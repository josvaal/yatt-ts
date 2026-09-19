/**
 * Strict zod schema for the yatt-ts configuration object.
 *
 * Design rules:
 * - Every domain is strict: unknown keys are rejected with an error naming the key (C13).
 * - Defaults mirror the current behavior of the base YATT tool (exploration report §5/§6):
 *   HTTP port 3191 on 127.0.0.1, viewport 1280x800, engine timeouts, and the artifact
 *   layout `yatt.db` + `tests/ reports/ exports/ baselines/ sessions/` under the root.
 * - Product decisions baked into defaults: headless ON (D10), toolbar injection OFF (D11),
 *   locale `en` (D14), sessions persisted (D7), retention disabled (D16).
 * - `paths` defaults are RELATIVE artifact names; `resolveConfig()` turns them into
 *   absolute paths against the resolved root.
 */
import { z } from 'zod';

/** Artifact paths relative to the data root; all overridable (C11). */
const PathsSchema = z.strictObject({
  /** Data root directory. Default: process.cwd() (resolved in resolveConfig). */
  root: z.string().min(1).optional(),
  tests: z.string().min(1).default('tests'),
  reports: z.string().min(1).default('reports'),
  exports: z.string().min(1).default('exports'),
  baselines: z.string().min(1).default('baselines'),
  sessions: z.string().min(1).default('sessions'),
  /** System database file. Default: <root>/yatt.db. */
  db: z.string().min(1).default('yatt.db'),
});

const CorsSchema = z.strictObject({
  origins: z
    .array(z.string().min(1))
    .default(() => ['*']),
});

const HttpSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Default matches the base tool's hardcoded port (3191). */
  port: z.number().int().min(1).max(65535).default(3191),
  host: z.string().min(1).default('127.0.0.1'),
  cors: CorsSchema.prefault({}),
});

/**
 * HTTP bearer auth (C06 groundwork). At most one of `token` / `tokenHash`;
 * both absent means no auth (stdio transport is unaffected).
 */
const AuthSchema = z
  .strictObject({
    /** Plain bearer token; minimum 16 characters. */
    token: z.string().min(16).optional(),
    /** SHA-256 hex digest of the token (64 hex chars); avoids keeping the plain token in config. */
    tokenHash: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
  })
  .refine((value) => !(value.token !== undefined && value.tokenHash !== undefined), {
    error: 'provide either "token" or "tokenHash", not both',
  });

/** Permissions (C07/C08 groundwork): global read-only plus per-tool allow/deny lists. */
const PermissionsSchema = z.strictObject({
  readOnly: z.boolean().default(false),
  allowTools: z.array(z.string().min(1)).optional(),
  denyTools: z.array(z.string().min(1)).optional(),
  /** 'error' keeps blocked tools visible but failing (D5/D6); 'hide' omits them from listings. */
  denyBehavior: z.enum(['error', 'hide']).default('error'),
});

/** Sessions persistence toggle (D7): false keeps sessions in memory, wiped on close. */
const SessionsSchema = z.strictObject({
  persist: z.boolean().default(true),
});

/** Optional cleanup of old reports (D16). Absent retention = never delete anything. */
const StorageSchema = z.strictObject({
  retention: z
    .strictObject({
      maxReports: z.number().int().min(1).optional(),
      maxAgeDays: z.number().int().min(1).optional(),
    })
    .optional(),
});

/** Engine sidecar lifecycle: runtime selection and timeouts (defaults = current behavior). */
const EngineSchema = z.strictObject({
  /**
   * 'auto' probes bun then node; 'bun'/'node' force a runtime; any other non-empty
   * string is treated as a binary path override.
   */
  runtime: z.string().min(1).default('auto'),
  readyTimeoutMs: z.number().int().min(1).default(20000),
  requestTimeoutMs: z.number().int().min(1).default(120000),
  closeGraceMs: z.number().int().min(1).default(5000),
  /** Auto-download Chromium on first use (D12). */
  autoInstallBrowser: z.boolean().default(true),
});

/** Browser defaults (C16): headless-first (D10), toolbar OFF (D11), current timeouts. */
const BrowserSchema = z.strictObject({
  defaultHeadless: z.boolean().default(true),
  defaultViewport: z
    .strictObject({
      width: z.number().int().min(1).default(1280),
      height: z.number().int().min(1).default(800),
    })
    .prefault({}),
  engine: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  toolbarInjection: z.boolean().default(false),
  gotoTimeoutMs: z.number().int().min(1).default(30000),
  elementTimeoutMs: z.number().int().min(1).default(5000),
  waitVisibleTimeoutMs: z.number().int().min(1).default(10000),
  previewTimeoutMs: z.number().int().min(1).default(5000),
  screenshotTimeoutMs: z.number().int().min(1).default(10000),
  closeTimeoutMs: z.number().int().min(1).default(6000),
  runStepTimeoutMs: z.number().int().min(1).default(40000),
  /** CDP viewport sync (chromium + visible mode only in the base tool). */
  cdpSync: z
    .strictObject({
      enabled: z.boolean().default(true),
      pollIntervalMs: z.number().int().min(1).default(400),
    })
    .prefault({}),
});

/** Headless runner defaults (defaults = current behavior). */
const RunnerSchema = z.strictObject({
  defaultBrowser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  stepTimeoutMs: z.number().int().min(1).default(40000),
  saveReport: z.boolean().default(true),
  /**
   * Fixed at 1 on purpose: the engine serializes calls through a single browser and
   * one client at a time (D23). Dataset rows always run sequentially.
   */
  datasetConcurrency: z.literal(1).default(1),
});

/** App-under-test database (C21, D22): TypeORM-style rich object; never credentials in argv. */
const PostgresPasswordProviderSchema = z.custom<() => string | Promise<string>>(
  (value) => typeof value === 'function',
);

const AppDbSqliteSchema = z.strictObject({
  type: z.literal('sqlite'),
  file: z.string().min(1),
});

const AppDbPostgresSchema = z
  .strictObject({
    type: z.literal('postgres'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5432),
    user: z.string().min(1),
    password: z.string().optional(),
    /** Provider function returning the password (sync or async); credentials never in argv. */
    passwordProvider: PostgresPasswordProviderSchema.optional(),
    database: z.string().min(1),
    ssl: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
  })
  .refine((value) => (value.password !== undefined) !== (value.passwordProvider !== undefined), {
    error: 'provide exactly one of "password" or "passwordProvider"',
  });

const AppDbSchema = z.discriminatedUnion('type', [AppDbSqliteSchema, AppDbPostgresSchema]);

const LoggingSchema = z.strictObject({
  level: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
});

export const YattConfigSchema = z.strictObject({
  paths: PathsSchema.prefault({}),
  http: HttpSchema.prefault({}),
  auth: AuthSchema.optional(),
  permissions: PermissionsSchema.prefault({}),
  sessions: SessionsSchema.prefault({}),
  storage: StorageSchema.prefault({}),
  engine: EngineSchema.prefault({}),
  browser: BrowserSchema.prefault({}),
  runner: RunnerSchema.prefault({}),
  appDb: AppDbSchema.optional(),
  logging: LoggingSchema.prefault({}),
  /** Prompt/SCHEMA_DOC/messages language (D14): 'en' default, 'es' option. */
  locale: z.enum(['en', 'es']).default('en'),
});

/** Raw (pre-resolution) configuration accepted by `resolveConfig`. */
export type YattConfig = z.input<typeof YattConfigSchema>;

/** Configuration right after zod parsing (defaults applied, paths still unresolved). */
export type ParsedConfig = z.output<typeof YattConfigSchema>;

/** Fully resolved configuration: all defaults applied and every path absolute. */
export type ResolvedConfig = Omit<ParsedConfig, 'paths'> & {
  paths: {
    root: string;
    tests: string;
    reports: string;
    exports: string;
    baselines: string;
    sessions: string;
    db: string;
  };
};
