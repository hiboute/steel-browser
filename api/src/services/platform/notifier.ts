import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { PlatformEvents } from "./events.js";
import { PlatformStore } from "./store.js";

export interface NotificationInput {
  event: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  url?: string;
  sessionId?: string;
  data?: unknown;
}
export interface Notification extends NotificationInput {
  id: string;
  at: string;
  delivered?: boolean;
}

export class Notifier {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private store: PlatformStore,
    private events: PlatformEvents,
    private logger: FastifyBaseLogger,
    private webhook?: string,
    private viewer?: string,
  ) {}
  async list(): Promise<Notification[]> {
    return (await this.store.readLines<Notification>("notifications.jsonl")).slice(-200).reverse();
  }
  send(input: NotificationInput): Promise<Notification> {
    const task = this.queue
      .catch(() => undefined)
      .then(async () => {
        const notification: Notification = {
          ...input,
          id: randomUUID(),
          at: new Date().toISOString(),
        };
        if (!notification.url && input.sessionId && this.viewer) {
          const url = new URL(this.viewer);
          url.searchParams.set("session", input.sessionId);
          notification.url = url.toString();
        }
        // Persist before external delivery so webhook downtime cannot discard notifications.
        const previous = await this.store.readLines<Notification>("notifications.jsonl");
        await this.store.rewriteLines(
          "notifications.jsonl",
          [...previous, notification].slice(-200),
        );
        this.events.publish("notification", notification, notification.sessionId);
        if (this.webhook) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await fetch(this.webhook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(notification),
                signal: AbortSignal.timeout(5000),
              });
              if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`HTTP ${response.status}`);
              }
              await response.body?.cancel();
              notification.delivered = true;
              break;
            } catch {
              notification.delivered = false;
              if (attempt === 2)
                this.logger.warn(
                  { notificationId: notification.id },
                  "Notification webhook delivery failed after three attempts",
                );
            }
          }
          await this.store.rewriteLines(
            "notifications.jsonl",
            [...previous, notification].slice(-200),
          );
        }
        return notification;
      });
    this.queue = task;
    return task;
  }
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }
}
