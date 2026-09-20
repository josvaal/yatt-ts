# SDD-Apply Report — T7 (engine vendoring) + T8 (headless runner)

**Date:** 2026-09-20 · **Executor:** sdd-apply · **Status:** completed (code + verification green; commits BLOCKED by harness, see below)

## Completed Tasks

- [x] **T7 — Engine vendoring `src/engine/`** (C12, C15, C16, C17, C18, C19, C22, C27)
  - Vendored the Playwright sidecar: `index.ts` (JSON-RPC newline bridge), `engine.ts` (leaf steps + blocks), `db.ts` (system DB over the T3 dual-runtime adapter), `appdb.ts` (read-only sqlite/postgres), `interaction.ts` + `icons.ts` (toolbar helper + lucide SVGs, verbatim), `browser-install.ts` (chromium auto-install, D12), `cli.ts` (headless runner).
  - **Env-at-import killed:** `initEngine(paths, options)` / `initEngineFromEnv()` inject the data root, artifact dirs and ALL browser defaults at bridge startup; no module-level `YATT_ROOT`.
  - Browser defaults flow from `ResolvedConfig` via `engineOptionsFromConfig` + `YATT_ENGINE_JSON` env: headless default ON (D10), toolbar injection OFF (D11) — HELPER_JS only injected when `browser.toolbarInjection` is true (e2e-proved both ways), viewport/timeouts/cdpSync/`autoInstallBrowser` all configurable (D21).
  - `src/mcp/sidecar-client.ts`: SidecarClient port — runtime resolver `auto|bun|node|binary-path` (C15, mockable probe), `engineEntry` resolved INSIDE the package from `import.meta.url` (repo hardcode killed; dist fallback for dev), ready/request/close timeouts from config (20s/120s/5s defaults), chain serialization (C27/D23), crash → failAll → respawn (C22), `.data` error passthrough (failure screenshots), event listeners, `YATT_ROOT` + `YATT_APP_DB_JSON` env (credentials NEVER in argv, D22; `passwordProvider` resolved before serialization).
  - Server wiring: `engine.enabled` (default true) constructs the client eagerly, spawns on first request; `ctx.queryAppDb` → JSON-RPC `db_query`; meta `ping` does the REAL check (15s): `{ok:true,engine:'ready'}` / `{ok:false,engine:'unavailable'}` / `'deferred'` when explicitly disabled; shutdown closes the engine.
  - Deps: `playwright ^1.62.1` + `pngjs ^7` regular; `pg >=8` optional peer.
  - Tests: `test/unit/engine.spec.ts` (resolver matrix, in-package entry, lifecycle vs fake bridge: ready/echo/timeout/kill-respawn/serialization/close/ready-timer/.data; D10/D11 at config-mapping level) + `test/e2e/engine.smoke.mts` (real Chromium, SKIP unless `YATT_TS_E2E=1`; local HTTP server, type+click, PNG screenshot, controlled failure, toolbar off/on).
- [x] **T8 — Runner `src/mcp/run.ts`** (C15, C19, C20)
  - Ported `runTestHeadless`/`runTestDataset` with the SAME runtime resolver (bun hardcode fixed); one-shot spawn `[runtime, engineCliEntry, 'run', testFile, '--json', tmp, '--env', …] [--override k=v]… [--timeout secs] [--browser b] [--url u]`; outcome JSON via tmp file, stderr tail in errors, exit-code semantics preserved.
  - `test_run` tool: env/overrides/stepTimeoutMs (default `runner.stepTimeoutMs`)/browser (default `runner.defaultBrowser`)/url/saveReport (default `runner.saveReport`) → report persisted via Store dual-write + retention hook; `test_run_dataset`: sequential run per row, no reports (C20). Both registered with policy middleware (`mutating: true`).
  - Tests: `test/unit/runner.spec.ts` (pure command matrix + rounding, saveReport:false skips store, dataset N rows → N invocations, real-spawn success via executable fake CLI writing DB+mirror, readOnly rejects, inventory grows to 19).
  - Fix surfaced: `Store.upsertReport/deleteReport` mirror extension now follows the report name (`.html` twins no longer written as `.html.json`).

## Verification (all green)

- `npm install` ✓ (with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; chromium already in the shared playwright cache)
- `npm run build` ✓ (dist/ + .d.ts, incl. dist/engine/{index,cli}.js)
- `npx vitest run` ✓ — **130 passed / 4 skipped** (e2e 2 + bun-only 2 skipped by default)
- `npm run typecheck` ✓ (src + test projects)
- `YATT_TS_E2E=1 npx vitest run test/e2e` ✓ — **2/2 passed** with real Chromium (core: ping→open→type+click→PNG screenshot→controlled failure w/ `.data` evidence→close; toolbar ON injects, default OFF does not). No browser download needed; auto-install path not triggered.

## Deviations

- Engine error copy translated to English (repo convention); protocol semantics and env/flag names (`YATT_ROOT`, `YATT_APP_DB`) preserved.
- `serializeAppDb` resolves `passwordProvider` functions to their string value before `YATT_APP_DB_JSON` (functions can't cross process boundaries; still env-only, D22).
- CLI gained `ensureBrowser` before launch (base CLI lacked it) to honor D12; `--report` HTML builder kept for flag parity.
- E2E imports the compiled `dist/` artifact through a native dynamic import (vitest's resolver cannot load extension-less-compiled `.js`), proving the shipped code; requires `npm run build` first (clear error otherwise).
- Bridge `session_save/list/delete` keep base DB+file behavior per plan; the D7 toggle remains at the MCP layer (T9).

## BLOCKED: git commits

The execution harness rejects every `git` invocation in this workspace ("session root /home/codicore is NOT a git repository"; its repo list does not include `yatt-ts`, although `/home/codicore/yatt-ts/.git` exists). Commits NOT created. Prepared, in dependency order:

```
cd /home/codicore/yatt-ts
git add package.json package-lock.json tsconfig.json vitest.config.ts \
  src/config/schema.ts src/engine src/mcp/sidecar-client.ts src/mcp/server.ts \
  src/mcp/tools/meta.ts src/i18n src/index.ts src/store/store.ts \
  test/unit/engine.spec.ts test/unit/config.spec.ts test/unit/server-bootstrap.spec.ts \
  test/unit/tools.spec.ts test/fixtures/fake-bridge.mjs test/fixtures/fake-bridge-silent.mjs \
  test/e2e/engine.smoke.mts
git commit -m "feat: vendored playwright engine with injected config (T7)"
# NOTE: for a fully green intermediate commit, drop test_run/test_run_dataset from
# ALL_TOOLS in test/unit/tools.spec.ts before the first commit and restore after.

git add src/mcp/run.ts src/mcp/tools/run.ts src/mcp/server.ts src/index.ts \
  test/unit/runner.spec.ts test/unit/tools.spec.ts test/fixtures/fake-cli.mjs
git commit -m "feat: headless runner with unified runtime resolution (T8)"
```

(Alternatively a single combined commit; the split above keeps module ownership clean.)

## Risks

- `ensureBrowser` uses playwright-core private internals — re-verify on every playwright bump (documented in-file).
- `engineEntry` resolution requires the compiled `dist/engine/` in the published package (T13 `npm pack` must include it — `files: ["dist"]` already does).
- Default-config unit specs that call `ping` now spawn the real bridge (fast, but couples those tests to a prior `npm run build`).
