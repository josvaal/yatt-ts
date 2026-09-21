# Plan — NestJS / external-HTTP integration (`createMcpHttpHandler`)

**Fecha:** 2026-09-19 · Cambio acotado (~300-400 líneas + tests). Decisiones GATE 1: D-Q1 envuelve YattServer existente · D-Q2 sin auth default + hook `authenticate` · D-Q3 receta Nest no-compilada + e2e express · D-Q4 CORS opt-in.

**Arquitectura:** extraer el núcleo de sesión HTTP de `startHttp()` a `src/mcp/http-handler.ts` (única fuente de verdad, dos consumidores: el server interno y el handler público exportado).

| # | Tarea | Cubre | Test |
|---|---|---|---|
| T1 | Extraer núcleo: `src/mcp/http-handler.ts` con `createMcpSessionRouter({ server, log }, { authenticate?, cors? })` → ruteo POST/GET/DELETE/OPTIONS, Map de sesiones por id, evicción new-wins, `readJsonBody` (con body opcional pre-parseado), `noSession` 400. `startHttp()` delega su request-handler en el router pasando su bearer-verifier como `authenticate` y sus origins como `cors` — **cero cambio de comportamiento observable** | C35 | suite HTTP existente COMPLETA verde (bearer 401/200, warning F11, A-DELETE→B, stale-eviction, smoke 133/133) |
| T2 | API pública `createMcpHttpHandler(yatt: YattServer, options?: { authenticate?, cors?, sessionIdGenerator? })` → `{ handle(req, res, body?), sessionCount(), close() }`. No requiere `yatt.start()` (el handler maneja los `server.connect` por sesión; documentar que NO debe llamarse start() en este modo). Export en `src/index.ts` | C31, C34, C39 | tests de T3 |
| T3 | Specs unitarias del handler (HTTP real, sin Chromium, siempre-on): ciclo de sesiones (DELETE cierra suya; muerto-sin-DELETE → new-wins; session-id evictado → 400) · body pre-parseado vs raw vs JSON inválido (400 -32700) · hook authenticate (true/false/throw) · close() limpia todo y shutdown() posterior completo · engine.enabled:false → ping deferred · exports públicos | C32, C33, C34, C37, C38, C39 | `test/unit/http-handler.spec.ts` |
| T4 | E2E de montaje en framework real: express (devDep + @types) con `express.json()`, handler montado en **ruta anidada** `/api/mcp`; cliente SDK (StreamableHTTP) inicializa, `tools/list`, `test_create`+`test_list` roundtrip | C31 | `test/unit/express-mount.spec.ts` (siempre-on, sin Chromium) |
| T5 | Documentación: `examples/09-nestjs-mcp-handler.ts` (receta Nest completa: controller @Post/@Get/@Delete('mcp'), OnModuleInit/Destroy, guards, excluida del typecheck con nota en header) + README.md/README.es.md sección "Embed in your HTTP framework (NestJS)" + `test/e2e/install.mjs` actualizado para importar y ejercitar `createMcpHttpHandler` (C39 en el pack) | C36, C39 | tsc de examples (los demás) + install.mjs verde |

**Cobertura:** C31→T4 · C32→T3 · C33→T3 · C34→T2+T3 · C35→T1 · C36→T5 · C37→T3 · C38→T3 · C39→T2+T3+T5. Todo caso con ≥1 tarea y ≥1 test.

**Orden:** T1 (RED no aplica: la suite existente es la prueba de paridad) → T2+T3 (tests primero donde capturen comportamiento nuevo) → T4 → T5 → GATE 2.

**Verificación por capa:** unit specs (handler aislado) discriminan qué parte rompe; express-mount e2e prueba el contrato de framework real; smoke interno 133/133 prueba que el server standalone no cambió; install.mjs prueba al consumidor final.
