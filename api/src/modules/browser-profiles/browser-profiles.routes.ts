import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readdir, rm, stat } from "fs/promises";
import path from "path";
import {
  BROWSER_PROFILE_NAME,
  PROFILE_FINGERPRINT_FILE,
  browserProfilesDir,
} from "../../services/session.service.js";

type NameParams = { Params: { name: string } };

const nameParam = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
} as const;

/**
 * Saved browsers: named persistent Chrome profiles (cookies, storage, the
 * fingerprint) that a session runs in with `browserProfile` on
 * POST /v1/sessions. Unlike a cookie set, the site sees the same browser.
 */
async function routes(server: FastifyInstance) {
  server.get(
    "/browser-profiles",
    {
      schema: {
        operationId: "list_browser_profiles",
        summary: "List saved browsers",
        description: "Lists the saved browsers (persistent Chrome profiles) and which session uses each.",
        tags: ["Saved browsers"],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const root = browserProfilesDir();
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const profiles = await Promise.all(
        entries
          .filter((e) => e.isDirectory() && BROWSER_PROFILE_NAME.test(e.name))
          .map(async (e) => {
            const dir = path.join(root, e.name);
            const info = await stat(dir).catch(() => null);
            const fingerprint = await stat(path.join(dir, PROFILE_FINGERPRINT_FILE))
              .then(() => true)
              .catch(() => false);
            return {
              name: e.name,
              inUseBy: server.sessionService.profileHolder(e.name) ?? null,
              updatedAt: info ? info.mtime.toISOString() : null,
              fingerprint,
            };
          }),
      );
      profiles.sort((a, b) => a.name.localeCompare(b.name));
      return reply.send({ profiles });
    },
  );

  server.delete(
    "/browser-profiles/:name",
    {
      schema: {
        operationId: "delete_browser_profile",
        summary: "Delete a saved browser",
        description: "Deletes a saved browser and everything in it (logins included). Refused while a session uses it.",
        tags: ["Saved browsers"],
        params: nameParam,
      },
    },
    async (request: FastifyRequest<NameParams>, reply: FastifyReply) => {
      const { name } = request.params;
      if (!BROWSER_PROFILE_NAME.test(name)) {
        return reply.code(400).send({ success: false, message: "Invalid saved browser name." });
      }
      const holder = server.sessionService.profileHolder(name);
      if (holder !== undefined) {
        return reply
          .code(409)
          .send({ success: false, message: `Saved browser "${name}" is in use by session ${holder}.` });
      }
      const dir = path.join(browserProfilesDir(), name);
      const exists = await stat(dir).then(() => true).catch(() => false);
      if (!exists) return reply.code(404).send({ success: false, message: `No saved browser "${name}".` });
      await rm(dir, { recursive: true, force: true });
      return reply.send({ success: true });
    },
  );
}

export default routes;
