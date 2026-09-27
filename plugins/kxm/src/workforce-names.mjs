/**
 * Workforce id conventions and rename resolution.
 *
 * Role ids are the vocabulary (`planner`, `writer`, `reviewer-arch`,
 * `reviewer-cli`, `experiment`). Agent ids and agent-step ids use that same
 * vocabulary. Route ids are `<harness>-<model-slug>[-<provider>]`, with `.`
 * in the model slug written as `-`. A provider suffix is required when the
 * model id contains `/`.
 *
 * Resolution is bidirectional and only fills a missing side. A commit whose
 * roles and models still use the old ids keeps matching itself, which is what
 * the assignment runner reads at one commit. A tree that has already renamed
 * the files still accepts the old id. A mixed tree accepts either side.
 * `opus-claude` is not renamed: that route pointed at an unadmitted model and
 * was removed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const ROSTER_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const ROLE_IDS = Object.freeze([
  "writer",
  "planner",
  "reviewer-arch",
  "reviewer-cli",
  "experiment",
]);

/** Old id, canonical id. Listed once; lookup tries both directions. */
export const ROUTE_RENAMES = Object.freeze([
  ["grok-native", "grok-grok-4-7"],
  ["qwen-openrouter-pi", "pi-qwen3-coder-plus-openrouter"],
  ["gemini-agy", "agy-gemini-3-8-flash-high"],
  ["fable-claude", "claude-fable"],
  ["sol-codex", "codex-gpt-5-6-sol"],
  ["grok-default", "grok-grok-4-6"],
  ["fable-default", "claude-fable"],
]);

export const AGENT_RENAMES = Object.freeze([
  ["coordinator", "planner"],
  ["implementer", "writer"],
  ["critic-arch", "reviewer-arch"],
  ["critic-cli", "reviewer-cli"],
]);

export const WORKFLOW_RENAMES = Object.freeze([
  ["implement-only", "writer-only"],
  ["review-arch-only", "reviewer-arch-only"],
  ["review-cli-only", "reviewer-cli-only"],
]);

export const STEP_RENAMES = Object.freeze([
  ["implement", "writer"],
  ["critic-arch", "reviewer-arch"],
  ["review-arch", "reviewer-arch"],
  ["critic-cli", "reviewer-cli"],
  ["review-cli", "reviewer-cli"],
]);

const RENAMES = Object.freeze({
  route: ROUTE_RENAMES,
  agent: AGENT_RENAMES,
  workflow: WORKFLOW_RENAMES,
  step: STEP_RENAMES,
});

const RESERVED_WORKFLOW_IDS = new Set(["default", "land"]);
const warned = new Set();

export function noteDeprecatedId(kind, from, to) {
  const key = `${kind}\0${from}\0${to}`;
  if (warned.has(key)) return;
  warned.add(key);
  if (process.env.KXM_QUIET_ALIASES === "1") return;
  console.warn(`kxm: deprecated ${kind} id '${from}' resolves to '${to}'`);
}

export function resetDeprecatedIdWarnings() {
  warned.clear();
}

export function resolveRenamedId(requested, knownIds, pairs) {
  if (typeof requested !== "string" || knownIds.has(requested)) return requested;
  for (const [oldId, newId] of pairs) {
    if (requested === oldId && knownIds.has(newId)) return newId;
    if (requested === newId && knownIds.has(oldId)) return oldId;
  }
  return requested;
}

export function canonicalRouteId(harness, model) {
  if (typeof harness !== "string" || typeof model !== "string" || !harness || !model) return undefined;
  const parts = model.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  const slug = parts[parts.length - 1].replaceAll(".", "-").toLowerCase();
  const provider = parts.length > 1 ? parts[0].replaceAll(".", "-").toLowerCase() : undefined;
  const id = provider ? `${harness}-${slug}-${provider}` : `${harness}-${slug}`;
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id) && id.length <= 64 ? id : undefined;
}

function aliasList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * @param {Iterable<{ id?: string, aliases?: readonly string[] }>} records
 * @param {string} requested
 * @param {"route"|"agent"|"workflow"|"step"} kind
 */
export function lookupById(records, requested, kind) {
  const list = [...records].filter((record) => typeof record?.id === "string" && record.id.length > 0);
  const known = new Set(list.map((record) => record.id));
  const direct = list.find((record) => record.id === requested);
  if (direct) return { record: direct, viaAlias: false };
  for (const record of list) {
    if (aliasList(record.aliases).includes(requested)) {
      noteDeprecatedId(kind, requested, record.id);
      return { record, viaAlias: true };
    }
  }
  const renamed = resolveRenamedId(requested, known, RENAMES[kind] ?? []);
  if (renamed !== requested) {
    const record = list.find((item) => item.id === renamed);
    if (record) {
      noteDeprecatedId(kind, requested, renamed);
      return { record, viaAlias: true };
    }
  }
  return undefined;
}

export function findYamlBasename(directory, requested, kind) {
  if (typeof requested !== "string" || !requested) return undefined;
  if (existsSync(join(directory, `${requested}.yaml`))) return requested;
  if (!existsSync(directory)) return undefined;
  const found = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".yaml") || name === "inventory.yaml") continue;
    const id = name.slice(0, -5);
    let doc;
    try {
      doc = YAML.parse(readFileSync(join(directory, name), "utf8"));
    } catch {
      continue;
    }
    const aliases = doc && typeof doc === "object" ? aliasList(doc.aliases) : [];
    found.push({ id, aliases });
  }
  const hit = lookupById(found, requested, kind);
  return hit?.record.id;
}

function readYamlDir(directory, skipInventory) {
  if (!existsSync(directory)) return [];
  const docs = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".yaml")) continue;
    const id = name.slice(0, -5);
    if (skipInventory && id === "inventory") continue;
    let doc;
    try {
      doc = YAML.parse(readFileSync(join(directory, name), "utf8"));
    } catch (error) {
      docs.push({ id, file: `${directory}/${name}`, error: error instanceof Error ? error.message : "invalid YAML" });
      continue;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      docs.push({ id, file: `${directory}/${name}`, error: "root must be a mapping" });
      continue;
    }
    docs.push({ id, file: name, doc });
  }
  return docs;
}

function push(bucket, severity, code, file, message) {
  bucket.push({ severity, code, file, message });
}

function selectorsFor(doc) {
  const model = typeof doc.model === "string" ? doc.model : "";
  const vendor = typeof doc.vendor === "string" ? doc.vendor : "";
  const harness = typeof doc.harness === "string" ? doc.harness : "";
  return [model, vendor && model ? `${vendor}/${model}` : "", harness && model ? `${harness}/${model}` : ""].filter(Boolean);
}

/**
 * Lint one project's `.kxm` workforce. Errors fail CI. An admitted model with
 * no route is a warning. Alias declarations are not uses; a roster or step
 * that still cites an old id is a `deprecated_id` warning.
 */
export function lintWorkforce(root) {
  const errors = [];
  const warnings = [];
  const models = readYamlDir(join(root, ".kxm", "models"), true).filter((entry) => !entry.error);
  for (const entry of readYamlDir(join(root, ".kxm", "models"), true)) {
    if (entry.error) push(errors, "error", "invalid_yaml", `.kxm/models/${entry.id}.yaml`, entry.error);
  }
  const roles = readYamlDir(join(root, ".kxm", "roles"), false).filter((entry) => !entry.error);
  const agents = readYamlDir(join(root, ".kxm", "agents"), false).filter((entry) => !entry.error);
  const workflows = readYamlDir(join(root, ".kxm", "workflows"), false).filter((entry) => !entry.error);
  let admitted = [];
  const routesFile = join(root, ".kxm", "routes.yaml");
  if (existsSync(routesFile)) {
    try {
      const policy = YAML.parse(readFileSync(routesFile, "utf8"));
      admitted = Array.isArray(policy?.admitted) ? policy.admitted.filter((item) => typeof item === "string") : [];
    } catch (error) {
      push(errors, "error", "invalid_yaml", ".kxm/routes.yaml", error instanceof Error ? error.message : "invalid YAML");
    }
  }

  const modelRecords = models.map((entry) => ({ id: entry.id, aliases: aliasList(entry.doc.aliases), entry }));
  const used = new Set();
  for (const role of roles) {
    const purpose = role.doc.purpose;
    if (typeof purpose === "string" && role.id !== purpose) {
      push(errors, "error", "role_id_convention", `.kxm/roles/${role.id}.yaml`, `role id '${role.id}' must equal purpose '${purpose}'`);
    }
    const roster = Array.isArray(role.doc.roster) ? role.doc.roster : [];
    for (const item of roster) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const route = item.route;
      const effort = item.effort;
      const routeLabel = typeof route === "string" && route ? route : "(missing route)";
      if (typeof effort !== "string" || !ROSTER_EFFORTS.has(effort)) {
        const detail = typeof effort === "string"
          ? `effort '${effort}' is not one of off, minimal, low, medium, high, xhigh, max`
          : "has no effort";
        push(errors, "error", "roster_effort_required", `.kxm/roles/${role.id}.yaml`, `roster route '${routeLabel}' ${detail}`);
      }
      if (typeof route !== "string" || !route) continue;
      const found = lookupById(modelRecords, route, "route");
      if (!found) {
        push(errors, "error", "route_unknown", `.kxm/roles/${role.id}.yaml`, `roster route '${route}' does not match a model file`);
        continue;
      }
      used.add(found.record.id);
      if (found.viaAlias) {
        push(warnings, "warning", "deprecated_id", `.kxm/roles/${role.id}.yaml`, `roster route '${route}' is a deprecated alias of '${found.record.id}'`);
      }
    }
  }

  const covered = new Set();
  for (const model of models) {
    const doc = model.doc;
    if (typeof doc.id === "string" && doc.id !== model.id) {
      push(errors, "error", "route_id_convention", `.kxm/models/${model.id}.yaml`, `declared id '${doc.id}' does not match the filename`);
    }
    const expected = canonicalRouteId(doc.harness, doc.model);
    if (!expected || model.id !== expected) {
      push(errors, "error", "route_id_convention", `.kxm/models/${model.id}.yaml`, `route id '${model.id}' must be '${expected ?? "<harness>-<model-slug>[-<provider>]"}'`);
    }
    if (!used.has(model.id)) {
      push(errors, "error", "route_unused", `.kxm/models/${model.id}.yaml`, `route '${model.id}' is not on any role roster`);
    }
    const selectorHit = selectorsFor(doc).find((selector) => admitted.includes(selector));
    if (!selectorHit) {
      push(errors, "error", "route_not_admitted", `.kxm/models/${model.id}.yaml`, `model '${doc.model ?? ""}' is not an admitted selector`);
    } else {
      covered.add(selectorHit);
    }
  }
  for (const selector of admitted) {
    if (!covered.has(selector)) {
      push(warnings, "warning", "admitted_unrouted", ".kxm/routes.yaml", `admitted model '${selector}' is not used by any route`);
    }
  }

  const agentRecords = agents.map((entry) => ({ id: entry.id, aliases: aliasList(entry.doc.aliases), entry }));
  for (const agent of agents) {
    const role = agent.doc.role;
    if (typeof role !== "string" || agent.id !== role) {
      push(errors, "error", "agent_id_convention", `.kxm/agents/${agent.id}.yaml`, `agent id '${agent.id}' must equal its role '${role ?? ""}'`);
    }
  }
  for (const workflow of workflows) {
    if (!RESERVED_WORKFLOW_IDS.has(workflow.id) && !ROLE_IDS.some((role) => workflow.id === `${role}-only`)) {
      push(errors, "error", "workflow_id_convention", `.kxm/workflows/${workflow.id}.yaml`, `workflow id '${workflow.id}' must be default, land, or <role>-only`);
    }
    const steps = Array.isArray(workflow.doc.steps) ? workflow.doc.steps : [];
    const realIds = new Set(steps.map((step) => step && typeof step.id === "string" ? step.id : "").filter(Boolean));
    for (const step of steps) {
      if (!step || typeof step !== "object" || typeof step.id !== "string") continue;
      if (step.kind === "agent" || step.kind === "moa") {
        const agentName = typeof step.agent === "string" ? step.agent : "";
        const found = agentName ? lookupById(agentRecords, agentName, "agent") : undefined;
        if (!found) {
          push(errors, "error", "agent_unknown", `.kxm/workflows/${workflow.id}.yaml`, `step '${step.id}' references unknown agent '${agentName}'`);
        } else if (found.viaAlias) {
          push(warnings, "warning", "deprecated_id", `.kxm/workflows/${workflow.id}.yaml`, `step '${step.id}' agent '${agentName}' is a deprecated alias of '${found.record.id}'`);
        }
        const role = found?.record.entry.doc.role;
        if (typeof role === "string" && step.id !== role) {
          push(errors, "error", "step_id_convention", `.kxm/workflows/${workflow.id}.yaml`, `agent step '${step.id}' must use the role id '${role}'`);
        }
      } else if (step.kind === "gate") {
        const gate = typeof step.gate === "string" ? step.gate : "";
        const allowed = step.id === "verify" || step.id === gate || step.id.startsWith(`${workflow.id}-`);
        if (!allowed) {
          push(errors, "error", "step_id_convention", `.kxm/workflows/${workflow.id}.yaml`, `gate step '${step.id}' must be verify, the gate id, or ${workflow.id}-<name>`);
        }
      }
      for (const alias of aliasList(step.aliases)) {
        if (realIds.has(alias) && alias !== step.id) {
          push(errors, "error", "step_id_convention", `.kxm/workflows/${workflow.id}.yaml`, `step alias '${alias}' collides with another step id`);
        }
      }
    }
  }
  return { errors, warnings };
}
