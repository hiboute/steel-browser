import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import path from "node:path";
import { DataError, DataRecords, type DataActor, type DataRecord } from "./common.js";
import { PageDiffService, type PageSnapshot } from "./page-diffs.js";
import { VaultService, type VaultFillGuard } from "./vault.js";
import { ArtifactService, type ProcessedArtifact } from "./artifacts.js";
import { WorkspaceBackup } from "./workspace-backup.js";
import { workspaceRoots } from "./workspace-recovery.js";
import { SessionSearch, type SearchDocument } from "./search.js";

import { isSensitiveSession, markSensitiveSession } from "./privacy.js";

interface Access {
  actor(request: FastifyRequest): DataActor;
  authorizeSession(request: FastifyRequest, id: string, write?: boolean): DataActor;
  assertRead(actor: DataActor, id: string): void;
  assertMutation(actor: DataActor, id: string, token?: string): void;
}
declare module "fastify" {
  interface FastifyInstance {
    dataVaultFill(
      sessionId: string,
      actor: DataActor,
      input: z.infer<typeof Fill>,
      guard: VaultFillGuard,
    ): Promise<unknown>;
    dataRecords: DataRecords;
    pageDiffs: PageDiffService;
    vault: VaultService;
    artifactProcessing: ArtifactService;
    workspaceBackup: WorkspaceBackup;
    sessionSearch: SessionSearch;
  }
}
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Capture = z
  .object({
    name: z.string().max(100).optional(),
    selector: z.string().max(500).optional(),
    ignoreSelectors: z.array(z.string().max(500)).max(30).optional(),
    ignorePatterns: z.array(z.string().min(1).max(200)).max(30).optional(),
    visual: z.boolean().optional(),
  })
  .strict();
const Fill = z
  .object({
    reference: z.string().max(80),
    selector: z.string().max(500),
    frameUrl: z.string().url().max(2000).optional(),
  })
  .strict();
const Process = z
  .object({
    path: z.string().min(1).max(1000),
    ocr: z.boolean().optional(),
    destination: z.string().max(80).optional(),
  })
  .strict();
const Export = z
  .object({ scopes: z.array(z.string()).min(1).max(10), passphrase: z.string().min(16).max(1024) })
  .strict();
const Restore = Export.extend({
  archive: z.string().max(140 * 1024 * 1024),
  conflict: z.enum(["reject", "replace"]),
}).strict();

const plugin: FastifyPluginAsync = async (server) => {
  const access = (server as unknown as { access?: Access }).access;
  if (!access)
    throw new Error("Steel data features require the control/access plugin to be registered first");
  const records = new DataRecords(server.store, 30, (actor, id) => {
    if (server.sessionService.getSession(id)) access.assertRead(actor, id);
  });
  const diffs = new PageDiffService(records);
  const vault = new VaultService();
  const artifacts = new ArtifactService(records, (id) =>
    server.fileService.forSession(id).getBaseFilesPath(),
  );
  const backup = new WorkspaceBackup(workspaceRoots(), server.store.path("recovery"), () => {
    if (
      server.sessionService.listSessions().some((session) => session.status === "live") ||
      server.sessionService.getPoolStatus().queued
    )
      throw new DataError(
        "workspace_busy",
        "Park or release browsers and clear queued work before workspace export",
        409,
      );
  });
  const search = new SessionSearch(records, async (document, actor) => {
    try {
      if (document.sessionId && server.sessionService.getSession(document.sessionId))
        access.assertRead(actor, document.sessionId);
      if (document.sourceKind === "artifact") await artifacts.get(document.sourceId, actor);
      else if (document.sourceKind === "snapshot") await diffs.get(document.sourceId, actor);
      else if (document.sourceKind === "extract")
        await records.get("extract", document.sourceId, actor);
      else {
        // Product sources register a checker; never return a stale or unknown source by default.
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });
  server.watcherService.setPageDiffs(async (page, record, sessionId) => {
    const actor: DataActor = {
      id: record.client || "anonymous",
      role: "agent",
      authenticated: true,
    };
    const snapshot = await diffs.capture(page, sessionId, actor, record.pageDiff || {});
    let comparison: Awaited<ReturnType<PageDiffService["compare"]>> | undefined;
    if (record.state.lastSnapshotId) {
      try {
        comparison = await diffs.compare(record.state.lastSnapshotId, snapshot.id, actor);
      } catch (error) {
        if (!(error instanceof DataError) || error.code !== "not_found") throw error;
      }
    }
    await search.index({
      sourceId: snapshot.id,
      owner: actor.id,
      sessionId,
      title: record.name,
      text: snapshot.text,
      kind: "snapshot",
      href: "/?view=automation",
      expiresAt: snapshot.expiresAt,
    });
    return { snapshotId: snapshot.id, text: snapshot.text, diff: comparison };
  });
  server.decorate("dataRecords", records);
  server.decorate("pageDiffs", diffs);
  server.decorate("vault", vault);
  server.decorate("artifactProcessing", artifacts);
  server.decorate("workspaceBackup", backup);
  server.decorate("sessionSearch", search);
  for (const file of await server.store.list("data/sensitive"))
    if (/^[A-Za-z0-9_-]+\.json$/.test(file)) markSensitiveSession(file.slice(0, -5));
  server.decorate(
    "dataVaultFill",
    async (id: string, actor: DataActor, input: z.infer<typeof Fill>, guard: VaultFillGuard) => {
      guard.assertControl();
      const session = server.sessionService.getSession(id);
      if (!session || session.status !== "live")
        throw new DataError("session_not_live", "Resume the browser before filling secrets", 409);
      markSensitiveSession(id);
      await server.store.write(`data/sensitive/${id}.json`, {
        at: new Date().toISOString(),
        reason: "vault",
      });
      const protector = server.sessionService as unknown as { protectSession?(id: string): void };
      protector.protectSession?.(id);
      session.cdpService.getInstrumentationLogger().setPrivateCapture?.();
      if (
        server.hasDecorator("recordings") &&
        server.recordings
          .list()
          .some((item) => item.sessionId === id && item.status === "recording")
      )
        await server.recordings.stop(id, "vault_sensitive");
      const result = await vault.fill(
        await session.cdpService.getPrimaryPage(),
        actor,
        input,
        guard,
      );
      await server.audit.log("vault.filled", {
        client: actor.id,
        sessionId: id,
        subject: result.reference,
        detail: { origin: result.origin, selector: result.selector },
      });
      return result;
    },
  );
  const unhookPrivacy = server.sessionService.hooks.add({
    onStarted: async (session) => {
      if (isSensitiveSession(session.id))
        session.cdpService.getInstrumentationLogger().setPrivateCapture?.();
    },
    onResumed: async (session) => {
      if (isSensitiveSession(session.id))
        session.cdpService.getInstrumentationLogger().setPrivateCapture?.();
    },
  });
  server.addHook("onClose", async () => {
    unhookPrivacy();
  });
  await server.register(
    async (routes) => {
      routes.setErrorHandler((error, _request, reply) => {
        const known = error instanceof DataError;
        const suppliedStatus = (error as { statusCode?: number }).statusCode;
        const statusCode = known
          ? error.statusCode
          : error instanceof z.ZodError
          ? 400
          : suppliedStatus && suppliedStatus < 500
          ? suppliedStatus
          : 500;
        return reply.code(statusCode).send({
          success: false,
          code: known
            ? error.code
            : statusCode === 400
            ? "invalid_request"
            : "data_operation_failed",
          message: known
            ? error.message
            : "The data operation failed validation or could not complete",
        });
      });
      const params = (request: FastifyRequest) => Id.parse((request.params as { id: string }).id);
      const current = (request: FastifyRequest, write = false) => {
        const id = params(request),
          actor = access.authorizeSession(request, id, write);
        const session = server.sessionService.getSession(id);
        if (!session || session.status !== "live")
          throw new DataError("session_not_live", "Resume the browser before this operation", 409);
        return { id, actor, session };
      };
      routes.post(
        "/sessions/:id/page-snapshots",
        { schema: { operationId: "capture_page_snapshot", tags: ["Data"] } },
        async (request) => {
          const { id, actor, session } = current(request);
          const options = Capture.parse(request.body);
          if (options.visual && isSensitiveSession(id))
            throw new DataError(
              "sensitive_session",
              "Saved images are disabled after a vault fill",
              409,
            );
          const record = await diffs.capture(
            await session.cdpService.getPrimaryPage(),
            id,
            actor,
            options,
          );
          await search.index({
            sourceId: record.id,
            owner: actor.id,
            sessionId: id,
            title: record.name || record.url,
            text: record.text,
            kind: "snapshot",
            href: `/?session=${encodeURIComponent(id)}&view=data`,
            expiresAt: record.expiresAt,
          });
          return record;
        },
      );
      routes.get(
        "/page-snapshots",
        { schema: { operationId: "list_page_snapshots", tags: ["Data"] } },
        async (request) => {
          const actor = access.actor(request),
            { sessionId } = request.query as { sessionId?: string };
          if (sessionId) access.authorizeSession(request, Id.parse(sessionId));
          return {
            snapshots: (await records.list<PageSnapshot>("snapshot", actor))
              .filter((item) => !sessionId || item.sessionId === sessionId)
              .map((item) => diffs.metadata(item)),
          };
        },
      );
      routes.get(
        "/page-snapshots/:id",
        { schema: { operationId: "get_page_snapshot", tags: ["Data"] } },
        async (request) => diffs.metadata(await diffs.get(params(request), access.actor(request))),
      );
      routes.get(
        "/page-snapshots/:id/image",
        { schema: { operationId: "get_page_snapshot_image", tags: ["Data"] } },
        async (request, reply) => {
          const record = await diffs.get(params(request), access.actor(request));
          if (!record.image) throw new DataError("image_not_found", "Snapshot has no image", 404);
          return reply
            .type("image/png")
            .header("Cache-Control", "no-store")
            .send(Buffer.from(record.image, "base64"));
        },
      );
      routes.delete(
        "/page-snapshots/:id",
        { schema: { operationId: "delete_page_snapshot", tags: ["Data"] } },
        async (request) => {
          const id = params(request);
          await diffs.remove(id, access.actor(request));
          await search.remove("snapshot", id);
          return { success: true };
        },
      );
      routes.post(
        "/page-diffs",
        { schema: { operationId: "compare_page_snapshots", tags: ["Data"] } },
        async (request) => {
          const { before, after } = z
            .object({ before: Id, after: Id })
            .strict()
            .parse(request.body);
          return diffs.compare(before, after, access.actor(request));
        },
      );
      routes.get(
        "/vault/references",
        { schema: { operationId: "list_vault_references", tags: ["Data"] } },
        async (request) => ({ references: vault.list(access.actor(request)) }),
      );
      routes.post(
        "/sessions/:id/vault/fill",
        { schema: { operationId: "fill_vault_reference", tags: ["Data"] } },
        async (request, reply) => {
          const { id, actor } = current(request, true);
          const token =
            typeof request.headers["x-steel-control"] === "string"
              ? request.headers["x-steel-control"]
              : undefined;
          const abort = new AbortController();
          const closed = () => {
            if (!reply.raw.writableFinished) abort.abort();
          };
          reply.raw.once("close", closed);
          try {
            return await server.dataVaultFill(id, actor, Fill.parse(request.body), {
              signal: abort.signal,
              assertControl: () => access.assertMutation(actor, id, token),
            });
          } finally {
            reply.raw.off("close", closed);
          }
        },
      );
      routes.post(
        "/sessions/:id/artifacts/process",
        { schema: { operationId: "process_session_artifact", tags: ["Data"] } },
        async (request, reply) => {
          const id = params(request),
            actor = access.authorizeSession(request, id);
          const abort = new AbortController();
          const closed = () => {
            if (!reply.raw.writableFinished) abort.abort();
          };
          reply.raw.once("close", closed);
          try {
            const record = await artifacts.process(
              id,
              actor,
              Process.parse(request.body),
              abort.signal,
            );
            await search.index({
              sourceId: record.id,
              owner: actor.id,
              sessionId: id,
              title: record.name,
              text: record.text,
              kind: "artifact",
              href: `/?session=${encodeURIComponent(id)}&view=data`,
              expiresAt: record.expiresAt,
            });
            return record;
          } finally {
            reply.raw.off("close", closed);
          }
        },
      );
      routes.get(
        "/artifacts/:id",
        { schema: { operationId: "get_processed_artifact", tags: ["Data"] } },
        async (request) => artifacts.get(params(request), access.actor(request)),
      );
      routes.get(
        "/artifacts",
        { schema: { operationId: "list_processed_artifacts", tags: ["Data"] } },
        async (request) => {
          const actor = access.actor(request),
            result: unknown[] = [];
          for (const record of await records.list<ProcessedArtifact>("artifact", actor)) {
            try {
              const { text, pages, ...metadata } = await artifacts.get(record.id, actor);
              result.push(metadata);
            } catch {}
          }
          return { artifacts: result };
        },
      );
      routes.get(
        "/workspace/scopes",
        { schema: { operationId: "list_workspace_export_scopes", tags: ["Data"] } },
        async (request) => {
          if (access.actor(request).role !== "operator")
            throw new DataError("operator_required", "Workspace backup requires an operator", 403);
          return { scopes: Object.keys(backup.roots), requiresOriginalStoreKeys: true };
        },
      );
      routes.post(
        "/workspace/export",
        { bodyLimit: 8192, schema: { operationId: "export_workspace", tags: ["Data"] } },
        async (request, reply) => {
          const input = Export.parse(request.body);
          reply.header("Cache-Control", "no-store");
          if (access.actor(request).role !== "operator")
            throw new DataError("operator_required", "Workspace backup requires an operator", 403);
          await server.store.flush();
          const sessions = server.sessionService as unknown as {
            withAdmissionPaused?<T>(action: () => Promise<T>): Promise<T>;
          };
          if (!sessions.withAdmissionPaused)
            throw new DataError(
              "backup_unavailable",
              "Session admission barrier is unavailable",
              503,
            );
          const result = await sessions.withAdmissionPaused(() =>
            backup.export(access.actor(request), input.scopes, input.passphrase),
          );
          await server.audit.log("workspace.exported", {
            client: access.actor(request).id,
            detail: { scopes: input.scopes, files: result.files },
          });
          return result;
        },
      );
      routes.post(
        "/workspace/restore",
        {
          bodyLimit: 150 * 1024 * 1024,
          schema: { operationId: "stage_workspace_recovery", tags: ["Data"] },
        },
        async (request, reply) => {
          reply.header("Cache-Control", "no-store");
          const result = await backup.stage(access.actor(request), Restore.parse(request.body));
          await server.audit.log("workspace.recovery_staged", {
            client: access.actor(request).id,
            subject: result.stageId,
            detail: { scopes: result.scopes },
          });
          return result;
        },
      );
      routes.get(
        "/search",
        { schema: { operationId: "search_session_data", tags: ["Data"] } },
        async (request) =>
          search.search(
            access.actor(request),
            z
              .object({
                q: z.string().max(500),
                sessionId: Id.optional(),
                kind: z
                  .enum(["snapshot", "artifact", "extract", "run", "procedure", "receipt"])
                  .optional(),
                limit: z.coerce.number().int().min(1).max(100).optional(),
                cursor: z.coerce.number().int().min(0).max(10000).optional(),
              })
              .strict()
              .parse(request.query),
          ),
      );
    },
    { prefix: "/v1" },
  );
};

export default fp(plugin, {
  name: "steel-data-workspace",
  dependencies: ["steel-platform", "steel-extras"],
});
