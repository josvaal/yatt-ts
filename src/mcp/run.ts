/**
 * Headless runner of the MCP server: one-shot spawns of the engine CLI per
 * run (isolation, Ctrl+C and per-step engine timeout). The CLI JSON
 * (`RunOutcome`) is mapped to the library `RunReport` and saved with the same
 * invariant as `report_save`: DB + `reports/<slug>.json|.html` mirrors.
 *
 * Ported from the base `mcp/src/run.ts` with two fixes:
 * - the `spawn("bun")` HARDCODE is gone: the CLI runtime is resolved with the
 *   SAME resolver as the engine bridge (`config.engine.runtime`, C15).
 * - `engineCliEntry` points at the compiled CLI inside THIS package
 *   (dist/engine/cli.js), never at the base repo.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { engineOptionsFromConfig, serializeAppDb, type SerializableAppDb } from '../engine/options.js';
import type { ResolvedAppDb } from '../engine/options.js';
import type { EngineOptions } from '../engine/state.js';
import { resolveEngineEntry, resolveRuntimeCommand, type RuntimeProbe } from './sidecar-client.js';
import { buildReportHtml, buildReportJson, reportSlug, type RunRecord, type RunReport } from '../lib/report.js';
import type { Ctx } from './ctx.js';

export interface RunRequest {
  /** Name of the saved test (DB key; run from its mirror). */
  name: string;
  env?: string;
  overrides?: Record<string, string>;
  /** Per-step timeout in ms (default from config.runner). */
  stepTimeoutMs?: number;
  browser?: 'chromium' | 'firefox' | 'webkit';
  url?: string;
  /** Saves the report to the DB + reports/ (default from config.runner). */
  saveReport?: boolean;
}

export interface RunSummary {
  ok: number;
  fail: number;
  skipped: number;
  stopped: boolean;
  durationMs: number;
  /** Percentage of green steps (rounded). */
  passedPct: number;
  steps: RunRecord[];
  report?: { slug: string; json: string; html: string };
  error?: string;
}

/** Shape of the JSON written by the CLI (engine RunOutcome + meta). */
interface CliOutcome {
  records?: unknown[];
  ok?: number;
  fail?: number;
  skipped?: number;
  stopped?: boolean;
}

/** Spawn contract (injectable for tests). */
export type SpawnCli = (
  cmd: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ code: number; stderr: string }>;

/** Default one-shot spawn: captures stderr, ignores stdout/stdin. */
export const defaultSpawnCli: SpawnCli = (cmd, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => reject(new Error(`could not launch the engine: ${err.message}`)));
    child.on('exit', (code) => resolve({ code: code ?? 2, stderr }));
  });

/**
 * Builds the exact CLI command for a run (pure; unit-testable).
 * `[runtime, engineCliEntry, 'run', testFile, '--json', tmpJson, '--env', …]`
 * with the base argument contract: per-key `--override`, `--timeout` in
 * whole seconds, `--browser` and `--url` when set.
 */
export function buildRunCommand(options: {
  runtime: string;
  engineCliEntry: string;
  /** Absolute path of the saved test mirror. */
  testFile: string;
  tmpJson: string;
  req: RunRequest;
  defaultBrowser: 'chromium' | 'firefox' | 'webkit';
  probe?: RuntimeProbe;
}): { cmd: string; args: string[] } {
  const { runtime, engineCliEntry, testFile, tmpJson, req, defaultBrowser, probe } = options;
  const args = ['run', testFile, '--json', tmpJson, '--env', req.env ?? 'default'];
  for (const [k, v] of Object.entries(req.overrides ?? {})) {
    args.push('--override', `${k}=${v}`);
  }
  if (req.stepTimeoutMs && req.stepTimeoutMs > 0) {
    args.push('--timeout', String(Math.max(1, Math.round(req.stepTimeoutMs / 1000))));
  }
  args.push('--browser', req.browser ?? defaultBrowser);
  if (req.url) args.push('--url', req.url);
  return resolveRuntimeCommand(runtime, engineCliEntry, args, probe);
}

/**
 * Environment for the CLI process: root + app-db via env, never argv (D22),
 * plus the projected engine options (F3): without YATT_ENGINE_JSON the one-shot
 * engine falls back to the built-in defaults and ignores viewport/timeouts/
 * toolbar/autoInstall AND the custom artifact paths (F1).
 */
export async function buildRunEnv(
  root: string,
  appDb: ResolvedAppDb | null,
  engineOptions?: EngineOptions,
  extra: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...extra, YATT_ROOT: root };
  if (appDb) {
    const payload: SerializableAppDb = await serializeAppDb(appDb);
    env.YATT_APP_DB_JSON = JSON.stringify(payload);
  }
  if (engineOptions) {
    env.YATT_ENGINE_JSON = JSON.stringify(engineOptions);
  }
  return env;
}

/** Localizable runner messages (defaults in English; tools pass the locale copy). */
export interface RunnerMessages {
  runTestMissing(name: string): string;
  runFailedNoReport(stderrTail: string): string;
}

export const ENGLISH_RUNNER_MESSAGES: RunnerMessages = {
  runTestMissing: (name) => `test "${name}" is not saved (create it with test_create first)`,
  runFailedNoReport: (tail) => `the run failed without a report: ${tail}`,
};

/**
 * Runs one saved test headless. `hooks` is test surface only: inject a spawn
 * mock, the CLI entry and/or localized messages (the defaults resolve the
 * in-package compiled CLI with canonical English copy).
 */
export async function runTestHeadless(
  ctx: Ctx,
  req: RunRequest,
  hooks: { spawnCli?: SpawnCli; engineCliEntry?: string; messages?: RunnerMessages } = {},
): Promise<RunSummary> {
  const config = ctx.config;
  const messages = hooks.messages ?? ENGLISH_RUNNER_MESSAGES;
  const testFile = join(config.paths.tests, `${Store_sanitize(req.name)}.yatt.json`);
  if (!existsSync(testFile)) {
    throw new Error(messages.runTestMissing(req.name));
  }

  const tmpJson = join(
    tmpdir(),
    `yatt-ts-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const engineCliEntry = hooks.engineCliEntry ?? resolveEngineEntry('cli.js');
  const { cmd, args } = buildRunCommand({
    runtime: config.engine.runtime,
    engineCliEntry,
    testFile,
    tmpJson,
    req,
    defaultBrowser: config.runner.defaultBrowser,
  });

  const startedAt = Date.now();
  const spawnCli = hooks.spawnCli ?? defaultSpawnCli;
  const { code, stderr } = await spawnCli(cmd, args, {
    cwd: dirname(engineCliEntry),
    env: await buildRunEnv(
      config.paths.root,
      config.appDb ?? null,
      engineOptionsFromConfig(config),
    ),
  });
  const durationMs = Date.now() - startedAt;

  let outcome: CliOutcome | null = null;
  if (existsSync(tmpJson)) {
    try {
      outcome = JSON.parse(readFileSync(tmpJson, 'utf8')) as CliOutcome;
    } catch {
      outcome = null;
    }
    rmSync(tmpJson, { force: true });
  }

  if (!outcome) {
    throw new Error(messages.runFailedNoReport(lastLines(stderr)));
  }

  const records = (outcome.records ?? []).map((r) => ({ ...(r as RunRecord) }));
  const summary: RunSummary = {
    ok: outcome.ok ?? 0,
    fail: outcome.fail ?? 0,
    skipped: outcome.skipped ?? 0,
    stopped: outcome.stopped === true,
    durationMs,
    passedPct: 0,
    steps: records,
  };
  const total = summary.ok + summary.fail + summary.skipped;
  summary.passedPct = total > 0 ? Math.round((summary.ok / total) * 100) : 0;

  const saveReport = req.saveReport ?? config.runner.saveReport;
  if (saveReport) {
    const report: RunReport = {
      kind: 'test',
      title: `${req.name} · YATT`,
      testName: req.name,
      url: req.url,
      env: req.env ?? 'default',
      headless: true,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(startedAt + durationMs).toISOString(),
      durationMs,
      ok: summary.ok,
      fail: summary.fail,
      skipped: summary.skipped,
      stopped: summary.stopped,
      logs: lastLines(stderr, 20).split('\n'),
      steps: records,
    };
    const slug = reportSlug(report.title);
    const jsonName = `${slug}.json`;
    const htmlName = `${slug}.html`;
    await ctx.store.upsertReport(jsonName, buildReportJson(report));
    await ctx.store.upsertReport(htmlName, buildReportHtml(report));
    summary.report = { slug, json: jsonName, html: htmlName };
    // Retention hook (C29): fire-and-forget; a no-op without configuration (D16).
    void ctx.afterReportMutation();
  }

  if (code !== 0 && code !== 1) {
    summary.error = lastLines(stderr);
  }
  return summary;
}

/** Dataset (data-driven): runs the test once per row of overrides (C20). */
export async function runTestDataset(
  ctx: Ctx,
  req: RunRequest & { rows: Array<Record<string, string>> },
  hooks: { spawnCli?: SpawnCli; engineCliEntry?: string } = {},
): Promise<{ rows: RunSummary[]; ok: number; fail: number; stopped: boolean; durationMs: number }> {
  const startedAt = Date.now();
  const rows: RunSummary[] = [];
  let ok = 0;
  let fail = 0;
  let stopped = false;
  for (const row of req.rows) {
    const r = await runTestHeadless(
      ctx,
      { ...req, overrides: { ...(req.overrides ?? {}), ...row }, saveReport: false },
      hooks,
    );
    rows.push(r);
    ok += r.ok;
    fail += r.fail;
    stopped = stopped || r.stopped;
  }
  return { rows, ok, fail, stopped, durationMs: Date.now() - startedAt };
}

/** Store-quality name for the mirror lookup (rejects path escapes). */
function Store_sanitize(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error(`invalid name: "${name}"`);
  }
  return trimmed;
}

function lastLines(s: string, n = 8): string {
  return s.split('\n').filter(Boolean).slice(-n).join('\n').trim() || 'no details';
}
