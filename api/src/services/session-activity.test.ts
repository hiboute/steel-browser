import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CdpActivityObserver, observeCdpActivity } from "./session-activity.js";

function frame(text: string, opcode = 1, final = true, compressed = false): Buffer {
  const body = Buffer.from(text);
  const prefix = body.length < 126 ? 2 : body.length <= 65535 ? 4 : 10;
  const header = Buffer.alloc(prefix + 4);
  header[0] = opcode | (final ? 128 : 0) | (compressed ? 64 : 0);
  header[1] = 128 | (prefix === 2 ? body.length : prefix === 4 ? 126 : 127);
  if (prefix === 4) header.writeUInt16BE(body.length, 2);
  if (prefix === 10) header.writeBigUInt64BE(BigInt(body.length), 2);
  const mask = Buffer.from([1, 2, 3, 4]);
  mask.copy(header, prefix);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([header, body]);
}
const ignores = "Browser.getVersion,Page.screencastFrameAck,Input.dispatchMouseEvent:mouseMoved";
const command = (method: string, params = {}) => JSON.stringify({ id: 1, method, params });

describe("CDP activity observer", () => {
  it("preserves pipelined upgrade frames until the proxy starts forwarding", async () => {
    const socket = new PassThrough();
    const upstream = new PassThrough();
    const touch = vi.fn();
    const wire = frame(command("Page.navigate", { url: "https://example.com" }));
    const head = wire.subarray(0, 11);
    const forwarded: Buffer[] = [];
    upstream.on("data", (data: Buffer) => forwarded.push(data));
    observeCdpActivity(socket, head, touch, ignores);
    // http-proxy puts the upgrade head back before piping the client socket.
    socket.unshift(head);
    socket.write(wire.subarray(head.length));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(touch).not.toHaveBeenCalled();
    expect(forwarded).toEqual([]);
    socket.pipe(upstream);
    await vi.waitFor(() => expect(touch).toHaveBeenCalledOnce());
    expect(Buffer.concat(forwarded)).toEqual(wire);
    socket.destroy();
    upstream.destroy();
  });
  it("ignores viewer maintenance and mouse motion but counts clicks and navigation", () => {
    const touch = vi.fn();
    const observer = new CdpActivityObserver(touch, ignores);
    for (const text of [
      command("Browser.getVersion"),
      command("Page.screencastFrameAck"),
      command("Input.dispatchMouseEvent", { type: "mouseMoved" }),
    ])
      observer.push(frame(text));
    expect(touch).not.toHaveBeenCalled();
    observer.push(
      Buffer.concat([
        frame(command("Input.dispatchMouseEvent", { type: "mousePressed" })),
        frame(command("Page.navigate", { url: "https://example.com" })),
      ]),
    );
    expect(touch).toHaveBeenCalledTimes(2);
  });
  it("handles fragmented messages, split headers, extended lengths and intervening pings", () => {
    const touch = vi.fn();
    const observer = new CdpActivityObserver(touch, ignores);
    const text = command("Runtime.evaluate", { expression: "x".repeat(500) });
    const wire = Buffer.concat([
      frame(text.slice(0, 90), 1, false),
      frame("ping", 9),
      frame(text.slice(90), 0),
    ]);
    for (const byte of wire) observer.push(Buffer.from([byte]));
    expect(touch).toHaveBeenCalledOnce();
    observer.push(frame("pong", 10));
    expect(touch).toHaveBeenCalledOnce();
  });
  it("ignores fragmented and nested CDP maintenance without mutating proxy input", () => {
    const touch = vi.fn();
    const observer = new CdpActivityObserver(touch, ignores);
    const text = command("Browser.getVersion");
    const wire = Buffer.concat([
      frame(text.slice(0, 5), 1, false),
      frame(text.slice(5), 0),
      frame(command("Target.sendMessageToTarget", { message: text })),
    ]);
    const copy = Buffer.from(wire);
    observer.push(wire);
    expect(touch).not.toHaveBeenCalled();
    expect(wire.equals(copy)).toBe(true);
  });
  it("counts compressed, large, binary and malformed data conservatively, then parses later frames", () => {
    for (const wire of [
      frame("z".repeat(70000)),
      frame("opaque", 1, true, true),
      frame("binary", 2),
      frame("not-json"),
    ]) {
      const touch = vi.fn();
      const observer = new CdpActivityObserver(touch, ignores);
      observer.push(wire);
      expect(touch).toHaveBeenCalled();
      touch.mockClear();
      observer.push(frame(command("Browser.getVersion")));
      expect(touch).not.toHaveBeenCalled();
    }
  });
});
