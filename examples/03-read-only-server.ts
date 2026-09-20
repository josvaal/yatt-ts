/**
 * Recipe 03 — Read-only server (C08).
 *
 * `permissions.readOnly: true` denies every state-mutating tool
 * (test_create/update/delete/rename/duplicate, test_run*, report_delete,
 * session_save/delete, …) with a CLEAR announced reason — nothing hides,
 * the AI just sees "this server runs in read-only mode". All read tools
 * keep working: test_list, test_get, report_list, browser_preview, ping…
 *
 * Great for pointing an AI assistant at an existing YATT library you do
 * not want it to modify.
 *
 *   node examples/03-read-only-server.ts
 */
import { createYattServer } from '../src/index.js';

const server = await createYattServer({
  // Point at an existing YATT data folder (same format as the desktop app).
  paths: { root: '/path/to/your/yatt-data' },
  permissions: {
    readOnly: true,
  },
});

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});

await server.start(); // stdio
console.error('[recipe-03] read-only yatt-ts server ready');
