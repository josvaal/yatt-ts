/**
 * Read-only connection to the app-under-test database (the `db_assert` /
 * `db_wait` steps and the bridge's `db_query` method).
 *
 * Ported from the base `sidecar/src/appdb.ts` with one upgrade: besides the
 * legacy string source (SQLite path, "file:" URL or postgres:// URL) it
 * accepts the rich connection object the library sends via `YATT_APP_DB_JSON`
 * (`{type:'sqlite',file}` or `{type:'postgres',host,port,user,password,
 * database,ssl}`). Credentials arrive through the environment, never argv
 * (D22); the per-call `db` parameter (a plain string) still wins over every
 * default, exactly like the base tool.
 *
 * Same dual-runtime technique as db.ts: `bun:sqlite` with Bun and
 * `node:sqlite` (DatabaseSync) as fallback on Node. The connection opens
 * lazily on first query and reopens if the configuration changes.
 */

export interface AppDbResult {
  columns: string[];
  /** Rows as arrays of cells, in the order of `columns`. */
  rows: unknown[][];
  /** Real number of rows returned by the query (before capping). */
  totalRows: number;
}

/** Rich (JSON) or legacy string connection source. */
export type AppDbSource =
  | string
  | { type: 'sqlite'; file: string }
  | {
      type: 'postgres';
      host: string;
      port?: number;
      user: string;
      password?: string;
      database: string;
      ssl?: boolean | Record<string, unknown>;
    };

/** Cap of returned rows (totalRows keeps the real count). */
const ROW_CAP = 200;

/** Configured default (initAppDb / YATT_APP_DB_JSON / YATT_APP_DB). */
let defaultSource: AppDbSource | null = null;

/**
 * Sets the default connection source. Called by the bridge startup with the
 * parsed `YATT_APP_DB_JSON` (or the legacy `YATT_APP_DB` env string), and by
 * the CLI with the `--app-db` flag (the flag wins over the env, base
 * semantics). Empty string clears it.
 */
export function initAppDb(source: AppDbSource | undefined | null): void {
  if (source === null || source === undefined) {
    defaultSource = null;
    return;
  }
  if (typeof source === 'string') {
    defaultSource = source.trim() ? source : null;
    return;
  }
  defaultSource = source;
}

/** Reads the default source from the environment (bridge startup helper). */
export function appDbSourceFromEnv(env: NodeJS.ProcessEnv = process.env): AppDbSource | null {
  const json = String(env.YATT_APP_DB_JSON ?? '').trim();
  if (json) {
    try {
      return JSON.parse(json) as AppDbSource;
    } catch {
      throw new Error('invalid YATT_APP_DB_JSON: not valid JSON');
    }
  }
  const legacy = String(env.YATT_APP_DB ?? '').trim();
  return legacy || null;
}

/** Is an app-under-test database configured? */
export function appDbConfigured(): boolean {
  return defaultSource !== null;
}

// ---- Read-only guard ----

const READ_ONLY_RE = /^\s*(select|with|explain|pragma)\b/i;

/** Rejects any statement that is not a read. */
function assertReadOnly(sql: string): void {
  if (!READ_ONLY_RE.test(sql)) {
    throw new Error('db: read-only (SELECT/WITH/EXPLAIN/PRAGMA)');
  }
}

/** Open connection: capped query + close. */
interface AppDbHandle {
  query(sql: string): Promise<AppDbResult>;
  close(): void;
}

let handle: { key: string; db: AppDbHandle } | null = null;

/** Builds the result: rows as arrays in column order, capped at 200. */
function shape(columns: string[], rows: Record<string, unknown>[]): AppDbResult {
  return {
    columns,
    rows: rows.slice(0, ROW_CAP).map((r) => columns.map((c) => r[c])),
    totalRows: rows.length,
  };
}

/** Cache key: strings as-is, objects re-serialized (config change → reopen). */
function keyOf(source: AppDbSource): string {
  return typeof source === 'string' ? source : JSON.stringify(source);
}

/** SQLite in read-only mode: bun:sqlite with node:sqlite fallback (C23). */
async function openSqlite(file: string): Promise<AppDbHandle> {
  // "file:" URL → plain path (without query string).
  const path = file.startsWith('file:')
    ? file.replace(/^file:\/\//, '').replace(/^file:/, '').split('?')[0]
    : file;
  const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  if (hasBun) {
    const specifier = 'bun:sqlite';
    const { Database } = (await import(/* @vite-ignore */ specifier)) as {
      Database: new (path: string, options: { readonly: boolean }) => {
        query(sql: string): { all(): unknown[]; columns?(): { name: string }[] };
        close(): void;
      };
    };
    const db = new Database(path, { readonly: true });
    return {
      query: async (sql) => {
        const stmt = db.query(sql);
        const rows = stmt.all() as Record<string, unknown>[];
        const columns =
          typeof stmt.columns === 'function'
            ? stmt.columns().map((c) => c.name)
            : rows.length > 0
              ? Object.keys(rows[0])
              : [];
        return shape(columns, rows);
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    query: async (sql) => {
      const rows = db.prepare(sql).all() as Record<string, unknown>[];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return shape(columns, rows);
    },
    close: () => db.close(),
  };
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ fields: { name: string }[]; rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** Postgres in read-only mode: requires the optional `pg` peer dependency. */
async function openPostgres(config: string | Record<string, unknown>): Promise<AppDbHandle> {
  let Client: new (cfg: string | Record<string, unknown>) => PgClient;
  try {
    // Non-literal specifier: `pg` is an optional peer dependency that is only
    // required when the source is postgres.
    const pgModule = 'pg';
    const pg = (await import(/* @vite-ignore */ pgModule)) as { Client: typeof Client };
    Client = pg.Client;
  } catch {
    throw new Error('db: postgres connections need the optional dependency "pg" (npm i pg)');
  }
  const client = new Client(config);
  await client.connect();
  return {
    query: async (sql) => {
      // Extra belt to the syntax guard: a read-only transaction.
      await client.query('BEGIN READ ONLY');
      try {
        const res = await client.query(sql);
        await client.query('COMMIT');
        return shape(res.fields.map((f) => f.name), res.rows);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    },
    close: () => {
      void client.end().catch(() => {});
    },
  };
}

/** Lazily cached connection; reopens if the configuration source changed. */
async function getHandle(key: string, opener: () => Promise<AppDbHandle>): Promise<AppDbHandle> {
  if (handle && handle.key === key) return handle.db;
  if (handle) {
    try {
      handle.db.close();
    } catch {
      /* already closed */
    }
    handle = null;
  }
  const db = await opener();
  handle = { key, db };
  return db;
}

async function openSource(source: AppDbSource): Promise<AppDbHandle> {
  if (typeof source === 'string') {
    return /^postgres(ql)?:\/\//i.test(source) ? openPostgres(source) : openSqlite(source);
  }
  if (source.type === 'sqlite') {
    return openSqlite(source.file);
  }
  const { type: _type, ...pg } = source;
  return openPostgres(pg);
}

/**
 * Runs a read-only query against the app-under-test database. `override`
 * (a plain path/URL string, as accepted by the `db_query` tool parameter)
 * wins over the configured default; with neither, the canonical error is
 * thrown (base behavior).
 */
export async function appDbQuery(sql: string, override?: unknown): Promise<AppDbResult> {
  const fromParam = String(override ?? '').trim();
  const source: AppDbSource | null = fromParam || defaultSource;
  if (!source) {
    throw new Error(
      'define YATT_APP_DB (or --app-db), or pass the db parameter to the db_query tool',
    );
  }
  assertReadOnly(sql);
  const key = keyOf(source);
  return getHandle(key, () => openSource(source)).then((db) => db.query(sql));
}

/** Closes the app connection (engine shutdown hook). */
export function closeAppDb(): void {
  if (handle) {
    try {
      handle.db.close();
    } catch {
      /* already closed */
    }
    handle = null;
  }
}
