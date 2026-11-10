import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CookieSetNotFoundError,
  CookieSetDeniedError,
  CookieSetConflictError,
  CookieSetSettings as Settings,
  filterByDomains,
  summarize,
} from "../../services/cookie-library.service.js";
import { getErrors } from "../../utils/errors.js";
import { buildJsonSchemas } from "../../utils/schema.js";
import { cookieLibrarySchemas } from "./cookie-library.schema.js";
import type { CookieData, LocalStorageData } from "../../services/context/types.js";

type NameParams = { Params: { name: string } };
const { schemas, $ref } = buildJsonSchemas(cookieLibrarySchemas);
function client(request: FastifyRequest): string {
  const value =
    (request as FastifyRequest & { steelClient?: string }).steelClient ??
    request.headers["x-steel-client"];
  return typeof value === "string" && value.length <= 128 ? value : "anonymous";
}
function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof CookieSetNotFoundError)
    return reply
      .code(404)
      .send({ success: false, code: "cookie_set_not_found", message: error.message });
  if (error instanceof CookieSetDeniedError)
    return reply
      .code(403)
      .send({ success: false, code: "cookie_set_denied", message: error.message });
  if (error instanceof CookieSetConflictError)
    return reply.code(409).send({ success: false, code: error.code, message: error.message });
  const message = String(getErrors(error));
  const status = /names are|not live|not found|invalid.*pattern/i.test(message) ? 400 : 500;
  return reply.code(status).send({
    success: false,
    code: status === 400 ? "invalid_request" : "cookie_set_error",
    message,
  });
}
const errorResponses = {
  400: $ref("CookieSetError"),
  403: $ref("CookieSetError"),
  404: $ref("CookieSetError"),
  409: $ref("CookieSetError"),
};
const base = { tags: ["Cookie library"], params: $ref("CookieSetName") };

async function routes(server: FastifyInstance) {
  server.setErrorHandler((error, _request, reply) => {
    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({
        success: false,
        code: "invalid_request",
        message: String((error as Error).message),
      });
    }
    return reply.send(error);
  });
  for (const schema of schemas) if (!server.getSchema(schema.$id)) server.addSchema(schema);
  const library = server.cookieLibrary;
  const authorizeExisting = async (name: string, caller: string) => {
    try {
      await library.assertAccess(name, caller);
    } catch (error) {
      if (!(error instanceof CookieSetNotFoundError)) throw error;
    }
  };
  const audit = async (event: string, request: FastifyRequest<NameParams>, sessionId?: string) => {
    await library.audit(event, {
      client: client(request),
      subject: request.params.name,
      sessionId,
    });
    library.changed(request.params.name, event);
  };
  server.get(
    "/cookie-library",
    {
      schema: {
        operationId: "list_cookie_sets",
        summary: "List saved cookie sets without credentials",
        tags: ["Cookie library"],
        response: { 200: $ref("CookieSetList") },
      },
    },
    async (request, reply) => {
      try {
        return reply.send({
          sets: await library.list(client(request)),
          encrypted: library.encrypted,
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
  server.get(
    "/cookie-library/:name",
    {
      schema: {
        ...base,
        operationId: "get_cookie_set",
        summary: "Get a cookie set, values included",
        response: { 200: $ref("CookieSet"), ...errorResponses },
      },
    },
    async (request: FastifyRequest<NameParams>, reply) => {
      try {
        const set = await library.assertAccess(request.params.name, client(request));
        await audit("cookieset.read", request);
        return reply.send(set);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
  server.put(
    "/cookie-library/:name",
    {
      schema: {
        ...base,
        operationId: "put_cookie_set",
        summary: "Import cookies and localStorage",
        body: $ref("CookieSetImport"),
        response: { 200: $ref("CookieSetSummary"), ...errorResponses },
      },
    },
    async (
      request: FastifyRequest<
        NameParams & {
          Body: {
            description?: string;
            cookies: CookieData[];
            localStorage?: Record<string, LocalStorageData>;
          };
        }
      >,
      reply,
    ) => {
      try {
        await authorizeExisting(request.params.name, client(request));
        const set = await library.save({ name: request.params.name, ...request.body });
        await audit("cookieset.imported", request);
        return reply.send(summarize(set));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
  server.patch(
    "/cookie-library/:name",
    {
      schema: {
        ...base,
        operationId: "update_cookie_set",
        summary: "Update login checks, identity, write-back and access rules",
        body: $ref("CookieSetSettings"),
        response: { 200: $ref("CookieSetSummary"), ...errorResponses },
      },
    },
    async (request: FastifyRequest<NameParams & { Body: Settings }>, reply) => {
      try {
        await library.assertAccess(request.params.name, client(request));
        if (request.body.check?.loggedOutUrlPattern) {
          try {
            new RegExp(request.body.check.loggedOutUrlPattern);
          } catch {
            throw new Error("Invalid logged-out URL pattern");
          }
        }
        const set = await library.update(request.params.name, request.body);
        await audit("cookieset.updated", request);
        return reply.send(summarize(set));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
  server.post(
    "/cookie-library/:name/capture",
    {
      schema: {
        ...base,
        operationId: "capture_cookie_set",
        summary: "Save a session's cookies, localStorage and browser identity",
        body: $ref("CookieSetCapture"),
        response: { 200: $ref("CookieSetSummary"), ...errorResponses },
      },
    },
    async (
      request: FastifyRequest<
        NameParams & {
          Body: { sessionId?: string; domains?: string[]; description?: string } | undefined;
        }
      >,
      reply,
    ) => {
      try {
        await authorizeExisting(request.params.name, client(request));
        const { sessionId, domains, description } = request.body ?? {};
        const session = sessionId
          ? server.sessionService.findSocketSession(sessionId)
          : server.sessionService.activeSession;
        if (!session || (session.status !== "live" && session.status !== "idle"))
          throw new Error(`Session ${sessionId ?? ""} is not live`.replace("  ", " "));
        const state = await session.cdpService.getBrowserState();
        state.cookies = await session.cdpService.getCookies();
        const picked = filterByDomains(
          { cookies: state.cookies ?? [], localStorage: state.localStorage },
          domains,
        );
        const options = server.sessionService.getLaunchOptions(session.id);
        const set = await library.save({
          name: request.params.name,
          description,
          ...picked,
          sourceSessionId: session.id,
          fingerprint: {
            fingerprint: session.cdpService.getFingerprintData() ?? undefined,
            userAgent: session.cdpService.getUserAgent(),
            dimensions: session.cdpService.getDimensions(),
            timezone: options?.timezone,
            locale: options?.userPreferences?.intl?.accept_languages,
          },
        });
        server.sessionService.touch(session.id, "cookie_capture");
        await audit("cookieset.captured", request, session.id);
        return reply.send(summarize(set));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
  server.post(
    "/cookie-library/:name/check",
    {
      schema: {
        ...base,
        operationId: "check_cookie_set",
        summary: "Run this cookie set's login check now",
        response: { 200: $ref("CookieSetChecked"), ...errorResponses, 503: $ref("CookieSetError") },
      },
    },
    async (request: FastifyRequest<NameParams>, reply) => {
      try {
        const result = await server.cookieHealth.check(request.params.name, client(request));
        if ("skipped" in result)
          return reply.code(503).send({
            success: false,
            code: "pool_busy",
            message: "No background browser is available. Retry when a slot is free.",
          });
        return reply.send(result);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
  server.post(
    "/cookie-library/:name/restore-previous",
    {
      schema: {
        ...base,
        operationId: "restore_cookie_set",
        summary: "Restore credentials saved before the last write-back",
        response: { 200: $ref("CookieSetSummary"), ...errorResponses },
      },
    },
    async (request: FastifyRequest<NameParams>, reply) => {
      try {
        await library.assertAccess(request.params.name, client(request));
        const set = await library.restorePrevious(request.params.name);
        await audit("cookieset.restored", request);
        return reply.send(summarize(set));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
  server.delete(
    "/cookie-library/:name",
    {
      schema: {
        ...base,
        operationId: "delete_cookie_set",
        summary: "Delete a cookie set",
        response: errorResponses,
      },
    },
    async (request: FastifyRequest<NameParams>, reply) => {
      try {
        await library.assertAccess(request.params.name, client(request));
        await library.delete(request.params.name);
        await audit("cookieset.deleted", request);
        return reply.send({ success: true });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
export default routes;
