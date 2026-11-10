import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const ajvPath = createRequire(import.meta.url).resolve("ajv");

/** JSON Schema may contain user-supplied regexes; validate model data off the API event loop. */
export async function validateExtractedData(
  schema: Record<string, unknown>,
  data: unknown,
  timeoutMs = 1000,
): Promise<{ valid: boolean; error: string }> {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    try {
      const { default: Ajv } = require(workerData.ajvPath);
      const ajv = new Ajv({allErrors:true,strict:false});
      const validate = ajv.compile(workerData.schema);
      const valid = validate(workerData.data);
      parentPort.postMessage({valid,error:valid?'':ajv.errorsText(validate.errors)});
    } catch(error) { parentPort.postMessage({valid:false,error:error.message}); }
  `,
    {
      eval: true,
      execArgv: [],
      workerData: { ajvPath, schema, data },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("JSON schema validation exceeded its execution limit")),
        timeoutMs,
      );
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error("JSON schema validation worker failed"));
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
