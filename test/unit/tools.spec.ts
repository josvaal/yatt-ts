/**
 * Tool registry spec (T6): the 17 engine-free tools exercised through a real
 * MCP client over the in-memory transport. Covers C02 (partial inventory),
 * C07 (deny/hide), C08 (read-only), C21 (db_query without engine), C25
 * (baselines), C26 (exports), C29 (retention wiring).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { YattServer } from '../../src/index.js';
import { isError, jsonOf, makeTmpRoot, sleep, startWithClient, stop, textOf } from './helpers/mcp.js';

const SIMPLE_DOC = {
  schemaVersion: 1,
  steps: [{ action: 'goto', value: 'https://example.dev' }],
};

const TWO_STEP_DOC = {
  schemaVersion: 1,
  steps: [
    { action: 'goto', value: 'https://example.dev' },
    { action: 'wait', value: '1' },
  ],
};

const ALL_TOOLS = [
  'baseline_get',
  'baseline_list',
  'browser_click_at',
  'browser_close',
  'browser_condition',
  'browser_eval',
  'browser_open',
  'browser_preview',
  'browser_run_step',
  'browser_scroll',
  'browser_status',
  'db_query',
  'ping',
  'report_delete',
  'report_get',
  'report_list',
  'schema',
  'session_delete',
  'session_list',
  'session_save',
  'tab_close',
  'tab_list',
  'tab_open',
  'tab_switch',
  'test_create',
  'test_delete',
  'test_duplicate',
  'test_export_playwright',
  'test_get',
  'test_list',
  'test_rename',
  'test_run',
  'test_run_dataset',
  'test_update',
  'test_validate',
];

describe('tools via MCP client (in-memory transport)', () => {
  it('registers the full tool catalog: 35 tools (C02; engine-free config included since T9)', async () => {
    const { handle, client } = await startWithClient({ paths: { root: makeTmpRoot() } });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(ALL_TOOLS);
    await stop(handle, client);
  });

  it('full CRUD cycle with mirror files asserted on disk', async () => {
    const root = makeTmpRoot();
    const { handle, client } = await startWithClient({ paths: { root } });

    const created = jsonOf(
      await client.callTool({ name: 'test_create', arguments: { content: SIMPLE_DOC, name: 'cycle-test' } }),
    );
    expect(created.ok).toBe(true);
    expect(created.created).toBe('cycle-test');
    expect(existsSync(join(root, 'tests', 'cycle-test.yatt.json'))).toBe(true);

    const got = jsonOf(await client.callTool({ name: 'test_get', arguments: { name: 'cycle-test' } }));
    expect(got.name).toBe('cycle-test');
    expect(got.doc.steps).toHaveLength(1);

    const listed = jsonOf(await client.callTool({ name: 'test_list', arguments: {} }));
    expect(listed.count).toBe(1);
    expect(listed.tests).toContain('cycle-test');

    const renamed = jsonOf(
      await client.callTool({
        name: 'test_rename',
        arguments: { name: 'cycle-test', newName: 'cycle-renamed' },
      }),
    );
    expect(renamed.ok).toBe(true);
    expect(existsSync(join(root, 'tests', 'cycle-test.yatt.json'))).toBe(false);
    expect(existsSync(join(root, 'tests', 'cycle-renamed.yatt.json'))).toBe(true);

    const duplicated = jsonOf(
      await client.callTool({ name: 'test_duplicate', arguments: { name: 'cycle-renamed' } }),
    );
    expect(duplicated.duplicated).toBe('cycle-renamed (copy)');
    expect(existsSync(join(root, 'tests', 'cycle-renamed (copy).yatt.json'))).toBe(true);

    const updated = jsonOf(
      await client.callTool({
        name: 'test_update',
        arguments: { name: 'cycle-renamed', content: TWO_STEP_DOC },
      }),
    );
    expect(updated.ok).toBe(true);
    expect(updated.steps).toBe(2);
    const mirror = JSON.parse(readFileSync(join(root, 'tests', 'cycle-renamed.yatt.json'), 'utf8'));
    expect(mirror.steps).toHaveLength(2);

    const deletedCopy = jsonOf(
      await client.callTool({ name: 'test_delete', arguments: { name: 'cycle-renamed (copy)' } }),
    );
    expect(deletedCopy.ok).toBe(true);
    expect(existsSync(join(root, 'tests', 'cycle-renamed (copy).yatt.json'))).toBe(false);

    await client.callTool({ name: 'test_delete', arguments: { name: 'cycle-renamed' } });
    const final = jsonOf(await client.callTool({ name: 'test_list', arguments: {} }));
    expect(final.tests).toEqual([]);

    await stop(handle, client);
  });

  it('test_create refuses duplicates unless overwrite (envelope parity)', async () => {
    const { handle, client } = await startWithClient({ paths: { root: makeTmpRoot() } });
    await client.callTool({ name: 'test_create', arguments: { content: SIMPLE_DOC, name: 'dup-test' } });

    const second = await client.callTool({
      name: 'test_create',
      arguments: { content: SIMPLE_DOC, name: 'dup-test' },
    });
    expect(isError(second)).toBe(true);
    expect(textOf(second)).toContain('already exists');

    const overwritten = jsonOf(
      await client.callTool({
        name: 'test_create',
        arguments: { content: SIMPLE_DOC, name: 'dup-test', overwrite: true },
      }),
    );
    expect(overwritten.ok).toBe(true);

    await stop(handle, client);
  });

  it('test_validate: good, bad and future schemaVersion (envelope ok/error)', async () => {
    const { handle, client } = await startWithClient({ paths: { root: makeTmpRoot() } });

    const good = jsonOf(
      await client.callTool({ name: 'test_validate', arguments: { content: SIMPLE_DOC } }),
    );
    expect(good.ok).toBe(true);
    expect(good.doc.steps).toBe(1);

    const bad = jsonOf(
      await client.callTool({ name: 'test_validate', arguments: { content: '{not json' } }),
    );
    expect(bad.ok).toBe(false);
    expect(typeof bad.error).toBe('string');
    expect(bad.error.toLowerCase()).toContain('json');

    const noSteps = jsonOf(
      await client.callTool({ name: 'test_validate', arguments: { content: { schemaVersion: 1 } } }),
    );
    expect(noSteps.ok).toBe(false);
    expect(noSteps.error).toContain('no steps');

    const future = jsonOf(
      await client.callTool({
        name: 'test_validate',
        arguments: { content: { schemaVersion: 2, steps: [] } },
      }),
    );
    expect(future.ok).toBe(false);
    expect(future.error).toContain('schemaVersion 2 is not supported');

    await stop(handle, client);
  });

  it('test_export_playwright: playwright + jest write to exports; invalid format rejected (C26)', async () => {
    const root = makeTmpRoot();
    const { handle, client } = await startWithClient({ paths: { root } });
    await client.callTool({
      name: 'test_create',
      arguments: {
        content: {
          schemaVersion: 1,
          url: 'https://example.dev',
          steps: [{ action: 'click', selector: '[data-testid="save"]' }],
        },
        name: 'exp-test',
      },
    });

    const pw = jsonOf(
      await client.callTool({ name: 'test_export_playwright', arguments: { name: 'exp-test' } }),
    );
    expect(pw.ok).toBe(true);
    expect(pw.spec).toContain('@playwright/test');
    expect(pw.path).toBeNull();

    const jest = jsonOf(
      await client.callTool({
        name: 'test_export_playwright',
        arguments: { name: 'exp-test', format: 'jest' },
      }),
    );
    expect(jest.spec).toContain('jest-environment-playwright');

    const written = jsonOf(
      await client.callTool({
        name: 'test_export_playwright',
        arguments: { name: 'exp-test', write: true },
      }),
    );
    expect(written.path).toBe(join(root, 'exports', 'exp-test.spec.ts'));
    expect(existsSync(written.path)).toBe(true);
    expect(readFileSync(written.path, 'utf8')).toBe(written.spec);

    const invalid = await client.callTool({
      name: 'test_export_playwright',
      arguments: { name: 'exp-test', format: 'cypress' },
    });
    expect(isError(invalid)).toBe(true);

    await stop(handle, client);
  });

  it('readOnly: true → mutations rejected with the policy reason, reads work (C08)', async () => {
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      permissions: { readOnly: true },
    });

    for (const [name, args] of [
      ['test_create', { content: SIMPLE_DOC, name: 'ro-test' }],
      ['test_update', { name: 'ro-test', content: SIMPLE_DOC }],
      ['test_delete', { name: 'ro-test' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('mutates state and this server runs in read-only mode');
    }

    const listed = jsonOf(await client.callTool({ name: 'test_list', arguments: {} }));
    expect(listed.count).toBe(0);

    const validated = jsonOf(
      await client.callTool({ name: 'test_validate', arguments: { content: SIMPLE_DOC } }),
    );
    expect(validated.ok).toBe(true);

    await stop(handle, client);
  });

  it('denyTools announces the denial and keeps the tool visible (C07)', async () => {
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      permissions: { denyTools: ['test_delete'] },
    });

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('test_delete');

    const result = await client.callTool({ name: 'test_delete', arguments: { name: 'whatever' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("tool 'test_delete' is not permitted by this server's policy");

    await stop(handle, client);
  });

  it('denyBehavior hide removes the tool from listings (C07)', async () => {
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      permissions: { denyTools: ['test_delete'], denyBehavior: 'hide' },
    });

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('test_delete');
    expect(names).toContain('test_list');

    await stop(handle, client);
  });

  it('reports cycle + retention applied after mutation when configured (C29)', async () => {
    const root = makeTmpRoot();
    const { handle, client } = await startWithClient({
      paths: { root },
      storage: { retention: { maxReports: 1 } },
    });
    const store = handle.ctx.store;

    await store.upsertReport('r-a.json', JSON.stringify({ title: 'a' }));
    await sleep(5);
    await store.upsertReport('r-b.json', JSON.stringify({ title: 'b', steps: [] }));
    await sleep(5);
    await store.upsertReport('r-c.json', JSON.stringify({ title: 'c' }));

    const listed = jsonOf(await client.callTool({ name: 'report_list', arguments: {} }));
    expect(listed.count).toBe(3);

    const got = jsonOf(await client.callTool({ name: 'report_get', arguments: { name: 'r-a.json' } }));
    expect(got.report.title).toBe('a');

    const missing = await client.callTool({ name: 'report_get', arguments: { name: 'nope.json' } });
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain('does not exist');

    const deleted = jsonOf(
      await client.callTool({ name: 'report_delete', arguments: { name: 'r-a.json' } }),
    );
    expect(deleted.ok).toBe(true);
    expect(existsSync(join(root, 'reports', 'r-a.json'))).toBe(false);

    // Join the fire-and-forget retention pass: maxReports 1 keeps the newest
    // of the survivors (r-c) and deletes r-b.
    await handle.ctx.afterReportMutation();
    const after = jsonOf(await client.callTool({ name: 'report_list', arguments: {} }));
    expect(after.reports).toEqual(['r-c.json']);
    expect(existsSync(join(root, 'reports', 'r-b.json'))).toBe(false);

    await stop(handle, client);
  });

  it('baseline list/get: empty-ok, PNG round-trip, clear missing error (C25)', async () => {
    const { handle, client } = await startWithClient({ paths: { root: makeTmpRoot() } });

    const empty = jsonOf(await client.callTool({ name: 'baseline_list', arguments: {} }));
    expect(empty.count).toBe(0);

    const missing = await client.callTool({ name: 'baseline_get', arguments: { name: 'nope' } });
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain('nope');

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    handle.ctx.store.db.run(
      'INSERT OR REPLACE INTO baselines (name, png, updated_at) VALUES (?1, ?2, ?3)',
      ['b1', png, Date.now()],
    );
    const result = await client.callTool({ name: 'baseline_get', arguments: { name: 'b1' } });
    expect(isError(result)).toBe(false);
    const content = (result as { content: Array<{ type: string; data?: string; mimeType?: string }> })
      .content;
    expect(content[1].mimeType).toBe('image/png');
    expect(Buffer.from(content[1].data ?? '', 'base64')).toEqual(Buffer.from(png));

    await stop(handle, client);
  });

  it('db_query: clear error without engine; injected fn works with guard + caps (C21)', async () => {
    // Engine explicitly disabled → the tool reports the engine requirement.
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
    });

    const noEngine = await client.callTool({ name: 'db_query', arguments: { sql: 'SELECT 1' } });
    expect(isError(noEngine)).toBe(true);
    expect(textOf(noEngine)).toBe(
      'app database query requires the engine, not available in this server configuration',
    );
    await stop(handle, client);

    // An injected query fn (the T7 wiring does exactly this) serves the tool.
    const { handle: h2, client: c2 } = await startWithClient({ paths: { root: makeTmpRoot() } });
    h2.ctx.queryAppDb = async () => ({
      columns: ['id'],
      rows: Array.from({ length: 250 }, (_, i) => [i]),
      totalRows: 250,
    });

    const ok = jsonOf(
      await c2.callTool({ name: 'db_query', arguments: { sql: 'SELECT id FROM t' } }),
    );
    expect(ok.columns).toEqual(['id']);
    expect(ok.rows).toHaveLength(200); // ROW_CAP
    expect(ok.totalRows).toBe(250);

    const denied = await c2.callTool({
      name: 'db_query',
      arguments: { sql: 'INSERT INTO t VALUES (1)' },
    });
    expect(isError(denied)).toBe(true);
    expect(textOf(denied)).toContain('read-only');

    await stop(h2, c2);
  });

  it('ping and schema respond; ping stays deferred with the engine disabled (C25/C02 partial)', async () => {
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
    });
    expect(handle.ctx.sidecar).toBeNull();

    const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
    expect(ping).toEqual({ ok: true, engine: 'deferred', version: '0.1.0' });

    const schema = textOf(await client.callTool({ name: 'schema', arguments: {} }));
    expect(schema).toContain('# YATT test format (schemaVersion 1)');
    expect(schema).toContain('run_flow');

    await stop(handle, client);
  });
});

/** Keeps the type import used even if the helper shape evolves. */
export type { Client, YattServer };
