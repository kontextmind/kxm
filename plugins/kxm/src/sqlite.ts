/** Runtime-portable SQLite constructor.
 *
 * Prefers Node's built-in `node:sqlite` (the supported runtime for the kxm
 * CLI). Pi loads extensions inside its embedded Bun runtime, which does not
 * provide `node:sqlite`, so fall back to Bun's `bun:sqlite` there.
 *
 * The two runtimes differ in one option this codebase uses: Node spells the
 * flag `readOnly`, Bun spells it `readonly`. Options are normalized here so
 * callers keep using the Node spelling everywhere.
 */
import { createRequire } from "node:module";

export interface DatabaseSyncOptions {
  readOnly?: boolean;
  [key: string]: unknown;
}

export interface StatementSync {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

type NativeDatabase = {
  prepare(sql: string): StatementSync;
  exec(sql: string): unknown;
  close(): void;
};

const requireFromHere = createRequire(import.meta.url);

function loadNative(): { Ctor: new (path: string, options?: object) => NativeDatabase; bun: boolean } {
  try {
    const mod = requireFromHere("node:sqlite") as { DatabaseSync?: new (path: string, options?: object) => NativeDatabase };
    if (mod.DatabaseSync) return { Ctor: mod.DatabaseSync, bun: false };
  } catch {
    // Not a Node runtime exposing node:sqlite (e.g. pi's embedded Bun).
  }
  try {
    const mod = requireFromHere("bun:sqlite") as
      | { DatabaseSync?: new (path: string, options?: object) => NativeDatabase; Database?: new (path: string, options?: object) => NativeDatabase }
      | undefined;
    const Ctor = mod?.DatabaseSync ?? mod?.Database;
    if (Ctor) return { Ctor, bun: true };
  } catch {
    // No bun:sqlite either.
  }
  throw new Error("kxm: no supported sqlite module found (need node:sqlite or bun:sqlite)");
}

const native = loadNative();

export class DatabaseSync {
  private readonly inner: NativeDatabase;

  constructor(path: string, options?: DatabaseSyncOptions) {
    let normalized: object | undefined = options;
    if (native.bun && options) {
      const { readOnly, ...rest } = options;
      normalized = readOnly === undefined ? rest : { ...rest, readonly: readOnly };
    }
    this.inner = normalized === undefined ? new native.Ctor(path) : new native.Ctor(path, normalized);
  }

  prepare(sql: string): StatementSync {
    return this.inner.prepare(sql);
  }

  exec(sql: string): unknown {
    return this.inner.exec(sql);
  }

  close(): void {
    this.inner.close();
  }
}
