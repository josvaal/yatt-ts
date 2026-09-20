/**
 * Public entry point of the yatt-ts library.
 */

export { VERSION } from './version.js';

export {
  ConfigError,
  resolveConfig,
  YattConfigSchema,
} from './config/index.js';
export type { ConfigIssue, ResolvedConfig, YattConfig } from './config/index.js';

export { getStrings } from './i18n/index.js';
export type { Locale, PromptCopy, YattStrings } from './i18n/index.js';

export { createYattServer } from './mcp/server.js';
export type { YattServer } from './mcp/server.js';
export { PolicyDeniedError, createToolRegistrar } from './mcp/policy-middleware.js';
export type { ToolDefinition, ToolHandler, ToolRegistrar } from './mcp/policy-middleware.js';
export type { AppDbQueryParams, AppDbQueryResult, Ctx, QueryAppDb } from './mcp/ctx.js';
export type { SidecarClient, SidecarEvent } from './mcp/sidecar-types.js';

export { createSessionSink, MemorySessionSink, PersistentSessionSink } from './store/sessions.js';
export type { SessionSink } from './store/sessions.js';
export { applyReportRetention } from './store/retention.js';
export type { ReportRetention, RetentionResult } from './store/retention.js';
export { openDatabase } from './store/sqlite.js';
export type { SqliteDatabase, SqliteRuntime } from './store/sqlite.js';
export { Store, mirrorFilePath } from './store/store.js';
export type { ReportEntry, StorePaths } from './store/store.js';

export { evaluateToolAccess, isToolListed } from './security/policy.js';
export type { ToolAccess, ToolCallOptions, ToolPolicy } from './security/policy.js';
export { generateToken, hashToken, redact, verifyToken } from './security/token.js';
