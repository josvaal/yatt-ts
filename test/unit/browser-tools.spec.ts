/**
 * Browser tools spec (T9, C09/C10/C18 groundwork): exercises the 16 browser
 * tools through a REAL MCP server (registrar + policy middleware) whose
 * engine is the FAKE bridge fixture (test/fixtures/fake-bridge.mjs) — fast
 * and self-contained, no browser.
 *
 * Covered: open/close/status roundtrip, browser_open session restore (inline
 * storageState for the MEMORY sink, session name for the persistent sink),
 * run_step vars forwarding + failure evidence passthrough, condition
 * polling, preview/scroll/click_at PNG image blocks, eval serialization caps,
 * tabs cycle, session save/list/delete in BOTH sink modes (memory mode
 * asserts ZERO new files under the root), policy (read-only, deny error/hide)
 * and the engine-disabled error.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../../src/config/index.js';
import type { ResolvedConfig } from '../../src/config/index.js';
import { getStrings } from '../../src/i18n/index.js';
import { createToolRegistrar } from '../../src/mcp/policy-middleware.js';
import type { Ctx } from '../../src/mcp/ctx.js';
import { SidecarClient } from '../../src/mcp/sidecar-client.js';
import { registerBrowserTools } from '../../src/mcp/tools/browser.js';
import type { ToolPolicy } from '../../src/security/index.js';
import { createSessionSink, Store } from '../../src/store/index.js';
import type { RetentionResult, SessionSink } from '../../src/store/index.js';

const PKG_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FAKE_BRIDGE = join(PKG_ROOT, 'test', 'fixtures', 'fake-bridge.mjs');

interface BootOptions {
  persist?: boolean;
  readOnly?: boolean;
  denyTools?: string[];
  denyBehavior?: 'error' | 'hide';
  withEngine?: boolean;
}

interface Booted {
  root: string;
  config: ResolvedConfig;
  ctx: Ctx;
  client: Client;
  sidecar: SidecarClient | null;
  store: Store;
  sink: SessionSink;
  close(): Promise<void>;
}

const opened: Booted[] = [];

async function boot(opts: BootOptions = {}): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), 'yatt-ts-browser-tools-'));
  const config = resolveConfig({
    paths: { root },
    sessions: { persist: opts.persist ?? true },
    permissions: {
      readOnly: opts.readOnly ?? false,
      ...(opts.denyTools ? { denyTools: opts.denyTools } : {}),
      ...(opts.denyBehavior ? { denyBehavior: opts.denyBehavior } : {}),
    },
  });
  const store = await Store.open({
    db: config.paths.db,
    tests: config.paths.tests,
    reports: config.paths.reports,
  });
  const sink = createSessionSink(config, store);
  const policy: ToolPolicy = {
    readOnly: config.permissions.readOnly,
    ...(config.permissions.allowTools ? { allowTools: [...config.permissions.allowTools] } : {}),
    ...(config.permissions.denyTools ? { denyTools: [...config.permissions.denyTools] } : {}),
    denyBehavior: config.permissions.denyBehavior,
  };

  // Real SidecarClient pointed at the fake bridge fixture (same pattern as
  // engine.spec.ts): the tools exercise the actual spawn/req lifecycle.
  let sidecar: SidecarClient | null = null;
  if (opts.withEngine !== false) {
    sidecar = new SidecarClient({
      root,
      runtime: 'node',
      engineEntry: FAKE_BRIDGE,
      readyTimeoutMs: 10000,
      requestTimeoutMs: 15000,
      closeGraceMs: 1000,
      probe: () => true,
    });
  }

  const ctx: Ctx = {
    config,
    root,
    store,
    sessionSink: sink,
    policy,
    sidecar,
    queryAppDb: null,
    afterReportMutation: (): Promise<RetentionResult> => Promise.resolve({ deleted: [] }),
  };

  const server = new McpServer(
    { name: 'yatt', version: 'test' },
    { capabilities: { tools: {} } },
  );
  const registrar = createToolRegistrar(server, ctx);
  registerBrowserTools(registrar, ctx, getStrings('en'));

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const booted: Booted = {
    root,
    config,
    ctx,
    client,
    sidecar,
    store,
    sink,
    close: async () => {
      await client.close();
      await server.close();
      await sidecar?.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  opened.push(booted);
  return booted;
}

afterEach(async () => {
  while (opened.length > 0) {
    await opened.pop()!.close();
  }
});

async function call(client: Client, name: string, args?: Record<string, unknown>): Promise<any> {
  return client.callTool({ name, arguments: args ?? {} });
}

function textOf(result: any): string {
  return ((result?.content ?? []) as Array<{ type: string; text?: string }>)
    .map((b) => b.text ?? '')
    .join('\n');
}

function jsonOf(result: any): any {
  return JSON.parse(textOf(result));
}

function imageBlocks(result: any): Array<{ type: string; data?: string; mimeType?: string }> {
  return ((result?.content ?? []) as Array<{ type: string }>).filter((b) => b.type === 'image');
}

/** Recursive fs snapshot: relative path → size+mtime, to prove zero writes. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        const st = statSync(full);
        out.set(rel, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir, '');
  return out;
}

async function engineRecord(sidecar: SidecarClient): Promise<any> {
  return sidecar.req('__record');
}

describe('browser tools — live control (fake bridge)', () => {
  it('open/close/status roundtrip keeps the base envelopes', async () => {
    const { client } = await boot();
    const open = await call(client, 'browser_open', { url: 'https://example.test/' });
    expect(jsonOf(open)).toMatchObject({ ok: true, open: true });

    const status = await call(client, 'browser_status');
    expect(jsonOf(status)).toMatchObject({ open: true, browser: 'chromium' });

    const closed = await call(client, 'browser_close');
    expect(jsonOf(closed)).toEqual({ ok: true, open: false });
  });

  it('omitted headless sends NO headless key so the engine default applies (F5/D10)', async () => {
    const { client, sidecar } = await boot();
    await call(client, 'browser_open', { url: 'https://example.test/', viewport: { width: 800 } });
    const record = await engineRecord(sidecar!);
    // F5 regression: the key must be ABSENT (not forced true) so the engine's
    // `params.headless ?? options.defaultHeadless` fallback is reachable.
    expect(record.lastOpen).not.toHaveProperty('headless');
    expect(record.lastOpen).toMatchObject({
      url: 'https://example.test/',
      variables: [],
      viewport: { width: 800 },
    });
  });

  it('explicit headless true/false is forwarded verbatim (F5/D10)', async () => {
    const { client, sidecar } = await boot();
    await call(client, 'browser_open', { headless: false });
    expect((await engineRecord(sidecar!)).lastOpen).toMatchObject({ headless: false });
    await call(client, 'browser_open', { headless: true });
    expect((await engineRecord(sidecar!)).lastOpen).toMatchObject({ headless: true });
  });

  it('browser_preview and scroll/click_at return PNG image content blocks', async () => {
    const { client } = await boot();
    await call(client, 'browser_open');

    const preview = await call(client, 'browser_preview');
    const previewMeta = jsonOf(preview);
    expect(previewMeta).toMatchObject({ url: 'about:blank', width: 1280, height: 800 });
    expect(imageBlocks(preview)).toEqual([
      { type: 'image', mimeType: 'image/png', data: expect.stringMatching(/^iVBOR/) },
    ]);

    const scrolled = await call(client, 'browser_scroll', { dy: 300 });
    expect(jsonOf(scrolled)).toHaveProperty('scrollY');
    expect(imageBlocks(scrolled)).toHaveLength(1);

    const clicked = await call(client, 'browser_click_at', { x: 10, y: 20 });
    expect(jsonOf(clicked)).toMatchObject({ selector: '[data-testid="target"]', tag: 'button' });
    expect(imageBlocks(clicked)).toHaveLength(1);
  });

  it('browser_eval serializes results with depth/item/length caps', async () => {
    const { client } = await boot();
    await call(client, 'browser_open');

    // Deep object: beyond depth 4 everything collapses to the cap marker
    // (the MCP envelope adds the `value` wrapper, so depth counts from it).
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
    const deepResult = await call(client, 'browser_eval', {
      expression: `__json:${JSON.stringify(deep)}`,
    });
    expect(jsonOf(deepResult).value.a.b.c.d).toEqual({ e: '[maximum depth]' });

    // Arrays are capped at 100 items.
    const long = await call(client, 'browser_eval', {
      expression: `__json:${JSON.stringify(Array.from({ length: 150 }, (_, i) => i))}`,
    });
    expect(jsonOf(long).value).toHaveLength(100);

    // Long strings are cut at 8000 chars + ellipsis.
    const longString = await call(client, 'browser_eval', {
      expression: `__json:${JSON.stringify('x'.repeat(9000))}`,
    });
    const value = jsonOf(longString).value as string;
    expect(value).toHaveLength(8001);
    expect(value.endsWith('…')).toBe(true);
  });

  it('run_step forwards step/timeout/vars, interpolates vars and returns evidence on ok AND failure', async () => {
    const { client, sidecar } = await boot();
    await call(client, 'browser_open');

    const ok = await call(client, 'browser_run_step', {
      step: { action: 'type', selector: '#name', value: '{{user}}' },
      timeoutMs: 5000,
      vars: { user: 'Ada' },
    });
    const okMeta = jsonOf(ok);
    expect(okMeta).toEqual({ name: 'type', ok: true, ms: 5 });
    expect(imageBlocks(ok)).toHaveLength(1);

    // The vars reached the engine and the engine-side interpolation applied.
    const record = await engineRecord(sidecar!);
    expect(record.lastRunStep.vars).toEqual({ user: 'Ada' });
    expect(record.lastRunStep.step.value).toBe('{{user}}');
    expect(record.lastRunStepResolved).toMatchObject({ action: 'type', value: 'Ada' });

    // Failure: the tool DOES NOT throw — it returns ok:false with the error
    // and the failure screenshot carried in the rejected result's `.data`.
    const failed = await call(client, 'browser_run_step', {
      step: { action: 'click', selector: '#fail' },
    });
    expect(failed.isError).toBeUndefined();
    expect(jsonOf(failed)).toEqual({ name: 'click', ok: false, error: 'boom' });
    expect(imageBlocks(failed)).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'ZmFpbHVyZS1ldmlkZW5jZQ==' },
    ]);

    // A step without an action fails with the localized message.
    const bad = await call(client, 'browser_run_step', { step: { selector: '#x' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('step must be an object with an action');
  });

  it('browser_condition polls until the condition holds (timeoutMs > 0)', async () => {
    const { client } = await boot();
    await call(client, 'browser_open');

    const single = await call(client, 'browser_condition', { selector: '#missing' });
    expect(jsonOf(single)).toMatchObject({ value: false });

    const polled = await call(client, 'browser_condition', {
      selector: '#exists',
      timeoutMs: 200,
      intervalMs: 50,
    });
    const polledJson = jsonOf(polled);
    expect(polledJson.value).toBe(true);
    // The fake bridge settles the poll window (≤250ms): elapsed reflects it.
    expect(polledJson.elapsedMs).toBeGreaterThanOrEqual(150);
  });

  it('tabs cycle: open → list → switch → close', async () => {
    const { client } = await boot();
    await call(client, 'browser_open');

    const openedList = await call(client, 'tab_open', { url: 'https://example.test/other' });
    expect(jsonOf(openedList).tabs).toHaveLength(2);
    expect(jsonOf(openedList).tabs[1]).toMatchObject({ active: true, url: 'https://example.test/other' });

    const switched = await call(client, 'tab_switch', { index: 0 });
    expect(jsonOf(switched).tabs[0]).toMatchObject({ index: 0, active: true });

    const list = await call(client, 'tab_list');
    expect(jsonOf(list).tabs).toHaveLength(2);

    const closed = await call(client, 'tab_close', { index: 1 });
    expect(jsonOf(closed).tabs).toHaveLength(1);
  });
});

describe('sessions toggle (D7, C09/C10)', () => {
  it('persistent mode: save → list → delete round-trips through DB + mirror (C10)', async () => {
    const { client, store, config } = await boot({ persist: true });

    const saved = await call(client, 'session_save', { name: 'qa-session' });
    expect(jsonOf(saved)).toEqual({ ok: true, name: 'qa-session' });

    // DB is source of truth + mirror written in the same operation.
    expect(store.sessionGet('qa-session')).toContain('cookies');
    const mirror = join(config.paths.sessions, 'qa-session.json');
    expect(statSyncSafe(mirror)).not.toBeNull();

    const list = await call(client, 'session_list');
    expect(jsonOf(list)).toEqual({ sessions: ['qa-session'] });

    const removed = await call(client, 'session_delete', { name: 'qa-session' });
    expect(jsonOf(removed)).toEqual({ ok: true });
    expect(store.sessionGet('qa-session')).toBeNull();
    expect(statSyncSafe(mirror)).toBeNull();
    expect(jsonOf(await call(client, 'session_list'))).toEqual({ sessions: [] });
  });

  it('memory mode: usable live, zero disk writes, engine gets persist:false (C09, D7)', async () => {
    const { client, store, sink, config, sidecar } = await boot({ persist: false });

    // Snapshot AFTER boot (Store.open already created yatt.db): nothing new
    // may appear from here on.
    const before = snapshot(config.paths.root);

    const saved = await call(client, 'session_save', { name: 'mem-session' });
    expect(jsonOf(saved)).toEqual({ ok: true, name: 'mem-session' });

    // Live visibility through BOTH the tool and the sink.
    expect(jsonOf(await call(client, 'session_list'))).toEqual({ sessions: ['mem-session'] });
    expect(await sink.list()).toEqual(['mem-session']);
    expect(await sink.get('mem-session')).toContain('cookies');

    // Nothing touched the disk: no new/changed files, empty sessions table,
    // and the engine was asked for the state WITHOUT persisting it.
    expect(snapshot(config.paths.root)).toEqual(before);
    expect(store.sessionGet('mem-session')).toBeNull();
    expect(statSyncSafe(join(config.paths.sessions, 'mem-session.json'))).toBeNull();
    expect((await engineRecord(sidecar!)).lastSessionSave).toMatchObject({
      name: 'mem-session',
      persist: false,
    });

    const removed = await call(client, 'session_delete', { name: 'mem-session' });
    expect(jsonOf(removed)).toEqual({ ok: true });
    expect(await sink.list()).toEqual([]);
    expect(snapshot(config.paths.root)).toEqual(before);
  });

  it('browser_open restores MEMORY-sink sessions inline via the storageState extension', async () => {
    const booted = await boot({ persist: false });
    const { client, sidecar, sink } = booted;
    await sink.save('live-session', JSON.stringify({ cookies: [{ name: 't' }], origins: [] }));

    await call(client, 'browser_open', { session: 'live-session' });
    const record = await engineRecord(sidecar!);
    expect(record.lastOpen.session).toBeUndefined();
    expect(record.lastOpen.storageState).toEqual({ cookies: [{ name: 't' }], origins: [] });
  });

  it('browser_open keeps passing the session name for persistent sessions (base parity)', async () => {
    const booted = await boot({ persist: true });
    const { client, sidecar, sink } = booted;
    await sink.save('db-session', JSON.stringify({ cookies: [], origins: [] }));

    await call(client, 'browser_open', { session: 'db-session' });
    const record = await engineRecord(sidecar!);
    expect(record.lastOpen.session).toBe('db-session');
    expect(record.lastOpen.storageState).toBeUndefined();
  });

  it('browser_open passes unknown session names through (engine-side lookup, base parity)', async () => {
    const { client, sidecar } = await boot({ persist: false });
    await call(client, 'browser_open', { session: 'not-saved-here' });
    const record = await engineRecord(sidecar!);
    expect(record.lastOpen.session).toBe('not-saved-here');
  });
});

describe('policy on browser tools (D5/D6, C07/C08)', () => {
  it('read-only mode rejects session_save/session_delete with an announced reason', async () => {
    const { client } = await boot({ readOnly: true });

    const save = await call(client, 'session_save', { name: 'blocked' });
    expect(save.isError).toBe(true);
    expect(textOf(save)).toContain('read-only');

    // session_delete of an unknown name still announces the POLICY denial
    // (the guard runs before the handler).
    const del = await call(client, 'session_delete', { name: 'blocked' });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toContain('read-only');

    // Runtime browser control stays available (no persisted data, D10).
    const open = await call(client, 'browser_open');
    expect(jsonOf(open)).toMatchObject({ ok: true });
  });

  it('read-only rejects capture_screenshot (leaf AND nested in structural children) with the policy reason (F7)', async () => {
    const { client } = await boot({ readOnly: true });
    await call(client, 'browser_open');

    // Leaf step: the baselines write is announced as policy-denied.
    const leaf = await call(client, 'browser_run_step', {
      step: { action: 'capture_screenshot', value: 'baseline-name' },
    });
    expect(leaf.isError).toBe(true);
    expect(textOf(leaf)).toContain('capture_screenshot');
    expect(textOf(leaf)).toContain('read-only');

    // Structural step: the same write hidden inside an `if` branch is caught.
    const nested = await call(client, 'browser_run_step', {
      step: {
        action: 'if',
        selector: '#name',
        children: [{ action: 'capture_screenshot', value: 'smuggled' }],
      },
    });
    expect(nested.isError).toBe(true);
    expect(textOf(nested)).toContain('read-only');
  });

  it('non-readOnly still allows capture_screenshot through to the engine (F7)', async () => {
    const { client, sidecar } = await boot();
    await call(client, 'browser_open');
    const ok = await call(client, 'browser_run_step', {
      step: { action: 'capture_screenshot', value: 'allowed-baseline' },
    });
    expect(jsonOf(ok)).toMatchObject({ name: 'capture_screenshot', ok: true });
    expect((await engineRecord(sidecar!)).lastRunStep.step).toMatchObject({
      action: 'capture_screenshot',
      value: 'allowed-baseline',
    });
  });

  it("denyTools with denyBehavior 'error' keeps the tool listed but announces the denial", async () => {
    const { client } = await boot({ denyTools: ['browser_open'], denyBehavior: 'error' });

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('browser_open');

    const denied = await call(client, 'browser_open');
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("tool 'browser_open' is not permitted");
  });

  it("denyTools with denyBehavior 'hide' omits the tool from listings", async () => {
    const { client } = await boot({ denyTools: ['browser_open'], denyBehavior: 'hide' });

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain('browser_open');
    expect(names).toContain('browser_preview');
  });
});

describe('engine-disabled surface', () => {
  it('browser tools fail with a clear engine-required error when sidecar is null', async () => {
    const { client } = await boot({ withEngine: false });

    const open = await call(client, 'browser_open');
    expect(open.isError).toBe(true);
    expect(textOf(open)).toContain('requires the engine');

    // session_save needs the live browser (the state comes from the engine),
    // but the listing/deletion of the sink keeps working engine-free.
    const save = await call(client, 'session_save', { name: 'no-engine' });
    expect(save.isError).toBe(true);
    expect(textOf(save)).toContain('requires the engine');
    expect(jsonOf(await call(client, 'session_list'))).toEqual({ sessions: [] });
    const del = await call(client, 'session_delete', { name: 'whatever' });
    expect(jsonOf(del)).toEqual({ ok: true });
  });
});

/** statSync that maps "missing" to null (keeps the specs declarative). */
function statSyncSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
