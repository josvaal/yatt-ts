/**
 * Ambient declaration for the playwright-core private internals used by the
 * Chromium auto-install path (D12). This module is intentionally untyped
 * upstream (private API): the shape here mirrors only what
 * `engine/browser-install.ts` consumes. Pin the playwright dependency tightly
 * and re-verify this surface on every bump.
 */
declare module 'playwright-core/lib/coreBundle' {
  export const registry: {
    registry: {
      findExecutable: (name: string) => unknown;
      install: (executables: unknown[]) => Promise<void>;
    };
  };
}
