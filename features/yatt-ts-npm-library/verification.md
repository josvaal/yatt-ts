# Verification — yatt-ts npm library

**Fecha cierre:** 2026-09-19 · **HEAD:** `8f77108` (working tree limpio, 16 commits)
**Re-review adversarial:** jd-judge-a + jd-judge-b (ciega dual, 2 rondas: hallazgos → fix F1–F12 → re-juzgamiento **APPROVE** por ambos) + ronda T14 de endurecimiento que cerró los huecos de cobertura marcados por los jueces.

## Gate final (ejecutado por el orquestador en HEAD)

| Capa | Comando | Resultado |
|---|---|---|
| Build | `npm run build` | ✅ dist + .d.ts + bin ejecutable |
| Unit | `npx vitest run` | ✅ **172 passed** / 9 skipped (0 fail) |
| Typecheck | `npm run typecheck` | ✅ src + test + examples |
| E2E real Chromium | `YATT_TS_E2E=1 npx vitest run test/e2e` | ✅ **7/7** (engine 2, browser 3, protocol smoke 1, install 1) |
| Protocol smoke | `bun run test/e2e/protocol.smoke.mts` | ✅ **133/133 checks** (node ✅ y bun ✅) |
| Packaging | `node test/e2e/install.mjs` | ✅ ALL GREEN (npm pack → consumers node+bun fresh) |
| fastloop_verify | — | ⚠️ no indexa yatt-ts (repo creado tras el registro del workspace del harness); la gate real corrió por bash, en verde |

## Caso por caso

| ID | Estado | Evidencia (test → archivo → reporte) |
|---|---|---|
| C01 | ✅ | protocol smoke happy path (create→list→persist+mirrors) · `test/e2e/protocol.smoke.mts` |
| C02 | ✅ | inventario 35/35 tools · `test/unit/tools.spec.ts` + smoke |
| C03 | ✅ | recursos legibles; prompts exact-5 por locale (S3) · smoke + `server-bootstrap.spec.ts` (es exact) |
| C04 | ✅ | stdio roundtrip vía `node dist/cli.js` · smoke |
| C05 | ✅ | HTTP port/host configurables · smoke HTTP + `cli.spec.ts` |
| C06 | ✅ | bearer 401/200 real fetch; timing-safe; token jamás logueado (redact) · smoke + `security.spec.ts` (23) |
| C07 | ✅ | deny anuncia razón; `hide` lo omite del listado · smoke + specs |
| C08 | ✅ | readOnly: mutantes rechazadas, lecturas OK; **F7**: export write:true y capture_screenshot también gated · smoke + specs |
| C09 | ✅ | `persist:false` → usable en vivo, CERO disco, wiped al cerrar (`clear()` en shutdown — F6) · smoke + `server-bootstrap.spec.ts:239-255` |
| C10 | ✅ | persist:true = DB+file, restore de sesión con browser restart · `browser.smoke.mts` |
| C11 | ✅ | **F1**: paths db/baselines/sessions honrados por engine + host Store; e2e prueba SAME-db con layout custom · smoke sección 10b |
| C12 | ✅ | cero entradas fuera del root tras shutdown (S1) · smoke `entriesOutsideRoot` |
| C13 | ✅ | ConfigError nombra la clave; unknown-keys anidados · `config.spec.ts` (28) + smoke |
| C14 | ✅ | defaults = headless ON, toolbar OFF, port 3191, viewport 1280×800, locale en · `config.spec.ts` |
| C15 | ✅ | matriz auto/bun/node/binario en SidecarClient Y runner (fix bun-hardcode) · `engine.spec.ts` |
| C16 | ✅ | **F3**: runner recibe YATT_ENGINE_JSON (viewport 1112 llega al engine, e2e); **F5**: defaultHeadless alcanzable; toolbar/cdp por config · `runner.spec.ts` + smoke |
| C17 | ✅ | toolbar ausente por defecto / presente al activar · `engine.smoke.mts` + browser smoke |
| C18 | ✅ | open→run_step(type+click)→preview PNG→close en headless real · `browser.smoke.mts` (3/3) |
| C19 | ✅ | test_run reporte DB+espejo, saveReport:false, report_delete · smoke run section |
| C20 | ✅ | dataset N filas = N corridas · smoke |
| C21 | ✅ | guard read-only, ROW_CAP 200; **F2**: db_assert dentro de test_run contra appDb sqlite efímera (S2) · smoke 572-602 |
| C22 | ✅ | crash→failAll→respawn transparente · `engine.spec.ts` (fake bridge) |
| C23 | ✅ | dual-runtime: node:sqlite + bun:sqlite probados · `store.bun.spec.ts` + smoke 133/133 ×2 + consumer bun |
| C24 | ✅ | pack contiene dist/engine, sin src/test; consumers fresh npm+bun con ping OK · `install.mjs` ALL GREEN |
| C25 | ✅ | baselines list/get PNG; visibilidad host↔engine bajo layout custom (F1 e2e) · smoke meta |
| C26 | ✅ | export playwright/jest/invalid a exports dir · smoke |
| C27 | ✅ | serialización 1-a-1 del engine (D23) · `engine.spec.ts` |
| C28 | ✅ | `createYattServer()` sin args levanta · smoke |
| C29 | ✅ | retention no-op por defecto; política borra por edad/cantidad · `store.spec.ts` + smoke |
| C30 | ✅ | CLI: flags, token efímero impreso una vez, cliente conecta, readOnly vía CLI · `cli.spec.ts` (6) + smoke |

**❌ bloqueantes: 0 · ⚠️ diferidos: 0 casos.**

## Limitaciones conocidas (no bloqueantes, aceptadas con rationale)

1. **HTTP multi-sesión comparte engine/browser/sink** (WARNING juez B): bajo D23 el usuario eligió "de a una"; `browser_open` cierra el browser previo y el documento README lo declara. Riesgo residual solo si alguien conecta dos clientes secuencialmente esperando aislamiento.
2. ~~Rama de evicción stale-transport sin test dedicado~~ **CERRADA (T14, G1)**: test A-sin-DELETE → B-inicializa con new-wins eviction.
3. ~~F8/F10/F11 sin test dedicado~~ **CERRADA (T14, G3+G4)**: exit code 2 del engine CLI con YATT_APP_DB_JSON inválido; warning único sin auth + silencio con `logging.silent`; paridad byte-a-byte del mensaje requireAppDb.
4. ~~Rama `elseChildren` del scan F7 sin test~~ **CERRADA (T14, G2)**: capture_screenshot oculto en `if.elseChildren` rechazado con razón de policy + control no-readOnly llega al bridge.
5. **bun×zod×vitest transform issue**: `vitest` bajo binario bun falla en specs que importan config (issue del loader, pre-existente a T5, documentado); el smoke standalone corre compiled `dist/` y pasa 133/133 — la compatibilidad bun real está probada por esa vía y por el consumer bun del install-proof.
6. `fastloop_verify` no indexa el repo (limitación del harness, gate real corrido por bash).

## Cómo reproducir la verificación

```bash
cd /home/codicore/yatt-ts
npm install && npm run build
npx vitest run                                  # 167 unit
YATT_TS_E2E=1 npx vitest run test/e2e           # 7/7 (Chromium real)
bun run test/e2e/protocol.smoke.mts             # 133/133 checks
node test/e2e/install.mjs                       # packaging proof
```
