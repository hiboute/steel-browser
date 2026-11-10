import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { Actor } from "./control/access.js";
import type { SearchDocument } from "./data/search.js";
import { isSensitiveSession } from "./data/privacy.js";

/** Index bounded task metadata, never command inputs, results or secret values. */
const plugin: FastifyPluginAsync = async (server) => {
  const internal: Actor = { id: "system:workspace-index", role: "operator", authenticated: true };
  let pending = Promise.resolve();
  let closed = false;
  const queue = (work: () => Promise<void>) => {
    if (closed) return;
    pending = pending.then(work).catch((error) => {
      server.log.warn(
        { code: (error as { code?: string }).code ?? "index_failed" },
        "Workspace metadata index update failed",
      );
    });
  };
  const sourceAccess =
    (check: (document: SearchDocument, actor: Actor) => unknown | Promise<unknown>) =>
    async (document: SearchDocument, actor: Actor) => {
      try {
        if (document.sessionId) {
          server.access.assertRead(actor, document.sessionId);
          if (isSensitiveSession(document.sessionId)) return false;
        }
        await check(document, actor);
        return true;
      } catch {
        return false;
      }
    };
  const unregister = [
    server.sessionSearch.registerSource(
      "run",
      sourceAccess((d, actor) => server.runs.get(d.sourceId, actor)),
    ),
    server.sessionSearch.registerSource(
      "procedure",
      sourceAccess((d, actor) => server.workflowService.getProcedure(d.sourceId, undefined, actor)),
    ),
    server.sessionSearch.registerSource(
      "receipt",
      sourceAccess(async (d, actor) => {
        server.runs.get(d.sourceId, actor);
        const receipt = (await server.workflowService.listReceipts(actor)).find(
          (record) => record.id === d.sourceId,
        );
        if (!receipt) throw new Error("Receipt no longer exists");
      }),
    ),
  ];
  const indexRun = async (id: string) => {
    const run = server.runs.get(id, internal);
    if (run.sessionId && isSensitiveSession(run.sessionId)) {
      await server.sessionSearch.remove("run", id);
      return;
    }
    const name =
      typeof run.metadata?.name === "string" ? run.metadata.name : `Task ${id.slice(0, 8)}`;
    await server.sessionSearch.index({
      sourceId: id,
      kind: "run",
      owner: run.ownerId,
      sessionId: run.sessionId,
      title: name,
      text: `${run.status} ${run.cursor}/${run.steps.length} ${run.pauseReason ?? ""}`,
      href: "/?view=inbox",
    });
  };
  const indexProcedure = async (id: string) => {
    const procedure = server.workflowService.getProcedure(id, undefined, internal);
    await server.sessionSearch.index({
      sourceId: id,
      kind: "procedure",
      owner: procedure.ownerId,
      title: procedure.name,
      text: `${procedure.description} version ${procedure.version}`,
      href: "/?view=automation",
    });
  };
  const indexReceipt = async (id: string) => {
    const receipt = (await server.workflowService.listReceipts(internal)).find(
      (row) => row.id === id,
    );
    if (!receipt || (receipt.sessionId && isSensitiveSession(receipt.sessionId))) {
      await server.sessionSearch.remove("receipt", id);
      return;
    }
    await server.sessionSearch.index({
      sourceId: id,
      kind: "receipt",
      owner: receipt.ownerId,
      sessionId: receipt.sessionId,
      title: receipt.summary,
      text: `${receipt.status} ${receipt.runStatus}`,
      href: "/?view=automation",
    });
  };
  const unsubscribe = server.events.subscribe((event) => {
    const data = event.data as { id?: string; run?: { id?: string } } | null;
    if (event.type === "run.updated" && data?.run?.id) queue(() => indexRun(data.run!.id!));
    if (event.type === "workflow.procedure.updated" && data?.id)
      queue(() => indexProcedure(data.id!));
    if (event.type === "workflow.procedure.deleted" && data?.id)
      queue(() => server.sessionSearch.remove("procedure", data.id!));
    if (event.type === "workflow.receipt.updated" && data?.id) queue(() => indexReceipt(data.id!));
  });
  server.addHook("onReady", async () => {
    for (const run of server.runs.list(internal)) await indexRun(run.id);
    for (const procedure of server.workflowService.listProcedures(internal))
      await indexProcedure(procedure.id);
    for (const receipt of await server.workflowService.listReceipts(internal))
      await indexReceipt(receipt.id);
    await pending;
  });
  server.addHook("preClose", async () => {
    closed = true;
    unsubscribe();
    await pending;
    unregister.forEach((remove) => remove());
  });
};
export default fp(plugin, {
  name: "workspace-index",
  dependencies: ["next-platform", "steel-workflows"],
});
