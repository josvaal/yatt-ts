# SDD-Explore Report — YATT → yatt-ts Deep Inventory (2026-09-19)

Subagent: sdd-explore · Status: completed · Sources read in full: mcp/src/**, sidecar/src/**, src/lib/{report,export,import,yatt,vars}.ts, both smoke tests, build scripts, ARCHITECTURE.md.

## 1. MCP server boot surface

**File: `mcp/src/server.ts`** (`main()`)

- **CLI flags** (manual argv parsing): `--http` (streamable HTTP instead of stdio), `--port N` (**default 3191 hardcoded**, binds `127.0.0.1`), `--root <path>`.
- **Env vars**: `YATT_ROOT` (root fallback), `YATT_SIDECAR` (prebuilt sidecar binary path), `YATT_APP_DB` (app-under-test DB, inherited by sidecar), `PLAYWRIGHT_SKIP_BROWSER_GC`.
- **Transport**: `--http` → `StreamableHTTPServerTransport`, **one single transport instance serves all requests**; CORS `*` hardcoded, per-session `sessionIdGenerator: crypto.randomUUID`. Otherwise `StdioServerTransport`.
- **Root resolution (`root.ts`)**: `YATT_ROOT` → else repo-layout fallback `dirname(import.meta.url)/../..`. **Critical split**: data root vs `sidecarDir()` = `import.meta.url/../../sidecar` (engine code always resolved from package repo layout). Biggest repo-layout hardcode.
- Helpers: `testsDir(root)`, `reportsDir(root)`, `exportsDir(root)`, `dbPath(root)`.
- **`ctx.ts`**: `interface Ctx { root: string; store: Store; sidecar: SidecarClient }` — all shared state.
- Shutdown: SIGINT/SIGTERM → `sidecar.close()` → `store.close()` → exit. Server identity: `McpServer({ name: "yatt", version: "0.1.0" })`. Registration order: meta, tests, run, browser, db, reports, resources, prompts.
- `SidecarClient.onEvent` exists but is **never wired** in server.ts — sidecar events (browser_status, tabs_changed, action_captured, log, browser_install_*) silently dropped.

## 2. Complete tool catalog (35 tools)

**tools/tests.ts — 9** (need `store`; export needs `root`): `test_list`, `test_get`, `test_create`, `test_update`, `test_delete`, `test_rename`, `test_duplicate`, `test_validate`, `test_export_playwright` (playwright/jest formats, optional write to `exports/`).

**tools/run.ts — 2** (spawn sidecar CLI one-shot): `test_run` (env, overrides, stepTimeoutMs, browser, url override, saveReport default true), `test_run_dataset` (sequential, one run per row, no reports).

**tools/browser.ts — 16** (need `sidecar` only): `browser_open`, `browser_close`, `browser_status`, `browser_preview` (PNG image content), `browser_eval` (8s), `browser_run_step` (+vars interpolation; screenshot evidence on ok & fail), `browser_condition` (polling), `browser_scroll`, `browser_click_at` (resolves data-testid→id→CSS), `tab_open`, `tab_list`, `tab_switch`, `tab_close`, `session_save`, `session_list`, `session_delete`.

**tools/db.ts — 1**: `db_query` (read-only SQL vs app DB; per-call `db` overrides `YATT_APP_DB`; 30s).

**tools/reports.ts — 3**: `report_list`, `report_get`, `report_delete`.

**tools/meta.ts — 4**: `ping` (15s, sidecar), `schema` (SCHEMA_DOC), `baseline_list`, `baseline_get` (PNG image content).

**~13 of 35 tools work with `sidecar: null`** — natural tool-subset split (tests CRUD, validate, reports, baseline list/get, schema).

## 3. Resources & prompts

Resources: `yatt://schema` (static), `yatt://tests/{name}`, `yatt://reports/{name}` (templates, no list callback).
Prompts (5, Spanish copy): `crear-test`, `diagnosticar-reporte`, `explorar-pagina`, `exportar-spec`, `bateria-de-flujos`.
`schema.ts`: `SCHEMA_DOC` — long embedded Spanish markdown (schemaVersion 1, all actions, authoring guide). Library asset; i18n consideration.

## 4. Sidecar coupling (`mcp/src/sidecar.ts`, class `SidecarClient`)

- Protocol: newline JSON-RPC over stdio: `{id,method,params}` → `{type:"response",id,ok,result|error}` + events `{type:"event",name,data}`. Same contract as Rust host.
- Spawn priority: `YATT_SIDECAR` binary → `bun run src/index.ts` (probe `bun --version`) → fallback `node src/index.ts` (≥22.6 type-stripping). `cwd = sidecarDir()` (repo-layout). stdout line-parsed; stderr inherited.
- Lifecycle: lazy start; readiness = `sidecar_ready` event with **20s fail-timer**; multiple pending starters; crash → failAll + respawn on next call.
- Serialization: single-browser engine → all calls through one promise chain. Timeouts: default 120s; ping 15s, eval 8s, db_query 30s. `.data` on error carries full result (failure screenshots).
- Close: EOF on stdin → sidecar exits; MCP waits 5s then kill.
- **`test_run` does NOT use this client**: `run.ts:spawnCli()` one-shot `spawn("bun", ["run","src/cli.ts","run",file,...])` — **hardcodes `bun`, no node fallback**.

## 5. Persistence layer

System DB `yatt.db` (schema identical in `sidecar/src/db.ts`, `src-tauri/src/db.rs`, `mcp/src/db.ts`):
```
tests     (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL)
reports   (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL)
baselines (name TEXT PRIMARY KEY, png BLOB NOT NULL,      updated_at INTEGER NOT NULL)
sessions  (name TEXT PRIMARY KEY, storage_state TEXT NOT NULL, updated_at INTEGER NOT NULL)
PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000
```
- `mcp/src/db.ts` `Store`: dual-write invariant (DB truth + file mirrors), serialized writes (`writeChain`), `sanitizeName()` rejects `/ \ ..`. `close()` on shutdown.
- `sidecar/src/db.ts` `openYattDb()`: `bun:sqlite` first, **`node:sqlite` DatabaseSync fallback**; lazy singleton via `engine.ts:getDb()`.
- App-under-test DB (`appdb.ts`): read-only; priority per-call param > `--app-db` > `YATT_APP_DB`; SQLite readonly or `postgres://` (needs `pg`); read-only regex guard + PG `BEGIN READ ONLY`; `ROW_CAP = 200`; cached handle.
- File layout under data root: `yatt.db` (+WAL), `tests/<name>.yatt.json`, `reports/<slug>.json|.html`, `exports/<name>.spec.ts`, `baselines/<name>.png`, `sessions/<name>.json` (legacy fallback only).
- Hardcoded: `sidecarDir()` repo layout, filenames (`yatt.db`, `.yatt.json`), and `engine.ts` module-level `ROOT = process.env.YATT_ROOT || process.cwd()` **resolved at import time** (config must be set before importing engine — library-design constraint).

## 6. Config surface: today vs backlog

Already parameterizable: data root, transport+port, per-run env/overrides/browser/stepTimeout/url/saveReport, per-open headless/viewport/engine/session/timezone/geolocation, app-db connection, per-step timeout+vars, export format/write.

**Hardcoded — config backlog for yatt-ts**: HTTP default port 3191/bind/CORS `*`/single shared transport; server name/version; sidecar spawn priority+cwd+timeouts (ready 20s, req 120s, close 5s); headless runner bun-only spawn; browser defaults (viewport 1280×800, goto 30s, element 5s, wait_visible 10s, preview 5s/10s, close 6s, run_step 40s); CDP sync 400ms poll chromium+visible-only; visual assert threshold 32; db ROW_CAP 200/busy 5000/WAL; db_wait defaults.
**Missing entirely**: access/permissions/auth layer (HTTP open on localhost), tool allowlist/denylist, read-only mode, session persistence toggle, per-artifact storage paths, engine download policy, log verbosity, tool-subset registration.
Inconsistencies: two sanitizers (`Store.sanitizeName` reject vs `engine.sanitizeName` replace); two report HTML builders (`cli.ts:buildHtml` vs `report.ts:buildReportHtml`).

## 7. Dependencies & runtime assumptions

- mcp: `@modelcontextprotocol/sdk ^1.30.0`, `zod ^4.5.4`; TS run directly by bun (**no build, `.ts`-extension imports, `allowImportingTsExtensions`, noEmit** → npm publish needs real build/bundler pass).
- sidecar: `playwright ^1.62.1`, `pngjs ^7.0.0`, `pg ^8.23.0` (appdb.ts comment claiming no `pg` is stale).
- Bun-specific: `bun:sqlite` hard import in `mcp/src/db.ts` (**MCP Store is Bun-only today**); `bun --version` probe; `spawn("bun")`; `import.meta.main/dir`.
- Node: `node:sqlite` needs ≥22.5; SEA bundle uses node v22.23.2. `browser-install.ts:ensureBrowser()` auto-installs chromium via **playwright-core private internals** (`lib/coreBundle`, `registry.registry.install`) — version-fragile; chromium-headless-shell needed for headless.
- **Entangled imports**: `run.ts` ← `src/lib/report.ts`; `tools/tests.ts` ← `src/lib/export.ts`, `src/lib/import.ts`, `src/lib/yatt.ts` (types). **`report.ts` imports value `ACTION_LABELS` from `yatt.ts` which imports Tauri APIs at module scope** — landmine for standalone packaging (must vendor + strip). `vars.ts` is pure. `@/` path aliases in `src/lib/*`.
- mcp/ and sidecar/ have **separate package.json/lockfiles** — clean extraction boundary.

## 8. Test infrastructure

- `mcp/test/smoke.ts`: single spawn via `StdioClientTransport`, ephemeral tmpdir root, local HTML fixture, ephemeral app DB as `YATT_APP_DB`; ~48 checks in ~10 sections: tool inventory (≥25 + required names), prompts ≥4, ping/schema/resource, validation good/bad/future-schema, CRUD+rename+duplicate+export (playwright/jest/invalid), live browser (open/status/preview-image/run_step/condition with polling timing/eval/vars), db_query (env + per-call + read-only rejection), tabs, session save/list/delete, `test_run` pass + report shape + resource read, controlled failure + `report_delete`, baseline_list empty. **Almost directly reusable as library E2E basis** (tests through public MCP protocol).
- `sidecar/test/smoke.ts`: 12 sections, each with own sidecar + wiped `.smoke-data`: core, toolbar, preview, form (RF-04), grab, vars, condition, db, tabs, visual, session, window-sync. Engine-level suite.

## 9. Reuse candidates

**Extract nearly as-is**: `mcp/src/sidecar.ts` (parametrize cwd/command), `sidecar/src/index.ts` (`start()` exported), `sidecar/src/engine.ts` (inject ROOT), `sidecar/src/db.ts`, `appdb.ts`, `browser-install.ts`, `interaction.ts`, `icons.ts`, `mcp/src/tools/*.ts`, `resources.ts`, `prompts.ts`, `schema.ts`, `run.ts` (config injection), `ctx.ts`, `src/lib/vars.ts`, `src/lib/import.ts`, `src/lib/export.ts` (path fix).
**Needs surgery**: `mcp/src/db.ts` Store (dual-runtime SQLite adapter), `mcp/src/run.ts` (inject dir+runtime), `src/lib/report.ts` (strip ACTION_LABELS import), `mcp/src/server.ts` (flags → options object), `sidecar/src/cli.ts` (dedupe report HTML).
**Do not carry**: `src/lib/yatt.ts` (Tauri IPC), `src-tauri/`, React UI, `sidecar/scripts/build-sidecar.ts` + `sea/` (superseded by npm distribution; playwright-core patching knowledge there is valuable).

## 10. Risks / gotchas

1. `sidecarDir()` repo-layout hardcode — library must bundle engine in-package or accept engine path via config.
2. `engine.ts` reads `YATT_ROOT` at module import — config-after-import silently uses `process.cwd()`.
3. WAL + cross-process access; repo-root `yatt.db` is **~583 MB** (`reports.content` stores per-step base64 screenshots as TEXT) — document/limit report retention.
4. `ensureBrowser()` playwright-core private API — pin playwright tightly, re-verify each bump; headless needs chromium-headless-shell.
5. Browser rotation in one sidecar session breaks engine process bus — tests spawn fresh engines per suite.
6. CDP viewport sync: chromium + visible-mode only; don't promise cross-engine window-sync.
7. Toolbar injection unconditional in `openBrowser()` — library should make injection optional.
8. Two sanitizers + two report HTML builders — parity risk.
9. `spawn("bun")` in run.ts has no node fallback (inconsistent with SidecarClient).
10. Events dropped in MCP mode (`onEvent` unwired).
11. HTTP mode open: CORS `*`, no auth, shared transport — needs access layer before exposure.
12. No file watcher: MCP writes appear in desktop UI only after reload.
13. `sidecar/src/icons.ts` is generated (lucide SVGs) — regenerate/vendor, don't hand-edit.
14. npm-publish blockers: bun:sqlite in Store, `.ts`-extension imports + noEmit, `@/` aliases, Tauri-reachable import chain, `pg` policy, playwright-core private API, `import.meta.main`.

**Verdict**: extraction boundary unusually clean. Library must add: unified config object (paths, runtime command, browser defaults, timeouts, ports, auth/permissions/tool subsets, session persistence toggle), dual-runtime SQLite adapter in Store, vendored Tauri-stripped `vars/import/export/report`, engine bundled in-package or addressable via config.
