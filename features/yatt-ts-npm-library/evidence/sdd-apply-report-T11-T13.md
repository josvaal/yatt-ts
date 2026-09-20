# SDD-Apply Report — T11 (protocol smoke) + T12 (docs & examples) + T13 (packaging proof)

**Date:** 2026-09-20 · **Executor:** sdd-apply · **Status:** completed (code + verification green; commits BLOCKED by harness, prepared commands below)

## Completed Tasks

- [x] **T11 — Protocol E2E smoke `test/e2e/protocol.smoke.mts` (the verification of record)** — **126 checks, 0 failures**, green on Node (vitest) AND Bun (standalone).
  - Dual-mode file: registers a vitest test (guarded by `YATT_TS_E2E=1`, like the sibling smokes) when loaded by the runner, and runs standalone with PASS/FAIL logging + non-zero exit when invoked directly (`bun run test/e2e/protocol.smoke.mts`; direct-run detection via realpath'd `import.meta.url` vs `argv[1]`). Only dynamically imports vitest inside the non-direct branch, so plain `bun run` never touches the runner (and hits no bun×zod transform issue — the smoke imports the COMPILED dist/ plain JS anyway).
  - Base-smoke parity ported (~48 checks): tool inventory (35 + required names, C02), prompts ≥4 (en names), `yatt://schema` / `yatt://tests/{name}` / `yatt://reports/{slug}` resources, `ping` + `schema` tool, test_validate good/bad/future-schemaVersion, CRUD + duplicate-fail + rename + export (playwright linear / jest / invalid format / `write:true` into the configured exports dir), live browser (open → status → preview PNG magic bytes → run_step type+click → condition exists → polling timeout timing bounds → eval DOM → `{{var}}` interpolation), tabs (open/switch/close), session save/list/delete, `test_run` pass + report shape + report resource, controlled failure + `report_delete`, `baseline_list` empty, cleanup leaves the library empty (C12).
  - New-capability checks beyond parity: HTTP transport with bearer auth accept/reject — no token → rejected, wrong token → rejected, valid token → accepted + full catalog + `ping` `engine:'deferred'` (C05/C06, engine.enabled:false); one real **stdio roundtrip through `node dist/cli.js`** with ping + 35-tool listing + `--no-engine` deferred (C04/C30); `readOnly` server denies `test_create`/`test_delete` with announced reason while reads work (C08); `denyTools` with `error` behavior stays listed + announces policy error, with `hide` is absent (34 tools remain) (C07); `sessions.persist:false` → live save + list, zero session files under root, and after shutdown no dir + sessions table empty (C09); `sessions.persist:true` → DB row (with the actual storage state) + `sessions/<name>.json` mirror (C10); `locale:'es'` → Spanish prompt names (crear-test…), Spanish schema text, Spanish tool descriptions (C03); retention `maxAgeDays:1` cleans a 5-day-old report after a report mutation (DB + mirror gone) (C29); headless default proven via `navigator.userAgent` = HeadlessChrome (C16/D10); toolbar absent by default / present with `browser.toolbarInjection:true` via `browser_eval` (C17); `test_run_dataset` 2 rows → 2 sequential runs, per-row results (C20); `baseline_list`/`baseline_get` with seeded PNG blob (C25); zero-config `createYattServer()` with NO args boots in a tmp `process.cwd()` and pings (C28); invalid configs (`notAKey`, `http.port: 99999`) → `ConfigError` naming the key (C13). appDb wired the library-native way via `config.appDb` (sqlite file; SELECT rows/columns/totalRows, per-call `db` override, INSERT rejected by the read-only guard, C21) with ONE env-path check kept for base parity (`YATT_APP_DB` feeds `db_query` through the engine's legacy env support).
  - Ephemeral tmp roots for every server; fixture page served on port 0; all roots removed in `finally`.
- [x] **T12 — Docs & examples**
  - `README.md` (English, marketplace-ready): what it is, install, 30-second quickstart (zero-config stdio + HTTP+token + CLI one-liners + mcpServers client snippet), full config-domain table with defaults, permissions/sessions/retention/appDb guidance, public API surface, CLI usage, engine notes (Chromium auto-download incl. headless-shell, headless-first, toolbar off, runtime auto bun→node, one-client serialization), requirements (Node ≥22.5 / Bun ≥1.4), dev commands, MIT.
  - `README.es.md`: same content in neutral professional Spanish.
  - `examples/` — 8 self-contained runnable recipes, each with a comment header: `01-zero-config-stdio.ts`, `02-http-with-token.ts`, `03-read-only-server.ts`, `04-deny-list.ts`, `05-ephemeral-sessions.ts`, `06-custom-paths.ts`, `07-report-retention.ts`, `08-appdb-postgres-object.ts` (TypeORM-style object with `passwordProvider`; documented that booting without a live Postgres is fine). All import from `../src/index.js` so they typecheck without install; kept OUT of the build tsconfig and typechecked via `tsconfig.test.json` (include now has `examples`).
  - `package.json` metadata polish: keywords (mcp/mcp-server/testing/playwright/headless/…), repository/bugs/homepage placeholders (github.com/yatt-labs/yatt-ts), engines already set; version kept 0.1.0.
- [x] **T13 — Packaging proof `test/e2e/install.mjs`** (+ vitest guard `test/e2e/install.mts`, same YATT_TS_E2E gate)
  - Plain-node script: `npm pack --json` → asserts the tarball is `yatt-ts-0.1.0.tgz` and ships `dist/index.js`, `dist/index.d.ts`, `dist/cli.js`, `dist/engine/index.js` (bridge), `dist/engine/cli.js` (runner CLI), `package.json`, `README.md`, `LICENSE`, and does NOT ship `src/` or `test/` → node consumer (tmp dir, `npm install <tgz>`) boots `createYattServer` from the INSTALLED package (tmp root, `engine.enabled:false`), pings over InMemoryTransport → `ok:true`/`deferred`, VERSION asserted → bun consumer (second tmp dir, `bun install <tgz>`) imports `VERSION` + `resolveConfig` and asserts defaults (C23/C24) → cleanup of all tmp dirs → non-zero exit on any failure.
  - Verified output (C24 evidence): `Packaging proof: ALL GREEN` — tarball checks ok, `NODE CONSUMER OK — installed yatt-ts boots and pings`, `BUN CONSUMER OK — installed yatt-ts imports and resolves config`, exit 0.

## Verification (all green, in order, final pass)

- `npm run build` ✓ (fresh dist/ + .d.ts; bin exec bit restored)
- `npm run typecheck` ✓ (src + test + examples projects)
- `npx vitest run` ✓ — **152 passed / 9 skipped** (the 2 new skips = protocol smoke + install guard, e2e-gated)
- `YATT_TS_E2E=1 npx vitest run test/e2e` ✓ — **7/7 passed** (4 files): engine 2/2, browser 3/3 (real Chromium), protocol smoke 1/1 (126 checks), install guard 1/1
- `node test/e2e/install.mjs` ✓ — Packaging proof: ALL GREEN (exit 0)
- `bun run test/e2e/protocol.smoke.mts` ✓ — **126 checks ok / 0 FAIL, exit 0** (bun 1.4.0; no bun×zod transform issue: the standalone path loads compiled dist/ and never imports vitest)

## Work Unit Evidence

| Evidence | Required value |
|---|---|
| Focused test command + result | `YATT_TS_E2E=1 npx vitest run test/e2e` → 7/7 passed (4 files); `node test/e2e/install.mjs` → ALL GREEN exit 0; `npx vitest run` → 152 passed/9 skipped; `npm run typecheck` → clean |
| Runtime harness + result | Real Chromium protocol smoke over MCP (in-memory + stdio CLI + HTTP+bearer) → 126/126 checks on Node AND `bun run` standalone (exit 0); fresh-consumer `npm install`/`bun install` of the packed tarball boots and pings |
| Rollback boundary | Delete `test/e2e/protocol.smoke.mts`, `test/e2e/install.mjs`, `test/e2e/install.mts`, `README.md`, `README.es.md`, `examples/` and revert `package.json` (metadata block) + `tsconfig.test.json` (include) — no src/ changes in this batch, so the library behavior is untouched |

## Deviations from the task text

- `browser_status` cannot "show headless true": the engine `status` payload (faithful base port) carries `{open, browser, url, interaction}` with no headless field. Headless default is proven instead via `browser_eval navigator.userAgent` containing `HeadlessChrome` + `browser_status.open === true` (stronger, runtime-level evidence). Noted for the record.
- The standalone runtime for the smoke is Bun only (`bun run test/e2e/protocol.smoke.mts`), as specified; plain `node file.mts` is not a supported standalone path on Node 22 without type-stripping flags (the node path is the vitest-guarded run). Not hit: the bun×zod×vitest transform issue did not appear (documented why above).
- `config.appDb`-vs-env: task asked to wire the app DB via config "NOT env" while keeping one env-path check for parity — implemented exactly that (main flow uses `config.appDb`; a dedicated server without `appDb` config proves `YATT_APP_DB` still works through the engine's legacy env support).
- Zero-config ping spawns the real engine (default `engine.enabled: true`) — kept, since C28's contract is "boots AND pings"; cost ~1-2 s.

## Issues found during implementation

- `localStorage.setItem` on `about:blank` is denied (opaque origin) — after the tab section the active tab is `about:blank`, so the smoke now sets localStorage while the fixture page is active and `session_save`'s storageState is asserted to carry it. Test-side fix; library behavior correct.
- `report_delete` fires retention fire-and-forget; joining via `ctx.afterReportMutation()` afterwards runs a SECOND (no-op) pass, so `{deleted:[]}` is expected there — the C29 evidence is the observable cleanup (report_list + mirror file gone).

## BLOCKED: git commits (harness guard, same as T7-T10 batches)

Every `git` invocation is rejected by the harness ("session root /home/codicore is NOT a git repository"). No staging was performed (tree left unstaged). Prepared commands, in order:

```
cd /home/codicore/yatt-ts
git add test/e2e/protocol.smoke.mts
git commit -m "test: protocol e2e smoke as verification of record (T11)"

git add README.md README.es.md examples/ package.json tsconfig.test.json
git commit -m "docs: readme en/es and runnable examples (T12)"

git add test/e2e/install.mjs test/e2e/install.mts
git commit -m "test: packaging install proof (T13)"
```

NOTE: if the T1–T10 prepared commits (see `sdd-apply-report-T7-T8.md` / `sdd-apply-report-T9-T10.md`) have not been executed yet, apply those first — the three commits above only cover T11/T12/T13 files.

## Risks

- `npm pack`/consumer installs require registry access for the package's dependencies; verified working now, but the install proof is network-dependent by nature (fits its role as a manual/gated packaging check, not a hermetic unit test).
- The HTTP auth checks assert on the SDK's rejection error text (`/401|unauthorized/`); an SDK wording change could require a one-line assertion tweak.
- `browser_condition` polling bound (`wall < 1500ms`) is a timing assertion inherited from the base smoke; it held across all runs (Node + Bun) with margin (≈630 ms observed).
