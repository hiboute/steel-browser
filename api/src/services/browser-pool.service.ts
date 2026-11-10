import { FastifyBaseLogger } from "fastify";
import { CDPService } from "./cdp/cdp.service.js";

export interface PoolSlot {
  index: number;
  cdpPort: number;
  cdpService: CDPService;
  sessionId: string | null;
  state: "free" | "starting" | "live" | "stopping";
}

export class PoolClosedError extends Error {
  constructor() {
    super("The browser pool is shutting down");
    this.name = "PoolClosedError";
  }
}

interface SlotRequest {
  sessionId: string;
  primaryOnly: boolean;
  background: boolean;
  enqueuedAt: number;
  finish: (slot: PoolSlot | null, error?: Error) => void;
}

/**
 * A fixed set of browser slots, one Chrome per slot, each on its own CDP port.
 *
 * Slot 0 is the primary browser: it is what `fastify.cdpService` points at, it
 * keeps an idle browser running between sessions, and it is the browser the
 * unscoped endpoints (`ws://host/`, `/v1/scrape`, ...) talk to. Slots 1..n-1
 * only run Chrome while a session holds them.
 */
export class BrowserPool {
  private slots: PoolSlot[];
  private logger: FastifyBaseLogger;
  private waiters: SlotRequest[] = [];
  private closed = false;
  private admission: () => boolean = () => true;
  private retryTimer?: NodeJS.Timeout;

  setAdmissionGuard(check: () => boolean) {
    this.admission = check;
  }
  hasMemoryCapacity() {
    return this.admission();
  }

  constructor(
    maxSessions: number,
    cdpPortBase: number,
    logger: FastifyBaseLogger,
    storageFactory: (index: number) => any,
    enableConsoleLogging: boolean,
    reservedPorts: number[] = [],
  ) {
    const size = Math.max(1, Math.floor(maxSessions));
    this.logger = logger.child({ component: "BrowserPool" });
    const ports = BrowserPool.allocatePorts(size, cdpPortBase, reservedPorts);
    this.slots = ports.map((cdpPort, i) => ({
      index: i,
      cdpPort,
      cdpService: new CDPService(
        { cdpPort, primary: i === 0 },
        logger.child({ slot: i }),
        storageFactory(i),
        enableConsoleLogging,
      ),
      sessionId: null,
      state: "free",
    }));
    this.logger.info(`[BrowserPool] ${size} slot(s), CDP ports ${ports.join(", ")}`);
  }

  /**
   * Slot 0 always gets the base port (the primary browser); later slots take
   * the next ports that are not reserved (9223 is the bundled nginx proxy).
   */
  static allocatePorts(size: number, base: number, reserved: number[] = []): number[] {
    const ports = [base];
    let next = base + 1;
    while (ports.length < size) {
      if (!reserved.includes(next)) ports.push(next);
      next++;
    }
    return ports;
  }

  /** Takes the first free slot (the primary first), or null when all are busy. */
  acquire(
    sessionId: string,
    options: { primaryOnly?: boolean; background?: boolean } = {},
  ): PoolSlot | null {
    if (this.closed) throw new PoolClosedError();
    // A new arrival must not jump ahead of an existing waiter.
    if (this.waiters.length) return null;
    return this.takeSlot(sessionId, options.primaryOnly ?? false, options.background ?? false);
  }

  private takeSlot(sessionId: string, primaryOnly: boolean, background = false): PoolSlot | null {
    if (
      !this.admission() ||
      (background &&
        (this.waiters.length > 0 || this.slots.filter((s) => s.state === "free").length <= 1))
    )
      return null;
    const candidates = primaryOnly ? this.slots.slice(0, 1) : this.slots;
    const slot = candidates.find((s) => s.state === "free");
    if (!slot) {
      this.logger.warn(`[BrowserPool] No free slot for session ${sessionId}`);
      return null;
    }
    slot.sessionId = sessionId;
    slot.state = "starting";
    this.logger.info(
      `[BrowserPool] Slot ${slot.index} (port ${slot.cdpPort}) -> session ${sessionId}`,
    );
    return slot;
  }

  /** FIFO reservation. A slot remains owned until teardown explicitly releases it. */
  async acquireWhenAvailable(
    sessionId: string,
    options: {
      primaryOnly?: boolean;
      background?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<PoolSlot | null> {
    options.signal?.throwIfAborted();
    const immediate = this.acquire(sessionId, options);
    if (immediate || !options.timeoutMs || options.background) return immediate;

    return new Promise((resolve, reject) => {
      let finished = false;
      const onAbort = () =>
        request.finish(null, new DOMException("Request cancelled", "AbortError"));
      const request: SlotRequest = {
        sessionId,
        primaryOnly: options.primaryOnly ?? false,
        background: options.background ?? false,
        enqueuedAt: Date.now(),
        finish: (slot, error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          const index = this.waiters.indexOf(request);
          if (index !== -1) this.waiters.splice(index, 1);
          if (error) reject(error);
          else resolve(slot);
          if (!this.waiters.length) {
            clearInterval(this.retryTimer);
            this.retryTimer = undefined;
          }
          this.drain();
        },
      };
      const timer = setTimeout(() => request.finish(null), options.timeoutMs);
      timer.unref();
      this.waiters.push(request);
      if (!this.retryTimer) {
        this.retryTimer = setInterval(() => this.drain(), 1000);
        this.retryTimer.unref();
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }

  private drain(): void {
    if (this.closed) return;
    const first = this.waiters[0];
    if (!first) return;
    const slot = this.takeSlot(first.sessionId, first.primaryOnly, first.background);
    if (slot) first.finish(slot);
  }

  markLive(sessionId: string): void {
    const slot = this.getSlot(sessionId);
    if (slot?.state === "starting") slot.state = "live";
  }

  markStopping(sessionId: string): void {
    const slot = this.getSlot(sessionId);
    if (slot) slot.state = "stopping";
  }

  idleReady(index: number): void {
    const slot = this.slots[index];
    if (slot && slot.sessionId === null) {
      slot.state = "free";
      this.drain();
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.retryTimer);
    for (const waiter of [...this.waiters]) waiter.finish(null, new PoolClosedError());
  }

  get queue(): { position: number; sessionId: string; waitingMs: number }[] {
    return this.waiters.map((waiter, index) => ({
      position: index + 1,
      sessionId: waiter.sessionId,
      waitingMs: Math.max(0, Date.now() - waiter.enqueuedAt),
    }));
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  release(sessionId: string): void {
    const slot = this.getSlot(sessionId);
    if (slot) {
      this.logger.info(`[BrowserPool] Slot ${slot.index} released by session ${sessionId}`);
      slot.sessionId = null;
      slot.state = "free";
      this.drain();
    }
  }

  getSlot(sessionId: string): PoolSlot | undefined {
    return this.slots.find((s) => s.sessionId === sessionId);
  }

  get primary(): PoolSlot {
    return this.slots[0];
  }

  get allSlots(): readonly PoolSlot[] {
    return this.slots;
  }

  get activeCount(): number {
    return this.slots.filter((s) => s.sessionId !== null).length;
  }

  get maxSessions(): number {
    return this.slots.length;
  }
}
