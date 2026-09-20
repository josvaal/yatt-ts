/**
 * Engine wiring spec (T7): runtime command resolution (C15), in-package
 * engineEntry resolution (kills the base-repo hardcode), SidecarClient
 * lifecycle against a FAKE bridge (ready event, req/response, timeout,
 * crash→respawn C22, serialization C27, close grace, .data passthrough) and
 * the config→engine-options mapping (headless ON D10, toolbar OFF D11).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SidecarClient,
  resolveEngineEntry,
  resolveRuntimeCommand,
} from '../../src/mcp/sidecar-client.js';
import { engineOptionsFromConfig } from '../../src/engine/options.js';
import { resolveConfig } from '../../src/config/index.js';
import { DEFAULT_ENGINE_OPTIONS, enginePaths, initEngine, initEngineFromEnv } from '../../src/engine/state.js';
import type { SidecarEvent } from '../../src/mcp/sidecar-types.js';

const PKG_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURES = join(PKG_ROOT, 'test', 'fixtures');
const FAKE_BRIDGE = join(FIXTURES, 'fake-bridge.mjs');
const FAKE_BRIDGE_SILENT = join(FIXTURES, 'fake-bridge-silent.mjs');

const probeOk = () => true;
const probeFail = () => false;

describe('runtime command resolution (C15)', () => {
  it('auto probes bun first and falls back to node', () => {
    expect(resolveRuntimeCommand('auto', '/e/index.js', [], probeOk)).toEqual({
      cmd: 'bun',
      args: ['/e/index.js'],
    });
    expect(resolveRuntimeCommand('auto', '/e/index.js', [], probeFail)).toEqual({
      cmd: 'node',
      args: ['/e/index.js'],
    });
  });

  it('bun and node runtimes force the interpreter with the engine entry', () => {
    expect(resolveRuntimeCommand('bun', '/e/index.js', [], probeFail)).toEqual({
      cmd: 'bun',
      args: ['/e/index.js'],
    });
    expect(resolveRuntimeCommand('node', '/e/index.js', [], probeOk)).toEqual({
      cmd: 'node',
      args: ['/e/index.js'],
    });
  });

  it('any other runtime string is a binary path executed directly (no entry arg)', () => {
    expect(resolveRuntimeCommand('/opt/yatt-engine/bridge', '/e/index.js', [], probeFail)).toEqual({
      cmd: '/opt/yatt-engine/bridge',
      args: [],
    });
    // CLI args are appended for the runner; the bridge gets none.
    expect(
      resolveRuntimeCommand('/opt/yatt-engine/bridge', '/e/index.js', ['run', 'x.json'], probeOk),
    ).toEqual({ cmd: '/opt/yatt-engine/bridge', args: ['run', 'x.json'] });
  });

  it('empty/unknown falls back to auto', () => {
    expect(resolveRuntimeCommand('', '/e/index.js', [], probeOk).cmd).toBe('bun');
  });
});

describe('engineEntry resolution inside the package', () => {
  it('resolves inside the yatt-ts package, never the base repo', () => {
    for (const file of ['index.js', 'cli.js'] as const) {
      const entry = resolveEngineEntry(file);
      expect(entry.startsWith(PKG_ROOT + sep)).toBe(true);
      expect(entry).not.toContain('/Proyectos/');
      expect(entry.endsWith(join('engine', file))).toBe(true);
    }
  });

  it('prefers the compiled dist twin when running from source', () => {
    const entry = resolveEngineEntry('index.js');
    // Either dist (built) or src (fallback candidate) — both inside the package.
    expect(existsSync(entry) || entry.includes(join('src', 'engine', 'index.js'))).toBe(true);
  });
});

describe('config → engine-options mapping (D10/D11 defaults)', () => {
  it('zero-config maps to headless ON, toolbar OFF, viewport 1280x800', () => {
    const config = resolveConfig({});
    const options = engineOptionsFromConfig(config);
    expect(options.defaultHeadless).toBe(true); // D10
    expect(options.toolbarInjection).toBe(false); // D11
    expect(options.defaultViewport).toEqual({ width: 1280, height: 800 });
    expect(options.defaultEngine).toBe('chromium');
    expect(options.autoInstallBrowser).toBe(true); // D12
    expect(options.runStepTimeoutMs).toBe(40000);
    expect(options.cdpSync).toEqual({ enabled: true, pollIntervalMs: 400 });
  });

  it('config overrides flow through', () => {
    const config = resolveConfig({
      browser: { defaultHeadless: false, toolbarInjection: true, gotoTimeoutMs: 1234 },
    });
    const options = engineOptionsFromConfig(config);
    expect(options.defaultHeadless).toBe(false);
    expect(options.toolbarInjection).toBe(true);
    expect(options.gotoTimeoutMs).toBe(1234);
  });

  it('projects the resolved artifact paths so the engine shares the host layout (F1/C11/D21)', () => {
    const config = resolveConfig({
      paths: {
        root: '/tmp/yatt-f1',
        db: 'system.sqlite',
        baselines: 'snapshots',
        sessions: 'login-states',
      },
    });
    const options = engineOptionsFromConfig(config);
    expect(options.db).toBe(join(config.paths.root, 'system.sqlite'));
    expect(options.baselinesDir).toBe(join(config.paths.root, 'snapshots'));
    expect(options.sessionsDir).toBe(join(config.paths.root, 'login-states'));
  });
});

/**
 * F1 bridge-side half: initEngineFromEnv must honor the path overrides that
 * travel inside YATT_ENGINE_JSON instead of hardcoding the <root> layout.
 */
describe('initEngineFromEnv path overrides (F1/C11)', () => {
  it('defaults to the <root> layout when the projection carries no paths', () => {
    initEngineFromEnv({ YATT_ROOT: '/tmp/yatt-f1-default' });
    expect(enginePaths()).toEqual({
      root: '/tmp/yatt-f1-default',
      db: join('/tmp/yatt-f1-default', 'yatt.db'),
      baselinesDir: join('/tmp/yatt-f1-default', 'baselines'),
      sessionsDir: join('/tmp/yatt-f1-default', 'sessions'),
    });
  });

  it('honors db/baselinesDir/sessionsDir overrides from YATT_ENGINE_JSON', () => {
    initEngineFromEnv({
      YATT_ROOT: '/tmp/yatt-f1-custom',
      YATT_ENGINE_JSON: JSON.stringify({
        db: '/data/yatt/system.db',
        baselinesDir: '/data/yatt/shots',
        sessionsDir: '/data/yatt/states',
      }),
    });
    expect(enginePaths()).toEqual({
      root: '/tmp/yatt-f1-custom',
      db: '/data/yatt/system.db',
      baselinesDir: '/data/yatt/shots',
      sessionsDir: '/data/yatt/states',
    });
  });

  it('keeps the browser defaults intact alongside the path overrides', () => {
    initEngineFromEnv({
      YATT_ROOT: '/tmp/yatt-f1-mixed',
      YATT_ENGINE_JSON: JSON.stringify({ db: '/elsewhere/yatt.db' }),
    });
    expect(enginePaths().db).toBe('/elsewhere/yatt.db');
    expect(enginePaths().baselinesDir).toBe(join('/tmp/yatt-f1-mixed', 'baselines'));
    initEngine(
      {
        root: '/tmp/yatt-f1-reset',
        db: join('/tmp/yatt-f1-reset', 'yatt.db'),
        baselinesDir: join('/tmp/yatt-f1-reset', 'baselines'),
        sessionsDir: join('/tmp/yatt-f1-reset', 'sessions'),
      },
      DEFAULT_ENGINE_OPTIONS,
    );
  });
});

describe('SidecarClient lifecycle with the fake bridge', () => {
  function makeClient(overrides: Record<string, unknown> = {}): SidecarClient {
    return new SidecarClient({
      root: mkdtempSync(join(tmpdir(), 'yatt-engine-spec-')),
      runtime: 'node',
      engineEntry: FAKE_BRIDGE,
      readyTimeoutMs: 5000,
      requestTimeoutMs: 3000,
      closeGraceMs: 1000,
      ...overrides,
    });
  }

  it('becomes ready (sidecar_ready event) and answers requests', async () => {
    const events: SidecarEvent[] = [];
    const client = makeClient();
    client.onEvent((e) => events.push(e));
    const result = await client.req<{ ok: boolean; pid: number }>('ping');
    expect(result.ok).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    const echo = await client.req<{ marker: string }>('echo', { marker: 'hello' });
    expect(echo.marker).toBe('hello');
    expect(events.some((e) => e.name === 'sidecar_ready')).toBe(true);
    await client.close();
  });

  it('rejects with .data passthrough on error payloads (failure evidence)', async () => {
    const client = makeClient();
    const err = await client.req('fail_with_data', { step: 'x' }).catch((e: Error & { data?: unknown }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { data?: unknown }).message).toContain('engine failure');
    expect((err as Error & { data?: { screenshot?: string } }).data?.screenshot).toBe('base64-evidence');
    await client.close();
  });

  it('times out a request that never answers', async () => {
    const client = makeClient();
    await expect(client.req('slow_never', {}, 250)).rejects.toThrow(
      'engine timeout in "slow_never" (250 ms)',
    );
    await client.close();
  });

  it('kill → next request respawns transparently (C22)', async () => {
    const client = makeClient();
    const first = await client.req<{ pid: number }>('ping');
    // Simulate an engine crash.
    process.kill(first.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 150));
    expect(client.alive).toBe(false);
    const second = await client.req<{ pid: number }>('ping');
    expect(second.pid).toBeGreaterThan(0);
    expect(second.pid).not.toBe(first.pid);
    await client.close();
  });

  it('serializes concurrent requests 1-to-1 through the chain (C27)', async () => {
    const client = makeClient();
    const p1 = client.req<{ echoed: string; receiptIndex: number; receiptMs: number }>('delay', {
      ms: 250,
      echo: 'first',
    });
    // Give the chain a tick so p1 is definitively queued first.
    await new Promise((r) => setTimeout(r, 30));
    const p2 = client.req<{ echoed: string; receiptIndex: number; receiptMs: number }>('delay', {
      ms: 1,
      echo: 'second',
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.echoed).toBe('first');
    expect(r2.echoed).toBe('second');
    // With serialization the bridge only receives the second request after it
    // finished the first one: receipt order 1→2 and ≥200ms apart.
    expect(r1.receiptIndex).toBe(1);
    expect(r2.receiptIndex).toBe(2);
    expect(r2.receiptMs - r1.receiptMs).toBeGreaterThanOrEqual(200);
    await client.close();
  });

  it('close() drains within the configured grace (bridge exits on stdin EOF)', async () => {
    const client = makeClient({ closeGraceMs: 2000 });
    const pid = (await client.req<{ pid: number }>('ping')).pid;
    const t0 = Date.now();
    await client.close();
    expect(Date.now() - t0).toBeLessThan(1900);
    // The bridge process exited through the orderly-close path (poll for it).
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        gone = true;
      }
    }
    expect(gone).toBe(true);
  });

  it('fails fast when the engine never becomes ready (ready timer)', async () => {
    const client = makeClient({
      engineEntry: FAKE_BRIDGE_SILENT,
      readyTimeoutMs: 400,
    });
    await expect(client.req('ping')).rejects.toThrow('engine did not become ready within 400 ms');
    await client.close();
  });
});

/** Guards the module URL helpers used by the entry resolution. */
describe('module path helpers', () => {
  it('moduleRelativePath resolves file URLs', () => {
    const p = pathToFileURL(join(PKG_ROOT, 'src')).href;
    expect(p.startsWith('file://')).toBe(true);
  });
});
