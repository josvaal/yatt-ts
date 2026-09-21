/**
 * Engine CLI spec (F10 regression, limitation 3a): the compiled headless CLI
 * (dist/engine/cli.js) must turn an unexpected main() rejection into the
 * documented usage-error exit code (2) with a clean diagnostic on stderr —
 * never an unhandled rejection (exit 1, stack-only dump).
 *
 * The scenario drives the ONE error source checked before any argument or
 * file handling: malformed YATT_APP_DB_JSON (appdb.ts throws while main()
 * is still resolving its injected configuration). The spawned process gets a
 * minimal env (YATT_ROOT to a tmp dir) so the ONLY seeded error source is the
 * malformed JSON.
 *
 * Run `npm run build` first — like test/unit/cli.spec.ts, this spec consumes
 * the compiled artifact and fails with a clear error when it is missing.
 */
import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ENGINE_CLI = join(PKG_ROOT, 'dist', 'engine', 'cli.js');

function requireDist(): void {
  if (!existsSync(ENGINE_CLI)) {
    throw new Error(
      `dist/engine/cli.js not found — run "npm run build" before the engine CLI spec (${ENGINE_CLI})`,
    );
  }
}

requireDist();

/** Spawns the engine CLI with a curated env; resolves code + collected stderr. */
function spawnEngineCli(env: NodeJS.ProcessEnv): {
  child: ChildProcess;
  exit: Promise<{ code: number | null; stderr: string }>;
} {
  const child = spawn(process.execPath, [ENGINE_CLI], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const exit = new Promise<{ code: number | null; stderr: string }>((resolveExit) => {
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout!.resume();
    child.on('exit', (code) => resolveExit({ code, stderr }));
  });
  return { child, exit };
}

describe('engine CLI exit codes (F10, limitation 3a)', () => {
  it('exits 2 with a clean diagnostic when YATT_APP_DB_JSON is invalid JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yatt-ts-engine-cli-'));
    const { child, exit } = spawnEngineCli({
      // Minimal environment: the ONLY error source is the malformed JSON.
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YATT_ROOT: root,
      YATT_APP_DB_JSON: '{"type": ',
    });
    try {
      const result = await exit;
      // The documented usage-error code, NOT an unhandled rejection (code 1).
      expect(result.code).toBe(2);
      // A clean error reached stderr (non-empty, names the offending env var).
      expect(result.stderr.trim().length).toBeGreaterThan(0);
      expect(result.stderr).toContain('invalid YATT_APP_DB_JSON: not valid JSON');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
