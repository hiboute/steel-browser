import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { createSecureContext } from "node:tls";

vi.mock("../env.js", () => ({ env: {} }));

import { ProxyServer } from "./proxy.js";

describe("HTTPS upstream proxy TLS", () => {
  let directory: string;
  let key: Buffer;
  const certificates: Record<string, Buffer> = {};

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "steel-proxy-tls-"));
    const keyPath = path.join(directory, "key.pem");
    for (const hostname of ["localhost", "example.com"]) {
      const certPath = path.join(directory, `${hostname}.pem`);
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-subj",
          `/CN=${hostname}`,
          "-addext",
          `subjectAltName=DNS:${hostname}`,
        ],
        { stdio: "ignore" },
      );
      certificates[hostname] = fs.readFileSync(certPath);
      certificates[`${hostname}-key`] = fs.readFileSync(keyPath);
    }
    key = certificates["localhost-key"];
  });

  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  async function fixture(hostname = "localhost", trustCertificate = true) {
    const cert = certificates[hostname];
    const requests: { method: string; url?: string; host?: string; auth?: string }[] = [];
    const serverNames: string[] = [];
    const sockets = new Set<Duplex>();
    const tlsOptions = { key: certificates[`${hostname}-key`] ?? key, cert };
    const upstream = https.createServer({
      ...tlsOptions,
      SNICallback(servername, callback) {
        serverNames.push(servername);
        callback(null, createSecureContext(tlsOptions));
      },
    });
    upstream.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    });
    const remember = (req: http.IncomingMessage) =>
      requests.push({
        method: req.method!,
        url: req.url,
        host: req.headers.host,
        auth: req.headers["proxy-authorization"],
      });
    upstream.on("request", (req, res) => {
      remember(req);
      res.end("forwarded");
    });
    upstream.on("connect", (req, socket) => {
      remember(req);
      socket.on("error", () => undefined);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(socket);
    });
    upstream.listen(0);
    await once(upstream, "listening");
    const port = (upstream.address() as net.AddressInfo).port;
    const proxy = new ProxyServer(`https://test-user:test-password@localhost:${port}`);
    const prepare = proxy.prepareRequestFunction!;
    proxy.prepareRequestFunction = async (options) => {
      const config = await prepare(options);
      // Trust only this fixture's certificate; keep normal hostname checks.
      const agent = config?.httpsAgent ?? new https.Agent();
      if (trustCertificate) agent.options.ca = cert;
      return { ...config, httpsAgent: agent };
    };
    await proxy.listen();
    return {
      proxy,
      requests,
      serverNames,
      async close() {
        await proxy.close(true);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      },
    };
  }

  async function connect(proxy: ProxyServer) {
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "CONNECT",
      path: "example.com:443",
      agent: false,
      timeout: 5_000,
    });
    req.on("timeout", () => req.destroy(new Error("CONNECT timed out")));
    req.end();
    const [response, socket] = (await once(req, "connect")) as [http.IncomingMessage, net.Socket];
    socket.on("error", () => undefined);
    return { response, socket };
  }

  it("validates the proxy hostname while tunnelling to a different destination", async () => {
    const f = await fixture();
    try {
      const { response, socket } = await connect(f.proxy);
      expect(response.statusCode).toBe(200);
      socket.write("tunnel payload");
      const [echo] = await once(socket, "data");
      expect(echo.toString()).toBe("tunnel payload");
      expect(f.serverNames).toEqual(["localhost"]);
      expect(f.requests).toEqual([
        {
          method: "CONNECT",
          url: "example.com:443",
          host: "example.com:443",
          auth: `Basic ${Buffer.from("test-user:test-password").toString("base64")}`,
        },
      ]);
      socket.destroy();
    } finally {
      await f.close();
    }
  });

  it("preserves the destination Host for HTTP requests through an HTTPS proxy", async () => {
    const f = await fixture();
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(
          {
            host: "127.0.0.1",
            port: f.proxy.port,
            path: "http://example.com/page",
            headers: { Host: "example.com" },
            agent: false,
          },
          resolve,
        );
        req.on("error", reject);
      });
      expect(response.statusCode).toBe(200);
      let body = "";
      for await (const chunk of response) body += chunk;
      expect(body).toBe("forwarded");
      expect(f.serverNames).toEqual(["localhost"]);
      expect(f.requests[0]).toMatchObject({ url: "http://example.com/page", host: "example.com" });
    } finally {
      await f.close();
    }
  });

  it.each([
    ["a certificate for the destination instead of the proxy", "example.com", true],
    ["an untrusted proxy certificate", "localhost", false],
  ])("rejects %s", async (_name, hostname, trustCertificate) => {
    const f = await fixture(hostname as string, trustCertificate as boolean);
    try {
      const { response, socket } = await connect(f.proxy);
      expect(response.statusCode).not.toBe(200);
      expect(f.requests).toEqual([]);
      socket.destroy();
    } finally {
      await f.close();
    }
  });
});
