/**
 * Recipe 01 — Zero-config stdio server (C28).
 *
 * `createYattServer()` with NO arguments boots a complete YATT MCP server
 * with every default applied: data root = current working directory,
 * headless Chromium engine ON, toolbar OFF, stdio transport.
 *
 * Run it and connect any MCP client to this process's stdio:
 *
 *   node examples/01-zero-config-stdio.ts
 *   # or, compiled:
 *   npx yatt-ts
 *
 * NOTE: stdio is the protocol channel — always log to stderr, never stdout.
 */
import { createYattServer } from '../src/index.js';

const server = await createYattServer();

// Ctrl+C / SIGTERM trigger a graceful shutdown (store flushed, engine closed).
process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});

await server.start(); // no transport argument → stdio
console.error(`[recipe-01] yatt-ts stdio server ready (data root: ${server.ctx.root})`);
