/**
 * Vitest guard for the packaging proof (T13): runs the plain-node script
 * `test/e2e/install.mjs` (npm pack → fresh consumer installs → ping) and
 * fails when it exits non-zero. Guarded by YATT_TS_E2E=1 like the other
 * e2e smokes because it performs real npm/bun installs and takes minutes:
 *
 *   npm run build && YATT_TS_E2E=1 npx vitest run test/e2e
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2e = process.env.YATT_TS_E2E === '1' ? describe : describe.skip;
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'install.mjs');

e2e('packaging install proof (T13)', () => {
  it(
    'npm pack ships the right files and fresh node/bun consumers boot the package',
    () => {
      const res = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
      // Stream the proof's own ok/FAIL log into the vitest output.
      process.stdout.write(res.stdout ?? '');
      if (res.stderr) process.stderr.write(res.stderr);
      expect(res.status).toBe(0);
    },
    900_000,
  );
});
