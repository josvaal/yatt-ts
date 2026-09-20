/**
 * Browser tools (16): live-browser control through the engine sidecar.
 * Ported faithfully from the base `mcp/src/tools/browser.ts` — same names,
 * zod schemas, envelopes and helper semantics (`withImage` PNG image blocks,
 * `serialize` caps for eval results: depth 4 / 100 items / 8000 chars).
 *
 * T9 deviations from the base, all deliberate (D7 session toggle):
 * - `session_save` / `session_list` / `session_delete` go through the
 *   host-side session sink instead of the engine's own storage, so
 *   `sessions.persist: false` yields a fully in-memory lifecycle (usable
 *   live, zero disk writes, wiped on close — C09) while `sessions.persist:
 *   true` keeps DB + mirror parity (C10).
 * - `session_save` asks the engine for the raw state with the non-breaking
 *   `persist: false` protocol extension (no engine-side write), then hands
 *   it to the sink, which owns persistence in both modes.
 * - `browser_open` restores sessions saved in the MEMORY sink by passing the
 *   state inline via the optional `storageState` open-protocol parameter;
 *   sessions in the persistent sink keep using the session name (the engine
 *   reads its DB), exactly like the base tool.
 *
 * Policy metadata (D5): only `session_save` and `session_delete` are marked
 * mutating. The remaining tools drive the runtime browser (navigation,
 * screenshots, tabs) and persist nothing in the library, so read-only mode
 * keeps them available — read-only protects the data on disk, not the
 * throwaway browser state, and screenshots/preview must stay available in
 * read-only servers (D10: captures always available).
 */
import { z } from 'zod';

import type { YattStrings } from '../../i18n/index.js';
import { MemorySessionSink } from '../../store/index.js';
import { Store } from '../../store/index.js';
import type { Ctx } from '../ctx.js';
import type { ToolRegistrar } from '../policy-middleware.js';
import { text } from './tests.js';

/** Resultado MCP con una imagen PNG embebida (la IA puede "ver" la página). */
function withImage(meta: unknown, base64: string | undefined) {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  > = [{ type: 'text', text: JSON.stringify(meta, null, 2) }];
  const png =
    base64 && base64.length > 0
      ? base64
      : meta && typeof meta === 'object' && 'screenshot' in meta
        ? String((meta as Record<string, unknown>).screenshot)
        : undefined;
  if (png) content.push({ type: 'image', data: png, mimeType: 'image/png' });
  return { content };
}

const browserEnum = z.enum(['chromium', 'firefox', 'webkit']).optional();

/** Resolves the engine request function, failing with a clear (localized)
 *  error when the engine is disabled (`engine.enabled: false` → no sidecar). */
function requireEngine(
  ctx: Ctx,
  engineRequiredMessage: string,
): {
  req: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<T>;
} {
  if (!ctx.sidecar) {
    throw new Error(engineRequiredMessage);
  }
  return { req: ctx.sidecar.req.bind(ctx.sidecar) };
}

/**
 * Resolves the open-parameters for a saved-session restore (T9/D7): sessions
 * held by the MEMORY sink travel inline (`storageState`, protocol extension)
 * so they restore without any disk read; anything else keeps the base
 * behavior of passing the session name (the engine reads its own DB).
 */
async function resolveSessionParam(ctx: Ctx, name: string): Promise<Record<string, unknown>> {
  if (ctx.sessionSink instanceof MemorySessionSink) {
    const inline = await ctx.sessionSink.get(name);
    if (inline !== null) {
      try {
        return { storageState: JSON.parse(inline) };
      } catch {
        // Corrupted memory state: fall back to the name (engine-side lookup).
      }
    }
  }
  return { session: name };
}

export function registerBrowserTools(reg: ToolRegistrar, ctx: Ctx, strings: YattStrings): void {
  const args = strings.args;

  reg.register({
    name: 'browser_open',
    description: strings.tools.browserOpen,
    inputSchema: {
      url: z.string().optional().describe(args.openUrl),
      headless: z.boolean().optional().describe(args.headless),
      viewport: z
        .object({
          width: z.coerce.number().optional(),
          height: z.coerce.number().optional(),
        })
        .optional()
        .describe(args.viewport),
      browser: browserEnum.describe(args.browser),
      session: z.string().optional().describe(args.session),
      timezoneId: z.string().optional(),
      geolocation: z
        .object({ latitude: z.coerce.number(), longitude: z.coerce.number() })
        .optional(),
    },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const a = raw as {
        url?: string;
        headless?: boolean;
        viewport?: { width?: number; height?: number };
        browser?: 'chromium' | 'firefox' | 'webkit';
        session?: string;
        timezoneId?: string;
        geolocation?: { latitude: number; longitude: number };
      };
      const params: Record<string, unknown> = {
        url: a.url ?? 'about:blank',
        headless: a.headless !== false,
        variables: [],
      };
      if (a.viewport) params.viewport = a.viewport;
      if (a.browser) params.browser = a.browser;
      if (a.session) Object.assign(params, await resolveSessionParam(ctx, a.session));
      if (a.timezoneId) params.timezoneId = a.timezoneId;
      if (a.geolocation) params.geolocation = a.geolocation;
      const r = await req('open', params);
      return text({ ok: true, ...(r as object) });
    },
  });

  reg.register({
    name: 'browser_close',
    description: strings.tools.browserClose,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      return text({ ok: true, ...((await req('close')) as object) });
    },
  });

  reg.register({
    name: 'browser_status',
    description: strings.tools.browserStatus,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      return text(await req('status'));
    },
  });

  reg.register({
    name: 'browser_preview',
    description: strings.tools.browserPreview,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const p = (await req('preview')) as Record<string, unknown>;
      const { screenshot, ...meta } = p;
      return withImage(meta, String(screenshot ?? ''));
    },
  });

  reg.register({
    name: 'browser_eval',
    description: strings.tools.browserEval,
    inputSchema: {
      expression: z.string().describe(args.expression),
    },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const { expression } = raw as { expression: string };
      // Base timeout for eval (8 s): page JS must answer quickly.
      const value = await req('eval', { expression }, 8000);
      return text({ value: serialize(value) });
    },
  });

  reg.register({
    name: 'browser_run_step',
    description: strings.tools.browserRunStep,
    inputSchema: {
      step: z
        .record(z.string(), z.unknown())
        .describe('YATT step: {action, selector?, value?, attribute?, disabled?}'),
      timeoutMs: z.coerce.number().optional().describe(args.runStepTimeoutMs),
      vars: z
        .record(z.string(), z.string())
        .optional()
        .describe(args.vars),
    },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const a = raw as {
        step?: Record<string, unknown>;
        timeoutMs?: number;
        vars?: Record<string, string>;
      };
      const step = a.step;
      if (!step || typeof step.action !== 'string') {
        throw new Error(strings.messages.stepMustHaveAction);
      }
      const params = {
        step,
        ...(a.timeoutMs && a.timeoutMs > 0 ? { timeoutMs: a.timeoutMs } : {}),
        ...(a.vars ? { vars: a.vars } : {}),
      };
      try {
        // Step OK: the sidecar answers `result` = StepResult {ok, ms, screenshot?}.
        const r = (await req('run_step', params)) as {
          ok: boolean;
          ms?: number;
          screenshot?: string;
        };
        return withImage({ name: step.action, ok: r.ok === true, ms: r.ms }, String(r.screenshot ?? ''));
      } catch (err) {
        // Step failed: ok:false with error (+ evidence screenshot in data).
        const data = (err as Error & { data?: unknown }).data as
          | { ok?: boolean; error?: string; screenshot?: string }
          | undefined;
        return withImage(
          {
            name: step.action,
            ok: false,
            error: data?.error ?? (err instanceof Error ? err.message : String(err)),
          },
          String(data?.screenshot ?? ''),
        );
      }
    },
  });

  reg.register({
    name: 'browser_condition',
    description: strings.tools.browserCondition,
    inputSchema: {
      selector: z.string().optional().describe(args.conditionSelector),
      value: z.string().optional().describe(args.conditionValue),
      timeoutMs: z.coerce
        .number()
        .optional()
        .describe(args.conditionTimeoutMs),
      intervalMs: z.coerce.number().optional().describe(args.intervalMs),
    },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const a = raw as {
        selector?: string;
        value?: string;
        timeoutMs?: number;
        intervalMs?: number;
      };
      return text(
        await req('condition', {
          ...(a.selector !== undefined ? { selector: a.selector } : {}),
          ...(a.value !== undefined ? { value: a.value } : {}),
          ...(a.timeoutMs !== undefined && a.timeoutMs > 0 ? { timeoutMs: a.timeoutMs } : {}),
          ...(a.intervalMs !== undefined ? { intervalMs: a.intervalMs } : {}),
        }),
      );
    },
  });

  reg.register({
    name: 'browser_scroll',
    description: strings.tools.browserScroll,
    inputSchema: { dy: z.coerce.number().describe(args.scrollDy) },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const { dy } = raw as { dy: number };
      const p = (await req('scroll_by', { dy })) as Record<string, unknown>;
      const { screenshot, ...meta } = p;
      return withImage(meta, String(screenshot ?? ''));
    },
  });

  reg.register({
    name: 'browser_click_at',
    description: strings.tools.browserClickAt,
    inputSchema: {
      x: z.coerce.number().describe(args.clickX),
      y: z.coerce.number().describe(args.clickY),
    },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const { x, y } = raw as { x: number; y: number };
      const p = (await req('click_at', { x, y })) as Record<string, unknown>;
      const { screenshot, ...meta } = p;
      return withImage(meta, String(screenshot ?? ''));
    },
  });

  reg.register({
    name: 'tab_open',
    description: strings.tools.tabOpen,
    inputSchema: { url: z.string().optional().describe(args.tabUrl) },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const { url } = raw as { url?: string };
      return text((await req('tab_open', url ? { url } : {})) as object);
    },
  });

  reg.register({
    name: 'tab_list',
    description: strings.tools.tabList,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      return text((await req('tab_list')) as object);
    },
  });

  reg.register({
    name: 'tab_switch',
    description: strings.tools.tabSwitch,
    inputSchema: { index: z.coerce.number().describe(args.tabIndex) },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const { index } = raw as { index: number };
      return text((await req('tab_switch', { index })) as object);
    },
  });

  reg.register({
    name: 'tab_close',
    description: strings.tools.tabClose,
    inputSchema: { index: z.coerce.number().optional().describe(args.tabIndex) },
    mutating: false,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const { index } = raw as { index?: number };
      return text((await req('tab_close', index !== undefined ? { index } : {})) as object);
    },
  });

  // ---- Sessions (D7 toggle): the sink owns persistence, in both modes. ----

  reg.register({
    name: 'session_save',
    description: strings.tools.sessionSave,
    inputSchema: { name: z.string().describe(args.sessionName) },
    mutating: true,
    handler: async (raw) => {
      const { req } = requireEngine(ctx, strings.messages.engineRequired);
      const { name } = raw as { name: string };
      // Store naming rules up front: invalid names fail the same way they
      // would for tests/reports (the sink applies them too).
      const safe = Store.sanitizeName(name);
      // `persist: false` (protocol extension): the engine returns the raw
      // state and writes NOTHING; the sink below owns the (optional) write.
      const r = (await req('session_save', { name: safe, persist: false })) as {
        state?: string;
      };
      if (typeof r.state !== 'string' || r.state.length === 0) {
        throw new Error('the engine did not return the session storage state');
      }
      await ctx.sessionSink.save(safe, r.state);
      return text({ ok: true, name: safe });
    },
  });

  reg.register({
    name: 'session_list',
    description: strings.tools.sessionList,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      // Same envelope as the base tool; the source is the configured sink
      // (memory or DB-backed), never the engine's own storage.
      return text({ sessions: await ctx.sessionSink.list() });
    },
  });

  reg.register({
    name: 'session_delete',
    description: strings.tools.sessionDelete,
    inputSchema: { name: z.string().describe(args.sessionName) },
    mutating: true,
    handler: async (raw) => {
      const { name } = raw as { name: string };
      await ctx.sessionSink.delete(Store.sanitizeName(name));
      return text({ ok: true });
    },
  });
}

/** Serializes any value returned by eval into safe, bounded text. */
function serialize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[maximum depth]';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string')
    return (value as string).length > 8000 ? (value as string).slice(0, 8000) + '…' : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function') return '[function]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => serialize(v, depth + 1));
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[k] = serialize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}
