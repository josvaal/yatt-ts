/**
 * Public entry point of the yatt-ts library.
 */

/** Semantic version of the yatt-ts package. */
export const VERSION = '0.1.0';

export interface CreateYattServerOptions {
  /** Raw user configuration; validated and resolved before the server boots. */
  config?: unknown;
}

export { createSessionSink, MemorySessionSink, PersistentSessionSink } from './store/sessions.js';
export type { SessionSink } from './store/sessions.js';
export { applyReportRetention } from './store/retention.js';
export type { ReportRetention, RetentionResult } from './store/retention.js';
export { openDatabase } from './store/sqlite.js';
export type { SqliteDatabase, SqliteRuntime } from './store/sqlite.js';
export { Store, mirrorFilePath } from './store/store.js';
export type { ReportEntry, StorePaths } from './store/store.js';

/**
 * Creates a fully configured YATT MCP server (stdio by default, optional HTTP).
 *
 * Placeholder stub — real implementation lands with the MCP bootstrap task (T5).
 */
export function createYattServer(_options?: CreateYattServerOptions): never {
  void _options;
  throw new Error('not implemented');
}
