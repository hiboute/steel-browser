# Several sessions at once (hiboute fork)

Stock Steel runs one Chrome and one session. This fork keeps a pool of
`MAX_SESSIONS` browsers (default `1`, which behaves like stock), one Chrome per
session, each on its own CDP port (`CDP_PORT_BASE`, `CDP_PORT_BASE + 1`, ...)
and its own profile directory.

| Env | Default | Meaning |
| --- | --- | --- |
| `MAX_SESSIONS` | `1` | Browsers in the pool, so sessions that can be live at once |
| `CDP_PORT_BASE` | `9222` | CDP port of slot 0; slot `i` uses `CDP_PORT_BASE + i` |

Give the container enough shared memory (`shm_size`) and RAM for that many
Chromes (roughly 300 MB to 1 GB each, depending on the pages).

## API

- `POST /v1/sessions` takes a free slot. When all are taken it answers `429`.
- The first slot is the primary browser: it keeps an idle browser between
  sessions, its session's `websocketUrl` stays `ws://host/`, and the unscoped
  endpoints (`/v1/scrape`, `/v1/screenshot`, `/v1/pdf`, the root CDP socket)
  use it. Other slots run Chrome only while a session holds them.
- Every session's `websocketUrl` also works as
  `ws://host/v1/sessions/<id>/cdp`; connect Puppeteer or Playwright there.
- `GET /v1/sessions` lists live sessions first (newest first), then released
  ones. `GET /v1/sessions/<id>`, `/context`, `/live-details` and
  `POST /v1/sessions/<id>/release` act on that session only;
  `POST /v1/sessions/release` releases all of them.
- Per-session sockets: `/v1/sessions/<id>/{cast,logs,pageId,recording}`, or
  the unscoped paths with `?sessionId=<id>`. The live view page is
  `/v1/sessions/<id>/debug`.
- A session whose Chrome dies (crash, kill) is released automatically.
