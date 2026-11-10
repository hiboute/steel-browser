import { Server } from "proxy-chain";
// A fixed upstream is mandatory. No route ever returns a direct connection.
const upstream = process.env.STEEL_GATEWAY_UPSTREAM;
if (!upstream || !/^https?:\/\//.test(upstream)) throw new Error("Configured HTTP(S) upstream is required");
const parsed = new URL(upstream); if (!parsed.hostname) throw new Error("Invalid upstream");
const server = new Server({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0", verbose: false, prepareRequestFunction: ({ hostname, port }) => {
  if (![80, 443].includes(port) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::|\[?fc|\[?fd)/i.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return { requestAuthentication: true, failMsg: "Destination disallowed" };
  return { upstreamProxyUrl: upstream };
} });
await server.listen(); for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => void server.close(true));
