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

/**
 * Multi-statement guard (review round F1): READ_ONLY_RE is start-anchored
 * only, so `SELECT 1; DROP TABLE users` passes it — and a host provider on
 * a live connection (TypeORM/pg simple-query protocol) would execute BOTH
 * statements. Engine-side connections are single-statement-safe by
 * construction (sqlite opened {readonly:true}, postgres BEGIN READ ONLY),
 * so this TOOL-LAYER check applies to both modes and restores parity.
 *
 * Strategy: strip the parts of the SQL that can legitimately contain a `;`
 * without separating statements (see `stripLiteralsAndComments`), then
 * reject when a `;` is still followed by real SQL (whitespace and further
 * `;` are skipped, so one or several TRAILING semicolons stay allowed).
 *
 * Known strictness, fail-closed on purpose: PostgreSQL dollar-quoted
 * strings ($$...$$) are not recognized — a `;` inside one is rejected.
 * Split such queries into separate db_query calls.
 */

/**
 * Pure scanner: blanks out single-quoted string literals ('...' with ''
 * escaping) and `--` line / `/*` block comments — the only places where a
 * `;` does NOT start a new statement. An unterminated literal or comment
 * runs to the end of the input, like a real SQL parser would treat it.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      // Single-quoted literal: consume it whole ('' is an escaped quote).
      out += "''";
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // escaped quote inside the literal
            continue;
          }
          i += 1; // closing quote
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      // Line comment: up to (not including) the newline.
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      // Block comment: up to the closing delimiter (or EOF when unterminated).
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = i < n ? i + 2 : n;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** A `;` that still sees SQL after it (skipping whitespace / `;`) → multi. */
const MULTI_STATEMENT_RE = /;\s*[^;\s]/;

/** Cap of returned rows (totalRows keeps the real count). */
export const ROW_CAP = 200;

/** Request timeout of the base tool (30 s); wraps `ctx.queryAppDb` (C44). */
export const DB_QUERY_TIMEOUT_MS = 30000;

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
      // F1 (review round): reject stacked statements before they can reach
      // any connection — engine-managed or the host provider (see the guard
      // docs above the scanner).
      if (MULTI_STATEMENT_RE.test(stripLiteralsAndComments(sql))) {
        throw new Error(msg.dbMultipleStatements);
      }
      // C47: the per-call connection override only makes sense for
      // engine-managed connections; in provider mode the host function IS
      // the one connection, so reject instead of silently ignoring it.
      if (db && ctx.appDbProvider) {
        throw new Error(msg.dbOverrideProviderOnly);
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
