import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { WorkbenchService } from "./workbench.service.js";
import { defaultWorkbenchAdapters } from "./adapters.js";
import type { WorkbenchAdapters } from "./types.js";
import workbenchRoutes from "../../modules/workbench/workbench.routes.js";

declare module "fastify" {
  interface FastifyInstance {
    workbench: WorkbenchService;
  }
}
const plugin: FastifyPluginAsync<{ adapters?: Partial<WorkbenchAdapters> }> = async (
  server,
  options,
) => {
  const workbench = new WorkbenchService(
    server.store,
    { ...defaultWorkbenchAdapters(server), ...options.adapters },
    (type, value, id) => server.events.publish(type, value, id),
  );
  server.decorate("workbench", workbench);
  server.addHook("onClose", () => workbench.close());
  await server.register(workbenchRoutes, { prefix: "/v1" });
};
export default fp(plugin, { name: "workbench", fastify: "5.x" });
