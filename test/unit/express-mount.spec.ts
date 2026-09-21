/**
 * Express mount e2e (T4): the handler embedded in a REAL framework router —
 * express as the stand-in for Nest's default platform adapter.
 *
 * Express 4 for the widest compatibility; the mount contract is identical
 * on express 5 (NestJS 11 ships it). This is the closest published analog
 * of a Nest controller route (`app.use('/api/mcp', …)` with `req.body`
 * already parsed by the framework). Always-on and Chromium-free
 * (engine.enabled: false).
 *
 * Covers C31 (external happy path at a NESTED route: initialize, tools/list,
 * test_create + test_list roundtrip persisted, DELETE terminates) plus the
 * authenticate:false path through the express-mounted route (C34 combined).
 */
import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  createMcpHttpHandler,
  createYattServer,
  type McpHttpHandler,
} from '../../src/index.js';
import { textOf } from './helpers/mcp.js';

/** Boots an express app with the handler mounted exactly like a Nest
 *  controller route would: body parsed by the framework, passed as the
 *  third argument. Returns the app server and its base URL. */
async function mountExpress(
  handler: McpHttpHandler,
): Promise<{ server: Server; url: string }> {
  const app = express();
  app.use(express.json());
  // The EXACT shape a Nest controller route would have: the framework
  // parsed `req.body`, the handler gets it as the third argument.
  app.use('/api/mcp', (req, res) => {
    void handler.handle(req, res, req.body);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/api/mcp` };
}

async function stopExpress(server: Server): Promise<void> {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('createMcpHttpHandler on express (framework mount, C31)', () => {
  it(
    'serves a full MCP client roundtrip at the nested /api/mcp route',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'yatt-ts-express-'));
      const yatt = await createYattServer({ paths: { root }, engine: { enabled: false } });
      const handler = createMcpHttpHandler(yatt);
      const { server, url } = await mountExpress(handler);

      const transport = new StreamableHTTPClientTransport(new URL(url));
      const client = new Client({ name: 'express-mount-spec', version: '0.0.0' });
      await client.connect(transport);

      // Initialize: the session id came back through the framework route.
      expect(transport.sessionId).toBeTruthy();

      // tools/list routes through the nested path with the required names.
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      for (const required of ['ping', 'test_create', 'test_run', 'test_list', 'schema']) {
        expect(names).toContain(required);
      }

      // Data roundtrip persisted to the configured tmp root.
      await client.callTool({
        name: 'test_create',
        arguments: {
          name: 'express-mount',
          content: { schemaVersion: 1, steps: [{ action: 'goto', value: 'https://example.dev' }] },
        },
      });
      const listed = await client.callTool({ name: 'test_list', arguments: {} });
      expect(JSON.parse(textOf(listed)).count).toBe(1);
      expect(textOf(listed)).toContain('express-mount');
      expect(existsSync(join(root, 'tests', 'express-mount.yatt.json'))).toBe(true);

      // DELETE terminates the session: the handler evicts its own entry.
      await transport.terminateSession();
      expect(handler.sessionCount()).toBe(0);

      client.close();
      await stopExpress(server);
      await handler.close();
      await yatt.shutdown();
      expect(existsSync(join(root, 'yatt.db'))).toBe(true);
    },
    20000,
  );

  it(
    'enforces the authenticate hook through the express-mounted route (C34)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'yatt-ts-express-auth-'));
      const yatt = await createYattServer({ paths: { root }, engine: { enabled: false } });
      const handler = createMcpHttpHandler(yatt, { authenticate: () => false });
      const { server, url } = await mountExpress(handler);

      const rejected = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'express-mount-spec', version: '0.0.0' },
          },
        }),
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({ error: 'unauthorized' });
      expect(handler.sessionCount()).toBe(0);

      await stopExpress(server);
      await handler.close();
      await yatt.shutdown();
    },
    20000,
  );
});
