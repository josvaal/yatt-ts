/**
 * Minimal contract of the engine (sidecar) client used by the MCP surface
 * today. The real client (JSON-RPC over stdio with lifecycle management)
 * lands with the engine task (T7); until then the server runs with
 * `sidecar: null` and the tools that need the engine degrade gracefully.
 */
export interface SidecarEvent {
  name: string;
  data: unknown;
}

export interface SidecarClient {
  /** JSON-RPC request; rejects on timeout or transport failure. */
  req<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  /** Closes the engine process (graceful, with kill fallback). */
  close(): Promise<void>;
  /** Subscribes to engine events (browser_status, tabs_changed, log, …). */
  onEvent(listener: (event: SidecarEvent) => void): void;
}
