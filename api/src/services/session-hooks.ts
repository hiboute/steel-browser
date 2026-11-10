import type { FastifyBaseLogger } from "fastify";
import type { Session, StartSessionOptions } from "./session.service.js";

export type EndReason = "api" | "idle" | "timeout" | "disconnected" | "parked_expired" | "shutdown";
export type ParkReason = "manual" | "idle" | "timeout" | "preempted" | "shutdown";
export interface SessionHooks {
  onStarting?(options: StartSessionOptions): void | Promise<void>;
  onAdmission?(options: StartSessionOptions): void | Promise<void>;
  onBrowserReady?(session: Session): void | Promise<void>;
  onStarted?(session: Session): void | Promise<void>;
  onEnding?(
    session: Session,
    context: { reason: EndReason | ParkReason; park: boolean },
  ): void | Promise<void>;
  onEnded?(session: Session): void | Promise<void>;
  onParked?(session: Session): void | Promise<void>;
  onResumed?(session: Session): void | Promise<void>;
}

export class SessionHookRegistry {
  private listeners = new Set<SessionHooks>();
  constructor(private logger: FastifyBaseLogger) {}

  add(hooks: SessionHooks): () => void {
    this.listeners.add(hooks);
    return () => {
      this.listeners.delete(hooks);
    };
  }

  async run<K extends keyof SessionHooks>(
    name: K,
    ...args: Parameters<NonNullable<SessionHooks[K]>>
  ): Promise<void> {
    for (const hooks of this.listeners) {
      const hook = hooks[name] as ((...args: any[]) => void | Promise<void>) | undefined;
      if (!hook) continue;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => hook(...args)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Session hook ${name} timed out`)), 10_000);
            timer.unref();
          }),
        ]);
      } catch (error) {
        if (["onStarting", "onAdmission", "onBrowserReady"].includes(name)) throw error;
        this.logger.error({ err: error, hook: name }, "Session lifecycle hook failed");
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
