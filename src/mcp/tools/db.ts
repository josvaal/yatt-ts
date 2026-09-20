/**
 * App-under-test database tool (1): read-only queries. Ported from the base
 * `mcp/src/tools/db.ts` + the read-only guard of `sidecar/src/appdb.ts`
 * (same regex, same 30 s timeout, same ROW_CAP/totalRows semantics).
 *
 * The query runs through the injected `ctx.queryAppDb` function (wired to
 * the engine in T7); when absent the tool fails with a clear error (C21).
 */
import { z } from 'zod';

import type { YattStrings } from '../../i18n/index.js';
import type { Ctx } from '../ctx.js';
import type { ToolRegistrar } from '../policy-middleware.js';
import { text } from './tests.js';

/** Rejects any statement that is not a read (base `appdb.ts` guard). */
const READ_ONLY_RE = /^\s*(select|with|explain|pragma)\b/i;

/** Cap of returned rows (totalRows keeps the real count). */
const ROW_CAP = 200;

/** Request timeout of the base tool (30 s). */
const DB_QUERY_TIMEOUT_MS = 30000;

export function registerDbTools(reg: ToolRegistrar, ctx: Ctx, strings: YattStrings): void {
  const msg = strings.messages;

  reg.register({
    name: 'db_query',
    description: strings.tools.dbQuery,
    inputSchema: {
      sql: z.string().describe(strings.args.sql),
      db: z.string().optional().describe(strings.args.db),
    },
    mutating: false,
    handler: async (raw) => {
      if (!ctx.queryAppDb) {
        throw new Error(msg.dbEngineRequired);
      }
      const { sql, db } = raw as { sql: string; db?: string };
      if (!READ_ONLY_RE.test(sql)) {
        throw new Error(msg.dbReadOnly());
      }
      const result = await withTimeout(
        ctx.queryAppDb({ sql, db }),
        DB_QUERY_TIMEOUT_MS,
        msg.dbQueryTimeout(DB_QUERY_TIMEOUT_MS),
      );
      const allRows = Array.isArray(result.rows) ? result.rows : [];
      return text({
        columns: Array.isArray(result.columns) ? result.columns : [],
        rows: allRows.slice(0, ROW_CAP),
        totalRows: typeof result.totalRows === 'number' ? result.totalRows : allRows.length,
      });
    },
  });
}

/** Races a promise against a timeout, always clearing the timer. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
