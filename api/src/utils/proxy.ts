import { env } from "../env.js";
import { SessionService } from "../services/session.service.js";
import { makePassthrough, PassthroughServer } from "./passthrough-proxy.js";
import { Server } from "proxy-chain";
import https from "node:https";
import { isIP } from "node:net";

export interface IProxyServer {
  readonly url: string;
  readonly upstreamProxyUrl: string;
  readonly txBytes: number;
  readonly rxBytes: number;
  listen(): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export class ProxyServer extends Server implements IProxyServer {
  public url: string;
  public upstreamProxyUrl: string;
  public txBytes = 0;
  public rxBytes = 0;
  private hostConnections = new Set<number>();
  private readonly upstreamHttpsAgent?: https.Agent;

  constructor(proxyUrl: string) {
    const upstream = new URL(proxyUrl);
    // CONNECT's Host is the destination website. Node otherwise derives TLS
    // SNI/certificate verification from that header instead of the HTTPS proxy.
    const upstreamHttpsAgent =
      upstream.protocol === "https:"
        ? new https.Agent({
            servername: isIP(upstream.hostname.replace(/^\[|\]$/g, "")) ? "" : upstream.hostname,
          })
        : undefined;
    super({
      port: 0,

      prepareRequestFunction: (options) => {
        const { connectionId, hostname } = options;

        const internalBypassTests = new Set(["0.0.0.0", process.env.HOST]);

        if (env.PROXY_INTERNAL_BYPASS) {
          for (const host of env.PROXY_INTERNAL_BYPASS.split(",")) {
            internalBypassTests.add(host.trim());
          }
        }

        const isInternalBypass = internalBypassTests.has(hostname);

        if (isInternalBypass) {
          this.hostConnections.add(connectionId);
          return {
            customConnectServer: PassthroughServer,
            customResponseFunction: makePassthrough(options),
          };
        }
        return {
          requestAuthentication: false,
          upstreamProxyUrl: proxyUrl,
          httpsAgent: upstreamHttpsAgent,
        };
      },
    });

    this.on("connectionClosed", ({ connectionId, stats }) => {
      if (stats && !this.hostConnections.has(connectionId)) {
        this.txBytes += stats.trgTxBytes;
        this.rxBytes += stats.trgRxBytes;
      }
      this.hostConnections.delete(connectionId);
    });

    this.url = `http://127.0.0.1:${this.port}`;
    this.upstreamProxyUrl = proxyUrl;
    this.upstreamHttpsAgent = upstreamHttpsAgent;
  }

  async listen(): Promise<void> {
    await super.listen();
    this.url = `http://127.0.0.1:${this.port}`;
  }

  async close(force = false): Promise<void> {
    const socketsClosed = [...this.connections.values()].map(
      (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    try {
      await super.close(force);
      await Promise.all(socketsClosed);
    } finally {
      this.upstreamHttpsAgent?.destroy();
    }
  }
}
