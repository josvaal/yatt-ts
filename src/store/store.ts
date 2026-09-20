/**
 * Access to the system database `yatt.db` with the same schema as the base
 * tool (tests/reports/baselines/sessions, WAL) — see the base
 * `mcp/src/db.ts` Store and `src-tauri/src/db.rs`.
 *
 * Invariant kept from the base tool: the database is the source of truth and
 * the files under the data root are portable/versionable mirrors, written in
 * the SAME operation (`upsertTest`/`upsertReport`). A mirror write failure
 * fails the whole operation (the promise rejects) — exactly like the base
 * Store; the DB row may already be applied at that point (the DB stays the
 * source of truth, retrying the upsert heals the mirror).
 *
 * All mutations are serialized through a write chain: WAL tolerates
 * concurrency, but predictable ordering matches the base tool.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase, type SqliteDatabase } from './sqlite.js';

/** Absolute locations the Store needs (from `resolveConfig().paths`). */
export interface StorePaths {
  /** System database file (`paths.db`). */
  db: string;
  /** Tests mirror directory (`paths.tests`). */
  tests: string;
  /** Reports mirror directory (`paths.reports`). */
  reports: string;
}

/** Name of a stored report plus its last-update timestamp (for retention). */
export interface ReportEntry {
  name: string;
  updatedAt: number;
}

/** Exact schema of the base tool (db.rs / sidecar db.ts / mcp db.ts). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tests     (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports   (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS baselines (name TEXT PRIMARY KEY, png BLOB NOT NULL,      updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions  (name TEXT PRIMARY KEY, storage_state TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

export class Store {
  readonly db: SqliteDatabase;
  readonly paths: StorePaths;
  private writeChain: Promise<unknown> = Promise.resolve();

  private constructor(db: SqliteDatabase, paths: StorePaths) {
    this.db = db;
    this.paths = paths;
  }

  /**
   * Opens the database (dual-runtime), applies the pragmas and creates the
   * base schema if missing. Async because runtime selection uses dynamic
   * imports.
   */
  static async open(paths: StorePaths): Promise<Store> {
    const db = await openDatabase(paths.db);
    db.exec(SCHEMA);
    return new Store(db, paths);
  }

  /** Runtime backing this store (`'bun'` or `'node'`). */
  get runtime(): 'bun' | 'node' {
    return this.db.runtime;
  }

  /** Same rules as `sanitize` in the base src-tauri/src/storage.rs. */
  static sanitizeName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
      throw new Error(`invalid name: "${name}"`);
    }
    return trimmed;
  }

  /** Serializes writes (the DB tolerates WAL concurrency; ordering stays predictable). */
  private write<T>(fn: () => T | Promise<T>): Promise<T> {
    // The chain flattens returned promises, so the cast below is sound.
    const next = this.writeChain.then(fn) as Promise<T>;
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  // ---- tests ----

  testList(): string[] {
    return (this.db.all('SELECT name FROM tests ORDER BY name') as Array<{ name: string }>).map(
      (row) => row.name,
    );
  }

  testGet(name: string): string | null {
    const row = this.db.get('SELECT content FROM tests WHERE name = ?1', [name]) as
      | { content: string }
      | null;
    return row ? row.content : null;
  }

  testExists(name: string): boolean {
    // Both runtimes return null (not undefined) when there is no row.
    return this.db.get('SELECT 1 FROM tests WHERE name = ?1', [name]) != null;
  }

  /** Upsert DB + mirror `tests/<name>.yatt.json` (same invariant as the app's test_save). */
  upsertTest(name: string, content: string): Promise<void> {
    const safe = Store.sanitizeName(name);
    return this.write(() => {
      this.db.run('INSERT OR REPLACE INTO tests (name, content, updated_at) VALUES (?1, ?2, ?3)', [
        safe,
        content,
        Date.now(),
      ]);
      mkdirSync(this.paths.tests, { recursive: true });
      writeFileSync(mirrorFilePath(this.paths.tests, safe, '.yatt.json'), content, 'utf8');
    });
  }

  deleteTest(name: string): Promise<void> {
    const safe = Store.sanitizeName(name);
    return this.write(() => {
      this.db.run('DELETE FROM tests WHERE name = ?1', [safe]);
      rmSync(mirrorFilePath(this.paths.tests, safe, '.yatt.json'), { force: true });
    });
  }

  // ---- reports ----

  /** Report names, newest first (base ordering: `ORDER BY name DESC`). */
  reportList(): string[] {
    return (this.db.all('SELECT name FROM reports ORDER BY name DESC') as Array<{ name: string }>).map(
      (row) => row.name,
    );
  }

  /** Report names with their `updated_at` timestamps, name-ascending. */
  reportEntries(): ReportEntry[] {
    return (
      this.db.all('SELECT name, updated_at FROM reports ORDER BY name') as Array<{
        name: string;
        updated_at: number | bigint;
      }>
    ).map((row) => ({ name: row.name, updatedAt: Number(row.updated_at) }));
  }

  reportGet(name: string): string | null {
    const row = this.db.get('SELECT content FROM reports WHERE name = ?1', [name]) as
      | { content: string }
      | null;
    return row ? row.content : null;
  }

  /**
   * Upsert DB + mirror under reports/. The mirror extension follows the
   * stored name: run reports are `<slug>.json` and their HTML twins
   * `<slug>.html` (the base runner writes both through this method).
   */
  upsertReport(name: string, content: string): Promise<string> {
    const safe = Store.sanitizeName(name);
    return this.write(() => {
      this.db.run('INSERT OR REPLACE INTO reports (name, content, updated_at) VALUES (?1, ?2, ?3)', [
        safe,
        content,
        Date.now(),
      ]);
      mkdirSync(this.paths.reports, { recursive: true });
      const path = mirrorFilePath(this.paths.reports, safe, reportExtension(safe));
      writeFileSync(path, content, 'utf8');
      return path;
    });
  }

  deleteReport(name: string): Promise<void> {
    const safe = Store.sanitizeName(name);
    return this.write(() => {
      this.db.run('DELETE FROM reports WHERE name = ?1', [safe]);
      rmSync(mirrorFilePath(this.paths.reports, safe, reportExtension(safe)), { force: true });
    });
  }

  // ---- baselines (read-only: the engine owns writes) ----

  baselineList(): string[] {
    return (
      this.db.all('SELECT name FROM baselines ORDER BY name') as Array<{ name: string }>
    ).map((row) => row.name);
  }

  baselineGet(name: string): Uint8Array | null {
    const row = this.db.get('SELECT png FROM baselines WHERE name = ?1', [name]) as
      | { png: Uint8Array }
      | null;
    return row ? new Uint8Array(row.png) : null;
  }

  // ---- sessions (DB level; mirrors live in the session sinks) ----

  sessionList(): string[] {
    return (
      this.db.all('SELECT name FROM sessions ORDER BY name') as Array<{ name: string }>
    ).map((row) => row.name);
  }

  sessionGet(name: string): string | null {
    const row = this.db.get('SELECT storage_state FROM sessions WHERE name = ?1', [name]) as
      | { storage_state: string }
      | null;
    return row ? row.storage_state : null;
  }

  upsertSession(name: string, storageState: string): Promise<void> {
    const safe = Store.sanitizeName(name);
    return this.write(() => {
      this.db.run(
        'INSERT OR REPLACE INTO sessions (name, storage_state, updated_at) VALUES (?1, ?2, ?3)',
        [safe, storageState, Date.now()],
      );
    });
  }

  deleteSession(name: string): Promise<void> {
    const safe = Store.sanitizeName(name);
    return this.write(() => {
      this.db.run('DELETE FROM sessions WHERE name = ?1', [safe]);
    });
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Mirror file path for an artifact name. The extension is appended unless the
 * name already carries it (idempotent for names imported from desktop-app
 * data, where report names include their extension, D9).
 */
export function mirrorFilePath(dir: string, name: string, extension: string): string {
  const suffix = name.toLowerCase().endsWith(extension) ? '' : extension;
  return join(dir, `${name}${suffix}`);
}

/** Mirror extension of a report name (.html for the HTML twins, .json otherwise). */
function reportExtension(name: string): string {
  return name.toLowerCase().endsWith('.html') ? '.html' : '.json';
}
