/**
 * Shared Streamable-HTTP session core (F4/D23).
 *
 * One implementation of the per-session HTTP machinery serves both
 * consumers:
 *   - the built-in server: `startHttp()` in `server.ts` delegates every
 *     request here, passing its bearer verifier as `authenticate` and its
 *     configured origins as `cors` (C06), and
 *   - the public `createMcpHttpHandler()` (below): the same routing mounted
 *     at ANY route of a host HTTP framework (NestJS/Express/Fastify-raw).
 *
 * Semantics (extracted verbatim from the original inline implementation in
 * `startHttp()`):
 *   - ONE transport PER SESSION (F4): every `initialize` POST builds its own
 *     `StreamableHTTPServerTransport`, live ones are tracked by session id,
 *     and a clean disconnect (DELETE / transport close) evicts only its own
 *     entry; later clients initialize again on the same server.
 *   - New-wins eviction (D23): the SDK allows ONE transport attached at a
 *     time; a client that vanished without a DELETE leaves a stale one
 *     attached, so the next `initialize` closes the stale transport and
 *     attaches the newcomer instead of wedging the server.
 *   - Body modes: `handle(req, res, body?)` accepts an ALREADY-PARSED JSON
 *     body (the framework path — Nest/Express body parsers) and falls back
 *     to reading the raw stream when the third argument is absent (the
 *     standalone path).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { YattServer } from './server.js';
import { redact, verifyToken } from '../security/index.js';

/** Default raw-body cap applied by `createMcpHttpHandler` (≈2 MB, F7). */
const DEFAULT_MAX_BODY_BYTES = 2_000_000;

/**
 * F7: raised by the raw body reader when the accumulated stream exceeds
 * `maxBodyBytes`. Internal only — consumers see the 413 HTTP response.
 */
class BodyTooLargeError extends Error {
  constructor() {
    super('payload too large');
    this.name = 'BodyTooLargeError';
  }
}

/** Options for the shared session router. */
export interface SessionRouterOptions {
  /**
   * Per-request gate (host authentication): `false` → 401 JSON
   * `{ error: 'unauthorized' }` without touching MCP; a throw → controlled
   * 500 through the same error catch. Absent = no authentication at this
   * layer (the host framework's guards/middleware rule instead).
   */
  authenticate?: (req: IncomingMessage) => boolean | Promise<boolean>;
  /**
   * Opt-in CORS: echoes `Access-Control-Allow-Origin` from the origin list
   * ('*' keeps the wildcard behavior, otherwise the origin is echoed only
   * when listed) and answers OPTIONS with 204. Off by default — host
   * frameworks usually own CORS; the built-in server passes its configured
   * `http.cors.origins`. Without `cors`, OPTIONS requests flow through the
   * ordinary routing (unknown sessions answer 400).
   */
  cors?: { origins: string[] };
  /** Session id factory (defaults to `crypto.randomUUID()`). */
  sessionIdGenerator?: () => string;
  /**
   * F7: cap in bytes for the RAW body path (the standalone read of the
   * request stream). When the accumulated body exceeds it the request
   * answers 413 JSON `{ error: 'payload too large' }` and further data is
   * not consumed. The framework-parsed path (`body` third argument) is
   * unaffected — the host body parser owns that limit. Absent = no cap:
   * the built-in server passes nothing (legacy behavior unchanged), while
   * `createMcpHttpHandler` defaults it to 2_000_000 unless the host
   * overrides.
   */
  maxBodyBytes?: number;
}

/** The shared per-session HTTP routing surface. */
export interface McpSessionRouter {
  /**
   * Routes one request: CORS echo + OPTIONS short-circuit (when `cors` is
   * configured), the `authenticate` gate (when configured), then the
   * POST/GET/DELETE session routing. `body` (framework-parsed JSON) wins
   * over the raw stream. Never rejects: invalid JSON answers 400 -32700 and
   * unexpected failures answer a controlled 500.
   */
  handle(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
  /** Live session count (one transport per session). */
  sessionCount(): number;
  /** Closes every live transport and clears the session map. */
  close(): Promise<void>;
}

/**
 * Builds the per-session HTTP router around an `McpServer`. The router
 * manages `server.connect()` per session itself — no separate start step —
 * and owns the session transport map.
 */
export function createMcpSessionRouter(
  deps: { server: McpServer; log: (message: string) => void },
  options: SessionRouterOptions = {},
): McpSessionRouter {
  const { server, log } = deps;
  const sessionIdGenerator = options.sessionIdGenerator ?? (() => crypto.randomUUID());
  /** Live HTTP session transports (F4): tracked per session so a clean
   *  disconnect evicts its own entry only, and close() closes them all. */
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let activeTransport: StreamableHTTPServerTransport | null = null;
  /** F5: set once close() starts — an initialize still in flight must not
   *  register its transport into the just-cleared map. */
  let closed = false;

  /**
   * F4: one transport PER SESSION instead of a single shared one. The SDK
   * allows ONE transport attached at a time: a client that vanished without
   * a DELETE leaves a stale one attached ("wedges after crash"); evict it
   * and attach the newcomer. One client at a time still holds for the
   * engine surface (D23): engine calls are serialized by the sidecar chain.
   */
  const connectTransport = async (
    transport: StreamableHTTPServerTransport,
  ): Promise<void> => {
    try {
      await server.connect(transport);
    } catch {
      if (activeTransport && activeTransport !== transport) {
        await activeTransport.close().catch(() => {
          /* already closed */
        });
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
      let received = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        // F7: past the cap nothing more is consumed or accumulated.
        if (tooLarge) return;
        received += chunk.length;
        if (options.maxBodyBytes !== undefined && received > options.maxBodyBytes) {
          tooLarge = true;
          rejectBody(new BodyTooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) return;
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
    return typeof id === 'string' ? transports.get(id) : undefined;
  };

  const noSession = (res: ServerResponse): void => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid MCP session (initialize first)' },
        id: null,
      }),
    );
  };

  const parseError = (res: ServerResponse, err: unknown): void => {
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
  };

  async function handle(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
    try {
      // Permissive-by-default CORS like the base tool, honoring the
      // configured origin list: '*' keeps the wildcard behavior; otherwise
      // the origin is echoed only when listed (browsers then block the
      // rest). Opt-in: only when `cors` is configured.
      if (options.cors) {
        const origin = req.headers.origin;
        const allowOrigin = options.cors.origins.includes('*')
          ? '*'
          : origin && options.cors.origins.includes(origin)
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
      }

      // Host authentication gate: failures answer 401 JSON and never reach
      // the MCP surface; a throwing hook falls into the controlled 500.
      if (options.authenticate) {
        const allowed = await options.authenticate(req);
        if (!allowed) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }

      if (req.method === 'POST') {
        let parsed: unknown;
        if (body !== undefined) {
          // Framework path: the host body parser already parsed the JSON.
          parsed = body;
        } else {
          // Standalone path: read the raw stream ourselves.
          try {
            parsed = await readJsonBody(req);
          } catch (err) {
            if (err instanceof BodyTooLargeError) {
              // F7: capped body → 413 JSON, no further consumption.
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'payload too large' }));
              return;
            }
            parseError(res, err);
            return;
          }
        }
        if (isInitializeRequest(parsed)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator,
            onsessioninitialized: (sessionId) => {
              // F5: an initialize still in flight when close() ran must not
              // leak a transport into the cleared map — drop it immediately.
              if (closed) {
                void transport.close().catch(() => {
                  /* already closed */
                });
                return;
              }
              transports.set(sessionId, transport);
            },
          });
          // A clean disconnect (DELETE / transport close) evicts ONLY this
          // session; the server keeps serving everyone else and future
          // clients initialize again without "already initialized" errors.
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) transports.delete(id);
            if (activeTransport === transport) activeTransport = null;
          };
          await connectTransport(transport);
          await transport.handleRequest(req, res, parsed);
          return;
        }
        const transport = sessionOf(req);
        if (!transport) {
          noSession(res);
          return;
        }
        await transport.handleRequest(req, res, parsed);
        return;
      }
      // GET (standalone SSE) and DELETE (terminate session) are session-bound.
      const transport = sessionOf(req);
      if (!transport) {
        noSession(res);
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`[yatt-ts] HTTP request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    }
  }

  return {
    handle,
    sessionCount: () => transports.size,
    async close(): Promise<void> {
      // F5: from here on, in-flight initializes must not register.
      closed = true;
      // Same loop as the built-in server's shutdown: closing a transport
      // fires its onclose, which evicts its own map entry — safe against
      // the removal below.
      for (const transport of [...transports.values()]) {
        await transport.close().catch(() => {
          /* already closed */
        });
      }
      transports.clear();
      activeTransport = null;
    },
  };
}

/** Public handle returned by `createMcpHttpHandler()`. */
export interface McpHttpHandler {
  /**
   * Routes one HTTP request (POST/GET/DELETE, plus OPTIONS when `cors` is
   * configured). `body` is the ALREADY-PARSED request body from the host
   * framework (e.g. Express/Nest `req.body`); when omitted, the raw stream
   * is read instead — so the same handler works mounted OR standalone.
   */
  handle(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
  /** Live MCP sessions (one transport per session). */
  sessionCount(): number;
  /** Closes every live session. Call this BEFORE `yatt.shutdown()` on teardown. */
  close(): Promise<void>;
}

/**
 * Exposes an existing YattServer as a plain request handler mountable at
 * ANY route/path of a host HTTP framework (NestJS controller, Express
 * router, Fastify raw, plain node:http) — an alternative to the built-in
 * server (`http.enabled`), with the exact same per-session semantics
 * (F4/D23).
 *
 * Lifecycle (the EMBEDDER owns it):
 *   - Do NOT call `yatt.start()` in handler mode: the handler manages
 *     `server.connect()` per session itself, and `start()` would pick the
 *     configured stdio/HTTP transport instead.
 *   - On teardown call `handler.close()` first (closes all sessions), then
 *     `yatt.shutdown()` (flushes and closes the store/engine).
 *
 * One MCP client at a time still holds per YattServer instance (D23): when
 * a second client initializes, the stale session is evicted (new-wins).
 */
export function createMcpHttpHandler(
  yatt: YattServer,
  options: SessionRouterOptions = {},
): McpHttpHandler {
  // Same diagnostics channel as the built-in server: stderr, honoring the
  // resolved logging config (silent → no output, never the protocol channel).
  const log = (message: string): void => {
    if (yatt.ctx.config.logging.level !== 'silent') {
      console.error(message);
    }
  };

  // F1: handler mode is auth-free BY DEFAULT (the host framework's guards
  // rule — GATE 1). But when the host configured yatt auth AND supplied no
  // `authenticate` hook, silently ignoring that config would be surprising:
  // wire the same bearer check the built-in server uses ('Bearer <token>'
  // header, 401 JSON on failure, redacted log line) and say so exactly once.
  let routerOptions: SessionRouterOptions = options;
  const auth = yatt.ctx.config.auth;
  if (!options.authenticate && auth) {
    log('using yatt auth.token/auth.tokenHash as the handler authenticate (pass options.authenticate to override)');
    routerOptions = {
      ...options,
      authenticate: (req: IncomingMessage): boolean => {
        const header = req.headers.authorization ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
        if (presented && verifyToken(presented, auth)) return true;
        log(
          `[yatt-ts] rejected unauthorized request (presented token: ${presented ? redact(presented) : 'none'})`,
        );
        return false;
      },
    };
  }

  // F7: safe-by-default for the new standalone exposure — cap the raw body
  // path at ~2 MB unless the host overrides. The built-in server passes
  // nothing, so its legacy behavior is untouched (zero observable change).
  routerOptions = { maxBodyBytes: DEFAULT_MAX_BODY_BYTES, ...routerOptions };

  const router = createMcpSessionRouter({ server: yatt.server, log }, routerOptions);
  return {
    handle: (req, res, body) => router.handle(req, res, body),
    sessionCount: () => router.sessionCount(),
    close: () => router.close(),
  };
}
