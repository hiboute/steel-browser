import WebSocket, { type WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ConnectionCredential, OwnershipService } from "./ownership.js";

// Runtime.evaluate, DOM writes, debugger pause and arbitrary nested CDP messages are deliberately absent.
const OBSERVER = new Set([
  "Browser.getVersion",
  "Target.getTargets",
  "Target.getTargetInfo",
  "Page.getFrameTree",
  "Page.getNavigationHistory",
  "DOM.getDocument",
  "DOM.describeNode",
  "Accessibility.getFullAXTree",
]);
export async function guardedCdp(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  endpoint: string,
  control: OwnershipService,
  credential?: ConnectionCredential,
) {
  wss.handleUpgrade(request, socket, head, (client) => {
    const upstream = new WebSocket(endpoint);
    const queue: string[] = [];
    let bytes = 0;
    const close = () => {
      upstream.close();
      client.close();
    };
    const expiry = setInterval(() => {
      if (credential)
        try {
          control.assertConnection(credential);
        } catch {
          client.close(4409, "Control expired or transferred");
          upstream.close();
        }
    }, 250);
    expiry.unref();
    client.on("message", (raw) => {
      let message: any;
      try {
        message = JSON.parse(raw.toString());
        if (!message || typeof message.method !== "string") throw new Error();
        if (credential) control.assertConnection(credential);
        else if (!OBSERVER.has(message.method)) throw new Error("observer");
      } catch {
        if (message?.id !== undefined)
          client.send(
            JSON.stringify({
              id: message.id,
              error: { code: -32000, message: "Current browser control is required" },
            }),
          );
        return;
      }
      const encoded = JSON.stringify(message);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(encoded);
      else {
        bytes += Buffer.byteLength(encoded);
        if (bytes > 1024 * 1024) {
          close();
          return;
        }
        queue.push(encoded);
      }
    });
    upstream.on("open", () => {
      try {
        if (credential) control.assertConnection(credential);
        for (const m of queue) upstream.send(m);
      } catch {
        close();
      } finally {
        queue.length = 0;
      }
    });
    upstream.on("message", (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    client.on("close", () => {
      clearInterval(expiry);
      upstream.close();
    });
    upstream.on("close", () => {
      clearInterval(expiry);
      client.close();
    });
    client.on("error", close);
    upstream.on("error", close);
  });
}
