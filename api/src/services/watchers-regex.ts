import { Worker } from "node:worker_threads";

/** Page text and patterns are untrusted. Backtracking must never block the API event loop. */
export async function boundedRegex(
  pattern: string,
  text: string,
  timeoutMs = 1000,
): Promise<string[] | null> {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    try {
      const match = new RegExp(workerData.pattern).exec(workerData.text);
      parentPort.postMessage({ match: match ? Array.from(match) : null });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
  `,
    {
      eval: true,
      execArgv: [],
      workerData: { pattern, text },
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
    },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string[] | null>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Regular expression exceeded its execution limit")),
        timeoutMs,
      );
      worker.once("message", (result: { match: string[] | null; error?: string }) => {
        if (result.error) reject(new Error(result.error));
        else resolve(result.match);
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error("Regular expression worker failed"));
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
