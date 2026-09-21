/**
 * HTTP handler spec (T3): `createMcpHttpHandler` mounted on a throwaway
 * node:http server at a NESTED path (`/api/mcp`) — framework-agnostic proof
 * that doubles as the session-core parity check outside the built-in server.
 * Real HTTP (loopback fetch + one SDK StreamableHTTP client), NO Chromium
 * (engine.enabled: false everywhere) — always-on and fast.
 *
 * Covers C32 (session lifecycle parity), C33 (pre-parsed vs raw body, 400
 * -32700), C34 (authenticate hook true/false/throw), C37 (close + shutdown,
 * no leaked handles), C38 (engine-less: ping deferred + data tools) and
 * C39 (public export from the package root — the import above IS the proof).
 */
import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  createMcpHttpHandler,
  createYattServer,
  VERSION,
  type McpHttpHandler,
  type YattServer,
} from '../../src/index.js';
import { jsonOf, makeTmpRoot, textOf } from './helpers/mcp.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'http-handler-spec', version: '0.0.0' },
  },
});

/** Mounts the handler on a throwaway node:http server (framework-agnostic).
 *  `parsed: true` simulates a framework body parser (Nest/Express): the
 *  mount parses the JSON itself and passes it as the third argument. */
function mount(handler: McpHttpHandler, parsed = false): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((req, res) => {
    if (parsed && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        void handler.handle(req, res, body);
      });
      return;
    }
    void handler.handle(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/api/mcp` });
    });
  });
}

/** Stops the throwaway server without waiting on keep-alive sockets. */
async function unmount(server: Server): Promise<void> {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Extracts the JSON-RPC payload out of a JSON or SSE body. */
async function payloadOf(res: Response): Promise<any> {
  const raw = await res.text();
  const text = raw.startsWith('{') ? raw : /^data: (.*)$/m.exec(raw)?.[1] ?? '{}';
  return JSON.parse(text);
}

/** JSON-RPC POST against the mounted handler path. */
function postJson(
  url: string,
  session: string | null,
  message: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      ...(session ? { 'mcp-session-id': session } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });
}

/** Joint teardown: unmount → close every session → shut the server down. */
async function teardown(handler: McpHttpHandler, yatt: YattServer, server?: Server): Promise<void> {
  if (server) await unmount(server);
  await handler.close();
  await yatt.shutdown();
}

describe('createMcpHttpHandler', () => {
  it('is exported from the package root (C39)', () => {
    expect(typeof createMcpHttpHandler).toBe('function');
  });

  it(
    'manages the session lifecycle: initialize → DELETE → new-wins → evicted 400 (C32)',
    async () => {
      const yatt = await createYattServer({
        paths: { root: makeTmpRoot('yatt-ts-handler-life-') },
        engine: { enabled: false },
      });
      const handler = createMcpHttpHandler(yatt);
      const { server, url } = await mount(handler);
      try {
        // Client A initializes over the mounted handler.
        const initA = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: INIT_BODY });
        expect(initA.status).toBe(200);
        const sessionA = initA.headers.get('mcp-session-id');
        expect(sessionA).toBeTruthy();
        expect(handler.sessionCount()).toBe(1);

        // A's session routes (tools/list answers inside it).
        const listA = await postJson(url, sessionA!, { id: 2, method: 'tools/list', params: {} });
        expect(listA.status).toBe(200);
        expect((await payloadOf(listA)).result?.tools?.length).toBeGreaterThan(0);

        // A disconnects CLEANLY (DELETE): only its own session is evicted.
        const del = await fetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionA! },
        });
        expect(del.status).toBe(200);
        expect(handler.sessionCount()).toBe(0);

        // A2 initializes and STAYS ATTACHED (a client that will vanish
        // without a DELETE), then B initializes: new-wins eviction (D23)
        // gives B a fresh session and silently evicts A2's stale one.
        const initA2 = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: INIT_BODY });
        expect(initA2.status).toBe(200);
        const sessionA2 = initA2.headers.get('mcp-session-id');
        expect(sessionA2).toBeTruthy();
        const initB = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: INIT_BODY });
        expect(initB.status).toBe(200);
        const sessionB = initB.headers.get('mcp-session-id');
        expect(sessionB).toBeTruthy();
        expect(sessionB).not.toBe(sessionA2);
        expect(handler.sessionCount()).toBe(1);

        // B's session routes; A2's evicted session answers 400 no-session.
        const listB = await postJson(url, sessionB!, { id: 3, method: 'tools/list', params: {} });
        expect(listB.status).toBe(200);
        const listEvicted = await postJson(url, sessionA2!, {
          id: 4,
          method: 'tools/list',
          params: {},
        });
        expect(listEvicted.status).toBe(400);
        expect((await payloadOf(listEvicted)).error?.message).toContain('no valid MCP session');
      } finally {
        await teardown(handler, yatt, server);
      }
    },
    20000,
  );

  it(
    'accepts pre-parsed AND raw bodies; invalid JSON answers 400 -32700 (C33)',
    async () => {
      // Path 1 — framework style (Nest/Express): the mount parses the body
      // and passes it as the third argument of handle().
      const yattParsed = await createYattServer({
        paths: { root: makeTmpRoot('yatt-ts-handler-parsed-') },
        engine: { enabled: false },
      });
      const parsedHandler = createMcpHttpHandler(yattParsed);
      const parsedMount = await mount(parsedHandler, true);
      const initParsed = await fetch(parsedMount.url, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: INIT_BODY,
      });
      expect(initParsed.status).toBe(200);
      expect(initParsed.headers.get('mcp-session-id')).toBeTruthy();
      await teardown(parsedHandler, yattParsed, parsedMount.server);

      // Path 2 — standalone style: no third argument, the raw stream is read.
      const yattRaw = await createYattServer({
        paths: { root: makeTmpRoot('yatt-ts-handler-raw-') },
        engine: { enabled: false },
      });
      const rawHandler = createMcpHttpHandler(yattRaw);
      const rawMount = await mount(rawHandler);
      const initRaw = await fetch(rawMount.url, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: INIT_BODY,
      });
      expect(initRaw.status).toBe(200);
      expect(initRaw.headers.get('mcp-session-id')).toBeTruthy();

      // Missing/malformed JSON on the raw path → 400 with code -32700.
      const bad = await fetch(rawMount.url, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: 'not-json{{',
      });
      expect(bad.status).toBe(400);
      const badPayload = await payloadOf(bad);
      expect(badPayload.error?.code).toBe(-32700);
      expect(badPayload.error?.message).toContain('parse error');
      await teardown(rawHandler, yattRaw, rawMount.server);
    },
    20000,
  );

  it(
    'honors the authenticate hook: pass, 401 without MCP side effects, throw → controlled 500 (C34)',
    async () => {
      // false → 401 JSON and the MCP surface is never touched.
      const yattDenied = await createYattServer({
        paths: { root: makeTmpRoot('yatt-ts-handler-denied-') },
        engine: { enabled: false },
      });
      const denied = createMcpHttpHandler(yattDenied, { authenticate: () => false });
      const deniedMount = await mount(denied);
      const rejected = await fetch(deniedMount.url, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: INIT_BODY,
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({ error: 'unauthorized' });
      expect(denied.sessionCount()).toBe(0);
      await teardown(denied, yattDenied, deniedMount.server);

      // Throwing hook → controlled 500, and the handler stays alive.
      const yattBoom = await createYattServer({
        paths: { root: makeTmpRoot('yatt-ts-handler-boom-') },
        engine: { enabled: false },
      });
      const boom = createMcpHttpHandler(yattBoom, {
        authenticate: (req) => {
          if (req.headers['x-boom']) throw new Error('guard exploded');
          return true;
        },
      });
      const boomMount = await mount(boom);
      const exploded = await fetch(boomMount.url, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-boom': '1' },
        body: INIT_BODY,
      });
      expect(exploded.status).toBe(500);
      expect(await exploded.json()).toEqual({ error: 'internal error' });

      // true → proceeds normally (also proves the 500 did not wedge it).
      const allowed = await fetch(boomMount.url, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: INIT_BODY,
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('mcp-session-id')).toBeTruthy();
      expect(boom.sessionCount()).toBe(1);
      await teardown(boom, yattBoom, boomMount.server);
    },
    20000,
  );

  it(
    'closes clean: close() empties sessions, later requests fail fast, shutdown() leaves no handles (C37)',
    async () => {
      const root = makeTmpRoot('yatt-ts-handler-close-');
      const yatt = await createYattServer({ paths: { root }, engine: { enabled: false } });
      const handler = createMcpHttpHandler(yatt);
      const { server, url } = await mount(handler);

      const init = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: INIT_BODY });
      expect(init.status).toBe(200);
      const session = init.headers.get('mcp-session-id');
      expect(session).toBeTruthy();

      await handler.close();
      expect(handler.sessionCount()).toBe(0);

      // A request referencing the closed session gets a CLEAN error — no
      // hang, no crash.
      const after = await postJson(url, session!, { id: 2, method: 'tools/list', params: {} });
      expect(after.status).toBe(400);

      // Full teardown completes and the store is on disk (process can exit).
      await unmount(server);
      await handler.close(); // idempotent second call
      await yatt.shutdown();
      expect(existsSync(join(root, 'yatt.db'))).toBe(true);
    },
    20000,
  );

  it(
    'serves a full SDK client with the engine disabled: ping deferred, data tools work (C38)',
    async () => {
      const root = makeTmpRoot('yatt-ts-handler-engineless-');
      const yatt = await createYattServer({ paths: { root }, engine: { enabled: false } });
      const handler = createMcpHttpHandler(yatt);
      const { server, url } = await mount(handler);
      const transport = new StreamableHTTPClientTransport(new URL(url));
      const client = new Client({ name: 'handler-spec', version: '0.0.0' });
      await client.connect(transport);

      const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
      expect(ping).toEqual({ ok: true, engine: 'deferred', version: VERSION });

      // Data tools need no engine: create + list roundtrip through the route.
      await client.callTool({
        name: 'test_create',
        arguments: {
          name: 'handler-engineless',
          content: { schemaVersion: 1, steps: [{ action: 'goto', value: 'https://example.dev' }] },
        },
      });
      const listed = await client.callTool({ name: 'test_list', arguments: {} });
      expect(JSON.parse(textOf(listed)).count).toBe(1);
      expect(textOf(listed)).toContain('handler-engineless');
      expect(existsSync(join(root, 'tests', 'handler-engineless.yatt.json'))).toBe(true);

      client.close();
      await teardown(handler, yatt, server);
    },
    20000,
  );
});
