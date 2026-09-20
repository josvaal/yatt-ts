/**
 * Build post-step: marks the compiled bin (dist/cli.js) as executable so
 * `./dist/cli.js` works directly (npm also runs this semantic when packing:
 * the `bin` entry gets the exec bit on install).
 *
 * The TypeScript compiler preserves the `#!` shebang line but does NOT carry
 * the source file's permission bits over to the emitted output, so the bit
 * is restored explicitly after every build.
 */
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(pkgRoot, 'dist', 'cli.js');

if (!existsSync(bin)) {
  console.error(`make-bin-executable: ${bin} not found — did "tsc -p tsconfig.json" run?`);
  process.exit(1);
}
chmodSync(bin, 0o755);
