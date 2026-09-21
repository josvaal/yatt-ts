/**
 * Shared state of every tool and resource of the MCP server.
 */
import type { ResolvedConfig } from '../config/index.js';
import type { ToolPolicy } from '../security/index.js';
import type { RetentionResult, SessionSink, Store } from '../store/index.js';
import type { SidecarClient } from './sidecar-types.js';

/** Parameters for an app-under-test database query (read-only). */
export interface AppDbQueryParams {
  sql: string;
  /** Per-call connection override (SQLite path or "file:" / postgres:// URL). */
  db?: string;
}

/** Result of an app-under-test database query (base `appdb.ts` shape). */
export interface AppDbQueryResult {
  columns: string[];
  /** Rows as arrays of cells, in the order of `columns`. */
  rows: unknown[][];
  /** Real number of rows returned by the query (before capping). */
  totalRows: number;
}

/**
 * Injected query function for `db_query`. Absent (`null`) until the engine
 * wiring lands (T7); the tool reports a clear error in that case (C21).
 */
export type QueryAppDb = (params: AppDbQueryParams) => Promise<AppDbQueryResult>;

export interface Ctx {
  config: ResolvedConfig;
  /** Data root (same value as `config.paths.root`). */
  root: string;
  store: Store;
  sessionSink: SessionSink;
  policy: ToolPolicy;
  /** Engine client; `null` until the engine task provides it (T7). */
  sidecar: SidecarClient | null;
  /** App-database query implementation; `null` until the engine lands (T7). */
  queryAppDb: QueryAppDb | null;
  /**
   * True when `config.appDb` is the `provider` arm (C41): `queryAppDb` runs
   * the host's function IN THIS PROCESS, so the per-call `db` connection
   * override has no meaning (C47) and the engine child has no app database
   * for its `db_assert`/`db_wait` steps (C46).
   */
  appDbProvider: boolean;
  /**
   * Joins/starts the report-retention pass after a report mutation (C29).
   * Fire-and-forget for tools; tests can await the returned promise. With no
   * retention configured it is a no-op (D16).
   */
  afterReportMutation(): Promise<RetentionResult>;
}
