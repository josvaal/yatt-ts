/**
 * Packaging proof (T13, C24/C23): `npm pack` → fresh consumer install →
 * the installed package actually boots and serves MCP.
 *
 * Run manually (plain node, no test runner):
 *
 *   npm run build && node test/e2e/install.mjs
 *
 * Steps:
 *   1. `npm pack --json` → yatt-ts-0.1.0.tgz + the exact file list.
 *   2. ASSERT the tarball ships dist/index.js, dist/index.d.ts, dist/cli.js,
 *      dist/engine/** (bridge + CLI), package.json, README.md, LICENSE — and
 *      does NOT ship src/ or test/.
 *   3. Node consumer: tmp dir → `npm install <tgz>` → boot createYattServer
 *      from the installed package (tmp root, engine disabled, fast) → ping
 *      over an in-memory transport → ok. THEN mount `createMcpHttpHandler`
 *      on a tiny raw node:http route `/mcp` (C39: the export works from the
 *      packed build — no express needed in the consumer), complete a full
 *      initialize + ping through it, terminate the session and close.
 *      FINALLY boot a third server with `appDb: { type: 'provider' }` — a
 *      plain JS function in the consumer — and prove db_query returns the
 *      consumer's own rows (C50).
 *   4. Bun consumer: second tmp dir → `bun install <tgz>` → import VERSION +
 *      resolve a config (dual-runtime packaging proof, C23).
 *   5. Clean up every tmp dir. Exits non-zero on any failure.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRED_FILES = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli.js',
  'dist/engine/index.js',
  'dist/engine/cli.js',
  'package.json',
  'README.md',
  'LICENSE',
];

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
  return ok;
}
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? PROJECT_ROOT,
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  });
  if (opts.allowFailure) return res;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (code ${res.status}):\n${res.stderr ?? ''}`);
  }
  return res;
}

function packInto(dest) {
  const out = run('npm', ['pack', '--json', '--pack-destination', dest], { capture: true });
  const parsed = JSON.parse(out.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return { filename: entry.filename, files: entry.files.map((f) => f.path) };
}

/** Node consumer: install the tarball and boot the installed package. */
function nodeConsumerCheck(tgz, consumerDir) {
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'yatt-ts-consumer-node', private: true, type: 'module' }, null, 2),
  );
  run('npm', ['install', tgz, '--no-audit', '--no-fund', '--loglevel', 'error'], {
    cwd: consumerDir,
  });
  writeFileSync(
    join(consumerDir, 'consumer.mjs'),
    `// Fresh-consumer proof: everything imported from the INSTALLED package.
import { createMcpHttpHandler, createYattServer, VERSION } from 'yatt-ts';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// 1) Boot + in-memory ping (kept from the original proof).
const handle = await createYattServer({
  paths: { root: ${JSON.stringify(join(consumerDir, 'data'))} },
  engine: { enabled: false }, // fast: no Chromium needed for this check
});
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'consumer', version: '0.0.0' });
await Promise.all([handle.start(serverTransport), client.connect(clientTransport)]);
const ping = JSON.parse(
  (await client.callTool({ name: 'ping', arguments: {} })).content[0].text,
);
if (ping.ok !== true || ping.engine !== 'deferred') {
  console.error('unexpected ping:', JSON.stringify(ping));
  process.exit(1);
}
if (VERSION !== '0.1.0') {
  console.error('unexpected VERSION:', VERSION);
  process.exit(1);
}
console.log('NODE CONSUMER OK — installed yatt-ts boots and pings');
await client.close();
await handle.shutdown();

// 2) HTTP handler embedding proof (C39): mount createMcpHttpHandler on a
//    tiny raw node:http route /mcp, initialize + ping through it, terminate
//    the session, close. Proves the export ships in the packed build.
const httpHandle = await createYattServer({
  paths: { root: ${JSON.stringify(join(consumerDir, 'data-http'))} },
  engine: { enabled: false },
});
const mcp = createMcpHttpHandler(httpHandle);
const httpServer = createHttpServer((req, res) => {
  if (req.url === '/mcp') {
    void mcp.handle(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const mcpUrl = 'http://127.0.0.1:' + httpServer.address().port + '/mcp';
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const init = await fetch(mcpUrl, {
  method: 'POST',
  headers: JSON_HEADERS,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'consumer', version: '0.0.0' },
    },
  }),
});
if (!init.ok) {
  console.error('handler initialize failed:', init.status);
  process.exit(1);
}
const session = init.headers.get('mcp-session-id');
if (!session) {
  console.error('no mcp-session-id from the mounted handler');
  process.exit(1);
}

/** Extracts the JSON-RPC payload out of a JSON or SSE body. */
const payloadOf = async (res) => {
  const raw = await res.text();
  return JSON.parse(raw.startsWith('{') ? raw : /^data: (.*)$/m.exec(raw)?.[1] ?? '{}');
};

const pingRes = await fetch(mcpUrl, {
  method: 'POST',
  headers: { ...JSON_HEADERS, 'mcp-session-id': session },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'ping', arguments: {} },
  }),
});
const pingJson = JSON.parse((await payloadOf(pingRes)).result?.content?.[0]?.text ?? '{}');
if (pingJson.ok !== true || pingJson.engine !== 'deferred') {
  console.error('unexpected handler ping:', JSON.stringify(pingJson));
  process.exit(1);
}
console.log('NODE CONSUMER OK — createMcpHttpHandler serves initialize + ping over raw node:http');

const term = await fetch(mcpUrl, {
  method: 'DELETE',
  headers: { 'mcp-session-id': session },
});
if (!term.ok) {
  console.error('handler session DELETE failed:', term.status);
  process.exit(1);
}
await mcp.close();
await httpHandle.shutdown();
httpServer.closeAllConnections?.();
await new Promise((resolve) => httpServer.close(resolve));

// 3) appDb provider proof (C50): the host supplies its own query function
//    (plain JS in the fresh consumer) and db_query executes through it.
const providerCalls = [];
const providerHandle = await createYattServer({
  paths: { root: ${JSON.stringify(join(consumerDir, 'data-provider'))} },
  engine: { enabled: false },
  appDb: {
    type: 'provider',
    provider: async (sql) => {
      providerCalls.push(sql);
      return [{ id: 1, note: 'from-host-provider' }];
    },
  },
});
const [pServerT, pClientT] = InMemoryTransport.createLinkedPair();
const providerClient = new Client({ name: 'consumer-provider', version: '0.0.0' });
await Promise.all([providerHandle.start(pServerT), providerClient.connect(pClientT)]);
const dbOut = JSON.parse(
  (
    await providerClient.callTool({
      name: 'db_query',
      arguments: { sql: 'SELECT id, note FROM notes' },
    })
  ).content[0].text,
);
if (providerCalls.length !== 1 || providerCalls[0] !== 'SELECT id, note FROM notes') {
  console.error('provider did not receive the verbatim SQL:', JSON.stringify(providerCalls));
  process.exit(1);
}
if (dbOut.totalRows !== 1 || dbOut.rows[0][1] !== 'from-host-provider') {
  console.error('unexpected db_query output:', JSON.stringify(dbOut));
  process.exit(1);
}
const denied = await providerClient.callTool({
  name: 'db_query',
  arguments: { sql: 'DELETE FROM notes' },
});
if (denied.isError !== true || !JSON.stringify(denied).includes('read-only')) {
  console.error('read-only guard missing in provider mode');
  process.exit(1);
}
console.log('NODE CONSUMER OK — appDb provider serves db_query from the host function (read-only enforced)');
await providerClient.close();
await providerHandle.shutdown();
`,
  );
  const res = run('node', ['consumer.mjs'], { cwd: consumerDir, capture: true, allowFailure: true });
  return { ok: res.status === 0, detail: res.status === 0 ? 'NODE CONSUMER OK' : (res.stderr ?? '').slice(-400) };
}

/** Bun consumer: install the tarball and exercise the API surface. */
function bunConsumerCheck(tgz, consumerDir) {
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'yatt-ts-consumer-bun', private: true, type: 'module' }, null, 2),
  );
  run('bun', ['install', tgz], { cwd: consumerDir });
  writeFileSync(
    join(consumerDir, 'consumer-bun.mjs'),
    `// Bun consumer proof (C23): the installed package works under Bun.
import { VERSION, resolveConfig } from 'yatt-ts';

if (VERSION !== '0.1.0') {
  console.error('unexpected VERSION:', VERSION);
  process.exit(1);
}
const config = resolveConfig({ paths: { root: ${JSON.stringify(join(consumerDir, 'data'))} } });
if (config.engine.enabled !== true || config.browser.defaultHeadless !== true) {
  console.error('unexpected resolved config defaults');
  process.exit(1);
}
console.log('BUN CONSUMER OK — installed yatt-ts imports and resolves config');
`,
  );
  const res = run('bun', ['run', 'consumer-bun.mjs'], { cwd: consumerDir, capture: true, allowFailure: true });
  return { ok: res.status === 0, detail: res.status === 0 ? 'BUN CONSUMER OK' : (res.stderr ?? '').slice(-400) };
}

function main() {
  console.log(`packaging proof for yatt-ts (root: ${PROJECT_ROOT})`);
  const packDir = mkdtempSync(join(tmpdir(), 'yatt-ts-pack-'));
  const consumerNode = mkdtempSync(join(tmpdir(), 'yatt-ts-consumer-node-'));
  const consumerBun = mkdtempSync(join(tmpdir(), 'yatt-ts-consumer-bun-'));
  try {
    // ---- 1-2. Pack + ship list ----
    const { filename, files } = packInto(packDir);
    const tgz = join(packDir, filename);
    check(`npm pack produced ${filename}`, filename === 'yatt-ts-0.1.0.tgz', `${files.length} files`);
    for (const required of REQUIRED_FILES) {
      check(`tarball ships ${required}`, files.includes(required));
    }
    check('tarball ships dist/engine/** (bridge + cli)', files.some((f) => f.startsWith('dist/engine/')));
    check('tarball does NOT ship src/', !files.some((f) => f === 'src' || f.startsWith('src/')));
    check('tarball does NOT ship test/', !files.some((f) => f === 'test' || f.startsWith('test/')));

    // ---- 3. Node consumer ----
    const nodeResult = nodeConsumerCheck(tgz, consumerNode);
    check(
      'node consumer: install + boot + ping + raw-http handler + appDb provider db_query (C24, C39, C50)',
      nodeResult.ok,
      nodeResult.detail,
    );

    // ---- 4. Bun consumer ----
    const bunResult = bunConsumerCheck(tgz, consumerBun);
    check('bun consumer: install + import + config resolve (C23/C24)', bunResult.ok, bunResult.detail);
  } finally {
    for (const dir of [packDir, consumerNode, consumerBun]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(failures === 0 ? '\nPackaging proof: ALL GREEN' : `\nPackaging proof: ${failures} FAILURE(S)`);
  process.exit(failures ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('Packaging proof crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
