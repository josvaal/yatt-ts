/**
 * Protocol E2E smoke — the verification of record (T11).
 *
 * Ports the base `mcp/test/smoke.ts` (~48 checks) against the yatt-ts LIBRARY
 * and adds every new capability: HTTP+bearer auth (C05/C06), read-only server
 * (C08), deny announce/hide (C07), ephemeral and persistent sessions (C09/C10),
 * es locale (C03), report retention (C29), engine ready/deferred ping, toolbar
 * off/on (C17), headless default (C16), dataset runs (C20), baselines (C25),
 * zero-config boot (C28) and config rejection naming the key (C13).
 *
 * Transport: SDK InMemoryTransport for the main flows (the library-native
 * embedding path) PLUS one real stdio roundtrip through `node dist/cli.js`
 * (C04/C30) and one real Streamable HTTP roundtrip with bearer auth (C05/C06).
 * The app-under-test database is wired the library-native way —
 * `config.appDb` — with a single env-path (`YATT_APP_DB`) check kept for
 * parity with the base smoke.
 *
 * Like its siblings, it imports the COMPILED package (dist/): the smoke
 * proves the shipped artifact. Run `npm run build` first.
 *
 *   npm run build && YATT_TS_E2E=1 npx vitest run test/e2e   # vitest mode (guarded)
 *   npm run build && bun run test/e2e/protocol.smoke.mts     # standalone (bun, C23)
 *
 * Every check logs `ok`/`FAIL` like the base smoke; the process exits
 * non-zero on any failure when run standalone, and the vitest wrapper fails
 * the test when any check fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpFixtureServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ---------------------------------------------------------------------------
// Compiled-package loader (proves the shipped artifact, like the siblings).
// ---------------------------------------------------------------------------

/** Minimal structural surface of dist/index.js used by this smoke. */
interface DbLike {
  run(sql: string, params?: readonly unknown[]): void;
  get(sql: string, params?: readonly unknown[]): Record<string, unknown> | null;
  all(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
  close(): void;
}
interface ServerHandleLike {
  ctx: { root: string; afterReportMutation?: () => Promise<{ deleted: string[] }> };
  start(transport?: unknown): Promise<void>;
  shutdown(): Promise<void>;
}
interface Dist {
  VERSION: string;
  createYattServer(config?: unknown): Promise<ServerHandleLike>;
  resolveConfig(input?: unknown): unknown;
  openDatabase(file: string): Promise<DbLike>;
  generateToken(): string;
}

const DIST_INDEX_URL = new URL('../../dist/index.js', import.meta.url);
const DIST_CLI_PATH = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

async function loadDist(): Promise<Dist> {
  try {
    const pkg = (await import(/* @vite-ignore */ DIST_INDEX_URL.href)) as Partial<Dist>;
    if (typeof pkg.createYattServer !== 'function') throw new Error('createYattServer missing');
    return pkg as Dist;
  } catch (error) {
    throw new Error(
      `the compiled package (dist/) is missing or broken — run "npm run build" before the protocol e2e. Original error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check machinery (PASS/FAIL logging like the base smoke).
// ---------------------------------------------------------------------------

let failures = 0;
let log: (line: string) => void = () => {};

function check(label: string, ok: boolean, extra = ''): boolean {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
  return ok;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** Any-shaped tool result helpers (the MCP envelopes are JSON text blocks). */
type AnyResult = { content?: Array<Record<string, unknown>>; isError?: boolean };

function textOf(res: unknown): string {
  return ((res as AnyResult).content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n');
}
function isToolError(res: unknown): boolean {
  return (res as AnyResult).isError === true;
}
function imageOf(res: unknown): { data: string; mimeType: string } | null {
  const block = ((res as AnyResult).content ?? []).find((c) => c.type === 'image');
  return block ? { data: String(block.data ?? ''), mimeType: String(block.mimeType ?? '') } : null;
}

/** Boots a server + connected MCP client over an in-memory linked pair. */
async function bootInMemory(
  dist: Dist,
  config?: unknown,
): Promise<{ handle: ServerHandleLike; client: Client }> {
  const handle = await dist.createYattServer(config);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'protocol-smoke', version: '0.1.0' });
  await Promise.all([handle.start(serverTransport), client.connect(clientTransport)]);
  return { handle, client };
}

function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
}
async function jsonOf(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  return JSON.parse(textOf(await call(client, name, args)));
}

/** Local HTTP fixture (random port) so the smoke never touches the network. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>yatt-ts protocol smoke</title></head><body>
<h1>yatt-ts protocol smoke</h1>
<form id="form">
  <input id="username" name="username" placeholder="user">
  <input id="password" name="password" type="password" placeholder="pass">
  <button id="submit" type="button">Sign in</button>
</form>
<p id="result">no result yet</p>
<p>viewport: <span id="viewport">0</span></p>
<script>
document.getElementById('viewport').textContent = String(window.innerWidth);
document.getElementById('submit').onclick = () => {
  document.getElementById('result').textContent = document.getElementById('username').value;
};
</script>
</body></html>`;

async function startFixtureServer(): Promise<{ server: HttpFixtureServer; url: string }> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no fixture server address');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

/** Grabs a free TCP port (small race, acceptable for a smoke). */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('no probe address');
  const port = address.port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function makeTmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * S1/C12 helper: relative entries of `dir` that are NOT under `rootName`.
 * The chosen data root is the only thing allowed to exist inside its parent.
 */
function entriesOutsideRoot(dir: string, rootName: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (relPath === rootName || relPath.startsWith(`${rootName}/`)) {
        if (entry.isDirectory()) walk(join(current, entry.name), relPath);
        continue;
      }
      if (entry.isDirectory()) {
        out.push(`${relPath}/`);
        walk(join(current, entry.name), relPath);
      } else {
        out.push(relPath);
      }
    }
  };
  walk(dir, '');
  return out;
}

/** Minimal but valid PNG header blob for baseline seeding (C25). */
function pngBlob(): Uint8Array {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 120; i++) bytes.push(i % 256);
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// The smoke itself. Sections mirror the base smoke + the new capabilities.
// ---------------------------------------------------------------------------

async function runProtocolSmoke(): Promise<number> {
  const dist = await loadDist();
  const roots: string[] = [];
  const fixture = await startFixtureServer();
  const { url } = fixture;

  try {
    // =====================================================================
    // 0. Config rejection names the key (C13, server-side rejection path).
    // =====================================================================
    const badRoot = await dist.createYattServer({ notAKey: true }).then(
      () => null,
      (err: unknown) => err,
    );
    check(
      'config unknown key rejected naming the key (C13)',
      badRoot instanceof Error &&
        badRoot.name === 'ConfigError' &&
        badRoot.message.includes('notAKey'),
      badRoot instanceof Error ? badRoot.message.slice(0, 90) : 'no error',
    );
    const badPort = await dist.createYattServer({ http: { port: 99999 } }).then(
      () => null,
      (err: unknown) => err,
    );
    check(
      'config invalid http.port rejected naming the key (C13)',
      badPort instanceof Error &&
        badPort.name === 'ConfigError' &&
        badPort.message.includes('http.port'),
      badPort instanceof Error ? badPort.message.slice(0, 90) : 'no error',
    );

    // =====================================================================
    // 1. Zero-config: createYattServer() with NO args boots in cwd (C28).
    // =====================================================================
    const origCwd = process.cwd();
    const tmpCwd = makeTmpRoot('yatt-ts-proto-zero-');
    roots.push(tmpCwd);
    let zeroHandle: ServerHandleLike | null = null;
    let zeroClient: Client | null = null;
    try {
      process.chdir(tmpCwd);
      zeroHandle = await dist.createYattServer();
      const [st, ct] = InMemoryTransport.createLinkedPair();
      zeroClient = new Client({ name: 'protocol-smoke-zero', version: '0.1.0' });
      await Promise.all([zeroHandle.start(st), zeroClient.connect(ct)]);
      const ping = await jsonOf(zeroClient, 'ping');
      check('zero-config server boots and pings (C28)', ping.ok === true, JSON.stringify(ping));
      check(
        'zero-config root is the current working directory (C28)',
        zeroHandle.ctx.root === realpathSync(tmpCwd),
        `root=${zeroHandle.ctx.root}`,
      );
    } finally {
      process.chdir(origCwd);
      if (zeroClient) await zeroClient.close().catch(() => {});
      if (zeroHandle) await zeroHandle.shutdown();
    }

    // =====================================================================
    // 2. stdio roundtrip through the compiled CLI (C04/C30).
    // =====================================================================
    {
      const rootCli = makeTmpRoot('yatt-ts-proto-cli-');
      roots.push(rootCli);
      const transport = new StdioClientTransport({
        command: 'node',
        args: [DIST_CLI_PATH, '--root', rootCli, '--no-engine'],
        env: { ...process.env } as Record<string, string>,
      });
      const cliClient = new Client({ name: 'protocol-smoke-stdio', version: '0.1.0' });
      try {
        await cliClient.connect(transport);
        const ping = await jsonOf(cliClient, 'ping');
        check('stdio CLI roundtrip: ping ok (C04/C30)', ping.ok === true, JSON.stringify(ping));
        check('stdio CLI roundtrip: engine deferred with --no-engine', ping.engine === 'deferred');
        const { tools } = await cliClient.listTools();
        check('stdio CLI roundtrip: full catalog listed', tools.length === 35, `${tools.length} tools`);
      } finally {
        await cliClient.close().catch(() => {});
      }
    }

    // =====================================================================
    // 3. Main in-memory server: base-smoke parity (C01/C02/C18...).
    //    appDb wired the library-native way: config.appDb (NOT env).
    //    S1/C12: the root lives inside a dedicated parent that starts EMPTY,
    //    so "zero entries outside the root after shutdown" is assertable.
    // =====================================================================
    const parentMain = makeTmpRoot('yatt-ts-proto-c12-');
    roots.push(parentMain);
    const rootMain = join(parentMain, 'data-root');
    mkdirSync(rootMain, { recursive: true });
    const appDbDir = makeTmpRoot('yatt-ts-proto-appdb-');
    roots.push(appDbDir);
    const appDbPath = join(appDbDir, 'app.db');
    {
      const db = await dist.openDatabase(appDbPath);
      db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
      db.run('DELETE FROM users');
      db.run("INSERT INTO users (name) VALUES ('ana'), ('beto')");
      db.close();
    }

    const main = await bootInMemory(dist, {
      paths: { root: rootMain },
      engine: { runtime: 'node' },
      appDb: { type: 'sqlite', file: appDbPath },
      // F3: a NON-default viewport — the runner e2e below proves it reaches
      // the one-shot CLI engine (dead-config regression).
      browser: { defaultViewport: { width: 1112, height: 666 } },
    });
    const client = main.client;

    try {
      // ---- Tool inventory (C02) ----
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      check('tools registered == 35 (C02)', names.length === 35, `${names.length} tools`);
      for (const required of [
        'ping',
        'schema',
        'test_create',
        'test_update',
        'test_delete',
        'test_rename',
        'test_duplicate',
        'test_validate',
        'test_export_playwright',
        'test_list',
        'test_get',
        'test_run',
        'test_run_dataset',
        'report_list',
        'report_get',
        'report_delete',
        'db_query',
        'baseline_list',
        'baseline_get',
        'browser_open',
        'browser_status',
        'browser_preview',
        'browser_eval',
        'browser_run_step',
        'browser_condition',
        'tab_open',
        'tab_switch',
        'tab_close',
        'session_save',
        'session_list',
        'session_delete',
      ]) {
        check(`tool ${required} present (C02)`, names.includes(required));
      }

      // ---- Prompts + resources (C03/en side) ----
      const prompts = await client.listPrompts();
      check('prompts registered ≥ 4', prompts.prompts.length >= 4, `${prompts.prompts.length}`);
      const enNames = prompts.prompts.map((p) => p.name).sort();
      // S3: not just "contains" — the en surface is EXACTLY these 5 prompts.
      check(
        'en prompts are EXACTLY the 5 expected names (C03/S3)',
        JSON.stringify(enNames) ===
          JSON.stringify(['create-test', 'diagnose-report', 'explore-page', 'export-spec', 'flow-battery']),
        enNames.join(','),
      );
      const schemaRes = await client.readResource({ uri: 'yatt://schema' });
      const schemaText = String((schemaRes.contents[0] as { text?: string })?.text ?? '');
      check('resource yatt://schema readable', schemaText.includes('schemaVersion') && schemaText.includes('steps'));

      // ---- Meta: ping (REAL engine → ready), schema tool ----
      const ping = await jsonOf(client, 'ping');
      check('ping ok with REAL engine ready', ping.ok === true && ping.engine === 'ready', JSON.stringify(ping));
      const schemaTool = textOf(await call(client, 'schema'));
      check('schema tool documents the format', schemaTool.includes('schemaVersion') && schemaTool.includes('goto'));

      // ---- Validation ----
      const goodDoc = {
        schemaVersion: 1,
        name: 'proto-test',
        url,
        steps: [
          { action: 'goto', value: url },
          { action: 'type', selector: '#username', value: 'demo' },
          { action: 'click', selector: '#submit' },
          { action: 'assert_text', selector: '#result', value: 'demo' },
        ],
      };
      const good = await jsonOf(client, 'test_validate', { content: JSON.stringify(goodDoc) });
      check('test_validate good', good.ok === true && good.doc.steps === 4);
      const bad = await jsonOf(client, 'test_validate', { content: '{not json' });
      check('test_validate bad', bad.ok === false && String(bad.error).length > 0);
      const future = await jsonOf(client, 'test_validate', {
        content: JSON.stringify({ schemaVersion: 9, steps: [] }),
      });
      check('test_validate future schemaVersion', future.ok === false);

      // ---- Baselines start empty (C25 part 1, fresh root) ----
      const blEmpty = await jsonOf(client, 'baseline_list');
      check('baseline_list empty on fresh root (C25)', blEmpty.count === 0);

      // ---- Create / list / get ----
      const created = await jsonOf(client, 'test_create', { content: JSON.stringify(goodDoc) });
      check('test_create', created.ok === true && created.created === 'proto-test');
      const dupFail = await call(client, 'test_create', {
        content: JSON.stringify({ schemaVersion: 1, name: 'proto-test', steps: [] }),
      });
      check(
        'test_create duplicate fails announced',
        isToolError(dupFail) || textOf(dupFail).includes('already exists'),
      );
      const list = await jsonOf(client, 'test_list');
      check('test_list includes proto-test', list.tests.includes('proto-test'));
      const got = await jsonOf(client, 'test_get', { name: 'proto-test' });
      check('test_get returns the doc', got.doc.name === 'proto-test' && got.doc.steps.length === 4);
      const testRes = await client.readResource({ uri: 'yatt://tests/proto-test' });
      check(
        'resource yatt://tests/<name> readable',
        String((testRes.contents[0] as { text?: string })?.text ?? '').includes('"proto-test"'),
      );

      // ---- Update / duplicate / rename / export ----
      const upd = await jsonOf(client, 'test_update', {
        name: 'proto-test',
        content: JSON.stringify({
          schemaVersion: 1,
          name: 'proto-test',
          url,
          steps: goodDoc.steps.concat([{ action: 'wait', value: '0.5' }]),
        }),
      });
      check('test_update', upd.ok === true && upd.steps === 5);
      const dup = await jsonOf(client, 'test_duplicate', { name: 'proto-test' });
      check('test_duplicate', dup.duplicated === 'proto-test (copy)', dup.duplicated);
      const ren = await jsonOf(client, 'test_rename', { name: 'proto-test (copy)', newName: 'proto-copy' });
      check('test_rename', ren.renamed === 'proto-copy');
      const exp = await jsonOf(client, 'test_export_playwright', { name: 'proto-test' });
      check(
        'test_export_playwright linear spec (C26)',
        exp.spec.includes('@playwright/test') &&
          exp.spec.includes('await page.locator(') &&
          !exp.spec.includes('STEPS:'),
        `len=${exp.length}`,
      );
      const expJest = await jsonOf(client, 'test_export_playwright', { name: 'proto-test', format: 'jest' });
      check(
        'test_export_playwright format=jest (C26)',
        expJest.spec.includes('@jest/globals') &&
          expJest.spec.includes('describe(') &&
          expJest.spec.includes('it('),
      );
      const expBad = await call(client, 'test_export_playwright', { name: 'proto-test', format: 'mocha' });
      check(
        'test_export_playwright invalid format rejected (C26)',
        isToolError(expBad) || textOf(expBad).includes('format'),
      );
      const expWritten = await jsonOf(client, 'test_export_playwright', {
        name: 'proto-test',
        write: true,
      });
      check(
        'test_export_playwright write lands in exports dir (C26/C11)',
        typeof expWritten.path === 'string' && expWritten.path.startsWith(join(rootMain, 'exports')),
        String(expWritten.path),
      );

      // ---- Live browser, headless by default (C16), toolbar OFF (C17) ----
      const opened = await jsonOf(client, 'browser_open', { url });
      check('browser_open', opened.ok === true);
      const status = await jsonOf(client, 'browser_status');
      check('browser_status open', status.open === true);
      const ua = await jsonOf(client, 'browser_eval', { expression: 'navigator.userAgent' });
      check(
        'headless default ON (C16/D10)',
        typeof ua.value === 'string' && ua.value.includes('HeadlessChrome'),
        String(ua.value).slice(0, 80),
      );
      const injectedOff = await jsonOf(client, 'browser_eval', {
        expression: 'Boolean(window.__yattInjected) || Boolean(document.querySelector(".yatt-tk"))',
      });
      check('toolbar NOT injected by default (C17/D11)', injectedOff.value === false);
      const preview = await call(client, 'browser_preview');
      const previewImage = imageOf(preview);
      const pngOk =
        previewImage !== null &&
        previewImage.mimeType === 'image/png' &&
        Buffer.from(previewImage.data, 'base64').subarray(0, 4).toString('hex') === '89504e47';
      check('browser_preview returns a real PNG (C18)', pngOk && textOf(preview).includes('url'));
      const typed = await jsonOf(client, 'browser_run_step', {
        step: { action: 'type', selector: '#username', value: 'demo' },
      });
      check('browser_run_step type', typed.ok === true);
      const clicked = await jsonOf(client, 'browser_run_step', { step: { action: 'click', selector: '#submit' } });
      check('browser_run_step click', clicked.ok === true);
      const cond = await jsonOf(client, 'browser_condition', { selector: '#result' });
      check('browser_condition exists', cond.value === true);
      const pollT0 = Date.now();
      const poll = await jsonOf(client, 'browser_condition', {
        selector: '#does-not-exist',
        timeoutMs: 600,
        intervalMs: 100,
      });
      const pollWall = Date.now() - pollT0;
      check(
        'browser_condition polling timeout honored',
        poll.value === false && poll.elapsedMs >= 500,
        `elapsed=${poll.elapsedMs}ms wall=${pollWall}ms`,
      );
      check('browser_condition polling bounded', pollWall < 1500, `wall=${pollWall}ms`);
      const ev = await jsonOf(client, 'browser_eval', {
        expression: "document.querySelector('#result').textContent",
      });
      check('browser_eval reads the DOM', ev.value === 'demo', String(ev.value));
      const typedVar = await jsonOf(client, 'browser_run_step', {
        step: { action: 'type', selector: '#username', value: '{{email}}' },
        vars: { email: 'var@test.dev' },
      });
      check('browser_run_step accepts vars', typedVar.ok === true);
      const evVar = await jsonOf(client, 'browser_eval', {
        expression: "document.querySelector('#username').value",
      });
      check('browser_run_step interpolates {{var}}', evVar.value === 'var@test.dev', String(evVar.value));

      // localStorage state for the session section below — MUST run while the
      // fixture page is active (about:blank after tab_close has an opaque
      // origin and denies localStorage; expected browser behavior).
      const lsSet = await jsonOf(client, 'browser_eval', {
        expression: "localStorage.setItem('proto', 'session-works')",
      });
      check('browser_eval sets localStorage', lsSet.value === undefined || lsSet.value === null);

      // ---- db_query: config.appDb + per-call db + read-only guard (C21) ----
      const dbq = await jsonOf(client, 'db_query', { sql: 'SELECT id, name FROM users ORDER BY id' });
      check(
        'db_query columns/rows via config.appDb (C21)',
        JSON.stringify(dbq.columns) === '["id","name"]' && dbq.totalRows === 2 && dbq.rows?.[0]?.[1] === 'ana',
        JSON.stringify(dbq).slice(0, 90),
      );
      const dbqParam = await jsonOf(client, 'db_query', {
        sql: 'SELECT id, name FROM users ORDER BY id',
        db: appDbPath,
      });
      check(
        'db_query per-call db parameter (C21)',
        JSON.stringify(dbqParam.columns) === '["id","name"]' && dbqParam.totalRows === 2,
      );
      const dbIns = await call(client, 'db_query', { sql: "INSERT INTO users (name) VALUES ('x')" });
      check(
        'db_query read-only guard rejects INSERT (C21)',
        isToolError(dbIns) && textOf(dbIns).includes('read-only'),
        textOf(dbIns).slice(0, 60),
      );

      // ---- S2/F2 regression: db_assert INSIDE test_run (one-shot CLI) ----
      // The CLI gets the appDb via YATT_APP_DB_JSON (config.appDb → runner
      // env) and must NOT null it (F2); the #viewport assert ALSO proves the
      // non-default viewport reached the CLI through YATT_ENGINE_JSON (F3
      // runner path).
      await jsonOf(client, 'test_create', {
        content: JSON.stringify({
          schemaVersion: 1,
          name: 'proto-db',
          url,
          steps: [
            { action: 'goto', value: url },
            { action: 'assert_text', selector: '#viewport', value: '1112' },
            { action: 'db_assert', sql: 'SELECT id, name FROM users ORDER BY id', expect: 'rows' },
          ],
        }),
      });
      const runDb = await jsonOf(client, 'test_run', { name: 'proto-db' });
      check(
        'test_run db_assert step passes via config.appDb (F2/S2)',
        runDb.fail === 0 && runDb.ok === 3,
        `ok=${runDb.ok} fail=${runDb.fail}`,
      );
      const viewportStep = (runDb.steps ?? []).find(
        (s: { action: string }) => s.action === 'assert_text',
      );
      check(
        'runner env carries the non-default viewport to the CLI engine (F3/S2)',
        viewportStep?.status === 'ok',
        JSON.stringify(viewportStep),
      );

      // ---- Tabs ----
      const tabs2 = await jsonOf(client, 'tab_open', { url: 'about:blank' });
      check('tab_open → 2 tabs', tabs2.tabs.length === 2);
      const tabsSwitch = await jsonOf(client, 'tab_switch', { index: 0 });
      check('tab_switch', tabsSwitch.tabs[0]?.active === true);
      const tabs1 = await jsonOf(client, 'tab_close', {});
      check('tab_close', tabs1.tabs.length === 1);

      // ---- Persistent sessions (C10): DB row + mirror file ----
      const savedPersist = await jsonOf(client, 'session_save', { name: 'proto-persist' });
      check('session_save persistent', savedPersist.ok === true && savedPersist.name === 'proto-persist');
      const sesList = await jsonOf(client, 'session_list');
      check('session_list shows saved session (C10)', sesList.sessions.includes('proto-persist'));
      const mirrorPath = join(rootMain, 'sessions', 'proto-persist.json');
      check('session mirror file exists (C10)', existsSync(mirrorPath), mirrorPath);
      const probeDb = await dist.openDatabase(join(rootMain, 'yatt.db'));
      const row = probeDb.get('SELECT name, storage_state FROM sessions WHERE name = ?', ['proto-persist']);
      check('session DB row exists (C10)', row?.name === 'proto-persist');
      check(
        'session DB row carries the storage state (C10)',
        String(row?.storage_state ?? '').includes('session-works'),
      );
      probeDb.close();
      const savedSes = await jsonOf(client, 'session_save', { name: 'proto-ses' });
      check('session_save second session', savedSes.ok === true);
      await jsonOf(client, 'session_delete', { name: 'proto-ses' });
      const sesList2 = await jsonOf(client, 'session_list');
      check('session_delete removes from listing (C10)', !sesList2.sessions.includes('proto-ses'));

      // ---- Headless run + reports (C19) ----
      const run = await jsonOf(client, 'test_run', { name: 'proto-test' });
      check('test_run passes (5 steps)', run.fail === 0 && run.ok === 5, `ok=${run.ok} fail=${run.fail}`);
      check('test_run saves report', typeof run.report?.json === 'string' && run.report.json.endsWith('.json'));
      const reportList = await jsonOf(client, 'report_list');
      check('report_list has the json', reportList.reports.includes(run.report.json));
      const rep = await jsonOf(client, 'report_get', { name: run.report.json });
      check('report_get RunReport shape (C19)', rep.report.kind === 'test' && rep.report.ok === 5);
      const repRes = await client.readResource({ uri: `yatt://reports/${run.report.json}` });
      check(
        'resource yatt://reports/<slug>',
        String((repRes.contents[0] as { text?: string })?.text ?? '').includes('"kind": "test"'),
      );

      // ---- Controlled failure + report_delete ----
      await jsonOf(client, 'test_create', {
        content: JSON.stringify({
          schemaVersion: 1,
          name: 'proto-fail',
          url,
          steps: [
            { action: 'goto', value: url },
            { action: 'assert_hidden', selector: '#username' },
          ],
        }),
      });
      const runFail = await jsonOf(client, 'test_run', { name: 'proto-fail' });
      check('test_run reports the failure', runFail.fail === 1, `fail=${runFail.fail}`);
      await jsonOf(client, 'report_delete', { name: runFail.report.json });
      const reportList2 = await jsonOf(client, 'report_list');
      check('report_delete', !reportList2.reports.includes(runFail.report.json));

      // ---- Dataset: one run per row (C20) ----
      await jsonOf(client, 'test_create', {
        content: JSON.stringify({
          schemaVersion: 1,
          name: 'proto-dataset',
          url,
          steps: [
            { action: 'goto', value: url },
            { action: 'assert_text', selector: '#result', value: 'no result yet' },
          ],
        }),
      });
      const dataset = await jsonOf(client, 'test_run_dataset', {
        name: 'proto-dataset',
        rows: [{ user: 'ana' }, { user: 'beto' }],
      });
      check(
        'test_run_dataset: 2 rows → 2 runs (C20)',
        dataset.rows.length === 2 && dataset.fail === 0 && dataset.ok === 4,
        `rows=${dataset.rows.length} ok=${dataset.ok}`,
      );
      check(
        'test_run_dataset per-row result (C20)',
        dataset.rows.every((r: { ok: number; fail: number }) => r.ok === 2 && r.fail === 0),
      );

      // ---- Baselines seeded (C25 part 2) ----
      {
        const db = await dist.openDatabase(join(rootMain, 'yatt.db'));
        db.run('INSERT INTO baselines (name, png, updated_at) VALUES (?, ?, ?)', [
          'proto-baseline',
          pngBlob(),
          Date.now(),
        ]);
        db.close();
      }
      const blList = await jsonOf(client, 'baseline_list');
      check('baseline_list sees seeded baseline (C25)', blList.count === 1 && blList.baselines[0] === 'proto-baseline');
      const blGet = await call(client, 'baseline_get', { name: 'proto-baseline' });
      const blImage = imageOf(blGet);
      check(
        'baseline_get returns PNG content (C25)',
        blImage !== null && blImage.data.length > 100,
        blImage ? `mimeType=${blImage.mimeType}` : 'no image',
      );

      // ---- Cleanup (C12): everything deleted through the protocol ----
      await call(client, 'test_delete', { name: 'proto-test' });
      await call(client, 'test_delete', { name: 'proto-fail' });
      await call(client, 'test_delete', { name: 'proto-dataset' });
      await call(client, 'test_delete', { name: 'proto-copy' });
      await call(client, 'test_delete', { name: 'proto-db' });
      const finalList = await jsonOf(client, 'test_list');
      check('test_delete cleans everything', finalList.tests.length === 0);
    } finally {
      await client.close().catch(() => {});
      await main.handle.shutdown();
    }

    // S1/C12: after shutdown the parent dir must contain NOTHING beyond the
    // chosen root itself — the real "zero traces outside the chosen root"
    // claim (replaces the weak listing-only assert, which is kept above).
    const strays = entriesOutsideRoot(parentMain, 'data-root');
    check('C12: zero entries outside the chosen root after shutdown (S1)', strays.length === 0, strays.join(', '));

    // =====================================================================
    // 4. HTTP transport + bearer auth (C05/C06) + ping 'deferred'.
    // =====================================================================
    {
      const rootHttp = makeTmpRoot('yatt-ts-proto-http-');
      roots.push(rootHttp);
      const port = await freePort();
      const token = dist.generateToken();
      const handle = await dist.createYattServer({
        paths: { root: rootHttp },
        engine: { enabled: false },
        http: { enabled: true, port, host: '127.0.0.1' },
        auth: { token },
      });
      await handle.start(); // no transport → HTTP transport from config
      const base = `http://127.0.0.1:${port}/`;

      const tryConnect = async (headers: Record<string, string>): Promise<{ ok: boolean; error: string }> => {
        const transport = new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers } });
        const c = new Client({ name: 'protocol-smoke-http', version: '0.1.0' });
        try {
          await c.connect(transport);
          return { ok: true, error: '', client: c };
        } catch (err) {
          await transport.close().catch(() => {});
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };

      try {
        const noToken = await tryConnect({});
        check(
          'HTTP without token rejected (C06)',
          !noToken.ok && /401|unauthorized/.test(noToken.error),
          noToken.error.slice(0, 80),
        );
        const wrongToken = await tryConnect({ Authorization: 'Bearer wrong-token-0000000000' });
        check(
          'HTTP with wrong token rejected (C06)',
          !wrongToken.ok && /401|unauthorized/.test(wrongToken.error),
          wrongToken.error.slice(0, 80),
        );
        const valid = await tryConnect({ Authorization: `Bearer ${token}` });
        check('HTTP with valid token accepted (C05/C06)', valid.ok, valid.error.slice(0, 80));
        if (valid.ok) {
          const httpClient = (valid as { client: Client }).client;
          const ping = await jsonOf(httpClient, 'ping');
          check(
            "ping reports 'deferred' when engine.enabled:false",
            ping.ok === true && ping.engine === 'deferred',
            JSON.stringify(ping),
          );
          const { tools } = await httpClient.listTools();
          check('HTTP surface lists the full catalog', tools.length === 35, `${tools.length}`);
          await httpClient.close();
        }
      } finally {
        await handle.shutdown();
      }
    }

    // =====================================================================
    // 5. Read-only server (C08): mutations announce, reads work.
    // =====================================================================
    {
      const rootRo = makeTmpRoot('yatt-ts-proto-ro-');
      roots.push(rootRo);
      const ro = await bootInMemory(dist, {
        paths: { root: rootRo },
        engine: { enabled: false },
        permissions: { readOnly: true },
      });
      try {
        const denied = await call(ro.client, 'test_create', {
          content: JSON.stringify({ schemaVersion: 1, name: 'nope', steps: [] }),
        });
        check(
          'readOnly denies test_create with announced reason (C08)',
          isToolError(denied) && textOf(denied).includes('read-only'),
          textOf(denied).slice(0, 80),
        );
        const deniedDel = await call(ro.client, 'test_delete', { name: 'nope' });
        check('readOnly denies test_delete (C08)', isToolError(deniedDel));
        const listed = await jsonOf(ro.client, 'test_list');
        check('readOnly keeps reads working (C08)', listed.count === 0 && Array.isArray(listed.tests));
        const roPing = await jsonOf(ro.client, 'ping');
        check('readOnly ping ok', roPing.ok === true);
      } finally {
        await ro.client.close().catch(() => {});
        await ro.handle.shutdown();
      }
    }

    // =====================================================================
    // 6. Deny lists (C07): announce (visible + error) and hide (absent).
    // =====================================================================
    {
      const rootD1 = makeTmpRoot('yatt-ts-proto-deny-err-');
      roots.push(rootD1);
      const d1 = await bootInMemory(dist, {
        paths: { root: rootD1 },
        engine: { enabled: false },
        permissions: { denyTools: ['test_delete'] },
      });
      try {
        const { tools } = await d1.client.listTools();
        const names = tools.map((t) => t.name);
        check('denied tool stays LISTED with denyBehavior error (C07)', names.includes('test_delete'));
        const denied = await call(d1.client, 'test_delete', { name: 'whatever' });
        check(
          'denied tool call announces the policy error (C07)',
          isToolError(denied) && textOf(denied).includes('not permitted'),
          textOf(denied).slice(0, 80),
        );
      } finally {
        await d1.client.close().catch(() => {});
        await d1.handle.shutdown();
      }

      const rootD2 = makeTmpRoot('yatt-ts-proto-deny-hide-');
      roots.push(rootD2);
      const d2 = await bootInMemory(dist, {
        paths: { root: rootD2 },
        engine: { enabled: false },
        permissions: { denyTools: ['test_delete'], denyBehavior: 'hide' },
      });
      try {
        const { tools } = await d2.client.listTools();
        const names = tools.map((t) => t.name);
        check('denyBehavior hide omits the tool from listings (C07)', !names.includes('test_delete'));
        check('hide keeps the rest of the catalog', names.includes('test_list') && names.length === 34, `${names.length}`);
      } finally {
        await d2.client.close().catch(() => {});
        await d2.handle.shutdown();
      }
    }

    // =====================================================================
    // 7. Spanish locale (C03): prompts + schema in Spanish.
    // =====================================================================
    {
      const rootEs = makeTmpRoot('yatt-ts-proto-es-');
      roots.push(rootEs);
      const es = await bootInMemory(dist, {
        paths: { root: rootEs },
        engine: { enabled: false },
        locale: 'es',
      });
      try {
        const prompts = await es.client.listPrompts();
        const esNames = prompts.prompts.map((p) => p.name);
        check(
          'es prompts listed with Spanish names (C03)',
          ['crear-test', 'diagnosticar-reporte', 'explorar-pagina', 'exportar-spec', 'bateria-de-flujos'].every(
            (n) => esNames.includes(n),
          ),
          esNames.join(','),
        );
        const schemaEs = textOf(await call(es.client, 'schema'));
        check('es schema tool text is Spanish (C03)', schemaEs.includes('Formato de test de YATT'));
        const { tools } = await es.client.listTools();
        const pingDesc = tools.find((t) => t.name === 'ping')?.description ?? '';
        check('es tool descriptions are Spanish (C03)', pingDesc.includes('motor'), pingDesc.slice(0, 60));
      } finally {
        await es.client.close().catch(() => {});
        await es.handle.shutdown();
      }
    }

    // =====================================================================
    // 8. Env-path parity: YATT_APP_DB still feeds db_query (base parity).
    // =====================================================================
    {
      const rootEnv = makeTmpRoot('yatt-ts-proto-envdb-');
      roots.push(rootEnv);
      const appDbEnvDir = makeTmpRoot('yatt-ts-proto-appdb-env-');
      roots.push(appDbEnvDir);
      const appDbEnvPath = join(appDbEnvDir, 'parity.db');
      const db = await dist.openDatabase(appDbEnvPath);
      db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
      db.run("INSERT INTO users (name) VALUES ('ana'), ('beto')");
      db.close();

      process.env.YATT_APP_DB = appDbEnvPath;
      const envServer = await bootInMemory(dist, {
        paths: { root: rootEnv },
        engine: { runtime: 'node' },
      });
      try {
        const dbq = await jsonOf(envServer.client, 'db_query', { sql: 'SELECT id, name FROM users ORDER BY id' });
        check(
          'db_query via YATT_APP_DB env still works (base parity)',
          dbq.totalRows === 2 && dbq.rows?.[0]?.[1] === 'ana',
          JSON.stringify(dbq).slice(0, 80),
        );
      } finally {
        delete process.env.YATT_APP_DB;
        await envServer.client.close().catch(() => {});
        await envServer.handle.shutdown();
      }
    }

    // =====================================================================
    // 9. Ephemeral sessions (C09): live usable, ZERO disk traces.
    // =====================================================================
    {
      const rootMem = makeTmpRoot('yatt-ts-proto-mem-');
      roots.push(rootMem);
      const mem = await bootInMemory(dist, {
        paths: { root: rootMem },
        engine: { runtime: 'node' },
        sessions: { persist: false },
      });
      try {
        expectOpen(await jsonOf(mem.client, 'browser_open', { url }));
        await jsonOf(mem.client, 'browser_eval', {
          expression: "localStorage.setItem('proto', 'ephemeral-works')",
        });
        const saved = await jsonOf(mem.client, 'session_save', { name: 'proto-mem' });
        check('memory session_save works live (C09)', saved.ok === true);
        const listed = await jsonOf(mem.client, 'session_list');
        check('memory session_list shows it (C09)', listed.sessions.includes('proto-mem'));
        check(
          'ZERO session files under root (C09)',
          !existsSync(join(rootMem, 'sessions')),
          join(rootMem, 'sessions'),
        );
        await jsonOf(mem.client, 'browser_close', {});
      } finally {
        await mem.client.close().catch(() => {});
        await mem.handle.shutdown();
      }
      // After shutdown: nothing persisted (no dir, no DB row).
      check('after shutdown sessions dir still absent (C09)', !existsSync(join(rootMem, 'sessions')));
      const dbAfter = await dist.openDatabase(join(rootMem, 'yatt.db'));
      const count = dbAfter.get('SELECT COUNT(*) AS n FROM sessions');
      check('after shutdown sessions table empty (C09)', Number(count?.n ?? -1) === 0, JSON.stringify(count));
      dbAfter.close();
    }

    // =====================================================================
    // 10. Toolbar ON (C17): injected when explicitly enabled.
    // =====================================================================
    {
      const rootTb = makeTmpRoot('yatt-ts-proto-tb-');
      roots.push(rootTb);
      const tb = await bootInMemory(dist, {
        paths: { root: rootTb },
        engine: { runtime: 'node' },
        browser: { toolbarInjection: true },
      });
      try {
        expectOpen(await jsonOf(tb.client, 'browser_open', { url }));
        await new Promise((r) => setTimeout(r, 500));
        const injected = await jsonOf(tb.client, 'browser_eval', {
          expression: 'Boolean(window.__yattInjected)',
        });
        check('toolbar IS injected when enabled (C17)', injected.value === true);
        await jsonOf(tb.client, 'browser_close', {});
      } finally {
        await tb.client.close().catch(() => {});
        await tb.handle.shutdown();
      }
    }

    // =====================================================================
    // 10b. Custom paths layout end-to-end (F1/C11/D21): the host Store and
    // the engine must open the SAME db file even under a custom layout —
    // capture_screenshot writes through the ENGINE db, baseline_list reads
    // through the HOST store, so visibility proves they share the file.
    // =====================================================================
    {
      const parentF1 = makeTmpRoot('yatt-ts-proto-f1-');
      roots.push(parentF1);
      const rootF1 = join(parentF1, 'layout');
      const f1 = await bootInMemory(dist, {
        paths: { root: rootF1, db: 'system.db', baselines: 'shots' },
        engine: { runtime: 'node' },
      });
      try {
        check('custom db path used by the host store (F1/C11)', existsSync(join(rootF1, 'system.db')));
        expectOpen(await jsonOf(f1.client, 'browser_open', { url }));
        const shot = await jsonOf(f1.client, 'browser_run_step', {
          step: { action: 'capture_screenshot', value: 'proto-f1-baseline' },
        });
        check('capture_screenshot step ok under custom layout (F1)', shot.ok === true, JSON.stringify(shot));
        // The baselinesDir override reached the engine too (PNG mirror).
        check(
          'custom baselines dir receives the engine PNG mirror (F1/C11)',
          existsSync(join(rootF1, 'shots', 'proto-f1-baseline.png')),
        );
        const baselines = await jsonOf(f1.client, 'baseline_list');
        check(
          'host store sees the engine-written baseline — SAME db file (F1/C11)',
          baselines.count === 1 && baselines.baselines[0] === 'proto-f1-baseline',
          JSON.stringify(baselines),
        );
        await jsonOf(f1.client, 'browser_close', {});
      } finally {
        await f1.client.close().catch(() => {});
        await f1.handle.shutdown();
      }
    }

    // =====================================================================
    // 11. Report retention (C29): configured policy cleans old reports.
    // =====================================================================
    {
      const rootRet = makeTmpRoot('yatt-ts-proto-ret-');
      roots.push(rootRet);
      const ret = await bootInMemory(dist, {
        paths: { root: rootRet },
        engine: { enabled: false },
        storage: { retention: { maxAgeDays: 1 } },
      });
      try {
        // Seed one old (5 days) and one fresh report, DB + mirror, directly.
        const seedDb = await dist.openDatabase(join(rootRet, 'yatt.db'));
        seedDb.run('INSERT INTO reports (name, content, updated_at) VALUES (?, ?, ?)', [
          'proto-retention-old',
          '{"kind":"test"}',
          Date.now() - 5 * 86_400_000,
        ]);
        seedDb.run('INSERT INTO reports (name, content, updated_at) VALUES (?, ?, ?)', [
          'proto-retention-new',
          '{"kind":"test"}',
          Date.now(),
        ]);
        seedDb.close();
        mkdirSync(join(rootRet, 'reports'), { recursive: true });
        writeFileSync(join(rootRet, 'reports', 'proto-retention-old.json'), '{"kind":"test"}', 'utf8');
        writeFileSync(join(rootRet, 'reports', 'proto-retention-new.json'), '{"kind":"test"}', 'utf8');

        const before = await jsonOf(ret.client, 'report_list');
        check('retention: both seeded reports listed', before.count === 2);

        // Deleting a report fires the retention pass (old one is beyond maxAgeDays).
        await jsonOf(ret.client, 'report_delete', { name: 'proto-retention-new' });
        // Join the (possibly already completed) retention chain; the DELETE is
        // observable below regardless of which pass did the cleanup.
        const result = await ret.handle.ctx.afterReportMutation?.();
        check('retention pass joins after report mutation (C29)', !!result, JSON.stringify(result));

        const after = await jsonOf(ret.client, 'report_list');
        check(
          'retention cleaned the old report (C29)',
          !after.reports.includes('proto-retention-old') && !after.reports.includes('proto-retention-new'),
          JSON.stringify(after),
        );
        check(
          'retention removed the old mirror file (C29)',
          !existsSync(join(rootRet, 'reports', 'proto-retention-old.json')),
        );
      } finally {
        await ret.client.close().catch(() => {});
        await ret.handle.shutdown();
      }
    }
  } finally {
    await new Promise<void>((r) => fixture.server.close(() => r()));
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }

  return failures;
}

/** Helper keeping the ephemeral-session/toolbar sections flat. */
function expectOpen(opened: { ok?: boolean }): void {
  if (opened.ok !== true) throw new Error(`browser_open failed: ${JSON.stringify(opened)}`);
}

// ---------------------------------------------------------------------------
// Dual-mode entry: vitest (guarded) OR standalone (bun, C23).
// ---------------------------------------------------------------------------

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
const isDirectRun =
  invoked !== '' &&
  (() => {
    try {
      return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
    } catch {
      return import.meta.url === invoked;
    }
  })();

if (isDirectRun) {
  // Standalone: `bun run test/e2e/protocol.smoke.mts` (or node with type-stripping).
  log = (line) => console.log(line);
  runProtocolSmoke()
    .then((failures) => {
      console.log(
        failures === 0
          ? '\nProtocol smoke: ALL GREEN'
          : `\nProtocol smoke: ${failures} FAILURE(S)`,
      );
      process.exit(failures ? 1 : 0);
    })
    .catch((err) => {
      console.error('Protocol smoke crashed:', err);
      process.exit(1);
    });
} else {
  // Vitest mode: guarded like the sibling smokes (fast default suite).
  const { describe, it, expect } = await import('vitest');
  const e2e = process.env.YATT_TS_E2E === '1' ? describe : describe.skip;
  e2e('protocol smoke — verification of record (T11)', () => {
    it(
      'full MCP protocol smoke over in-memory + stdio CLI + HTTP auth (real Chromium)',
      async () => {
        log = (line) => process.stdout.write(`${line}\n`);
        const failed = await runProtocolSmoke();
        if (failed > 0) {
          throw new Error(`protocol smoke: ${failed} check(s) failed — see the ok/FAIL log above`);
        }
        expect(failed).toBe(0);
      },
      900_000,
    );
  });
}
