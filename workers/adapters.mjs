import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const commands = ["launch", "goto", "click", "fill", "press", "snapshot", "screenshot", "evaluate", "cookies", "checkpoint", "close"];
const safeUrl = value => { const u = new URL(value); if (!["http:", "https:", "about:"].includes(u.protocol) || (u.protocol === "about:" && u.href !== "about:blank") || u.username || u.password) throw new Error("unsupported_navigation_url"); return u.href; };
const text = (v, limit = 50_000) => { if (typeof v !== "string" || v.length > limit) throw new Error("invalid_command_argument"); return v; };
export function validatePayload(kind, p = {}) {
  if (kind === "goto") safeUrl(text(p.url, 8192));
  if (["click", "fill", "press"].includes(kind)) text(p.selector, 2000);
  if (kind === "fill") text(p.value, 100_000);
  if (kind === "press") text(p.key, 100);
  if (kind === "evaluate") text(p.expression, 50_000);
  return p;
}

export class PlaywrightAdapter {
  constructor(engine, options = {}) { this.engine = engine; this.options = options; }
  async launch(sessionId, p) {
    const playwright = this.options.playwright ?? await import("playwright");
    let strictProxyIp;
    if (this.options.strict && this.engine === "chromium") {
      try { strictProxyIp = new URL(this.options.proxy?.server).hostname; } catch { throw new Error("invalid_strict_proxy"); }
      if (isIP(strictProxyIp) !== 4) throw new Error("invalid_strict_proxy");
    }
    if (this.engine === "android") {
      if (!this.options.androidSerial) throw new Error("android_serial_required");
      const devices = await playwright._android.devices(); this.device = devices.find(d => d.serial() === this.options.androidSerial);
      if (!this.device) throw new Error("android_device_unavailable");
      this.context = await this.device.launchBrowser({ proxy: this.options.proxy });
    } else {
      const profile = path.join(this.options.profileRoot, sessionId);
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const browser = playwright[this.engine]; if (!browser) throw new Error("unsupported_engine");
      this.context = await browser.launchPersistentContext(profile, { headless: p.headless ?? this.options.headless ?? true, ...(this.options.channel && this.engine === "chromium" ? { channel: this.options.channel } : {}), ...(this.options.executablePath && this.engine === "chromium" ? { executablePath: this.options.executablePath } : {}), proxy: this.options.proxy, viewport: this.options.viewport ?? { width: 1280, height: 900 }, ...(this.options.strict && this.engine === "chromium" ? { args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${strictProxyIp}`, "--proxy-bypass-list=<-loopback>"] } : {}) });
    }
    this.context.setDefaultTimeout(15_000); this.context.setDefaultNavigationTimeout(30_000);
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    if (p.checkpoint) await this.restore(p.checkpoint);
    return { engine: this.engine, browserVersion: this.context.browser()?.version() ?? "persistent-context", profileKind: this.engine === "android" ? "dedicated_android_automation" : "dedicated_persistent_profile", nativeDesktop: !p.headless && this.engine !== "android" };
  }
  async restore(checkpoint) {
    if (checkpoint.storageState?.cookies) await this.context.addCookies(checkpoint.storageState.cookies);
    const origins = checkpoint.storageState?.origins ?? [];
    for (const origin of origins) {
      const page = await this.context.newPage(); await page.goto(safeUrl(origin.origin));
      await page.evaluate(items => { for (const item of items) localStorage.setItem(item.name, item.value); }, origin.localStorage ?? []); await page.close();
    }
    for (let i = 0; i < checkpoint.tabs.length; i++) {
      const tab = checkpoint.tabs[i]; const page = i === 0 ? this.page : await this.context.newPage();
      await page.goto(safeUrl(tab.url));
      if (tab.sessionStorage) { await page.evaluate(items => { for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, value); }, tab.sessionStorage); await page.reload(); }
    }
  }
  async execute(kind, payload) {
    const p = validatePayload(kind, payload); if (!this.context) throw new Error("browser_not_launched");
    if (kind === "goto") { const response = await this.page.goto(safeUrl(p.url)); return { url: this.page.url(), title: await this.page.title(), status: response?.status() ?? null }; }
    if (kind === "click") { await this.page.locator(p.selector).click(); return { applied: true }; }
    if (kind === "fill") { await this.page.locator(p.selector).fill(p.value); return { applied: true }; }
    if (kind === "press") { await this.page.locator(p.selector).press(p.key); return { applied: true }; }
    if (kind === "snapshot") return { url: this.page.url(), title: await this.page.title(), text: (await this.page.locator("body").innerText()).slice(0, 100_000) };
    if (kind === "screenshot") return { mimeType: "image/png", data: (await this.page.screenshot({ fullPage: false })).toString("base64") };
    if (kind === "evaluate") return await this.page.evaluate(p.expression);
    if (kind === "cookies") return { cookies: await this.context.cookies() };
    if (kind === "checkpoint") return { storageState: await this.context.storageState(), tabs: await Promise.all(this.context.pages().map(async page => ({ url: safeUrl(page.url()), sessionStorage: await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))).catch(() => ({})) }))) };
    if (kind === "close") { await this.close(); return { closed: true }; }
    throw new Error("unsupported_capability");
  }
  async close() { await this.context?.close(); await this.device?.close(); this.context = undefined; }
}

/** Safari uses its real macOS WebDriver, not Playwright's WebKit build. Its automation windows are isolated by Safari. */
export class SafariAdapter {
  constructor(options = {}) { this.options = options; this.base = options.webdriverUrl ?? "http://127.0.0.1:9617"; }
  async call(method, route, body) {
    const response = await fetch(this.base + route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
    const data = await response.json(); if (!response.ok || data.value?.error) throw new Error(`safari_${data.value?.error ?? "webdriver_error"}`); return data.value;
  }
  async launch(_id, p) {
    if (process.platform !== "darwin" && !this.options.allowTestHost) throw new Error("safari_requires_macos");
    if (p.headless) throw new Error("safari_headless_unsupported");
    if (p.egressPolicy === "strict") throw new Error("safari_strict_egress_unsupported");
    if (!this.options.webdriverUrl) {
      this.child = spawn("/usr/bin/safaridriver", ["--port", "9617"], { stdio: "ignore" });
      for (let attempt = 0; attempt < 30; attempt++) { try { await this.call("GET", "/status"); break; } catch { await delay(100); } }
    }
    const result = await this.call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari", "safari:automaticInspection": false, "safari:automaticProfiling": false } } });
    this.id = result.sessionId;
    if (p.checkpoint) await this.restore(p.checkpoint);
    return { engine: "safari", browserVersion: result.capabilities?.browserVersion, profileKind: "safari_isolated_automation", nativeDesktop: true };
  }
  async script(expression, args = []) { return this.call("POST", `/session/${this.id}/execute/sync`, { script: expression, args }); }
  async element(selector) { const result = await this.call("POST", `/session/${this.id}/element`, { using: "css selector", value: selector }); return result["element-6066-11e4-a52e-4f735466cecf"]; }
  async restore(checkpoint) {
    // WebDriver cookies require visiting their origin. Restore only checkpoint origins, never arbitrary file URLs.
    for (const origin of checkpoint.storageState?.origins ?? []) {
      await this.call("POST", `/session/${this.id}/url`, { url: safeUrl(origin.origin) });
      await this.script("for (const item of arguments[0]) localStorage.setItem(item.name,item.value);", [origin.localStorage ?? []]);
      for (const cookie of checkpoint.storageState?.cookies ?? []) if (new URL(origin.origin).hostname.endsWith(cookie.domain.replace(/^\./, ""))) await this.call("POST", `/session/${this.id}/cookie`, { cookie });
    }
    if (checkpoint.tabs?.[0]) { await this.call("POST", `/session/${this.id}/url`, { url: safeUrl(checkpoint.tabs[0].url) }); await this.script("for (const [k,v] of Object.entries(arguments[0])) sessionStorage.setItem(k,v);", [checkpoint.tabs[0].sessionStorage ?? {}]); await this.call("POST", `/session/${this.id}/refresh`, {}); }
  }
  async execute(kind, payload) {
    const p = validatePayload(kind, payload); const route = `/session/${this.id}`;
    if (kind === "goto") { await this.call("POST", route + "/url", { url: safeUrl(p.url) }); return { url: await this.call("GET", route + "/url"), title: await this.call("GET", route + "/title") }; }
    if (kind === "click") { await this.call("POST", `${route}/element/${await this.element(p.selector)}/click`, {}); return { applied: true }; }
    if (kind === "fill") { const id = await this.element(p.selector); await this.call("POST", `${route}/element/${id}/clear`, {}); await this.call("POST", `${route}/element/${id}/value`, { text: p.value }); return { applied: true }; }
    if (kind === "press") { const keys = { Enter: "\uE007", Tab: "\uE004", Escape: "\uE00C", Backspace: "\uE003" }; if (!(p.key in keys) && p.key.length !== 1) throw new Error("unsupported_key"); await this.call("POST", `${route}/element/${await this.element(p.selector)}/value`, { text: keys[p.key] ?? p.key }); return { applied: true }; }
    if (kind === "snapshot") return this.script("return {url:location.href,title:document.title,text:(document.body?.innerText??'').slice(0,100000)}");
    if (kind === "screenshot") return { mimeType: "image/png", data: await this.call("GET", route + "/screenshot") };
    if (kind === "evaluate") return this.script(`return (${p.expression});`);
    if (kind === "cookies") return { cookies: await this.call("GET", route + "/cookie") };
    if (kind === "checkpoint") { const state = await this.script("return {url:location.href,origin:location.origin,localStorage:Object.entries(localStorage).map(([name,value])=>({name,value})),sessionStorage:Object.fromEntries(Object.entries(sessionStorage))}"); return { storageState: { cookies: await this.call("GET", route + "/cookie"), origins: [{ origin: state.origin, localStorage: state.localStorage }] }, tabs: [{ url: state.url, sessionStorage: state.sessionStorage }] }; }
    if (kind === "close") { await this.close(); return { closed: true }; }
    throw new Error("unsupported_capability");
  }
  async close() { if (this.id) await this.call("DELETE", `/session/${this.id}`).catch(() => {}); this.id = undefined; this.child?.kill("SIGTERM"); }
}

export const createAdapter = (engine, options) => engine === "safari" ? new SafariAdapter(options) : new PlaywrightAdapter(engine, options);
