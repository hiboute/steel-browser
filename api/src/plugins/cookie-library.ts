import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { env } from "../env.js";
import { CookieLibraryService } from "../services/cookie-library.service.js";

declare module "fastify" {
  interface FastifyInstance {
    cookieLibrary: CookieLibraryService;
  }
}

const cookieLibraryPlugin: FastifyPluginAsync = async (fastify) => {
  const dir = env.COOKIE_LIBRARY_DIR || path.join(process.cwd(), "cookie-library");
  const library = new CookieLibraryService(dir, env.COOKIE_LIBRARY_KEY);
  fastify.decorate("cookieLibrary", library);
  fastify.log.info(
    `Cookie library at ${dir} (${
      library.encrypted ? "encrypted" : "not encrypted: set COOKIE_LIBRARY_KEY"
    })`,
  );
};

export default fp(cookieLibraryPlugin, "5.x");
