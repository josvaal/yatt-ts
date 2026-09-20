/**
 * Auto-installation of browsers on distributed builds (D12).
 *
 * On a consumer machine the Playwright browsers may not exist yet (they live
 * in the system cache, e.g. ~/.cache/ms-playwright). Before the first
 * `launch` we check the executables and, when one is missing, download it
 * through the same API the Playwright CLI uses.
 *
 * Ported from the base `sidecar/src/browser-install.ts` — including the
 * playwright-core internals (`lib/coreBundle`) and the
 * PLAYWRIGHT_SKIP_BROWSER_GC escape. This touches a private Playwright API:
 * pin the playwright dependency tightly and re-verify on every bump.
 */

import { existsSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';

type ProgressFn = (name: string, data: Record<string, unknown>) => void;

/**
 * Executables required by each engine. The chromium headless launch uses
 * `chromium-headless-shell` (a separate binary from full chromium), so a
 * `open headless:true` needs both downloaded.
 */
const ENGINE_EXECUTABLES: Record<string, Array<() => string>> = {
  // BOUND: storing the reference without `.bind()` loses `this` at call time
  // and playwright throws "Cannot read properties of undefined
  // (reading '_initializer')" → the check always failed → reinstalled forever.
  chromium: [chromium.executablePath.bind(chromium)],
  firefox: [firefox.executablePath.bind(firefox)],
  webkit: [webkit.executablePath.bind(webkit)],
};

/** True when every executable of the given engine is downloaded. */
export function browserInstalled(engine: string): boolean {
  const paths = ENGINE_EXECUTABLES[engine];
  if (!paths) return true; // unknown engine: let playwright fail with its message
  return paths.every((p) => {
    try {
      return existsSync(p());
    } catch (err) {
      // If the internal resolution throws (broken registry in a bundle) it
      // must NOT be silenced: without this log it would reinstall forever.
      console.error(
        `[yatt] browserInstalled(${engine}): executable resolution failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  });
}

/**
 * Guarantees the requested browser is available. Only chromium (the default
 * engine) is auto-installed; other engines throw a clear error.
 */
export async function ensureBrowser(
  engine: string,
  emit: ProgressFn,
  existsFn: (engine: string) => boolean = browserInstalled,
): Promise<void> {
  if (existsFn(engine)) return;
  if (engine !== 'chromium') {
    throw new Error(
      `The engine '${engine}' is not downloaded. Run 'npx playwright install ${engine}' and try again.`,
    );
  }
  emit('browser_install_started', { engine });
  // `registry.install()` is the CLI path (`npx playwright install`):
  // lock + download + marker. `installBrowsersForNpmInstall` instead uses
  // npm's `.links` mechanism: it registers the installer package and, while
  // validating the cache, DELETES as "stale" every browser whose link does
  // not resolve. In a standalone bundle the link points to package paths
  // that do not exist → it deleted and re-downloaded the browser on every run.
  //
  // registry.install() also runs that GC up front; the official escape is
  // PLAYWRIGHT_SKIP_BROWSER_GC. Without it, on a consumer machine the browser
  // was re-downloaded on every restart.
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
  // coreBundle exports the `registry` namespace; the LIVE registry instance
  // (findExecutable/install) lives at `registry.registry`.
  const bundle = (await import('playwright-core/lib/coreBundle')) as unknown as {
    registry: {
      registry: {
        findExecutable: (name: string) => unknown;
        install: (executables: unknown[]) => Promise<void>;
      };
    };
  };
  const registry = bundle.registry.registry;
  const executables = ['chromium', 'chromium-headless-shell']
    .map((name) => registry.findExecutable(name))
    .filter(Boolean);
  if (executables.length === 0) {
    emit('browser_install_failed', { engine, error: 'registry has no chromium executables' });
    throw new Error('The Playwright registry does not expose the chromium browser.');
  }
  try {
    await registry.install(executables);
  } catch (err) {
    emit('browser_install_failed', {
      engine,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      'Chromium could not be downloaded automatically. Check the internet connection and try again.',
    );
  }
  emit('browser_install_finished', { engine });
}
