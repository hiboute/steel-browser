#!/usr/bin/env node
/** Pair and install this already-staged worker in the current user's GUI session.
 * Input is one JSON object on stdin: {coordinator, pairingToken?}. No credentials
 * enter launchd's environment or command arguments. This never edits Safari's
 * automation permission or opens a personal Chrome profile.
 */
import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromEnvironment } from "./worker.mjs";

assert.equal(process.platform, "darwin", "The desktop installer requires macOS");
assert(process.getuid() > 0, "Install as the dedicated desktop user, not root");
let input = "";
for await (const chunk of process.stdin) { input += chunk; assert(input.length <= 16384, "Oversized pairing input"); }
const config = JSON.parse(input);
assert(config && typeof config.coordinator === "string", "Coordinator is required");
const stateRoot = path.join(os.homedir(), ".local/state/steel-worker");
const credentialPath = path.join(stateRoot, "credentials.json");
const coordinatorFile = path.join(stateRoot, "coordinator.json");
try { assert.equal(JSON.parse(await readFile(coordinatorFile, "utf8")).origin, new URL(config.coordinator).origin, "Existing worker belongs to another coordinator"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const workerPath = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(chrome);
Object.assign(process.env, {
  STEEL_WORKER_COORDINATOR: config.coordinator,
  STEEL_WORKER_STATE_DIR: stateRoot,
  STEEL_WORKER_ENGINES: "chromium",
  STEEL_WORKER_CHROME_PATH: chrome,
  STEEL_WORKER_HEADLESS: "false",
  STEEL_WORKER_CAPACITY: "1",
});
delete process.env.STEEL_WORKER_PRIVATE_HTTP;
delete process.env.STEEL_WORKER_PROXY_URL;
delete process.env.STEEL_WORKER_STRICT;
if (config.pairingToken) process.env.STEEL_WORKER_PAIRING_TOKEN = config.pairingToken;
const worker = await fromEnvironment();
await worker.initialize();
delete process.env.STEEL_WORKER_PAIRING_TOKEN;
await chmod(stateRoot, 0o700); await chmod(credentialPath, 0o600);
await writeFile(coordinatorFile, JSON.stringify({ origin: worker.options.coordinator }) + "\n", { mode: 0o600 });
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const label = "fr.robiche.steel-worker";
const logs = path.join(stateRoot, "logs"); await mkdir(logs, { recursive: true, mode: 0o700 });
const agents = path.join(os.homedir(), "Library/LaunchAgents"); await mkdir(agents, { recursive: true });
const plist = path.join(agents, label + ".plist");
const environment = Object.fromEntries(["STEEL_WORKER_COORDINATOR", "STEEL_WORKER_STATE_DIR", "STEEL_WORKER_ENGINES", "STEEL_WORKER_CHROME_PATH", "STEEL_WORKER_HEADLESS", "STEEL_WORKER_CAPACITY"].map(key => [key, process.env[key]]));
await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(workerPath)}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k, v]) => `<key>${escape(k)}</key><string>${escape(v)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>StandardOutPath</key><string>${escape(path.join(logs, "worker.out.log"))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(logs, "worker.err.log"))}</string>
</dict></plist>\n`, { mode: 0o600 });
const domain = `gui/${process.getuid()}`;
if (spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0) assert.equal(spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" }).status, 0, "Cannot stop previous dedicated worker");
assert.equal(spawnSync("launchctl", ["bootstrap", domain, plist], { stdio: "ignore" }).status, 0, "Cannot start worker in the logged-in desktop session");
console.log(JSON.stringify({ installed: true, label, workerId: worker.credentials.workerId, engine: "chromium", profileScope: worker.credentials.profileScope, coordinator: worker.options.coordinator }));
