# Context — yatt-ts npm library

**Date:** 2026-09-19 · Full inventory: [evidence/sdd-explore-report.md](evidence/sdd-explore-report.md)

## Relevant code (base repo /home/codicore/Proyectos/yatt)

| Area | Files | Role |
|---|---|---|
| MCP server | `mcp/src/server.ts` | Bootstrap: flags `--http/--port/--root`, env `YATT_ROOT`, stdio or HTTP transport |
| MCP state | `mcp/src/ctx.ts`, `root.ts`, `db.ts` | `Ctx{root,store,sidecar}`; path helpers; `Store` (SQLite dual-write, **bun:sqlite only — publish blocker**) |
| MCP tools | `mcp/src/tools/{tests,run,browser,db,reports,meta}.ts` | 35 tools total; ~13 need no browser engine |
| MCP assets | `mcp/src/{schema,prompts,resources}.ts` | SCHEMA_DOC (ES), 5 prompts (ES), 3 resources |
| Runner bridge | `mcp/src/sidecar.ts`, `mcp/src/run.ts` | `SidecarClient` (JSON-RPC stdio, lazy spawn, bun→node fallback) vs one-shot `spawnCli` (**bun hardcoded**) |
| Engine | `sidecar/src/{index,engine,db,appdb,interaction,icons,browser-install,cli}.ts` | Playwright JSON-RPC bridge; dual-runtime SQLite (`bun:sqlite`→`node:sqlite`); in-page toolbar; auto browser install |
| Shared pure libs | `src/lib/{vars,import,export,report}.ts` | Extractable, but `report.ts` imports `ACTION_LABELS` value from Tauri-coupled `yatt.ts` |
| Tests | `mcp/test/smoke.ts` (~48 checks via MCP protocol), `sidecar/test/smoke.ts` (12 isolated sections) | Directly reusable as library test basis |

## Existing states / entities

- SQLite `yatt.db`: tables `tests`, `reports`, `baselines`, `sessions` (WAL, busy_timeout 5000). DB = truth; files = mirrors.
- Test doc format: `schemaVersion: 1`, leaf + structural actions, variables/environments, dataset.
- Config surface today: data root, transport+port, per-run/per-open options, app-db connection. Everything else hardcoded (ports, timeouts, viewport, spawn priority, CORS `*`, no auth, no tool subsets, no session-persistence toggle).

## What exists vs what's missing

**Exists (to extract, not rewrite):** complete MCP server (35 tools), complete Playwright engine, dual-runtime SQLite fallbacks (sidecar side), clean package boundaries (mcp/ and sidecar/ have own package.json), protocol-level smoke tests.

**Missing for the npm library:**
1. Publishable build (today: bun runs TS directly, `.ts`-extension imports, noEmit — needs bundler/tsconfig pass and `exports` map + `.d.ts`).
2. `Store` dual-runtime SQLite (bun:sqlite hard import blocks Node consumers).
3. Unified config object: paths per artifact, runtime command, browser defaults, timeouts, ports, bind, CORS, logging.
4. Access/permission layer: HTTP auth token, tool allowlist/denylist, read-only mode.
5. Session persistence toggle (sessions/no saved sessions) + per-artifact storage overrides.
6. Tool-subset registration (browser tools optional without engine).
7. Engine bundled in-package (kill `sidecarDir()` repo-layout hardcode) + optional toolbar injection toggle.
8. Tauri-stripped vendored `vars/import/export/report` (+ dedupe the two report HTML builders, two sanitizers).

## Applicable conventions

- Base repo `CLAUDE.md`: DB is source of truth + file mirror written together (invariant of `test_save`); don't touch `src-tauri/gen/`, `dist/`, `node_modules/`, mirror folders; sidecar/MCP run TS via bun; smoke tests are the E2E verification pattern.
- New project `yatt-ts` has no AGENTS.md yet — its conventions will be established by this feature (recorded here and in the eventual README).

## Visual exploration

Not applicable — the feature delivers an npm library (no UI of its own). Verification is protocol-level (MCP client) + engine-level (Playwright), mirroring the existing smoke suites. YATT in-app E2E does not apply; the library's own smoke/E2E suite replaces it (and YATT itself becomes the tool under test).
