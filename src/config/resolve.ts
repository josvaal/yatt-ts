/**
 * Config resolution: validate strict schema, apply defaults, and turn every
 * artifact path into an absolute path (C11) — failing fast and naming the
 * offending key for any invalid configuration (C13).
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ZodError } from 'zod';
import { YattConfigSchema, type ParsedConfig, type ResolvedConfig } from './schema.js';

/** A single configuration problem, addressed by its config key path. */
export interface ConfigIssue {
  /** Dot-separated path relative to the config root (e.g. `http.port`). Empty for root-level problems. */
  path: string;
  /** Human-readable description of what is wrong. */
  message: string;
}

/**
 * Thrown by `resolveConfig` for any invalid configuration: unknown keys, wrong
 * types, cross-field violations, or impossible paths. The message always names
 * the offending key (C13).
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(formatIssues(issues));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function formatIssues(issues: readonly ConfigIssue[]): string {
  const rendered = issues.map(({ path, message }) =>
    path.length > 0 ? `config.${path}: ${message}` : `config: ${message}`,
  );
  return `Invalid configuration: ${rendered.join('; ')}`;
}

type ZodIssueLike = ZodError['issues'][number];

function issueToConfigIssue(issue: ZodIssueLike): ConfigIssue {
  const basePath = issue.path.map(String).join('.');
  switch (issue.code) {
    case 'invalid_type': {
      // zod does not carry the offending input on invalid_type issues; extract the
      // received kind from its rendered message, falling back to the full message.
      const received = /received (.+)$/.exec(issue.message)?.[1];
      return {
        path: basePath,
        message: received ? `expected ${issue.expected}, got ${received}` : issue.message,
      };
    }
    case 'unrecognized_keys': {
      const keys = issue.keys.map((key) => String(key));
      if (keys.length === 1) {
        return { path: joinKeyPath(basePath, keys[0]), message: 'unrecognized key' };
      }
      return {
        path: basePath,
        message: `unrecognized keys: ${keys.map((key) => `"${key}"`).join(', ')}`,
      };
    }
    default:
      return { path: basePath, message: issue.message };
  }
}

function joinKeyPath(base: string, key: string): string {
  return base.length > 0 ? `${base}.${key}` : key;
}

function toConfigIssues(error: ZodError): ConfigIssue[] {
  return error.issues.map(issueToConfigIssue);
}

function expandTilde(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/')) return path.join(homedir(), target.slice(2));
  return target;
}

/** Expands `~` and resolves relative targets against `base`, returning a normalized absolute path. */
function resolveUserPath(target: string, base: string): string {
  const expanded = expandTilde(target);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

function resolvePaths(config: ParsedConfig): ResolvedConfig {
  const root = resolveUserPath(config.paths.root ?? process.cwd(), process.cwd());
  return {
    ...config,
    paths: {
      root,
      tests: resolveUserPath(config.paths.tests, root),
      reports: resolveUserPath(config.paths.reports, root),
      exports: resolveUserPath(config.paths.exports, root),
      baselines: resolveUserPath(config.paths.baselines, root),
      sessions: resolveUserPath(config.paths.sessions, root),
      db: resolveUserPath(config.paths.db, root),
    },
    http: { ...config.http, cors: { origins: [...config.http.cors.origins] } },
    permissions: {
      ...config.permissions,
      ...(config.permissions.allowTools ? { allowTools: [...config.permissions.allowTools] } : {}),
      ...(config.permissions.denyTools ? { denyTools: [...config.permissions.denyTools] } : {}),
    },
  };
}

const DIRECTORY_PATH_KEYS = ['root', 'tests', 'reports', 'exports', 'baselines', 'sessions'] as const;

/**
 * Early "impossible path" check (C13): a configured location that already exists
 * with the wrong kind (file where a directory is expected, or vice versa) can
 * never work, so fail now instead of mid-run. Missing paths are fine — they are
 * created later by the store.
 */
function assertPathsUsable(paths: ResolvedConfig['paths']): void {
  for (const key of DIRECTORY_PATH_KEYS) {
    assertPathKind(`paths.${key}`, paths[key], 'directory');
  }
  assertPathKind('paths.db', paths.db, 'file');
}

function assertPathKind(key: string, target: string, kind: 'directory' | 'file'): void {
  let stats;
  try {
    stats = statSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw new ConfigError([
      { path: key, message: `cannot inspect path "${target}": ${code ?? 'unknown error'}` },
    ]);
  }
  if (kind === 'directory' && !stats.isDirectory()) {
    throw new ConfigError([{ path: key, message: `path exists but is not a directory: "${target}"` }]);
  }
  if (kind === 'file' && !stats.isFile()) {
    throw new ConfigError([{ path: key, message: `path exists but is not a file: "${target}"` }]);
  }
}

/**
 * Validates and resolves the raw user configuration into a fully defaulted
 * `ResolvedConfig`. Never mutates the input; the returned object shares no
 * arrays with it.
 *
 * - `undefined` means zero-config: every default applies (C14/C28).
 * - Any problem throws {@link ConfigError} naming the offending key (C13).
 */
export function resolveConfig(input?: unknown): ResolvedConfig {
  const result = YattConfigSchema.safeParse(input === undefined ? {} : input);
  if (!result.success) {
    throw new ConfigError(toConfigIssues(result.error));
  }
  const resolved = resolvePaths(result.data);
  assertPathsUsable(resolved.paths);
  return resolved;
}
