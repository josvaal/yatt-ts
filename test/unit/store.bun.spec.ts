/**
 * Bun-only store checks. Skipped on every other runtime: run with
 * `bunx vitest run test/unit/store.bun.spec.ts` to prove the `bun:sqlite`
 * branch of the dual-runtime adapter (C23).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/store/sqlite.js';
import { Store } from '../../src/store/store.js';

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yatt-ts-store-bun-'));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
  }
});

describe.skipIf(!IS_BUN)('store on bun:sqlite (bun runtime only)', () => {
  it('openDatabase reports the bun runtime and roundtrips rows', async () => {
    const db = await openDatabase(path.join(tmpRoot(), 'yatt.db'));
    expect(db.runtime).toBe('bun');

    db.exec('CREATE TABLE t (a TEXT PRIMARY KEY, b INTEGER)');
    db.run('INSERT INTO t (a, b) VALUES (?1, ?2)', ['x', 42]);
    expect(db.get('SELECT a, b FROM t WHERE a = ?1', ['x'])).toEqual({ a: 'x', b: 42 });
    expect(db.get('SELECT a FROM t WHERE a = ?1', ['missing'])).toBeNull();
    expect(db.all('SELECT a FROM t ORDER BY a')).toEqual([{ a: 'x' }]);
    const mode = db.get('PRAGMA journal_mode') as Record<string, unknown>;
    expect(String(Object.values(mode)[0]).toLowerCase()).toBe('wal');
    db.close();
  });

  it('Store.open uses bun:sqlite and keeps the dual-write invariant', async () => {
    const root = tmpRoot();
    const store = await Store.open({
      db: path.join(root, 'yatt.db'),
      tests: path.join(root, 'tests'),
      reports: path.join(root, 'reports'),
    });

    expect(store.runtime).toBe('bun');
    await store.upsertTest('bun-flow', '{"schemaVersion":1}');
    await store.upsertReport('bun-run', '{"ok":true}');

    expect(store.testGet('bun-flow')).toBe('{"schemaVersion":1}');
    expect(store.reportGet('bun-run')).toBe('{"ok":true}');
    expect(readFileSync(path.join(root, 'tests', 'bun-flow.yatt.json'), 'utf8')).toBe(
      '{"schemaVersion":1}',
    );
    expect(readFileSync(path.join(root, 'reports', 'bun-run.json'), 'utf8')).toBe('{"ok":true}');

    await store.deleteReport('bun-run');
    expect(existsSync(path.join(root, 'reports', 'bun-run.json'))).toBe(false);
    store.close();
  });
});
