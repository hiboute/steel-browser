/** Offline recovery entry point. Stop the API and all workers sharing these volumes first. */
import path from "node:path";
import { WorkspaceBackup } from "./workspace-backup.js";

export function workspaceRoots() {
  const data = path.resolve(process.env.STEEL_DATA_DIR || "data");
  return {
    profiles: path.resolve(process.env.BROWSER_PROFILES_DIR || "browser-profiles"),
    logins: path.resolve(process.env.COOKIE_LIBRARY_DIR || "cookie-library"),
    workflows: path.join(data, "workflows"),
    watchers: path.join(data, "watchers"),
    warm: path.join(data, "warm.json"),
    identities: path.join(data, "identity"),
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === path.resolve(process.argv[1])) {
  const [command, stageId, offline] = process.argv.slice(2);
  if (!["activate", "rollback"].includes(command) || !stageId || offline !== "--service-stopped") {
    process.stderr.write(
      "Usage: node build/services/data/workspace-recovery.js activate|rollback STAGE_ID --service-stopped\nStop the API and workers before activation. Original store encryption keys must be available after restart.\n",
    );
    process.exitCode = 2;
  } else {
    const backup = new WorkspaceBackup(
      workspaceRoots(),
      path.resolve(process.env.STEEL_DATA_DIR || "data", "recovery"),
    );
    (command === "activate" ? backup.activate(stageId) : backup.rollback(stageId))
      .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
      .catch((error) => {
        process.stderr.write(`Recovery failed: ${error.code || "restore_error"}\n`);
        process.exitCode = 1;
      });
  }
}
