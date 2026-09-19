/**
 * Unit spec for the storage layer (T3).
 *
 * Covers:
 * - C23: dual-runtime adapter — `node:sqlite` under Node, `bun:sqlite` under
 *   Bun (the bun-specific extra checks live in `store.bun.spec.ts`).
 * - Dual-write invariant: DB row + file mirror written together; deletes
 *   remove both; a mirror write failure fails the operation.
 * - `sanitizeName` mirrors the base Rust `sanitize` semantics.
 * - C29/D16: retention is a no-op when undefined; maxAgeDays then maxReports.
 * - D7/C09/C10 groundwork: persistent session sink (DB + mirror) vs memory
 *   session sink (nothing touches disk, readable live).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/index.js';
import { applyReportRetention } from '../../src/store/retention.js';
import { createSessionSink, MemorySessionSink, PersistentSessionSink } from '../../src/store/sessions.js';
import { openDatabase } from '../../src/store/sqlite.js';
import { Store } from '../../src/store/store.js';

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const DAY_MS = 86_400_000;

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yatt-ts-store-'));
  tmpRoots.push(root);
  return root;
}

async function openStore(root = tmpRoot()): Promise<{ root: string; store: Store }> {
  const store = await Store.open({
    db: path.join(root, 'yatt.db'),
    tests: path.join(root, 'tests'),
    reports: path.join(root, 'reports'),
  });
  return { root, store };
}

/** Seeds a report row directly (controllable updated_at) plus its mirror file. */
function seedReport(store: Store, root: string, name: string, updatedAt: number, content = '{}'): void {
  store.db.run('INSERT OR REPLACE INTO reports (name, content, updated_at) VALUES (?1, ?2, ?3)', [
    name,
    content,
    updatedAt,
  ]);
  const dir = path.join(root, 'reports');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(dir, `${name}.json`), content, 'utf8');
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('dual-runtime adapter (C23)', () => {
  it('opens through the runtime-native driver (node:sqlite on Node, bun:sqlite on Bun)', async () => {
    const { store } = await openStore();
    expect(store.runtime).toBe(IS_BUN ? 'bun' : 'node');
    store.close();
  });

  it('openDatabase applies WAL and busy_timeout on open', async () => {
    const root = tmpRoot();
    const db = await openDatabase(path.join(root, 'yatt.db'));
    expect(db.runtime).toBe(IS_BUN ? 'bun' : 'node');
    const mode = db.get('PRAGMA journal_mode');
    const timeout = db.get('PRAGMA busy_timeout');
    expect(String(Object.values(mode as Record<string, unknown>)[0]).toLowerCase()).toBe('wal');
    expect(Number(Object.values(timeout as Record<string, unknown>)[0])).toBe(5000);
    db.close();
  });

  it('supports run/get/all roundtrips and close', async () => {
    const root = tmpRoot();
    const db = await openDatabase(path.join(root, 'data', 'yatt.db'));
    db.exec('CREATE TABLE t (a TEXT PRIMARY KEY, b INTEGER)');
    db.run('INSERT INTO t (a, b) VALUES (?1, ?2)', ['x', 7]);
    expect(db.get('SELECT a, b FROM t WHERE a = ?1', ['x'])).toEqual({ a: 'x', b: 7 });
    expect(db.get('SELECT a FROM t WHERE a = ?1', ['missing'])).toBeNull();
    expect(db.all('SELECT a FROM t ORDER BY a')).toEqual([{ a: 'x' }]);
    db.close();
  });
});

describe('dual-write invariant (DB + mirror)', () => {
  it('upsertTest writes the DB row and the tests/<name>.yatt.json mirror together', async () => {
    const { root, store } = await openStore();
    await store.upsertTest('login-flow', '{"schemaVersion":1}');

    expect(store.testList()).toEqual(['login-flow']);
    expect(store.testGet('login-flow')).toBe('{"schemaVersion":1}');
    expect(store.testExists('login-flow')).toBe(true);
    const mirror = path.join(root, 'tests', 'login-flow.yatt.json');
    expect(existsSync(mirror)).toBe(true);
    expect(readFileSync(mirror, 'utf8')).toBe('{"schemaVersion":1}');
    store.close();
  });

  it('upsertTest replaces an existing test in DB and mirror', async () => {
    const { root, store } = await openStore();
    await store.upsertTest('login-flow', 'v1');
    await store.upsertTest('login-flow', 'v2');

    expect(store.testGet('login-flow')).toBe('v2');
    expect(readFileSync(path.join(root, 'tests', 'login-flow.yatt.json'), 'utf8')).toBe('v2');
    expect(store.testList()).toEqual(['login-flow']);
    store.close();
  });

  it('deleteTest removes both the DB row and the mirror', async () => {
    const { root, store } = await openStore();
    await store.upsertTest('login-flow', 'v1');
    await store.deleteTest('login-flow');

    expect(store.testList()).toEqual([]);
    expect(store.testExists('login-flow')).toBe(false);
    expect(existsSync(path.join(root, 'tests', 'login-flow.yatt.json'))).toBe(false);
    store.close();
  });

  it('upsertReport writes the DB row and the reports/<name>.json mirror, returning the mirror path', async () => {
    const { root, store } = await openStore();
    const mirrorPath = await store.upsertReport('run-2026-09-19', '{"status":"pass"}');

    expect(mirrorPath).toBe(path.join(root, 'reports', 'run-2026-09-19.json'));
    expect(store.reportGet('run-2026-09-19')).toBe('{"status":"pass"}');
    expect(readFileSync(mirrorPath, 'utf8')).toBe('{"status":"pass"}');
    store.close();
  });

  it('reportList orders names descending (base semantics)', async () => {
    const { store } = await openStore();
    await store.upsertReport('a-report', '{}');
    await store.upsertReport('b-report', '{}');
    expect(store.reportList()).toEqual(['b-report', 'a-report']);
    store.close();
  });

  it('deleteReport removes both the DB row and the mirror', async () => {
    const { root, store } = await openStore();
    await store.upsertReport('run-2026-09-19', '{"status":"pass"}');
    await store.deleteReport('run-2026-09-19');

    expect(store.reportList()).toEqual([]);
    expect(existsSync(path.join(root, 'reports', 'run-2026-09-19.json'))).toBe(false);
    store.close();
  });

  it('fails the operation when the mirror cannot be written', async () => {
    const root = tmpRoot();
    // A regular file blocking the mirror directory makes mkdir/write fail.
    writeFileSync(path.join(root, 'blocker'), 'not a dir');
    const store = await Store.open({
      db: path.join(root, 'yatt.db'),
      tests: path.join(root, 'blocker', 'tests'),
      reports: path.join(root, 'blocker', 'reports'),
    });

    await expect(store.upsertTest('x', 'content')).rejects.toThrow();
    await expect(store.upsertReport('y', 'content')).rejects.toThrow();
    store.close();
  });

  it('keeps the DB as source of truth when the mirror write fails (base semantics)', async () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'blocker'), 'not a dir');
    const store = await Store.open({
      db: path.join(root, 'yatt.db'),
      tests: path.join(root, 'blocker', 'tests'),
      reports: path.join(root, 'reports'),
    });

    // The mirror write fails after the DB insert: the op rejects, the DB row
    // persists, and retrying with a usable mirror heals it.
    await expect(store.upsertTest('x', 'content')).rejects.toThrow();
    expect(store.testGet('x')).toBe('content');
    store.close();
  });
});

describe('baselines (read-only)', () => {
  it('lists and returns stored PNG bytes', async () => {
    const { store } = await openStore();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    store.db.run('INSERT INTO baselines (name, png, updated_at) VALUES (?1, ?2, ?3)', [
      'home.png',
      png,
      Date.now(),
    ]);

    expect(store.baselineList()).toEqual(['home.png']);
    expect(store.baselineGet('home.png')).toEqual(png);
    expect(store.baselineGet('missing.png')).toBeNull();
    store.close();
  });
});

describe('sanitizeName (base Rust storage.rs semantics)', () => {
  it('accepts regular names and trims whitespace', () => {
    expect(Store.sanitizeName('login-flow')).toBe('login-flow');
    expect(Store.sanitizeName('  my test  ')).toBe('my test');
  });

  it('rejects empty and whitespace-only names', () => {
    expect(() => Store.sanitizeName('')).toThrow(/invalid name/);
    expect(() => Store.sanitizeName('   ')).toThrow(/invalid name/);
  });

  it('rejects path separators and traversal segments naming the input', () => {
    for (const bad of ['a/b', 'a\\b', '..', 'a..b', '../escape', '/abs', 'C:\\x']) {
      expect(() => Store.sanitizeName(bad), `expected rejection for "${bad}"`).toThrow(
        new RegExp(`invalid name: "${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      );
    }
  });

  it('rejects invalid names on every mutating entry point (synchronously, like the base Store)', async () => {
    const { store: s } = await openStore();
    for (const bad of ['../escape', 'a/b']) {
      expect(() => s.upsertTest(bad, '{}')).toThrow(/invalid name/);
      expect(() => s.upsertReport(bad, '{}')).toThrow(/invalid name/);
      expect(() => s.upsertSession(bad, '{}')).toThrow(/invalid name/);
      expect(() => s.deleteTest(bad)).toThrow(/invalid name/);
      expect(() => s.deleteReport(bad)).toThrow(/invalid name/);
      expect(() => s.deleteSession(bad)).toThrow(/invalid name/);
    }
    s.close();
  });
});

describe('report retention (C29, D16)', () => {
  it('is a no-op returning no deletions when retention is undefined', async () => {
    const { root, store } = await openStore();
    await store.upsertReport('keep-me', '{}');
    await store.upsertReport('keep-me-2', '{}');

    expect(await applyReportRetention(store, undefined)).toEqual({ deleted: [] });
    expect(store.reportList()).toEqual(['keep-me-2', 'keep-me']);
    expect(existsSync(path.join(root, 'reports', 'keep-me.json'))).toBe(true);
    expect(existsSync(path.join(root, 'reports', 'keep-me-2.json'))).toBe(true);
    store.close();
  });

  it('is a no-op for an empty policy object', async () => {
    const { store } = await openStore();
    await store.upsertReport('keep-me', '{}');
    expect(await applyReportRetention(store, {})).toEqual({ deleted: [] });
    expect(store.reportList()).toEqual(['keep-me']);
    store.close();
  });

  it('maxAgeDays deletes only reports older than the cutoff (by updated_at)', async () => {
    const { root, store } = await openStore();
    const now = Date.now();
    seedReport(store, root, 'ancient', now - 10 * DAY_MS);
    seedReport(store, root, 'recent', now - 1 * DAY_MS);

    const result = await applyReportRetention(store, { maxAgeDays: 7 });

    expect(result.deleted).toEqual(['ancient']);
    expect(store.reportList()).toEqual(['recent']);
    expect(existsSync(path.join(root, 'reports', 'ancient.json'))).toBe(false);
    expect(existsSync(path.join(root, 'reports', 'recent.json'))).toBe(true);
    store.close();
  });

  it('maxReports keeps the newest N reports regardless of name order', async () => {
    const { root, store } = await openStore();
    const now = Date.now();
    seedReport(store, root, 'r1-old', now - 40_000);
    seedReport(store, root, 'r2-newest', now);
    seedReport(store, root, 'r3-middle', now - 20_000);
    seedReport(store, root, 'r4-old', now - 30_000);
    seedReport(store, root, 'r5-middle', now - 10_000);

    const result = await applyReportRetention(store, { maxReports: 2 });

    expect(result.deleted.sort()).toEqual(['r1-old', 'r3-middle', 'r4-old'].sort());
    expect(store.reportList().sort()).toEqual(['r2-newest', 'r5-middle'].sort());
    expect(existsSync(path.join(root, 'reports', 'r2-newest.json'))).toBe(true);
    expect(existsSync(path.join(root, 'reports', 'r1-old.json'))).toBe(false);
    store.close();
  });

  it('combined policy: age pass deletes old reports, count pass trims the rest', async () => {
    const { root, store } = await openStore();
    const now = Date.now();
    seedReport(store, root, 'ancient', now - 30 * DAY_MS);
    seedReport(store, root, 'm1', now - 9 * DAY_MS);
    seedReport(store, root, 'm2', now - 8 * DAY_MS);
    seedReport(store, root, 'fresh-1', now - 2 * DAY_MS);
    seedReport(store, root, 'fresh-2', now - 1 * DAY_MS);

    const result = await applyReportRetention(store, { maxAgeDays: 7, maxReports: 2 });

    // 'ancient' goes by age; among the 4-day-window survivors (m1, m2,
    // fresh-1, fresh-2) the two newest stay.
    expect(result.deleted.sort()).toEqual(['ancient', 'm1', 'm2'].sort());
    expect(store.reportList().sort()).toEqual(['fresh-1', 'fresh-2'].sort());
    store.close();
  });
});

describe('persistent session sink (DB + mirror)', () => {
  it('save writes the DB row and the sessions/<name>.json mirror together', async () => {
    const root = tmpRoot();
    const config = resolveConfig({ paths: { root } });
    const { store } = await openStore(root);
    const sink = createSessionSink(config, store);

    await sink.save('github-user', '{"cookies":[],"origins":[]}');

    expect(store.sessionGet('github-user')).toBe('{"cookies":[],"origins":[]}');
    const mirror = path.join(config.paths.sessions, 'github-user.json');
    expect(existsSync(mirror)).toBe(true);
    expect(readFileSync(mirror, 'utf8')).toBe('{"cookies":[],"origins":[]}');
    expect(await sink.list()).toEqual(['github-user']);
    expect(await sink.get('github-user')).toBe('{"cookies":[],"origins":[]}');
    store.close();
  });

  it('delete removes both the DB row and the mirror', async () => {
    const root = tmpRoot();
    const config = resolveConfig({ paths: { root } });
    const { store } = await openStore(root);
    const sink = createSessionSink(config, store);

    await sink.save('github-user', '{"cookies":[]}');
    await sink.delete('github-user');

    expect(await sink.get('github-user')).toBeNull();
    expect(await sink.list()).toEqual([]);
    expect(store.sessionList()).toEqual([]);
    expect(existsSync(path.join(config.paths.sessions, 'github-user.json'))).toBe(false);
    store.close();
  });

  it('flush drains queued writes before they are asserted', async () => {
    const root = tmpRoot();
    const config = resolveConfig({ paths: { root } });
    const { store } = await openStore(root);
    const sink = createSessionSink(config, store);

    const pending = sink.save('queued', '{"cookies":[]}');
    await sink.flush();
    await pending;

    expect(existsSync(path.join(config.paths.sessions, 'queued.json'))).toBe(true);
    store.close();
  });

  it('fails the operation when the sessions mirror cannot be written', async () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'blocker'), 'not a dir');
    const { store } = await openStore(root);
    // Constructed directly: resolveConfig would rightly reject the impossible
    // sessions path up front (C13); here the sink itself is under test.
    const sink = new PersistentSessionSink(store, path.join(root, 'blocker', 'sessions'));

    await expect(sink.save('x', '{}')).rejects.toThrow();
    store.close();
  });
});

describe('memory session sink (D7: nothing touches disk, usable live)', () => {
  it('saves and reads back live without creating any file or DB row', async () => {
    const root = tmpRoot();
    const config = resolveConfig({ paths: { root }, sessions: { persist: false } });
    const { store } = await openStore(root);
    const sink = createSessionSink(config, store);
    expect(sink).toBeInstanceOf(MemorySessionSink);

    await sink.save('ephemeral-a', '{"cookies":[1]}');
    await sink.save('ephemeral-b', '{"cookies":[2]}');

    // Live readability (C09/C10 groundwork): usable within the session.
    expect(await sink.get('ephemeral-a')).toBe('{"cookies":[1]}');
    expect(await sink.list()).toEqual(['ephemeral-a', 'ephemeral-b']);

    // Nothing on disk: no sessions folder, no DB rows, nothing.
    expect(existsSync(config.paths.sessions)).toBe(false);
    expect(store.sessionList()).toEqual([]);
    expect(store.sessionGet('ephemeral-a')).toBeNull();
    store.close();
  });

  it('delete drops the entry and flush stays a no-op', async () => {
    const root = tmpRoot();
    const config = resolveConfig({ paths: { root }, sessions: { persist: false } });
    const { store } = await openStore(root);
    const sink = createSessionSink(config, store);

    await sink.save('a', '{}');
    await sink.delete('a');
    await sink.flush();

    expect(await sink.get('a')).toBeNull();
    expect(await sink.list()).toEqual([]);
    expect(existsSync(config.paths.sessions)).toBe(false);
    store.close();
  });

  it('rejects invalid names like every other sink', async () => {
    const sink = new MemorySessionSink();
    await expect(sink.save('../escape', '{}')).rejects.toThrow(/invalid name/);
  });
});

describe('store-level session methods', () => {
  it('upsert/list/get/delete sessions at the DB level', async () => {
    const { store } = await openStore();
    await store.upsertSession('beta', '{"b":1}');
    await store.upsertSession('alpha', '{"a":1}');

    expect(store.sessionList()).toEqual(['alpha', 'beta']);
    expect(store.sessionGet('alpha')).toBe('{"a":1}');
    expect(store.sessionGet('missing')).toBeNull();

    await store.deleteSession('alpha');
    expect(store.sessionList()).toEqual(['beta']);
    store.close();
  });
});
