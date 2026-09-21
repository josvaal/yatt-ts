# Cases — NestJS / external-HTTP integration (`createMcpHttpHandler`)

**Legend — Fuente:** `pedido` / `descubierto-código` / `checklist`. **Tipo:** `unit` = spec de unidad · `e2e` = test de protocolo MCP (cliente SDK ↔ handler, con HTTP real; este feature no tiene UI de app → el estándar E2E-YATT-in-app no aplica y lo reemplaza el smoke de protocolo, igual que en yatt-ts-npm-library). **Estado completo con evidencia: `verification.md`.**

| ID | Caso | Fuente | Comportamiento esperado | Verificación | Tipo | Estado |
|---|---|---|---|---|---|---|
| C31 | Happy path: handler montado EXTERNAMENTE (ruta anidada real `/api/mcp`) — cliente MCP inicializa y trabaja | pedido (R1/R3) | POST initialize → 200 con session-id; tools/list rutea; `test_create`+`test_list` roundtrip contra el mismo server embebido | express (devDep, stand-in del adapter de Nest) + cliente SDK full — `test/unit/express-mount.spec.ts` | e2e | ✅ |
| C32 | Ciclo de sesiones = paridad con el server interno: DELETE cierra su sesión; cliente muerto sin DELETE → siguiente initialize entra (new-wins, D23); session-id evictado → 400 "no valid MCP session" | descubierto-código (F4) | las tres transiciones sobre el handler externo | `test/unit/http-handler.spec.ts` | unit | ✅ |
| C33 | Body: handler acepta body PRE-PARSEADO (3er arg — camino Nest) Y raw por stream (standalone); JSON inválido → 400 -32700 | descubierto-código | ambas vías responden igual; parse error claro | `test/unit/http-handler.spec.ts` | unit | ✅ |
| C34 | Auth del host: sin hook ni config → abierto (guards del host mandan); `authenticate` false → 401 sin tocar MCP; throw → 500 controlado; **config.auth del server → bearer default con aviso (fix F1)** | pedido (R4) + checklist#6 | hook optativo; sin leaks de token | `test/unit/http-handler.spec.ts` (3 brazos diferencial) | unit | ✅ |
| C35 | Refactor sin regresión: server interno (`http.enabled`) idéntico tras extraer el núcleo compartido | checklist#3 | TODOS los tests HTTP previos verdes: bearer 401/200, warning F11, A-DELETE→B, stale-eviction, smoke 133/133, install | suite preexistente = red de seguridad | unit+e2e | ✅ |
| C36 | Ejemplo NestJS oficial + receta README (en+es), con `enableShutdownHooks()` (fix F2) y scope Express adapter explícito (fix F3) | pedido (R2) | `examples/09-nestjs-mcp-handler.ts` documentado, excluido del typecheck con nota; README con sección de embedding | verificación de docs + header | unit | ✅ |
| C37 | Cierre limpio: `close()` cierra todas las sesiones; `yatt.shutdown()` posterior completo sin handles colgados; initialize en vuelo durante close no re-registra (fix F5: flag `closed`) | checklist#8 | 0 sesiones tras close; shutdown no cuelga (guard 20s en e2e con engine real — fix F8) | `test/unit/http-handler.spec.ts` + e2e gated | unit | ✅ |
| C38 | Modo embedder liviano: `engine.enabled:false` a través del handler — ping `deferred`, tools de datos funcionan | checklist | server sin Chromium por la ruta del host | `test/unit/http-handler.spec.ts` | unit | ✅ |
| C39 | API pública exportada desde la raíz y presente en el pack; consumer fresh la monta sobre node:http y completa initialize+ping | pedido (R1) | `import { createMcpHttpHandler } from 'yatt-ts'` desde el tarball | `test/e2e/install.mjs` (extendido) | unit | ✅ |
| C40 | Coverage extra de la revisión: CORS/OPTIONS pinneados (preflight 204 + echo; origen no permitido sin ACAO; sin cors → fallthrough sin ACAO) y cap de body (`maxBodyBytes` default 2MB en handler, 413 JSON; built-in server sin cap = paridad) — fixes F6/F7 | descubierto-revisión | exactamente el comportamiento del router, pinneado en tests | `test/unit/http-handler.spec.ts` | unit | ✅ |

## Cobertura pedido → casos

- R1 (helper mountable): C31, C32, C33, C34, C37, C39, C40
- R2 (ejemplo NestJS): C36
- R3 (e2e en ruta real de framework): C31, C35
- R4 (backend empresarial: host controla HTTP/auth): C34, C36, C38

**Resultado GATE 2: 10/10 casos ✅ (C31–C40), 0 ❌, 0 ⚠️ diferidos.** Limitaciones aceptadas documentadas en `verification.md`.
