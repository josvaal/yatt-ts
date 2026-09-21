/**
 * Runner tools (2): test_run + test_run_dataset. Ported from the base
 * `mcp/src/tools/run.ts` — same names, same zod input schemas and envelopes;
 * defaults now come from the runner config domain (stepTimeoutMs,
 * defaultBrowser, saveReport) and the spawn runtime from engine config
 * (C15). Both tools are mutating (read-only mode rejects them, C08).
 */
import { z } from 'zod';

import type { YattStrings } from '../../i18n/index.js';
import type { Ctx } from '../ctx.js';
import { runTestDataset, runTestHeadless } from '../run.js';
import type { ToolRegistrar } from '../policy-middleware.js';
import { coerceOverrides, text } from './tests.js';

/**
 * Recursively scans a step tree for `db_assert`/`db_wait` leaves (C46):
 * those steps execute in the engine child process, which can never call back
 * into the host's appDb provider — including steps nested inside structural
 * blocks (if/repeat/for_each children, elseChildren).
 */
function containsDbStep(step: Record<string, unknown>): boolean {
  if (step.action === 'db_assert' || step.action === 'db_wait') return true;
  for (const key of ['children', 'elseChildren']) {
    const nested = step[key];
    if (
      Array.isArray(nested) &&
      nested.some(
        (child) =>
          !!child &&
          typeof child === 'object' &&
          containsDbStep(child as Record<string, unknown>),
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * C46 pre-flight: with a provider-only appDb, a saved test that contains
 * database steps is rejected BEFORE spawning the engine child (which would
 * only fail later with a generic no-connection error). Missing or malformed
 * tests are left to the runner's own errors.
 */
function assertEngineCanRunDbSteps(ctx: Ctx, strings: YattStrings, name: string): void {
  if (ctx.config.appDb?.type !== 'provider') return;
  const raw = ctx.store.testGet(name);
  if (!raw) return;
  let steps: unknown;
  try {
    steps = (JSON.parse(raw) as { steps?: unknown }).steps;
  } catch {
    return; // malformed docs fail later in the engine with their own error
  }
  const hasDbStep =
    Array.isArray(steps) &&
    steps.some(
      (step) =>
        !!step &&
        typeof step === 'object' &&
        containsDbStep(step as Record<string, unknown>),
    );
  if (hasDbStep) {
    throw new Error(strings.messages.dbAssertNeedsConnection(name));
  }
}

export function registerRunTools(reg: ToolRegistrar, ctx: Ctx, strings: YattStrings): void {
  const args = strings.args;
  const msg = strings.messages;
  const browserEnum = z.enum(['chromium', 'firefox', 'webkit']).optional().describe(args.browser);

  reg.register({
    name: 'test_run',
    description: strings.tools.testRun,
    inputSchema: {
      name: z.string().describe(args.runName),
      env: z.string().optional().describe(args.env),
      overrides: z.record(z.string(), z.unknown()).optional().describe(args.overrides),
      stepTimeoutMs: z.coerce.number().optional().describe(args.stepTimeoutMs),
      browser: browserEnum,
      url: z.string().optional().describe(args.url),
      saveReport: z.boolean().optional().describe(args.saveReport),
    },
    mutating: true,
    handler: async (raw) => {
      const a = raw as {
        name: string;
        env?: string;
        overrides?: Record<string, unknown>;
        stepTimeoutMs?: number;
        browser?: 'chromium' | 'firefox' | 'webkit';
        url?: string;
        saveReport?: boolean;
      };
      // C46: provider-only appDb cannot serve the engine child's db steps.
      assertEngineCanRunDbSteps(ctx, strings, a.name);
      const summary = await runTestHeadless(
        ctx,
        {
          name: a.name,
          env: a.env,
          overrides: coerceOverrides(a.overrides),
          // F3: the config runner default fills the absent tool arg (it was
          // dead config before — the CLI then fell back to its own 40s).
          stepTimeoutMs: a.stepTimeoutMs ?? ctx.config.runner.stepTimeoutMs,
          browser: a.browser,
          url: a.url,
          saveReport: a.saveReport,
        },
        { messages: strings.messages },
      );
      return text(summary);
    },
  });

  reg.register({
    name: 'test_run_dataset',
    description: strings.tools.testRunDataset,
    inputSchema: {
      name: z.string().describe(args.runName),
      rows: z.array(z.record(z.string(), z.unknown())).min(1).describe(args.rows),
      env: z.string().optional().describe(args.env),
      stepTimeoutMs: z.coerce.number().optional().describe(args.stepTimeoutMs),
      browser: browserEnum,
    },
    mutating: true,
    handler: async (raw) => {
      const a = raw as {
        name: string;
        rows: Array<Record<string, unknown>>;
        env?: string;
        stepTimeoutMs?: number;
        browser?: 'chromium' | 'firefox' | 'webkit';
      };
      const rows = a.rows.map(coerceOverrides);
      assertEngineCanRunDbSteps(ctx, strings, a.name);
      const result = await runTestDataset(ctx, {
        name: a.name,
        rows,
        env: a.env,
        stepTimeoutMs: a.stepTimeoutMs ?? ctx.config.runner.stepTimeoutMs,
        browser: a.browser,
      });
      return text({
        ...result,
        rows: result.rows.map((r, i) => ({
          row: i + 1,
          overrides: rows[i],
          ok: r.ok,
          fail: r.fail,
          skipped: r.skipped,
          stopped: r.stopped,
          durationMs: r.durationMs,
          passedPct: r.passedPct,
        })),
      });
    },
  });
}
