/**
 * Recipe 02 — HTTP transport with bearer-token auth (C05/C06).
 *
 * Exposes the server over Streamable HTTP on a fixed port. Every request
 * must present `Authorization: Bearer <token>`; failures get a 401 and the
 * token is never logged (only redacted hints reach stderr).
 *
 * The token can be a plain string (min 16 chars) or its SHA-256 hex digest
 * (`auth.tokenHash`) so the raw secret never sits in your config file.
 *
 *   node examples/02-http-with-token.ts
 *   # then connect an MCP client to http://127.0.0.1:3191/ with the header:
 *   #   Authorization: Bearer change-me-at-least-16-chars
 */
import { createYattServer } from '../src/index.js';

const server = await createYattServer({
  http: {
    enabled: true,
    port: 3191, // default; any free port works
    host: '127.0.0.1', // bind explicitly; use '0.0.0.0' only behind a firewall
  },
  auth: {
    token: 'change-me-at-least-16-chars',
  },
});

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});

await server.start();
console.error('[recipe-02] listening on http://127.0.0.1:3191 (bearer token required)');
