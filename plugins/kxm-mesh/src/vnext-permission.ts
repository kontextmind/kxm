import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  VnextConfigError,
  loadVnextProject,
  parseRestrictedYaml,
  vnextCanonicalJson,
  vnextPortablePath,
  vnextResourceIdentifier,
  type JsonObject,
  type JsonValue,
  type VnextConfigIssue,
  type VnextConfigOptions,
  type VnextProjectBundle,
  type VnextResource,
  type VnextResourceKind,
} from "./vnext-config.ts";

/* ------------------------------------------------------------------ *
 * Structured authority projections
 * ------------------------------------------------------------------ */

export type VnextPermissionField =
  | "repository-access"
  | "tools"
  | "secrets"
  | "executor"
  | "network"
  | "model"
  | "sync-policy"
  | "snapshot-policy"
  | "evidence-quorum"
  | "transition"
  | "budget"
  | "resource-shape"
  | "environment"
  | "gate"
  | "delivery";

export type VnextPermissionDirection = "expansion" | "narrowing" | "neutral";

export interface VnextAuthorityEntry {
  /** Resource-relative pointer, e.g. /repositories/api or /steps/3/tools/preset. */
  path: string;
  field: VnextPermissionField;
  /** Canonical JSON of the comparable value (never secret material). */
  value: string;
}

const PROSE_FIELDS: Readonly<Record<VnextResourceKind, ReadonlySet<string>>> = {
  project: new Set(["name", "description"]),
  repository: new Set(["description"]),
  agent: new Set(["purpose", "instructions"]),
  model: new Set([]),
  environment: new Set([]),
  workflow: new Set(["description"]),
};

const ACCESS_RANK: Readonly<Record<string, number>> = { none: 0, read: 1, write: 2 };
const NETWORK_RANK: Readonly<Record<string, number>> = { none: 0, "provider-only": 1, restricted: 2, host: 3 };
const UNTRACKED_RANK: Readonly<Record<string, number>> = { "tracked-only": 0, ask: 1, bounded: 2 };

function canonical(value: JsonValue | undefined): string {
  return vnextCanonicalJson(value === undefined ? null : value);
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function valuesOf(value: JsonObject, key: string): JsonValue[] {
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate : [];
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pointerEscape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function secretGrantKeys(grants: JsonValue[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const grant of grants) {
    const ref = stringValue(asObject(grant)?.ref);
    if (ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  const keys = new Map<number, string>();
  for (const [index, grant] of grants.entries()) {
    const ref = stringValue(asObject(grant)?.ref);
    keys.set(index, ref && counts.get(ref) === 1 ? `by-ref/${pointerEscape(ref)}` : String(index));
  }
  return keys;
}

/** Extract the authority-bearing fields of one resource as comparable entries. */
export function vnextAuthorityEntries(resource: { kind: VnextResourceKind; id?: string; value: JsonObject }): VnextAuthorityEntry[] {
  const entries: VnextAuthorityEntry[] = [];
  const push = (path: string, field: VnextPermissionField, value: JsonValue | undefined): void => {
    entries.push({ path, field, value: canonical(value) });
  };
  const value = resource.value;

  switch (resource.kind) {
    case "project": {
      push("/id", "resource-shape", value.id);
      push("/defaultWorkflow", "delivery", value.defaultWorkflow);
      push("/defaultExecutor", "executor", value.defaultExecutor);
      const declarations = valuesOf(value, "repositories");
      const declarationIds = new Map<string, number>();
      for (const entry of declarations) {
        const id = stringValue(asObject(entry)?.id);
        if (id) declarationIds.set(id, (declarationIds.get(id) ?? 0) + 1);
      }
      for (const [index, repository] of declarations.entries()) {
        const entry = asObject(repository);
        if (!entry) continue;
        const id = stringValue(entry.id);
        const key = id && declarationIds.get(id) === 1 ? `by-id/${pointerEscape(id)}` : String(index);
        push(`/repositories/${key}`, "resource-shape", entry);
      }
      const workspace = asObject(value.workspace);
      if (workspace) push("/workspace", "snapshot-policy", workspace);
      const sync = asObject(value.sync);
      if (sync) push("/sync", "sync-policy", sync);
      const limits = asObject(value.limits);
      if (limits) push("/limits", "budget", limits);
      break;
    }
    case "repository": {
      push("/projectId", "resource-shape", value.projectId);
      push("/repositoryId", "resource-shape", value.repositoryId);
      push("/defaultAccess", "repository-access", value.defaultAccess);
      push("/ecosystems", "resource-shape", value.ecosystems);
      push("/classification", "resource-shape", value.classification);
      break;
    }
    case "agent": {
      push("/model", "model", value.model);
      push("/executor", "executor", value.executor);
      push("/tools", "tools", value.tools);
      push("/defaultRepositoryAccess", "repository-access", value.defaultRepositoryAccess);
      const repositories = asObject(value.repositories);
      for (const repositoryId of Object.keys(repositories ?? {}).sort()) {
        push(`/repositories/${pointerEscape(repositoryId)}`, "repository-access", repositories?.[repositoryId]);
      }
      const secretKeys = secretGrantKeys(valuesOf(value, "secrets"));
      for (const [index, grant] of valuesOf(value, "secrets").entries()) {
        push(`/secrets/${secretKeys.get(index)}`, "secrets", grant);
      }
      push("/network", "network", value.network);
      push("/resultSchema", "delivery", value.resultSchema);
      const session = asObject(value.session);
      if (session) push("/session", "resource-shape", session);
      break;
    }
    case "model": {
      push("/provider", "model", value.provider);
      push("/model", "model", value.model);
      push("/thinking", "model", value.thinking);
      // Tags drive selector resolution; retagging retargets consumers.
      push("/tags", "model", value.tags);
      push("/capabilities", "model", value.capabilities);
      push("/priority", "model", value.priority);
      push("/fallbacks", "model", value.fallbacks);
      const limits = asObject(value.limits);
      if (limits) push("/limits", "budget", limits);
      break;
    }
    case "environment": {
      push("/path", "environment", value.path);
      const envValues = asObject(value.values);
      for (const key of Object.keys(envValues ?? {}).sort()) {
        const entry = asObject(envValues?.[key]) as JsonObject | undefined;
        // Never compare or store secret values: hash only the reference shape.
        const projected: JsonValue | undefined = entry
          ? ({ ...entry, value: entry.value === undefined ? undefined : "<redacted>" } as JsonObject)
          : (envValues?.[key] as JsonValue | undefined);
        push(`/values/${pointerEscape(key)}`, "environment", projected);
      }
      const envSecretKeys = secretGrantKeys(valuesOf(value, "secrets"));
      for (const [index, grant] of valuesOf(value, "secrets").entries()) {
        push(`/secrets/${envSecretKeys.get(index)}`, "secrets", grant);
      }
      break;
    }
    case "workflow": {
      push("/coordinator", "resource-shape", value.coordinator);
      const limits = asObject(value.limits);
      if (limits) push("/limits", "budget", limits);
      if (value.reproOracle !== undefined) push("/reproOracle", "evidence-quorum", value.reproOracle);
      if (value.planHash !== undefined) push("/planHash", "evidence-quorum", value.planHash);
      if (value.requirePlanHash !== undefined) push("/requirePlanHash", "evidence-quorum", value.requirePlanHash);
      for (const [index, stepEntry] of valuesOf(value, "steps").entries()) {
        const step = asObject(stepEntry);
        if (!step) continue;
        const stepPath = `/steps/${index}`;
        push(`${stepPath}/id`, "resource-shape", step.id);
        push(`${stepPath}/kind`, "resource-shape", step.kind);
        push(`${stepPath}/agent`, "resource-shape", step.agent);
        push(`${stepPath}/gate`, "gate", step.gate);
        push(`${stepPath}/signal`, "delivery", step.signal);
        push(`${stepPath}/model`, "model", step.model);
        push(`${stepPath}/maxAttempts`, "budget", step.maxAttempts);
        push(`${stepPath}/timeoutMs`, "budget", step.timeoutMs);
        const repositories = asObject(step.repositories);
        for (const repositoryId of Object.keys(repositories ?? {}).sort()) {
          push(`${stepPath}/repositories/${pointerEscape(repositoryId)}`, "repository-access", repositories?.[repositoryId]);
        }
        push(`${stepPath}/tools`, "tools", step.tools);
        const stepSecretKeys = secretGrantKeys(valuesOf(step, "secrets"));
        for (const [grantIndex, grant] of valuesOf(step, "secrets").entries()) {
          push(`${stepPath}/secrets/${stepSecretKeys.get(grantIndex)}`, "secrets", grant);
        }
        push(`${stepPath}/assignments`, "resource-shape", step.assignments);
        push(`${stepPath}/join`, "evidence-quorum", step.join);
        const evidence = valuesOf(step, "requiredEvidence");
        for (const [evidenceIndex, evidenceEntry] of evidence.entries()) {
          push(`${stepPath}/requiredEvidence/${evidenceIndex}`, "evidence-quorum", evidenceEntry);
        }
        push(`${stepPath}/safeSpeculation`, "resource-shape", step.safeSpeculation);
        push(`${stepPath}/on`, "transition", step.on);
      }
      break;
    }
  }
  return entries;
}

/** Prose/non-authority fields, surfaced separately so reviewers see them as neutral. */
export function vnextProseEntries(resource: { kind: VnextResourceKind; value: JsonObject }): Map<string, string> {
  const entries = new Map<string, string>();
  for (const field of PROSE_FIELDS[resource.kind]) {
    if (resource.value[field] !== undefined) entries.set(`/${field}`, canonical(resource.value[field]));
  }
  if (resource.kind === "workflow") {
    for (const [index, stepEntry] of valuesOf(resource.value, "steps").entries()) {
      const step = asObject(stepEntry);
      if (!step) continue;
      for (const field of ["description", "instructions"] as const) {
        if (step[field] !== undefined) entries.set(`/steps/${index}/${field}`, canonical(step[field]));
      }
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Diff
 * ------------------------------------------------------------------ */

export interface VnextPermissionChange {
  resource: string;
  path: string;
  field: VnextPermissionField;
  direction: VnextPermissionDirection;
  summary: string;
  baseValueSha256?: string;
  candidateValueSha256?: string;
}

export interface VnextPermissionDiff {
  schema: "kxm.permission-diff.v1";
  baseRevision: string;
  candidateRevision: string;
  changes: VnextPermissionChange[];
  expansions: VnextPermissionChange[];
  narrowings: VnextPermissionChange[];
  neutralChanges: VnextPermissionChange[];
  requiresReview: boolean;
}

function valueHash(canonicalValue: string): string {
  return `sha256:${createHash("sha256").update(canonicalValue, "utf8").digest("hex")}`;
}

function rankDirection(rank: Readonly<Record<string, number>>, baseValue: string, candidateValue: string): VnextPermissionDirection {
  const base = JSON.parse(baseValue) as unknown;
  const candidate = JSON.parse(candidateValue) as unknown;
  const baseRank = typeof base === "string" && base in rank ? rank[base] as number : undefined;
  const candidateRank = typeof candidate === "string" && candidate in rank ? rank[candidate] as number : undefined;
  if (baseRank === undefined || candidateRank === undefined) return "expansion";
  if (candidateRank > baseRank) return "expansion";
  if (candidateRank < baseRank) return "narrowing";
  return "neutral";
}

/** Direction for a numeric bound: raising limits is expansion. */
function numericBoundDirection(baseValue: string, candidateValue: string): VnextPermissionDirection {
  const base = JSON.parse(baseValue) as unknown;
  const candidate = JSON.parse(candidateValue) as unknown;
  if (typeof base !== "number" || typeof candidate !== "number") return "expansion";
  if (candidate > base) return "expansion";
  if (candidate < base) return "narrowing";
  return "neutral";
}

function budgetDirection(baseValue: string, candidateValue: string): VnextPermissionDirection {
  const base = asObject(JSON.parse(baseValue) as JsonValue);
  const candidate = asObject(JSON.parse(candidateValue) as JsonValue);
  if (!base || !candidate) return "expansion";
  let sawExpansion = false;
  let sawNarrowing = false;
  for (const key of new Set([...Object.keys(base), ...Object.keys(candidate)])) {
    const direction = numericBoundDirection(canonical(base[key] as JsonValue | undefined), canonical(candidate[key] as JsonValue | undefined));
    if (direction === "expansion") sawExpansion = true;
    if (direction === "narrowing") sawNarrowing = true;
  }
  // Mixed directions cannot be ordered conservatively.
  if (sawExpansion) return "expansion";
  return sawNarrowing ? "narrowing" : "neutral";
}

function quorumDirection(baseValue: string, candidateValue: string): VnextPermissionDirection {
  const base = asObject(JSON.parse(baseValue) as JsonValue);
  const candidate = asObject(JSON.parse(candidateValue) as JsonValue);
  if (!base || !candidate) return "expansion";
  // Join policies, oracles, and plan-hash retargets have no conservative
  // order: any change can weaken the quorum path.
  if (base.strategy !== undefined || candidate.strategy !== undefined) return "expansion";
  if (base.stageId !== undefined || candidate.stageId !== undefined) return "expansion";
  // Evidence requirement entries: key/kind must match for an ordered compare.
  if (base.key === undefined || candidate.key === undefined || base.key !== candidate.key || base.kind !== candidate.kind) return "expansion";
  const baseRequirementMinimum = typeof base.minimum === "number" ? base.minimum : 1;
  const candidateRequirementMinimum = typeof candidate.minimum === "number" ? candidate.minimum : 1;
  if (candidateRequirementMinimum < baseRequirementMinimum) return "expansion";
  // A narrowing observed so far must never short-circuit the remaining
  // quorum checks: a later expansion always wins the report.
  let sawNarrowing = candidateRequirementMinimum > baseRequirementMinimum;
  if (base.reusableAcrossAttempts === true && (candidate.reusableAcrossAttempts ?? false) === false) sawNarrowing = true;
  if ((base.reusableAcrossAttempts ?? false) === false && candidate.reusableAcrossAttempts === true) return "expansion";
  const CLASSIFIED = new Set(["key", "kind", "minimum", "reusableAcrossAttempts", "strategy", "stageId", "evidenceKey"]);
  const CLASSIFIED_POLICY = new Set(["minimumProducers", "eligibleAgents", "degradation"]);
  const residualOf = (value: string): JsonValue => {
    const parsed = asObject(JSON.parse(value) as JsonValue);
    if (!parsed) return null;
    const residual: JsonObject = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (CLASSIFIED.has(key)) continue;
      if (key === "producerPolicy") {
        const policy = asObject(entry);
        if (!policy) {
          residual[key] = entry;
          continue;
        }
        residual[key] = Object.fromEntries(Object.entries(policy).filter(([policyKey]) => !CLASSIFIED_POLICY.has(policyKey)));
        continue;
      }
      residual[key] = entry;
    }
    return residual;
  };
  // Residual fail-closed check runs BEFORE any narrowing return: unknown or
  // future fields always expand, even alongside an ordered narrowing.
  if (vnextCanonicalJson(residualOf(baseValue)) !== vnextCanonicalJson(residualOf(candidateValue))) return "expansion";
  const basePolicy = asObject(base.producerPolicy as JsonValue | undefined);
  const candidatePolicy = asObject(candidate.producerPolicy as JsonValue | undefined);
  if (!basePolicy && !candidatePolicy) return sawNarrowing ? "narrowing" : "neutral";
  if (!basePolicy || !candidatePolicy) return "expansion";
  const basePolicyMinimum = typeof basePolicy.minimumProducers === "number" ? basePolicy.minimumProducers : 1;
  const candidatePolicyMinimum = typeof candidatePolicy.minimumProducers === "number" ? candidatePolicy.minimumProducers : 1;
  if (candidatePolicyMinimum < basePolicyMinimum) return "expansion"; // weaker quorum
  const baseEligible = new Set((Array.isArray(basePolicy.eligibleAgents) ? basePolicy.eligibleAgents : []).map(String));
  const candidateEligible = new Set((Array.isArray(candidatePolicy.eligibleAgents) ? candidatePolicy.eligibleAgents : []).map(String));
  for (const agent of baseEligible) if (!candidateEligible.has(agent)) return "expansion"; // producer removed
  const baseDegradation = asObject(basePolicy.degradation as JsonValue | undefined);
  const candidateDegradation = asObject(candidatePolicy.degradation as JsonValue | undefined);
  if (!baseDegradation && candidateDegradation) return "expansion"; // degradation introduced
  if (baseDegradation && candidateDegradation) {
    const baseFloor = typeof baseDegradation.minimumProducers === "number" ? baseDegradation.minimumProducers : 1;
    const candidateFloor = typeof candidateDegradation.minimumProducers === "number" ? candidateDegradation.minimumProducers : 1;
    if (candidateFloor < baseFloor) return "expansion";
  }
  if (candidatePolicyMinimum > basePolicyMinimum) return "narrowing";
  for (const agent of candidateEligible) if (!baseEligible.has(agent)) {
    // A new producer enlarges the set of passing combinations at the same
    // floor (a+c and b+c now pass where only a+b did): quorum weakening.
    return "expansion";
  }
  return sawNarrowing ? "narrowing" : "neutral";
}

function snapshotDirection(baseValue: string, candidateValue: string): VnextPermissionDirection {
  const base = asObject(JSON.parse(baseValue) as JsonValue);
  const candidate = asObject(JSON.parse(candidateValue) as JsonValue);
  if (!base || !candidate) return "expansion";
  const baseSnapshot = asObject(base.dirtySnapshot as JsonValue | undefined);
  const candidateSnapshot = asObject(candidate.dirtySnapshot as JsonValue | undefined);
  if (!baseSnapshot || !candidateSnapshot) return "expansion";
  const untracked = rankDirection(UNTRACKED_RANK, canonical(baseSnapshot.untracked as JsonValue | undefined), canonical(candidateSnapshot.untracked as JsonValue | undefined));
  if (untracked === "expansion") return "expansion";
  // Byte bounds matter only while the mode is bounded; downgrading the mode
  // makes the bounds irrelevant rather than an expansion.
  const candidateMode = stringValue(candidateSnapshot.untracked as JsonValue | undefined);
  const bounds = candidateMode === "bounded"
    ? budgetDirection(
      canonical({ maxUntrackedFileBytes: baseSnapshot.maxUntrackedFileBytes, maxUntrackedTotalBytes: baseSnapshot.maxUntrackedTotalBytes } as JsonValue),
      canonical({ maxUntrackedFileBytes: candidateSnapshot.maxUntrackedFileBytes, maxUntrackedTotalBytes: candidateSnapshot.maxUntrackedTotalBytes } as JsonValue),
    )
    : "neutral";
  if (bounds === "expansion") return "expansion";
  // Residual fail-closed check: unknown future snapshot keys expand.
  const CLASSIFIED_SNAPSHOT = new Set(["untracked", "maxUntrackedFileBytes", "maxUntrackedTotalBytes", "dirtySubmodules"]);
  const residualOf = (snapshot: JsonObject): JsonValue => Object.fromEntries(Object.entries(snapshot).filter(([key]) => !CLASSIFIED_SNAPSHOT.has(key)));
  if (vnextCanonicalJson(residualOf(baseSnapshot)) !== vnextCanonicalJson(residualOf(candidateSnapshot))) return "expansion";
  return bounds === "narrowing" || untracked === "narrowing" ? "narrowing" : "neutral";
}

function classifyChange(
  field: VnextPermissionField,
  baseValue: string | undefined,
  candidateValue: string | undefined,
  context?: { fallbackRank?: number; baseFallbackRank?: number },
): VnextPermissionDirection {
  if (baseValue === candidateValue) return "neutral";
  if (baseValue === undefined || candidateValue === undefined) {
    if (candidateValue === undefined) {
      // Removal semantics depend on the effective fallback. A secret grant
      // removal strictly narrows (no fallback exists). Everything else can
      // widen the effective ceiling by falling back to a broader default, so
      // it narrows only when the removed value is provably at or below the
      // fallback rank; otherwise it expands.
      if (field === "secrets") return "narrowing";
      if (field === "repository-access" && context?.fallbackRank !== undefined) {
        const removed = JSON.parse(baseValue as string) as unknown;
        const removedRank = typeof removed === "string" && removed in ACCESS_RANK ? ACCESS_RANK[removed] as number : Number.POSITIVE_INFINITY;
        // Removing an override lands on the fallback: strictly-weaker-than-
        // fallback removals widen effective access; broader ones tighten it;
        // equal-rank removals change nothing effective.
        if (removedRank < context.fallbackRank) return "expansion";
        return removedRank > context.fallbackRank ? "narrowing" : "neutral";
      }
      return "expansion";
    }
    // Addition: mirror of removal — an override stricter than the BASE
    // fallback narrows, a broader one expands, an equal one is neutral.
    if (field === "repository-access" && context?.baseFallbackRank !== undefined) {
      const added = JSON.parse(candidateValue) as unknown;
      const addedRank = typeof added === "string" && added in ACCESS_RANK ? ACCESS_RANK[added] as number : Number.POSITIVE_INFINITY;
      if (addedRank > context.baseFallbackRank) return "expansion";
      return addedRank < context.baseFallbackRank ? "narrowing" : "neutral";
    }
    return "expansion";
  }
  switch (field) {
    case "repository-access": return rankDirection(ACCESS_RANK, baseValue, candidateValue);
    case "network": return rankDirection(NETWORK_RANK, baseValue, candidateValue);
    case "budget": {
      // Scalar bounds (maxAttempts, timeoutMs) compare numerically; object
      // bounds (limits/workspace) compare field-wise.
      const baseParsed = JSON.parse(baseValue) as unknown;
      const candidateParsed = JSON.parse(candidateValue) as unknown;
      if (typeof baseParsed === "number" && typeof candidateParsed === "number") {
        return numericBoundDirection(baseValue, candidateValue);
      }
      return budgetDirection(baseValue, candidateValue);
    }
    case "evidence-quorum": return quorumDirection(baseValue, candidateValue);
    case "snapshot-policy": return snapshotDirection(baseValue, candidateValue);
    case "secrets": {
      const base = asObject(JSON.parse(baseValue) as JsonValue);
      const candidate = asObject(JSON.parse(candidateValue) as JsonValue);
      if (base && candidate && base.ref === candidate.ref) {
        // Any non-required grant field (as, name, future keys) changing is a
        // review-required expansion; then order by required (default true).
        const { required: _b, ...baseRest } = base;
        const { required: _c, ...candidateRest } = candidate;
        if (vnextCanonicalJson(baseRest as JsonValue) !== vnextCanonicalJson(candidateRest as JsonValue)) return "expansion";
        const baseRequired = (base.required ?? true) === true;
        const candidateRequired = (candidate.required ?? true) === true;
        if (baseRequired && !candidateRequired) return "narrowing";
        if (!baseRequired && candidateRequired) return "expansion";
        return "neutral";
      }
      return "expansion";
    }
    default:
      // tools, executor, model, sync-policy, transition, resource-shape,
      // environment, gate, delivery: no conservative order — any change is a
      // review-required expansion.
      return "expansion";
  }
}

function summarize(resource: string, path: string, field: VnextPermissionField, direction: VnextPermissionDirection, baseValue: string | undefined, candidateValue: string | undefined): string {
  const verb = baseValue === undefined ? "added" : candidateValue === undefined ? "removed" : "changed";
  return `${resource} ${path} ${field} ${verb} (${direction})`;
}

/** Diff two complete bundles into a deterministic, classified permission report. */
export function computeVnextPermissionDiff(base: VnextProjectBundle, candidate: VnextProjectBundle): VnextPermissionDiff {
  const changes: VnextPermissionChange[] = [];
  const baseByPath = new Map(base.resources.map((resource) => [resource.logicalPath, resource]));
  const candidateByPath = new Map(candidate.resources.map((resource) => [resource.logicalPath, resource]));

  const allPaths = [...new Set([...baseByPath.keys(), ...candidateByPath.keys()])].sort();
  for (const logicalPath of allPaths) {
    const baseResource = baseByPath.get(logicalPath);
    const candidateResource = candidateByPath.get(logicalPath);
    if (baseResource && candidateResource) {
      diffResource(logicalPath, baseResource, candidateResource, changes);
      continue;
    }
    // Resource added or removed: shape change. Added resources expand
    // authority; removed resources narrow it — except models: removing one
    // can retarget tag-based consumers onto another profile (an expansion).
    const resource = candidateResource ?? baseResource as VnextResource;
    const direction: VnextPermissionDirection = candidateResource
      ? "expansion"
      : (resource.kind === "model" ? "expansion" : "narrowing");
    changes.push({
      resource: logicalPath,
      path: "/",
      field: "resource-shape",
      direction,
      summary: `${logicalPath} ${candidateResource ? "added" : "removed"} (${direction})`,
      ...(candidateResource && resource.kind !== "environment" ? { candidateValueSha256: valueHash(canonical(resource.value)) } : {}),
      ...(!candidateResource && resource.kind !== "environment" ? { baseValueSha256: valueHash(canonical(resource.value)) } : {}),
    });
  }

  const sorted = changes.sort((left, right) => left.resource < right.resource ? -1 : left.resource > right.resource ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const expansions = sorted.filter((change) => change.direction === "expansion");
  const narrowings = sorted.filter((change) => change.direction === "narrowing");
  const neutralChanges = sorted.filter((change) => change.direction === "neutral");
  return {
    schema: "kxm.permission-diff.v1",
    baseRevision: base.configRevision,
    candidateRevision: candidate.configRevision,
    changes: sorted,
    expansions,
    narrowings,
    neutralChanges,
    requiresReview: expansions.length > 0,
  };
}

/** Diff two values of one resource kind (e.g. template baseline vs target). */
export function computeVnextResourcePermissionDiff(
  kind: VnextResourceKind,
  resourcePath: string,
  baseValue: JsonObject,
  candidateValue: JsonObject,
): VnextPermissionChange[] {
  const changes: VnextPermissionChange[] = [];
  const base: VnextResource = { kind, file: resourcePath, logicalPath: resourcePath, value: baseValue };
  const candidate: VnextResource = { kind, file: resourcePath, logicalPath: resourcePath, value: candidateValue };
  diffResource(resourcePath, base, candidate, changes);
  return changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function diffResource(logicalPath: string, base: VnextResource, candidate: VnextResource, changes: VnextPermissionChange[]): void {
  const baseEntries = new Map(vnextAuthorityEntries(base).map((entry) => [entry.path, entry]));
  const candidateEntries = new Map(vnextAuthorityEntries(candidate).map((entry) => [entry.path, entry]));
  const paths = [...new Set([...baseEntries.keys(), ...candidateEntries.keys()])].sort();
  for (const path of paths) {
    const baseEntry = baseEntries.get(path);
    const candidateEntry = candidateEntries.get(path);
    const field = (candidateEntry ?? baseEntry as VnextAuthorityEntry).field;
    // For per-repository overrides, the effective fallback is the resource-
    // level defaultRepositoryAccess (the loader's ceiling rule). Removal
    // compares against the candidate's default; addition against the base's.
    const context = field === "repository-access" && path.startsWith("/repositories/")
      ? {
        fallbackRank: (() => {
          const fallback = stringValue(candidate.value.defaultRepositoryAccess as JsonValue | undefined) ?? "none";
          return fallback in ACCESS_RANK ? ACCESS_RANK[fallback] as number : 0;
        })(),
        baseFallbackRank: (() => {
          const fallback = stringValue(base.value.defaultRepositoryAccess as JsonValue | undefined) ?? "none";
          return fallback in ACCESS_RANK ? ACCESS_RANK[fallback] as number : 0;
        })(),
      }
      : undefined;
    const direction = classifyChange(field, baseEntry?.value, candidateEntry?.value, context);
    if (direction === "neutral") continue;
    changes.push({
      resource: logicalPath,
      path,
      field,
      direction,
      summary: summarize(logicalPath, path, field, direction, baseEntry?.value, candidateEntry?.value),
      ...(baseEntry && field !== "environment" ? { baseValueSha256: valueHash(baseEntry.value) } : {}),
      ...(candidateEntry && field !== "environment" ? { candidateValueSha256: valueHash(candidateEntry.value) } : {}),
    });
  }
  // Prose changes are surfaced as neutral for reviewer visibility.
  const baseProse = vnextProseEntries(base);
  const candidateProse = vnextProseEntries(candidate);
  for (const path of [...new Set([...baseProse.keys(), ...candidateProse.keys()])].sort()) {
    if (baseProse.get(path) === candidateProse.get(path)) continue;
    changes.push({
      resource: logicalPath,
      path,
      field: "resource-shape",
      direction: "neutral",
      summary: `${logicalPath} ${path} prose ${baseProse.has(path) ? (candidateProse.has(path) ? "changed" : "removed") : "added"} (neutral)`,
      ...(baseProse.has(path) ? { baseValueSha256: valueHash(baseProse.get(path) as string) } : {}),
      ...(candidateProse.has(path) ? { candidateValueSha256: valueHash(candidateProse.get(path) as string) } : {}),
    });
  }
}

/* ------------------------------------------------------------------ *
 * Git base loading
 * ------------------------------------------------------------------ */

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new VnextConfigError([{
      phase: "discovery",
      code: "git_base_unavailable",
      file: args[0] ?? "<git>",
      message: (result.stderr || result.stdout || String(result.error ?? "")).trim() || "git command failed",
    }]);
  }
  return result.stdout;
}

function gitBuffer(root: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: gitEnvironment(),
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new VnextConfigError([{
      phase: "discovery",
      code: "git_base_unavailable",
      file: args[0] ?? "<git>",
      message: String(result.stderr || result.stdout || result.error || "git command failed").trim() || "git command failed",
    }]);
  }
  return result.stdout as Buffer;
}

/** Resolve a revision to its tree SHA once so a moving ref cannot mix bases. */
function resolveTreeRevision(root: string, revision: string): string {
  if (!/^[A-Za-z0-9._/^~-]+$/.test(revision) || revision.includes("..") || revision.startsWith("-")) {
    throw new VnextConfigError([{
      phase: "discovery",
      code: "git_revision_invalid",
      file: revision,
      message: "base revision must be a plain Git revision name",
    }]);
  }
  return git(root, ["rev-parse", "--verify", "--quiet", `${revision}^{tree}`]).trim();
}

/** Load the bundle as of a Git revision by materializing tracked files into a temporary shadow root. */
export function loadVnextProjectAtRevision(root: string, revision: string, options: VnextConfigOptions = {}): VnextProjectBundle {
  const tree = resolveTreeRevision(root, revision);
  const listing = gitBuffer(root, ["ls-tree", "-r", "-z", "--name-only", tree]).toString("utf8");
  const paths = listing
    .split("\u0000")
    .filter((line) => line.length > 0 && (line.startsWith(".kxm/") || line.includes("/.kxm/")));
  const shadow = mkdtempSync(join(tmpdir(), "kxm-permission-base-"));
  const shadowResolved = resolve(shadow);
  const shadowMembersDir = `.kxm-shadow-members-${createHash("sha256").update(shadowResolved, "utf8").digest("hex").slice(0, 8)}`;
  try {
    for (const path of paths) {
      const segments = path.split("/");
      if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[\\:]/.test(segment))) {
        throw new VnextConfigError([{
          phase: "path",
          code: "git_tree_path_invalid",
          file: path,
          message: "Git tree entry contains a traversal or non-portable segment",
        }]);
      }
      const absolute = join(shadowResolved, ...segments);
      const resolved = resolve(absolute);
      if (!resolved.startsWith(`${shadowResolved}${sep}`)) {
        throw new VnextConfigError([{
          phase: "path",
          code: "git_tree_path_invalid",
          file: path,
          message: "Git tree entry escapes the shadow root",
        }]);
      }
      const content = gitBuffer(root, ["cat-file", "blob", `${tree}:${path}`]);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    // Member repositories bind only at authoritative Git worktree roots.
    // Initialize the shadow control root; member worktrees are gitlinks in
    // the control tree and are materialized separately below.
    initShadowGitRoot(shadowResolved);
    // Nested member worktrees are gitlinks in the control tree: their content
    // lives in each member's own history, and the control tree pins an exact
    // commit for each. Materialize every BASE-declared member at its pinned
    // gitlink commit. Members are enumerated from the base project.yaml so a
    // candidate-added member reports as an expansion (base simply lacks it)
    // and a removed member reports as a narrowing (base still has it).
    const baseProjectFile = join(shadowResolved, ".kxm", "project.yaml");
    let baseProject: BaseProjectMember[];
    try {
      baseProject = loadBaseProjectDeclarations(baseProjectFile);
    } catch (error) {
      if (error instanceof VnextConfigError) {
        throw new VnextConfigError(error.issues.map((entry) => ({ ...entry, message: `base ${revision}: ${entry.message}` })));
      }
      throw error;
    }
    const shadowBindings: Record<string, string> = {};
    for (const member of baseProject) {
      if (member.role !== "member") continue;
      if (!vnextResourceIdentifier(member.repositoryId)) {
        throw new VnextConfigError([{
          phase: "path",
          code: "git_tree_path_invalid",
          file: ".kxm/project.yaml",
          message: `member repository id ${JSON.stringify(member.repositoryId)} at the base revision is not a valid identifier`,
        }]);
      }
      if (member.pathHint !== undefined && !portableMemberPathHint(member.pathHint)) {
        throw new VnextConfigError([{
          phase: "path",
          code: "git_tree_path_invalid",
          file: ".kxm/project.yaml",
          message: `member repository ${member.repositoryId} has a non-portable pathHint at the base revision`,
        }]);
      }
      // The object source for reads: a host-local binding for this exact id,
      // else the live portable worktree at the SAME pathHint.
      const boundPath = options.repositoryBindings?.[member.repositoryId];
      const memberWorktree = boundPath
        ? resolve(boundPath)
        : member.pathHint
          ? resolve(root, ...member.pathHint.split("/"))
          : undefined;
      if (!memberWorktree || !existsSync(memberWorktree)) {
        if (member.required === false) continue; // optional member absent on this host (loader tolerates it)
        throw new VnextConfigError([{
          phase: "discovery",
          code: "trust_scope_unsupported",
          file: ".kxm/project.yaml",
          message: `member repository ${member.repositoryId} has no resolvable worktree at the base revision; trust diff cannot materialize its pinned content`,
        }]);
      }
      // The control tree's gitlink for this member path pins the reviewed commit.
      let pinnedCommit: string | undefined;
      if (member.pathHint) {
        const gitlink = git(root, ["ls-tree", tree, "--", member.pathHint]).trim();
        if (gitlink.length > 0) {
          const match = /^160000 commit ([0-9a-f]{40,64})\t/.exec(gitlink);
          if (!match) {
            throw new VnextConfigError([{
              phase: "discovery",
              code: "trust_scope_unsupported",
              file: ".kxm/project.yaml",
              message: `member ${member.repositoryId} pathHint ${member.pathHint} is not a pinned gitlink at the base revision`,
            }]);
          }
          pinnedCommit = match[1];
        } else if (boundPath) {
          // Host-locally bound member with no gitlink in the control tree:
          // the only reviewable base is the member's own HEAD commit.
          pinnedCommit = git(memberWorktree, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).trim();
        } else {
          throw new VnextConfigError([{
            phase: "discovery",
            code: "trust_scope_unsupported",
            file: ".kxm/project.yaml",
            message: `member repository ${member.repositoryId} pathHint ${member.pathHint} is not tracked as a gitlink at the base revision (gitignored nested worktrees cannot be diffed)`,
          }]);
        }
      } else if (boundPath) {
        // Host-locally bound member with no pathHint: the only reviewable
        // base is the member's own HEAD commit.
        pinnedCommit = git(memberWorktree, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).trim();
      }
      if (!pinnedCommit) {
        throw new VnextConfigError([{
          phase: "discovery",
          code: "trust_scope_unsupported",
          file: ".kxm/project.yaml",
          message: `member repository ${member.repositoryId} declares no pathHint and has no host-local binding at the base revision`,
        }]);
      }
      const memberTree = git(memberWorktree, ["rev-parse", "--verify", "--quiet", `${pinnedCommit}^{tree}`]).trim();
      const memberListing = gitBuffer(memberWorktree, ["ls-tree", "-r", "-z", "--name-only", memberTree]).toString("utf8");
      const memberPaths = memberListing.split("\u0000").filter((line) => line.length > 0 && (line.startsWith(".kxm/") || line.includes("/.kxm/")));
      const memberShadowRoot = join(shadowResolved, shadowMembersDir, member.repositoryId);
      if (!resolve(memberShadowRoot).startsWith(`${resolve(shadowResolved, shadowMembersDir)}${sep}`)) {
        throw new VnextConfigError([{
          phase: "path",
          code: "git_tree_path_invalid",
          file: ".kxm/project.yaml",
          message: `member repository ${member.repositoryId} shadow path escapes the member shadow root`,
        }]);
      }
      for (const path of memberPaths) {
        const segments = path.split("/");
        if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[\\:]/.test(segment))) {
          throw new VnextConfigError([{ phase: "path", code: "git_tree_path_invalid", file: path, message: "member Git tree entry contains a traversal or non-portable segment" }]);
        }
        const absolute = join(memberShadowRoot, ...segments);
        const resolved = resolve(absolute);
        if (!resolved.startsWith(`${resolve(memberShadowRoot)}${sep}`)) {
          throw new VnextConfigError([{ phase: "path", code: "git_tree_path_invalid", file: path, message: "member Git tree entry escapes the shadow root" }]);
        }
        const content = gitBuffer(memberWorktree, ["cat-file", "blob", `${memberTree}:${path}`]);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
      }
      initShadowGitRoot(memberShadowRoot);
      shadowBindings[member.repositoryId] = memberShadowRoot;
    }
    try {
      return loadVnextProject(shadowResolved, { ...options, repositoryBindings: shadowBindings });
    } catch (error) {
      if (error instanceof VnextConfigError) {
        throw new VnextConfigError(error.issues.map((entry) => ({ ...entry, message: `base ${revision}: ${entry.message}` })));
      }
      throw error;
    }
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
}

interface BaseProjectMember {
  repositoryId: string;
  role?: string;
  pathHint?: string;
  required?: boolean;
}

/** Portable member pathHint predicate (mirrors the loader's portable path rules; "." is never a member). */
function portableMemberPathHint(pathHint: string): boolean {
  return pathHint !== "." && vnextPortablePath(pathHint);
}



/** Read only the repository declarations from a materialized base project.yaml. */
function loadBaseProjectDeclarations(projectFile: string): BaseProjectMember[] {
  if (!existsSync(projectFile)) return [];
  const value = parseRestrictedYaml(readFileSync(projectFile, "utf8"), ".kxm/project.yaml");
  const repositories = Array.isArray(value?.repositories) ? value.repositories : [];
  const members: BaseProjectMember[] = [];
  for (const entry of repositories) {
    const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as JsonObject : undefined;
    const repositoryId = record && typeof record.id === "string" ? record.id : undefined;
    if (!repositoryId) continue;
    members.push({
      repositoryId,
      ...(record && typeof record.role === "string" ? { role: record.role } : {}),
      ...(record && typeof record.pathHint === "string" ? { pathHint: record.pathHint } : {}),
      ...(record && typeof record.required === "boolean" ? { required: record.required } : {}),
    });
  }
  return members;
}

function initShadowGitRoot(directory: string): void {
  const result = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", directory], {
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    throw new VnextConfigError([{
      phase: "discovery",
      code: "git_base_unavailable",
      file: directory,
      message: (result.stderr || String(result.error ?? "")).trim() || "could not initialize the shadow Git root",
    }]);
  }
}

/** Diff the working tree against a Git revision. */
export function diffVnextProjectAgainstRevision(
  root: string,
  revision: string,
  options: VnextConfigOptions = {},
): VnextPermissionDiff {
  const base = loadVnextProjectAtRevision(root, revision, options);
  const candidate = loadVnextProject(root, options);
  return computeVnextPermissionDiff(base, candidate);
}

/** Human-readable report lines for the CLI. */
export function formatVnextPermissionDiff(diff: VnextPermissionDiff): string {
  const lines: string[] = [];
  lines.push(`permission diff: ${diff.baseRevision.slice(0, 19)}… -> ${diff.candidateRevision.slice(0, 19)}…`);
  if (diff.changes.length === 0) {
    lines.push("no authority-bearing or prose changes");
    return lines.join("\n");
  }
  for (const change of diff.expansions) lines.push(`EXPANSION  ${change.summary}`);
  for (const change of diff.narrowings) lines.push(`narrowing  ${change.summary}`);
  for (const change of diff.neutralChanges) lines.push(`neutral    ${change.summary}`);
  lines.push(diff.requiresReview
    ? `${diff.expansions.length} expansion(s) require explicit reviewed trust action`
    : "no expansions; no trust review required");
  return lines.join("\n");
}
