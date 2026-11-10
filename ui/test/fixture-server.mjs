import http from "node:http";
const html = `<!doctype html><html><head><title>Browser workshop</title><style>body{font:18px system-ui;background:#edf2e9;color:#233b31;padding:40px}button{padding:15px;background:#16866a;color:white;border:0;border-radius:7px}h1{font:48px Georgia}a{display:block;margin:20px 0}</style></head><body><small>STEEL INTEGRATION WORKSHOP</small><h1>A browser that remembers.</h1><p id="account">Signed in for testing</p><p class="price">49</p><button onclick="this.textContent='Saved';localStorage.setItem('test','saved');sessionStorage.setItem('tab','restored');document.cookie='workshop=yes; Path=/'">Save state</button><a href="/download">Download report</a><p>Use this local page to verify parking, downloads, login checks, and recording.</p></body></html>`;
const port = Number(process.env.UI_TEST_FIXTURE_PORT || 3347);
http
  .createServer(async (req, res) => {
    if (req.url === "/download") {
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="report.csv"',
      });
      res.end("name,price\nWorkshop,49\n");
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ title: "Browser workshop" }) } }],
          model: "integration-fixture",
          usage: { total_tokens: 8 },
        }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  })
  .listen(port, process.env.UI_TEST_FIXTURE_HOST || "127.0.0.1", () =>
    console.log(`Fixture page and deterministic LLM responder on ${port}`),
  );
