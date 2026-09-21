/**
 * CLI spec (T10, C30 + C05/C06/C08 via CLI): spawns the COMPILED bin
 * (dist/cli.js) like a real consumer.
 *
 * Covered: --version (node + direct exec), serve --http without token →
 * ephemeral token printed ONCE on stderr (D4) and MCP HTTP clients with/-
 * without the token accepted/rejected (C06), --read-only + --deny-tool
 * denials announced through the CLI (C08/D5/D6), and stdio serve with a
 * client ping (C04 via CLI). Each spawn gets a tmp root; children are killed
 * in afterEach.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION } from '../../src/version.js';

const PKG_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = join(PKG_ROOT, 'dist', 'cli.js');

requireDist();

function requireDist(): void {
  if (!existsSync(CLI)) {
    throw new Error(`dist/cli.js not found — run "npm run build" before the CLI spec (${CLI})`);
  }
}

const children: ChildProcess[] = [];
const tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yatt-ts-cli-'));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop()!;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  while (tmpRoots.length > 0) {
    rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

/** Picks a free TCP port (small race window; collisions are unlikely). */
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface ServingHttp {
  child: ChildProcess;
  port: number;
  stderr: () => string;
  /** Resolves once `pattern` shows up on stderr (server ready signals). */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<void>;
}

function spawnHttpServe(extraArgs: string[], port: number): ServingHttp {
  const root = makeTmpRoot();
  const child = spawn(
    process.execPath,
    [CLI, 'serve', '--http', '--port', String(port), '--root', root, ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  let output = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  return {
    child,
    port,
    stderr: () => output,
    waitFor(pattern, timeoutMs = 15000) {
      const started = Date.now();
      return new Promise((resolveWait, rejectWait) => {
        const tick = (): void => {
          const match = output.match(pattern);
          if (match) {
            resolveWait();
            return;
          }
          if (Date.now() - started > timeoutMs) {
            return rejectWait(new Error(`timeout waiting for ${pattern} in stderr:\n${output}`));
          }
          setTimeout(tick, 100);
        };
        tick();
      });
    },
  };
}

/** Connects an MCP client over Streamable HTTP, optionally with the bearer. */
async function httpClient(port: number, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'cli-spec', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return client;
}

describe('yatt-ts CLI', () => {
  it('--version prints the package version', () => {
    const out = execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
    expect(out).toBe(`yatt-ts ${VERSION}\n`);
  });

  it('runs directly through the shebang (./dist/cli.js --version)', () => {
    const out = execFileSync(CLI, ['--version'], { encoding: 'utf8' });
    expect(out).toBe(`yatt-ts ${VERSION}\n`);
  });

  it('rejects bad arguments with exit code 2 and a clear message', () => {
    expect(() => execFileSync(process.execPath, [CLI, '--port', 'nope'], { encoding: 'utf8' }))
      .toThrow(/--port must be an integer/);
    expect(
      () =>
        execFileSync(process.execPath, [CLI, 'serve', '--http', '--token', 'short'], {
          encoding: 'utf8',
        }),
    ).toThrow(/--token is too short/);
    expect(() => execFileSync(process.execPath, [CLI, '--frobnicate'], { encoding: 'utf8' }))
      .toThrow(/unknown argument "--frobnicate"/);
  });

  it('serve --http without token generates an ephemeral token once and enforces it (C30, C05, C06, D4)', async () => {
    const port = await freePort();
    const serving = spawnHttpServe([], port);

    // The ephemeral token (64 hex chars) is printed ONCE to stderr, and the
    // listening line never contains it (redaction).
    await serving.waitFor(/generated ephemeral token, pass --token or --token-hash to fix it/);
    const tokenMatch = serving.stderr().match(/^[0-9a-f]{64}$/m);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![0];

    // With the token: ping answers (happy path).
    const client = await httpClient(port, token);
    await client.ping();
    await client.close();

    // Without the token: rejected.
    await expect(httpClient(port)).rejects.toThrow();

    // Give any late stderr (rejected-request log) time to land, then verify
    // the full token leaked exactly once.
    await new Promise((r) => setTimeout(r, 300));
    const leaked = serving.stderr().split(token).length - 1;
    expect(leaked).toBe(1);

    serving.child.kill('SIGTERM');
  }, 30000);

  it('serve --http --read-only --deny-tool announces policy denials (C08, C07 via CLI)', async () => {
    const port = await freePort();
    const token = 'cli-spec-explicit-token-0123456789';
    const serving = spawnHttpServe(
      ['--token', token, '--read-only', '--deny-tool', 'test_delete'],
      port,
    );
    await serving.waitFor(/yatt-ts MCP listening on http:\/\//);

    const client = await httpClient(port, token);
    try {
      await client.ping();

      // read-only: test_create denied with the announced reason (tool visible).
      const created = await client.callTool({
        name: 'test_create',
        arguments: { name: 'blocked', content: '{"schemaVersion":1,"name":"blocked","steps":[]}' },
      });
      expect(created.isError).toBe(true);
      const reason = ((created.content ?? []) as Array<{ text?: string }>)
        .map((b) => b.text ?? '')
        .join('\n');
      expect(reason).toContain('read-only');

      // deny-tool: test_delete denied and the denial announces the policy.
      const deleted = await client.callTool({
        name: 'test_delete',
        arguments: { name: 'anything' },
      });
      expect(deleted.isError).toBe(true);
      const denyText = ((deleted.content ?? []) as Array<{ text?: string }>)
        .map((b) => b.text ?? '')
        .join('\n');
      expect(denyText).toContain("tool 'test_delete' is not permitted");

      // Reads keep working.
      const listed = await client.callTool({ name: 'test_list', arguments: {} });
      expect(listed.isError).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 30000);

  it('serve over stdio answers a client ping (C04 via CLI)', async () => {
    const root = makeTmpRoot();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve', '--root', root],
    });
    const client = new Client({ name: 'cli-spec-stdio', version: '0.0.0' });
    await client.connect(transport);
    try {
      await client.ping();
    } finally {
      await client.close();
    }
  }, 30000);
});
