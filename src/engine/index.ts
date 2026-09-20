/**
 * yatt-ts engine bridge — drives Chromium through Playwright.
 *
 * Protocol: lightweight newline-delimited JSON-RPC over stdin/stdout with the
 * host process (the MCP server's SidecarClient):
 *
 *   request  → {"id": 1, "method": "open", "params": {...}}   (stdin)
 *   response → {"type":"response","id":1,"ok":true,"result":{...}}  (stdout)
 *   response → {"type":"response","id":1,"ok":false,"error":"..."}  (stdout)
 *   event    → {"type":"event","name":"action_captured","data":{...}} (stdout, push)
 *
 * Ported from the base `sidecar/src/index.ts`. Configuration is INJECTED at
 * startup (`initEngine` / `initAppDb`, resolved from the environment set by
 * SidecarClient) instead of being read at import time. The floating toolbar
 * (HELPER_JS) is only injected when the configured `toolbarInjection` is
 * enabled (D11: OFF by default).
 */

import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright';
import { HELPER_JS, selectorAtPoint } from './interaction.js';
import { ensureBrowser } from './browser-install.js';
import { appDbQuery, appDbSourceFromEnv, closeAppDb, initAppDb } from './appdb.js';
import {
  closeDb,
  executeLeaf,
  evalConditionOn,
  getDb,
  resolve,
  sanitizeName,
  type Step,
} from './engine.js';
import {
  engineOptions,
  initEngine,
  initEngineFromEnv,
  isEngineInitialized,
  sessionsDir,
} from './state.js';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let interactionOn = false;
/** Engine (chromium default, firefox or webkit). */
let engineName = 'chromium';

// Editor variable names: injected into the floating toolbar so {{name}} can be
// inserted while recording a value, and updated live via `toolbar_vars`
// without reopening the browser.
let toolbarVars: string[] = [];

// ---- Multi-tab: `page` is the active tab; the context may hold several
// (tabs opened by YATT or pop-ups from the app under test). ----

function allPages(): Page[] {
  return context ? context.pages().filter((p) => !p.isClosed()) : [];
}

function currentPage(): Page | null {
  if (page && !page.isClosed()) return page;
  const ps = allPages();
  return ps.length > 0 ? ps[ps.length - 1] : null;
}

async function tabsPayload() {
  return Promise.all(
    allPages().map(async (p, idx) => ({
      index: idx,
      active: p === page,
      title: await p.title().catch(() => ''),
      url: p.url(),
    })),
  );
}

/** Publishes the tab state (new, closed, switched) to the host. */
function refreshTabs() {
  tabsPayload()
    .then((tabs) => emit('tabs_changed', { tabs }))
    .catch(() => {
      /* context closed mid-flight */
    });
}

// Window → viewport sync (visible mode only): when the user resizes the
// Chromium window, the page layout must follow.
let resizeTimer: ReturnType<typeof setInterval> | null = null;
let cdp: CDPSession | null = null;
let prevOuterW = 0;
let prevOuterH = 0;
let appliedOuterW = 0;
let appliedOuterH = 0;
let chromeW = 0;
let chromeH = 0;

function send(obj: unknown) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    /* the host closed the pipe (the app is exiting); ignore */
  }
}

// If the host dies before closing the pipe orderly, do not crash the bridge.
process.stdout.on('error', () => {});

function respond(id: number, ok: boolean, extra: Record<string, unknown> = {}) {
  send({ type: 'response', id, ok, ...extra });
}

function emit(name: string, data: Record<string, unknown>) {
  send({ type: 'event', name, data });
}

function stepLabel(step: Step): string {
  const target = step.selector ? ` · ${step.selector}` : '';
  return `${step.action}${step.value !== undefined ? ` "${step.value}"` : ''}${target}`;
}

/** Executes a leaf step on the active tab. The behavior lives in the shared
 *  engine (engine.ts): the same code runs in the CLI. */
async function executeStep(step: Step, p: Page, withScreenshot: boolean) {
  return executeLeaf(p, step, { screenshot: withScreenshot }, {
    context,
    getCurrent: currentPage,
    setCurrent: (np) => {
      page = np;
    },
    afterTabs: refreshTabs,
    onNewPage: (np) => {
      void exposePageBindings(np);
    },
  });
}

/**
 * Registers the context init scripts. The HELPER_JS (floating toolbar) is
 * ONLY registered when toolbar injection is enabled (D11); the variables
 * propagation script follows the same switch because it only serves the
 * toolbar. Playwright runs init scripts at the start of every navigation of
 * every page (tabs and pop-ups), avoiding addScriptTag races.
 */
function registerToolbarInit() {
  if (!context) return;
  if (!engineOptions().toolbarInjection) return;
  context
    .addInitScript((vars: string[]) => {
      (window as any).__yattVars = vars;
    }, toolbarVars)
    .catch(() => {
      /* best-effort registration; must not fail */
    });
  context.addInitScript({ content: HELPER_JS }).catch(() => {
    /* best-effort registration; must not fail */
  });
}

/** Per-page bindings: the channel from the page under test to the bridge.
 *  Registered per page (not context-wide) to know WHICH tab recorded an
 *  action when there are several. Must complete before evaluating page code
 *  (otherwise the first __yattRecord may not be registered yet). */
function exposePageBindings(p: Page) {
  if ((p as any).__yattBoundPromise) return (p as any).__yattBoundPromise as Promise<void>;
  const prom = (async () => {
    await Promise.all([
      p.exposeFunction('__yattRecord', async (step: unknown) => {
        const s = step as Step;
        const r = await executeStep(s, p, true);
        emit('action_captured', {
          step: { ...s, label: s.label ?? stepLabel(s) },
          result: { ok: r.ok, error: r.error, ms: r.ms },
        });
        return { ok: r.ok, error: r.error };
      }),
      // Selector captured in re-record mode (start_grab); published as an event.
      p.exposeFunction('__yattGrabResult', (sel: unknown) => {
        emit('grab_result', { selector: String(sel ?? '') });
      }),
    ]).catch(() => {
      /* best-effort: if it fails the tab cannot record but the bridge survives */
    });
  })();
  (p as any).__yattBoundPromise = prom;
  return prom;
}

/** Tab close hook: publishes the updated tab list. */
function hookPageLifecycle(p: Page) {
  if ((p as any).__yattHooked) return;
  (p as any).__yattHooked = true;
  p.on('close', () => refreshTabs());
}

/**
 * One sync pass: reads the real OS window size over CDP, discounts the chrome
 * frame (auto-calibrated) and applies the viewport with page.setViewportSize
 * (native Playwright, so screenshot/preview stay consistent). Only applies
 * when the window has been stable for one tick, so it does not fight the
 * user's drag.
 */
async function syncVisibleWindow(p: Page) {
  if (!cdp) return;
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', {});
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    if (!bounds || bounds.windowState === 'minimized') return;
    const width = Number(bounds.width ?? 0);
    const height = Number(bounds.height ?? 0);
    if (!width || !height) return;
    // The window must be stable for at least one tick.
    if (width !== prevOuterW || height !== prevOuterH) {
      prevOuterW = width;
      prevOuterH = height;
      return;
    }
    if (width === appliedOuterW && height === appliedOuterH) return;
    if (chromeW === 0) {
      const vp = p.viewportSize();
      chromeW = Math.max(0, width - (vp?.width ?? width));
      chromeH = Math.max(0, height - (vp?.height ?? height));
    }
    const w = Math.max(320, width - chromeW);
    const h = Math.max(200, height - chromeH);
    await p.setViewportSize({ width: w, height: h });
    appliedOuterW = width;
    appliedOuterH = height;
  } catch {
    /* window not available yet; retried on the next tick */
  }
}

function startResizeSync(p: Page) {
  stopResizeSync();
  p.context()
    .newCDPSession(p)
    .then((s) => {
      cdp = s;
    })
    .catch(() => {
      cdp = null;
    });
  resizeTimer = setInterval(() => syncVisibleWindow(p), engineOptions().cdpSync.pollIntervalMs);
}

function stopResizeSync() {
  if (resizeTimer) {
    clearInterval(resizeTimer);
    resizeTimer = null;
  }
  cdp = null;
  prevOuterW = 0;
  prevOuterH = 0;
  appliedOuterW = 0;
  appliedOuterH = 0;
}

const ENGINE_LAUNCHERS: Record<string, { launch: typeof chromium.launch; label: string }> = {
  chromium: { launch: chromium.launch.bind(chromium), label: 'chromium' },
  firefox: { launch: firefox.launch.bind(firefox), label: 'firefox' },
  webkit: { launch: webkit.launch.bind(webkit), label: 'webkit' },
};

async function openBrowser(params: {
  url?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  variables?: string[];
  session?: string;
  browser?: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number } | null;
}) {
  const options = engineOptions();
  await closeBrowser();
  toolbarVars = Array.isArray(params.variables) ? params.variables.map(String) : [];
  engineName =
    params.browser && params.browser in ENGINE_LAUNCHERS ? params.browser : options.defaultEngine;
  // Auto-install (D12): when the browser is not downloaded on this machine,
  // download it before the launch (chromium only, the default engine). The
  // behavior can be turned off via config (autoInstallBrowser: false).
  if (options.autoInstallBrowser) {
    await ensureBrowser(engineName, emit);
  }
  // Headless default ON (D10): the per-call param wins, then the configured
  // default (which itself defaults to true).
  const headless = params.headless ?? options.defaultHeadless;
  browser = await ENGINE_LAUNCHERS[engineName].launch({ headless });
  // Session: source of truth is the DB (yatt.db); fallback to the legacy
  // sessions/<name>.json file pre-migration or when the DB is unavailable.
  const sname = params.session ? sanitizeName(String(params.session)) : '';
  let storageState: NonNullable<
    import('playwright').BrowserContextOptions['storageState']
  > | undefined;
  if (sname) {
    const db = await getDb();
    if (db) {
      const row = db.get('SELECT storage_state FROM sessions WHERE name = ?', [sname]);
      if (row && row.storage_state) {
        try {
          storageState = JSON.parse(String(row.storage_state));
        } catch {
          storageState = undefined;
        }
      }
    }
    if (storageState === undefined) {
      const statePath = join(sessionsDir(), `${sname}.json`);
      if (existsSync(statePath)) storageState = statePath; // Playwright accepts path or state
    }
  }
  context = await browser.newContext({
    viewport: params.viewport ?? { ...options.defaultViewport },
    ...(storageState ? { storageState } : {}),
    // Simulated environment: timezone and geolocation.
    ...(params.timezoneId ? { timezoneId: params.timezoneId } : {}),
    ...(params.geolocation && typeof params.geolocation.latitude === 'number'
      ? { geolocation: params.geolocation, permissions: ['geolocation'] as string[] }
      : {}),
  });

  // Toolbar init scripts (context-wide) — only when injection is enabled (D11).
  registerToolbarInit();

  // Every new page (tab or pop-up) receives bindings and announces its close.
  context.on('page', (p) => {
    void exposePageBindings(p).then(() => {
      hookPageLifecycle(p);
      refreshTabs();
    });
  });

  page = await context.newPage();
  await exposePageBindings(page);

  interactionOn = true;
  if (params.url) {
    await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: options.gotoTimeoutMs });
  } else {
    // No URL: force a minimal navigation so the init scripts run.
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
  }
  // Visible-window sync uses CDP (chromium only, and when enabled).
  if (
    !headless &&
    engineName === 'chromium' &&
    options.cdpSync.enabled
  ) {
    startResizeSync(page);
  }
  refreshTabs();
  emit('browser_status', { open: true, headless, browser: engineName, url: params.url ?? '' });
}

async function closeBrowser() {
  stopResizeSync();
  if (browser) {
    await withTimeout(browser.close(), engineOptions().closeTimeoutMs, 'browser close').catch(() => {
      emit('log', {
        level: 'warn',
        message: `browser.close() took longer than ${engineOptions().closeTimeoutMs} ms; forcing the closed state`,
      });
    });
  }
  browser = null;
  context = null;
  page = null;
  interactionOn = false;
  emit('browser_status', { open: false });
}

/** Preview payload: viewport screenshot + scroll state and url. */
async function previewPayload(p: Page) {
  const options = engineOptions();
  const info = await withTimeout(
    p.evaluate(() => ({
      url: location.href,
      title: document.title,
      scrollY: window.scrollY,
      maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      width: window.innerWidth,
      height: window.innerHeight,
    })),
    options.previewTimeoutMs,
    'preview evaluate',
  ).catch(() => ({
    url: '',
    title: '',
    scrollY: 0,
    maxScrollY: 0,
    width: 1280,
    height: 800,
  }));
  const shot = await withTimeout(p.screenshot({ type: 'png' }), options.screenshotTimeoutMs, 'preview screenshot').catch(
    () => null,
  );
  return { ...info, screenshot: shot ? shot.toString('base64') : null };
}

/** Watchdog: guarantees an operation never leaves the protocol unanswered. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`internal timeout: ${label}`)), ms),
    ),
  ]);
}

/**
 * Flattens a failed launch error into readable plain text. Playwright returns
 * ASCII box banners ("launch: ╔════…║ Host system is missing
 * dependencies…╚════"); strip the box art and the "launch:" prefix so the
 * error shows the real cause in one line.
 */
function humanErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw
    .split('\n')
    .map((l) => l.trim().replace(/^║\s*/, '').replace(/\s*║$/, ''))
    .filter((l) => l && !/^[╔╗╚╝═\s]+$/.test(l));
  return lines.join(' ').replace(/^(browserType\.)?launch:\s*/i, '') || 'unknown error';
}

async function handleRequest(id: number, method: string, params: Record<string, unknown>) {
  try {
    switch (method) {
      case 'ping':
        respond(id, true, { result: { ok: true, pid: process.pid } });
        break;
      case 'open':
        await openBrowser(
          params as {
            url?: string;
            headless?: boolean;
            viewport?: { width: number; height: number };
            variables?: string[];
            session?: string;
            browser?: string;
            timezoneId?: string;
            geolocation?: { latitude: number; longitude: number } | null;
          },
        );
        respond(id, true, { result: { open: true } });
        break;
      case 'close':
        await closeBrowser();
        respond(id, true, { result: { open: false } });
        break;
      case 'run_step': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: "the browser is not open (run 'open' first)" });
          return;
        }
        // Optional variables ({{name}} → value) for loose live steps.
        const rawVars = params.vars as Record<string, unknown> | undefined;
        const vars: Record<string, string> = {};
        if (rawVars && typeof rawVars === 'object') {
          for (const [k, v] of Object.entries(rawVars)) vars[k] = String(v);
        }
        const step = (Object.keys(vars).length ? resolve(params.step as Step, vars) : params.step) as Step;
        const timeoutMs =
          Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : engineOptions().runStepTimeoutMs;
        const r = await withTimeout(executeStep(step, p, true), timeoutMs, 'step execution');
        respond(id, r.ok, r.ok ? { result: r } : { error: r.error, result: r });
        break;
      }
      case 'eval': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: "the browser is not open (run 'open' first)" });
          return;
        }
        const r = await withTimeout(p.evaluate(String(params.expression ?? '')), 8000, 'eval evaluate');
        respond(id, true, { result: r });
        break;
      }
      case 'preview': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: "the browser is not open (run 'open' first)" });
          return;
        }
        respond(id, true, { result: await previewPayload(p) });
        break;
      }
      case 'scroll_by': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        await p.mouse.wheel(Number(params.dx ?? 0), Number(params.dy ?? 0));
        await new Promise((r) => setTimeout(r, 80));
        respond(id, true, { result: await previewPayload(p) });
        break;
      }
      case 'scroll_to': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        await p.evaluate(
          ([px, py]) => {
            const sx = Math.max(0, Math.min(px, document.documentElement.scrollWidth - window.innerWidth));
            const sy = Math.max(0, Math.min(py, document.documentElement.scrollHeight - window.innerHeight));
            window.scrollTo(sx, sy);
          },
          [Number(params.x ?? 0), Number(params.y ?? 0)],
        );
        await new Promise((r) => setTimeout(r, 80));
        respond(id, true, { result: await previewPayload(p) });
        break;
      }
      case 'click_at': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        // Resolve the element under the cursor BEFORE the click: robust
        // selector (data-testid → id → CSS path) to suggest a reproducible step.
        const hit = await p
          .evaluate(selectorAtPoint, [
            Number(params.x ?? 0),
            Number(params.y ?? 0),
          ] as [number, number])
          .catch(() => ({ selector: null, tag: null }));
        await p.mouse.click(Number(params.x ?? 0), Number(params.y ?? 0));
        await new Promise((r) => setTimeout(r, 120));
        const payload = await previewPayload(p);
        respond(id, true, { result: { ...payload, selector: hit.selector, tag: hit.tag } });
        break;
      }
      case 'start_grab': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        // The __yattGrabResult binding is registered once per page (Playwright
        // re-applies it after every navigation).
        await withTimeout(
          p.evaluate(() => {
            (globalThis as any).__yattGrab = true;
            if ((globalThis as any).__yattSetStatus) {
              (globalThis as any).__yattSetStatus('re-recording: click the element (Esc cancels)', 'warn');
            }
          }),
          5000,
          'start_grab evaluate',
        );
        respond(id, true, { result: { active: true } });
        break;
      }
      case 'toolbar_vars': {
        toolbarVars = Array.isArray(params.variables) ? params.variables.map(String) : [];
        // For upcoming navigations: re-register the variables init script.
        if (context && engineOptions().toolbarInjection) {
          context
            .addInitScript((vars: string[]) => {
              (window as any).__yattVars = vars;
            }, toolbarVars)
            .catch(() => {
              /* best-effort */
            });
        }
        if (currentPage()) {
          const p = currentPage()!;
          await withTimeout(
            p.evaluate((list: string[]) => {
              if ((globalThis as any).__yattSetVars) {
                (globalThis as any).__yattSetVars(list);
              } else {
                (globalThis as any).__yattVars = list;
              }
            }, toolbarVars),
            5000,
            'toolbar_vars evaluate',
          ).catch(() => {
            /* the browser closed mid-flight */
          });
        }
        respond(id, true, { result: { ok: true } });
        break;
      }
      case 'window_sync_now': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        await syncVisibleWindow(p);
        respond(id, true, { result: await previewPayload(p) });
        break;
      }
      case 'window_resize': {
        const p = currentPage();
        if (!p || !cdp) {
          respond(id, false, { error: 'the visible browser is not available' });
          return;
        }
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget', {});
          await cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
              width: Number(params.width),
              height: Number(params.height),
              windowState: 'normal',
            },
          });
          await new Promise((r) => setTimeout(r, 400));
          await syncVisibleWindow(p); // registers the new size
          await new Promise((r) => setTimeout(r, 450));
          await syncVisibleWindow(p); // applies the viewport once settled
          respond(id, true, { result: await previewPayload(p) });
        } catch (e) {
          respond(id, false, { error: String(e) });
        }
        break;
      }
      case 'status':
        respond(id, true, {
          result: {
            open: !!browser,
            browser: engineName,
            url: currentPage()?.url() ?? null,
            interaction: interactionOn,
          },
        });
        break;

      // ---- Multi-tab ----
      case 'tab_open': {
        const c = context;
        if (!c) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        const np = await c.newPage();
        await exposePageBindings(np);
        page = np;
        const url = String(params.url ?? '');
        await np.goto(url || 'about:blank', {
          waitUntil: 'domcontentloaded',
          timeout: engineOptions().gotoTimeoutMs,
        });
        refreshTabs();
        respond(id, true, { result: { tabs: await tabsPayload() } });
        break;
      }
      case 'tab_list': {
        if (!context) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        respond(id, true, { result: { tabs: await tabsPayload() } });
        break;
      }
      case 'tab_switch': {
        const ps = allPages();
        const idx = Number(params.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= ps.length) {
          respond(id, false, { error: `tab index ${idx} is invalid (${ps.length} open)` });
          return;
        }
        page = ps[idx];
        refreshTabs();
        respond(id, true, { result: { tabs: await tabsPayload() } });
        break;
      }
      case 'tab_close': {
        const ps = allPages();
        if (ps.length <= 1) {
          respond(id, false, { error: 'cannot close the only tab' });
          return;
        }
        const idx = params.index === undefined ? ps.indexOf(page!) : Number(params.index);
        const target = ps[idx];
        if (!target) {
          respond(id, false, { error: `tab index ${idx} is invalid (${ps.length} open)` });
          return;
        }
        if (page === target) {
          page = ps.filter((x) => x !== target).pop() ?? null;
        }
        await withTimeout(target.close(), 5000, 'tab close').catch(() => {});
        refreshTabs();
        respond(id, true, { result: { tabs: await tabsPayload() } });
        break;
      }

      // ---- `if` condition: element exists, or value non-empty.
      // With timeoutMs > 0 it polls until true or the timeout expires. ----
      case 'condition': {
        const p = currentPage();
        if (!p) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        const timeoutMs = Math.max(0, Number(params.timeoutMs) || 0);
        const intervalMs = Math.max(10, Number(params.intervalMs) || 300);
        const t0 = Date.now();
        const evaluate = () =>
          evalConditionOn(p, String(params.selector ?? ''), String(params.value ?? ''));
        let value = await evaluate();
        if (timeoutMs > 0) {
          while (!value && Date.now() - t0 < timeoutMs) {
            await new Promise((r) => setTimeout(r, intervalMs));
            value = await evaluate();
          }
        }
        respond(id, true, { result: { value, elapsedMs: Date.now() - t0 } });
        break;
      }

      // ---- Read-only query against the app-under-test database ----
      case 'db_query': {
        const result = await appDbQuery(String(params.sql ?? ''), params.db);
        respond(id, true, { result });
        break;
      }

      // ---- Session state: cookies + localStorage ----
      case 'session_save': {
        const c = context;
        if (!c) {
          respond(id, false, { error: 'the browser is not open' });
          return;
        }
        const name = sanitizeName(String(params.name ?? ''));
        if (!name) {
          respond(id, false, { error: 'missing the session name' });
          return;
        }
        const db = await getDb();
        const state = await c.storageState();
        if (db) {
          db.run(
            'INSERT OR REPLACE INTO sessions (name, storage_state, updated_at) VALUES (?, ?, ?)',
            [name, JSON.stringify(state), Date.now()],
          );
        } else {
          // Legacy (no DB): file under sessions/.
          mkdirSync(sessionsDir(), { recursive: true });
          writeFileSync(join(sessionsDir(), `${name}.json`), JSON.stringify(state, null, 2));
        }
        respond(id, true, { result: { ok: true, name } });
        break;
      }
      case 'session_list': {
        let names: string[] = [];
        const db = await getDb();
        if (db) {
          names = (db.all('SELECT name FROM sessions ORDER BY name') as { name: unknown }[]).map(
            (r) => String(r.name),
          );
        } else if (existsSync(sessionsDir())) {
          names = readdirSync(sessionsDir())
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''))
            .sort();
        }
        respond(id, true, { result: names });
        break;
      }
      case 'session_delete': {
        const name = sanitizeName(String(params.name ?? ''));
        const db = await getDb();
        if (db) {
          db.run('DELETE FROM sessions WHERE name = ?', [name]);
        } else {
          const path = join(sessionsDir(), `${name}.json`);
          if (existsSync(path)) unlinkSync(path);
        }
        respond(id, true, { result: { ok: true } });
        break;
      }
      default:
        respond(id, false, { error: 'unknown method: ' + method });
    }
  } catch (err) {
    respond(id, false, { error: humanErrorMessage(err) });
  }
}

/**
 * Starts the JSON-RPC loop. Injects the engine state first: when the host
 * already called {@link initEngine} (in-process embedding/tests), the
 * injected state wins; otherwise the bridge process resolves it from the
 * environment set by SidecarClient (YATT_ROOT / YATT_ENGINE_JSON /
 * YATT_APP_DB_JSON).
 */
async function start() {
  if (!isEngineInitialized()) {
    initEngineFromEnv();
  }
  initAppDb(appDbSourceFromEnv());
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  emit('sidecar_ready', { pid: process.pid });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req: { id?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    const id = typeof req.id === 'number' ? req.id : -1;
    const method = typeof req.method === 'string' ? req.method : '';
    const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
    await handleRequest(id, method, params);
  });
  rl.on('close', () => {
    closeBrowser()
      .finally(() => {
        closeAppDb();
        closeDb();
        process.exit(0);
      });
  });
}

function shutdown() {
  closeBrowser().finally(() => {
    closeAppDb();
    closeDb();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Entry-point detection that works on BOTH runtimes: `import.meta.main` is a
 * Bun extension (Node leaves it undefined), so compare the module URL with
 * the executed script for Node while keeping the Bun fast-path.
 */
function isMainModule(): boolean {
  if ((import.meta as { main?: boolean }).main === true) return true;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  start();
}

// Re-exported so embedders can boot the engine in-process after initEngine().
export { initEngine, start };
