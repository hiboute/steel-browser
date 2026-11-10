import type { Duplex } from "node:stream";

/** Passive, bounded WebSocket inspection. This never changes or consumes forwarded bytes. */
export class CdpActivityObserver {
  private header = Buffer.alloc(0);
  private frame?: {
    remaining: number;
    offset: number;
    mask?: Buffer;
    opcode: number;
    final: boolean;
  };
  private parts: Buffer[] = [];
  private size = 0;
  private opaqueMessage = false;
  private inMessage = false;
  private opaqueStream = false;
  private readonly ignored: Set<string>;
  constructor(
    private touch: () => void,
    ignored: string,
  ) {
    this.ignored = new Set(
      ignored
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  push(input: Buffer): void {
    if (this.opaqueStream) {
      if (input.length) this.touch();
      return;
    }
    let offset = 0;
    while (offset < input.length) {
      if (!this.frame) {
        const needed =
          this.header.length < 2
            ? 2
            : 2 +
              ((this.header[1] & 127) === 126 ? 2 : (this.header[1] & 127) === 127 ? 8 : 0) +
              (this.header[1] & 128 ? 4 : 0);
        const count = Math.min(needed - this.header.length, input.length - offset);
        this.header = Buffer.concat([this.header, input.subarray(offset, offset + count)]);
        offset += count;
        if (this.header.length < 2) continue;
        const marker = this.header[1] & 127;
        const lengthBytes = marker === 126 ? 2 : marker === 127 ? 8 : 0;
        const headerSize = 2 + lengthBytes + (this.header[1] & 128 ? 4 : 0);
        if (this.header.length < headerSize) continue;
        const opcode = this.header[0] & 15;
        const final = !!(this.header[0] & 128);
        const length =
          lengthBytes === 8
            ? Number(this.header.readBigUInt64BE(2))
            : lengthBytes === 2
            ? this.header.readUInt16BE(2)
            : marker;
        if (
          !Number.isSafeInteger(length) ||
          ![0, 1, 2, 8, 9, 10].includes(opcode) ||
          (opcode >= 8 && (!final || length > 125)) ||
          (opcode === 0 && !this.inMessage) ||
          ((opcode === 1 || opcode === 2) && this.inMessage)
        ) {
          this.opaqueStream = true;
          this.header = Buffer.alloc(0);
          this.parts = [];
          this.touch();
          return;
        }
        if (opcode === 1 || opcode === 2) {
          this.inMessage = true;
          this.parts = [];
          this.size = 0;
          this.opaqueMessage = opcode === 2 || !!(this.header[0] & 112);
        }
        this.frame = {
          remaining: length,
          offset: 0,
          opcode,
          final,
          mask:
            this.header[1] & 128 ? Buffer.from(this.header.subarray(2 + lengthBytes)) : undefined,
        };
        this.header = Buffer.alloc(0);
      }
      const frame = this.frame;
      const count = Math.min(frame.remaining, input.length - offset);
      if (frame.opcode < 8 && count) {
        if (this.size + count > 65_536) {
          this.opaqueMessage = true;
          this.parts = [];
        }
        if (!this.opaqueMessage) {
          const payload = Buffer.from(input.subarray(offset, offset + count));
          if (frame.mask)
            for (let i = 0; i < payload.length; i++)
              payload[i] ^= frame.mask[(frame.offset + i) % 4];
          this.parts.push(payload);
          this.size += count;
        } else this.touch();
      }
      offset += count;
      frame.offset += count;
      frame.remaining -= count;
      if (frame.remaining) return;
      if (frame.opcode < 8 && frame.final) {
        if (!this.opaqueMessage) this.inspect(Buffer.concat(this.parts).toString("utf8"));
        this.parts = [];
        this.size = 0;
        this.inMessage = false;
      }
      this.frame = undefined;
    }
  }

  private inspect(text: string): void {
    try {
      const data = JSON.parse(text);
      if (typeof data?.method !== "string") {
        this.touch();
        return;
      }
      if (this.ignored.has(data.method) || this.ignored.has(`${data.method}:${data.params?.type}`))
        return;
      // Older CDP clients tunnel a JSON command to a target instead of using flattened sessions.
      if (
        data.method === "Target.sendMessageToTarget" &&
        typeof data.params?.message === "string"
      ) {
        const nested = JSON.parse(data.params.message);
        if (
          typeof nested?.method === "string" &&
          (this.ignored.has(nested.method) ||
            this.ignored.has(`${nested.method}:${nested.params?.type}`))
        )
          return;
      }
      this.touch();
    } catch {
      this.touch();
    }
  }
}

export function observeCdpActivity(
  socket: Duplex,
  _head: Buffer,
  touch: () => void,
  ignored: string,
): void {
  const parser = new CdpActivityObserver(touch, ignored);
  const listener = (data: Buffer) => parser.push(data);
  // The HTTP proxy resumes this socket when its upstream pipe is ready. A data
  // listener must not start flow early and consume pipelined client frames.
  socket.pause();
  socket.on("data", listener);
  socket.once("close", () => socket.off("data", listener));
  // http-proxy unshifts the upgrade head onto this socket, so it is observed
  // exactly once through data, including when it contains only part of a frame.
}
