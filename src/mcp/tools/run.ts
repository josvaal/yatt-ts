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
      const summary = await runTestHeadless(
        ctx,
        {
          name: a.name,
          env: a.env,
          overrides: coerceOverrides(a.overrides),
          stepTimeoutMs: a.stepTimeoutMs,
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
      const result = await runTestDataset(ctx, {
        name: a.name,
        rows,
        env: a.env,
        stepTimeoutMs: a.stepTimeoutMs,
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
