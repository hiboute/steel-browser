import Fastify from "fastify";
import { writeFile } from "node:fs/promises";
import steelBrowserPlugin from "../src/steel-browser-plugin.js";
import { ShutdownReason } from "../src/services/cdp/plugins/core/base-plugin.js";

// Build the complete route registry without binding an HTTP listener or racing index.ts startup.
const server = Fastify({ logger: false });
try {
  await server.register(steelBrowserPlugin);
  await server.ready();
  await writeFile("./openapi/schemas.json", JSON.stringify(server.swagger(), null, 2), "utf8");
  console.log("OpenAPI JSON has been written to schemas.json");
} finally {
  await server.close();
  for (const slot of server.browserPool?.allSlots ?? [])
    await slot.cdpService.shutdown(ShutdownReason.SESSION_END);
}
