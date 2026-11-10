import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CDPSession, Page, Protocol } from "puppeteer-core";

export class NavigationPolicyError extends Error {
  readonly code = "blocked_target";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "NavigationPolicyError";
  }
}
export interface NavigationPolicyOptions {
  /** Explicit operator opt-in. URL schemes and credentials remain restricted. */
  allowPrivateNetworks?: boolean;
  /** Injectable resolver for deterministic policy tests. Every request resolves afresh. */
  resolve?: (hostname: string) => Promise<string[]>;
  dnsTimeoutMs?: number;
}
export interface NavigationPolicy {
  assertUrl(url: string): Promise<string>;
  throwIfBlocked(): void;
}
const prohibitedNames = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);
const defaultResolver = async (hostname: string) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}
function inV4(address: number, network: string, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(ipv4Number(network) / size);
}
function ipv6Number(address: string): bigint {
  // Expand a dotted IPv4 tail before expanding ::, including IPv4-mapped addresses.
  if (address.includes(".")) {
    const index = address.lastIndexOf(":"),
      tail = ipv4Number(address.slice(index + 1));
    address = `${address.slice(0, index)}:${Math.floor(tail / 65536).toString(16)}:${(
      tail % 65536
    ).toString(16)}`;
  }
  const [left, right] = address.split("::");
  const before = left ? left.split(":") : [],
    after = right ? right.split(":") : [];
  const groups =
    right !== undefined
      ? [...before, ...Array(8 - before.length - after.length).fill("0"), ...after]
      : before;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}
function inV6(address: bigint, network: string, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return address >> shift === ipv6Number(network) >> shift;
}

/** Public unicast only; mapped/transition IPv6 must not disguise a private IPv4 target. */
export function isPublicAddress(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, "");
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) {
    const ip = ipv4Number(address);
    const reserved: [string, number][] = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !reserved.some(([network, prefix]) => inV4(ip, network, prefix));
  }
  if (family !== 6) return false;
  const ip = ipv6Number(address);
  if (ip >> 32n === 0xffffn) {
    const v4 = Number(ip & 0xffffffffn);
    return isPublicAddress(
      [24, 16, 8, 0].map((shift) => Math.floor(v4 / 2 ** shift) % 256).join("."),
    );
  }
  // Only global-unicast 2000::/3, excluding IETF special-use, documentation and 6to4.
  return (
    inV6(ip, "2000::", 3) &&
    ![
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
    ].some(([network, prefix]) => inV6(ip, String(network), Number(prefix)))
  );
}

export function extrasAllowPrivateNetworks(): boolean {
  const configured = process.env.EXTRAS_ALLOW_PRIVATE_NETWORKS ?? "false";
  if (!["true", "false", "1", "0"].includes(configured))
    throw new Error("EXTRAS_ALLOW_PRIVATE_NETWORKS must be true or false");
  return configured === "true" || configured === "1";
}

export async function assertAllowedUrl(
  raw: string,
  options: NavigationPolicyOptions = {},
  topLevel = true,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NavigationPolicyError("Invalid navigation URL");
  }
  if (!topLevel && (url.protocol === "data:" || url.protocol === "blob:")) return url.toString();
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new NavigationPolicyError("Only HTTP and HTTPS navigation is allowed");
  if (url.username || url.password)
    throw new NavigationPolicyError("URLs containing credentials are not allowed");
  if (options.allowPrivateNetworks ?? extrasAllowPrivateNetworks()) return url.toString();
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (prohibitedNames.has(hostname) || hostname.endsWith(".localhost"))
    throw new NavigationPolicyError("Private and metadata hosts are not allowed");
  let addresses: string[];
  if (isIP(hostname)) addresses = [hostname];
  else {
    let timer: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        (options.resolve ?? defaultResolver)(hostname),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("DNS lookup timed out")),
            options.dnsTimeoutMs ?? 5000,
          );
          timer.unref();
        }),
      ]);
    } catch {
      throw new NavigationPolicyError("The destination's DNS addresses could not be verified");
    } finally {
      clearTimeout(timer);
    }
  }
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
    throw new NavigationPolicyError(
      "Private, loopback, link-local and reserved destinations are not allowed",
    );
  }
  return url.toString();
}

const scopes = new WeakMap<Page, Promise<unknown>>();

/**
 * Scoped policy for fresh extraction/watcher job pages (not existing live sessions).
 * A separate Fetch session runs before Puppeteer's existing request handlers.
 * This avoids a pre-existing legacy request.continue() bypassing an async DNS check.
 * Detaching restores the page's own interception, including ad blocking.
 */
export async function withNavigationPolicy<T>(
  page: Page,
  run: (policy: NavigationPolicy) => Promise<T>,
  options: NavigationPolicyOptions = {},
): Promise<T> {
  const previous = scopes.get(page) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      const root = await page.createCDPSession();
      let blocked: NavigationPolicyError | undefined;
      const pending = new Set<Promise<void>>();
      const cleanups: Array<() => Promise<void>> = [];
      let rootFrameId: string | undefined;
      const policy: NavigationPolicy = {
        assertUrl: (url) => assertAllowedUrl(url, options),
        throwIfBlocked: () => {
          if (blocked) throw blocked;
        },
      };
      const track = (operation: Promise<void>) => {
        pending.add(operation);
        void operation.finally(() => pending.delete(operation));
      };
      const ignoreResolved = (error: unknown) =>
        /Invalid InterceptionId|Invalid interception id|No resource with given identifier|Target closed|Session closed|has been closed/i.test(
          String(error),
        );
      const configure = async (client: CDPSession): Promise<void> => {
        const seen = new Set<string>();
        const onRequest = (event: Protocol.Fetch.RequestPausedEvent) => {
          // A request has separate request and response events. Each stage resolves once.
          const key = `${event.requestId}:${
            event.responseStatusCode === undefined && !event.responseErrorReason
              ? "request"
              : "response"
          }`;
          if (seen.has(key)) return;
          seen.add(key);
          track(
            (async () => {
              try {
                if (event.responseStatusCode !== undefined || event.responseErrorReason) {
                  // Fetch does not intercept WebSocket handshakes. Restrict connection schemes
                  // and worker creation on newly loaded documents before their scripts execute.
                  // Existing loaded pages retain the normal browser network contract.
                  if (
                    event.resourceType === "Document" &&
                    event.responseStatusCode &&
                    !(event.responseStatusCode >= 300 && event.responseStatusCode < 400) &&
                    event.responseStatusCode !== 204 &&
                    !event.responseErrorReason
                  ) {
                    const body = await client.send("Fetch.getResponseBody", {
                      requestId: event.requestId,
                    });
                    await client.send("Fetch.fulfillRequest", {
                      body: body.base64Encoded
                        ? body.body
                        : Buffer.from(body.body).toString("base64"),
                      requestId: event.requestId,
                      responseCode: event.responseStatusCode,
                      // HTTP/2 omits the reason phrase; CDP rejects an explicit empty one.
                      ...(event.responseStatusText
                        ? { responsePhrase: event.responseStatusText }
                        : {}),
                      responseHeaders: [
                        ...(event.responseHeaders ?? []).filter(
                          (header) =>
                            !["content-encoding", "content-length", "transfer-encoding"].includes(
                              header.name.toLowerCase(),
                            ),
                        ),
                        {
                          name: "Content-Security-Policy",
                          value: "connect-src http: https:; worker-src 'none'",
                        },
                      ],
                    });
                  } else {
                    await client.send("Fetch.continueRequest", { requestId: event.requestId });
                  }
                  return;
                }
                const topLevel =
                  event.resourceType === "Document" &&
                  (!event.frameId || event.frameId === rootFrameId);
                await assertAllowedUrl(event.request.url, options, topLevel);
                await client.send("Fetch.continueRequest", {
                  requestId: event.requestId,
                  interceptResponse: event.resourceType === "Document",
                });
              } catch (error) {
                if (ignoreResolved(error) || page.isClosed()) return;
                if (error instanceof NavigationPolicyError) blocked ??= error;
                else
                  blocked ??= new NavigationPolicyError(
                    "Request interception could not safely continue",
                  );
                await client
                  .send("Fetch.failRequest", {
                    requestId: event.requestId,
                    errorReason: "BlockedByClient",
                  })
                  .catch(() => {});
              }
            })(),
          );
        };
        const onAttached = (event: Protocol.Target.AttachedToTargetEvent) => {
          track(
            (async () => {
              const child = client.connection()?.session(event.sessionId);
              if (!child) {
                blocked ??= new NavigationPolicyError(
                  "A child browser target could not be secured",
                );
                await client
                  .send("Target.closeTarget", { targetId: event.targetInfo.targetId })
                  .catch(() => {});
                return;
              }
              try {
                await configure(child);
                await child.send("Runtime.runIfWaitingForDebugger");
              } catch (error) {
                if (!ignoreResolved(error) && !page.isClosed())
                  blocked ??= new NavigationPolicyError(
                    "A child browser target could not be secured",
                  );
                // A child that cannot be guarded must never run while waiting for the debugger.
                await client
                  .send("Target.closeTarget", { targetId: event.targetInfo.targetId })
                  .catch(() => {});
              }
            })(),
          );
        };
        client.on("Fetch.requestPaused", onRequest);
        client.on("Target.attachedToTarget", onAttached);
        cleanups.push(async () => {
          client.off("Fetch.requestPaused", onRequest);
          client.off("Target.attachedToTarget", onAttached);
          await client
            .send("Target.setAutoAttach", {
              autoAttach: false,
              waitForDebuggerOnStart: false,
              flatten: true,
            })
            .catch(() => {});
          await client.send("Fetch.disable").catch(() => {});
          await client.send("Network.setBypassServiceWorker", { bypass: false }).catch(() => {});
          await client.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
        });
        await client.send("Network.enable");
        await client.send("Network.setBypassServiceWorker", { bypass: true });
        await client.send("Network.setCacheDisabled", { cacheDisabled: true });
        await client.send("Fetch.enable", {
          patterns: [
            { urlPattern: "*", requestStage: "Request" },
            { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
          ],
        });
        await client.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        });
      };
      const drain = async () => {
        // Child attachment and pending requests may enqueue more work while draining.
        while (pending.size) await Promise.all([...pending]);
      };
      try {
        rootFrameId = (await root.send("Page.getFrameTree")).frameTree.frame.id;
        await configure(root);
        try {
          const result = await run(policy);
          await drain();
          policy.throwIfBlocked();
          return result;
        } catch (error) {
          await drain();
          policy.throwIfBlocked();
          throw error;
        }
      } finally {
        for (const cleanup of cleanups.reverse()) await cleanup();
        await root.detach().catch(() => {});
      }
    });
  scopes.set(page, task);
  try {
    return await task;
  } finally {
    if (scopes.get(page) === task) scopes.delete(page);
  }
}
