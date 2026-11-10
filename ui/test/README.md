# Browser integration smoke

This test drives the real UI and API with Chromium. It covers session creation,
human handoff, saved logins and health checks, recordings, downloads,
park/resume identity, watchers, warm browsers, extraction, and mobile navigation.
The local fixture provides a page and a deterministic OpenAI-compatible reply;
it does not verify a remote LLM provider.

Run against an isolated development API with at least three browser slots and
fresh data directories. Install repository dependencies and Chromium first.
The smoke uses uniquely named resources and removes its own resources on exit.
It leaves released session history in the isolated API's data directory.

From the repository root, start each command in a separate terminal:

```sh
npm run test:fixture -w ui

NODE_ENV=development PORT=3307 HOST=127.0.0.1 \
CDP_PORT_BASE=9802 CDP_REDIRECT_PORT=9803 CDP_RESERVED_PORTS=9803 \
MAX_SESSIONS=3 CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
CHROME_HEADLESS=true DISABLE_CHROME_SANDBOX=true \
CHROME_USER_DATA_DIR=/tmp/steel-ui-smoke-api/primary \
STEEL_DATA_DIR=/tmp/steel-ui-smoke-api/data \
COOKIE_LIBRARY_DIR=/tmp/steel-ui-smoke-api/cookies \
BROWSER_PROFILES_DIR=/tmp/steel-ui-smoke-api/profiles \
DEFAULT_TIMEZONE=UTC SESSION_IDLE_TIMEOUT_MS=0 LOG_STORAGE_ENABLED=false \
EXTRAS_ALLOW_PRIVATE_NETWORKS=true \
LLM_BASE_URL=http://127.0.0.1:3347/v1 LLM_MODEL=integration-fixture \
npx tsx --tsconfig api/tsconfig.json api/src/index.ts

STEEL_DEV_API_URL=http://127.0.0.1:3307 npm run dev -w ui -- --port 5174

npm run test:smoke -w ui
```

Test configuration:

| Variable | Default |
| --- | --- |
| `UI_TEST_BASE_URL` | `http://127.0.0.1:5174` |
| `API_TEST_BASE_URL` | `http://127.0.0.1:3307` |
| `UI_TEST_CDP_URL` | API URL with the WebSocket scheme; uses session-scoped CDP |
| `UI_TEST_FIXTURE_URL` | `http://127.0.0.1:3347` |
| `UI_TEST_FIXTURE_PORT` | `3347` (fixture server) |
| `UI_TEST_FIXTURE_HOST` | `127.0.0.1` (fixture server) |
| `UI_TEST_ARTIFACT_DIR` | `steel-ui-smoke` under the OS temporary directory |
| `CHROME_EXECUTABLE_PATH` | `/usr/bin/chromium` |

Set Vite's `STEEL_DEV_API_URL` to the same API used by the test. If API, CDP, or
fixture ports change, update their launch environment accordingly. Screenshots
and `results.json` are written outside the repository by default; failures also
save a screenshot.

`EXTRAS_ALLOW_PRIVATE_NETWORKS=true` is only for this isolated local fixture:
watchers and extraction must reach its loopback address. Leave that setting
disabled in production.
