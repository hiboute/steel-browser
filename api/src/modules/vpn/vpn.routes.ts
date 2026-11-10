import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nordVpnConfigured } from "../../services/nordvpn.service.js";

/** Which VPNs a session can use (`vpn` on POST /v1/sessions). */
async function routes(server: FastifyInstance) {
  server.get(
    "/vpn",
    {
      schema: {
        operationId: "get_vpn_providers",
        summary: "List VPN providers",
        description: "VPN providers a session can be routed through, and whether each is set up.",
        tags: ["Sessions"],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.send({ providers: [{ id: "nordvpn", configured: nordVpnConfigured() }] }),
  );
}

export default routes;
