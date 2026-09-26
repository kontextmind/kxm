import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { assembleRosterPolicy } from "../../scripts/roster-policy.mjs";

function docs(dir: string, skipInventory: boolean) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") && !(skipInventory && name === "inventory.yaml"))
    .map((name) => parse(readFileSync(join(dir, name), "utf8")));
}

export const ADMITTED_ROSTER_POLICY = Object.freeze(
  assembleRosterPolicy(docs(".kxm/models", true), docs(".kxm/roles", false)),
);

export function withRosterPolicy<T extends object>(deps: T = {} as T): T {
  const record = deps as T & { loadTrustedRosterPolicy?: unknown };
  if (Object.hasOwn(deps, "rosterPolicy") || typeof record.loadTrustedRosterPolicy === "function") {
    return deps;
  }
  return { ...deps, rosterPolicy: ADMITTED_ROSTER_POLICY };
}
