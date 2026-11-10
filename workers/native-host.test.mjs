/** Explicit native-host acceptance only; never opens a personal browser profile. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAdapter } from "./adapters.mjs";
for (const engine of (process.env.STEEL_TEST_NATIVE_ENGINES ?? "").split(",").filter(Boolean)) test(`${engine} real desktop fixture in dedicated automation profile`, { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "steel-native-fixture-"));
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end('<title>Steel native fixture</title><input id="name"><button>Verify</button><p id="result"></p><script>document.querySelector("button").onclick=()=>document.querySelector("#result").textContent=document.querySelector("#name").value</script>'); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const adapter = createAdapter(engine, { profileRoot: root, executablePath: engine === "chromium" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined });
  try {
    const runtime = await adapter.launch(randomUUID(), { headless: false });
    await adapter.execute("goto", { url: `http://127.0.0.1:${server.address().port}/` });
    await adapter.execute("fill", { selector: "#name", value: "Native verified" }); await adapter.execute("click", { selector: "button" });
    assert.match((await adapter.execute("snapshot", {})).text, /Native verified/);
    const screenshot = await adapter.execute("screenshot", {}); assert.equal(Buffer.from(screenshot.data, "base64").subarray(1, 4).toString(), "PNG");
    const identity = await adapter.execute("evaluate", { expression: "({platform:navigator.platform,userAgent:navigator.userAgent,screen:{width:screen.width,height:screen.height},renderer:(()=>{const gl=document.createElement('canvas').getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null})()})" });
    console.log(JSON.stringify({ runtime, identity }));
  } finally { await adapter.close(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
