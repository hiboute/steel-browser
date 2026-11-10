import { isSensitiveSession } from "./data/privacy.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "puppeteer-core";
import type { Session } from "./session.service.js";
import type { PlatformStore } from "./platform/store.js";
import {
  activePage,
  AgentFeatureError,
  bounded,
  configuredNumber,
  dataSessionId,
} from "./handoff/agent-feature-utils.js";

export interface RecordingFrame {
  seq: number;
  /** Milliseconds from the start of this recording, using Chrome's frame timestamp. */
  t: number;
  at: string;
  pageId: string;
  url: string;
  bytes: number;
}

export interface RecordingDetails {
  sessionId: string;
  status: "recording" | "stopped";
  startedAt: string;
  stoppedAt: string | null;
  frames: number;
  bytes: number;
  stopReason: string | null;
}

interface RecordingDependencies {
  store: PlatformStore;
  getSession(id: string): Session | undefined;
  publish(type: string, data: unknown, sessionId?: string): unknown;
  log(error: unknown): void;
  fps?: number;
  width?: number;
  quality?: number;
  maxBytes?: number;
  totalMaxBytes?: number;
  retentionDays?: number;
}

interface ActiveRecording {
  details: RecordingDetails;
  page?: Page;
  client?: CDPSession;
  timer?: NodeJS.Timeout;
  switching: boolean;
  nextFrameAt: number;
  pendingFrame: boolean;
  closed: boolean;
}

export class RecordingService {
  private readonly live = new Map<string, ActiveRecording>();
  private readonly saved = new Map<string, RecordingDetails>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly fps: number;
  private readonly width: number;
  private readonly quality: number;
  private readonly maxBytes: number;
  private readonly totalMaxBytes: number;
  private readonly retentionDays: number;

  constructor(private readonly deps: RecordingDependencies) {
    this.fps = deps.fps ?? configuredNumber("RECORDING_FPS_MAX", 2, 0.1, 30);
    this.width = deps.width ?? configuredNumber("RECORDING_MAX_WIDTH", 1280, 64, 4096);
    this.quality = deps.quality ?? configuredNumber("RECORDING_JPEG_QUALITY", 60, 1, 100);
    this.maxBytes =
      deps.maxBytes ?? configuredNumber("RECORDING_MAX_MB_PER_SESSION", 300) * 1024 * 1024;
    this.totalMaxBytes =
      deps.totalMaxBytes ?? configuredNumber("RECORDING_TOTAL_MAX_MB", 4000) * 1024 * 1024;
    this.retentionDays = deps.retentionDays ?? configuredNumber("RECORDING_RETENTION_DAYS", 7);
  }

  async initialize() {
    for (const id of await this.deps.store.list("recordings")) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) continue;
      const details = await this.deps.store.read<RecordingDetails>(`recordings/${id}/meta.json`);
      if (!details) continue;
      const manifest = await this.deps.store.readLines<RecordingFrame>(
        `recordings/${id}/manifest.jsonl`,
      );
      details.frames = manifest.at(-1)?.seq ?? 0;
      details.bytes = manifest.reduce((sum, frame) => sum + frame.bytes, 0);
      if (details.status === "recording") {
        details.status = "stopped";
        details.stopReason = "restart";
        details.stoppedAt = new Date().toISOString();
        await this.deps.store.write(`recordings/${id}/meta.json`, details);
      }
      this.saved.set(id, details);
    }
    await this.sweep();
  }

  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const operation = (this.operations.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(fn);
    this.operations.set(id, operation);
    void operation
      .finally(() => {
        if (this.operations.get(id) === operation) this.operations.delete(id);
      })
      .catch(() => undefined);
    return operation;
  }

  get(id: string): RecordingDetails {
    const details = this.saved.get(id);
    if (!details) throw new AgentFeatureError(404, "recording_not_found", "Recording not found");
    return { ...details };
  }

  list(): RecordingDetails[] {
    return [...this.saved.values()]
      .map((details) => ({ ...details }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  start(id: string): Promise<RecordingDetails> {
    dataSessionId(id);
    if (isSensitiveSession(id))
      return Promise.reject(
        new AgentFeatureError(409, "sensitive_session", "Recording is disabled after a vault fill"),
      );
    return this.serialize(id, async () => {
      const session = this.deps.getSession(id);
      if (!session || session.status !== "live")
        throw new AgentFeatureError(409, "not_live", "Recording requires a live session");
      if (session.isSelenium)
        throw new AgentFeatureError(409, "not_supported", "Recording requires a CDP session");
      if (this.live.has(id)) return this.get(id);
      const existing = this.saved.get(id);
      if ((existing?.bytes ?? 0) >= this.maxBytes || this.totalBytes() >= this.totalMaxBytes) {
        throw new AgentFeatureError(
          409,
          "recording_limit",
          "Recording storage limit reached; delete old recordings first",
        );
      }
      const details: RecordingDetails = {
        sessionId: id,
        status: "recording",
        startedAt: existing?.startedAt ?? new Date().toISOString(),
        stoppedAt: null,
        frames: existing?.frames ?? 0,
        bytes: existing?.bytes ?? 0,
        stopReason: null,
      };
      const active: ActiveRecording = {
        details,
        switching: false,
        nextFrameAt: 0,
        pendingFrame: false,
        closed: false,
      };
      this.saved.set(id, details);
      this.live.set(id, active);
      try {
        await this.deps.store.write(`recordings/${id}/meta.json`, details);
        await this.followPage(active);
        active.timer = setInterval(() => void this.followPage(active).catch(this.deps.log), 500);
        active.timer.unref();
        Object.assign(session, { recording: true });
        this.deps.publish("recording.started", details, id);
        return { ...details };
      } catch (error) {
        await this.stopActive(active, "error");
        throw error;
      }
    });
  }

  private totalBytes() {
    return [...this.saved.values()].reduce((sum, item) => sum + item.bytes, 0);
  }

  private async followPage(active: ActiveRecording) {
    if (active.switching || active.closed) return;
    active.switching = true;
    try {
      const session = this.deps.getSession(active.details.sessionId);
      if (!session || session.status !== "live") {
        void this.stop(active.details.sessionId, "session_ended").catch(this.deps.log);
        return;
      }
      const page = await activePage(session);
      if (active.closed || (page === active.page && active.client)) return;
      await this.detachClient(active);
      if (!page || active.closed) return;
      const client = await bounded(page.createCDPSession());
      if (active.closed) {
        await client.detach().catch(() => undefined);
        return;
      }
      active.page = page;
      active.client = client;
      const pageId = session.cdpService.getTargetId(page);
      client.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
        // Always acknowledge, including frames dropped by FPS/backpressure/storage limits.
        void client
          .send("Page.screencastFrameAck", { sessionId }, { timeout: 3000 })
          .catch(() => undefined);
        if (
          active.client !== client ||
          active.closed ||
          active.pendingFrame ||
          Date.now() < active.nextFrameAt
        )
          return;
        active.nextFrameAt = Date.now() + 1000 / this.fps;
        active.pendingFrame = true;
        void this.appendFrame(active, data, metadata.timestamp, pageId, page.url())
          .catch(this.deps.log)
          .finally(() => {
            active.pendingFrame = false;
          });
      });
      client.on("Disconnected", () => {
        if (active.client === client) active.client = undefined;
      });
      await client.send(
        "Page.startScreencast",
        { format: "jpeg", quality: this.quality, maxWidth: this.width, maxHeight: this.width * 2 },
        { timeout: 3000 },
      );
    } finally {
      active.switching = false;
    }
  }

  private appendFrame(
    active: ActiveRecording,
    data: string,
    timestamp: number | undefined,
    pageId: string,
    url: string,
  ): Promise<void> {
    // One pending frame per recording, one writer globally: bounded memory and atomic global cap.
    const task = this.writes
      .catch(() => undefined)
      .then(async () => {
        if (active.closed) return;
        const image = Buffer.from(data, "base64");
        if (
          active.details.bytes + image.length > this.maxBytes ||
          this.totalBytes() + image.length > this.totalMaxBytes
        ) {
          void this.stop(
            active.details.sessionId,
            active.details.bytes + image.length > this.maxBytes ? "session_limit" : "total_limit",
          ).catch(this.deps.log);
          return;
        }
        const now =
          timestamp !== undefined && Number.isFinite(timestamp) ? timestamp * 1000 : Date.now();
        const frame: RecordingFrame = {
          seq: active.details.frames + 1,
          t: Math.max(0, now - Date.parse(active.details.startedAt)),
          at: new Date(now).toISOString(),
          pageId,
          url,
          bytes: image.length,
        };
        const relative = `recordings/${active.details.sessionId}`;
        const filename = this.deps.store.path(`${relative}/${frame.seq}.jpg`);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, image, { mode: 0o600 });
        try {
          await this.deps.store.append(`${relative}/manifest.jsonl`, frame);
        } catch (error) {
          await rm(filename, { force: true });
          throw error;
        }
        active.details.frames++;
        active.details.bytes += image.length;
        await this.deps.store.write(`${relative}/meta.json`, active.details);
      });
    this.writes = task;
    return task;
  }

  private async detachClient(active: ActiveRecording) {
    const client = active.client;
    active.client = undefined;
    active.page = undefined;
    if (client) {
      await client.send("Page.stopScreencast", undefined, { timeout: 3000 }).catch(() => undefined);
      await bounded(client.detach(), 2000).catch(() => undefined);
    }
  }

  private async stopActive(active: ActiveRecording, reason: string) {
    active.closed = true;
    if (active.timer) clearInterval(active.timer);
    await this.detachClient(active);
    await this.writes.catch(() => undefined);
    active.details.status = "stopped";
    active.details.stoppedAt = new Date().toISOString();
    active.details.stopReason = reason;
    this.live.delete(active.details.sessionId);
    const session = this.deps.getSession(active.details.sessionId);
    if (session) Object.assign(session, { recording: false });
    await this.deps.store.write(`recordings/${active.details.sessionId}/meta.json`, active.details);
    this.deps.publish("recording.stopped", active.details, active.details.sessionId);
    return { ...active.details };
  }

  stop(id: string, reason = "manual"): Promise<RecordingDetails> {
    return this.serialize(id, async () => {
      const active = this.live.get(id);
      return active ? this.stopActive(active, reason) : this.get(id);
    });
  }

  async frames(
    id: string,
    from = 0,
    to = Number.MAX_SAFE_INTEGER,
    limit = 500,
  ): Promise<RecordingFrame[]> {
    this.get(id);
    await this.writes.catch(() => undefined);
    const frames = await this.deps.store.readLines<RecordingFrame>(
      `recordings/${dataSessionId(id)}/manifest.jsonl`,
    );
    return frames
      .filter((frame) => frame.t >= from && frame.t <= to)
      .slice(0, Math.min(5000, Math.max(1, limit)));
  }

  async image(id: string, seq: number): Promise<Buffer> {
    const details = this.get(id);
    if (!Number.isInteger(seq) || seq < 1 || seq > details.frames)
      throw new AgentFeatureError(404, "frame_not_found", "Recording frame not found");
    try {
      return await readFile(this.deps.store.path(`recordings/${dataSessionId(id)}/${seq}.jpg`));
    } catch {
      throw new AgentFeatureError(404, "frame_not_found", "Recording frame not found");
    }
  }

  remove(id: string): Promise<void> {
    return this.serialize(id, async () => {
      const active = this.live.get(id);
      if (active) await this.stopActive(active, "deleted");
      this.get(id);
      await this.deps.store.remove(`recordings/${dataSessionId(id)}`);
      this.saved.delete(id);
      this.deps.publish("recording.deleted", { sessionId: id }, id);
    });
  }

  async sweep() {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    for (const details of this.saved.values()) {
      if (this.live.has(details.sessionId) || this.operations.has(details.sessionId)) continue;
      if (Date.parse(details.stoppedAt ?? details.startedAt) < cutoff)
        await this.remove(details.sessionId);
    }
  }

  async close() {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id, "shutdown")));
    await this.writes.catch(() => undefined);
  }
}
