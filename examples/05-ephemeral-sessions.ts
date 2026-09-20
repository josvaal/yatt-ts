/**
 * Recipe 05 — Ephemeral sessions: `sessions.persist: false` (C09, D7).
 *
 * Default behavior saves browser sessions (cookies + localStorage) to the
 * system database AND a `sessions/<name>.json` mirror. With `persist: false`
 * sessions live in MEMORY only:
 * - `session_save` / `session_list` / restoring by name all work live,
 * - NOTHING is ever written to disk (no DB row, no file),
 * - everything is wiped when the server process ends.
 *
 * Ideal for shared machines, CI, or privacy-sensitive flows.
 *
 *   node examples/05-ephemeral-sessions.ts
 */
import { createYattServer } from '../src/index.js';

const server = await createYattServer({
  sessions: {
    persist: false, // in-memory sessions, wiped on close (default: true)
  },
});

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});

await server.start(); // stdio
console.error('[recipe-05] yatt-ts ready — sessions are memory-only and leave zero traces');
