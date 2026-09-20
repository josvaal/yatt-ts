#!/usr/bin/env node
/**
 * `yatt-ts` command line entry point (T10, C30, D3).
 *
 *   yatt-ts [serve] [--http] [--port N] [--host H] [--root PATH]
 *           [--token T | --token-hash HEX64] [--read-only] [--locale en|es]
 *           [--no-engine] [--allow-tool NAME] [--deny-tool NAME]
 *           [--deny-behavior error|hide]
 *   yatt-ts --version | --help
 *
 * The CLI maps the flags onto a `YattConfig` and boots `createYattServer`.
 *
 * Security (D4, C06): `--http` without `--token`/`--token-hash` generates an
 * ephemeral crypto-secure token and prints it ONCE to stderr — it is never
 * printed or logged again (every other diagnostic only shows `redact()`
 * output). The stdio transport ignores auth, exactly like the base tool.
 * App-database credentials are NEVER accepted here: they belong to the
 * programmatic config or the engine environment (D22).
 */
import { pathToFileURL } from 'node:url';

import { resolveConfig } from './config/index.js';
import type { YattConfig } from './config/index.js';
import { createYattServer } from './mcp/server.js';
import type { YattServer } from './mcp/server.js';
import { generateToken, redact } from './security/index.js';
import { VERSION } from './version.js';

/** Error in the command-line arguments (exit code 2). */
export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

export type CliMode = 'serve' | 'version' | 'help';

/** Parsed CLI surface. Mapping onto `YattConfig` happens in `cliConfig()`. */
export interface CliOptions {
  mode: CliMode;
  http: boolean;
  port?: number;
  host?: string;
  root?: string;
  token?: string;
  tokenHash?: string;
  readOnly: boolean;
  locale?: 'en' | 'es';
  engine: boolean;
  allowTools: string[];
  denyTools: string[];
  denyBehavior?: 'error' | 'hide';
}

/** Usage text (also the `--help` output). */
export function usage(): string {
  return `yatt-ts — your own configurable YATT MCP server

Usage:
  yatt-ts [serve] [flags]
  yatt-ts --version
  yatt-ts --help

Commands:
  serve                        Start the MCP server (default when no command is given)

Flags:
  --http                       Serve over Streamable HTTP instead of stdio
  --port N                     HTTP port (default 3191)
  --host H                     HTTP bind host (default 127.0.0.1)
  --root PATH                  Data root directory (default: current working directory)
  --token T                    Bearer token for HTTP auth (minimum 16 characters)
  --token-hash HEX64           SHA-256 hex digest of the token instead of the plain token
  --read-only                  Deny every state-mutating tool (with an announced reason)
  --locale en|es               Prompt/message language (default en)
  --no-engine                  Run without the Playwright engine (browser/run/db tools off)
  --allow-tool NAME            Only these tools are allowed (repeatable)
  --deny-tool NAME             Reject these tools (repeatable)
  --deny-behavior error|hide   Denied tools announce on call (default) or hide from listings
  --version                    Print the version and exit
  --help                       Print this help and exit

Security:
  --http without --token/--token-hash generates an ephemeral token and prints
  it ONCE to stderr; pass --token or --token-hash to pin a stable one.
  The stdio transport never requires a token.
`;
}

/**
 * Parses the argv list (no `node`/script entries). Throws `CliArgError` with
 * a clear message for any malformed or unknown input (never a silent fix).
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    mode: 'serve',
    http: false,
    readOnly: false,
    engine: true,
    allowTools: [],
    denyTools: [],
  };

  const value = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new CliArgError(`flag ${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--version':
        opts.mode = 'version';
        return opts;
      case '--help':
        opts.mode = 'help';
        return opts;
      case 'serve':
        if (i !== 0) throw new CliArgError("'serve' must be the first argument");
        break;
      case '--http':
        opts.http = true;
        break;
      case '--port': {
        const raw = value(arg, i);
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new CliArgError(`--port must be an integer between 1 and 65535, got "${raw}"`);
        }
        opts.port = port;
        i++;
        break;
      }
      case '--host':
        opts.host = value(arg, i);
        i++;
        break;
      case '--root':
        opts.root = value(arg, i);
        i++;
        break;
      case '--token': {
        const token = value(arg, i);
        if (token.length < 16) {
          throw new CliArgError(
            `--token is too short (${token.length} characters): the token needs at least 16 characters`,
          );
        }
        opts.token = token;
        i++;
        break;
      }
      case '--token-hash': {
        const hash = value(arg, i);
        if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
          throw new CliArgError('--token-hash must be a SHA-256 hex digest (64 hexadecimal characters)');
        }
        opts.tokenHash = hash.toLowerCase();
        i++;
        break;
      }
      case '--read-only':
        opts.readOnly = true;
        break;
      case '--locale': {
        const locale = value(arg, i);
        if (locale !== 'en' && locale !== 'es') {
          throw new CliArgError(`--locale must be "en" or "es", got "${locale}"`);
        }
        opts.locale = locale;
        i++;
        break;
      }
      case '--no-engine':
        opts.engine = false;
        break;
      case '--allow-tool':
        opts.allowTools.push(value(arg, i));
        i++;
        break;
      case '--deny-tool':
        opts.denyTools.push(value(arg, i));
        i++;
        break;
      case '--deny-behavior': {
        const behavior = value(arg, i);
        if (behavior !== 'error' && behavior !== 'hide') {
          throw new CliArgError(`--deny-behavior must be "error" or "hide", got "${behavior}"`);
        }
        opts.denyBehavior = behavior;
        i++;
        break;
      }
      default:
        throw new CliArgError(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

/** Result of mapping flags onto config: the config plus, when `--http` ran
 *  without explicit credentials, the ephemeral token to print exactly once. */
export interface CliConfigResult {
  config: YattConfig;
  /** Present ONLY for the generated ephemeral token (D4); never logged again. */
  ephemeralToken: string | null;
}

/** Maps the parsed flags onto the library configuration object. */
export function cliConfig(opts: CliOptions): CliConfigResult {
  const config: YattConfig = {
    paths: { ...(opts.root ? { root: opts.root } : {}) },
    http: {
      enabled: opts.http,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.host ? { host: opts.host } : {}),
    },
    permissions: {
      ...(opts.readOnly ? { readOnly: true } : {}),
      ...(opts.allowTools.length > 0 ? { allowTools: [...opts.allowTools] } : {}),
      ...(opts.denyTools.length > 0 ? { denyTools: [...opts.denyTools] } : {}),
      ...(opts.denyBehavior ? { denyBehavior: opts.denyBehavior } : {}),
    },
    engine: { enabled: opts.engine },
    ...(opts.locale ? { locale: opts.locale } : {}),
  };

  // Auth (D4/C06): explicit token, else explicit hash, else — HTTP only — an
  // ephemeral generated one (returned so main() prints it exactly once).
  // stdio ignores auth: the config is built the same way but only the HTTP
  // transport enforces it.
  let ephemeralToken: string | null = null;
  if (opts.token) {
    config.auth = { token: opts.token };
  } else if (opts.tokenHash) {
    config.auth = { tokenHash: opts.tokenHash };
  } else if (opts.http) {
    ephemeralToken = generateToken();
    config.auth = { token: ephemeralToken };
  }
  return { config, ephemeralToken };
}

/** Boots `serve`: config → server → transport, then serves until signaled. */
async function serve(opts: CliOptions): Promise<void> {
  const { config, ephemeralToken } = cliConfig(opts);

  let handle: YattServer;
  try {
    handle = await createYattServer(config);
  } catch (err) {
    // Config errors (C13) land here: fast, clear, naming the offending key.
    console.error(`yatt-ts: failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  await handle.start();

  // D4: the ephemeral token is printed ONCE, to stderr, right after the
  // server is up; every other diagnostic only ever shows redacted material.
  if (ephemeralToken) {
    console.error('[yatt-ts] generated ephemeral token, pass --token or --token-hash to fix it');
    console.error(ephemeralToken);
  } else if (opts.token) {
    console.error(`[yatt-ts] auth enabled (bearer token ${redact(opts.token)})`);
  } else if (opts.tokenHash) {
    console.error('[yatt-ts] auth enabled (bearer token-hash)');
  }

  // server.start() registered SIGINT/SIGTERM → shutdown(); the CLI adds the
  // final process exit once the shutdown settles (the library itself never
  // calls process.exit).
  const exitAfterShutdown = (): void => {
    void handle.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);
  if (!opts.http) {
    // stdio: when the client hangs up (stdin EOF) leave cleanly.
    process.stdin.on('end', exitAfterShutdown);
  }

  // Serve until a signal/EOF fires exitAfterShutdown.
  await new Promise<never>(() => {});
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliArgError) {
      console.error(`yatt-ts: ${err.message}`);
      console.error("run 'yatt-ts --help' for usage");
      process.exit(2);
    }
    throw err;
  }

  if (opts.mode === 'version') {
    process.stdout.write(`yatt-ts ${VERSION}\n`);
    return;
  }
  if (opts.mode === 'help') {
    process.stdout.write(usage());
    return;
  }
  await serve(opts);
}

/** Entry-point detection that also works when compiled to dist/cli.js. */
function isMainModule(): boolean {
  if ((import.meta as { main?: boolean }).main === true) return true;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error('yatt-ts: unexpected failure:', err);
    process.exit(1);
  });
}
