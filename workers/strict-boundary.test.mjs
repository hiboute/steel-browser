import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { PlaywrightAdapter } from "./adapters.mjs";
import http from "node:http";
import dgram from "node:dgram";
const ip = process.env.STEEL_STRICT_PROXY_IP;
assert.equal(process.getuid(),1000);
assert.match(await readFile("/proc/self/status","utf8"),/CapEff:\s+0000000000000000/);
assert.notEqual(spawnSync("iptables",["-L"]).status,0);
await assert.rejects(fetch(`http://${ip}:8081/`,{signal:AbortSignal.timeout(1500)}));
const v6 = http.createServer((_req,res)=>res.end("must not connect"));await new Promise(resolve=>v6.listen(8081,"::1",resolve));
await assert.rejects(fetch("http://[::1]:8081/",{signal:AbortSignal.timeout(1500)}),error=>error.name==="TimeoutError");await new Promise(resolve=>v6.close(resolve));
const dns = dgram.createSocket("udp4");await new Promise((resolve,reject)=>dns.send(Buffer.from("owned DNS blocked probe"),5353,ip,error=>error?reject(error):resolve())).catch(error=>assert(["EPERM","EACCES"].includes(error.code)));dns.close();
console.log("allowed endpoints",await fetch(`http://${ip}:3000/`).then(r=>r.json()),await fetch(`http://${ip}:8080/`).then(r=>r.status));
const profileRoot = await mkdtemp("/tmp/steel-strict-adapter-");
const adapter = new PlaywrightAdapter("chromium", { profileRoot, strict: true, proxy: { server: `http://${ip}:8080`, bypass: "<-loopback>" } });
try {
  await adapter.launch("owned-boundary-test", { headless: true });
  const page=adapter.page;await page.goto("http://owned-fixture.invalid/");assert.equal(await page.title(),"Owned proxy fixture");
  await page.goto(`http://${ip}:8081/`);assert.equal(await page.title(),"Owned proxy fixture");
  let metrics=await fetch(`http://${ip}:3000/`).then(r=>r.json());assert.equal(metrics.directHits,0);assert.equal(metrics.dnsHits,0);assert(metrics.proxyHits>0);
  await fetch(`http://${ip}:3000/stop-proxy`);await assert.rejects(page.goto(`http://${ip}:8081/after-outage`,{timeout:5000}));
  metrics=await fetch(`http://${ip}:3000/`).then(r=>r.json());assert.equal(metrics.directHits,0);
  console.log(JSON.stringify({passed:true,checks:["non-root capabilities dropped","direct TCP blocked","DNS UDP blocked","IPv6 blocked with listening target","shipped Chromium adapter resolves only the required literal proxy", "browser target hostname resolves through the proxy","upstream outage fails closed","zero direct target requests"]}));
} finally {await adapter.close();await rm(profileRoot,{recursive:true,force:true});}
