# Cases — yatt-ts npm library

**Legend — Fuente:** `pedido` / `pedido-gate1` (decisión del GATE 1) / `descubierto-código` / `checklist`. **Tipo:** `unit` = spec de unidad · `e2e` = test de protocolo MCP punta a punta (client SDK ↔ server, con Chromium real cuando aplica; reemplaza al E2E YATT-in-app: aquí la librería ES la herramienta bajo test). **Estado** se completa en GATE 2.

| ID | Caso | Fuente | Comportamiento esperado | Verificación | Tipo | Estado |
|---|---|---|---|---|---|---|
| C01 | Happy path E2E: consumidor instala `yatt-ts`, levanta server (stdio) y conecta un cliente MCP | pedido+checklist | `ping` responde; `test_create`+`test_list` persisten en root configurado; invariante DB+mirror se cumple | smoke portado del `mcp/test/smoke.ts` | e2e | |
| C02 | Paridad de catálogo: los 35 tools actuales existen con mismos nombres/args | pedido | inventario de tools ≥ catálogo actual; nombres requeridos presentes | smoke: tool inventory | e2e | |
| C03 | Paridad de recursos y prompts: `yatt://schema`, `yatt://tests/{name}`, `yatt://reports/{name}`, 5 prompts | pedido | recursos legibles; ≥5 prompts listados; en `es` los prompts salen en español | smoke: resources+prompts (ambos locales) | e2e | |
| C04 | Transporte stdio por defecto funciona (comportamiento actual) | pedido | server arranca en stdio sin flags extra | smoke base | e2e | |
| C05 | Transporte HTTP configurable: puerto y bind configurables | pedido (configurable) | `http.port`/`http.host` respetados; server responde en la dirección elegida | smoke HTTP section | e2e | |
| C06 | Acceso: auth por token en HTTP — request sin token válido rechazado | pedido-gate1 (D4) | token generado con aleatoriedad criptográfica; comparación timing-safe; config acepta token plano o su hash sha256; el token jamás sale en logs; sin token → rechazo; con token → pasa; stdio no exige token | smoke: auth on/off + spec timing-safe | e2e | |
| C07 | Permisos: deny/allowlist de tools — herramienta bloqueada AVISA, no desaparece (D5+D6) | pedido-gate1 | tool bloqueada sigue registrada pero responde error de permiso claro; `denyBehavior:'hide'` la omite del listado; ambas listas + readOnly combinables | smoke: denied tool + spec de policy | e2e | |
| C08 | Restricciones: modo read-only global (D5) | pedido-gate1 | `readOnly: true` → tools mutantes (`test_create/update/delete`, `report_delete`, `session_delete`, `test_delete`) rechazan con error claro; lecturas OK | smoke: readOnly | e2e | |
| C09 | Sesiones sin persistencia (D7): `sessions.persist:false` → `session_save` funciona en memoria, nada toca DB/archivos; tras cerrar el server no queda rastro | pedido (sesiones/sin sesiones guardadas) | `sessions` table vacía + sin `sessions/*.json`; `session_list` en vivo sí la muestra; al cerrar, cero trazas | smoke: ephemeral sessions | e2e | |
| C10 | Sesiones con persistencia (default) = comportamiento actual (DB + mirror) | descubierto-código | parity con sidecar actual: save→list→delete con DB y archivo | smoke: session section | e2e | |
| C11 | Paths por artefacto configurables (db, tests, reports, exports, baselines) | pedido-gate1 (D8/D21) | cada artefacto cae en el dir configurado; defaults = layout actual relativo al root elegido | spec de paths + smoke | unit | |
| C12 | Modo efímero total: root en tmp — cero trazas fuera del root elegido | descubierto-código | tras cierre, fuera del tmp no queda nada | smoke cleanup assert | e2e | |
| C13 | Config inválida: clave desconocida/tipo mal/path imposible → boot falla RÁPIDO con error que nombra la clave | checklist#4 | error temprano y claro, nunca falla silencioso a mitad de run | spec de validación de config | unit | |
| C14 | Config parcial: claves omitidas toman defaults; zero-config `{}` levanta server (C28) | checklist#3 | defaults = headless ON, toolbar OFF, puerto 3191, viewport 1280×800, timeouts actuales, locale en | spec de defaults | unit | |
| C15 | Selección de runtime del engine: auto bun→node preservada + override explícito | descubierto-código | config `engine.runtime: 'bun'\|'node'\|'auto'\|binario` respetada en SidecarClient Y en spawnCli (hoy bun-hardcoded: bug corregido en la librería) | spec de resolución de comando | unit | |
| C16 | Defaults de browser configurables: headless ON por defecto (full headless con capturas, D10), toolbar OFF por defecto (D11), viewport, timeouts, cdp-sync | pedido-gate1 | config respetada en `browser_open` y en runner headless; capturas/preview funcionan en headless | spec de opciones + smoke browser | unit | |
| C17 | Toolbar injection OFF → HELPER_JS no inyectado en páginas; ON = comportamiento actual | pedido-gate1 (D11) | eval confirma ausencia del script YATT cuando está apagada | smoke: no-toolbar | e2e | |
| C18 | Flujo browser completo headless: open→run_step(type+click)→preview(PNG)→close | pedido (funcionalidad actual + D10) | parity con smoke actual de browser, en headless, con evidencia PNG | smoke browser section | e2e | |
| C19 | Runner headless + reportes: `test_run` guarda reporte (DB+mirror), `report_get` lo lee; `saveReport:false` no persiste | pedido | parity con smoke actual de run + report_delete | smoke run section | e2e | |
| C20 | Data-driven: `test_run_dataset` corre una vez por fila | pedido | N filas = N corridas, resultado por fila | smoke dataset | e2e | |
| C21 | `db_query`: guard read-only (INSERT rechazado), SELECT OK; conexión a app-db por objeto rico estilo TypeORM (sqlite file \| postgres host/port/credenciales/ssl), credenciales NUNCA en argv, soporte password vía función proveedora (D22) | pedido-gate1 | parity con smoke db actual + conexión por objeto funciona en ambos motores | smoke db section + spec de config | e2e | |
| C22 | Resiliencia: crash del engine → próxima llamada lo respawnea transparente | checklist#8 | kill del sidecar → siguiente req relanza y responde | spec de lifecycle | unit | |
| C23 | Compatibilidad dual-runtime: librería corre en Node ≥22.5 (node:sqlite fallback en Store — hoy bun:sqlite hardcode: bloqueante resuelto) y en Bun | pedido-gate1 (D2) | Store abre DB con node:sqlite en Node; con bun:sqlite en Bun; smoke corre en ambos | spec dual-runtime + smoke x2 | unit | |
| C24 | Publicabilidad: build emite dist/ + .d.ts + exports map + bin; `npm pack` contiene dist + engine; metadata/licencia listas; install en proyecto consumer fresh funciona | pedido-gate1 (D17) | `npm pack` + install local en consumer → `createYattServer` responde ping | build gate + smoke de instalación | unit | |
| C25 | Baselines: list/get con contenido PNG | pedido (parity) | parity con smoke meta actual | smoke meta | e2e | |
| C26 | Export de specs: playwright/jest format, write a exports dir configurable | pedido (parity) | parity con smoke export actual | smoke export | e2e | |
| C27 | Concurrencia: llamadas al engine se serializan (single browser, un cliente a la vez D23) sin corrupción | checklist#5 | cola de promesas: respuesta 1-a-1 con request | spec de chain | unit | |
| C28 | Zero-config: `createYattServer()` sin args funciona (root=cwd, defaults) | checklist#3 | server levanta y responde ping | smoke mínimo | e2e | |
| C29 | Limpieza opcional de reportes (D16): `storage.retention` apagada por defecto; al activarla borra reportes viejos según edad/cantidad configurados, sin tocar nada más | pedido-gate1 | default = cero borrado; activada = aplica política y registra lo borrado | spec de retention | unit | |
| C30 | Comando de terminal `yatt-ts` (D3): `yatt-ts serve` con flags (--http/--port/--root/--token/--read-only/--locale), `--version`; `--http` sin token → genera uno seguro y lo muestra una vez | pedido-gate1 | bin funciona, server levanta desde CLI, cliente conecta | spec de CLI (spawn+client ping) | unit | |

## Cobertura pedido → casos

- R1 (librería npm "yatt-ts"): C23, C24, C30
- R2 (levanta su propio MCP): C01, C04, C05, C28
- R3 (accesos/permisos/restricciones/sesiones/config total): C06, C07, C08, C09, C10, C11, C13, C14, C15, C16, C17, C29
- R4 (todas las funcionalidades + las actuales): C02, C03, C18, C19, C20, C21, C25, C26, C12, C22, C27

Checklist obligatorio: happy path (C01/C18), existe-todo/parcial (C14/C28/C07), dato faltante (C13), race/selección (C15, C27), permisos (C06/C07/C08), server-vs-consumer validation (C13 boot vs zod por llamada), estados terminales/error (C22, C08-rechazo).
