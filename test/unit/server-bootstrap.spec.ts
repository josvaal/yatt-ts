/**
 * Server bootstrap spec (T5): createYattServer resolution, resources,
 * prompts/i18n, store location, auth misconfig and HTTP bearer auth.
 * Covers C01 (partial: client connects), C03, C05, C06, C28, plus the F4
 * stale-transport eviction branch and the F11 HTTP-without-auth warning.
 */
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createYattServer,
  generateToken,
  VERSION,
  type YattConfig,
  type YattServer,
} from '../../src/index.js';
import { jsonOf, makeTmpRoot, startWithClient, stop } from './helpers/mcp.js';

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bootstrap-spec', version: '0.0.0' },
  },
});

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

async function connect(handle: YattServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bootstrap-spec', version: '0.0.0' });
  await Promise.all([handle.start(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createYattServer bootstrap', () => {
  it('resolves a zero-config-style server and returns server + ctx (C28)', async () => {
    const root = makeTmpRoot();
    const handle = await createYattServer({ paths: { root } });

    expect(handle.server).toBeDefined();
    expect(handle.ctx.root).toBe(root);
    expect(handle.ctx.config.paths.db).toBe(join(root, 'yatt.db'));
    expect(handle.ctx.policy).toEqual({ readOnly: false, denyBehavior: 'error' });
    // Engine enabled by default (T7): the client is constructed eagerly, but
    // the engine process only spawns on the first request.
    expect(handle.ctx.sidecar).not.toBeNull();
    expect(handle.ctx.queryAppDb).not.toBeNull();

    await stop(handle, await connect(handle));
  });

  it('engine.enabled: false keeps the server engine-free (ping deferred)', async () => {
    const root = makeTmpRoot();
    const handle = await createYattServer({
      paths: { root },
      engine: { enabled: false },
    });
    expect(handle.ctx.sidecar).toBeNull();
    expect(handle.ctx.queryAppDb).toBeNull();
    const client = await connect(handle);
    const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
    expect(ping).toEqual({ ok: true, engine: 'deferred', version: VERSION });
    await stop(handle, client);
  });

  it('opens the store at the configured path (DB + mirrors under root)', async () => {
    const root = makeTmpRoot();
    const handle = await createYattServer({ paths: { root } });

    expect(existsSync(join(root, 'yatt.db'))).toBe(true);
    await handle.ctx.store.upsertTest('boot-test', '{"schemaVersion":1}');
    expect(existsSync(join(root, 'tests', 'boot-test.yatt.json'))).toBe(true);

    await handle.shutdown();
  });

  it('exposes readable resources: schema, tests/{name}, reports/{name} (C03)', async () => {
    const root = makeTmpRoot();
    const { handle, client } = await startWithClient({ paths: { root } });

    const schema = await client.readResource({ uri: 'yatt://schema' });
    expect(schema.contents[0].mimeType).toBe('text/markdown');
    expect(String(schema.contents[0].text)).toContain('# YATT test format (schemaVersion 1)');

    await client.callTool({
      name: 'test_create',
      arguments: {
        content: { schemaVersion: 1, steps: [{ action: 'goto', value: 'https://example.dev' }] },
        name: 'res-test',
      },
    });
    const test = await client.readResource({ uri: 'yatt://tests/res-test' });
    expect(JSON.parse(String(test.contents[0].text)).name).toBe('res-test');

    await handle.ctx.store.upsertReport('res-rep.json', '{"title":"res"}');
    const report = await client.readResource({ uri: 'yatt://reports/res-rep.json' });
    expect(JSON.parse(String(report.contents[0].text)).title).toBe('res');

    await expect(client.readResource({ uri: 'yatt://tests/missing' })).rejects.toThrow(
      /does not exist/,
    );
    // F9: the report-resource miss points at report_list (read guidance).
    await expect(client.readResource({ uri: 'yatt://reports/missing' })).rejects.toThrow(
      /report_list/,
    );

    await stop(handle, client);
  });

  it('lists 5 prompts; locale es returns Spanish names and content (C03, D14)', async () => {
    const rootEn = makeTmpRoot();
    const handleEn = await createYattServer({ paths: { root: rootEn } });
    const clientEn = await connect(handleEn);
    const enNames = (await clientEn.listPrompts()).prompts.map((p) => p.name);
    expect(enNames.length).toBeGreaterThanOrEqual(5);
    expect(enNames).toContain('create-test');
    expect(enNames).toContain('flow-battery');
    const enPrompt = await clientEn.getPrompt({ name: 'create-test' });
    expect(String((enPrompt.messages[0].content as { text: string }).text)).toContain(
      'You are going to create a complete YATT test',
    );
    await stop(handleEn, clientEn);

    const rootEs = makeTmpRoot();
    const handleEs = await createYattServer({ paths: { root: rootEs }, locale: 'es' });
    const clientEs = await connect(handleEs);
    const esNames = (await clientEs.listPrompts()).prompts.map((p) => p.name);
    expect(esNames).toEqual([
      'crear-test',
      'diagnosticar-reporte',
      'explorar-pagina',
      'exportar-spec',
      'bateria-de-flujos',
    ]);
    const esPrompt = await clientEs.getPrompt({ name: 'crear-test' });
    expect(String((esPrompt.messages[0].content as { text: string }).text)).toContain(
      'Vas a crear un test YATT completo',
    );
    const esSchema = await clientEs.readResource({ uri: 'yatt://schema' });
    expect(String(esSchema.contents[0].text)).toContain('# Formato de test de YATT');
    await stop(handleEs, clientEs);
  });

  it('rejects auth misconfig (token AND tokenHash) at boot (C13)', async () => {
    const root = makeTmpRoot();
    const config: YattConfig = {
      paths: { root },
      auth: { token: generateToken(), tokenHash: 'a'.repeat(64) },
    };
    await expect(createYattServer(config)).rejects.toThrow(/token/);
  });

  it('survives client disconnects: A connects → DELETE → B initializes on the SAME server (F4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yatt-ts-http-f4-'));
    const port = 30000 + Math.floor(Math.random() * 20000);
    const token = generateToken();
    const handle = await createYattServer({
      paths: { root },
      engine: { enabled: false },
      http: { enabled: true, port },
      auth: { token },
    });
    await handle.start();

    const url = `http://127.0.0.1:${port}/`;
    const authHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };

    /** Extracts the JSON-RPC payload out of a JSON or SSE body. */
    const payloadOf = async (res: Response): Promise<any> => {
      const raw = await res.text();
      const text = raw.startsWith('{') ? raw : /^data: (.*)$/m.exec(raw)?.[1] ?? '{}';
      return JSON.parse(text);
    };

    try {
      // Client A: initialize over HTTP.
      const initA = await fetch(url, { method: 'POST', headers: authHeaders, body: INIT_BODY });
      expect(initA.status).toBe(200);
      const sessionA = initA.headers.get('mcp-session-id');
      expect(sessionA).toBeTruthy();

      // A's session actually routes (tools/list answers inside the session).
      const listA = await fetch(url, {
        method: 'POST',
        headers: { ...authHeaders, 'mcp-session-id': sessionA! },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(listA.status).toBe(200);
      expect((await payloadOf(listA)).result?.tools?.length).toBeGreaterThan(0);

      // A disconnects CLEANLY (DELETE terminates the session).
      const del = await fetch(url, {
        method: 'DELETE',
        headers: { ...authHeaders, 'mcp-session-id': sessionA! },
      });
      expect(del.status).toBe(200);

      // Client B: initialize on the SAME server succeeds — no full shutdown on
      // A's disconnect, no "Server already initialized" for B (F4 regression).
      const initB = await fetch(url, { method: 'POST', headers: authHeaders, body: INIT_BODY });
      expect(initB.status).toBe(200);
      const sessionB = initB.headers.get('mcp-session-id');
      expect(sessionB).toBeTruthy();
      expect(sessionB).not.toBe(sessionA);
      const listB = await fetch(url, {
        method: 'POST',
        headers: { ...authHeaders, 'mcp-session-id': sessionB! },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      expect((await payloadOf(listB)).result?.tools?.length).toBeGreaterThan(0);

      // Explicit shutdown still closes everything (listener gone: the next
      // request either fails or is refused — undici throws on refused/reset).
      await handle.shutdown();
      let listenerGone = false;
      try {
        const after = await fetch(url, { method: 'POST', headers: authHeaders, body: INIT_BODY });
        listenerGone = !after.ok;
      } catch {
        listenerGone = true;
      }
      expect(listenerGone).toBe(true);
    } finally {
      await handle.shutdown();
      expect(existsSync(join(root, 'yatt.db'))).toBe(true);
    }
  }, 30000);

  it('evicts a stale attached transport: B initializes after A vanished WITHOUT DELETE (F4 new-wins branch)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yatt-ts-http-stale-'));
    const port = 30000 + Math.floor(Math.random() * 20000);
    const token = generateToken();
    const handle = await createYattServer({
      paths: { root },
      engine: { enabled: false },
      http: { enabled: true, port },
      auth: { token },
    });
    await handle.start();

    const url = `http://127.0.0.1:${port}/`;
    const authHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };

    /** Extracts the JSON-RPC payload out of a JSON or SSE body. */
    const payloadOf = async (res: Response): Promise<any> => {
      const raw = await res.text();
      const text = raw.startsWith('{') ? raw : /^data: (.*)$/m.exec(raw)?.[1] ?? '{}';
      return JSON.parse(text);
    };
    const listTools = (session: string, id: number): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: { ...authHeaders, 'mcp-session-id': session },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
      });

    try {
      // Client A initializes over HTTP and STAYS ATTACHED — no DELETE, exactly
      // like a client that crashed without a clean disconnect.
      const initA = await fetch(url, { method: 'POST', headers: authHeaders, body: INIT_BODY });
      expect(initA.status).toBe(200);
      const sessionA = initA.headers.get('mcp-session-id');
      expect(sessionA).toBeTruthy();

      // Client B initializes on the SAME server: the SDK rejects the second
      // attach and the new-wins path evicts A's stale transport, so B still
      // gets a fresh session instead of a wedge.
      const initB = await fetch(url, { method: 'POST', headers: authHeaders, body: INIT_BODY });
      expect(initB.status).toBe(200);
      const sessionB = initB.headers.get('mcp-session-id');
      expect(sessionB).toBeTruthy();
      expect(sessionB).not.toBe(sessionA);

      // B's session actually routes: tools/list answers inside it.
      const listB1 = await listTools(sessionB!, 2);
      expect(listB1.status).toBe(200);
      expect((await payloadOf(listB1)).result?.tools?.length).toBeGreaterThan(0);

      // The server is still alive: a third request from B works too.
      const listB2 = await listTools(sessionB!, 3);
      expect(listB2.status).toBe(200);
      expect((await payloadOf(listB2)).result?.tools?.length).toBeGreaterThan(0);

      // Sibling proof of the eviction: A's closed session no longer routes.
      const listA = await listTools(sessionA!, 4);
      expect(listA.status).toBe(400);

      // Clean shutdown at the end.
      await handle.shutdown();
    } finally {
      await handle.shutdown();
      expect(existsSync(join(root, 'yatt.db'))).toBe(true);
    }
  }, 30000);

  it('memory sessions are wiped on shutdown; zero disk traces (F6/C09/D7)', async () => {
    const root = makeTmpRoot();
    const handle = await createYattServer({
      paths: { root },
      engine: { enabled: false },
      sessions: { persist: false },
    });
    await handle.ctx.sessionSink.save('doomed', '{"cookies":[],"origins":[]}');
    expect(await handle.ctx.sessionSink.list()).toEqual(['doomed']);

    await handle.shutdown();

    expect(await handle.ctx.sessionSink.list()).toEqual([]);
    expect(await handle.ctx.sessionSink.get('doomed')).toBeNull();
    // Still zero disk: no sessions dir was ever created by the memory sink.
    expect(existsSync(join(root, 'sessions'))).toBe(false);
  });

  it('serves HTTP with bearer auth: 401 without token, accepted with it (C05, C06)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yatt-ts-http-'));
    const port = 30000 + Math.floor(Math.random() * 20000);
    const token = generateToken();
    const handle = await createYattServer({
      paths: { root },
      http: { enabled: true, port },
      auth: { token },
    });
    await handle.start(); // no transport → HTTP transport per config

    const url = `http://127.0.0.1:${port}/`;

    const noAuth = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: INIT_BODY });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({ error: 'unauthorized' });

    const badAuth = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Authorization: `Bearer not-the-token` },
      body: INIT_BODY,
    });
    expect(badAuth.status).toBe(401);

    const goodAuth = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: INIT_BODY,
    });
    expect(goodAuth.status).toBe(200);
    // The transport may answer with an SSE stream; pull the JSON-RPC payload
    // out of the `data:` line in that case.
    const raw = await goodAuth.text();
    const payload = raw.startsWith('{') ? raw : /^data: (.*)$/m.exec(raw)?.[1] ?? '{}';
    const body = JSON.parse(payload) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('yatt');

    await handle.shutdown();
    expect(existsSync(join(root, 'yatt.db'))).toBe(true);
  });

  it('warns exactly once when HTTP runs without auth; silent logging silences it (F11)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // HTTP + NO auth: exactly ONE authentication warning reaches stderr.
      const root = makeTmpRoot();
      const port = 30000 + Math.floor(Math.random() * 20000);
      const handle = await createYattServer({
        paths: { root },
        engine: { enabled: false },
        http: { enabled: true, port }, // no auth on purpose
      });
      await handle.start();
      await handle.shutdown();

      const authWarnings = errorSpy.mock.calls.filter((args) =>
        args.map(String).join(' ').includes('authentication'),
      );
      expect(authWarnings).toHaveLength(1);
      // The log channel was live during the boot (the listening line uses it).
      expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      errorSpy.mockClear();

      // Same boot with logging.level 'silent': ZERO console.error output.
      const quietRoot = makeTmpRoot();
      const quietPort = 30000 + Math.floor(Math.random() * 20000);
      const quiet = await createYattServer({
        paths: { root: quietRoot },
        engine: { enabled: false },
        http: { enabled: true, port: quietPort }, // still no auth
        logging: { level: 'silent' },
      });
      await quiet.start();
      await quiet.shutdown();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  }, 30000);

  it('answers the MCP client over the chosen transport (C01 partial)', async () => {
    const root = makeTmpRoot();
    // Engine disabled: deterministic ping without spawning the real bridge.
    const { handle, client } = await startWithClient({
      paths: { root },
      engine: { enabled: false },
    });
    const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
    expect(ping.ok).toBe(true);
    expect(ping.engine).toBe('deferred');
    await stop(handle, client);
  });
});
