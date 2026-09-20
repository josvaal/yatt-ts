/**
 * Browser smoke (T9, C18 + D7/D10/D11) — REAL Chromium, runs ONLY with
 * YATT_TS_E2E=1 so the default `npx vitest run` stays fast:
 *
 *   npm run build && YATT_TS_E2E=1 npx vitest run test/e2e
 *
 * Full MCP flow through the COMPILED package (dist/) like a consumer:
 * browser_open (headless default) → run_step type+click → eval → preview PNG
 * → session_save + browser restart with the session restored (persistent
 * mode) → close. Toolbar must NOT be injected by default (D11) and must be
 * injected when `browser.toolbarInjection: true`.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Loads the COMPILED package (dist/): the smoke proves the shipped artifact.
 * `npm run build` is required first (a clear error names it when missing).
 */
async function loadDist() {
  try {
    const pkg = await import(/* @vite-ignore */ new URL('../../dist/index.js', import.meta.url).href);
    return { createYattServer: pkg.createYattServer, resolveConfig: pkg.resolveConfig };
  } catch (error) {
    throw new Error(
      `the compiled package (dist/) is missing or broken — run "npm run build" before the browser e2e. Original error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const e2e = process.env.YATT_TS_E2E === '1' ? describe : describe.skip;

const PAGE = `<!doctype html>
<html><head><title>yatt-ts browser smoke</title></head>
<body>
  <h1 id="title">Hello YATT</h1>
  <input id="name" type="text" />
  <button id="go" onclick="document.getElementById('out').textContent = 'typed:' + document.getElementById('name').value">go</button>
  <span id="out"></span>
</body></html>`;

/** Local HTTP server (random port) so the smoke never touches the network. */
async function startServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function call(client: Client, name: string, args?: Record<string, unknown>): Promise<any> {
  return client.callTool({ name, arguments: args ?? {} });
}

function jsonOf(result: any): any {
  return JSON.parse(
    ((result?.content ?? []) as Array<{ type: string; text?: string }>)
      .map((b) => b.text ?? '')
      .join('\n'),
  );
}

function firstImage(result: any): { data: string; mimeType: string } | null {
  const block = ((result?.content ?? []) as Array<Record<string, string>>).find(
    (b) => b.type === 'image',
  );
  return block ? { data: block.data, mimeType: block.mimeType } : null;
}

e2e('browser smoke (T9)', () => {
  it(
    'open (headless default) → run_step type+click → preview PNG → session save/restore → close',
    async () => {
      const { createYattServer, resolveConfig } = await loadDist();
      const root = mkdtempSync(join(tmpdir(), 'yatt-ts-browser-e2e-'));
      const { server, url } = await startServer();
      const handle = await createYattServer(resolveConfig({ paths: { root } }));
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'smoke-client', version: '0.0.0' });
      await Promise.all([handle.start(serverTransport), client.connect(clientTransport)]);

      try {
        // ---- open with defaults: headless ON comes from config (D10) ----
        const open = jsonOf(await call(client, 'browser_open', { url }));
        expect(open.ok).toBe(true);
        expect(jsonOf(await call(client, 'browser_status'))).toMatchObject({ open: true });

        // ---- toolbar NOT injected by default (D11/C17) ----
        await new Promise((r) => setTimeout(r, 400));
        const injected = jsonOf(
          await call(client, 'browser_eval', {
            expression: 'Boolean(window.__yattInjected) || Boolean(document.querySelector(".yatt-tk"))',
          }),
        ).value;
        expect(injected).toBe(false);

        // ---- run_step: type + click with a real DOM effect (C18) ----
        const typed = jsonOf(
          await call(client, 'browser_run_step', {
            step: { action: 'type', selector: '#name', value: 'Ada' },
          }),
        );
        expect(typed).toMatchObject({ name: 'type', ok: true });
        const clicked = jsonOf(
          await call(client, 'browser_run_step', { step: { action: 'click', selector: '#go' } }),
        );
        expect(clicked).toMatchObject({ name: 'click', ok: true });
        const out = jsonOf(
          await call(client, 'browser_eval', { expression: "document.getElementById('out').textContent" }),
        ).value;
        expect(out).toBe('typed:Ada');

        // ---- preview returns a real PNG image block the AI can see ----
        const preview = await call(client, 'browser_preview');
        const image = firstImage(preview);
        expect(image).not.toBeNull();
        expect(image!.mimeType).toBe('image/png');
        const png = Buffer.from(image!.data, 'base64');
        expect(png.length).toBeGreaterThan(1000);
        expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

        // ---- persistent session (C10): save → DB + mirror, restore ----
        await call(client, 'browser_eval', {
          expression: "localStorage.setItem('yatt-smoke', 'session-works')",
        });
        const saved = jsonOf(await call(client, 'session_save', { name: 'smoke-session' }));
        expect(saved).toEqual({ ok: true, name: 'smoke-session' });
        expect(jsonOf(await call(client, 'session_list'))).toEqual({
          sessions: ['smoke-session'],
        });
        // Mirror file exists (persistent mode = DB truth + sessions/ mirror).
        expect(existsSync(join(root, 'sessions', 'smoke-session.json'))).toBe(true);

        // Restart the browser WITH the saved session: localStorage comes back.
        expect(jsonOf(await call(client, 'browser_close'))).toEqual({ ok: true, open: false });
        const reopened = jsonOf(
          await call(client, 'browser_open', { url, session: 'smoke-session' }),
        );
        expect(reopened.ok).toBe(true);
        const restored = jsonOf(
          await call(client, 'browser_eval', { expression: "localStorage.getItem('yatt-smoke')" }),
        ).value;
        expect(restored).toBe('session-works');

        expect(jsonOf(await call(client, 'browser_close'))).toEqual({ ok: true, open: false });
      } finally {
        await client.close();
        await handle.shutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    180000,
  );

  it(
    'toolbar IS injected when browser.toolbarInjection is explicitly enabled',
    async () => {
      const { createYattServer, resolveConfig } = await loadDist();
      const root = mkdtempSync(join(tmpdir(), 'yatt-ts-browser-e2e-tb-'));
      const { server, url } = await startServer();
      const handle = await createYattServer(
        resolveConfig({ paths: { root }, browser: { toolbarInjection: true } }),
      );
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'smoke-client-tb', version: '0.0.0' });
      await Promise.all([handle.start(serverTransport), client.connect(clientTransport)]);
      try {
        expect(jsonOf(await call(client, 'browser_open', { url })).ok).toBe(true);
        // Init scripts run on navigation; give the page a beat.
        await new Promise((r) => setTimeout(r, 500));
        const injected = jsonOf(
          await call(client, 'browser_eval', { expression: 'Boolean(window.__yattInjected)' }),
        ).value;
        expect(injected).toBe(true);
        expect(jsonOf(await call(client, 'browser_close')).ok).toBe(true);
      } finally {
        await client.close();
        await handle.shutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    180000,
  );

  it(
    'memory mode (sessions.persist:false): session usable live, zero disk traces, restored INLINE by the real engine (C09, D7)',
    async () => {
      const { createYattServer, resolveConfig } = await loadDist();
      const root = mkdtempSync(join(tmpdir(), 'yatt-ts-browser-e2e-mem-'));
      const { server, url } = await startServer();
      const handle = await createYattServer(
        resolveConfig({ paths: { root }, sessions: { persist: false } }),
      );
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'smoke-client-mem', version: '0.0.0' });
      await Promise.all([handle.start(serverTransport), client.connect(clientTransport)]);

      try {
        expect(jsonOf(await call(client, 'browser_open', { url })).ok).toBe(true);
        await call(client, 'browser_eval', {
          expression: "localStorage.setItem('yatt-mem', 'ephemeral-works')",
        });
        expect(
          jsonOf(await call(client, 'session_save', { name: 'mem-session' })),
        ).toEqual({ ok: true, name: 'mem-session' });

        // Usable live through session_list…
        expect(jsonOf(await call(client, 'session_list'))).toEqual({ sessions: ['mem-session'] });

        // …with ZERO disk traces: no mirror file under the root (persistent
        // mode writes sessions/<name>.json — memory mode must not).
        await new Promise((r) => setTimeout(r, 200));
        expect(existsSync(join(root, 'sessions'))).toBe(false);

        // Restart with the session name: the MEMORY sink hands the state to
        // the engine INLINE (storageState protocol extension, real Chromium).
        expect(jsonOf(await call(client, 'browser_close'))).toEqual({ ok: true, open: false });
        expect(
          jsonOf(await call(client, 'browser_open', { url, session: 'mem-session' })).ok,
        ).toBe(true);
        const restored = jsonOf(
          await call(client, 'browser_eval', { expression: "localStorage.getItem('yatt-mem')" }),
        ).value;
        expect(restored).toBe('ephemeral-works');

        // Deleting clears the live view; still nothing on disk.
        expect(jsonOf(await call(client, 'session_delete', { name: 'mem-session' }))).toEqual({
          ok: true,
        });
        expect(jsonOf(await call(client, 'session_list'))).toEqual({ sessions: [] });
        expect(existsSync(join(root, 'sessions'))).toBe(false);
        expect(jsonOf(await call(client, 'browser_close'))).toEqual({ ok: true, open: false });
      } finally {
        await client.close();
        await handle.shutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    180000,
  );
});
