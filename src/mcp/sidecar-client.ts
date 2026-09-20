/**
 * JSON-RPC client for the yatt-ts engine (the Playwright sidecar). Same
 * contract as the base tool's Rust host: requests `{"id","method","params"}`
 * through stdin, responses `{"type":"response","id","ok","result"|"error"}`
 * and events `{"type":"event","name","data"}` interleaved on stdout,
 * newline-delimited.
 *
 * Ported from the base `mcp/src/sidecar.ts` with the repo-layout hardcodes
 * removed:
 * - `engineEntry` is resolved INSIDE this package (dist/engine/index.js next
 *   to this module once compiled) — never from the base repo.
 * - The spawn command comes from `config.engine.runtime` (C15): 'auto'
 *   probes bun then node; 'bun'/'node' force the runtime; any other string
 *   is a binary path executed directly (no args for the bridge, CLI args
 *   appended when used by the runner).
 * - Timeouts (ready 20s, request 120s, close grace 5s) come from config.
 *
 * Lifecycle preserved: lazy spawn, readiness via the `sidecar_ready` event
 * with a fail timer, crash → failAll + respawn on the next call, promise-chain
 * serialization (single browser, one client at a time — D23), `.data` passthrough
 * on error payloads (failure screenshots).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SerializableAppDb } from '../engine/options.js';
import { serializeAppDb } from '../engine/options.js';
import type { EngineOptions } from '../engine/state.js';
import { DEFAULT_ENGINE_OPTIONS } from '../engine/state.js';
import type { ResolvedAppDb } from '../engine/options.js';
import type { SidecarClient as SidecarClientContract, SidecarEvent } from './sidecar-types.js';

type Waiter = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Probes whether a command is runnable (base behavior: `<cmd> --version`). */
export type RuntimeProbe = (cmd: string) => boolean;

function defaultProbe(cmd: string): boolean {
  try {
    return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolves the spawn command for the configured runtime (C15).
 *
 * - 'auto'  → `bun <entry>` when bun answers `--version`, else `node <entry>`.
 * - 'bun'   → `bun <entry>`.
 * - 'node'  → `node <entry>`.
 * - other   → the runtime string is a binary path: executed directly, with
 *   `extraArgs` appended (empty for bridge calls; run arguments for the CLI).
 */
export function resolveRuntimeCommand(
  runtime: string,
  engineEntry: string,
  extraArgs: string[] = [],
  probe: RuntimeProbe = defaultProbe,
): { cmd: string; args: string[] } {
  const value = String(runtime ?? '').trim() || 'auto';
  if (value === 'auto') {
    return probe('bun')
      ? { cmd: 'bun', args: [engineEntry, ...extraArgs] }
      : { cmd: 'node', args: [engineEntry, ...extraArgs] };
  }
  if (value === 'bun') return { cmd: 'bun', args: [engineEntry, ...extraArgs] };
  if (value === 'node') return { cmd: 'node', args: [engineEntry, ...extraArgs] };
  return { cmd: value, args: [...extraArgs] };
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the compiled engine entry (bridge `index.js` or `cli.js`) inside
 * THIS package. When running from source (`src/mcp/…`), falls back to the
 * compiled `dist/engine/<file>` twin so tests/e2e work after `npm run build`.
 * Throws a clear error when nothing is built yet.
 */
export function resolveEngineEntry(file: 'index.js' | 'cli.js'): string {
  const candidates: string[] = [join(THIS_DIR, '..', 'engine', file)];
  // Dev fallback: src/mcp/* → dist/engine/* (same package, compiled output).
  if (THIS_DIR.split(sep).includes('src')) {
    candidates.push(join(THIS_DIR, '..', '..', 'dist', 'engine', file));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `engine entry not found (${candidates.join(' | ')}). Run "npm run build" inside the yatt-ts package first.`,
  );
}

/** Options for constructing a {@link SidecarClient} (from ResolvedConfig). */
export interface SidecarClientOptions {
  /** Data root passed as YATT_ROOT to the engine process. */
  root: string;
  /** `config.engine.runtime` (auto | bun | node | binary path). */
  runtime: string;
  /** Engine bridge entry; defaults to the in-package compiled bridge. */
  engineEntry?: string;
  /** Fail timer for the `sidecar_ready` event (config.engine.readyTimeoutMs). */
  readyTimeoutMs: number;
  /** Default per-request timeout (config.engine.requestTimeoutMs). */
  requestTimeoutMs: number;
  /** Grace before SIGKILL on close (config.engine.closeGraceMs). */
  closeGraceMs: number;
  /** Rich app-under-test connection → YATT_APP_DB_JSON (D22: env, not argv). */
  appDb?: ResolvedAppDb | null;
  /** Browser defaults → YATT_ENGINE_JSON. */
  engineOptions?: EngineOptions;
  /** Injectable runtime probe (tests). */
  probe?: RuntimeProbe;
  /** Extra environment for the child process (tests). */
  env?: Record<string, string>;
}

export class SidecarClient implements SidecarClientContract {
  private child: ChildProcess | null = null;
  private buf = '';
  private seq = 1;
  private waiters = new Map<number, Waiter>();
  private ready: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(event: SidecarEvent) => void>();

  private readonly root: string;
  private readonly runtime: string;
  private readonly entry: string;
  private readonly readyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly appDb: ResolvedAppDb | null;
  private readonly engineOpts: EngineOptions;
  private readonly probe: RuntimeProbe;
  private readonly extraEnv: Record<string, string>;

  constructor(options: SidecarClientOptions) {
    this.root = options.root;
    this.runtime = options.runtime;
    this.entry = options.engineEntry ?? resolveEngineEntry('index.js');
    this.readyTimeoutMs = options.readyTimeoutMs;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.closeGraceMs = options.closeGraceMs;
    this.appDb = options.appDb ?? null;
    this.engineOpts = options.engineOptions ?? DEFAULT_ENGINE_OPTIONS;
    this.probe = options.probe ?? defaultProbe;
    this.extraEnv = options.env ?? {};
  }

  /** Spawn command: resolved from the configured runtime (C15). */
  private command(): { cmd: string; args: string[] } {
    return resolveRuntimeCommand(this.runtime, this.entry, [], this.probe);
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Engine process id, when running (used by tests to kill/respawn). */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Environment for the engine process: config travels via env (D22). */
  private async childEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv, YATT_ROOT: this.root };
    if (this.appDb) {
      const payload: SerializableAppDb = await serializeAppDb(this.appDb);
      env.YATT_APP_DB_JSON = JSON.stringify(payload);
    }
    env.YATT_ENGINE_JSON = JSON.stringify(this.engineOpts);
    return env;
  }

  /** Spawns the engine (once) and waits for the `sidecar_ready` event. */
  private ensure(): Promise<void> {
    if (!this.ready) this.ready = this.start();
    return this.ready;
  }

  private async start(): Promise<void> {
    const { cmd, args } = this.command();
    const child = spawn(cmd, args, {
      // cwd = the engine entry directory (inside this package).
      cwd: dirname(this.entry),
      env: await this.childEnv(),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = child;

    return new Promise<void>((resolveReady, rejectReady) => {
      const failTimer = setTimeout(() => {
        this.readyHandlers.splice(0).forEach((h) => clearTimeout(h.failTimer));
        rejectReady(new Error(`engine did not become ready within ${this.readyTimeoutMs} ms`));
      }, this.readyTimeoutMs);
      this.readyHandlers.push({ resolveReady, rejectReady, failTimer });

      child.stdout!.on('data', (chunk: Buffer) => {
        this.buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (!line) continue;
          try {
            this.handleLine(JSON.parse(line));
          } catch {
            /* corrupt line: ignored */
          }
        }
      });

      child.on('error', (err) => {
        this.readyHandlers.splice(0).forEach((h) => clearTimeout(h.failTimer));
        this.child = null;
        this.ready = null;
        rejectReady(new Error(`could not launch the engine (${cmd}): ${err.message}`));
        this.failAll(new Error(`could not launch the engine: ${err.message}`));
      });
      child.on('exit', (code) => {
        if (this.child !== child) return; // orderly close already processed
        this.child = null;
        this.ready = null;
        const msg = `engine exited unexpectedly (code ${code})`;
        this.readyHandlers.splice(0).forEach((h) => {
          clearTimeout(h.failTimer);
          h.rejectReady(new Error(msg));
        });
        this.failAll(new Error(msg));
      });
    });
  }

  private readyHandlers: Array<{
    resolveReady: () => void;
    rejectReady: (e: Error) => void;
    failTimer: ReturnType<typeof setTimeout>;
  }> = [];

  private handleLine(msg: {
    type?: string;
    id?: number;
    ok?: boolean;
    result?: unknown;
    error?: string;
    name?: string;
    data?: Record<string, unknown>;
  }): void {
    if (msg.type === 'event') {
      if (msg.name === 'sidecar_ready') {
        const handlers = this.readyHandlers.splice(0);
        for (const h of handlers) {
          clearTimeout(h.failTimer);
          h.resolveReady();
        }
      }
      const event: SidecarEvent = { name: msg.name ?? '?', data: msg.data ?? {} };
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          /* listener errors must not break the protocol loop */
        }
      }
      return;
    }
    if (msg.type === 'response') {
      const w = this.waiters.get(msg.id ?? -1);
      if (!w) return;
      this.waiters.delete(msg.id ?? -1);
      clearTimeout(w.timer);
      if (msg.ok) w.resolve(msg.result);
      else {
        // Attaches the full result (e.g. a failed step's evidence screenshot)
        // so callers can surface it.
        const e = new Error(msg.error ?? 'engine error');
        (e as Error & { data?: unknown }).data = msg.result;
        w.reject(e);
      }
    }
  }

  private failAll(err: Error): void {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
  }

  /** Runs an engine method, serialized with every other call (D23). */
  req<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    const run = () => this.reqInner<T>(method, params, timeoutMs);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async reqInner<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    await this.ensure();
    if (!this.child || !this.child.stdin?.writable) throw new Error('the engine is not available');
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`engine timeout in "${method}" (${timeoutMs} ms)`));
      }, timeoutMs);
      this.waiters.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  /** Subscribes to engine events (browser_status, tabs_changed, log, …). */
  onEvent(listener: (event: SidecarEvent) => void): void {
    this.listeners.add(listener);
  }

  /** Orderly close: EOF on stdin → the engine closes Chromium and exits. */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (!child || child.exitCode !== null) return;
    child.stdin!.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, this.closeGraceMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.failAll(new Error('engine closed'));
  }
}

/** Module URL as a file path (exported for tests/asserts). */
export const sidecarClientDir = THIS_DIR;

/** Resolves a file URL relative to this module (test helper). */
export function moduleRelativePath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}
