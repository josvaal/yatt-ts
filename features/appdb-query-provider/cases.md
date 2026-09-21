# Cases — in-process app-DB query provider

**Legend — Fuente:** `pedido` / `descubierto-código` / `checklist`. **Tipo:** `unit` = spec · `e2e` = protocolo MCP real (cliente SDK ↔ server; sin UI de app, estándar de los features anteriores). **Estado completo con evidencia: `verification.md`.**

| ID | Caso | Fuente | Comportamiento esperado | Verificación | Tipo | Estado |
|---|---|---|---|---|---|---|
| C41 | Happy path: `appDb: { type: 'provider', provider }` + `db_query` SELECT → corre EN PROCESO vía el provider, devuelve {columns, rows, totalRows}; funciona con `engine.enabled:false` | pedido (R1/R2) | provider recibe el SQL verbatim; mapping correcto | `test/unit/appdb-provider.spec.ts` (espía + SDK client) | unit | ✅ |
| C42 | Guard read-only SIEMPRE activo: INSERT/UPDATE/DELETE/DROP → rechazo, provider NUNCA invocado; **multi-statement (`SELECT 1; DROP`) también rechazado en ambos modos** (fix F1, paridad con engine restaurada) | pedido (R3) + revisión | sin escape opt-out; fall-closed | spec (23 inputs adversariales trazados por el juez A: cero bypass) | unit | ✅ |
| C43 | Row cap: provider devuelve 500 → salida 200 + `totalRows: 500`; adapter corta ANTES de mapear (paridad de memoria con engine — fix F5) | descubierto-código | byte-identical al modo engine | spec C43 | unit | ✅ |
| C44 | Timeout: provider que cuelga → `dbQueryTimeout` a los 30s (fake timers), timer limpio, server sigue sirviendo; **abandono del query documentado** (fix F4) | descubierto-código | sin leaks de timers; docs en/es + ejemplo 10 | spec + README/example | unit | ✅ |
| C45 | Provider que lanza error → envelope limpio; server vivo; **retorno no-array → error de contrato claro, no TypeError crudo** (fix F2) | checklist#8 | sin crash, mensajes claros | spec | unit | ✅ |
| C46 | Frontera honesta: provider-only + `test_run` con db_assert/db_wait → aviso one-line al crear el server + error i18n ANTES del spawn; **incluye db_assert escondido tras run_flow (resolución por nombre, visited-Set contra ciclos, bound 25)** (fix F3) | pedido (R4) | el usuario entiende el porqué; differential fake-CLI prueba cero spawn | spec (directo, anidado, run_flow, ciclos) | unit | ✅ |
| C47 | Parámetro `db` por-llamada en modo provider → error i18n claro sin invocar al provider | descubierto-código | sin ambigüedad silenciosa | spec (ambos locales) | unit | ✅ |
| C48 | Config estricta: provider no-función / faltante / claves desconocidas → ConfigError nombrando `config.appDb.provider`; async y sync aceptados por referencia | checklist#4 | C13 intacto; unión discriminada convive con sqlite/postgres | `test/unit/config.spec.ts` (+5) | unit | ✅ |
| C49 | Ejemplo NestJS+TypeORM (`examples/10-typeorm-provider.ts`) + README en/es con provider, recomendación de rol read-only y notas de límite/timeout | pedido (contexto TypeORM) | receta doc-grade excluida del typecheck con header | docs + jueces (consistencia API↔docs) | unit | ✅ |
| C50 | Publicabilidad: `AppDbProvider`/`AppDbQueryFn` exportados; install.mjs monta server con provider (función JS desde el tarball en consumer fresh) y completa db_query con guard | pedido | tarball funciona con provider | `test/e2e/install.mjs` extendido | unit | ✅ |
| C51 | Paridad de modos existentes: sqlite/postgres por env al hijo SIN cambios; `serializeAppDb` rechaza provider defensivamente; `buildRunEnv` omite `YATT_APP_DB_JSON` en modo provider; smoke 133/133 y suite completa verdes | checklist#3 | cero regresión | regresión completa + specs de serialize/buildRunEnv | unit | ✅ |

## Cobertura pedido → casos

- R1 (provider propio): C41, C48, C49, C50
- R2 (in-proceso, sin engine): C41, C45, C51
- R3 (seguridad preservada): C42, C43, C44, C47
- R4 (frontera honesta): C46, C51

**Resultado GATE 2: 11/11 casos ✅ (C41–C51), 0 ❌, 0 ⚠️ diferidos.** Aceptados no-bloqueantes documentados en `verification.md`.
