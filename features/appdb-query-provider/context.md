# Context — in-process app-DB query provider

**Date:** 2026-09-19 · Base: HEAD `8ec24da` (3 features entregados: librería, http-handler, docs release).

## Relevant code (verified today)

| Archivo | Hecho clave para este feature |
|---|---|
| `src/mcp/tools/db.ts` | **El guard vive en la CAPA DEL TOOL**: `READ_ONLY_RE = /^\s*(select\|with\|explain\|pragma)\b/i`, `ROW_CAP = 200`, `DB_QUERY_TIMEOUT_MS = 30000`; llama `ctx.queryAppDb({ sql, db })`. Un provider in-proceso hereda guard/timeout/cap SIN tocar el engine. |
| `src/mcp/ctx.ts` | `queryAppDb: QueryAppDb \| null` — ya es un punto de inyección; hoy lo cablea el sidecar-client (JSON-RPC `db_query` al hijo). |
| `src/config/schema.ts` (AppDb*) | `z.discriminatedUnion('type', [sqlite{type,file}, postgres{type,host,port(5432),user,password xor passwordProvider,database,ssl?}])`, strictObject. Nuevo brazo `provider` necesita literal propio para entrar a la union. |
| `src/engine/options.ts` | `serializeAppDb(appDb)` → `YATT_APP_DB_JSON` (resuelve passwordProvider antes de serializar). Brazo `provider` NO es serializable → no debe viajar al hijo. |
| `src/engine/appdb.ts` | Guard duplicado del lado engine (`BEGIN READ ONLY` + regex) para los pasos `db_assert`/`db_wait` de `test_run` (proceso hijo). **Esos pasos jamás podrán usar un provider del host** — frontera de proceso. |
| `src/mcp/server.ts` | Wiring: `ctx.queryAppDb` hoy = sidecar. Cablear provider = asignar adapter in-proceso. `engine.enabled:false` ya soportado (ping deferred). |
| `src/i18n/{en,es}.ts` | Mensajes user-facing (dbEngineRequired, dbReadOnly, dbQueryTimeout...) — el brazo provider necesita su mensaje de scope (db_assert en test_run). |
| `test/e2e/install.mjs` | Consumer fresh — el provider es una función JS: se puede probar desde el tarball (a diferencia de credenciales). |

## Qué existe vs qué falta

**Existe:** punto de inyección `ctx.queryAppDb`; guard/timeout/cap en la capa tool (aplican a cualquier implementación); unión discriminada de appDb con dos brazos; modo engine-less verificado (C38 del feature anterior); serializeAppDb con manejo de funciones (passwordProvider).

**Falta:** brazo `appDb: { type: 'provider', provider: fn }` en el schema (con validación de que sea función); wiring del adapter in-proceso en server.ts (provider → ctx.queryAppDb, con env NO enviado al hijo); contrato de retorno del provider (rows array) + mapeo a {columns, rows, totalRows}; regla para el parámetro `db` por-llamada en modo provider (sin sentido → error claro); aviso/limitación documentada para db_assert/db_wait de test_run; i18n de mensajes nuevos; ejemplo NestJS+TypeORM (`examples/10-typeorm-provider.ts`, doc-grade como el 09); tests (unit + express-style real) + install-proof.

## Convenciones aplicables

- Imports `.js` explícitos, copy en inglés, commits convencionales sin atribución, tests unitarios siempre-on sin Chromium, e2e Chromium gated `YATT_TS_E2E=1`, `features/` como registro, invariante BD+espejo intocable, strict config (C13), i18n en/es para todo mensaje user-facing.
- Sin UI de app → verificación por protocolo MCP (cliente SDK), estándar de los features anteriores; YATT-in-app no aplica.

## Exploración visual

No aplica (librería). Evidencia = suites de tests + reportes en `evidence/`.
