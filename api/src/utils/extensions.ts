import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
export async function getExtensionPaths(extensionNames: string[]): Promise<string[]> {
  const extensionsDir = path.join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "extensions",
  );

  const libraryDir = path.join(
    process.env.STEEL_DATA_DIR || path.join(process.cwd(), "data"),
    "extensions",
  );
  const paths: string[] = [];
  for (const name of new Set(extensionNames)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error("Invalid extension name");
    for (const root of [libraryDir, extensionsDir]) {
      const candidate = path.join(root, name);
      try {
        await fs.promises.access(path.join(candidate, "manifest.json"));
        paths.push(candidate);
        break;
      } catch {
        /* Try the bundled extension after the installed library. */
      }
    }
  }
  return paths;
}
