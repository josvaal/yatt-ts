/**
 * Server bootstrap spec (T5): createYattServer resolution, resources,
 * prompts/i18n, store location, auth misconfig and HTTP bearer auth.
 * Covers C01 (partial: client connects), C03, C05, C06, C28.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createYattServer,
  generateToken,
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
    expect(handle.ctx.sidecar).toBeNull();
    expect(handle.ctx.queryAppDb).toBeNull();

    await stop(handle, await connect(handle));
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

  it('answers the MCP client over the chosen transport (C01 partial)', async () => {
    const root = makeTmpRoot();
    const { handle, client } = await startWithClient({ paths: { root } });
    const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
    expect(ping.ok).toBe(true);
    expect(ping.engine).toBe('deferred');
    await stop(handle, client);
  });
});
