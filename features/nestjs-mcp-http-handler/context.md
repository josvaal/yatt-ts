# Context — NestJS / external-HTTP integration

**Date:** 2026-09-19 · Base: yatt-ts HEAD `18610c0` (feature yatt-ts-npm-library completo, 172 tests)

## Relevant code

| Archivo | Rol para este feature |
|---|---|
| `src/mcp/server.ts` (140-430) | Toda la maquinaria HTTP de sesión vive INLINE dentro de `startHttp()`: Map `httpTransports` por session-id, `connectTransport` con evicción new-wins (una sola sesión viva, D23), `readJsonBody`, `sessionOf`, `noSession` (400 JSON), CORS echo por lista, bearer auth (C06), ruteo POST/GET/DELETE/OPTIONS, catch 500. **Este feature extrae ese núcleo a un módulo reutilizable.** |
| `src/mcp/server.ts` (43-57) | `YattServer { server: McpServer; ctx; start(transport?); shutdown() }` — `start(transport)` ya entra en "embedded mode" (conecta UN transporte fijo y se saltea handlers/signals). El helper nuevo compone con este handle. |
| SDK `streamableHttp.js` | `new StreamableHTTPServerTransport({ sessionIdGenerator, onsessioninitialized })`; `handleRequest(req, res, parsedBody?)` acepta **body ya parseado** (3er arg, optativo); `transport.close()` limpia `Protocol._transport` → reconexión legal (verificado en revisión F4). |
| `src/index.ts` | exports públicos — el helper se agrega acá. |
| `examples/01-08` | Convención: archivos autocontenidos con header-comentario, import relativos `../src/index.js`, typecheckeados vía `tsconfig.test.json` (include: src+test+examples). |
| `package.json` | Sin express ni @nestjs hoy. `@modelcontextprotocol/sdk ^1.30.0` (prod). |
| `test/unit/server-bootstrap.spec.ts` | Patrón real-HTTP con fetch + cliente SDK; cubre bearer 401/200, A-DELETE→B, stale-eviction — red de seguridad para el refactor. |
| `test/e2e/protocol.smoke.mts` | 133 checks: HTTP+bearer acepta/rechaza, sesiones efímeras/persistentes — paridad obligatoria post-refactor. |

## Qué existe vs qué falta

**Existe:** modo embedded `start(transport)` (pero conecta UN solo transporte fijo — no resuelve sesiones múltiples ni ruteo POST/GET/DELETE); núcleo de sesión HTTP completo pero privado dentro de `startHttp()`; auth bearer + CORS acoplados al `node:http` server propio; ejemplo `02-http-with-token.ts` (server propio, no montable).

**Falta:** `createMcpHttpHandler()` exportado que gestione el Map de sesiones + evicción + ruteo y exponga `handle(req, res, body?)`; soporte de body pre-parseado (framework) y raw (standalone); hook de auth reemplazable (los guards del host mandan); ejemplo NestJS; e2e que monte el handler en una ruta anidada de un framework real.

## Convenciones aplicables

- Del feature anterior (memoria del repo): imports `.js` explícitos, copy en inglés, commits convencionales sin atribución, `features/` como registro, tests unitarios rápidos en `test/unit/` + e2e gated `YATT_TS_E2E=1`, invariante BD+espejo intocable.
- `CLAUDE.md` del repo base (referencia): la BD es fuente de verdad y los archivos espejo se escriben juntos — el helper no toca persistencia.
- No UI de app en este feature → verificación por protocolo MCP (cliente SDK ↔ handler), mismo estándar que el feature anterior; YATT-in-app no aplica.

## Exploración visual

No aplica (librería HTTP; no hay pantallas). Evidencia = suites de tests + reportes de corrida en `evidence/`.
