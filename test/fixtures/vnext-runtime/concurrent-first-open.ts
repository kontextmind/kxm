import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VnextRunEventStore, VnextRuntimeRegistry } from "../../../plugins/kxm/src/vnext-runtime-store.ts";

const [kind, databasePath, barrierDir, participant] = process.argv.slice(2);
if ((kind !== "registry" && kind !== "events") || !databasePath || !barrierDir || !participant) {
  throw new Error("expected store kind, database path, barrier directory and participant");
}

// Pause both processes just before their first write lock. The old initializer
// has already inspected version 0 here; the fixed initializer has not read it.
const exec = DatabaseSync.prototype.exec;
let arrived = false;
DatabaseSync.prototype.exec = function (sql: string): void {
  if (!arrived && sql === "BEGIN IMMEDIATE") {
    arrived = true;
    writeFileSync(join(barrierDir, `arrived-${participant}`), "ready");
    const deadline = Date.now() + 10_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(join(barrierDir, "release"))) {
      if (Date.now() >= deadline) process.exit(72);
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  exec.call(this, sql);
};

const store = kind === "registry"
  ? new VnextRuntimeRegistry(databasePath)
  : new VnextRunEventStore(databasePath);
store.close();
