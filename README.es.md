# yatt-ts

**Tu propio servidor MCP de YATT, altamente configurable, como librería npm.**

`yatt-ts` levanta un servidor [Model Context Protocol](https://modelcontextprotocol.io) completo que da a clientes de IA (Claude, Cursor, tus propios agentes) acceso pleno a [YATT](https://github.com/yatt-labs/yatt): una caja de herramientas de testing de UI con **35 tools**: biblioteca de tests (crear/editar/validar), runner headless de Playwright con reportes HTML, un **navegador Chromium en vivo con capturas que la IA puede ver**, gestión de sesiones, baselines visuales, exportación de specs y SQL de solo lectura contra la base de tu aplicación.

Todo es configurable desde un único objeto de configuración tipado: transporte (stdio/HTTP), auth por bearer, permisos por tool, persistencia de sesiones, rutas de artefactos, defaults del navegador, retención. La validación estricta falla rápido y nombra la clave problemática — nunca una mala configuración silenciosa.

- Runtimes: **Node ≥ 22.5** o **Bun 1.4+** (dual-runtime, incluida la capa SQLite)
- Motor: Chromium de Playwright **vendido dentro del paquete**, **headless-first** (las capturas siempre están disponibles), con descarga automática en el primer uso
- Licencia: MIT

## Instalación

```bash
npm install yatt-ts
# o
bun add yatt-ts
```

Node 22.5+ o Bun 1.4+. En el primer uso del navegador se descargan automáticamente Chromium y `chromium-headless-shell` — sin configuración extra.

## Quickstart (30 segundos)

**Servidor stdio, cero configuración** — la raíz de datos es tu directorio actual:

```ts
import { createYattServer } from 'yatt-ts';

const server = await createYattServer(); // todos los defaults (C28: zero-config)
await server.start(); // habla MCP por stdio
```

**HTTP + token bearer** — conectá clientes remotos por red:

```ts
import { createYattServer, generateToken } from 'yatt-ts';

const server = await createYattServer({
  http: { enabled: true, port: 3191, host: '127.0.0.1' },
  auth: { token: generateToken() }, // o tu propio string (mín. 16 caracteres) / tokenHash
});
await server.start();
// Los clientes envían: Authorization: Bearer <token> (401 en otro caso; el token nunca se loguea)
```

**O desde la terminal** (sin código):

```bash
npx yatt-ts --version
npx yatt-ts --http --port 3191 --token my-secret-token-16ch
npx yatt-ts --read-only --root /ruta/a/datos-yatt --locale es
```

`--http` sin token genera uno efímero criptográficamente seguro y lo imprime **una sola vez** por stderr.

Conectá tu cliente MCP (estilo Claude Desktop / Cursor):

```json
{
  "mcpServers": {
    "yatt": { "command": "npx", "args": ["yatt-ts", "--root", "/ruta/a/datos-yatt"] }
  }
}
```

## Qué obtenés

- **35 MCP tools** — `ping`, `schema`, CRUD de tests + validate/rename/duplicate/export (`test_*`), runner headless (`test_run`, `test_run_dataset`), reportes (`report_*`), navegador en vivo (`browser_*`, `tab_*`, `session_*`), baselines (`baseline_*`) y SQL de solo lectura (`db_query`).
- **Recursos**: `yatt://schema`, `yatt://tests/{name}`, `yatt://reports/{name}`.
- **Prompts**: 5 prompts de trabajo listos para usar, en inglés o español.
- **Evidencia real del navegador**: `browser_preview` devuelve un PNG que la IA puede ver; los pasos fallidos adjuntan una captura de evidencia.

## Configuración

Todo es opcional; las claves omitidas toman defaults. Las claves desconocidas se rechazan con un error que nombra la clave.

| Dominio | Claves (default) | Qué controla |
|---|---|---|
| `paths` | `root` (cwd), `tests` (`tests`), `reports` (`reports`), `exports` (`exports`), `baselines` (`baselines`), `sessions` (`sessions`), `db` (`yatt.db`) | Dónde vive cada artefacto. Las rutas relativas se resuelven contra `root`; `~` se expande. Apuntá `root` a una carpeta de datos existente de YATT desktop — totalmente compatible. |
| `http` | `enabled` (false), `port` (3191), `host` (127.0.0.1), `cors.origins` (['*']) | Transporte Streamable HTTP en lugar de stdio. |
| `auth` | `token` \| `tokenHash` | Auth bearer para HTTP. Token plano (≥16 caracteres) o su digest SHA-256 hex — nunca ambos. stdio ignora la auth. |
| `permissions` | `readOnly` (false), `allowTools`, `denyTools`, `denyBehavior` ('error' \| 'hide') | Las tools que mutan estado se rechazan con un motivo anunciado; las bloqueadas quedan visibles ('error') o desaparecen del listado ('hide'); `allowTools` niega por defecto el resto. |
| `sessions` | `persist` (true) | `false` = las sesiones del navegador viven solo en memoria: utilizables en vivo, **cero** escrituras en disco/DB, borradas al cerrar. |
| `storage` | `retention.maxAgeDays`, `retention.maxReports` | Limpieza de reportes opt-in. **Sin configurar, nunca borra nada.** |
| `engine` | `enabled` (true), `runtime` ('auto' \| 'bun' \| 'node' \| ruta de binario), `autoInstallBrowser` (true), timeouts | El motor Playwright vendido. `enabled: false` corre sin motor (las tools browser/run/db fallan con error claro; `ping` reporta `'deferred'`). |
| `browser` | `defaultHeadless` (true), `toolbarInjection` (false), `defaultViewport` (1280×800), `engine` ('chromium'), timeouts, `cdpSync` | Headless-first con soporte completo de capturas; la barra flotante está apagada salvo que la actives. |
| `runner` | `defaultBrowser` ('chromium'), `stepTimeoutMs` (40000), `saveReport` (true) | Defaults de la corrida headless. |
| `appDb` | `{ type: 'sqlite', file }` \| `{ type: 'postgres', host, port, user, password \| passwordProvider, database, ssl }` \| `{ type: 'provider', provider: (sql) => rows }` | La base de la app bajo prueba para `db_query` (solo lectura). Los brazos de conexión viajan al motor por env, nunca por argv; `passwordProvider` resuelve secretos en el momento de la llamada. El brazo `provider` ejecuta las consultas **en tu proceso** (ver abajo). |
| `logging` | `level` ('info', o 'silent') | Los diagnósticos del servidor van a stderr (nunca al canal de protocolo). |
| `locale` | `'en'` (default) \| `'es'` | Idioma de prompts, descripciones de tools y mensajes. |

Valores inválidos (tipo incorrecto, ruta imposible, ambas formas de token, …) lanzan `ConfigError` en el arranque nombrando la clave exacta.

### Provider de base de datos (embebido)

Con `appDb: { type: 'provider', provider }`, la tool `db_query` ejecuta **en tu proceso** a través de tu propia función — típicamente un `DataSource` vivo de TypeORM/NestJS (su pool, sus credenciales, su posición de red). Funciona con `engine: { enabled: false }`:

```ts
const yatt = await createYattServer({
  appDb: { type: 'provider', provider: (sql) => dataSource.query(sql) },
});
```

El provider devuelve el array completo de filas (la forma nativa de TypeORM); yatt-ts aplica el guard de solo lectura (SELECT/WITH/EXPLAIN/PRAGMA — las sentencias rechazadas nunca llegan a tu función), el timeout de 30 s y el tope de 200 filas en la salida (`totalRows` conserva el conteo real). El override de conexión por llamada (`db`) no aplica en este modo.

**Advertencia de timeout**: cuando vence el timeout de 30 s, yatt-ts deja de esperar pero no puede cancelar la consulta ya entregada a tu provider — JavaScript no ofrece forma de abortar la llamada del host, así que la sentencia sigue corriendo en tu pool. Configurá tu propio límite del lado del host (p. ej. `statement_timeout` de PostgreSQL o un timeout de query a nivel de pool) para que las consultas abandonadas no se acumulen.

- **Usá igualmente un rol de BD de solo lectura** — yatt-ts controla el SQL, pero el nivel de privilegio es tuyo (defensa en profundidad).
- **Frontera honesta**: los pasos `db_assert`/`db_wait` del runner headless se ejecutan en el proceso hijo del motor, que no puede llamar a una función del host. Con config solo-provider esas corridas se rechazan con un mensaje claro; configurá `appDb` sqlite/postgres para usarlas. Se registra un aviso de una línea al arrancar.
- Receta completa NestJS + TypeORM: [`examples/10-typeorm-provider.ts`](./examples/10-typeorm-provider.ts).

## Notas de seguridad

- **CORS es permisivo por defecto.** `http.cors.origins` toma `['*']` como default, igual que la herramienta base de YATT. En entornos no confiables, restringilo a una lista explícita de orígenes en tu configuración.
- **Los overrides de variables de `test_run` viajan como argumentos CLI** del proceso efímero del motor (p. ej. `--override token=…`), igual que en la herramienta base. Son visibles en la lista de procesos del host (p. ej. `ps`) durante la corrida — evitá valores secretos en los overrides, o contribuí el paso de overrides por env más adelante.

## Recetas

Los ejemplos de permisos, sesiones, retención y conexión están en [`examples/`](./examples) — cada uno es un archivo autocontenido y ejecutable:

`01-zero-config-stdio` · `02-http-with-token` · `03-read-only-server` · `04-deny-list` · `05-ephemeral-sessions` · `06-custom-paths` · `07-report-retention` · `08-appdb-postgres-object` · `09-nestjs-mcp-handler` · `10-typeorm-provider`

## Integración en tu framework HTTP (NestJS)

En lugar del servidor HTTP integrado (`http.enabled`), podés exponer el endpoint MCP en **cualquier ruta de tu propio framework HTTP** — NestJS, Express, Fastify, `node:http` crudo — con `createMcpHttpHandler`:

```ts
import { createYattServer, createMcpHttpHandler } from 'yatt-ts';

const yatt = await createYattServer({ engine: { enabled: false } });
const mcp = createMcpHttpHandler(yatt);

// Cualquier ruta de tu framework (controlador Nest, router Express, …):
app.use('/api/mcp', (req, res) => mcp.handle(req, res, req.body));
```

- **Cuándo usar cada uno**: `http.enabled` para un endpoint MCP independiente que manejás de punta a punta; el handler cuando un backend existente debe alojarlo (middleware compartido, TLS, despliegue).
- **El ciclo de vida es tuyo**: NO llames a `yatt.start()` en modo handler (el handler conecta el servidor MCP por sesión él mismo); al apagar, llamá primero `mcp.close()` y después `yatt.shutdown()`. En una app Nest llamá a `app.enableShutdownHooks()` — sin eso Nest nunca dispara `onModuleDestroy` en SIGINT/SIGTERM y el apagado ordenado no se ejecuta.
- **Auth con guards del host**: sin auth por default — mandan los guards/middleware de tu framework. O pasá `authenticate: (req) => boolean` (`false` → 401 JSON, throw → 500 controlado). Excepción: si configuraste `auth.token`/`auth.tokenHash` en el server, el handler los usa como chequeo bearer por defecto (y avisa con una línea en el log) salvo que pases tu propio `authenticate`.
- **Tamaño del body**: el camino de request raw rechaza bodies de más de 2 MB con `413` (opción `maxBodyBytes` para cambiarlo). Los bodies ya parseados por tu framework se saltean el tope — ese límite lo maneja tu parser.
- **Un cliente por vez** por servidor (un solo motor de navegador): cuando un segundo cliente inicializa, la sesión vieja se desaloja (new-wins).
- Receta NestJS completa (controller + service + bearer guard): [`examples/09-nestjs-mcp-handler.ts`](./examples/09-nestjs-mcp-handler.ts).

## API pública

```ts
import {
  createYattServer,     // (config?) → { server, ctx, start(transport?), shutdown() }
  createMcpHttpHandler, // monta el endpoint MCP dentro de tu propio framework HTTP
  resolveConfig,        // validar y aplicar defaults por tu cuenta
  ConfigError,          // errores de configuración que nombran la clave
  generateToken,        // token de 64 hex criptográficamente seguro
  verifyToken, hashToken, redact,
  evaluateToolAccess, isToolListed,
  applyReportRetention,
  Store, openDatabase,
  VERSION,
} from 'yatt-ts';
```

`start()` sin argumento elige el transporte según la configuración (HTTP si `http.enabled`, stdio en otro caso) y maneja SIGINT/SIGTERM; pasá un `Transport` de MCP (p. ej. `InMemoryTransport`) para embeber el servidor en tu propio proceso y controlar el ciclo de vida vos. `shutdown()` es idempotente y siempre seguro de llamar.

## CLI

```
yatt-ts [serve] [--http] [--port N] [--host H] [--root PATH]
        [--token T | --token-hash HEX64] [--read-only] [--locale en|es]
        [--no-engine] [--allow-tool NAME] [--deny-tool NAME]
        [--deny-behavior error|hide]
yatt-ts --version | --help
```

`--http` sin `--token`/`--token-hash` genera un token efímero y lo imprime una vez por stderr. Las credenciales de la base de la app nunca se aceptan por línea de comandos — configúralas programáticamente (D22).

## Notas del motor

- **Solo Chromium, headless-first.** `browser_open` corre headless por defecto (D10); las capturas/preview funcionan igual. Pasá `headless: false` cuando un humano necesite mirar.
- **Descarga automática.** El primer uso del navegador instala `chromium` + `chromium-headless-shell` vía el Playwright incluido. Desactivable con `engine.autoInstallBrowser: false`.
- **Barra flotante apagada por defecto** (D11). Activala con `browser.toolbarInjection: true`.
- **Selección de runtime.** El proceso del motor resuelve `bun → node` automáticamente (override: `engine.runtime`). Un navegador por vez — las llamadas al motor se serializan por diseño (un cliente MCP concurrente).
- **Sin red** para el servidor en sí; la única descarga es el navegador en el primer uso.

## Requisitos

- Node **≥ 22.5** (usa `node:sqlite` integrado) o **Bun ≥ 1.4** (`bun:sqlite`)
- ~300 MB de disco para el Chromium descargado automáticamente

## Desarrollo

```bash
npm run build            # tsc → dist/ (+ bin ejecutable)
npm test                 # suite unitaria con vitest
npm run typecheck        # src + test + examples
YATT_TS_E2E=1 npx vitest run test/e2e   # smokes e2e con Chromium real
node test/e2e/install.mjs               # npm pack + prueba de instalación en consumer fresh
```

## Licencia

[MIT](./LICENSE)
