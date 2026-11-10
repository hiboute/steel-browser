import fastifyMultipart from "@fastify/multipart";
import { FastifyInstance, FastifyRequest } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { MB } from "../../utils/size.js";
import path from "node:path";
import { FilesController } from "./files.controller.js";

async function routes(server: FastifyInstance) {
  const filesController = new FilesController(server.fileService);

  server.addHook("preHandler", async (request, reply) => {
    const id =
      (request.params as { sessionId?: string })?.sessionId ??
      (request.query as { sessionId?: string })?.sessionId;
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
      return reply.code(400).send({
        success: false,
        code: "invalid_session",
        message: "A valid session id is required",
      });
    }
    if (
      !server.sessionService.findSocketSession(id) &&
      !server.sessionService.isParked(id) &&
      !(await server.fileService.hasSession(id))
    ) {
      return reply
        .code(404)
        .send({ success: false, code: "session_not_found", message: "Session files not found" });
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      server.sessionService.touch(id, "files");
  });

  server.get<{ Querystring: { sessionId: string } }>(
    "/files",
    {
      schema: {
        operationId: "list_session_files",
        tags: ["Files"],
        summary: "List retained files for a session",
        querystring: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" },
          },
        },
        response: { 200: $ref("MultipleFiles") },
      },
    },
    async (request) => {
      const files = server.fileService.forSession(request.query.sessionId);
      return {
        data: (await files.listFiles()).map((file) => ({
          ...file,
          path: path.relative(files.getBaseFilesPath(), file.path),
        })),
      };
    },
  );

  await server.register(fastifyMultipart, {
    limits: {
      fileSize: server.steelBrowserConfig.fileStorage?.maxSizePerSession ?? 100 * MB,
    },
    attachFieldsToBody: false,
  });

  server.post(
    "/sessions/:sessionId/files",
    {
      schema: {
        operationId: "upload_file",
        summary: "Upload a file",
        description:
          "Uploads a file to a session via `multipart/form-data` with a `file` field that accepts either binary data or a URL string to download from, and an optional `path` field for the file storage path.",
        tags: ["Files"],
        consumes: ["multipart/form-data"],
        body: $ref("FileUploadRequest"),
        response: {
          200: $ref("FileDetails"),
        },
      },
      validatorCompiler: () => (value) => ({ value }),
    },
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
      }>,
      reply,
    ) => filesController.handleFileUpload(server, request, reply),
  );

  server.head(
    "/sessions/:sessionId/files/*",
    {
      schema: {
        operationId: "head_file",
        summary: "Head a file",
        description: "Head a file from a session",
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string; "*": string } }>, reply) =>
      filesController.handleFileHead(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/files/*",
    {
      schema: {
        operationId: "download_file",
        summary: "Download a file",
        description: "Download a file from a session",
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string; "*": string } }>, reply) =>
      filesController.handleFileDownload(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/files",
    {
      schema: {
        operationId: "list_files",
        summary: "List files",
        description: "List all files from the session in descending order.",
        tags: ["Files"],
        response: {
          200: $ref("MultipleFiles"),
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
      }>,
      reply,
    ) => filesController.handleFileList(server, request, reply),
  );

  server.delete(
    "/sessions/:sessionId/files/*",
    {
      schema: {
        operationId: "delete_file",
        summary: "Delete a file",
        description: "Delete a file from a session",
        tags: ["Files"],
        response: {
          204: {
            type: "null",
            description: "No content",
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string; "*": string } }>, reply) =>
      filesController.handleFileDelete(server, request, reply),
  );

  server.delete(
    "/sessions/:sessionId/files",
    {
      schema: {
        operationId: "delete_all_files",
        summary: "Delete all files",
        description: "Delete all files from a session",
        tags: ["Files"],
        response: {
          204: {
            type: "null",
            description: "No content",
          },
        },
      },
    },

    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) =>
      filesController.handleFileDeleteAll(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/files.zip",
    {
      schema: {
        operationId: "download_archive",
        summary: "Download archive",
        description: "Download all files from the session as a zip archive.",
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) =>
      filesController.handleDownloadArchive(server, request, reply),
  );
}

export default routes;
