/**
 * Runner spec (T8): command construction (runtime matrix C15, tmp outcome
 * path, timeout seconds rounding), saveReport=false skipping persistence,
 * dataset N rows → N invocations (C20), report persistence DB+mirror with a
 * fake CLI, and the mutating policy wiring (readOnly rejects test_run, C08).
 */
import { describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRunCommand, buildRunEnv, runTestDataset, runTestHeadless } from '../../src/mcp/run.js';
import { engineOptionsFromConfig } from '../../src/engine/options.js';
import { resolveEngineEntry } from '../../src/mcp/sidecar-client.js';
import { resolveConfig } from '../../src/config/index.js';
import { Store } from '../../src/store/index.js';
import type { Ctx } from '../../src/index.js';
import type { SpawnCli } from '../../src/mcp/run.js';
import {
  isError,
  jsonOf,
  makeTmpRoot,
  startWithClient,
  stop,
  textOf,
} from './helpers/mcp.js';

const FAKE_CLI = join(mkdtempSync(join(tmpdir(), 'yatt-runner-fixture-')), 'fake-cli.mjs');

// One CLI entry resolved like the runner does; the fake CLI is a standalone
// node script (no build needed).
const CLI_ENTRY = FAKE_CLI;
function makeCtx(root: string, overrides: Record<string, unknown> = {}): Ctx {
  const config = resolveConfig({ paths: { root }, ...overrides });
  return {
    config,
    root: config.paths.root,
    // Opened lazily per call site; the runner only needs upsert/report reads.
    store: null as unknown as Ctx['store'],
    sessionSink: {} as Ctx['sessionSink'],
    policy: { readOnly: false, denyBehavior: 'error' },
    sidecar: null,
    queryAppDb: null,
    afterReportMutation: async () => ({ deleted: [] }),
  };
}

/** Spawn mock that also writes the outcome JSON the runner reads back. */
function mockSpawnCli(): SpawnCli & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = {};
  const fn = (async (cmd, args, _options) => {
    (fn as any).calls ??= [];
    (fn as any).calls.push({ cmd, args });
    const jsonPath = args[args.indexOf('--json') + 1];
    if (jsonPath) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        jsonPath,
        JSON.stringify({ records: [], ok: 1, fail: 0, skipped: 0, stopped: false }),
      );
    }
    return { code: 0, stderr: '' };
  }) as SpawnCli & { calls: Array<{ cmd: string; args: string[] }> };
  return fn;
}

describe('buildRunCommand (pure construction)', () => {
  const base = {
    engineCliEntry: '/pkg/dist/engine/cli.js',
    testFile: '/root/tests/t.yatt.json',
    tmpJson: '/tmp/out.json',
    req: { name: 't' } as Parameters<typeof buildRunCommand>[0]['req'],
    defaultBrowser: 'chromium' as const,
  };

  it('auto → bun or node with the CLI entry and the run args', () => {
    const ok = buildRunCommand({ ...base, runtime: 'auto', probe: () => true });
    expect(ok.cmd).toBe('bun');
    expect(ok.args[0]).toBe('/pkg/dist/engine/cli.js');
    expect(ok.args.slice(1, 3)).toEqual(['run', '/root/tests/t.yatt.json']);
    const fallback = buildRunCommand({ ...base, runtime: 'auto', probe: () => false });
    expect(fallback.cmd).toBe('node');
  });

  it('binary runtime runs the binary directly with the CLI args appended', () => {
    const cmd = buildRunCommand({ ...base, runtime: '/opt/bridge', probe: () => true });
    expect(cmd.cmd).toBe('/opt/bridge');
    expect(cmd.args[0]).toBe('run');
  });

  it('emits the tmp outcome path, env, overrides, rounded timeout, browser and url', () => {
    const cmd = buildRunCommand({
      ...base,
      runtime: 'node',
      req: {
        name: 't',
        env: 'staging',
        overrides: { user: 'ada', pass: 's3cret' },
        stepTimeoutMs: 4500,
        url: 'https://example.dev',
      },
      defaultBrowser: 'firefox',
    });
    expect(cmd.args).toContain('/tmp/out.json');
    expect(cmd.args).toEqual([
      '/pkg/dist/engine/cli.js',
      'run',
      '/root/tests/t.yatt.json',
      '--json',
      '/tmp/out.json',
      '--env',
      'staging',
      '--override',
      'user=ada',
      '--override',
      'pass=s3cret',
      '--timeout',
      '5', // 4500 ms → rounded seconds
      '--browser',
      'firefox', // explicit/default browser always pinned
      '--url',
      'https://example.dev',
    ]);
  });

  it('rounds timeouts up to at least 1 second', () => {
    const cmd = buildRunCommand({
      ...base,
      runtime: 'node',
      req: { name: 't', stepTimeoutMs: 400 },
      defaultBrowser: 'chromium',
    });
    expect(cmd.args[cmd.args.indexOf('--timeout') + 1]).toBe('1');
  });

  it('resolves the in-package CLI entry (no base-repo references)', () => {
    const entry = resolveEngineEntry('cli.js');
    expect(entry).not.toContain('/Proyectos/');
  });
});

/**
 * F3: the one-shot CLI must receive the projected engine options (browser
 * defaults AND the custom artifact paths), otherwise viewport/timeouts/
 * toolbar/autoInstall are dead config for every headless run.
 */
describe('buildRunEnv (engine config projection)', () => {
  it('carries YATT_ENGINE_JSON with viewport, toolbar flag and the artifact paths (F3+F1)', async () => {
    const config = resolveConfig({
      paths: { root: '/tmp/yatt-f3', db: 'custom.db' },
      browser: {
        defaultViewport: { width: 1112, height: 666 },
        toolbarInjection: true,
      },
    });
    const env = await buildRunEnv(config.paths.root, null, engineOptionsFromConfig(config), {});
    expect(env.YATT_ROOT).toBe(config.paths.root);
    expect(env.YATT_APP_DB_JSON).toBeUndefined();
    const projected = JSON.parse(env.YATT_ENGINE_JSON!) as Record<string, unknown>;
    expect(projected.defaultViewport).toEqual({ width: 1112, height: 666 });
    expect(projected.toolbarInjection).toBe(true);
    expect(projected.defaultHeadless).toBe(true);
    // F1: paths ride along so the CLI opens the SAME db as the host store.
    expect(projected.db).toBe(config.paths.db);
    expect(projected.baselinesDir).toBe(config.paths.baselines);
    expect(projected.sessionsDir).toBe(config.paths.sessions);
  });

  it('carries the app-db JSON when configured (D22) and omits YATT_ENGINE_JSON without options', async () => {
    const config = resolveConfig({
      appDb: { type: 'sqlite', file: '/tmp/app.db' },
    });
    const env = await buildRunEnv('/tmp/root', config.appDb ?? null, undefined, {});
    expect(JSON.parse(env.YATT_APP_DB_JSON!)).toEqual({ type: 'sqlite', file: '/tmp/app.db' });
    expect(env.YATT_ENGINE_JSON).toBeUndefined();
  });
});

describe('runTestHeadless persistence', () => {
  it('saveReport: false skips the store write entirely', async () => {
    const root = makeTmpRoot();
    const store = await Store.open({ db: join(root, 'yatt.db'), tests: join(root, 'tests'), reports: join(root, 'reports') });
    await store.upsertTest('x', JSON.stringify({ schemaVersion: 1, steps: [] }));
    const ctx = { ...makeCtx(root), store };
    const spawn = mockSpawnCli();
    const summary = await runTestHeadless(
      ctx,
      { name: 'x', saveReport: false },
      { spawnCli: spawn, engineCliEntry: CLI_ENTRY },
    );
    expect(summary.ok).toBe(1);
    expect(summary.report).toBeUndefined();
    expect(store.reportList()).toEqual([]);
  });

  it('success path (fake CLI) writes the report to DB + mirror and passes retention', async () => {
    const root = makeTmpRoot();
    const store = await Store.open({ db: join(root, 'yatt.db'), tests: join(root, 'tests'), reports: join(root, 'reports') });
    await store.upsertTest('x', JSON.stringify({ schemaVersion: 1, steps: [] }));
    const ctx: Ctx = {
      ...makeCtx(root),
      store,
      afterReportMutation: async () => ({ deleted: ['hooked'] }),
    };
    let retentionRan = false;
    ctx.afterReportMutation = async () => {
      retentionRan = true;
      return { deleted: [] };
    };
    const spawn = mockSpawnCli();
    const summary = await runTestHeadless(
      ctx,
      { name: 'x', env: 'default' },
      { spawnCli: spawn, engineCliEntry: CLI_ENTRY },
    );
    expect(summary.ok).toBe(1);
    expect(summary.passedPct).toBe(100);
    expect(summary.report).toBeDefined();
    const names = store.reportList();
    expect(names.some((n) => n.endsWith('.json'))).toBe(true);
    expect(names.some((n) => n.endsWith('.html'))).toBe(true);
    expect(existsSync(join(root, 'reports', names[0]))).toBe(true); // mirror
    expect(retentionRan).toBe(true);
  });

  it('a CLI crash without outcome JSON fails with the stderr tail', async () => {
    const root = makeTmpRoot();
    const store = await Store.open({ db: join(root, 'yatt.db'), tests: join(root, 'tests'), reports: join(root, 'reports') });
    await store.upsertTest('x', JSON.stringify({ schemaVersion: 1, steps: [] }));
    const ctx = { ...makeCtx(root), store };
    await expect(
      runTestHeadless(ctx, { name: 'x' }, {
        spawnCli: async () => ({ code: 2, stderr: 'boom\ntrace line' }),
        engineCliEntry: CLI_ENTRY,
      }),
    ).rejects.toThrow('the run failed without a report: boom\ntrace line');
  });

  it('absent stepTimeoutMs falls back to config.runner.stepTimeoutMs through the tool surface (F3)', async () => {
    // Real end of the F3 wiring: the MCP tool runs the one-shot CLI (the fake
    // CLI, binary runtime) whose argv log proves which --timeout was sent.
    const root = makeTmpRoot();
    const fakeCli = join(root, 'fake-cli.mjs');
    copyFileSync(fileURLToPath(new URL('../fixtures/fake-cli.mjs', import.meta.url)), fakeCli);
    chmodSync(fakeCli, 0o755);
    const argvLog = join(root, 'argv.log');
    const { handle, client } = await startWithClient({
      paths: { root },
      engine: { runtime: fakeCli },
      runner: { stepTimeoutMs: 25000 },
    });
    process.env.YATT_FAKE_CLI_LOG = argvLog;
    try {
      await client.callTool({
        name: 'test_create',
        arguments: { content: { schemaVersion: 1, steps: [] }, name: 'x' },
      });
      // No stepTimeoutMs arg → the config default (25000 ms → 25 s) is used.
      await client.callTool({ name: 'test_run', arguments: { name: 'x' } });
      // Explicit arg → wins over the config default (5000 ms → 5 s).
      await client.callTool({
        name: 'test_run',
        arguments: { name: 'x', stepTimeoutMs: 5000 },
      });
    } finally {
      delete process.env.YATT_FAKE_CLI_LOG;
      await stop(handle, client);
    }
    const invocations = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[] });
    expect(invocations).toHaveLength(2);
    const timeoutOf = (argv: string[]) => argv[argv.indexOf('--timeout') + 1];
    expect(timeoutOf(invocations[0].argv)).toBe('25');
    expect(timeoutOf(invocations[1].argv)).toBe('5');
  });
});

describe('runTestDataset (C20)', () => {
  it('one sequential invocation per row with merged overrides', async () => {
    const root = makeTmpRoot();
    const store = await Store.open({ db: join(root, 'yatt.db'), tests: join(root, 'tests'), reports: join(root, 'reports') });
    await store.upsertTest('x', JSON.stringify({ schemaVersion: 1, steps: [] }));
    const ctx = { ...makeCtx(root), store };
    const spawn = mockSpawnCli();
    const result = await runTestDataset(
      ctx,
      { name: 'x', rows: [{ user: 'a' }, { user: 'b' }, { user: 'c' }] },
      { spawnCli: spawn, engineCliEntry: CLI_ENTRY },
    );
    expect(result.rows).toHaveLength(3);
    expect(result.ok).toBe(3);
    const calls = (spawn as any).calls as Array<{ args: string[] }>;
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toContain('user=a');
    expect(calls[1].args).toContain('user=b');
    expect(calls[2].args).toContain('user=c');
    // No reports for dataset rows.
    expect(store.reportList()).toEqual([]);
  });
});

describe('test_run tools through the MCP surface', () => {
  it('registers test_run + test_run_dataset (full catalog grows to 35 with the T9 browser tools)', async () => {
    const { handle, client } = await startWithClient({ paths: { root: makeTmpRoot() } });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain('test_run');
    expect(names).toContain('test_run_dataset');
    expect(names).toHaveLength(35);
    await stop(handle, client);
  });

  it('end-to-end run through the REAL spawn with the fake CLI (report DB+mirror)', async () => {
    const root = makeTmpRoot();
    // Executable wrapper: the binary runtime mode runs it directly with the
    // CLI arguments (C15 override path) — node resolves the shebang.
    const fakeCliTarget = join(root, 'fake-cli.mjs');
    copyFileSync(
      fileURLToPath(new URL('../fixtures/fake-cli.mjs', import.meta.url)),
      fakeCliTarget,
    );
    chmodSync(fakeCliTarget, 0o755);
    const { handle, client } = await startWithClient({
      paths: { root },
      engine: { runtime: fakeCliTarget, autoInstallBrowser: false },
    });
    await client.callTool({
      name: 'test_create',
      arguments: { content: { schemaVersion: 1, steps: [] }, name: 'x' },
    });
    const summary = await runTestHeadless(
      handle.ctx,
      { name: 'x' },
      { engineCliEntry: fakeCliTarget },
    );
    expect(summary.ok).toBe(1);
    expect(summary.report).toBeDefined();
    const reports = handle.ctx.store.reportList();
    expect(reports.length).toBe(2);
    expect(existsSync(join(root, 'reports', reports[0]))).toBe(true);
    const got = jsonOf(
      await client.callTool({ name: 'report_get', arguments: { name: reports[0] } }),
    );
    expect(got.report.kind).toBe('test');
    await stop(handle, client);
  });

  it('test_run of a missing test fails with a clear error', async () => {
    const { handle, client } = await startWithClient({ paths: { root: makeTmpRoot() } });
    const result = await client.callTool({ name: 'test_run', arguments: { name: 'nope' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('nope');
    await stop(handle, client);
  });

  it('readOnly rejects test_run with the policy reason (C08)', async () => {
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      permissions: { readOnly: true },
    });
    const result = await client.callTool({ name: 'test_run', arguments: { name: 'x' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('read-only mode');
    const dataset = await client.callTool({
      name: 'test_run_dataset',
      arguments: { name: 'x', rows: [{}] },
    });
    expect(isError(dataset)).toBe(true);
    await stop(handle, client);
  });
});

/** Covers the reports mirror directory listing used above. */
describe('reports mirror sanity', () => {
  it('mirror dir contains json+html after a persisted run', async () => {
    const root = makeTmpRoot();
    const store = await Store.open({ db: join(root, 'yatt.db'), tests: join(root, 'tests'), reports: join(root, 'reports') });
    await store.upsertTest('x', JSON.stringify({ schemaVersion: 1, steps: [] }));
    const ctx = { ...makeCtx(root), store };
    const spawn = mockSpawnCli();
    const summary = await runTestHeadless(
      ctx,
      { name: 'x', saveReport: true },
      { spawnCli: spawn, engineCliEntry: CLI_ENTRY },
    );
    expect(summary.report).toBeDefined();
    const files = readdirSync(join(root, 'reports')).sort();
    expect(files.length).toBe(2);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.html'))).toHaveLength(1);
    const json = JSON.parse(
      readFileSync(join(root, 'reports', files.find((f) => f.endsWith('.json'))!), 'utf8'),
    ) as { ok: number };
    expect(json.ok).toBe(1);
  });
});
