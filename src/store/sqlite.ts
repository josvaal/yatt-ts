/**
 * Dual-runtime SQLite adapter (C23).
 *
 * `bun:sqlite` is used when the process runs under Bun; otherwise it falls back
 * to `node:sqlite` (`DatabaseSync`, Node >= 22.5). Both runtimes get the same
 * minimal uniform interface so the rest of the library never branches on the
 * runtime. The system database is the source of truth; file mirrors live in
 * `store.ts` / `sessions.ts`.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Runtime that backs an opened database. */
export type SqliteRuntime = 'bun' | 'node';

/**
 * Minimal uniform database surface shared by bun:sqlite and node:sqlite.
 * Values are plain rows; missing rows come back as `null` on both runtimes.
 */
export interface SqliteDatabase {
  /** Runtime backing this handle. */
  readonly runtime: SqliteRuntime;
  /** Executes one or more raw statements (DDL, multiple statements separated by `;`). */
  exec(sql: string): void;
  /** Runs a mutating statement with optional positional parameters. */
  run(sql: string, params?: readonly unknown[]): void;
  /** First row of a query, or `null` when there is none. */
  get(sql: string, params?: readonly unknown[]): Record<string, unknown> | null;
  /** All rows of a query. */
  all(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
  /** Runs a PRAGMA statement (the `PRAGMA` keyword is optional). */
  pragma(sql: string): void;
  /** Closes the underlying database handle. */
  close(): void;
}

/** Structural type for the subset of bun:sqlite's `Database` we rely on. */
interface BunSqliteDatabase {
  run(sql: string, ...params: unknown[]): unknown;
  exec(sql: string): unknown;
  query(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/**
 * Opens (creating parent folders if needed) the database file with WAL and a
 * 5s busy timeout already applied. Throws a clean, actionable error when no
 * SQLite driver is available in the current runtime.
 */
export async function openDatabase(file: string): Promise<SqliteDatabase> {
  // SQLite does not create parent folders by itself.
  mkdirSync(dirname(file), { recursive: true });

  // Detected through globalThis so no ambient Bun types are required.
  const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

  if (hasBun) {
    // Non-literal specifier (+ @vite-ignore): keeps bundlers/vitest from trying
    // to statically resolve `bun:sqlite` on runtimes that do not have it.
    const specifier = 'bun:sqlite';
    const { Database } = (await import(/* @vite-ignore */ specifier)) as {
      Database: new (path: string) => BunSqliteDatabase;
    };
    const db = new Database(file);
    const handle: SqliteDatabase = {
      runtime: 'bun',
      exec: (sql) => {
        db.exec(sql);
      },
      run: (sql, params = []) => {
        db.run(sql, ...params);
      },
      get: (sql, params = []) =>
        (db.query(sql).get(...params) as Record<string, unknown> | undefined) ?? null,
      all: (sql, params = []) => db.query(sql).all(...params) as Record<string, unknown>[],
      pragma: (sql) => {
        db.run(normalizePragma(sql));
      },
      close: () => {
        db.close();
      },
    };
    applyDefaultPragmas(handle);
    return handle;
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    const handle: SqliteDatabase = {
      runtime: 'node',
      exec: (sql) => {
        db.exec(sql);
      },
      run: (sql, params = []) => {
        db.prepare(sql).run(...(params as import('node:sqlite').SQLInputValue[]));
      },
      get: (sql, params = []) =>
        (db.prepare(sql).get(...(params as import('node:sqlite').SQLInputValue[])) as
          | Record<string, unknown>
          | undefined) ?? null,
      all: (sql, params = []) =>
        db.prepare(sql).all(...(params as import('node:sqlite').SQLInputValue[])) as Record<
          string,
          unknown
        >[],
      pragma: (sql) => {
        db.exec(normalizePragma(sql));
      },
      close: () => {
        db.close();
      },
    };
    applyDefaultPragmas(handle);
    return handle;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite is unavailable in this runtime: yatt-ts requires Node >= 22.5 (node:sqlite) or Bun (bun:sqlite). Original error: ${reason}`,
    );
  }
}

function applyDefaultPragmas(db: SqliteDatabase): void {
  // Same pragmas as the base tool: WAL journal + 5s busy timeout.
  db.pragma('journal_mode=WAL');
  db.pragma('busy_timeout=5000');
}

function normalizePragma(sql: string): string {
  return /^pragma\s/i.test(sql) ? sql : `PRAGMA ${sql}`;
}
