/**
 * Public exports of the configuration module.
 */
export type { YattConfig, ResolvedConfig } from './schema.js';
export type { AppDbProvider, AppDbQueryFn } from './schema.js';
export { YattConfigSchema } from './schema.js';
export { ConfigError, resolveConfig } from './resolve.js';
export type { ConfigIssue } from './resolve.js';
