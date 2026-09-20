/**
 * Mapping between the library `ResolvedConfig` and the engine process inputs.
 *
 * - {@link engineOptionsFromConfig} projects the browser/runner domains into
 *   the {@link EngineOptions} the bridge consumes (single source of truth for
 *   defaults: the strict config schema).
 * - {@link serializeAppDb} turns the rich app-under-test connection object
 *   into a JSON-serializable payload for the `YATT_APP_DB_JSON` environment
 *   variable. Credentials travel via env, NEVER argv (D22); `passwordProvider`
 *   functions are resolved to their string value before serialization
 *   (functions cannot cross a process boundary).
 */
import type { ResolvedConfig } from '../config/index.js';
import type { EngineOptions } from './state.js';

/** Projects config.browser (+ engine.autoInstallBrowser) into engine options. */
export function engineOptionsFromConfig(config: ResolvedConfig): EngineOptions {
  return {
    defaultHeadless: config.browser.defaultHeadless,
    defaultViewport: { ...config.browser.defaultViewport },
    defaultEngine: config.browser.engine,
    toolbarInjection: config.browser.toolbarInjection,
    gotoTimeoutMs: config.browser.gotoTimeoutMs,
    elementTimeoutMs: config.browser.elementTimeoutMs,
    waitVisibleTimeoutMs: config.browser.waitVisibleTimeoutMs,
    previewTimeoutMs: config.browser.previewTimeoutMs,
    screenshotTimeoutMs: config.browser.screenshotTimeoutMs,
    closeTimeoutMs: config.browser.closeTimeoutMs,
    runStepTimeoutMs: config.browser.runStepTimeoutMs,
    autoInstallBrowser: config.engine.autoInstallBrowser,
    cdpSync: { ...config.browser.cdpSync },
    // F1 (C11/D21): the resolved artifact paths reach the engine process via
    // YATT_ENGINE_JSON, so host store and engine share the SAME db/baselines/
    // sessions locations even under a fully custom layout.
    db: config.paths.db,
    baselinesDir: config.paths.baselines,
    sessionsDir: config.paths.sessions,
  };
}

/** Resolved app-under-test connection (post-zod shape of `config.appDb`). */
export type ResolvedAppDb = NonNullable<ResolvedConfig['appDb']>;

/** JSON-serializable shape the engine receives via `YATT_APP_DB_JSON`. */
export type SerializableAppDb =
  | { type: 'sqlite'; file: string }
  | {
      type: 'postgres';
      host: string;
      port: number;
      user: string;
      password?: string;
      database: string;
      ssl?: boolean | Record<string, unknown>;
    };

/**
 * Resolves the app-db config into a JSON-ready payload. `passwordProvider`
 * (sync or async) is awaited and inlined as `password`; the provider key
 * itself never crosses the process boundary.
 */
export async function serializeAppDb(appDb: ResolvedAppDb): Promise<SerializableAppDb> {
  if (appDb.type === 'sqlite') {
    return { type: 'sqlite', file: appDb.file };
  }
  let password = appDb.password;
  if (appDb.passwordProvider) {
    password = await appDb.passwordProvider();
  }
  return {
    type: 'postgres',
    host: appDb.host,
    port: appDb.port,
    user: appDb.user,
    ...(password !== undefined ? { password } : {}),
    database: appDb.database,
    ...(appDb.ssl !== undefined ? { ssl: appDb.ssl } : {}),
  };
}
