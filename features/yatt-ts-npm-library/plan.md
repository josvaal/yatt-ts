# Plan — yatt-ts npm library

**Fecha:** 2026-09-19 · **Presupuesto:** cambio grande (≫400 líneas — consentido por el usuario: completitud sobre rapidez; review adversarial dual obligatoria en GATE 2).

**Arquitectura objetivo:** paquete npm `yatt-ts@0.1.0` ESM + tipos, dual-runtime Node≥22.5/Bun. Layout: `src/config/` (schema+defaults+paths) · `src/store/` (SQLite dual-runtime + mirrors + retention) · `src/security/` (tokens + policy) · `src/mcp/` (bootstrap + 35 tools + policy middleware + resources + prompts i18n) · `src/engine/` (sidecar Playwright vendido, config inyectable, headless-first) · `src/cli.ts` (bin `yatt-ts`) · `src/index.ts` (API pública) · `test/unit/` (vitest) + `test/e2e/smoke.ts` (puerto del smoke del repo base) + `examples/`.

Regla transversal: **invariante del repo base** — la BD es fuente de verdad y los archivos son espejo; se escriben juntos. **D10:** headless por defecto, capturas siempre disponibles. **D11:** toolbar OFF por defecto. **D22:** credenciales de app-db jamás en argv.

| # | Tarea | Cubre | Test |
|---|---|---|---|
| T1 | Scaffold: git init, package.json (name yatt-ts, 0.1.0, ESM, engines node≥22.5, bin, exports map, files), tsconfig (NodeNext+declaration), vitest, LICENSE MIT, .gitignore, stubs, commit inicial | C24 | `npm run build` emite dist+.d.ts; `npx vitest run` verde |
| T2 | `src/config/`: zod schema estricto (rechaza claves desconocidas, error nombra la clave), defaults = comportamiento actual + headless ON + toolbar OFF + locale en, resolución de paths por artefacto | C11, C13, C14, C28 | `test/unit/config.spec.ts` |
| T3 | `src/store/`: adaptador dual-runtime (bun:sqlite→node:sqlite), Store portado (dual-write DB+espejo, sanitizeName, WAL, busy_timeout), helpers de retention (edad/cantidad) | C23, C10, C29 | `test/unit/store.spec.ts` |
| T4 | `src/security/`: generateToken (crypto 32B), verificación timing-safe (sha256, acepta plano o hash en config, jamás loguea), policy evaluator (readOnly + allow/deny + denyBehavior error/hide) | C06, C07, C08 | `test/unit/security.spec.ts` |
| T5 | `src/mcp/server.ts`: createYattServer(config) → stdio + HTTP (port/host, bearer auth con middleware del T4), recursos (schema/tests/reports), prompts + SCHEMA_DOC i18n (en/es), shutdown limpio | C01, C03, C04, C05, C28 | `test/unit/server-bootstrap.spec.ts` |
| T6 | Port tools sin engine: tests(9) + reports(3) + meta(4) + db(1) con app-db por objeto rico TypeORM-like (sqlite\|postgres, ssl, password como función; credenciales por env JSON al engine, nunca argv); policy middleware sobre TODOS los tools | C02, C07, C08, C21, C25, C26 | `test/unit/tools.spec.ts` |
| T7 | `src/engine/`: vendoring del sidecar con config inyectable (ROOT ya no es env-at-import, defaults de browser del T2, toolbar OFF default, headless ON default), auto-install chromium, runtime auto bun→node + override, crash→respawn, serialización de llamadas | C12, C15, C16, C17, C18, C22, C27 | `test/unit/engine.spec.ts` + engine smoke reducido |
| T8 | Port runner: `test_run`/`test_run_dataset` vía CLI one-shot con MISMA resolución de runtime (fix bun-hardcode), saveReport, overrides/env/url/timeout, persistencia con hooks de retention | C15, C19, C20 | `test/unit/runner.spec.ts` |
| T9 | Browser tools (16) + toggle de sesiones: persist:false → store en memoria (usable en vivo, cero escritura, wiped al cerrar); persist:true = actual | C09, C10, C18 | `test/unit/sessions.spec.ts` |
| T10 | CLI `src/cli.ts` (bin): `serve` con flags (--http/--port/--host/--root/--token/--read-only/--locale), `--version`, token autogenerado si --http sin token | C30, C05, C06 | `test/unit/cli.spec.ts` |
| T11 | E2E smoke `test/e2e/smoke.ts`: puerto del smoke base (~48 checks) + nuevos: auth, readOnly, deny-avisa, sesiones efímeras, toolbar ausente, headless default, retention, CLI boot, es/i18n; parametrizado por runtime (node\|bun) | C01–C21, C25–C30 | smoke verde en node y bun |
| T12 | Docs & examples: README en + README.es, examples/ (recetas: zero-config, http+token, read-only, deny-list, sesiones efímeras, paths custom, retention, app-db postgres objeto), pulido de metadata npm | C24 | tsc de examples/ sin errores |
| T13 | Empaquetado probado: `npm pack` → install en consumer temporal fresh → ping OK (node) + smoke bun | C24, C23, C01 | `test/e2e/install.mjs` verde |

**Cobertura:** todo caso tiene ≥1 tarea (C01–C30 ↦ T1–T13; C22/C27 en T7, C29 en T3+T8+T11, C12 en T7+T11).

**Orden de ejecución:** T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → GATE 2.

**Verificación por capa:** unit specs discriminan qué módulo rompe (vitest, Node primario); smoke E2E prueba punta a punta por protocolo MCP (el rol de "E2E YATT" aquí lo juega el propio smoke: la librería ES YATT); install-test prueba al consumidor real. Sin UI propia no hay screenshots antes/después de app; la evidencia son reportes de smoke + install-test + `npm pack`.
