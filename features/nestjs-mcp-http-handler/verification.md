# Verification — NestJS / external-HTTP integration (`createMcpHttpHandler`)

**Fecha cierre:** 2026-09-19 · **HEAD:** `e69f925` (working tree limpio)
**Review adversarial:** jd-judge-a + jd-judge-b (ciega dual, ronda 1: APPROVE con 1 WARNING c/u → fix F1–F8 `7f8c88a` → re-juzgamiento: **APPROVE ambos, F1–F8 CONFIRMED_FIXED**, sin defectos nuevos).

## Gate final (ejecutado por el orquestador en HEAD)

| Capa | Comando | Resultado |
|---|---|---|
| Build | `npm run build` | ✅ |
| Unit | `npx vitest run` | ✅ **183 passed** / 10 skipped (0 fail) |
| Typecheck | `npm run typecheck` | ✅ (real: src + test + examples, solo el 09 excluido) |
| E2E real Chromium | `YATT_TS_E2E=1 npx vitest run test/e2e` | ✅ **8/8** (incluye el nuevo: handler con engine real montado en node:http) |
| Protocol smoke | `bun run test/e2e/protocol.smoke.mts` | ✅ **133/133** (node ✅ y bun ✅) — server interno sin cambios |
| Packaging | `node test/e2e/install.mjs` | ✅ ALL GREEN (incluye roundtrip initialize+ping del handler desde el tarball en consumer fresh) |
| YATT-in-app | — | No aplica: el feature no toca UI de app ni flujos navegables de usuario; la verificación de protocolo MCP (cliente SDK ↔ HTTP real) es el estándar equivalente, igual que en yatt-ts-npm-library. |

## Caso por caso

| ID | Estado | Evidencia |
|---|---|---|
| C31 | ✅ | `test/unit/express-mount.spec.ts` — express.json + handler en `/api/mcp`, cliente SDK StreamableHTTP full: session-id, tools requeridos, roundtrip persistido, DELETE→sessionCount 0 |
| C32 | ✅ | `test/unit/http-handler.spec.ts` — DELETE cierra suya; new-wins tras cliente muerto; id evictado → 400 "no valid MCP session" |
| C33 | ✅ | mismo spec — body pre-parseado (3er arg) vs raw vs inválido → 400/-32700; SDK valida Accept/Content-Type en ambas vías (verificado por jueces contra el SDK) |
| C34 | ✅ | mismo spec — 3 brazos: config.auth → bearer default 401/200 con aviso (F1); hook explícito gana (hookCalls=1); sin nada → abierto (GATE 1 Q2a) |
| C35 | ✅ | refactor T1 con suite preexistente intacta: server-bootstrap (bearer, F11, A-DELETE→B, stale-eviction), smoke 133/133, install — cero cambio observable |
| C36 | ✅ | `examples/09-nestjs-mcp-handler.ts` (controller+lifecycle+guard+enableShutdownHooks F2, scope Express-only F3, excluido del typecheck con nota) + README en/es sección embedding (jueces: consistente API↔docs) |
| C37 | ✅ | close() idempotente, post-close → sin sesiones (flag `closed` F5, registro único map-site verificado por juez); e2e F8: close()+shutdown() con engine real resuelve en ~4.5s bajo guard de 20s |
| C38 | ✅ | engine.enabled:false vía handler → ping `deferred`, test_create/test_list OK |
| C39 | ✅ | export desde raíz + install.mjs: consumer fresh importa `createMcpHttpHandler` del tarball, monta en node:http, initialize+ping OK |
| C40 | ✅ | CORS/OPTIONS pinneados (204+echo; sin ACAO en origen no permitido; fallthrough sin cors) y maxBodyBytes (413 JSON, default 2MB handler, built-in sin cap = paridad) — fixes F6/F7 con tests |

**❌ bloqueantes: 0 · ⚠️ diferidos: 0.**

## Extras de la revisión (fuera del alcance original, aprobados)

- **tsconfig.test.json realmente chequeaba solo `src/`** (heredaba `exclude` del padre en silencio) — al excluir el ejemplo 09 el typecheck real se activó y destapó **24 errores de tipado latentes** en tests, corregidos (`198c532`, solo tipos, cero cambios de runtime; todas las suites re-ejecutadas verdes después).
- `connectTransport` desaloja ante CUALQUIER error de connect (no solo "Already connected") — edge pre-existente del diseño new-wins, pinneado por tests F4: **aceptado**.
- POST con body vacío responde -32000 (no -32700) — cosmético pre-existente: **aceptado**.
- tmp dirs de los e2e gated no se borran (convención de los hermanos, OS tmpdir): **aceptado**.

## Cómo reproducir la verificación

```bash
cd /home/codicore/yatt-ts
npm install && npm run build
npx vitest run                                  # 183 unit (incl. handler + express mount)
YATT_TS_E2E=1 npx vitest run test/e2e           # 8/8 (Chromium real, incl. handler con engine)
bun run test/e2e/protocol.smoke.mts             # 133/133 server interno
node test/e2e/install.mjs                       # packaging + handler desde el tarball
```
