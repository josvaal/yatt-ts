/**
 * Engine-side access to the system database `yatt.db` (sessions + baselines
 * owned by the bridge process). Same schema and pragmas as the base tool's
 * `sidecar/src/db.ts`, but built on the T3 dual-runtime SQLite adapter
 * (`bun:sqlite` under Bun, `node:sqlite` DatabaseSync under Node >= 22.5) so
 * both the bridge and the host share one implementation (C23).
 */
import { openDatabase, type SqliteDatabase } from '../store/sqlite.js';

/** Minimal uniform surface the engine needs (subset of SqliteDatabase). */
export type YattDb = SqliteDatabase;

/** Schema identical to the base tool (src-tauri/src/db.rs). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tests     (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports   (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS baselines (name TEXT PRIMARY KEY, png BLOB NOT NULL,      updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions  (name TEXT PRIMARY KEY, storage_state TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

/** Opens `yatt.db` with WAL + busy_timeout (from the adapter) and the schema. */
export async function openYattDb(path: string): Promise<YattDb> {
  const db = await openDatabase(path);
  db.exec(SCHEMA);
  return db;
}
