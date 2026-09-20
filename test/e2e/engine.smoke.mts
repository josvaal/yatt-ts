/**
 * Engine smoke (T7) — REAL Chromium, runs ONLY with YATT_TS_E2E=1 so the
 * default `npx vitest run` stays fast:
 *
 *   npm run build && YATT_TS_E2E=1 npx vitest run test/e2e
 *
 * Reuses the base `sidecar/test/smoke.ts` "core" section patterns (spawn a
 * bridge, ping → open → steps → screenshot → controlled failure → close)
 * against a tiny local HTTP server (no external network). It imports the
 * COMPILED package (dist/) on purpose: the smoke proves the shipped artifact
 * and spawns the in-package compiled bridge exactly like a consumer would.
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Loads the COMPILED package (dist/) with the NATIVE loader: the smoke
 * proves the shipped artifact and spawns the in-package compiled bridge
 * exactly like a consumer would. `npm run build` is therefore required
 * before running the e2e (a clear error names it when dist is missing).
 */
async function loadDist() {
  try {
    const [sidecar, options, config] = await Promise.all([
      import(/* @vite-ignore */ new URL('../../dist/mcp/sidecar-client.js', import.meta.url).href),
      import(/* @vite-ignore */ new URL('../../dist/engine/options.js', import.meta.url).href),
      import(/* @vite-ignore */ new URL('../../dist/config/index.js', import.meta.url).href),
    ]);
    return {
      SidecarClient: sidecar.SidecarClient,
      resolveEngineEntry: sidecar.resolveEngineEntry,
      engineOptionsFromConfig: options.engineOptionsFromConfig,
      resolveConfig: config.resolveConfig,
    };
  } catch (error) {
    throw new Error(
      `the compiled package (dist/) is missing or broken — run "npm run build" before the engine e2e. Original error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const e2e = process.env.YATT_TS_E2E === '1' ? describe : describe.skip;

const PAGE = `<!doctype html>
<html><head><title>yatt-ts smoke</title></head>
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

e2e('engine smoke (real Chromium, headless)', () => {
  it('core: ping → open → type+click steps → screenshot → close', async () => {
    const { SidecarClient, resolveEngineEntry, engineOptionsFromConfig, resolveConfig } =
      await loadDist();
    const root = mkdtempSync(join(tmpdir(), 'yatt-ts-engine-e2e-'));
    const { server, url } = await startServer();
    const config = resolveConfig({ paths: { root } });

    const client = new SidecarClient({
      root,
      runtime: 'node',
      engineEntry: resolveEngineEntry('index.js'),
      readyTimeoutMs: 20000,
      requestTimeoutMs: 60000,
      closeGraceMs: 5000,
      engineOptions: engineOptionsFromConfig(config),
    });

    try {
      // ping (also proves the bridge spawned + spoke sidecar_ready).
      const ping = await client.req<{ ok: boolean; pid: number }>('ping');
      expect(ping.ok).toBe(true);

      // open headless (browser default comes from config: headless ON, D10).
      const open = await client.req<{ open: boolean }>('open', { url, headless: true });
      expect(open.open).toBe(true);

      // Toolbar OFF by default (D11/C17): no injected helper in the page.
      const injected = await client.req<unknown>('eval', {
        expression: 'Boolean(window.__yattInjected) || Boolean(document.querySelector(".yatt-tk"))',
      });
      expect(injected).toBe(false);

      // type + click with DOM effect.
      const typed = await client.req<{ ok: boolean }>('run_step', {
        step: { action: 'type', selector: '#name', value: 'Ada' },
      });
      expect(typed.ok).toBe(true);
      const clicked = await client.req<{ ok: boolean }>('run_step', {
        step: { action: 'click', selector: '#go' },
      });
      expect(clicked.ok).toBe(true);
      const out = await client.req<unknown>('eval', {
        expression: "document.getElementById('out').textContent",
      });
      expect(out).toBe('typed:Ada');

      // screenshot step returns PNG bytes (base64, magic header checked).
      const shot = await client.req<{ ok: boolean; screenshot?: string }>('run_step', {
        step: { action: 'screenshot' },
      });
      expect(shot.ok).toBe(true);
      const png = Buffer.from(shot.screenshot ?? '', 'base64');
      expect(png.length).toBeGreaterThan(1000);
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

      // Controlled failure: the step rejects the request and the error payload
      // carries the full result as `.data` (failure evidence screenshot).
      const bad = await client
        .req<{ screenshot?: string }>('run_step', {
          step: { action: 'click', selector: '#no-exists-xyz' },
        })
        .then(
          () => null,
          (err: Error & { data?: { screenshot?: string } }) => err,
        );
      expect(bad).toBeInstanceOf(Error);
      expect(String((bad as Error | null)?.message)).toContain('locator.click: Timeout');
      expect(typeof (bad as (Error & { data?: { screenshot?: string } }) | null)?.data?.screenshot).toBe('string');

      // close + status.
      await client.req('close', {});
      const status = await client.req<{ open: boolean }>('status');
      expect(status.open).toBe(false);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120000);

  it('toolbar injection ON injects the helper when explicitly enabled', async () => {
    const { SidecarClient, resolveEngineEntry, engineOptionsFromConfig, resolveConfig } =
      await loadDist();
    const root = mkdtempSync(join(tmpdir(), 'yatt-ts-engine-e2e-tb-'));
    const { server, url } = await startServer();
    const config = resolveConfig({ paths: { root }, browser: { toolbarInjection: true } });

    const client = new SidecarClient({
      root,
      runtime: 'node',
      engineEntry: resolveEngineEntry('index.js'),
      readyTimeoutMs: 20000,
      requestTimeoutMs: 60000,
      closeGraceMs: 5000,
      engineOptions: engineOptionsFromConfig(config),
    });
    try {
      await client.req('ping');
      await client.req('open', { url, headless: true });
      // Init scripts run on navigation; the helper sets window.__yattInjected.
      await new Promise((r) => setTimeout(r, 500));
      const injected = await client.req<unknown>('eval', {
        expression: 'Boolean(window.__yattInjected)',
      });
      expect(injected).toBe(true);
      await client.req('close', {});
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120000);
});
