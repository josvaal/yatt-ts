/**
 * Report retention (D16): old-report cleanup is strictly opt-in. With no
 * retention configured NOTHING is ever deleted — deletion only happens for a
 * caller that explicitly passes a policy.
 *
 * Applied in two passes: first by age (`maxAgeDays`, compared against
 * `updated_at`), then by count (`maxReports`, keeping the newest N).
 */
import type { Store } from './store.js';

/** Retention policy for stored reports. */
export interface ReportRetention {
  /** Delete reports older than this many days (by `updated_at`). */
  maxAgeDays?: number;
  /** Keep only the newest N reports. */
  maxReports?: number;
}

/** Outcome of a retention pass. */
export interface RetentionResult {
  /** Names deleted from the DB (and their mirrors, via `Store.deleteReport`). */
  deleted: string[];
}

const DAY_MS = 86_400_000;

/**
 * Applies the configured retention to the reports in the store. Passing
 * `undefined` (the default config state) is a no-op returning
 * `{ deleted: [] }` (D16: nobody deletes without permission).
 */
export async function applyReportRetention(
  store: Store,
  retention: ReportRetention | undefined,
): Promise<RetentionResult> {
  if (!retention) {
    return { deleted: [] };
  }

  const deleted: string[] = [];

  if (retention.maxAgeDays !== undefined) {
    const cutoff = Date.now() - retention.maxAgeDays * DAY_MS;
    for (const entry of store.reportEntries()) {
      if (entry.updatedAt < cutoff) {
        await store.deleteReport(entry.name);
        deleted.push(entry.name);
      }
    }
  }

  if (retention.maxReports !== undefined) {
    const remaining = [...store.reportEntries()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const entry of remaining.slice(retention.maxReports)) {
      await store.deleteReport(entry.name);
      deleted.push(entry.name);
    }
  }

  return { deleted };
}
