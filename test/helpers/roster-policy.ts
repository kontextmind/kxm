import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ADMITTED_ROSTER_POLICY = Object.freeze(
  JSON.parse(readFileSync(join(process.cwd(), ".kxm/roster.json"), "utf8")),
);

export function withRosterPolicy<T extends object>(deps: T = {} as T): T {
  const record = deps as T & { loadTrustedRosterPolicy?: unknown };
  if (Object.hasOwn(deps, "rosterPolicy") || typeof record.loadTrustedRosterPolicy === "function") {
    return deps;
  }
  return { ...deps, rosterPolicy: ADMITTED_ROSTER_POLICY };
}
