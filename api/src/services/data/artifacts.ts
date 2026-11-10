import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileTypeFromBuffer } from "file-type";
import { DataError, DataRecords, sanitized, type DataActor, type DataRecord } from "./common.js";

export interface ProcessedArtifact extends DataRecord {
  name: string;
  sourcePath: string;
  sha256: string;
  bytes: number;
  mime: string;
  sourceModifiedAt: number;
  text: string;
  pages: { page: number; text: string; tables: unknown[] }[];
  ocr: "not_requested" | "completed";
  destination?: string;
}
export class ArtifactService {
  private active = 0;
  constructor(
    private records: DataRecords,
    private filesRoot: (id: string) => string,
    private destinations: Record<string, string> = JSON.parse(
      process.env.STEEL_ARTIFACT_DESTINATIONS || "{}",
    ),
  ) {}
  async process(
    sessionId: string,
    actor: DataActor,
    input: { path: string; ocr?: boolean; destination?: string },
    signal?: AbortSignal,
  ) {
    if (this.active >= 2)
      throw new DataError(
        "processing_busy",
        "Two documents are already processing; retry later",
        429,
      );
    if (input.destination && !this.destinations[input.destination])
      throw new DataError("destination_denied", "Destination is not configured", 403);
    this.active++;
    try {
      const root = await realpath(this.filesRoot(sessionId));
      const filename = path.resolve(root, input.path);
      if (!input.path || path.isAbsolute(input.path) || !filename.startsWith(root + path.sep))
        throw new DataError("invalid_path", "Use a path inside this session's files");
      const resolved = await realpath(filename);
      if (!resolved.startsWith(root + path.sep))
        throw new DataError("invalid_path", "File leaves the session directory");
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: Buffer;
      let sourceModifiedAt: number;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 25 * 1024 * 1024)
          throw new DataError(
            "invalid_artifact",
            "Only regular files up to 25 MiB can be processed",
          );
        sourceModifiedAt = info.mtimeMs;
        data = await handle.readFile();
        if (data.length > 25 * 1024 * 1024)
          throw new DataError("invalid_artifact", "File grew beyond the size limit");
      } finally {
        await handle.close();
      }
      const type = await fileTypeFromBuffer(data);
      const mime =
        type?.mime ||
        (/\.(txt|csv|json|md)$/i.test(input.path) && !data.includes(0)
          ? "text/plain"
          : "application/octet-stream");
      if (
        !["application/pdf", "image/png", "image/jpeg", "image/tiff", "text/plain"].includes(mime)
      )
        throw new DataError(
          "unsupported_artifact",
          "Supported types are PDF, PNG, JPEG, TIFF and text/CSV/JSON/Markdown",
          415,
        );
      if (signal?.aborted) throw new DataError("cancelled", "Artifact processing cancelled", 409);
      const result =
        mime === "text/plain"
          ? {
              text: data.toString("utf8").slice(0, 1_000_000),
              pages: [],
              ocr: "not_requested" as const,
            }
          : await processDocument(data, mime, !!input.ocr, signal);
      const safe = sanitized(result) as typeof result;
      const sha256 = createHash("sha256").update(data).digest("hex");
      const name =
        path
          .basename(input.path)
          .replace(/[^\p{L}\p{N}._-]/gu, "_")
          .slice(0, 120) || "artifact";
      let destination: string | undefined;
      if (input.destination) {
        const directory = path.resolve(this.destinations[input.destination]);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const target = path.join(await realpath(directory), `${sha256.slice(0, 12)}-${name}.json`);
        const temp = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ ...safe, sha256, source: name }), {
            mode: 0o600,
            flag: "wx",
          });
          await rename(temp, target);
        } finally {
          await rm(temp, { force: true });
        }
        destination = input.destination;
      }
      return await this.records.create(
        "artifact",
        actor.id,
        {
          name,
          sourcePath: input.path,
          sha256,
          bytes: data.length,
          sourceModifiedAt,
          mime,
          ...safe,
          destination,
        },
        sessionId,
      );
    } finally {
      this.active--;
    }
  }
  async get(id: string, actor: DataActor) {
    const artifact = await this.records.get<ProcessedArtifact>("artifact", id, actor);
    // Deleted source files cease to be searchable/readable even if retained metadata still exists.
    const root = path.resolve(this.filesRoot(artifact.sessionId!));
    const source = path.resolve(root, artifact.sourcePath);
    const details = await stat(source).catch(() => null);
    if (!source.startsWith(root + path.sep) || !details?.isFile())
      throw new DataError("source_deleted", "Artifact source has been deleted", 404);
    if (details.size !== artifact.bytes || details.mtimeMs !== artifact.sourceModifiedAt)
      throw new DataError(
        "source_changed",
        "Artifact source changed; process it again before using its evidence",
        409,
      );
    return artifact;
  }
  async verify(id: string, actor: DataActor, expectedSha256: string) {
    const artifact = await this.get(id, actor);
    if (artifact.sha256 !== expectedSha256)
      throw new DataError("artifact_changed", "Reviewed artifact hash does not match", 409);
    const root = await realpath(this.filesRoot(artifact.sessionId!));
    const source = await realpath(path.resolve(root, artifact.sourcePath));
    if (!source.startsWith(root + path.sep))
      throw new DataError("invalid_path", "Artifact leaves its session directory");
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size !== artifact.bytes || details.size > 25 * 1024 * 1024)
        throw new DataError("artifact_changed", "Reviewed artifact changed", 409);
      const bytes = await handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
        throw new DataError("artifact_changed", "Reviewed artifact changed", 409);
      return {
        id: artifact.id,
        sha256: artifact.sha256,
        sessionId: artifact.sessionId,
        path: artifact.sourcePath,
        bytes: artifact.bytes,
      };
    } finally {
      await handle.close();
    }
  }
}

async function processDocument(
  data: Buffer,
  mime: string,
  ocr: boolean,
  signal?: AbortSignal,
): Promise<{
  text: string;
  pages: { page: number; text: string; tables: unknown[] }[];
  ocr: "not_requested" | "completed";
}> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "steel-document-"));
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(
        `import('mupdf').then(mupdf => (${documentWorker.toString()})(mupdf)).catch(() => require('node:worker_threads').parentPort.postMessage({error:'document_failed'}))`,
        {
          eval: true,
          workerData: { data, mime, ocr, temporary },
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
        },
      );
      let childPid: number | undefined;
      let finished = false;
      const finish = (error?: Error, value?: any) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (childPid) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {}
        }
        void worker.terminate().finally(() => (error ? reject(error) : resolve(value)));
      };
      const abort = () => finish(new DataError("cancelled", "Artifact processing cancelled", 409));
      const timer = setTimeout(
        () =>
          finish(
            new DataError("processing_timeout", "Document processing exceeded 60 seconds", 408),
          ),
        60_000,
      );
      worker.on("message", (value) => {
        if ("childPid" in value) {
          childPid = value.childPid || undefined;
          return;
        }
        value.error
          ? finish(
              new DataError(
                value.error,
                value.error === "ocr_unavailable"
                  ? "Tesseract OCR is not installed"
                  : "Document processing failed or exceeded configured limits",
                422,
              ),
            )
          : finish(undefined, value);
      });
      worker.once("error", () =>
        finish(new DataError("document_failed", "Document worker failed", 422)),
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Isolated worker: untrusted document decoding cannot block the API event loop. */
async function documentWorker(mupdf: typeof import("mupdf")) {
  const { workerData, parentPort } =
    require("node:worker_threads") as typeof import("node:worker_threads");
  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  const { promisify } = require("node:util") as typeof import("node:util");
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const run = promisify(execFile);
  const { data, mime, ocr, temporary } = workerData;
  const pages: { page: number; text: string; tables: unknown[] }[] = [];
  try {
    if (ocr) {
      try {
        await run("tesseract", ["--version"], { timeout: 3000, maxBuffer: 4096 });
      } catch {
        parentPort!.postMessage({ error: "ocr_unavailable" });
        return;
      }
    }
    const recognize = async (png: Uint8Array, index: number) => {
      const filename = path.join(temporary, `${index}.png`);
      await fs.writeFile(filename, png, { mode: 0o600 });
      const operation = run("tesseract", [filename, "stdout", "-l", "eng", "--psm", "3"], {
        timeout: 15_000,
        maxBuffer: 1_000_000,
      });
      parentPort!.postMessage({ childPid: operation.child.pid });
      try {
        return (await operation).stdout;
      } finally {
        parentPort!.postMessage({ childPid: null });
      }
    };
    if (mime === "application/pdf") {
      const document = mupdf.Document.openDocument(new Uint8Array(data), mime);
      try {
        if (document.needsPassword() || document.countPages() > 50)
          throw new Error("Document limit");
        for (let i = 0; i < document.countPages(); i++) {
          const page = document.loadPage(i);
          try {
            const structured = page.toStructuredText("preserve-whitespace");
            let text: string;
            const lines: { y: number; x: number; text: string }[] = [];
            try {
              text = structured.asText();
              let current: { y: number; x: number; text: string };
              structured.walk({
                beginLine: (box) => {
                  current = { x: box[0], y: box[1], text: "" };
                },
                onChar: (character) => {
                  if (current) current.text += character;
                },
                endLine: () => {
                  if (current?.text.trim()) lines.push(current);
                },
              });
            } finally {
              structured.destroy();
            }
            if (ocr && !text.trim()) {
              const bounds = page.getBounds();
              const scale = Math.min(
                2,
                Math.sqrt(8_000_000 / ((bounds[2] - bounds[0]) * (bounds[3] - bounds[1]))),
              );
              const pixels = page.toPixmap(
                mupdf.Matrix.scale(scale, scale),
                mupdf.ColorSpace.DeviceRGB,
                false,
              );
              try {
                text = await recognize(pixels.asPNG(), i);
              } finally {
                pixels.destroy();
              }
            }
            // A geometric table candidate is explicit, not a claim of semantic table certainty.
            const rows: { y: number; cells: { x: number; text: string }[] }[] = [];
            for (const line of lines.sort((a, b) => a.y - b.y || a.x - b.x)) {
              let row = rows.find((item) => Math.abs(item.y - line.y) < 3);
              if (!row) {
                row = { y: line.y, cells: [] };
                rows.push(row);
              }
              row.cells.push({ x: line.x, text: line.text.trim() });
            }
            const tableRows = rows
              .filter((row) => row.cells.length >= 2)
              .map((row) => row.cells.sort((a, b) => a.x - b.x).map((cell) => cell.text));
            pages.push({
              page: i + 1,
              text: text.slice(0, 100_000),
              tables:
                tableRows.length >= 2
                  ? [{ method: "geometry-candidate", confidence: "unverified", rows: tableRows }]
                  : [],
            });
            if (pages.reduce((size, item) => size + item.text.length, 0) > 1_000_000)
              throw new Error("Text limit");
          } finally {
            page.destroy();
          }
        }
      } finally {
        document.destroy();
      }
    } else {
      if (!ocr) throw new Error("Image requires OCR");
      const image = new mupdf.Image(new Uint8Array(data));
      try {
        if (image.getWidth() * image.getHeight() > 8_000_000) throw new Error("Image pixel limit");
        const pixels = image.toPixmap();
        try {
          pages.push({ page: 1, text: await recognize(pixels.asPNG(), 0), tables: [] });
        } finally {
          pixels.destroy();
        }
      } finally {
        image.destroy();
      }
    }
    parentPort!.postMessage({
      pages,
      text: pages.map((page) => page.text).join("\n\n"),
      ocr: ocr ? "completed" : "not_requested",
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
