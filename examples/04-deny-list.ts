/**
 * Recipe 04 — Deny list with both behaviors (C07).
 *
 * Per-tool allow/deny lists sit on top of read-only mode:
 * - `denyTools: ['test_delete', 'report_delete']` → those tools are blocked.
 * - `denyBehavior: 'error'` (default) → the tools stay LISTED and announce a
 *   clear policy error when called (deny always announces, D6).
 * - `denyBehavior: 'hide'` → the denied tools are omitted from listings
 *   entirely (a smaller catalog for the client).
 * - `allowTools` (optional, combinable) → default-deny: ONLY the listed
 *   tools work. Explicit deny always wins over allow.
 *
 *   node examples/04-deny-list.ts
 */
import { createYattServer } from '../src/index.js';

const server = await createYattServer({
  permissions: {
    // Never let the AI destroy data…
    denyTools: ['test_delete', 'report_delete', 'session_delete'],
    // …and announce the denial on call ('error') or hide the tools ('hide').
    denyBehavior: 'error',
    // Alternative shape: a strict allowlist (everything else is denied):
    // allowTools: ['ping', 'schema', 'test_list', 'test_get', 'test_run'],
  },
});

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});

await server.start(); // stdio
console.error('[recipe-04] yatt-ts server with a deny list ready');
