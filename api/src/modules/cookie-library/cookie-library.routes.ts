import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CookieSetNotFoundError,
  filterByDomains,
  summarize,
} from "../../services/cookie-library.service.js";
import { getErrors } from "../../utils/errors.js";

type NameParams = { Params: { name: string } };

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof CookieSetNotFoundError) {
    return reply.code(404).send({ success: false, message: error.message });
  }
  const message = getErrors(error);
  const status = /names are|not live|not found/i.test(String(message)) ? 400 : 500;
  return reply.code(status).send({ success: false, message });
}

const nameParam = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
} as const;

/**
 * Cookie library: named sets of cookies (and localStorage) captured from a
 * logged-in session, reusable in new sessions via `cookieSets` on
 * POST /v1/sessions.
 */
async function routes(server: FastifyInstance) {
  const library = server.cookieLibrary;

  server.get(
    "/cookie-library",
    {
      schema: {
        operationId: "list_cookie_sets",
        summary: "List saved cookie sets",
        description: "Lists the cookie library, without cookie values.",
        tags: ["Cookie library"],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send({ sets: await library.list(), encrypted: library.encrypted });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  server.get(
    "/cookie-library/:name",
    {
      schema: {
        operationId: "get_cookie_set",
        summary: "Get a cookie set, values included",
        tags: ["Cookie library"],
        params: nameParam,
      },
    },
    async (request: FastifyRequest<NameParams>, reply: FastifyReply) => {
      try {
        return reply.send(await library.get(request.params.name));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  server.put(
    "/cookie-library/:name",
    {
      schema: {
        operationId: "put_cookie_set",
        summary: "Save a cookie set from cookies you provide (import)",
        tags: ["Cookie library"],
        params: nameParam,
        body: {
          type: "object",
          properties: {
            description: { type: "string" },
            cookies: { type: "array", items: { type: "object", additionalProperties: true } },
            localStorage: { type: "object", additionalProperties: true },
          },
          required: ["cookies"],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { name: string };
        Body: { description?: string; cookies: any[]; localStorage?: Record<string, any> };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const set = await library.save({ name: request.params.name, ...request.body });
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
        operationId: "capture_cookie_set",
        summary: "Save a live (or the idle) session's cookies and localStorage as a cookie set",
        description:
          "Reads the cookies and localStorage of a live session (default: the most recent one) and saves them under this name, replacing any set with the same name. Pass domains to keep only those sites (subdomains included).",
        tags: ["Cookie library"],
        params: nameParam,
        body: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            domains: { type: "array", items: { type: "string" } },
            description: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { name: string };
        Body: { sessionId?: string; domains?: string[]; description?: string } | undefined;
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { sessionId, domains, description } = request.body ?? {};
        // The idle browser counts too: it is where people log in by hand.
        const session = sessionId
          ? server.sessionService.findSocketSession(sessionId)
          : server.sessionService.activeSession;
        if (!session || (session.status !== "live" && session.status !== "idle")) {
          throw new Error(`Session ${sessionId ?? ""} is not live`.replace("  ", " "));
        }
        const state = await session.cdpService.getBrowserState();
        const picked = filterByDomains(
          { cookies: state.cookies ?? [], localStorage: state.localStorage ?? {} },
          domains,
        );
        const set = await library.save({
          name: request.params.name,
          description,
          cookies: picked.cookies,
          localStorage: picked.localStorage,
          sourceSessionId: session.id,
        });
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
        operationId: "delete_cookie_set",
        summary: "Delete a cookie set",
        tags: ["Cookie library"],
        params: nameParam,
      },
    },
    async (request: FastifyRequest<NameParams>, reply: FastifyReply) => {
      try {
        await library.delete(request.params.name);
        return reply.send({ success: true });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}

export default routes;
