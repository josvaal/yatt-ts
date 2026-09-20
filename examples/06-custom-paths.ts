/**
 * Recipe 06 — Custom paths for every artifact (C11).
 *
 * Each artifact location is individually configurable; anything omitted
 * falls back to the default layout relative to the chosen root:
 *
 *   <root>/yatt.db      system database (source of truth)
 *   <root>/tests/       saved tests (*.yatt.json mirrors)
 *   <root>/reports/     run reports (*.json + *.html mirrors)
 *   <root>/exports/     Playwright/Jest spec exports
 *   <root>/baselines/   visual baselines (PNG)
 *   <root>/sessions/    session mirrors (only with sessions.persist: true)
 *
 * `~` expands to the home directory; relative paths resolve against the root.
 * You can also point `paths.root` at an EXISTING YATT desktop data folder —
 * the format is fully compatible.
 *
 *   node examples/06-custom-paths.ts
 */
import { createYattServer } from '../src/index.js';

const server = await createYattServer({
  paths: {
    root: '~/yatt-data', // data root (default: current working directory)
    db: 'system.sqlite', // default: yatt.db
    tests: 'suite', // default: tests
    reports: 'runs', // default: reports
    exports: 'generated-specs', // default: exports
    baselines: 'snapshots', // default: baselines
    sessions: 'login-states', // default: sessions
  },
});

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});

await server.start(); // stdio
console.error(`[recipe-06] ready with custom layout under ${server.ctx.root}`);
