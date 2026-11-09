import { FastifyBaseLogger } from "fastify";
import { CDPService } from "./cdp/cdp.service.js";

export interface PoolSlot {
  index: number;
  cdpPort: number;
  cdpService: CDPService;
  sessionId: string | null;
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

  constructor(
    maxSessions: number,
    cdpPortBase: number,
    logger: FastifyBaseLogger,
    storageFactory: (index: number) => any,
    enableConsoleLogging: boolean,
  ) {
    const size = Math.max(1, Math.floor(maxSessions));
    this.logger = logger.child({ component: "BrowserPool" });
    this.slots = Array.from({ length: size }, (_, i) => ({
      index: i,
      cdpPort: cdpPortBase + i,
      cdpService: new CDPService(
        { cdpPort: cdpPortBase + i, primary: i === 0 },
        logger.child({ slot: i }),
        storageFactory(i),
        enableConsoleLogging,
      ),
      sessionId: null,
    }));
    this.logger.info(
      `[BrowserPool] ${size} slot(s), CDP ports ${cdpPortBase}-${cdpPortBase + size - 1}`,
    );
  }

  /** Takes the first free slot (the primary first), or null when all are busy. */
  acquire(sessionId: string, options: { primaryOnly?: boolean } = {}): PoolSlot | null {
    const candidates = options.primaryOnly ? this.slots.slice(0, 1) : this.slots;
    const slot = candidates.find((s) => s.sessionId === null);
    if (!slot) {
      this.logger.warn(`[BrowserPool] No free slot for session ${sessionId}`);
      return null;
    }
    slot.sessionId = sessionId;
    this.logger.info(
      `[BrowserPool] Slot ${slot.index} (port ${slot.cdpPort}) -> session ${sessionId}`,
    );
    return slot;
  }

  release(sessionId: string): void {
    const slot = this.getSlot(sessionId);
    if (slot) {
      this.logger.info(`[BrowserPool] Slot ${slot.index} released by session ${sessionId}`);
      slot.sessionId = null;
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
