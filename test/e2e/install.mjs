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
 *      over an in-memory transport → ok.
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
import { createYattServer, VERSION } from 'yatt-ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
    check('node consumer: install + boot + in-memory ping (C24)', nodeResult.ok, nodeResult.detail);

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
