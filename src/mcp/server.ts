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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

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
  // Browser tools (T9): live-browser control + the session persistence
  // toggle (ctx.sessionSink; sessions.persist:false → memory-only, D7).
  registerBrowserTools(registrar, ctx, strings);
  registerResources(server, ctx, strings);
  registerPrompts(server, strings);

  // ---- lifecycle ----

  let started = false;
  let shutDown = false;
  let httpServer: HttpServer | null = null;
  /** Live HTTP session transports (F4): tracked per session so a clean
   *  disconnect evicts its own entry only, and shutdown closes them all. */
  const httpTransports = new Map<string, StreamableHTTPServerTransport>();

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
    const corsOrigins = config.http.cors.origins;
    const auth = config.auth;

    // F11: warn exactly once when HTTP runs without auth (plain text, no
    // redaction needed — the message never carries secret material).
    if (!auth) {
      log('HTTP server is running WITHOUT authentication; set auth.token or auth.tokenHash');
    }

    /**
     * F4: one transport PER SESSION instead of a single shared one.
     * Previously a lone transport was created at startup and its `onclose`
     * triggered a FULL server shutdown, so the first clean client disconnect
     * killed the server and every later `initialize` answered 400 "Server
     * already initialized". Now each `initialize` POST builds its own
     * transport, live ones are tracked by session id, and a close only
     * evicts its own entry. One client at a time still holds for the engine
     * surface (D23): engine calls are serialized by the sidecar chain.
     */
    let activeTransport: StreamableHTTPServerTransport | null = null;

    const connectTransport = async (
      transport: StreamableHTTPServerTransport,
    ): Promise<void> => {
      try {
        await server.connect(transport);
      } catch {
        // The SDK allows ONE transport attached at a time. A client that
        // vanished without a DELETE leaves a stale one attached ("wedges
        // after crash"); evict it and attach the newcomer.
        if (activeTransport && activeTransport !== transport) {
          await activeTransport.close().catch(() => {});
          await server.connect(transport);
        } else {
          throw new Error('server transport already attached and no stale session to evict');
        }
      }
      activeTransport = transport;
    };

    const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
      new Promise((resolveBody, rejectBody) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!raw.trim()) {
            resolveBody(undefined);
            return;
          }
          try {
            resolveBody(JSON.parse(raw));
          } catch {
            rejectBody(new Error('parse error: invalid JSON body'));
          }
        });
        req.on('error', rejectBody);
      });

    const sessionOf = (req: IncomingMessage): StreamableHTTPServerTransport | undefined => {
      const id = req.headers['mcp-session-id'];
      return typeof id === 'string' ? httpTransports.get(id) : undefined;
    };

    const noSession = (res: import('node:http').ServerResponse): void => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid MCP session (initialize first)' },
          id: null,
        }),
      );
    };

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

      void (async () => {
        if (req.method === 'POST') {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32700,
                  message: err instanceof Error ? err.message : 'Parse error',
                },
                id: null,
              }),
            );
            return;
          }
          if (isInitializeRequest(body)) {
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (sessionId) => {
                httpTransports.set(sessionId, transport);
              },
            });
            // A clean disconnect (DELETE / transport close) evicts ONLY this
            // session; the server keeps serving everyone else and future
            // clients initialize again without "already initialized" errors.
            transport.onclose = () => {
              const id = transport.sessionId;
              if (id) httpTransports.delete(id);
              if (activeTransport === transport) activeTransport = null;
            };
            await connectTransport(transport);
            await transport.handleRequest(req, res, body);
            return;
          }
          const transport = sessionOf(req);
          if (!transport) {
            noSession(res);
            return;
          }
          await transport.handleRequest(req, res, body);
          return;
        }
        // GET (standalone SSE) and DELETE (terminate session) are session-bound.
        const transport = sessionOf(req);
        if (!transport) {
          noSession(res);
          return;
        }
        await transport.handleRequest(req, res);
      })().catch((err) => {
        log(`[yatt-ts] HTTP request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        } else {
          res.end();
        }
      });
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

    // F4: close EVERY live HTTP session transport (not just the attached one),
    // then the server itself. Closing a transport fires its onclose, which
    // evicts its own map entry — safe against the removal below.
    for (const transport of [...httpTransports.values()]) {
      await transport.close().catch(() => {
        /* already closed */
      });
    }
    httpTransports.clear();
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
