import { randomUUID } from "node:crypto";

export interface PlatformEvent {
  id: string;
  type: string;
  at: string;
  sessionId?: string;
  data: unknown;
}

export class PlatformEvents {
  private listeners = new Set<(event: PlatformEvent) => void>();
  publish(type: string, data: unknown, sessionId?: string): PlatformEvent {
    const event = { id: randomUUID(), type, at: new Date().toISOString(), sessionId, data };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* A disconnected observer must not break lifecycle work. */
      }
    }
    return event;
  }
  subscribe(listener: (event: PlatformEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
