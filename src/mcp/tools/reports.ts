/**
 * Report tools (3): list/get/delete. Ported from the base
 * `mcp/src/tools/reports.ts`. After any mutation, the report retention pass
 * is fired (fire-and-forget) when `storage.retention` is configured (C29
 * wiring; D16: absent retention never deletes anything).
 */
import { z } from 'zod';

import type { YattStrings } from '../../i18n/index.js';
import type { Ctx } from '../ctx.js';
import type { ToolRegistrar } from '../policy-middleware.js';
import { text } from './tests.js';

export function registerReportTools(reg: ToolRegistrar, ctx: Ctx, strings: YattStrings): void {
  const { store } = ctx;
  const msg = strings.messages;
  const args = strings.args;

  reg.register({
    name: 'report_list',
    description: strings.tools.reportList,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      const reports = store.reportList();
      return text({ count: reports.length, reports });
    },
  });

  reg.register({
    name: 'report_get',
    description: strings.tools.reportGet,
    inputSchema: { name: z.string().describe(args.reportName) },
    mutating: false,
    handler: async (raw) => {
      const { name } = raw as { name: string };
      const content = store.reportGet(name);
      if (content === null) throw new Error(msg.reportMissingGet(name));
      return text({ name, report: JSON.parse(content) });
    },
  });

  reg.register({
    name: 'report_delete',
    description: strings.tools.reportDelete,
    inputSchema: { name: z.string() },
    mutating: true,
    handler: async (raw) => {
      const { name } = raw as { name: string };
      if (store.reportGet(name) === null) throw new Error(msg.reportMissingDelete(name));
      await store.deleteReport(name);
      // Fire-and-forget retention pass (C29): best-effort cleanup of old
      // reports; a no-op when no retention is configured (D16).
      void ctx.afterReportMutation();
      return text({ ok: true, deleted: name });
    },
  });
}
