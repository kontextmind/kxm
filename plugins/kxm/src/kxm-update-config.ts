import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  KXM_UPDATE_SCHEMA,
  KxmUpdateConfigError,
  type KxmUpdateConfig,
} from "./kxm-update.ts";

export function loadKxmUpdateConfig(projectRoot: string): KxmUpdateConfig {
  const path = join(projectRoot, ".kxm", "update.yaml");
  if (!existsSync(path)) return { schema: KXM_UPDATE_SCHEMA, auto: false, source: "github" };
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    throw new KxmUpdateConfigError(".kxm/update.yaml is not valid YAML");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KxmUpdateConfigError(".kxm/update.yaml must be a mapping");
  }
  const row = parsed as Record<string, unknown>;
  const allowed = new Set(["schema", "auto", "source"]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw new KxmUpdateConfigError(`.kxm/update.yaml unknown field ${key}`);
  }
  if (row.schema !== KXM_UPDATE_SCHEMA) {
    throw new KxmUpdateConfigError(".kxm/update.yaml schema must be kxm.update.v1");
  }
  if (typeof row.auto !== "boolean") {
    throw new KxmUpdateConfigError(".kxm/update.yaml auto must be a boolean");
  }
  const source = row.source === undefined ? "github" : row.source;
  if (source !== "npm" && source !== "github") {
    throw new KxmUpdateConfigError(".kxm/update.yaml source must be npm or github");
  }
  return { schema: KXM_UPDATE_SCHEMA, auto: row.auto, source };
}
