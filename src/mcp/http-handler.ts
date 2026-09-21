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
            parseError(res, err);
            return;
          }
        }
        if (isInitializeRequest(parsed)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator,
            onsessioninitialized: (sessionId) => {
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
