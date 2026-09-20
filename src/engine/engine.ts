/**
 * Shared execution engine: runs leaf steps and blocks (if/repeat/for_each/
 * run_flow) against a Playwright page.
 *
 * Ported from the base `sidecar/src/engine.ts`. The module-level
 * `ROOT = process.env.YATT_ROOT || process.cwd()` env-at-import resolution is
 * REPLACED by the injected state (`state.ts`, set through `initEngine`), and
 * the hardcoded step timeouts now come from the injected browser defaults
 * (D21). Both the JSON-RPC bridge (index.ts) and the headless CLI (cli.ts)
 * use this module so step behavior is identical live and in CI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { BrowserContext, Page } from 'playwright';
import { openYattDb, type YattDb } from './db.js';
import { appDbConfigured, appDbQuery, type AppDbResult } from './appdb.js';
import { baselinesDir, engineOptions, enginePaths } from './state.js';

export interface Step {
  id?: string;
  action: string;
  selector?: string;
  value?: string;
  attribute?: string;
  disabled?: boolean;
  label?: string;
  children?: Step[];
  elseChildren?: Step[];
  times?: number;
  list?: string;
  itemVar?: string;
  flow?: string;
  withVars?: Record<string, string>;
  baseline?: string;
  tolerance?: number;
  fullPage?: boolean;
  // db_* steps (verification against the app-under-test database).
  sql?: string;
  expect?: 'rows' | 'empty' | 'value';
  /** Seconds (db_wait; default 10). */
  timeout?: number;
  /** Seconds between attempts (db_wait; default 0.5, minimum 0.1). */
  interval?: number;
}

export function sanitizeName(name: string | undefined): string {
  return String(name ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---- Storage (SQLite as source of truth + legacy mirrors) ----
let yattDb: YattDb | null = null;

/** Lazy open of the system DB next to the data root (injected paths). */
export async function getDb(): Promise<YattDb | null> {
  if (yattDb) return yattDb;
  try {
    yattDb = await openYattDb(join(enginePaths().db));
  } catch (e) {
    yattDb = null;
    console.error('[yatt] could not open yatt.db:', e instanceof Error ? e.message : String(e));
  }
  return yattDb;
}

/** Closes the system DB (used by tests and shutdown paths). */
export function closeDb(): void {
  if (yattDb) {
    try {
      yattDb.close();
    } catch {
      /* already closed */
    }
    yattDb = null;
  }
}

/** Baseline image bytes: DB first (source of truth), then the file mirror. */
async function baselineBytes(name: string): Promise<Buffer | null> {
  const db = await getDb();
  if (db) {
    const row = db.get('SELECT png FROM baselines WHERE name = ?', [name]);
    if (row && row.png) return Buffer.from(row.png as Uint8Array);
  }
  const basePath = join(baselinesDir(), `${name}.png`);
  if (existsSync(basePath)) return readFileSync(basePath);
  return null;
}

export interface StepResult {
  ok: boolean;
  error?: string;
  ms?: number;
  screenshot?: string;
}

/** Active-tab context: open/switch tabs from inside step execution. */
export interface LeafContext {
  context: BrowserContext | null;
  getCurrent(): Page | null;
  setCurrent(p: Page): void;
  /** Notifies the host when the tab set changed. */
  afterTabs?(): void;
  /** Hook on new tabs (the bridge registers page bindings there). */
  onNewPage?(p: Page): void;
}

/** Interpolates {{name}} with the given variable scope. */
export function interp(value: string | undefined, vars: Record<string, string>): string | undefined {
  if (value === undefined) return undefined;
  return String(value).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m,
  );
}

/** Resolves the interpolable fields of a step (value, selector, attribute, sql). */
export function resolve(step: Step, vars: Record<string, string>): Step {
  return {
    ...step,
    value: interp(step.value, vars),
    selector: interp(step.selector, vars),
    attribute: interp(step.attribute, vars),
    sql: interp(step.sql, vars),
  };
}

/** `if` condition (RF-18): element exists, or value is non-empty. */
export async function evalConditionOn(p: Page, selector?: string, value?: string): Promise<boolean> {
  const sel = (selector ?? '').trim();
  if (sel) return (await p.locator(sel).count()) > 0;
  const v = (value ?? '').trim();
  return v !== '' && v !== 'false' && v !== '0';
}

// ---- db_* steps (verification against the app-under-test database) ----

/** First cell (row 1, column 1), stringified and trimmed, or null with no rows. */
function scalarOf(res: AppDbResult): string | null {
  const cell = res.rows[0]?.[0];
  return cell === undefined ? null : String(cell).trim();
}

/** Bounded snapshot of a result (first row) for error messages. */
function snapshotOf(res: AppDbResult, max = 120): string {
  const first = res.rows[0];
  if (!first) return 'no rows';
  const s = `[${first.map((c) => (c === null ? 'null' : String(c))).join(', ')}]`;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Shared requirement of the db_* steps: an app database must be configured. */
function requireAppDb(): void {
  if (!appDbConfigured()) {
    throw new Error('set YATT_APP_DB (or --app-db) to use db_* steps');
  }
}

/** Element interaction timeout from the injected browser defaults. */
function elementTimeout(): number {
  return engineOptions().elementTimeoutMs;
}

/** Executes a leaf action on the page and returns the result (with an
 *  evidence screenshot of the state after the step, ok or failed, when asked). */
export async function executeLeaf(
  p: Page,
  step: Step,
  opts: { screenshot?: boolean },
  ctx: LeafContext,
): Promise<StepResult> {
  const t0 = Date.now();
  const fail = async (err: unknown) => {
    let screenshot: string | null = null;
    if (opts.screenshot) {
      try {
        screenshot = (await p.screenshot({ type: 'png' })).toString('base64');
      } catch {
        screenshot = null;
      }
    }
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { ok: false, error: msg, ms: Date.now() - t0, ...(screenshot ? { screenshot } : {}) };
  };

  try {
    switch (step.action) {
      case 'click':
        await p.locator(step.selector!).click({ timeout: elementTimeout() });
        break;
      case 'dblclick':
        await p.locator(step.selector!).dblclick({ timeout: elementTimeout() });
        break;
      case 'hover':
        await p.locator(step.selector!).hover({ timeout: elementTimeout() });
        break;
      case 'type':
        await p.locator(step.selector!).fill(step.value ?? '', { timeout: elementTimeout() });
        break;
      case 'clear':
        await p.locator(step.selector!).clear({ timeout: elementTimeout() });
        break;
      case 'upload': {
        const path = step.value ?? '';
        if (!path) {
          throw new Error(
            "upload: missing the file path (use a 'file' variable with {{name}})",
          );
        }
        await p.locator(step.selector!).setInputFiles(path, { timeout: elementTimeout() });
        break;
      }
      case 'select_option':
        try {
          await p.locator(step.selector!).selectOption(step.value ?? '', { timeout: elementTimeout() });
        } catch {
          await p
            .locator(step.selector!)
            .selectOption({ label: step.value ?? '' }, { timeout: elementTimeout() });
        }
        break;
      case 'check':
        await p.locator(step.selector!).check({ timeout: elementTimeout() });
        break;
      case 'press_key':
        if (step.selector) {
          await p.locator(step.selector).press(step.value ?? 'Enter', { timeout: elementTimeout() });
        } else {
          await p.keyboard.press(step.value ?? 'Enter');
        }
        break;
      case 'wait_visible':
        await p.locator(step.selector!).waitFor({
          state: 'visible',
          timeout: engineOptions().waitVisibleTimeoutMs,
        });
        break;
      case 'scroll_to_element': {
        const inView = await p
          .locator(step.selector!)
          .evaluate((el: Element) => {
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            const r = el.getBoundingClientRect();
            const vh = window.innerHeight || document.documentElement.clientHeight;
            return r.top >= 0 && r.bottom <= vh && r.width > 0;
          })
          .catch(() => false);
        if (!inView) throw new Error(`scroll to element: could not bring into view (${step.selector})`);
        break;
      }
      case 'assert_visible': {
        const visible = await p.locator(step.selector!).isVisible().catch(() => false);
        if (!visible) throw new Error(`assert visible: element is not visible (${step.selector})`);
        break;
      }
      case 'assert_hidden': {
        const visible = await p.locator(step.selector!).isVisible().catch(() => false);
        if (visible) throw new Error(`assert hidden: element is visible (${step.selector})`);
        break;
      }
      case 'assert_text': {
        const text = (await p.locator(step.selector!).textContent({ timeout: elementTimeout() }).catch(() => '')) ?? '';
        if (!text.includes(step.value ?? '')) {
          throw new Error(
            `assert text: expected "${step.value}" but the text is "${text.trim().slice(0, 60)}"`,
          );
        }
        break;
      }
      case 'assert_value': {
        const val = await p.locator(step.selector!).inputValue({ timeout: elementTimeout() }).catch(() => '');
        if (val !== step.value) {
          throw new Error(`assert value: expected "${step.value}" but the value is "${val}"`);
        }
        break;
      }
      case 'assert_attribute': {
        const attr = await p
          .locator(step.selector!)
          .getAttribute(step.attribute ?? '', { timeout: elementTimeout() })
          .catch(() => null);
        if (attr !== step.value) {
          throw new Error(
            `assert attribute ${step.attribute ?? '?'}: expected "${step.value}" but it is "${attr ?? '(no attribute)'}"`,
          );
        }
        break;
      }
      case 'goto':
        await p.goto(step.value || 'about:blank', {
          waitUntil: 'domcontentloaded',
          timeout: engineOptions().gotoTimeoutMs,
        });
        break;
      case 'wait':
        await p.waitForTimeout(Math.max(0, Number(step.value) || 500));
        break;
      case 'screenshot':
        return {
          ok: true,
          ms: Date.now() - t0,
          screenshot: (await p.screenshot({ type: 'png' })).toString('base64'),
        };

      // ---- Multi-tab ----
      case 'open_tab': {
        if (!ctx.context) throw new Error('no browser open');
        const np = await ctx.context.newPage();
        ctx.setCurrent(np);
        ctx.onNewPage?.(np);
        if (step.value) await np.goto(step.value, { waitUntil: 'domcontentloaded', timeout: engineOptions().gotoTimeoutMs });
        else await np.goto('about:blank', { waitUntil: 'domcontentloaded' });
        ctx.afterTabs?.();
        break;
      }
      case 'switch_tab': {
        const ps = ctx.context?.pages().filter((x) => !x.isClosed()) ?? [];
        const idx = Number(step.value);
        if (!Number.isInteger(idx) || idx < 0 || idx >= ps.length) {
          throw new Error(`switch tab: index ${step.value} is invalid (${ps.length} open)`);
        }
        ctx.setCurrent(ps[idx]);
        ctx.afterTabs?.();
        break;
      }
      case 'close_tab': {
        const ps = ctx.context?.pages().filter((x) => !x.isClosed()) ?? [];
        if (ps.length <= 1) throw new Error('cannot close the only tab');
        const idx = step.value === undefined || step.value === '' ? ps.indexOf(p) : Number(step.value);
        const target = ps[idx];
        if (!target) throw new Error(`close tab: index ${idx} is invalid (${ps.length} open)`);
        if (p === target) {
          ctx.setCurrent(ps.filter((x) => x !== target).pop() ?? ps[0]);
        }
        await target.close().catch(() => {});
        ctx.afterTabs?.();
        break;
      }

      // ---- Visual asserts: baseline image + tolerance ----
      case 'capture_screenshot': {
        const name = sanitizeName(step.value || step.baseline);
        if (!name) throw new Error('capture baseline: missing the name');
        const buf = await p.screenshot({ type: 'png', fullPage: !!step.fullPage });
        const db = await getDb();
        if (db) {
          db.run('INSERT OR REPLACE INTO baselines (name, png, updated_at) VALUES (?, ?, ?)', [
            name,
            buf,
            Date.now(),
          ]);
        }
        // Mirror: needed by the exported Playwright spec and manual review.
        mkdirSync(baselinesDir(), { recursive: true });
        writeFileSync(join(baselinesDir(), `${name}.png`), buf);
        break;
      }
      case 'assert_screenshot': {
        const name = sanitizeName(step.baseline || step.value);
        if (!name) throw new Error('assert screenshot: missing the baseline image name');
        const baseBytes_ = await baselineBytes(name);
        if (!baseBytes_) {
          throw new Error(
            `assert screenshot: baselines/${name}.png is missing (run "capture baseline" first)`,
          );
        }
        const tol = Math.max(0, Number(step.tolerance) || 0) / 100;
        const base = PNG.sync.read(baseBytes_);
        const shot = PNG.sync.read(await p.screenshot({ type: 'png', fullPage: !!step.fullPage }));
        if (base.width !== shot.width || base.height !== shot.height) {
          throw new Error(
            `assert screenshot: the size changed (base ${base.width}x${base.height}, current ${shot.width}x${shot.height})`,
          );
        }
        const a = base.data;
        const b = shot.data;
        let diffPx = 0;
        const total = shot.width * shot.height;
        for (let i = 0; i < a.length; i += 4) {
          const dr = Math.abs(a[i] - b[i]);
          const dg = Math.abs(a[i + 1] - b[i + 1]);
          const dbl = Math.abs(a[i + 2] - b[i + 2]);
          if (dr > 32 || dg > 32 || dbl > 32) diffPx++;
        }
        const ratio = diffPx / total;
        if (ratio > tol) {
          throw new Error(
            `assert screenshot: ${(ratio * 100).toFixed(2)}% of pixels differ (tolerance ${(tol * 100).toFixed(2)}%)`,
          );
        }
        break;
      }

      // ---- Verification against the app database (read-only) ----
      case 'db_assert': {
        requireAppDb();
        const sql = (step.sql ?? '').trim();
        if (!sql) throw new Error('db_assert: missing the sql field');
        const res = await appDbQuery(sql);
        const expect = step.expect ?? 'rows';
        if (expect === 'rows') {
          if (res.totalRows < 1) {
            throw new Error(`db_assert: expected rows and the query returned 0 (${snapshotOf(res)})`);
          }
        } else if (expect === 'empty') {
          if (res.totalRows > 0) {
            throw new Error(`db_assert: expected 0 rows and there are ${res.totalRows} (${snapshotOf(res)})`);
          }
        } else if (expect === 'value') {
          if (step.value === undefined || step.value === '') {
            throw new Error('db_assert: expect "value" requires the value field to compare');
          }
          const got = scalarOf(res);
          if (got === null) {
            throw new Error(`db_assert: no rows to compare the value against (${snapshotOf(res)})`);
          }
          const want = step.value.trim();
          if (got !== want) {
            throw new Error(`db_assert: expected "${want}" but got "${got.slice(0, 80)}"`);
          }
        } else {
          throw new Error(`db_assert: invalid expect "${expect}" (rows|empty|value)`);
        }
        break;
      }
      case 'db_wait': {
        requireAppDb();
        const sql = (step.sql ?? '').trim();
        if (!sql) throw new Error('db_wait: missing the sql field');
        const timeoutMs = Math.max(0, (Number(step.timeout) || 10) * 1000);
        const intervalMs = Math.max(100, (Number(step.interval) || 0.5) * 1000);
        const wantValue = step.value !== undefined && step.value !== '';
        const started = Date.now();
        for (;;) {
          const res = await appDbQuery(sql);
          const matched = wantValue
            ? scalarOf(res) === step.value!.trim()
            : res.totalRows >= 1;
          if (matched) break;
          const elapsed = Date.now() - started;
          if (elapsed >= timeoutMs) {
            throw new Error(
              `db_wait: timeout after ${(elapsed / 1000).toFixed(1)}s without the query holding (${snapshotOf(res)})`,
            );
          }
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        break;
      }
      default:
        return await fail(new Error('unknown action: ' + step.action));
    }
    // Evidence: page state after a successful step (optional; a failed capture
    // never fails the step).
    if (opts.screenshot) {
      try {
        return {
          ok: true,
          ms: Date.now() - t0,
          screenshot: (await p.screenshot({ type: 'png' })).toString('base64'),
        };
      } catch {
        /* optional screenshot: must not fail the step */
      }
    }
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return await fail(err);
  }
}

// ---- Full test runner (used by the CLI) ----

export interface RunRecord {
  index: number;
  action: string;
  selector?: string;
  value?: string;
  attribute?: string;
  status: 'ok' | 'fail' | 'skipped' | 'stopped';
  ms?: number;
  error?: string;
  screenshot?: string;
  depth?: number;
  summary?: string;
}

export interface RunOutcome {
  records: RunRecord[];
  ok: number;
  fail: number;
  skipped: number;
  stopped: boolean;
}

export interface RunOptions {
  /** Resolves a sub-flow by name; null when missing. */
  flows?: (name: string) => Promise<{ steps?: Step[] } | null>;
  /** Per-step timeout in ms (default 40000). */
  stepTimeoutMs?: number;
  /** The runner stops cleanly when this returns true (Ctrl+C in CI). */
  shouldStop?: () => boolean;
}

/** Runs a list of steps (with blocks) against `holder.page` (the active tab
 *  can change with open_tab/switch_tab). Accumulates the report. */
export async function runTestSteps(
  holder: { page: Page },
  steps: Step[],
  vars: Record<string, string>,
  opts: RunOptions = {},
): Promise<RunOutcome> {
  const timeoutMs = opts.stepTimeoutMs && opts.stepTimeoutMs > 0 ? opts.stepTimeoutMs : 40000;

  const state: RunOutcome & { counter: number } = {
    records: [],
    ok: 0,
    fail: 0,
    skipped: 0,
    stopped: false,
    counter: 0,
  };

  const leafCtx: LeafContext = {
    context: holder.page.context(),
    getCurrent: () => holder.page,
    setCurrent: (p) => {
      holder.page = p;
    },
  };

  async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`internal timeout: ${label}`)), ms),
      ),
    ]);
  }

  async function runList(list: Step[], scope: Record<string, string>, depth: number, flowStack: string[]) {
    for (const step of list) {
      if (opts.shouldStop?.()) {
        state.stopped = true;
        return;
      }
      const resolved = resolve(step, scope);
      const base: RunRecord = {
        index: ++state.counter,
        action: step.action,
        selector: step.selector,
        value: step.value,
        attribute: step.attribute,
        depth,
        status: 'ok',
      };
      if (step.disabled) {
        state.records.push({ ...base, status: 'skipped' });
        state.skipped++;
        continue;
      }
      if (step.action === 'if') {
        let truthy: boolean;
        try {
          truthy = await evalConditionOn(holder.page, resolved.selector, resolved.value);
        } catch (err) {
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
          state.records.push({
            ...base,
            status: 'fail',
            error: `if: could not evaluate (${msg})`,
          });
          state.fail++;
          continue;
        }
        const branch = truthy ? step.children ?? [] : step.elseChildren ?? [];
        if (branch.length === 0) {
          state.records.push({
            ...base,
            summary: `${truthy ? 'true condition' : 'false condition'} · no steps in the branch`,
          });
          state.ok++;
          continue;
        }
        const beforeOk = state.ok;
        const beforeFail = state.fail;
        await runList(branch, scope, depth + 1, flowStack);
        state.records.push({
          ...base,
          summary: `${truthy ? 'then' : 'else'} · ${state.ok - beforeOk} ok${state.fail - beforeFail ? ` · ${state.fail - beforeFail} failed` : ''}`,
        });
        state.ok++;
        continue;
      }
      if (step.action === 'repeat') {
        const times = Math.max(0, Math.floor(Number(step.times) || 0));
        if (times === 0) {
          state.records.push({ ...base, summary: '0 repetitions' });
          state.ok++;
          continue;
        }
        let iterOk = 0;
        let iterFail = 0;
        for (let i = 1; i <= times; i++) {
          if (opts.shouldStop?.()) {
            state.stopped = true;
            break;
          }
          const bOk = state.ok;
          const bFail = state.fail;
          await runList(step.children ?? [], scope, depth + 1, flowStack);
          iterOk += state.ok - bOk;
          iterFail += state.fail - bFail;
        }
        state.records.push({
          ...base,
          summary: `×${times} · ${iterOk} ok${iterFail ? ` · ${iterFail} failed` : ''}`,
        });
        state.ok++;
        continue;
      }
      if (step.action === 'for_each') {
        const listVal = (interp(step.list, scope) ?? '').trim();
        const items = listVal.split(',').map((s) => s.trim()).filter(Boolean);
        if (items.length === 0) {
          state.records.push({ ...base, summary: 'empty list · 0 iterations' });
          state.ok++;
          continue;
        }
        if (!step.itemVar) {
          state.records.push({ ...base, status: 'fail', error: 'missing the item variable' });
          state.fail++;
          continue;
        }
        let iterOk = 0;
        let iterFail = 0;
        for (const item of items) {
          if (opts.shouldStop?.()) {
            state.stopped = true;
            break;
          }
          const bOk = state.ok;
          const bFail = state.fail;
          await runList(step.children ?? [], { ...scope, [step.itemVar]: item }, depth + 1, flowStack);
          iterOk += state.ok - bOk;
          iterFail += state.fail - bFail;
        }
        state.records.push({
          ...base,
          summary: `${items.length} item(s) · ${iterOk} ok${iterFail ? ` · ${iterFail} failed` : ''}`,
        });
        state.ok++;
        continue;
      }
      if (step.action === 'run_flow') {
        const flowName = (interp(step.flow, scope) ?? '').trim();
        if (!flowName) {
          state.records.push({ ...base, status: 'fail', error: 'missing the sub-flow name' });
          state.fail++;
          continue;
        }
        if (flowStack.includes(flowName)) {
          state.records.push({ ...base, status: 'fail', error: `circular flow: ${flowName}` });
          state.fail++;
          continue;
        }
        if (!opts.flows) {
          state.records.push({
            ...base,
            status: 'fail',
            error: `no sub-flow resolver for "${flowName}"`,
          });
          state.fail++;
          continue;
        }
        let fdoc: { steps?: Step[] } | null;
        try {
          fdoc = await opts.flows(flowName);
        } catch (err) {
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
          state.records.push({
            ...base,
            status: 'fail',
            error: `could not read the sub-flow "${flowName}": ${msg}`,
          });
          state.fail++;
          continue;
        }
        if (!fdoc) {
          state.records.push({ ...base, status: 'fail', error: `could not read the sub-flow "${flowName}"` });
          state.fail++;
          continue;
        }
        // Flow variables: enriched with this step's withVars mapping.
        const fvars: Record<string, string> = { ...scope };
        for (const [k, src] of Object.entries(step.withVars ?? {})) {
          fvars[k] = /^\{\{[\w.-]+\}\}$/.test(src)
            ? interp(src, scope) ?? ''
            : Object.prototype.hasOwnProperty.call(scope, src)
              ? scope[src]
              : src;
        }
        const bOk = state.ok;
        const bFail = state.fail;
        await runList(fdoc.steps ?? [], fvars, depth + 1, [...flowStack, flowName]);
        state.records.push({
          ...base,
          summary: `sub-flow "${flowName}" · ${state.ok - bOk} ok${state.fail - bFail ? ` · ${state.fail - bFail} failed` : ''}`,
        });
        state.ok++;
        continue;
      }

      // Leaf: run against the active tab, with an evidence screenshot both on
      // success and on failure.
      const r = await withTimeout(
        executeLeaf(holder.page, resolved, { screenshot: true }, leafCtx),
        timeoutMs,
        'step execution',
      );
      if (r.ok) {
        state.ok++;
        state.records.push({ ...base, status: 'ok', ms: r.ms, screenshot: r.screenshot });
      } else {
        state.fail++;
        state.records.push({ ...base, status: 'fail', ms: r.ms, error: r.error, screenshot: r.screenshot });
      }
    }
  }

  await runList(steps, vars, 0, []);
  return state;
}
