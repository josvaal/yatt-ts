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
 * Bound of run_flow-referenced tests the C46 pre-flight will scan (review
 * round F3): a pathological (or machine-generated) reference graph cannot
 * make the pre-flight unbounded. References beyond the bound are left to
 * the runner, which fails them in the child with the generic no-connection
 * error — the same tradeoff as a missing test.
 */
const MAX_SCANNED_TESTS = 25;

/**
 * Recursively scans a step tree for `db_assert`/`db_wait` leaves (C46):
 * those steps execute in the engine child process, which can never call
 * back into the host's appDb provider. That includes steps nested inside
 * structural blocks (if/repeat/for_each children, elseChildren) AND, since
 * review round F3, inside run_flow-referenced sub-tests: the runner resolves
 * those by NAME at run time, so the pre-flight follows the same edges via
 * `resolveFlow`. `visited` (by test name, seeded with the top-level test)
 * stops reference cycles and `scanned` enforces MAX_SCANNED_TESTS.
 */
function containsDbStep(
  steps: unknown[],
  resolveFlow: (name: string) => unknown[] | null,
  visited: Set<string>,
  scanned: { count: number },
): boolean {
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const s = step as Record<string, unknown>;
    if (s.action === 'db_assert' || s.action === 'db_wait') return true;
    for (const key of ['children', 'elseChildren']) {
      const nested = s[key];
      if (
        Array.isArray(nested) &&
        containsDbStep(nested, resolveFlow, visited, scanned)
      ) {
        return true;
      }
    }
    if (s.action === 'run_flow' && typeof s.flow === 'string') {
      const flowName = s.flow.trim();
      if (!flowName || visited.has(flowName) || scanned.count >= MAX_SCANNED_TESTS) {
        continue; // cycles/bound/unresolvable → the runner owns the outcome
      }
      scanned.count += 1;
      visited.add(flowName);
      const flowSteps = resolveFlow(flowName);
      if (flowSteps && containsDbStep(flowSteps, resolveFlow, visited, scanned)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Steps of a saved test for the pre-flight scan. `null` = missing, invalid
 * JSON or a non-array `steps` — all left to the runner's own errors, same
 * as before F3.
 */
function stepsOfTest(store: Ctx['store'], name: string): unknown[] | null {
  const raw = store.testGet(name);
  if (!raw) return null;
  try {
    const steps = (JSON.parse(raw) as { steps?: unknown }).steps;
    return Array.isArray(steps) ? steps : null;
  } catch {
    return null; // malformed docs fail later in the engine with their own error
  }
}

/**
 * C46 pre-flight: with a provider-only appDb, a saved test that contains
 * database steps is rejected BEFORE spawning the engine child (which would
 * only fail later with a generic no-connection error). The scan follows
 * run_flow references into saved sub-tests (F3). Missing or malformed
 * tests are left to the runner's own errors.
 */
function assertEngineCanRunDbSteps(ctx: Ctx, strings: YattStrings, name: string): void {
  if (ctx.config.appDb?.type !== 'provider') return;
  const steps = stepsOfTest(ctx.store, name);
  if (!steps) return;
  const hasDbStep = containsDbStep(
    steps,
    (flowName) => stepsOfTest(ctx.store, flowName),
    new Set([name]),
    { count: 0 },
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
