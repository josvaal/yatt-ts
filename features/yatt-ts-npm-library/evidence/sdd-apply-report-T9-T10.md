# SDD-Apply Report — T9 (browser tools + sessions toggle) + T10 (CLI)

**Date:** 2026-09-20 · **Executor:** sdd-apply · **Status:** completed (code + verification green; commits BLOCKED by harness, prepared commands below)

## Completed Tasks

- [x] **T9 — Browser tools (16) + sessions toggle** (C09, C10, C18; D5/D6/D7/D10/D11)
  - `src/mcp/tools/browser.ts` (new): faithful port of the base `mcp/src/tools/browser.ts` — same 16 tool names (`browser_open/close/status/preview/eval/run_step/condition/scroll/click_at`, `tab_open/list/switch/close`, `session_save/list/delete`), same zod schemas, same envelopes. Helpers preserved: `withImage` (PNG image content blocks), `serialize` (eval caps: depth 4 / 100 items / 8000 chars, English cap markers), eval timeout 8s, `run_step` returning evidence screenshot on ok AND failure (failure `.data` from the rejected JSON-RPC result), `browser_click_at` selector resolution (data-testid → id → CSS, engine-side), `browser_condition` polling semantics (engine-side, tool passes `timeoutMs`/`intervalMs` through).
  - **Sessions toggle (D7):** `session_save/list/delete` go through `ctx.sessionSink` instead of the engine's own storage. `sessions.persist: false` → `MemorySessionSink` (usable live via `session_list`, ZERO disk writes, wiped on close — C09); `persist: true` (default) → `PersistentSessionSink` DB + `sessions/<name>.json` mirror, same invariant as tests/reports (C10). `createSessionSink(config, store)` was already wired in `server.ts` — confirmed and now actually consumed by tools.
  - **Deliberate, documented, non-breaking protocol extensions in `src/engine/index.ts`:**
    1. `open` accepts optional inline `storageState` (parsed object; wins over `session`) so `browser_open` can restore MEMORY-sink sessions without any disk read. Persistent mode keeps passing the session name (engine reads its DB) exactly like the base.
    2. `session_save` accepts optional `persist: false`: the bridge returns the raw storage state (`state`, JSON string) and writes NOTHING — the host-side sink owns persistence in both modes.
  - **Policy metadata (D5):** only `session_save`/`session_delete` are `mutating: true`; the other 14 stay available in read-only mode (runtime browser control persists nothing in the library; screenshots/preview must remain available, D10). Choice documented in-code.
  - Engine-disabled surface: every engine-backed tool fails with the localized `engineRequired` message when `engine.enabled: false`; session_list/delete keep working (sink-only).
  - i18n: 16 tool descriptions + 19 arg descriptions + 2 messages added to `YattToolCopy`/`YattArgCopy`/`YattMessages` in both `en` (faithful translation of the base Spanish copy) and `es` (base copy verbatim).
  - Tests: `test/unit/browser-tools.spec.ts` — 16 tests through a REAL MCP server (registrar + policy middleware) with the engine pointed at the extended fake bridge: open/close/status, headless default ON (D10), inline-vs-name session restore per sink mode, run_step vars forwarding + engine-side interpolation + failure evidence, condition polling timing, eval caps, preview/scroll/click_at image blocks, tabs cycle, session round-trips in BOTH modes (memory mode asserts an fs snapshot before/after is unchanged: no new files, no DB row, no `sessions/` dir, engine received `persist:false`), readOnly denials with announced reason, deny error/hide behaviors, engine-disabled errors. `test/fixtures/fake-bridge.mjs` extended additively (browser surface + `__record` introspection; prior methods untouched).
  - `test/e2e/browser.smoke.mts` (YATT_TS_E2E=1 only, real Chromium, compiled dist/): open (headless default) → run_step type+click → eval → preview returns a real PNG block (magic bytes checked) → persistent session save → DB+mirror exist → browser restart with session restored (localStorage round-trip proves the restore) → close; toolbar NOT injected by default (D11) and injected with `browser.toolbarInjection: true`; PLUS a memory-mode section proving zero disk traces and the INLINE storageState restore path against the REAL engine (C09/D7).
- [x] **T10 — CLI `src/cli.ts`** (C30, C05, C06, C08 via CLI; D3, D4)
  - Real implementation (was a placeholder): `serve` (default command), flags `--http`, `--port N`, `--host H`, `--root PATH`, `--token T` (min 16 chars, else exit 2 with a clear message), `--token-hash HEX64`, `--read-only`, `--locale en|es`, `--no-engine`, `--allow-tool NAME` (repeatable), `--deny-tool NAME` (repeatable), `--deny-behavior error|hide`, `--version`, `--help`. Unknown flag/argument or malformed value → exit 2 naming the offending input. Flags map onto `YattConfig` (pure `parseCliArgs`/`cliConfig` exports) and boot `createYattServer`.
  - **Security (D4):** `--http` with no token/token-hash → `generateToken()` (32 crypto-random bytes, 64 hex) printed ONCE to stderr with the warning `generated ephemeral token, pass --token or --token-hash to fix it`; never printed or logged again (spec counts full-token occurrences on stderr == 1). Explicit-token diagnostics use `redact()`. stdio ignores auth (C06, base parity). App-db credentials are never accepted on argv (D22 — not even a flag).
  - Graceful lifecycle: SIGINT/SIGTERM → `handle.shutdown()` → exit; stdio stdin EOF → clean exit (the library itself never calls `process.exit`).
  - Bin emitted correctly: tsc preserves the `#!` shebang; exec bit restored after every build via `scripts/make-bin-executable.mjs` (wired into `npm run build`). Verified BOTH `node dist/cli.js --version` AND direct `./dist/cli.js --version`.
  - Tests: `test/unit/cli.spec.ts` — 6 spawn-based tests: `--version` (node + direct shebang exec), exit-2 arg validation (bad port, short token, unknown flag), serve --http without token → ephemeral 64-hex token on stderr → MCP StreamableHTTP client WITH token pings OK, WITHOUT token rejected, token leaked exactly once (C30/C05/C06/D4); `--read-only --deny-tool test_delete` → `test_create` denied with read-only reason, `test_delete` denied with policy reason, `test_list` works (C08/C07 via CLI); stdio serve → client ping OK (C04 via CLI). Tmp root per spawn; children SIGTERM'd (SIGKILL escalation) in afterEach.
- [x] Inventory parity updates: `test/unit/tools.spec.ts` ALL_TOOLS and `test/unit/runner.spec.ts` length assertion now reflect the full 35-tool catalog (C02) after the browser tools registration.

## Verification (all green, fresh run in order)

- `npm install` ✓
- `npm run build` ✓ (dist/ + .d.ts; bin shebang preserved + exec bit; both invocation modes verified)
- `npx vitest run` ✓ — **152 passed / 7 skipped** (5 e2e + 2 bun-only skipped by default)
- `npm run typecheck` ✓ (src + test projects)
- `YATT_TS_E2E=1 npx vitest run test/e2e` ✓ — **5/5 passed** with real Chromium: browser.smoke 3/3 (C18 full flow + persistent session restore + toolbar off/on + memory-mode inline restore) and engine.smoke 2/2 (T7 regression intact).

Test totals: 22 new tests (16 browser-tools + 6 CLI) + 5 e2e (3 new browser + 2 engine).

## Deviations from the task text

- None material. Notes: (1) `session_save` without an engine fails with the engine-required error (the live storage state can only come from the engine's browser) while `session_list`/`session_delete` remain engine-free — coherent with the data flow; (2) the fake bridge returns a VALID-base64 stand-in for failure screenshots because the MCP SDK validates image blocks as base64 (semantics unchanged); (3) `serialize` cap markers translated to English per repo convention (behavior identical).

## BLOCKED: git commits (same harness guard as the T7-T8 batch)

Every `git` invocation in this workspace is rejected by the harness ("session root /home/codicore is NOT a git repository") even with `workdir=/home/codicore/yatt-ts`. No staging was performed (tree left clean of partial staging). Prepared commands, in order:

```
cd /home/codicore/yatt-ts
git add src/engine/index.ts src/mcp/tools/browser.ts src/mcp/server.ts \
  src/i18n/index.ts src/i18n/en.ts src/i18n/es.ts \
  test/fixtures/fake-bridge.mjs test/unit/browser-tools.spec.ts test/e2e/browser.smoke.mts \
  test/unit/tools.spec.ts test/unit/runner.spec.ts
git commit -m "feat: browser tools with session persistence toggle (T9)"

git add src/cli.ts scripts/make-bin-executable.mjs package.json test/unit/cli.spec.ts
git commit -m "feat: yatt-ts CLI with secure defaults (T10)"
```

NOTE: if the T1–T8 prepared commits (see `sdd-apply-report-T7-T8.md`) have not been executed yet, the tree still carries those changes; the orchestrator should apply the earlier batches' staged commands first — the two commits above only cover T9/T10 files.

## Risks

- The engine-side `persist:false` / inline `storageState` extensions are in-package contract only; external consumers speaking the raw bridge protocol with an OLDER engine binary would get no `state` back from `session_save persist:false` — the tool fails with a clear error instead of silently writing (in-package engine makes this a non-issue).
- `browser_open` with a memory-sink session passes the parsed state inline; a corrupted state falls back to the name lookup (documented).
- The e2e memory-mode zero-disk assert checks the `sessions/` dir absence + mirror (not byte-level DB diffing); the DB-row absence is covered at unit level via `store.sessionGet`.
