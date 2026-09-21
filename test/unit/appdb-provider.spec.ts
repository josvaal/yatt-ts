/**
 * In-process appDb provider spec (T1-T3): covers C41-C47 and the C51
 * serialization boundary. Every test runs against a REAL server through the
 * official MCP client over the in-memory transport (no Chromium, no engine
 * child): the host provider is a spy that records the SQL it receives, which
 * is what discriminates which layer answered a query.
 */
import { describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../../src/config/index.js';
import { serializeAppDb } from '../../src/engine/options.js';
import { buildRunEnv } from '../../src/mcp/run.js';
import { DB_QUERY_TIMEOUT_MS } from '../../src/mcp/tools/db.js';
import type { AppDbQueryFn } from '../../src/index.js';
import { isError, jsonOf, makeTmpRoot, startWithClient, stop, textOf } from './helpers/mcp.js';

const FIXTURE_ROWS = [
  { id: 1, email: 'a@x.dev' },
  { id: 2, email: 'b@x.dev' },
];

/** Provider spy: records every SQL string it is asked to run. */
function spyProvider(rows: Record<string, unknown>[] = FIXTURE_ROWS): {
  provider: AppDbQueryFn;
  calls: string[];
} {
  const calls: string[] = [];
  const provider: AppDbQueryFn = async (sql) => {
    calls.push(sql);
    return rows;
  };
  return { provider, calls };
}

const DB_ASSERT_DOC = {
  schemaVersion: 1,
  steps: [{ action: 'db_assert', sql: 'SELECT 1', expect: 'rows' }],
};

describe('db_query through the provider (C41)', () => {
  it('runs IN PROCESS via the spy: exact SQL in, {columns, rows, totalRows} out', async () => {
    const { provider, calls } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      appDb: { type: 'provider', provider },
    });
    expect(handle.ctx.appDbProvider).toBe(true);

    const out = jsonOf(
      await client.callTool({
        name: 'db_query',
        arguments: { sql: 'SELECT id, email FROM users' },
      }),
    );
    expect(calls).toEqual(['SELECT id, email FROM users']);
    expect(out.columns).toEqual(['id', 'email']);
    expect(out.rows).toEqual([
      [1, 'a@x.dev'],
      [2, 'b@x.dev'],
    ]);
    expect(out.totalRows).toBe(2);

    await stop(handle, client);
  });

  it('works with engine.enabled: false (pure data server): ping deferred, db_query served', async () => {
    const { provider, calls } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });
    expect(handle.ctx.sidecar).toBeNull();
    expect(handle.ctx.queryAppDb).not.toBeNull();

    const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
    expect(ping).toEqual({ ok: true, engine: 'deferred', version: '0.1.0' });

    const out = jsonOf(
      await client.callTool({ name: 'db_query', arguments: { sql: 'SELECT id FROM users' } }),
    );
    expect(calls).toEqual(['SELECT id FROM users']);
    expect(out.totalRows).toBe(2);
    expect(out.rows).toEqual([
      [1, 'a@x.dev'],
      [2, 'b@x.dev'],
    ]);

    await stop(handle, client);
  });
});

describe('security posture preserved (C42/C43)', () => {
  it('read-only guard rejects writes and NEVER invokes the provider (C42)', async () => {
    const { provider, calls } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });

    for (const sql of [
      'INSERT INTO users VALUES (1)',
      'UPDATE users SET id = 1',
      'DELETE FROM users',
      'DROP TABLE users',
    ]) {
      const denied = await client.callTool({ name: 'db_query', arguments: { sql } });
      expect(isError(denied), sql).toBe(true);
      expect(textOf(denied)).toContain('read-only');
    }
    expect(calls).toEqual([]);

    await stop(handle, client);
  });

  it('provider returns 500 rows → output capped at 200 with totalRows 500 (C43)', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ n: i }));
    const { provider, calls } = spyProvider(rows);
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });

    const out = jsonOf(await client.callTool({ name: 'db_query', arguments: { sql: 'SELECT n' } }));
    expect(calls).toEqual(['SELECT n']);
    expect(out.rows).toHaveLength(200);
    expect(out.totalRows).toBe(500);

    await stop(handle, client);
  });
});

describe('multi-statement guard (F1 review round)', () => {
  it('rejects stacked statements (SELECT 1; DROP ...) and NEVER invokes the provider', async () => {
    const { provider, calls } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });

    const denied = await client.callTool({
      name: 'db_query',
      arguments: { sql: 'SELECT 1; DROP TABLE users' },
    });
    expect(isError(denied)).toBe(true);
    expect(textOf(denied)).toContain('multiple SQL statements');
    // The hostile string never reached the host connection.
    expect(calls).toEqual([]);

    await stop(handle, client);
  });

  it('allows trailing semicolons and semicolons inside literals/comments (they reach the provider)', async () => {
    const { provider, calls } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });

    const allowed = [
      'SELECT 1;', // one trailing `;`
      'SELECT 1;;', // several trailing `;`
      "SELECT * FROM t WHERE name = 'a;b'", // `;` inside a string literal
      "SELECT 'it''s ; fine' FROM t", // escaped quote + `;` inside a literal
      'SELECT 1 -- ; drop table users', // `;` inside a line comment
      'SELECT 1 /* ; drop table users */', // `;` inside a block comment
    ];
    for (const sql of allowed) {
      const ok = await client.callTool({ name: 'db_query', arguments: { sql } });
      expect(isError(ok), sql).toBe(false);
    }
    // Verbatim pass-through: the guard rejects, it never rewrites SQL.
    expect(calls).toEqual(allowed);

    await stop(handle, client);
  });
});

describe('timeout (C44)', () => {
  it('pins the 30s tool-layer timeout constant (parity with the base tool)', () => {
    expect(DB_QUERY_TIMEOUT_MS).toBe(30000);
  });

  it('a hanging provider hits the timeout error and the server stays alive', async () => {
    let mode: 'hang' | 'ok' = 'hang';
    const provider: AppDbQueryFn = async () => {
      if (mode === 'hang') return new Promise<Record<string, unknown>[]>(() => {});
      return [{ id: 1 }];
    };
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });

    vi.useFakeTimers();
    try {
      const pending = client.callTool({ name: 'db_query', arguments: { sql: 'SELECT 1' } });
      await vi.advanceTimersByTimeAsync(DB_QUERY_TIMEOUT_MS);
      const result = await pending;
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain(`timed out after ${DB_QUERY_TIMEOUT_MS} ms`);
    } finally {
      vi.useRealTimers();
    }

    // The timer was cleared (withTimeout) and the same server answers again
    // once the provider behaves: no crash, no leak of the failed request.
    mode = 'ok';
    const ok = jsonOf(await client.callTool({ name: 'db_query', arguments: { sql: 'SELECT 1' } }));
    expect(ok.totalRows).toBe(1);

    await stop(handle, client);
  });
});

describe('provider failure handling (C45)', () => {
  it('a rejecting provider yields a clean error envelope; the server keeps serving', async () => {
    const calls: string[] = [];
    const provider: AppDbQueryFn = async (sql) => {
      calls.push(sql);
      throw new Error('provider connection refused');
    };
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });

    for (let i = 0; i < 2; i++) {
      const failed = await client.callTool({
        name: 'db_query',
        arguments: { sql: 'SELECT 1' },
      });
      expect(isError(failed)).toBe(true);
      expect(textOf(failed)).toBe('provider connection refused');
    }
    // Still alive: the ping answers after the failures.
    const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
    expect(ping.ok).toBe(true);

    await stop(handle, client);
  });
});

describe('provider return contract (F2 review round)', () => {
  it('a non-array provider return fails with the contract error, not a raw TypeError', async () => {
    const provider: AppDbQueryFn = async () =>
      undefined as unknown as Record<string, unknown>[];
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });

    const failed = await client.callTool({ name: 'db_query', arguments: { sql: 'SELECT 1' } });
    expect(isError(failed)).toBe(true);
    // Clean contract message; NOT "cannot read properties of undefined".
    expect(textOf(failed)).toBe(
      'appDb provider must return an array of row objects (got undefined)',
    );

    // The server stays alive and serves the next call.
    const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
    expect(ping.ok).toBe(true);

    await stop(handle, client);
  });
});

describe('per-call db override in provider mode (C47)', () => {
  it('rejects the db parameter with the i18n error and never calls the provider', async () => {
    const { provider, calls } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });

    const denied = await client.callTool({
      name: 'db_query',
      arguments: { sql: 'SELECT 1', db: '/tmp/other.db' },
    });
    expect(isError(denied)).toBe(true);
    expect(textOf(denied)).toBe(
      'the per-call db override only applies to engine-managed connections (sqlite/postgres appDb)',
    );
    expect(calls).toEqual([]);

    await stop(handle, client);
  });

  it('localizes both provider errors in Spanish (es)', async () => {
    const { provider } = spyProvider();
    const root = makeTmpRoot();
    const { handle, client } = await startWithClient({
      paths: { root },
      engine: { enabled: false },
      locale: 'es',
      appDb: { type: 'provider', provider },
    });

    const denied = await client.callTool({
      name: 'db_query',
      arguments: { sql: 'SELECT 1', db: '/tmp/other.db' },
    });
    expect(textOf(denied)).toContain('solo aplica a conexiones administradas por el motor');

    // F1 (review round): the multi-statement guard is localized too.
    const stacked = await client.callTool({
      name: 'db_query',
      arguments: { sql: 'SELECT 1; DROP TABLE users' },
    });
    expect(textOf(stacked)).toContain('múltiples sentencias SQL');

    // C46 in Spanish too: the run pre-flight names the engine child boundary.
    await client.callTool({
      name: 'test_create',
      arguments: { content: DB_ASSERT_DOC, name: 'con-db' },
    });
    const rejected = await client.callTool({ name: 'test_run', arguments: { name: 'con-db' } });
    expect(isError(rejected)).toBe(true);
    expect(textOf(rejected)).toContain('proceso hijo del motor');

    await stop(handle, client);
  });
});

describe('test_run boundary with provider-only appDb (C46)', () => {
  function fakeCliIn(root: string): { cli: string; argvLog: string } {
    const cli = join(root, 'fake-cli.mjs');
    copyFileSync(fileURLToPath(new URL('../fixtures/fake-cli.mjs', import.meta.url)), cli);
    chmodSync(cli, 0o755);
    return { cli, argvLog: join(root, 'argv.log') };
  }

  it('rejects db_assert tests BEFORE spawning; non-db tests still run (fake CLI proof)', async () => {
    const root = makeTmpRoot();
    const { cli, argvLog } = fakeCliIn(root);
    const { provider } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root },
      engine: { runtime: cli },
      appDb: { type: 'provider', provider },
    });
    process.env.YATT_FAKE_CLI_LOG = argvLog;
    try {
      await client.callTool({
        name: 'test_create',
        arguments: { content: DB_ASSERT_DOC, name: 'with-db' },
      });
      const denied = await client.callTool({ name: 'test_run', arguments: { name: 'with-db' } });
      expect(isError(denied)).toBe(true);
      expect(textOf(denied)).toContain('with-db');
      expect(textOf(denied)).toContain('db_assert/db_wait');

      // The dataset runner is equally bounded.
      const deniedDataset = await client.callTool({
        name: 'test_run_dataset',
        arguments: { name: 'with-db', rows: [{}] },
      });
      expect(isError(deniedDataset)).toBe(true);
      expect(textOf(deniedDataset)).toContain('db_assert/db_wait');

      // A db_wait nested inside a structural block is caught by the scan too.
      await client.callTool({
        name: 'test_create',
        arguments: {
          content: {
            schemaVersion: 1,
            steps: [
              {
                action: 'repeat',
                times: 2,
                children: [{ action: 'db_wait', sql: 'SELECT 1' }],
              },
            ],
          },
          name: 'nested-db',
        },
      });
      const deniedNested = await client.callTool({
        name: 'test_run',
        arguments: { name: 'nested-db' },
      });
      expect(isError(deniedNested)).toBe(true);
      expect(textOf(deniedNested)).toContain('db_assert/db_wait');

      // The proof of "before spawning": the fake CLI never logged an invocation.
      expect(existsSync(argvLog)).toBe(false);

      // Control: a test WITHOUT db steps runs through the child normally.
      await client.callTool({
        name: 'test_create',
        arguments: { content: { schemaVersion: 1, steps: [] }, name: 'no-db' },
      });
      const ran = await client.callTool({ name: 'test_run', arguments: { name: 'no-db' } });
      expect(isError(ran)).toBe(false);
      expect(jsonOf(ran).ok).toBe(1);
      expect(existsSync(argvLog)).toBe(true);
    } finally {
      delete process.env.YATT_FAKE_CLI_LOG;
      await stop(handle, client);
    }
  });

  it('a missing test still reports the runner error (pre-flight does not shadow it)', async () => {
    const { provider } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root: makeTmpRoot() },
      engine: { enabled: false },
      appDb: { type: 'provider', provider },
    });
    const missing = await client.callTool({ name: 'test_run', arguments: { name: 'nope' } });
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain('not saved');
    await stop(handle, client);
  });

  it('follows run_flow: a db_assert inside a referenced sub-test is rejected BEFORE spawning (F3)', async () => {
    const root = makeTmpRoot();
    const { cli, argvLog } = fakeCliIn(root);
    const { provider } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root },
      engine: { runtime: cli },
      appDb: { type: 'provider', provider },
    });
    process.env.YATT_FAKE_CLI_LOG = argvLog;
    try {
      await client.callTool({
        name: 'test_create',
        arguments: { content: DB_ASSERT_DOC, name: 'sub-with-db' },
      });
      await client.callTool({
        name: 'test_create',
        arguments: {
          content: {
            schemaVersion: 1,
            steps: [{ action: 'run_flow', flow: 'sub-with-db' }],
          },
          name: 'flow-into-db',
        },
      });

      // The top-level tree is clean; the db step hides behind the run_flow.
      const denied = await client.callTool({
        name: 'test_run',
        arguments: { name: 'flow-into-db' },
      });
      expect(isError(denied)).toBe(true);
      expect(textOf(denied)).toContain('flow-into-db');
      expect(textOf(denied)).toContain('db_assert/db_wait');

      // The proof of "before spawning": the fake CLI never logged an invocation.
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      delete process.env.YATT_FAKE_CLI_LOG;
      await stop(handle, client);
    }
  });

  it('a run_flow reference cycle terminates cleanly: runner decides, no hang (F3)', async () => {
    const root = makeTmpRoot();
    const { cli, argvLog } = fakeCliIn(root);
    const { provider } = spyProvider();
    const { handle, client } = await startWithClient({
      paths: { root },
      engine: { runtime: cli },
      appDb: { type: 'provider', provider },
    });
    process.env.YATT_FAKE_CLI_LOG = argvLog;
    try {
      // A references B references A (no db steps anywhere).
      await client.callTool({
        name: 'test_create',
        arguments: {
          content: { schemaVersion: 1, steps: [{ action: 'run_flow', flow: 'cycle-b' }] },
          name: 'cycle-a',
        },
      });
      await client.callTool({
        name: 'test_create',
        arguments: {
          content: { schemaVersion: 1, steps: [{ action: 'run_flow', flow: 'cycle-a' }] },
          name: 'cycle-b',
        },
      });

      // The pre-flight must NOT hang on the cycle and must NOT reject a
      // db-free cycle: the runner owns the outcome (fake CLI runs it).
      const ran = await client.callTool({ name: 'test_run', arguments: { name: 'cycle-a' } });
      expect(isError(ran)).toBe(false);
      expect(jsonOf(ran).ok).toBe(1);
      expect(existsSync(argvLog)).toBe(true);

      // A cycle that DOES hide a db step is still caught: C → D → C + db.
      await client.callTool({
        name: 'test_create',
        arguments: {
          content: { schemaVersion: 1, steps: [{ action: 'run_flow', flow: 'cycle-d' }] },
          name: 'cycle-c',
        },
      });
      await client.callTool({
        name: 'test_create',
        arguments: {
          content: {
            schemaVersion: 1,
            steps: [{ action: 'run_flow', flow: 'cycle-c' }, { ...DB_ASSERT_DOC.steps[0] }],
          },
          name: 'cycle-d',
        },
      });
      const denied = await client.callTool({
        name: 'test_run',
        arguments: { name: 'cycle-c' },
      });
      expect(isError(denied)).toBe(true);
      expect(textOf(denied)).toContain('db_assert/db_wait');
    } finally {
      delete process.env.YATT_FAKE_CLI_LOG;
      await stop(handle, client);
    }
  });
});

describe('engine-child boundary (C51)', () => {
  it('logs the one-line startup notice when the engine is enabled with a provider', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { provider } = spyProvider();
      const { handle, client } = await startWithClient({
        paths: { root: makeTmpRoot() },
        appDb: { type: 'provider', provider },
      });
      const notices = errSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('appDb provider covers the db_query tool in this process'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('test_run db_assert/db_wait steps run in the engine child');
      await stop(handle, client);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs no provider notice when the engine is disabled', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { provider } = spyProvider();
      const { handle, client } = await startWithClient({
        paths: { root: makeTmpRoot() },
        engine: { enabled: false },
        appDb: { type: 'provider', provider },
      });
      const notices = errSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('appDb provider covers'));
      expect(notices).toEqual([]);
      await stop(handle, client);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('serializeAppDb refuses the provider arm defensively', async () => {
    const { provider } = spyProvider();
    const config = resolveConfig({ appDb: { type: 'provider', provider } });
    await expect(serializeAppDb(config.appDb!)).rejects.toThrow(
      'provider appDb cannot be serialized to the engine process',
    );
  });

  it('buildRunEnv sends NO YATT_APP_DB_JSON for the provider arm (sqlite unchanged)', async () => {
    const { provider } = spyProvider();
    const providerConfig = resolveConfig({ appDb: { type: 'provider', provider } });
    const providerEnv = await buildRunEnv(
      providerConfig.paths.root,
      providerConfig.appDb ?? null,
      undefined,
      {},
    );
    expect(providerEnv.YATT_APP_DB_JSON).toBeUndefined();

    const sqliteEnv = await buildRunEnv(
      '/tmp/yatt-root',
      { type: 'sqlite', file: '/tmp/app.db' },
      undefined,
      {},
    );
    expect(JSON.parse(sqliteEnv.YATT_APP_DB_JSON!)).toEqual({ type: 'sqlite', file: '/tmp/app.db' });
  });
});
