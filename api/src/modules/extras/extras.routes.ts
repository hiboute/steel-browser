import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { z } from "zod";
import { buildJsonSchemas } from "../../utils/schema.js";
import { ExtrasError } from "../../services/extract.service.js";
import { sanitized, type DataActor } from "../../services/data/common.js";
import { NavigationPolicyError } from "../../services/navigation-policy.js";
import { extrasConfig } from "../../services/extras.config.js";
import { SessionPoolFullError } from "../../services/session.service.js";
import {
  ExtractRequest,
  WarmSettings,
  WarmDetails,
  WatcherSettings,
  WatcherPatch,
  WatcherDetails,
  WatcherRun,
  ExtensionName,
  ExtensionDetails,
  HttpUrl,
  extrasSchemas,
  extrasRef,
} from "./extras.schema.js";

const additional = buildJsonSchemas({
  WarmList: z.object({ warm: z.array(WarmDetails) }),
  WatcherList: z.object({ watchers: z.array(WatcherDetails) }),
  WatcherHistory: z.object({ history: z.array(WatcherRun) }),
  ExtensionList: z.object({ extensions: z.array(ExtensionDetails) }),
  ExtensionInstall: z.object({ name: ExtensionName, url: HttpUrl }).strict(),
  WatcherPatch,
  ExtrasSuccess: z.object({ success: z.literal(true) }),
});
const errors = {
  400: extrasRef("ExtrasError"),
  404: extrasRef("ExtrasError"),
  409: extrasRef("ExtrasError"),
  502: extrasRef("ExtrasError"),
};

async function execute(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ExtrasError || error instanceof NavigationPolicyError)
      return reply
        .code(error.statusCode)
        .send({ success: false, code: error.code, message: error.message });
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof RangeError)
      return reply
        .code(400)
        .send({ success: false, code: "invalid_request", message: error.message });
    if (error instanceof SessionPoolFullError)
      return reply
        .code(429)
        .header("Retry-After", "1")
        .send({ success: false, code: "pool_full", message: error.message });
    throw error;
  }
}

export default async function extrasRoutes(server: FastifyInstance) {
  // Validation and body-parser errors happen before handlers, but must still match
  // this plugin's error response schema instead of failing error serialization.
  server.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, "Extras request failed");
    return reply.code(status).send({
      success: false,
      code:
        error instanceof ExtrasError
          ? error.code
          : status < 500
          ? "invalid_request"
          : "internal_error",
      message: status < 500 ? error.message : "The requested operation failed",
    });
  });
  for (const schema of [...extrasSchemas, ...additional.schemas]) server.addSchema(schema);
  await server.register(fastifyMultipart, {
    limits: { fileSize: extrasConfig.EXTENSION_MAX_MB * 1024 * 1024, files: 1, fields: 1 },
  });

  server.post(
    "/extract",
    {
      schema: {
        operationId: "extract_structured_data",
        tags: ["Extract"],
        summary: "Extract schema-validated JSON from a page",
        body: extrasRef("ExtractRequest"),
        response: { 200: extrasRef("ExtractResponse"), ...errors },
      },
    },
    async (request, reply) => {
      const abort = new AbortController();
      const closed = () => {
        if (!reply.raw.writableFinished) abort.abort();
      };
      reply.raw.once("close", closed);
      try {
        return await execute(reply, async () => {
          const input = ExtractRequest.parse(request.body);
          const access = (
            server as unknown as {
              access?: {
                actor(request: FastifyRequest): DataActor;
                authorizeSession(request: FastifyRequest, id: string): DataActor;
              };
            }
          ).access;
          const actor = access?.actor(request);
          if (input.sessionId) access?.authorizeSession(request, input.sessionId);
          const result = await server.extractService.extract(
            input,
            actor?.id ?? request.steelClient,
            abort.signal,
          );
          if (actor && server.hasDecorator("dataRecords")) {
            const record = await server.dataRecords.create(
              "extract",
              actor.id,
              sanitized(result) as object,
              input.sessionId,
            );
            await server.sessionSearch.index({
              sourceId: record.id,
              owner: actor.id,
              sessionId: input.sessionId,
              title: result.title,
              text: JSON.stringify(sanitized(result.data)),
              kind: "extract",
              href: input.sessionId ? `/sessions/${input.sessionId}` : "/automation",
              expiresAt: record.expiresAt,
            });
            return { ...result, extractionId: record.id };
          }
          return result;
        });
      } finally {
        reply.raw.off("close", closed);
      }
    },
  );
  server.get(
    "/warm",
    {
      schema: {
        operationId: "list_warm_sessions",
        tags: ["Warm sessions"],
        response: { 200: additional.$ref("WarmList") },
      },
    },
    async () => ({ warm: server.warmService.list() }),
  );
  server.put(
    "/warm/:name",
    {
      schema: {
        operationId: "save_warm_session",
        tags: ["Warm sessions"],
        body: extrasRef("WarmSettings"),
        response: { 200: extrasRef("WarmDetails"), ...errors },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string } }>, reply) =>
      execute(reply, async () => {
        const name = ExtensionName.parse(request.params.name);
        const result = await server.warmService.put(
          name,
          WarmSettings.parse(request.body),
          request.steelClient,
        );
        await server.audit.log("warm.updated", { client: request.steelClient, subject: name });
        return result;
      }),
  );
  server.delete(
    "/warm/:name",
    {
      schema: {
        operationId: "delete_warm_session",
        tags: ["Warm sessions"],
        response: { 200: additional.$ref("ExtrasSuccess"), ...errors },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string } }>, reply) =>
      execute(reply, async () => {
        await server.warmService.remove(ExtensionName.parse(request.params.name));
        await server.audit.log("warm.deleted", {
          client: request.steelClient,
          subject: request.params.name,
        });
        return { success: true };
      }),
  );
  server.post(
    "/warm/:name/restart",
    {
      schema: {
        operationId: "restart_warm_session",
        tags: ["Warm sessions"],
        response: { 200: extrasRef("WarmDetails"), ...errors },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string } }>, reply) =>
      execute(reply, () => server.warmService.restart(ExtensionName.parse(request.params.name))),
  );
  server.get(
    "/watchers",
    {
      schema: {
        operationId: "list_watchers",
        tags: ["Watchers"],
        response: { 200: additional.$ref("WatcherList") },
      },
    },
    async () => ({ watchers: server.watcherService.list() }),
  );
  server.post(
    "/watchers",
    {
      schema: {
        operationId: "create_watcher",
        tags: ["Watchers"],
        body: extrasRef("WatcherSettings"),
        response: { 200: extrasRef("WatcherDetails"), ...errors },
      },
    },
    async (request, reply) =>
      execute(reply, async () => {
        const watcher = await server.watcherService.create(
          WatcherSettings.parse(request.body),
          request.steelClient,
        );
        await server.audit.log("watcher.created", {
          client: request.steelClient,
          subject: watcher.id,
        });
        return watcher;
      }),
  );
  server.get(
    "/watchers/:id",
    {
      schema: {
        operationId: "get_watcher",
        tags: ["Watchers"],
        response: { 200: extrasRef("WatcherDetails"), ...errors },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) =>
      execute(reply, async () =>
        server.watcherService.get(z.string().uuid().parse(request.params.id)),
      ),
  );
  for (const method of ["PATCH", "PUT"] as const)
    server.route({
      method,
      url: "/watchers/:id",
      schema: {
        operationId: method === "PUT" ? "replace_watcher" : "update_watcher",
        tags: ["Watchers"],
        body: method === "PUT" ? extrasRef("WatcherSettings") : additional.$ref("WatcherPatch"),
        response: { 200: extrasRef("WatcherDetails"), ...errors },
      },
      handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply) =>
        execute(reply, async () => {
          const id = z.string().uuid().parse(request.params.id);
          const previous = server.watcherService.get(id);
          const patch = method === "PATCH" ? WatcherPatch.parse(request.body) : undefined;
          const input = patch
            ? {
                ...previous,
                ...patch,
                extract: { ...previous.extract, ...patch.extract },
                condition: { ...previous.condition, ...patch.condition },
                notify: { ...previous.notify, ...patch.notify },
              }
            : request.body;
          const watcher = await server.watcherService.update(
            id,
            WatcherSettings.strip().parse(input),
          );
          await server.audit.log("watcher.updated", { client: request.steelClient, subject: id });
          return watcher;
        }),
    });
  server.delete(
    "/watchers/:id",
    {
      schema: {
        operationId: "delete_watcher",
        tags: ["Watchers"],
        response: { 200: additional.$ref("ExtrasSuccess"), ...errors },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) =>
      execute(reply, async () => {
        const id = z.string().uuid().parse(request.params.id);
        await server.watcherService.remove(id);
        await server.audit.log("watcher.deleted", { client: request.steelClient, subject: id });
        return { success: true };
      }),
  );
  server.post(
    "/watchers/:id/run",
    {
      schema: {
        operationId: "run_watcher",
        tags: ["Watchers"],
        response: { 200: extrasRef("WatcherRun"), ...errors },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) =>
      execute(reply, () => server.watcherService.run(z.string().uuid().parse(request.params.id))),
  );
  server.get(
    "/watchers/:id/history",
    {
      schema: {
        operationId: "get_watcher_history",
        tags: ["Watchers"],
        response: { 200: additional.$ref("WatcherHistory"), ...errors },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) =>
      execute(reply, async () => ({
        history: await server.watcherService.history(z.string().uuid().parse(request.params.id)),
      })),
  );

  server.get(
    "/extensions",
    {
      schema: {
        operationId: "list_extensions",
        tags: ["Extensions"],
        response: { 200: additional.$ref("ExtensionList") },
      },
    },
    async () => ({ extensions: await server.extensionService.list() }),
  );
  server.post(
    "/extensions",
    {
      schema: {
        operationId: "install_extension",
        tags: ["Extensions"],
        summary: "Install an unpacked extension from a ZIP or CRX upload or URL",
        description:
          "Send JSON {name,url}, or multipart fields name and file. Only stored/deflated ZIP and CRX2/CRX3 are accepted; archive paths and expanded sizes are validated.",
        body: { content: { "application/json": { schema: additional.$ref("ExtensionInstall") } } },
        response: { 200: extrasRef("ExtensionDetails"), ...errors },
      },
    },
    async (request, reply) =>
      execute(reply, async () => {
        let result;
        if (request.isMultipart()) {
          let name: string | undefined;
          let archive: Buffer | undefined;
          for await (const part of request.parts()) {
            if (part.type === "file") archive = await part.toBuffer();
            else if (part.fieldname === "name") name = ExtensionName.parse(part.value);
          }
          if (!name || !archive)
            throw new ExtrasError(
              "invalid_request",
              "Multipart upload requires name and file fields",
            );
          result = await server.extensionService.install(name, archive);
        } else {
          const body = z.object({ name: ExtensionName, url: HttpUrl }).strict().parse(request.body);
          result = await server.extensionService.installFromUrl(body.name, body.url);
        }
        await server.audit.log("extension.installed", {
          client: request.steelClient,
          subject: result.name,
        });
        return result;
      }),
  );
  server.delete(
    "/extensions/:name",
    {
      schema: {
        operationId: "delete_extension",
        tags: ["Extensions"],
        response: { 200: additional.$ref("ExtrasSuccess"), ...errors },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string } }>, reply) =>
      execute(reply, async () => {
        const name = ExtensionName.parse(request.params.name);
        await server.extensionService.remove(name);
        await server.audit.log("extension.deleted", { client: request.steelClient, subject: name });
        return { success: true };
      }),
  );
}
