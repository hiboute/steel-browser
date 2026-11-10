import {
  SessionPoolFullError,
  type Session,
  type SessionService,
  type StartSessionOptions,
} from "../session.service.js";

export interface BackgroundJobOptions {
  sessionOptions?: Partial<StartSessionOptions>;
  timeoutMs?: number;
}
export class BackgroundJobs {
  private count = 0;
  private closing = false;
  private pending = new Set<Promise<unknown>>();
  private controllers = new Set<AbortController>();
  constructor(
    private sessions: SessionService,
    readonly max = 1,
  ) {}
  get running(): number {
    return this.count;
  }

  async run<T>(
    kind: string,
    options: BackgroundJobOptions,
    fn: (session: Session) => Promise<T>,
  ): Promise<T | undefined> {
    const pool = this.sessions.getPoolStatus();
    if (this.closing || this.count >= this.max || pool.queued > 0 || pool.free <= 1)
      return undefined;
    // Reserve background admission before the first await so simultaneous jobs cannot overcommit.
    this.count++;
    const abort = new AbortController();
    this.controllers.add(abort);
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 60_000, 1000), 3_600_000);
    const timer = setTimeout(
      () => abort.abort(new Error(`Background ${kind} job timed out`)),
      timeoutMs,
    );
    timer.unref();
    let id: string | undefined;
    const task = (async () => {
      const details = await this.sessions.startSession({
        ...options.sessionOptions,
        credentials: options.sessionOptions?.credentials,
        queueTimeout: 0,
        signal: abort.signal,
        keepAlive: true,
        onExpire: "release",
        timeout: timeoutMs,
        labels: { ...options.sessionOptions?.labels, background: kind },
      });
      id = details.id;
      const session = this.sessions.getSession(id);
      if (!session) throw new Error("Background session did not become live");
      const releaseHold = this.sessions.holdActivity(id);
      let onAbort: (() => void) | undefined;
      try {
        abort.signal.throwIfAborted();
        return await Promise.race([
          fn(session),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(abort.signal.reason);
            abort.signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort) abort.signal.removeEventListener("abort", onAbort);
        releaseHold();
      }
    })();
    this.pending.add(task);
    try {
      return await task;
    } catch (error) {
      // A foreground request can take capacity while launch hooks are running.
      // This is a postponed background run, not a failed page/login check.
      if (error instanceof SessionPoolFullError) return undefined;
      throw error;
    } finally {
      clearTimeout(timer);
      if (id && this.sessions.getSession(id))
        await this.sessions.endSession(id).catch(() => undefined);
      this.count--;
      this.pending.delete(task);
      this.controllers.delete(abort);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers)
      controller.abort(new Error("Background jobs are shutting down"));
    await Promise.allSettled([...this.pending]);
  }
}
