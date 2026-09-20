/**
 * Shared helpers for the unit specs: boots a real yatt-ts server and talks
 * to it through the official MCP SDK client over an in-memory transport
 * (deterministic, no I/O beyond the configured data root).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createYattServer, type YattConfig, type YattServer } from '../../../src/index.js';

/** Fresh ephemeral data root per test (C12 style: nothing outside it). */
export function makeTmpRoot(prefix = 'yatt-ts-unit-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Boots the server with the given config and connects an MCP client. */
export async function startWithClient(config?: YattConfig): Promise<{
  handle: YattServer;
  client: Client;
}> {
  const handle = await createYattServer(config);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([handle.start(serverTransport), client.connect(clientTransport)]);
  return { handle, client };
}

/** Jointly closes the client and the server (store included). */
export async function stop(handle: YattServer, client: Client): Promise<void> {
  await handle.shutdown();
  await client.close();
}

/** Concatenated text of a tool result. */
export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? '').join('\n');
}

/** Parses the JSON envelope carried by a tool result. */
export function jsonOf(result: unknown): any {
  return JSON.parse(textOf(result));
}

/** Whether the tool result is a protocol-level error (handler threw). */
export function isError(result: unknown): boolean {
  return Boolean((result as { isError?: boolean }).isError);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
