/**
 * yatt-ts MCP server bootstrap (C01, C04, C05, C06, C28).
 *
 * `createYattServer(config)` resolves the strict configuration (T2), opens
 * the store (T3), builds the session sink and the tool policy (T4), registers
 * the tool registry with policy middleware (T6), resources and i18n prompts,
 * and returns a handle with `start()`/`shutdown()`.
 *
 * Transport: explicit argument (embedding/tests) → Streamable HTTP when
 * `http.enabled` (bearer auth when `auth` is configured, C06) → stdio
 * (default, C04). HTTP keeps one transport PER SESSION (F4): a client's clean
 * disconnect evicts only its own session and later clients can initialize
 * again on the same server; full shutdown closes every live transport.
 * SIGINT/SIGTERM trigger a graceful shutdown (close server, flush sessions,
 * close store) — never a bare `process.exit` from the library side.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { resolveConfig, type ResolvedConfig, type YattConfig } from '../config/index.js';
import { engineOptionsFromConfig } from '../engine/options.js';
import { getStrings, type YattStrings } from '../i18n/index.js';
import { redact, verifyToken, type ToolPolicy } from '../security/index.js';
import { applyReportRetention, createSessionSink, Store, type RetentionResult } from '../store/index.js';
import { VERSION } from '../version.js';
import type { AppDbQueryResult, Ctx, QueryAppDb } from './ctx.js';
import { createMcpSessionRouter, type McpSessionRouter } from './http-handler.js';
import { SidecarClient } from './sidecar-client.js';
import { registerPrompts } from './prompts.js';
import { createToolRegistrar } from './policy-middleware.js';
import { registerResources } from './resources.js';
import { registerDbTools, ROW_CAP } from './tools/db.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerMetaTools } from './tools/meta.js';
import { registerReportTools } from './tools/reports.js';
import { registerRunTools } from './tools/run.js';
import { registerTestTools } from './tools/tests.js';

/** Result of `createYattServer`: everything a consumer needs to run it. */
export interface YattServer {
  /** Underlying MCP server (advanced use: register extra tools/resources). */
  server: McpServer;
  /** Shared state used by the built-in tools and resources. */
  ctx: Ctx;
  /**
   * Connects a transport and starts serving. With no argument, the transport
   * is chosen from the configuration: Streamable HTTP when `http.enabled`,
   * stdio otherwise. Passing a transport skips the signal handlers (the
   * embedder owns the process lifecycle).
   */
  start(transport?: Transport): Promise<void>;
  /** Graceful shutdown: close server + HTTP listener, flush, close store. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Creates a fully configured YATT MCP server. Throws `ConfigError` on any
 * invalid input (C13) — including `auth` carrying both `token` and
 * `tokenHash`.
 */
export async function createYattServer(input?: YattConfig): Promise<YattServer> {
  const config: ResolvedConfig = resolveConfig(input);
  const strings: YattStrings = getStrings(config.locale);

  const store = await Store.open({
    db: config.paths.db,
    tests: config.paths.tests,
    reports: config.paths.reports,
  });
  const sessionSink = createSessionSink(config, store);

  const policy: ToolPolicy = {
    readOnly: config.permissions.readOnly,
    ...(config.permissions.allowTools ? { allowTools: [...config.permissions.allowTools] } : {}),
    ...(config.permissions.denyTools ? { denyTools: [...config.permissions.denyTools] } : {}),
    denyBehavior: config.permissions.denyBehavior,
  };

  // C29: serialized, joinable retention passes. Tools fire it without
  // awaiting; tests/verify can `await ctx.afterReportMutation()` to join.
  let retentionChain: Promise<RetentionResult> = Promise.resolve({ deleted: [] });
  const afterReportMutation = (): Promise<RetentionResult> => {
    retentionChain = retentionChain
      .then(() => applyReportRetention(store, config.storage.retention))
      .catch(() => ({ deleted: [] }));
    return retentionChain;
  };

  // App-db mode (C41): the `provider` arm runs db_query IN THIS PROCESS via
  // the host's function; nothing serializable exists to hand the engine
  // child, which keeps serving the browser/run tools only (R4).
  const providerAppDb = config.appDb?.type === 'provider' ? config.appDb : null;
  const connectionAppDb = providerAppDb ? null : (config.appDb ?? null);

  // Engine wiring (T7): the client is constructed eagerly (cheap) but the
  // engine process only spawns on the first request. With `engine.enabled`
  // explicitly false the server runs engine-free (ping reports 'deferred').
  let sidecar: SidecarClient | null = null;
  let queryAppDb: QueryAppDb | null = null;
  if (config.engine.enabled) {
    const client = new SidecarClient({
      root: config.paths.root,
      runtime: config.engine.runtime,
      readyTimeoutMs: config.engine.readyTimeoutMs,
      requestTimeoutMs: config.engine.requestTimeoutMs,
      closeGraceMs: config.engine.closeGraceMs,
      appDb: connectionAppDb,
      engineOptions: engineOptionsFromConfig(config),
    });
    sidecar = client;
    // db_query → engine JSON-RPC (base db tool ↔ appdb contract: per-call
    // `db` override wins over the configured connection; rows capped by the
    // engine at 200 with the real count in totalRows).
    queryAppDb = (params): Promise<AppDbQueryResult> =>
      client.req<AppDbQueryResult>(
        'db_query',
        params.db ? { sql: params.sql, db: params.db } : { sql: params.sql },
      );
  }
  if (providerAppDb) {
    // In-process adapter (C41; wins over the engine wiring for db_query):
    // the provider returns the FULL rows array of row objects; shaping
    // mirrors the engine's appdb.ts (columns from the first row, cells in
    // column order, real count in totalRows) and db_query caps the output.
    const provider = providerAppDb.provider;
    queryAppDb = async ({ sql }) => {
      const result = await provider(sql);
      // F2 (review round): a non-array return used to crash downstream with
      // a raw TypeError — fail with the provider contract error instead.
      if (!Array.isArray(result)) {
        throw new Error(
          `appDb provider must return an array of row objects (got ${typeof result})`,
        );
      }
      // F5 (review round): memory parity with the engine's appdb.ts
      // shape() — count ALL rows, map only the first ROW_CAP, so a huge
      // result no longer allocates a mapped array for the discarded tail.
      // Output is byte-identical to capping after the map.
      const columns = result.length > 0 ? Object.keys(result[0]) : [];
      return {
        columns,
        rows: result.slice(0, ROW_CAP).map((row) => columns.map((column) => row[column])),
        totalRows: result.length,
      };
    };
  }

  const ctx: Ctx = {
    config,
    root: config.paths.root,
    store,
    sessionSink,
    policy,
    sidecar,
    queryAppDb,
    appDbProvider: providerAppDb !== null,
    afterReportMutation,
  };

  const server = new McpServer(
    { name: 'yatt', version: VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const registrar = createToolRegistrar(server, ctx);
  registerMetaTools(registrar, ctx, strings);
  registerTestTools(registrar, ctx, strings);
  registerReportTools(registrar, ctx, strings);
  registerDbTools(registrar, ctx, strings);
  registerRunTools(registrar, ctx, strings);
  // Browser tools (T9): live-browser control + the session persistence
  // toggle (ctx.sessionSink; sessions.persist:false → memory-only, D7).
  registerBrowserTools(registrar, ctx, strings);
  registerResources(server, ctx, strings);
  registerPrompts(server, strings);

  // ---- lifecycle ----

  let started = false;
  let shutDown = false;
  let httpServer: HttpServer | null = null;
  /** Shared per-session HTTP router (F4): created by `startHttp()` and closed
   *  by `shutdown()` — it owns the session transport map. */
  let httpRouter: McpSessionRouter | null = null;

  const onSignal = () => {
    void shutdown();
  };

  const log = (message: string): void => {
    if (config.logging.level !== 'silent') {
      console.error(message);
    }
  };

  // C46: honest one-line notice (F11 style, stderr) about the process
  // boundary — the provider covers db_query in this process, but the engine
  // child's db_assert/db_wait steps still need sqlite/postgres appDb config.
  if (config.engine.enabled && config.appDb?.type === 'provider') {
    log(
      'appDb provider covers the db_query tool in this process; test_run db_assert/db_wait steps run in the engine child and need sqlite/postgres appDb config',
    );
  }

  async function start(transport?: Transport): Promise<void> {
    if (started) throw new Error('yatt-ts server already started');
    if (shutDown) throw new Error('yatt-ts server already shut down');
    started = true;

    if (transport) {
      // Embedded mode: the caller owns the process lifecycle.
      await server.connect(transport);
      return;
    }

    if (config.http.enabled) {
      await startHttp();
    } else {
      await server.connect(new StdioServerTransport());
      log(`yatt-ts MCP ready (root: ${ctx.root})`);
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  async function startHttp(): Promise<void> {
    const corsOrigins = config.http.cors.origins;
    const auth = config.auth;

    // F11: warn exactly once when HTTP runs without auth (plain text, no
    // redaction needed — the message never carries secret material).
    if (!auth) {
      log('HTTP server is running WITHOUT authentication; set auth.token or auth.tokenHash');
    }

    /**
     * C06: bearer auth as the router's `authenticate` gate. Every
     * non-OPTIONS request must present a valid token; failures answer 401
     * JSON and never leak the token (only a redacted hint reaches the
     * diagnostics log).
     */
    const bearerCheck = (req: IncomingMessage): boolean => {
      if (!auth) return true;
      const header = req.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (presented && verifyToken(presented, auth)) return true;
      log(
        `[yatt-ts] rejected unauthorized request (presented token: ${presented ? redact(presented) : 'none'})`,
      );
      return false;
    };

    // The shared session core (http-handler.ts) owns the per-session
    // transport map, new-wins eviction and the POST/GET/DELETE routing;
    // the 500 catch lives inside the router too, so the observable
    // responses of the built-in server are unchanged.
    const router = createMcpSessionRouter(
      { server, log },
      { authenticate: bearerCheck, cors: { origins: corsOrigins } },
    );
    httpRouter = router;

    httpServer = createHttpServer((req, res) => {
      void router.handle(req, res);
    });

    await listen();
    log(
      `yatt-ts MCP listening on http://${config.http.host}:${config.http.port} (root: ${ctx.root})`,
    );

    /** Binds the HTTP listener, resolving on 'listening' (or throwing). */
    async function listen(): Promise<void> {
      httpServer!.listen(config.http.port, config.http.host);
      await new Promise<void>((resolve, reject) => {
        httpServer!.once('listening', resolve);
        httpServer!.once('error', reject);
      });
    }
  }

  async function shutdown(): Promise<void> {
    if (shutDown) return;
    shutDown = true;

    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);

    // F4: close EVERY live HTTP session transport via the shared router
    // (not just the attached one), then the server itself. Closing a
    // transport fires its onclose, which evicts its own map entry — safe
    // against the clear inside close().
    try {
      await httpRouter?.close();
    } catch {
      /* already closed */
    }
    httpRouter = null;
    try {
      await server.close();
    } catch {
      /* already closed */
    }
    if (httpServer) {
      const closing = httpServer;
      httpServer = null;
      closing.closeIdleConnections?.();
      closing.closeAllConnections?.();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
    try {
      await sessionSink.flush();
      // D7/C09 (F6): memory-only sessions are wiped on close; the persistent
      // sink's clear() is a no-op (persisted data belongs to the owner).
      await sessionSink.clear();
    } catch {
      /* nothing queued */
    }
    // Orderly engine shutdown: EOF on stdin → the bridge closes Chromium.
    try {
      await sidecar?.close();
    } catch {
      /* engine already gone */
    }
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }

  return { server, ctx, start, shutdown };
}
