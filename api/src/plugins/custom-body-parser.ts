import fp from "fastify-plugin";
import { type FastifyInstance, type FastifyPluginAsync } from "fastify";

const customBodyParser: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    function (req, body, done) {
      try {
        // Older clients send an empty JSON body when releasing a session.
        // Preserve that compatibility while still parsing a supplied sessionId.
        const release = /^\/v1\/sessions\/(?:[^/?]+\/)?release\/?$/.test(req.url.split("?", 1)[0]);
        if (release && body.length === 0) done(null, null);
        else done(null, JSON.parse(body.toString()));
      } catch (error) {
        done(Object.assign(error as Error, { statusCode: 400 }), undefined);
      }
    },
  );
};

export default fp(customBodyParser, { name: "custom-body-parser" });
