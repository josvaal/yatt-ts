/**
 * Unit spec for the yatt-ts configuration module.
 *
 * Covers:
 * - C14: defaults = current tool behavior (port 3191, headless ON, toolbar OFF,
 *   locale en, viewport 1280x800, all engine/browser timeouts, artifact layout).
 * - C13: strict validation — unknown keys, wrong types and impossible paths fail
 *   fast with an error naming the offending key.
 * - C11: per-artifact path resolution (relative -> absolute vs root, ~ expansion).
 * - Auth (C06 groundwork) and appDb (D22) cross-field validation.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from '../../src/config/index.js';

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'yatt-ts-config-'));
}

function expectConfigError(run: () => unknown, messagePattern: RegExp): ConfigError {
  try {
    run();
  } catch (error) {
    expect(error, `expected ConfigError matching ${messagePattern}`).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.message).toMatch(messagePattern);
    return configError;
  }
  throw new Error(`expected resolveConfig to throw matching ${messagePattern}, but it succeeded`);
}

describe('defaults (C14, C28)', () => {
  it('resolves zero-config to the documented defaults', () => {
    const cfg = resolveConfig();
    const cwd = process.cwd();

    expect(cfg.paths).toEqual({
      root: cwd,
      tests: path.join(cwd, 'tests'),
      reports: path.join(cwd, 'reports'),
      exports: path.join(cwd, 'exports'),
      baselines: path.join(cwd, 'baselines'),
      sessions: path.join(cwd, 'sessions'),
      db: path.join(cwd, 'yatt.db'),
    });
    expect(cfg.http).toEqual({ enabled: false, port: 3191, host: '127.0.0.1', cors: { origins: ['*'] } });
    expect(cfg.auth).toBeUndefined();
    expect(cfg.permissions).toEqual({ readOnly: false, denyBehavior: 'error' });
    expect(cfg.sessions).toEqual({ persist: true });
    expect(cfg.storage).toEqual({});
    expect(cfg.engine).toEqual({
      enabled: true,
      runtime: 'auto',
      readyTimeoutMs: 20000,
      requestTimeoutMs: 120000,
      closeGraceMs: 5000,
      autoInstallBrowser: true,
    });
    expect(cfg.browser).toEqual({
      defaultHeadless: true,
      defaultViewport: { width: 1280, height: 800 },
      engine: 'chromium',
      toolbarInjection: false,
      gotoTimeoutMs: 30000,
      elementTimeoutMs: 5000,
      waitVisibleTimeoutMs: 10000,
      previewTimeoutMs: 5000,
      screenshotTimeoutMs: 10000,
      closeTimeoutMs: 6000,
      runStepTimeoutMs: 40000,
      cdpSync: { enabled: true, pollIntervalMs: 400 },
    });
    expect(cfg.runner).toEqual({ defaultBrowser: 'chromium', stepTimeoutMs: 40000, saveReport: true, datasetConcurrency: 1 });
    expect(cfg.appDb).toBeUndefined();
    expect(cfg.logging).toEqual({ level: 'info' });
    expect(cfg.locale).toBe('en');
  });

  it('treats an explicit empty object exactly like no arguments', () => {
    expect(resolveConfig({})).toEqual(resolveConfig());
  });

  it('keeps storage.retention undefined when absent (D16: no cleanup by default)', () => {
    expect(resolveConfig().storage.retention).toBeUndefined();
    expect(resolveConfig({ storage: {} }).storage.retention).toBeUndefined();
    expect(resolveConfig({ storage: { retention: { maxReports: 5 } } }).storage.retention).toEqual({ maxReports: 5 });
  });
});

describe('strict validation (C13)', () => {
  it('rejects unknown top-level keys naming the key', () => {
    expectConfigError(() => resolveConfig({ ports: 3192 }), /config\.ports: unrecognized key/);
  });

  it('rejects unknown nested keys naming the key path', () => {
    expectConfigError(() => resolveConfig({ browser: { toolbar: true } }), /config\.browser\.toolbar: unrecognized key/);
    expectConfigError(
      () => resolveConfig({ browser: { defaultViewport: { widths: 99 } } }),
      /config\.browser\.defaultViewport\.widths: unrecognized key/,
    );
  });

  it('rejects wrong types naming the key path with expected/got', () => {
    expectConfigError(() => resolveConfig({ http: { port: '3191' } }), /config\.http\.port: expected number, got string/);
    expectConfigError(
      () => resolveConfig({ browser: { defaultViewport: { width: 'wide' } } }),
      /config\.browser\.defaultViewport\.width: expected number, got string/,
    );
  });

  it('rejects invalid enum values and out-of-range numbers naming the key', () => {
    expectConfigError(() => resolveConfig({ locale: 'fr' }), /config\.locale/);
    expectConfigError(() => resolveConfig({ engine: { readyTimeoutMs: 0 } }), /config\.engine\.readyTimeoutMs/);
    expectConfigError(() => resolveConfig({ runner: { datasetConcurrency: 2 } }), /config\.runner\.datasetConcurrency/);
  });

  it('rejects non-object input', () => {
    expectConfigError(() => resolveConfig('nope'), /config: expected object, got string/);
    expectConfigError(() => resolveConfig(null), /config: expected object, got null/);
  });
});

describe('auth validation (C06 groundwork)', () => {
  it('accepts a token with the minimum 16 characters', () => {
    const cfg = resolveConfig({ auth: { token: 'x'.repeat(16) } });
    expect(cfg.auth?.token).toBe('x'.repeat(16));
  });

  it('rejects a token shorter than 16 characters naming the key', () => {
    expectConfigError(() => resolveConfig({ auth: { token: 'x'.repeat(15) } }), /config\.auth\.token/);
  });

  it('accepts a 64 hex char tokenHash and rejects anything else', () => {
    const cfg = resolveConfig({ auth: { tokenHash: 'a'.repeat(64) } });
    expect(cfg.auth?.tokenHash).toBe('a'.repeat(64));
    expectConfigError(() => resolveConfig({ auth: { tokenHash: 'zz'.repeat(32) } }), /config\.auth\.tokenHash/);
    expectConfigError(() => resolveConfig({ auth: { tokenHash: 'a'.repeat(63) } }), /config\.auth\.tokenHash/);
  });

  it('rejects providing both token and tokenHash', () => {
    expectConfigError(
      () => resolveConfig({ auth: { token: 'x'.repeat(16), tokenHash: 'a'.repeat(64) } }),
      /config\.auth: provide either "token" or "tokenHash", not both/,
    );
  });

  it('allows an empty auth domain (both absent = no auth)', () => {
    expect(resolveConfig({ auth: {} }).auth).toEqual({});
  });
});

describe('appDb validation (D22, C21 groundwork)', () => {
  it('accepts a sqlite connection', () => {
    expect(resolveConfig({ appDb: { type: 'sqlite', file: 'app.db' } }).appDb).toEqual({ type: 'sqlite', file: 'app.db' });
  });

  it('applies postgres defaults and keeps optional fields undefined', () => {
    // Exactly one of password/passwordProvider is mandatory for postgres (D22).
    const cfg = resolveConfig({
      appDb: { type: 'postgres', host: 'db.local', user: 'u', database: 'd', password: 'secret' },
    });
    expect(cfg.appDb).toEqual({ type: 'postgres', host: 'db.local', port: 5432, user: 'u', database: 'd', password: 'secret' });
    expect(cfg.appDb?.passwordProvider).toBeUndefined();
    expect(cfg.appDb?.ssl).toBeUndefined();
  });

  it('accepts exactly one of password or passwordProvider', () => {
    const provider = () => 'secret';
    const withPassword = resolveConfig({
      appDb: { type: 'postgres', host: 'h', user: 'u', database: 'd', password: 'secret' },
    });
    expect(withPassword.appDb).toMatchObject({ password: 'secret' });
    expect(withPassword.appDb?.passwordProvider).toBeUndefined();

    const withProvider = resolveConfig({
      appDb: { type: 'postgres', host: 'h', user: 'u', database: 'd', passwordProvider: provider },
    });
    expect(withProvider.appDb).toMatchObject({ passwordProvider: provider });
    expect(withProvider.appDb?.password).toBeUndefined();
  });

  it('rejects providing both password and passwordProvider', () => {
    expectConfigError(
      () =>
        resolveConfig({
          appDb: { type: 'postgres', host: 'h', user: 'u', database: 'd', password: 's', passwordProvider: () => 's' },
        }),
      /config\.appDb: provide exactly one of "password" or "passwordProvider"/,
    );
  });

  it('rejects a postgres connection with neither password nor passwordProvider', () => {
    expectConfigError(
      () => resolveConfig({ appDb: { type: 'postgres', host: 'h', user: 'u', database: 'd' } }),
      /config\.appDb: provide exactly one of "password" or "passwordProvider"/,
    );
  });

  it('rejects an unknown discriminator and missing required fields naming the key', () => {
    expectConfigError(() => resolveConfig({ appDb: { type: 'mysql' as never } }), /config\.appDb\.type/);
    expectConfigError(
      () => resolveConfig({ appDb: { type: 'postgres', user: 'u', database: 'd' } }),
      /config\.appDb\.host/,
    );
  });

  it('rejects unknown keys inside a union member naming the key', () => {
    expectConfigError(
      () => resolveConfig({ appDb: { type: 'sqlite', file: 'a.db', host: 'x' } }),
      /config\.appDb\.host: unrecognized key/,
    );
  });
});

describe('path resolution (C11)', () => {
  it('resolves a relative root against cwd and derives artifact paths from it', () => {
    const cfg = resolveConfig({ paths: { root: './tmp-yatt-root' } });
    const root = path.resolve(process.cwd(), 'tmp-yatt-root');
    expect(cfg.paths.root).toBe(root);
    expect(cfg.paths.tests).toBe(path.join(root, 'tests'));
    expect(cfg.paths.reports).toBe(path.join(root, 'reports'));
    expect(cfg.paths.exports).toBe(path.join(root, 'exports'));
    expect(cfg.paths.baselines).toBe(path.join(root, 'baselines'));
    expect(cfg.paths.sessions).toBe(path.join(root, 'sessions'));
    expect(cfg.paths.db).toBe(path.join(root, 'yatt.db'));
  });

  it('keeps absolute roots and resolves relative artifacts against the root', () => {
    const base = tmpDir();
    try {
      const cfg = resolveConfig({ paths: { root: base, tests: 'specs/tests', db: 'data/app-db.sqlite' } });
      expect(cfg.paths.root).toBe(path.normalize(base));
      expect(cfg.paths.tests).toBe(path.join(base, 'specs/tests'));
      expect(cfg.paths.db).toBe(path.join(base, 'data/app-db.sqlite'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps absolute artifact paths untouched', () => {
    const base = tmpDir();
    try {
      const customTests = path.join(base, 'custom-tests');
      const cfg = resolveConfig({ paths: { root: base, tests: customTests } });
      expect(cfg.paths.tests).toBe(path.normalize(customTests));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('expands ~ to the home directory', () => {
    const cfg = resolveConfig({ paths: { root: '~', tests: '~/yatt-ts-tests' } });
    expect(cfg.paths.root).toBe(homedir());
    expect(cfg.paths.tests).toBe(path.join(homedir(), 'yatt-ts-tests'));
  });

  it('never mutates the input object', () => {
    const input = {
      paths: { root: './rel-root', tests: 't' },
      http: { port: 4000, cors: { origins: ['https://a'] } },
      permissions: { allowTools: ['ping'] },
    };
    const snapshot = JSON.stringify(input);
    const cfg = resolveConfig(input);

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.paths.root).toBe('./rel-root');

    // Returned object shares no array references with the input.
    input.http.cors.origins.push('https://b');
    input.permissions.allowTools?.push('schema');
    expect(cfg.http.cors.origins).toEqual(['https://a']);
    expect(cfg.permissions.allowTools).toEqual(['ping']);
  });
});

describe('impossible paths fail fast (C13)', () => {
  it('rejects a root that exists as a file', () => {
    const base = tmpDir();
    try {
      const filePath = path.join(base, 'not-a-dir');
      writeFileSync(filePath, 'x');
      expectConfigError(() => resolveConfig({ paths: { root: filePath } }), /config\.paths\.root:.*not a directory/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a db path that exists as a directory', () => {
    const base = tmpDir();
    try {
      const dirPath = path.join(base, 'db-dir');
      mkdirSync(dirPath);
      expectConfigError(
        () => resolveConfig({ paths: { root: base, db: dirPath } }),
        /config\.paths\.db:.*not a file/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('allows paths that do not exist yet (created later by the store)', () => {
    const base = tmpDir();
    try {
      const freshRoot = path.join(base, 'missing-root');
      const cfg = resolveConfig({ paths: { root: freshRoot, tests: 'missing/nested' } });
      expect(cfg.paths.root).toBe(path.normalize(freshRoot));
      expect(cfg.paths.tests).toBe(path.join(path.normalize(freshRoot), 'missing/nested'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
