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
 * (default, C04). SIGINT/SIGTERM trigger a graceful shutdown (close server,
 * flush sessions, close store) — never a bare `process.exit` from the
 * library side.
 */
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { resolveConfig, type ResolvedConfig, type YattConfig } from '../config/index.js';
import { engineOptionsFromConfig } from '../engine/options.js';
import { getStrings, type YattStrings } from '../i18n/index.js';
import { redact, verifyToken, type ToolPolicy } from '../security/index.js';
import { applyReportRetention, createSessionSink, Store, type RetentionResult } from '../store/index.js';
import { VERSION } from '../version.js';
import type { AppDbQueryResult, Ctx, QueryAppDb } from './ctx.js';
import { SidecarClient } from './sidecar-client.js';
import { registerPrompts } from './prompts.js';
import { createToolRegistrar } from './policy-middleware.js';
import { registerResources } from './resources.js';
import { registerDbTools } from './tools/db.js';
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
      appDb: config.appDb ?? null,
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

  const ctx: Ctx = {
    config,
    root: config.paths.root,
    store,
    sessionSink,
    policy,
    sidecar,
    queryAppDb,
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
  registerResources(server, ctx, strings);
  registerPrompts(server, strings);

  // ---- lifecycle ----

  let started = false;
  let shutDown = false;
  let httpServer: HttpServer | null = null;

  const onSignal = () => {
    void shutdown();
  };

  const log = (message: string): void => {
    if (config.logging.level !== 'silent') {
      console.error(message);
    }
  };

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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    const corsOrigins = config.http.cors.origins;
    const auth = config.auth;

    httpServer = createHttpServer((req, res) => {
      // Permissive-by-default CORS like the base tool, honoring the configured
      // origin list: '*' keeps the wildcard behavior; otherwise the origin is
      // echoed only when listed (browsers then block the rest).
      const origin = req.headers.origin;
      const allowOrigin = corsOrigins.includes('*')
        ? '*'
        : origin && corsOrigins.includes(origin)
          ? origin
          : undefined;
      if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Authorization',
      );
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // C06: bearer auth. Every non-OPTIONS request must present a valid
      // token; failures answer 401 JSON and never leak the token (only a
      // redacted hint reaches the diagnostics log).
      if (auth) {
        const header = req.headers.authorization ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
        if (!presented || !verifyToken(presented, auth)) {
          log(
            `[yatt-ts] rejected unauthorized request (presented token: ${presented ? redact(presented) : 'none'})`,
          );
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }

      void transport.handleRequest(req, res);
    });

    transport.onclose = () => {
      void shutdown();
    };

    await server.connect(transport);
    httpServer.listen(config.http.port, config.http.host);
    await new Promise<void>((resolve, reject) => {
      httpServer!.once('listening', resolve);
      httpServer!.once('error', reject);
    });
    log(
      `yatt-ts MCP listening on http://${config.http.host}:${config.http.port} (root: ${ctx.root})`,
    );
  }

  async function shutdown(): Promise<void> {
    if (shutDown) return;
    shutDown = true;

    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);

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
