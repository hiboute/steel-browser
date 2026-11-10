import Fastify from "fastify";
import { writeFile } from "node:fs/promises";
import steelBrowserPlugin from "../src/steel-browser-plugin.js";
import { ShutdownReason } from "../src/services/cdp/plugins/core/base-plugin.js";

// Build the complete route registry without binding an HTTP listener or racing index.ts startup.
const server = Fastify({ logger: false });
try {
  await server.register(steelBrowserPlugin);
  await server.ready();
  const document = server.swagger();
  // Fail before replacing the checked-in contract when route schemas contain
  // unresolved Fastify IDs or broken JSON pointers. Client generators can
  // otherwise report success while silently retaining an obsolete client.
  function validateReferences(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value && typeof value.$ref === "string") {
      const ref = value.$ref;
      if (!ref.startsWith("#/")) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
      const resolved = ref.slice(2).split("/").reduce<unknown>((node, key) => {
        const decoded = key.replace(/~1/g, "/").replace(/~0/g, "~");
        return node && typeof node === "object"
          ? (node as Record<string, unknown>)[decoded]
          : undefined;
      }, document);
      if (resolved === undefined) throw new Error(`Missing OpenAPI reference: ${ref}`);
    }
    for (const child of Object.values(value)) validateReferences(child);
  }
  validateReferences(document);
  await writeFile("./openapi/schemas.json", JSON.stringify(document, null, 2), "utf8");
  console.log("OpenAPI JSON has been written to schemas.json");
} finally {
  await server.close();
  for (const slot of server.browserPool?.allSlots ?? [])
    await slot.cdpService.shutdown(ShutdownReason.SESSION_END);
}
