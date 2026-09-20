/**
 * Fake engine bridge for unit tests: speaks the newline-delimited JSON-RPC
 * protocol of the yatt engine without any browser.
 *
 * Methods:
 *   ping                → { ok: true, pid }
 *   echo                → echoes params as the result
 *   delay               → responds after params.ms with { echoed, receiptIndex, receiptMs }
 *   fail_with_data      → ok:false with a result payload (error .data passthrough)
 *   slow_never          → never responds (request-timeout test)
 *
 * Browser-surface methods (T9): `open` (records params), `close`, `status`,
 * `preview`, `eval` (supports `__json:<json>` payloads), `run_step` (applies
 * {{var}} interpolation, fails on selector '#fail'), `condition` (honors
 * timeoutMs as a simulated poll), `scroll_by`, `click_at`, `tab_open/list/
 * switch/close` (stateful tab list) and `session_save` (with the `persist:
 * false` inline-state extension). The last received parameters of open /
 * run_step / session_save are retrievable through the `__record` method.
 */
import { createInterface } from 'node:readline';

const t0 = Date.now();
let receipts = 0;

/** 1x1 transparent PNG (enough to assert image content plumbing). */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Valid-base64 stand-in for a failure evidence screenshot. */
const FAILURE_EVIDENCE = Buffer.from('failure-evidence').toString('base64');

const record = {
  lastOpen: null,
  lastRunStep: null,
  lastRunStepResolved: null,
  lastSessionSave: null,
};

const tabs = [{ url: 'about:blank', title: 'blank' }];
let activeTab = 0;

function tabPayload() {
  return tabs.map((t, index) => ({ index, active: index === activeTab, title: t.title, url: t.url }));
}

function previewPayload() {
  return {
    url: tabs[activeTab]?.url ?? 'about:blank',
    title: tabs[activeTab]?.title ?? '',
    scrollY: 0,
    maxScrollY: 0,
    width: 1280,
    height: 800,
    screenshot: TINY_PNG,
  };
}

/** Same {{name}} substitution contract as the real engine's `resolve`. */
function interpolate(value, vars) {
  let out = String(value);
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, ok, result) {
  send({ type: 'response', id, ok, result });
}

send({ type: 'event', name: 'sidecar_ready', data: { pid: process.pid } });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const id = req.id;
  const method = req.method;
  const params = req.params ?? {};
  if (method === 'ping') {
    respond(id, true, { ok: true, pid: process.pid });
    return;
  }
  if (method === 'echo') {
    respond(id, true, params);
    return;
  }
  if (method === 'delay') {
    const ms = Number(params.ms) || 0;
    const receiptIndex = ++receipts;
    const receiptMs = Date.now() - t0;
    setTimeout(() => {
      respond(id, true, { echoed: params.echo ?? null, receiptIndex, receiptMs });
    }, ms);
    return;
  }
  if (method === 'fail_with_data') {
    send({
      type: 'response',
      id,
      ok: false,
      error: 'engine failure',
      result: { screenshot: 'base64-evidence', step: params },
    });
    return;
  }
  if (method === 'slow_never') {
    return; // intentionally unanswered: exercises the request timeout
  }
  if (method === '__record') {
    respond(id, true, record);
    return;
  }

  // ---- Browser surface (T9) ----
  if (method === 'open') {
    record.lastOpen = params;
    respond(id, true, { open: true });
    return;
  }
  if (method === 'close') {
    respond(id, true, { open: false });
    return;
  }
  if (method === 'status') {
    respond(id, true, {
      open: true,
      browser: 'chromium',
      url: tabs[activeTab]?.url ?? 'about:blank',
      interaction: true,
    });
    return;
  }
  if (method === 'preview') {
    respond(id, true, previewPayload());
    return;
  }
  if (method === 'eval') {
    const expression = String(params.expression ?? '');
    if (expression.startsWith('__json:')) {
      try {
        respond(id, true, JSON.parse(expression.slice('__json:'.length)));
      } catch (err) {
        respond(id, false, { error: `bad __json payload: ${err.message}` });
      }
      return;
    }
    respond(id, true, { expression });
    return;
  }
  if (method === 'run_step') {
    record.lastRunStep = params;
    const rawVars = params.vars && typeof params.vars === 'object' ? params.vars : {};
    const vars = {};
    for (const [k, v] of Object.entries(rawVars)) vars[k] = String(v);
    const step = params.step && typeof params.step === 'object' ? { ...params.step } : {};
    for (const key of ['selector', 'value', 'attribute']) {
      if (typeof step[key] === 'string') step[key] = interpolate(step[key], vars);
    }
    record.lastRunStepResolved = step;
    if (step.selector === '#fail') {
      send({
        type: 'response',
        id,
        ok: false,
        error: 'boom',
        result: { ok: false, error: 'boom', ms: 3, screenshot: FAILURE_EVIDENCE },
      });
      return;
    }
    respond(id, true, { ok: true, ms: 5, screenshot: TINY_PNG });
    return;
  }
  if (method === 'condition') {
    const timeoutMs = Number(params.timeoutMs) || 0;
    const value = String(params.selector ?? '') === '#exists';
    const started = Date.now();
    const finish = () => respond(id, true, { value, elapsedMs: Date.now() - started });
    if (timeoutMs > 0) {
      // Simulated polling: the answer only settles after the poll window.
      setTimeout(finish, Math.min(timeoutMs, 250));
      return;
    }
    finish();
    return;
  }
  if (method === 'scroll_by') {
    respond(id, true, previewPayload());
    return;
  }
  if (method === 'click_at') {
    respond(id, true, { ...previewPayload(), selector: '[data-testid="target"]', tag: 'button' });
    return;
  }
  if (method === 'tab_open') {
    tabs.push({ url: String(params.url || 'about:blank'), title: `tab-${tabs.length}` });
    activeTab = tabs.length - 1;
    respond(id, true, { tabs: tabPayload() });
    return;
  }
  if (method === 'tab_list') {
    respond(id, true, { tabs: tabPayload() });
    return;
  }
  if (method === 'tab_switch') {
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0 || index >= tabs.length) {
      respond(id, false, { error: `tab index ${index} is invalid (${tabs.length} open)` });
      return;
    }
    activeTab = index;
    respond(id, true, { tabs: tabPayload() });
    return;
  }
  if (method === 'tab_close') {
    if (tabs.length <= 1) {
      respond(id, false, { error: 'cannot close the only tab' });
      return;
    }
    const index = params.index === undefined ? activeTab : Number(params.index);
    if (!Number.isInteger(index) || index < 0 || index >= tabs.length) {
      respond(id, false, { error: `tab index ${index} is invalid (${tabs.length} open)` });
      return;
    }
    tabs.splice(index, 1);
    activeTab = Math.min(activeTab, tabs.length - 1);
    respond(id, true, { tabs: tabPayload() });
    return;
  }
  if (method === 'session_save') {
    record.lastSessionSave = params;
    const state = JSON.stringify({ cookies: [], origins: [] });
    if (params.persist === false) {
      // yatt-ts extension (D7): return the state WITHOUT writing anything,
      // so the host-side session sink owns persistence.
      respond(id, true, { ok: true, name: String(params.name ?? ''), state });
      return;
    }
    respond(id, true, { ok: true, name: String(params.name ?? '') });
    return;
  }
  respond(id, false, { error: 'unknown method: ' + method });
});

// Orderly close: EOF on stdin → exit 0 (like the real bridge).
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
