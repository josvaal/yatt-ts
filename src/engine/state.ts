/**
 * Injected engine state.
 *
 * The base sidecar resolved its data root AT IMPORT TIME
 * (`const ROOT = process.env.YATT_ROOT || process.cwd()`), which made the
 * module unusable as a library (config-after-import silently used cwd).
 * Here the bridge startup calls {@link initEngine} exactly once with explicit
 * paths and browser defaults, and every engine module reads the state through
 * the getters instead of touching the environment.
 *
 * In the spawned bridge process the values arrive via environment variables
 * (set by `SidecarClient`): `YATT_ROOT` for the data root, `YATT_ENGINE_JSON`
 * for the browser defaults, `YATT_APP_DB_JSON` for the app-under-test
 * connection (credentials travel via env, NEVER argv — D22).
 */
import { join } from 'node:path';

/** Absolute locations the engine needs inside the data root. */
export interface EnginePaths {
  /** Data root (YATT_ROOT): the only place the engine writes (C12). */
  root: string;
  /** System database file (`<root>/yatt.db`). */
  db: string;
  /** Baselines mirror directory (`<root>/baselines`). */
  baselinesDir: string;
  /** Sessions legacy-mirror directory (`<root>/sessions`). */
  sessionsDir: string;
}

/**
 * Browser defaults + engine behavior knobs (D21: everything adjustable).
 * Defaults reproduce the base tool behavior with the library decisions baked
 * in: headless ON (D10), toolbar injection OFF (D11).
 */
export interface EngineOptions {
  /** Default headless state when `open` omits `headless` (D10). */
  defaultHeadless: boolean;
  /** Default viewport when `open` omits `viewport`. */
  defaultViewport: { width: number; height: number };
  /** Default browser engine. */
  defaultEngine: 'chromium' | 'firefox' | 'webkit';
  /** Injects the floating toolbar (HELPER_JS) into pages (D11: default OFF). */
  toolbarInjection: boolean;
  /** `goto`/page navigation timeout. */
  gotoTimeoutMs: number;
  /** Element interaction timeout (click/type/…). */
  elementTimeoutMs: number;
  /** `wait_visible` timeout. */
  waitVisibleTimeoutMs: number;
  /** Preview payload `evaluate` timeout. */
  previewTimeoutMs: number;
  /** Preview screenshot timeout. */
  screenshotTimeoutMs: number;
  /** `browser.close()` grace before forcing the closed state. */
  closeTimeoutMs: number;
  /** Default timeout for live `run_step` calls. */
  runStepTimeoutMs: number;
  /** Auto-download Chromium when the binary is missing (D12). */
  autoInstallBrowser: boolean;
  /** CDP window→viewport sync (chromium + visible mode only, as in the base tool). */
  cdpSync: { enabled: boolean; pollIntervalMs: number };
}

/** Defaults = base tool behavior with D10/D11 decisions applied. */
export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  defaultHeadless: true,
  defaultViewport: { width: 1280, height: 800 },
  defaultEngine: 'chromium',
  toolbarInjection: false,
  gotoTimeoutMs: 30000,
  elementTimeoutMs: 5000,
  waitVisibleTimeoutMs: 10000,
  previewTimeoutMs: 5000,
  screenshotTimeoutMs: 10000,
  closeTimeoutMs: 6000,
  runStepTimeoutMs: 40000,
  autoInstallBrowser: true,
  cdpSync: { enabled: true, pollIntervalMs: 400 },
};

let state: { paths: EnginePaths; options: EngineOptions } | null = null;

/**
 * Injects the engine paths and options. Idempotent-until-reset: the bridge
 * calls it once at startup; tests may call it per suite (a repeated call
 * simply replaces the state).
 */
export function initEngine(paths: EnginePaths, options?: Partial<EngineOptions>): void {
  state = {
    paths: { ...paths },
    options: { ...DEFAULT_ENGINE_OPTIONS, ...options },
  };
}

export function isEngineInitialized(): boolean {
  return state !== null;
}

/** Injected paths; throws when the bridge forgot to call `initEngine`. */
export function enginePaths(): EnginePaths {
  if (!state) {
    throw new Error('engine not initialized: initEngine(paths, options) must run before use');
  }
  return state.paths;
}

/** Injected options (defaults when not initialized — mirrors the base tool). */
export function engineOptions(): EngineOptions {
  return state ? state.options : DEFAULT_ENGINE_OPTIONS;
}

/** Convenience accessors used by the hot paths (mirror of the base ROOT/…). */
export const baselinesDir = (): string => join(enginePaths().baselinesDir);
export const sessionsDir = (): string => join(enginePaths().sessionsDir);

/**
 * Builds the engine state from the process environment (bridge startup).
 * Unknown/invalid `YATT_ENGINE_JSON` values fall back to the defaults instead
 * of crashing the bridge: browser defaults are advisory, never fatal.
 */
export function initEngineFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const root = String(env.YATT_ROOT ?? '').trim() || process.cwd();
  initEngine(
    {
      root,
      db: join(root, 'yatt.db'),
      baselinesDir: join(root, 'baselines'),
      sessionsDir: join(root, 'sessions'),
    },
    parseEngineOptionsJson(env.YATT_ENGINE_JSON),
  );
}

function parseEngineOptionsJson(raw: string | undefined): Partial<EngineOptions> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<EngineOptions>;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
