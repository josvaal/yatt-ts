#!/usr/bin/env node
/**
 * Fake engine CLI for runner unit tests: accepts the real CLI argument
 * contract (`run <file> --json <out> --env … [--override k=v …] --timeout N
 * --browser b [--url u]`), writes the outcome JSON the runner expects, and
 * optionally appends an invocation log line to YATT_FAKE_CLI_LOG (dataset
 * invocation counting).
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function collectPairs(name) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      const kv = argv[i + 1] ?? '';
      const idx = kv.indexOf('=');
      if (idx > 0) out[kv.slice(0, idx)] = kv.slice(idx + 1);
    }
  }
  return out;
}

if (flag('--crash')) {
  console.error('fake CLI crashed on purpose');
  process.exit(2);
}

const overrides = collectPairs('--override');
if (process.env.YATT_FAKE_CLI_LOG) {
  appendFileSync(process.env.YATT_FAKE_CLI_LOG, JSON.stringify({ argv, overrides }) + '\n');
}

const jsonPath = flag('--json');
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify({
      meta: { title: 'fake' },
      records: [{ index: 1, action: 'goto', status: 'ok', ms: 3 }],
      ok: 1,
      fail: 0,
      skipped: 0,
      stopped: false,
    }),
  );
}
console.log('fake run ok');
process.exit(0);
