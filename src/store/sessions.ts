/**
 * Session persistence strategies (D7, C09/C10 groundwork).
 *
 * - `PersistentSessionSink`: current behavior — DB row + `sessions/<name>.json`
 *   mirror written in the same operation (mirror failure fails the op).
 * - `MemorySessionSink`: sessions live in an in-memory map only. Nothing ever
 *   touches the disk (no DB row, no file) and the data dies with the process
 *   when the server shuts down.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import type { ResolvedConfig } from '../config/index.js';
import { mirrorFilePath, Store } from './store.js';

/**
 * Storage boundary for saved browser sessions. Every method is async so both
 * implementations are interchangeable behind `createSessionSink`.
 */
export interface SessionSink {
  /** Saves (or replaces) a storage state under the given name. */
  save(name: string, storageState: string): Promise<void>;
  /** All session names, name-ascending. */
  list(): Promise<string[]>;
  /** Storage state for a name, or `null` when unknown. */
  get(name: string): Promise<string | null>;
  /** Deletes a session (DB row + mirror, or map entry). */
  delete(name: string): Promise<void>;
  /** Resolves once every queued write has finished (no-op for the memory sink). */
  flush(): Promise<void>;
  /**
   * Wipes every held session on server shutdown (F6/D7: memory sessions are
   * 'wiped on close'). The persistent sink is a no-op — persisted data belongs
   * to its DB/mirror owner, not to the process lifecycle.
   */
  clear(): Promise<void>;
}

/** DB + file mirror persistence (current base behavior). */
export class PersistentSessionSink implements SessionSink {
  private readonly store: Store;
  private readonly sessionsDir: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(store: Store, sessionsDir: string) {
    this.store = store;
    this.sessionsDir = sessionsDir;
  }

  private write<T>(fn: () => T | Promise<T>): Promise<T> {
    // The chain flattens returned promises, so the cast below is sound.
    const next = this.writeChain.then(fn) as Promise<T>;
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  save(name: string, storageState: string): Promise<void> {
    return this.write(() => {
      // Sanitized inside the chain so an invalid name rejects the promise
      // instead of throwing synchronously (uniform async contract).
      const safe = Store.sanitizeName(name);
      // DB row and mirror are written inside the same serialized operation;
      // a mirror failure rejects the op (DB stays source of truth, same as
      // the base Store semantics for tests/reports).
      return this.store.upsertSession(safe, storageState).then(() => {
        mkdirSync(this.sessionsDir, { recursive: true });
        writeFileSync(mirrorFilePath(this.sessionsDir, safe, '.json'), storageState, 'utf8');
      });
    });
  }

  async list(): Promise<string[]> {
    return this.store.sessionList();
  }

  async get(name: string): Promise<string | null> {
    return this.store.sessionGet(name);
  }

  delete(name: string): Promise<void> {
    return this.write(() => {
      const safe = Store.sanitizeName(name);
      return this.store.deleteSession(safe).then(() => {
        rmSync(mirrorFilePath(this.sessionsDir, safe, '.json'), { force: true });
      });
    });
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** No-op (F6): persisted sessions survive the process that served them. */
  async clear(): Promise<void> {
    // Intentionally empty — see the interface contract.
  }
}

/** Ephemeral in-memory persistence: usable live, wiped when the process ends (D7). */
export class MemorySessionSink implements SessionSink {
  private readonly sessions = new Map<string, string>();

  async save(name: string, storageState: string): Promise<void> {
    // Same naming rules everywhere; the state itself never leaves the process.
    this.sessions.set(Store.sanitizeName(name), storageState);
  }

  async list(): Promise<string[]> {
    return [...this.sessions.keys()].sort();
  }

  async get(name: string): Promise<string | null> {
    return this.sessions.get(name) ?? null;
  }

  async delete(name: string): Promise<void> {
    this.sessions.delete(name);
  }

  async flush(): Promise<void> {
    // Nothing is ever queued on disk; nothing to drain.
  }

  /** Drops every in-memory session (F6/D7: wiped when the server shuts down). */
  async clear(): Promise<void> {
    this.sessions.clear();
  }
}

/**
 * Builds the session sink for a resolved configuration: `sessions.persist`
 * (default true) keeps the DB + mirror behavior, `persist: false` returns the
 * ephemeral memory sink (D7).
 */
export function createSessionSink(config: ResolvedConfig, store: Store): SessionSink {
  if (config.sessions.persist) {
    return new PersistentSessionSink(store, config.paths.sessions);
  }
  return new MemorySessionSink();
}
