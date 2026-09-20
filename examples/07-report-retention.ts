/**
 * Recipe 07 — Report retention policy (C29, D16).
 *
 * By default yatt-ts NEVER deletes anything. With `storage.retention` you
 * opt in to automatic cleanup of old run reports, applied after every
 * report mutation:
 * - `maxAgeDays`: delete reports older than N days (by stored timestamp),
 * - `maxReports`: keep only the newest N reports.
 * Both can be combined (age first, then count). Reports are removed from
 * the database AND their `reports/` mirrors.
 *
 * Handy because reports embed per-step screenshots and can grow large.
 *
 *   node examples/07-report-retention.ts
 */
import { createYattServer } from '../src/index.js';

const server = await createYattServer({
  storage: {
    retention: {
      maxAgeDays: 30, // drop reports older than 30 days…
      maxReports: 200, // …and never keep more than 200
    },
  },
});

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});

await server.start(); // stdio
console.error('[recipe-07] ready — reports older than 30d (or beyond 200) are cleaned up');
