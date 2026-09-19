/**
 * Public entry point of the yatt-ts library.
 */

/** Semantic version of the yatt-ts package. */
export const VERSION = '0.1.0';

export interface CreateYattServerOptions {
  /** Raw user configuration; validated and resolved before the server boots. */
  config?: unknown;
}

/**
 * Creates a fully configured YATT MCP server (stdio by default, optional HTTP).
 *
 * Placeholder stub — real implementation lands with the MCP bootstrap task (T5).
 */
export function createYattServer(_options?: CreateYattServerOptions): never {
  void _options;
  throw new Error('not implemented');
}
