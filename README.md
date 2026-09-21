# yatt-ts

**Your own highly configurable YATT MCP server, as an npm library.**

`yatt-ts` spins up a complete [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI clients (Claude, Cursor, your own agents) full access to [YATT](https://github.com/yatt-labs/yatt) — a UI-testing toolbox with **35 tools**: a test library (create/edit/validate), a headless Playwright runner with HTML reports, a **live Chromium browser with screenshots the AI can actually see**, session management, visual baselines, spec export, and read-only SQL against your app's database.

Everything is configurable from a single typed config object: transport (stdio/HTTP), bearer auth, per-tool permissions, session persistence, artifact paths, browser defaults, retention. Strict validation fails fast and names the offending key — never a silent misconfiguration.

- Runtime: **Node ≥ 22.5** or **Bun 1.4+** (dual-runtime, including the SQLite layer)
- Engine: vendored Playwright **Chromium**, **headless-first** (screenshots always available), auto-downloaded on first use
- License: MIT

## Install

```bash
npm install yatt-ts
# or
bun add yatt-ts
```

Node 22.5+ or Bun 1.4+. On first browser use, Chromium (and `chromium-headless-shell`) is downloaded automatically — no extra setup.

## Quickstart (30 seconds)

**Stdio server, zero config** — the data root is your current working directory:

```ts
import { createYattServer } from 'yatt-ts';

const server = await createYattServer(); // all defaults (C28: zero-config works)
await server.start(); // speaks MCP over stdio
```

**HTTP + bearer token** — connect remote clients over the network:

```ts
import { createYattServer, generateToken } from 'yatt-ts';

const server = await createYattServer({
  http: { enabled: true, port: 3191, host: '127.0.0.1' },
  auth: { token: generateToken() }, // or your own string (min 16 chars) / tokenHash
});
await server.start();
// Clients send: Authorization: Bearer <token>  (401 otherwise; token never logged)
```

**Or from the terminal** (no code at all):

```bash
npx yatt-ts --version
npx yatt-ts --http --port 3191 --token my-secret-token-16ch
npx yatt-ts --read-only --root /path/to/yatt-data --locale es
```

`--http` without a token generates a crypto-secure ephemeral one and prints it **once** to stderr.

Point your MCP client at it (Claude Desktop / Cursor style):

```json
{
  "mcpServers": {
    "yatt": { "command": "npx", "args": ["yatt-ts", "--root", "/path/to/yatt-data"] }
  }
}
```

## What you get

- **35 MCP tools** — `ping`, `schema`, test CRUD + validate/rename/duplicate/export (`test_*`), headless runner (`test_run`, `test_run_dataset`), reports (`report_*`), live browser (`browser_*`, `tab_*`, `session_*`), baselines (`baseline_*`), and read-only SQL (`db_query`).
- **Resources**: `yatt://schema`, `yatt://tests/{name}`, `yatt://reports/{name}`.
- **Prompts**: 5 ready-made work prompts, in English or Spanish.
- **Real browser evidence**: `browser_preview` returns a PNG the AI can see; failed steps attach an evidence screenshot.

## Configuration

Everything is optional; omitted keys take defaults. Unknown keys are rejected with an error that names the key.

| Domain | Keys (default) | What it controls |
|---|---|---|
| `paths` | `root` (cwd), `tests` (`tests`), `reports` (`reports`), `exports` (`exports`), `baselines` (`baselines`), `sessions` (`sessions`), `db` (`yatt.db`) | Where every artifact lives. Relative paths resolve against `root`; `~` expands. Point `root` at an existing YATT desktop data folder — fully compatible. |
| `http` | `enabled` (false), `port` (3191), `host` (127.0.0.1), `cors.origins` (['*']) | Streamable HTTP transport instead of stdio. |
| `auth` | `token` \| `tokenHash` | Bearer auth for HTTP. Plain token (≥16 chars) or its SHA-256 hex digest — never both. stdio ignores auth. |
| `permissions` | `readOnly` (false), `allowTools`, `denyTools`, `denyBehavior` ('error' \| 'hide') | Mutating tools denied with an announced reason; denied tools stay visible ('error') or vanish from listings ('hide'); `allowTools` default-denies the rest. |
| `sessions` | `persist` (true) | `false` = browser sessions live in memory only: usable live, **zero** disk/DB writes, wiped on close. |
| `storage` | `retention.maxAgeDays`, `retention.maxReports` | Opt-in report cleanup. **Absent = never deletes anything.** |
| `engine` | `enabled` (true), `runtime` ('auto' \| 'bun' \| 'node' \| binary path), `autoInstallBrowser` (true), timeouts | The vendored Playwright engine. `enabled: false` runs engine-free (browser/run/db tools fail clearly; `ping` reports `'deferred'`). |
| `browser` | `defaultHeadless` (true), `toolbarInjection` (false), `defaultViewport` (1280×800), `engine` ('chromium'), timeouts, `cdpSync` | Headless-first with full screenshot support; floating toolbar OFF unless you turn it on. |
| `runner` | `defaultBrowser` ('chromium'), `stepTimeoutMs` (40000), `saveReport` (true) | Headless run defaults. |
| `appDb` | `{ type: 'sqlite', file }` \| `{ type: 'postgres', host, port, user, password \| passwordProvider, database, ssl }` | The app-under-test database for `db_query` (read-only). Credentials travel via env, never argv; `passwordProvider` resolves secrets at call time. |
| `logging` | `level` ('info', or 'silent') | Server diagnostics go to stderr (never the protocol channel). |
| `locale` | `'en'` (default) \| `'es'` | Language for prompts, tool descriptions, and messages. |

Invalid values (wrong type, impossible path, both token forms, …) throw `ConfigError` at boot naming the exact key.

## Security notes

- **CORS is permissive by default.** `http.cors.origins` defaults to `['*']`, mirroring the base YATT tool. For untrusted environments, restrict it to an explicit origin list in your config.
- **`test_run` variable overrides travel as CLI arguments** to the one-shot engine process (e.g. `--override token=…`), matching the base-tool behavior. They are visible in the host process list (e.g. `ps`) for the duration of the run — avoid secret values in overrides, or contribute env-based override passing later.

## Recipes

Permission, session, retention, and connection examples live in [`examples/`](./examples) — each one is a runnable, self-contained file:

`01-zero-config-stdio` · `02-http-with-token` · `03-read-only-server` · `04-deny-list` · `05-ephemeral-sessions` · `06-custom-paths` · `07-report-retention` · `08-appdb-postgres-object` · `09-nestjs-mcp-handler`

## Embed in your HTTP framework (NestJS)

Instead of the built-in HTTP server (`http.enabled`), you can expose the MCP endpoint at **any route of your own HTTP framework** — NestJS, Express, Fastify, plain `node:http` — with `createMcpHttpHandler`:

```ts
import { createYattServer, createMcpHttpHandler } from 'yatt-ts';

const yatt = await createYattServer({ engine: { enabled: false } });
const mcp = createMcpHttpHandler(yatt);

// Any framework route (Nest controller, Express router, …):
app.use('/api/mcp', (req, res) => mcp.handle(req, res, req.body));
```

- **When to use which**: `http.enabled` for a standalone MCP endpoint you own end-to-end; the handler when an existing backend should host it (shared middleware, TLS, deployment).
- **Lifecycle is yours**: do NOT call `yatt.start()` in handler mode (the handler connects the MCP server per session itself); on teardown call `mcp.close()` first, then `yatt.shutdown()`. In a Nest app call `app.enableShutdownHooks()` — without it Nest never fires `onModuleDestroy` on SIGINT/SIGTERM, so graceful teardown never runs.
- **Auth via host guards**: no auth by default — your framework's guards/middleware rule. Or pass `authenticate: (req) => boolean` (`false` → 401 JSON, throw → controlled 500).
- **One client at a time** per server (single browser engine): when a second client initializes, the stale session is evicted (new-wins).
- Full NestJS recipe (controller + service + bearer guard): [`examples/09-nestjs-mcp-handler.ts`](./examples/09-nestjs-mcp-handler.ts).

## Public API

```ts
import {
  createYattServer,     // (config?) → { server, ctx, start(transport?), shutdown() }
  createMcpHttpHandler, // mount the MCP endpoint inside your own HTTP framework
  resolveConfig,        // validate + apply defaults yourself
  ConfigError,          // named-key config failures
  generateToken,        // crypto-secure 64-hex token
  verifyToken, hashToken, redact,
  evaluateToolAccess, isToolListed,
  applyReportRetention,
  Store, openDatabase,
  VERSION,
} from 'yatt-ts';
```

`start()` with no argument picks the transport from config (HTTP when `http.enabled`, stdio otherwise) and handles SIGINT/SIGTERM; pass an MCP `Transport` (e.g. `InMemoryTransport`) to embed the server in your own process and own the lifecycle yourself. `shutdown()` is idempotent and always safe to call.

## CLI

```
yatt-ts [serve] [--http] [--port N] [--host H] [--root PATH]
        [--token T | --token-hash HEX64] [--read-only] [--locale en|es]
        [--no-engine] [--allow-tool NAME] [--deny-tool NAME]
        [--deny-behavior error|hide]
yatt-ts --version | --help
```

`--http` without `--token`/`--token-hash` generates an ephemeral token and prints it once to stderr. App-database credentials are never accepted on the command line — configure them programmatically (D22).

## Engine notes

- **Chromium only, headless-first.** `browser_open` runs headless by default (D10); screenshots/preview work exactly the same. Pass `headless: false` when a human needs to watch.
- **Auto-download.** First browser use installs `chromium` + `chromium-headless-shell` via the bundled Playwright. Disable with `engine.autoInstallBrowser: false`.
- **Floating toolbar OFF by default** (D11). Enable with `browser.toolbarInjection: true`.
- **Runtime selection.** The engine child process resolves `bun → node` automatically (override: `engine.runtime`). One browser at a time — engine calls are serialized by design (single concurrent MCP client).
- **No network needed** for the server itself; the only download is the browser on first use.

## Requirements

- Node **≥ 22.5** (uses the built-in `node:sqlite`) or **Bun ≥ 1.4** (`bun:sqlite`)
- ~300 MB disk for the auto-downloaded Chromium

## Development

```bash
npm run build            # tsc → dist/ (+ executable bin)
npm test                 # vitest unit suite
npm run typecheck        # src + test + examples
YATT_TS_E2E=1 npx vitest run test/e2e   # real-Chromium e2e smokes
node test/e2e/install.mjs               # npm pack + fresh-consumer install proof
```

## License

[MIT](./LICENSE)
