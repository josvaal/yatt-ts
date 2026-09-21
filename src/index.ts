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
export { createMcpHttpHandler } from './mcp/http-handler.js';
export type { McpHttpHandler, SessionRouterOptions } from './mcp/http-handler.js';
export { PolicyDeniedError, createToolRegistrar } from './mcp/policy-middleware.js';
export type { ToolDefinition, ToolHandler, ToolRegistrar } from './mcp/policy-middleware.js';
export type { AppDbQueryParams, AppDbQueryResult, Ctx, QueryAppDb } from './mcp/ctx.js';
export type { SidecarClient, SidecarEvent } from './mcp/sidecar-types.js';
export {
  SidecarClient as EngineClient,
  resolveEngineEntry,
  resolveRuntimeCommand,
} from './mcp/sidecar-client.js';
export type { RuntimeProbe, SidecarClientOptions } from './mcp/sidecar-client.js';
export {
  ENGLISH_RUNNER_MESSAGES,
  buildRunCommand,
  runTestDataset,
  runTestHeadless,
} from './mcp/run.js';
export type { RunnerMessages, RunRequest, RunSummary, SpawnCli } from './mcp/run.js';
export {
  DEFAULT_ENGINE_OPTIONS,
  initEngine,
} from './engine/state.js';
export type { EngineOptions, EnginePaths } from './engine/state.js';
export { engineOptionsFromConfig, serializeAppDb } from './engine/options.js';
export type { ResolvedAppDb, SerializableAppDb } from './engine/options.js';

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
