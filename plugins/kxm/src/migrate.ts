import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import {
  KxmConfigError,
  KxmSchemaRegistry,
  discoverGitRoot,
  legacyConfigFilesAt,
  loadKxmProject,
  migrationReceiptSelfHash,
  parseRestrictedYaml,
  readKxmMigrationReceipt,
  validateKxmResources,
  verifyKxmMigrationReceiptTarget,
  kxmCanonicalJson,
  KXM_MIGRATION_RECEIPT_PATH,
  type JsonObject,
  type JsonValue,
  type KxmConfigIssue,
  type KxmConfigOptions,
  type KxmResourceKind,
} from "./project-config.ts";
import { withKxmLocalBindingLock, type KxmLocalBindingLock, type KxmLocalBindingStoreOptions } from "./bindings.ts";

/* ------------------------------------------------------------------ *
 * Bounded legacy JSON reading (duplicate keys rejected, depth bounded)
 * ------------------------------------------------------------------ */

const MAX_LEGACY_JSON_BYTES = 1024 * 1024;
const MAX_LEGACY_JSON_DEPTH = 32;
const MAX_LEGACY_JSON_NODES = 32_768;
const MAX_LEGACY_SOURCES = 64;

function migrateIssue(phase: KxmConfigIssue["phase"], code: string, file: string, message: string): KxmConfigIssue {
  return { phase, code, file, message };
}

function migrateFail(code: string, file: string, message: string): never {
  throw new KxmConfigError([migrateIssue("parse", code, file, message)]);
}

/** JSON.parse with duplicate-key rejection and structural bounds. */
export function parseLegacyJson(text: string, label: string): JsonValue {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_LEGACY_JSON_BYTES) migrateFail("document_too_large", label, `document exceeds ${MAX_LEGACY_JSON_BYTES} bytes`);
  const state = { nodes: 0 };
  const parseNode = (value: unknown, path: string, depth: number): JsonValue => {
    state.nodes += 1;
    if (state.nodes > MAX_LEGACY_JSON_NODES) migrateFail("node_limit", label, `document exceeds ${MAX_LEGACY_JSON_NODES} nodes`);
    if (depth > MAX_LEGACY_JSON_DEPTH) migrateFail("depth_limit", label, `document exceeds nesting depth ${MAX_LEGACY_JSON_DEPTH}`);
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) migrateFail("non_json_number", label, `${path} is not a finite number`);
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => parseNode(entry, `${path}[${index}]`, depth + 1)) as JsonValue;
    }
    if (value && typeof value === "object") {
      const record: JsonObject = {};
      for (const [key, entry] of Object.entries(value)) record[key] = parseNode(entry, `${path}.${key}`, depth + 1);
      return record;
    }
    migrateFail("non_json_value", label, `${path} is not JSON-compatible`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    migrateFail("invalid_json", label, error instanceof Error ? error.message : String(error));
  }
  // JSON.parse silently keeps the last duplicate key; reject them with a
  // token-level scan over the (now known-valid) document.
  detectDuplicateKeys(text, label);
  return parseNode(raw, "$", 0);
}

/** Token-level duplicate key scan: tracks object key sets per nesting level. */
function detectDuplicateKeys(text: string, label: string): void {
  const stack: Array<Set<string> | "array"> = [];
  let index = 0;
  const length = text.length;
  const skipWhitespace = (): void => {
    while (index < length && /[\s]/.test(text[index] as string)) index += 1;
  };
  const parseString = (): string => {
    let result = "";
    index += 1; // opening quote
    while (index < length) {
      const char = text[index] as string;
      if (char === '"') { index += 1; return result; }
      if (char === "\\") {
        const escape = text[index + 1] as string;
        if (escape === "u") {
          result += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
          index += 6;
        } else {
          const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          result += escapes[escape] ?? escape;
          index += 2;
        }
      } else {
        result += char;
        index += 1;
      }
    }
    migrateFail("invalid_json", label, "unterminated string");
  };
  const skipValue = (): void => {
    skipWhitespace();
    const char = text[index] as string;
    if (char === '"') { parseString(); return; }
    if (char === "{" || char === "[") { parseContainer(); return; }
    while (index < length && !/[\s,\]}]/.test(text[index] as string)) index += 1;
  };
  const parseContainer = (): void => {
    const char = text[index] as string;
    if (stack.length > MAX_LEGACY_JSON_DEPTH) migrateFail("depth_limit", label, `document exceeds nesting depth ${MAX_LEGACY_JSON_DEPTH}`);
    if (char === "{") {
      const keys = new Set<string>();
      stack.push(keys);
      index += 1;
      skipWhitespace();
      if (text[index] === "}") { index += 1; stack.pop(); return; }
      for (;;) {
        skipWhitespace();
        if (text[index] !== '"') migrateFail("invalid_json", label, `expected object key at byte ${index}`);
        const key = parseString();
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          migrateFail("forbidden_key", label, `key ${JSON.stringify(key)} is forbidden`);
        }
        const frame = stack[stack.length - 1];
        if (frame instanceof Set) {
          if (frame.has(key)) migrateFail("duplicate_key", label, `duplicate key ${JSON.stringify(key)}`);
          frame.add(key);
        }
        skipWhitespace();
        if (text[index] !== ":") migrateFail("invalid_json", label, `expected ':' at byte ${index}`);
        index += 1;
        skipValue();
        skipWhitespace();
        if (text[index] === ",") { index += 1; continue; }
        if (text[index] === "}") { index += 1; stack.pop(); return; }
        migrateFail("invalid_json", label, `expected ',' or '}' at byte ${index}`);
      }
    }
    if (char === "[") {
      stack.push("array");
      index += 1;
      skipWhitespace();
      if (text[index] === "]") { index += 1; stack.pop(); return; }
      for (;;) {
        skipValue();
        skipWhitespace();
        if (text[index] === ",") { index += 1; continue; }
        if (text[index] === "]") { index += 1; stack.pop(); return; }
        migrateFail("invalid_json", label, `expected ',' or ']' at byte ${index}`);
      }
    }
  };
  skipValue();
  skipWhitespace();
  if (index !== length) migrateFail("invalid_json", label, `trailing content at byte ${index}`);
}

/* ------------------------------------------------------------------ *
 * Legacy source model
 * ------------------------------------------------------------------ */

export interface KxmLegacySource {
  path: string;
  sha256: string;
  bytes: number;
  value: JsonValue;
}

function sha256Of(input: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

/** Read every legacy configuration file with bounds and exact duplicate-key rejection. */
export function readKxmLegacySources(root: string): KxmLegacySource[] {
  const files = legacyConfigFilesAt(root);
  if (files.length > MAX_LEGACY_SOURCES) {
    throw new KxmConfigError([migrateIssue("discovery", "legacy_source_limit", ".kxm/config", `legacy configuration exceeds ${MAX_LEGACY_SOURCES} files`)]);
  }
  return files.map((path) => {
    const absolute = join(root, ...path.split("/"));
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new KxmConfigError([migrateIssue("path", "legacy_source_invalid", path, "legacy configuration must be a regular file, not a link")]);
    }
    const buffer = readFileSync(absolute);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new KxmConfigError([migrateIssue("parse", "invalid_utf8", path, "document is not valid UTF-8")]);
    }
    return {
      path,
      sha256: sha256Of(buffer),
      bytes: buffer.byteLength,
      value: parseLegacyJson(text, path),
    };
  });
}

export function legacySourceDigest(sources: readonly KxmLegacySource[]): string {
  return sha256Of(kxmCanonicalJson(sources.map((source) => ({ path: source.path, sha256: source.sha256, bytes: source.bytes }))));
}

/* ------------------------------------------------------------------ *
 * Conversion
 * ------------------------------------------------------------------ */

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const KNOWN_AGENT_FIELDS = new Set(["name", "kind", "driver", "model", "thinking", "purpose"]);
const KNOWN_GATE_FIELDS = new Set(["name", "kind", "driver", "purpose"]);
const KNOWN_WORKFLOW_FIELDS = new Set([
  "id", "source", "project", "target", "secret", "secretEnv", "signalSecret", "signalSecretEnv",
  "event", "filter", "delivery", "ttlMs", "promptTemplate", "stages", "maxTransitions",
  "reproOracle", "planHash", "requirePlanHash",
]);
const KNOWN_STAGE_FIELDS = new Set(["id", "label", "instructions", "requiredEvidence", "maxAttempts", "area", "evidencePolicies", "on", "maxTransitions"]);
const KNOWN_POLICY_FIELDS = new Set(["kind", "minProducers", "eligibleAgents", "acceptedStatuses", "degradation"]);
const KNOWN_TRANSITION_FIELDS = new Set(["target", "maxTransitions"]);

export interface KxmMigrationAmbiguity {
  key: string;
  category: "unsupported" | "identity" | "step-kind" | "terminal-status" | "transition-budget" | "evidence-policy" | "permission" | "secret-reference";
  sourcePath: string;
  message: string;
  allowedValues: readonly (string | number)[];
}

export interface KxmMigrationUnmapped {
  sourcePath: string;
  jsonPointer: string;
  valueSha256: string;
  sensitive: boolean;
}

export interface KxmMigrationRename {
  from: string;
  to: string;
  kind: "agent" | "model" | "workflow" | "step" | "evidence" | "outcome";
}

export interface KxmMigrationPermissionChange {
  sourcePath: string;
  targetPath: string;
  direction: "narrowing" | "expansion" | "unknown";
  summary: string;
  decisionKey: string;
}

interface MutablePlan {
  ambiguities: KxmMigrationAmbiguity[];
  invalidDecisions: string[];
  decisionKeys: Set<string>;
  decisionAllowedValues: Map<string, readonly (string | number)[]>;
  unmapped: KxmMigrationUnmapped[];
  renames: KxmMigrationRename[];
  permissionChanges: KxmMigrationPermissionChange[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeIdentifier(raw: string): string {
  return raw
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "")
    .replace(/^(?=[0-9])/, "id-");
}

function pointerEscape(segment: string): string {
  const escaped = segment.replace(/~/g, "~0").replace(/\//g, "~1");
  // jsonPointer is schema-bounded at 1024; digest oversized segments so a
  // pathological legacy key can never hard-fail the plan record.
  if (escaped.length <= 200) return escaped;
  const digest = createHash("sha256").update(segment, "utf8").digest("hex").slice(0, 8);
  return `${escaped.slice(0, 180)}~digest-${digest}`;
}

/** Truncate a legacy name for plan-record fields with schema length bounds. */
function elide(raw: string, max = 120): string {
  return raw.length <= max ? raw : `${raw.slice(0, max - 15)}…[${raw.length}]`;
}

/** Deterministic, schema-pattern-safe decision-key fragment for a raw legacy name. */
function keyFragment(raw: string): string {
  const full = normalizeIdentifier(raw) || "unnamed";
  // The 8-hex digest disambiguates; cap the readable portion so composed
  // decision keys always fit the 512-char schema bound.
  const normalized = full.length > 96 ? `${full.slice(0, 96)}-${full.length}` : full;
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return `${normalized}-${digest}`;
}

function recordUnmapped(plan: MutablePlan, sourcePath: string, pointer: string, value: JsonValue | undefined, sensitive: boolean): void {
  // Sensitive fields are never hashed content-wise: a low-entropy secret must
  // not be recoverable by offline guessing against a committed plan. Record
  // only the serialized byte length as proof something was dropped.
  const digestInput = sensitive
    ? { redacted: true, bytes: Buffer.byteLength(kxmCanonicalJson(value === undefined ? null : value), "utf8") }
    : (value === undefined ? null : value);
  plan.unmapped.push({
    sourcePath,
    jsonPointer: pointer,
    valueSha256: sha256Of(kxmCanonicalJson(digestInput)),
    sensitive,
  });
}

function recordUnknownFields(
  plan: MutablePlan,
  sourcePath: string,
  pointer: string,
  record: JsonObject,
  known: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    if (!known.has(key)) recordUnmapped(plan, sourcePath, `${pointer}/${pointerEscape(key)}`, record[key], false);
  }
}

type IdentityOutcome =
  | { status: "adopted"; id: string }
  | { status: "pending" }
  | { status: "dropped" };

function mapIdentity(
  plan: MutablePlan,
  sourcePath: string,
  raw: string,
  kind: KxmMigrationRename["kind"],
  taken: Map<string, string>,
  decisions: Readonly<Record<string, JsonValue>>,
  dropPointer?: string,
  dropValue?: JsonValue,
): IdentityOutcome {
  const normalized = normalizeIdentifier(raw);
  const usable = (candidate: string): boolean => IDENTIFIER.test(candidate) && candidate.length <= 64;
  const adopt = (candidate: string): { outcome: "adopted"; id: string } | { outcome: "taken" } | { outcome: "duplicate" } => {
    const foldedCandidate = candidate.toLocaleLowerCase("en-US");
    const priorCandidate = taken.get(foldedCandidate);
    if (priorCandidate !== undefined && priorCandidate !== raw) return { outcome: "taken" };
    if (priorCandidate === raw) return { outcome: "duplicate" };
    taken.set(foldedCandidate, raw);
    plan.renames.push({ from: elide(raw), to: candidate, kind });
    return { outcome: "adopted", id: candidate };
  };
  const reportDuplicate = (): IdentityOutcome => {
    // Exact duplicate raw identity: never merge two legacy definitions
    // last-wins. The only resolution is an explicit drop of the duplicate;
    // its full content is preserved in the report either way.
    const decided = resolveDecision(
      plan,
      `identity-duplicate:${kind}:${keyFragment(raw)}`,
      "unsupported",
      sourcePath,
      `${kind} name ${JSON.stringify(elide(raw, 200))} is declared more than once; confirm the duplicate definition is dropped`,
      ["drop"],
      decisions,
    );
    recordUnmapped(plan, sourcePath, dropPointer ?? `/duplicates/${pointerEscape(raw)}`, dropValue ?? raw, false);
    return decided === "drop" ? { status: "dropped" } : { status: "pending" };
  };
  if (!normalized || !usable(normalized)) {
    const supplied = resolveDecision(
      plan,
      `identity:${kind}:${keyFragment(raw)}`,
      "identity",
      sourcePath,
      `${kind} name ${JSON.stringify(elide(raw, 200))} cannot be normalized to a KXM identifier; supply a decision with the target identifier`,
      ["<identifier>"],
      decisions,
    );
    if (typeof supplied === "string" && usable(supplied)) {
      const adopted = adopt(supplied);
      if (adopted.outcome === "adopted") return { status: "adopted", id: adopted.id };
      if (adopted.outcome === "duplicate") return reportDuplicate();
      plan.ambiguities.push({
        key: `identity:${kind}:${keyFragment(raw)}`,
        category: "identity",
        sourcePath,
        message: `decision-supplied identifier ${JSON.stringify(elide(supplied, 200))} for ${kind} ${JSON.stringify(elide(raw, 200))} collides with another migrated identity`,
        allowedValues: ["<identifier>"],
      });
    }
    return { status: "pending" };
  }
  const folded = normalized.toLocaleLowerCase("en-US");
  const prior = taken.get(folded);
  if (prior && prior !== raw) {
    const supplied = resolveDecision(
      plan,
      `identity-collision:${kind}:${folded}-${keyFragment(raw)}`,
      "identity",
      sourcePath,
      `${kind} names ${JSON.stringify(elide(prior, 200))} and ${JSON.stringify(elide(raw, 200))} collide after normalization; supply a distinct identifier for ${JSON.stringify(elide(raw, 200))}`,
      ["<identifier>"],
      decisions,
    );
    if (typeof supplied === "string" && usable(supplied)) {
      const adopted = adopt(supplied);
      if (adopted.outcome === "adopted") return { status: "adopted", id: adopted.id };
      if (adopted.outcome === "duplicate") return reportDuplicate();
      plan.ambiguities.push({
        key: `identity-collision:${kind}:${folded}-${keyFragment(raw)}`,
        category: "identity",
        sourcePath,
        message: `decision-supplied identifier ${JSON.stringify(elide(supplied, 200))} for ${kind} ${JSON.stringify(elide(raw, 200))} collides with another migrated identity`,
        allowedValues: ["<identifier>"],
      });
    }
    return { status: "pending" };
  }
  if (prior === raw) return reportDuplicate();
  taken.set(folded, raw);
  if (normalized !== raw && !plan.renames.some((rename) => rename.kind === kind && rename.from === raw)) {
    plan.renames.push({ from: elide(raw), to: normalized, kind });
  }
  return { status: "adopted", id: normalized };
}

/** Validate one supplied decision value against the plan's allowed shape. */
function decisionValueAllowed(key: string, value: JsonValue | undefined, allowed: readonly (string | number)[]): boolean {
  if (value === undefined) return false;
  if (allowed.some((candidate) => candidate === "<identifier>")) {
    return typeof value === "string" && IDENTIFIER.test(value) && value.length <= 64;
  }
  if (allowed.some((candidate) => candidate === "<provider/model>")) {
    if (typeof value !== "string") return false;
    const separator = value.indexOf("/");
    const provider = separator > 0 ? normalizeIdentifier(value.slice(0, separator)) : "";
    const modelId = separator > 0 ? value.slice(separator + 1) : "";
    return IDENTIFIER.test(provider) && provider.length <= 64 && modelId.length >= 1 && modelId.length <= 200;
  }
  // Numeric budget proposals enumerate suggested values; any in-range integer
  // is a valid reviewed choice.
  if (key.startsWith("backedge:")) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100;
  }
  if (key.startsWith("budget:")) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000;
  }
  // Roster-choice keys list the roster as a hint (capped at 64 entries for
  // schema bounds); a capped list accepts any identifier-shaped value and the
  // semantic validators (coordinator_unknown/producer_agent_unknown) remain
  // the backstop, while an uncapped list requires exact membership.
  if (key.startsWith("coordinator:") || key.startsWith("producer:")) {
    if (allowed.some((candidate) => candidate === value)) return true;
    return allowed.length >= 64 && typeof value === "string" && IDENTIFIER.test(value) && value.length <= 64;
  }
  return allowed.some((candidate) => candidate === value);
}

function resolveDecision(
  plan: MutablePlan,
  key: string,
  category: KxmMigrationAmbiguity["category"],
  sourcePath: string,
  message: string,
  allowedValues: readonly (string | number)[],
  decisions: Readonly<Record<string, JsonValue>>,
): JsonValue | undefined {
  plan.decisionKeys.add(key);
  plan.decisionAllowedValues.set(key, allowedValues);
  if (Object.hasOwn(decisions, key)) {
    const value = decisions[key];
    if (decisionValueAllowed(key, value, allowedValues)) return value;
    // An invalid supplied value never falls back to a default: the ambiguity
    // persists and the decision is reported invalid at apply.
    if (!plan.invalidDecisions.includes(key)) plan.invalidDecisions.push(key);
  }
  if (!plan.ambiguities.some((ambiguity) => ambiguity.key === key)) {
    plan.ambiguities.push({ key, category, sourcePath, message, allowedValues });
  }
  return undefined;
}

/* ------------------------- agents roster -------------------------- */

interface ConvertedAgents {
  agents: Map<string, JsonObject>;
  models: Map<string, JsonObject>;
  /** Exact legacy raw roster name -> migrated id (case-sensitive first match). */
  rawNames: Map<string, string>;
  /** Raw roster names whose identity decision is still pending (exact set). */
  pendingRawNames: Set<string>;
  /** True when at least one roster agent's identity decision is still pending. */
  identityPending: boolean;
}

function convertAgentsRoster(
  plan: MutablePlan,
  source: KxmLegacySource,
  decisions: Readonly<Record<string, JsonValue>>,
  agentNames: Map<string, string>,
): ConvertedAgents {
  const agents = new Map<string, JsonObject>();
  const models = new Map<string, JsonObject>();
  const rawNames = new Map<string, string>();
  const pendingRawNames = new Set<string>();
  const modelNames = new Map<string, string>();
  let identityPending = false;
  const root = asObject(source.value);
  if (!root) {
    resolveDecision(
      plan,
      `unsupported:${source.path}:/`,
      "unsupported",
      source.path,
      "agents.json must be a JSON object with an agents array; confirm it is dropped from conversion",
      ["drop"],
      decisions,
    );
    return { agents, models, rawNames, pendingRawNames, identityPending };
  }
  recordUnknownFields(plan, source.path, "", root, new Set(["schema", "project", "host", "agents", "ownership"]));
  if (root.ownership !== undefined) recordUnmapped(plan, source.path, "/ownership", root.ownership, false);
  if (root.host !== undefined) recordUnmapped(plan, source.path, "/host", root.host, false);
  if (root.project !== undefined) recordUnmapped(plan, source.path, "/project", root.project, false);
  if (root.schema !== undefined && root.schema !== "kxm.agents.v1") recordUnmapped(plan, source.path, "/schema", root.schema, false);
  const list = Array.isArray(root.agents) ? root.agents : [];
  for (const [index, entry] of list.entries()) {
    const pointer = `/agents/${index}`;
    const record = asObject(entry);
    if (!record) {
      recordUnmapped(plan, source.path, pointer, entry, false);
      continue;
    }
    recordUnknownFields(plan, source.path, pointer, record, KNOWN_AGENT_FIELDS);
    const name = asString(record.name);
    const kind = asString(record.kind) ?? "agent";
    const driver = asString(record.driver) ?? "ai";
    if (!name || kind !== "agent" || driver !== "ai") {
      resolveDecision(
        plan,
        `unsupported:${source.path}:${pointer}`,
        "unsupported",
        source.path,
        `roster entry ${index} (${name === undefined ? "unnamed" : elide(name, 200)}) has kind ${elide(kind, 64)}/driver ${elide(driver, 64)}; only agent/ai entries convert losslessly — confirm the entry is dropped`,
        ["drop"],
        decisions,
      );
      recordUnmapped(plan, source.path, pointer, record, false);
      continue;
    }
    // Register the permission decision before identity resolution: the key
    // derives from the raw roster name, so the first plan already lists it
    // even when an identity decision is still pending.
    resolveDecision(
      plan,
      `permission:${keyFragment(name)}`,
      "permission",
      source.path,
      `approve the narrowed tool/repository/network ceiling for agent ${elide(name, 200)}`,
      ["approve"],
      decisions,
    );
    const agentIdentity = mapIdentity(plan, source.path, name, "agent", agentNames, decisions, pointer, record);
    if (agentIdentity.status === "pending") {
      identityPending = true;
      pendingRawNames.add(name);
    }
    if (agentIdentity.status !== "adopted") continue;
    const id = agentIdentity.id;
    const agent: JsonObject = {
      schema: "kxm.agent.v1",
      purpose: asString(record.purpose) ?? `Migrated legacy agent ${elide(name, 200)}.`,
    };
    const model = asString(record.model);
    if (model) {
      const applyModel = (candidate: string): boolean => {
        const separator = candidate.indexOf("/");
        if (separator <= 0) return false;
        const provider = normalizeIdentifier(candidate.slice(0, separator));
        const modelId = candidate.slice(separator + 1);
        if (IDENTIFIER.test(provider) && provider.length <= 64 && modelId.length >= 1 && modelId.length <= 200) {
          agent.model = { provider, model: modelId };
          return true;
        }
        return false;
      };
      if (!applyModel(model)) {
        const supplied = resolveDecision(
          plan,
          `model:${keyFragment(name)}`,
          "identity",
          source.path,
          `agent ${elide(name, 200)} model ${JSON.stringify(elide(model, 200))} does not map to a provider identifier + model id pair; supply <provider>/<model>`,
          ["<provider/model>"],
          decisions,
        );
        if (typeof supplied === "string" && supplied !== model) {
          applyModel(supplied);
        } else if (typeof supplied !== "string") {
          recordUnmapped(plan, source.path, `${pointer}/model`, model, false);
        }
      }
    }
    const thinking = asString(record.thinking);
    if (thinking) {
      // KXM agents select models; thinking belongs to a model profile. Emit
      // a per-agent profile when the model mapped cleanly.
      const selector = asObject(agent.model as JsonValue | undefined);
      if (selector && typeof selector.profile !== "string") {
        const profileIdentity = mapIdentity(plan, source.path, `${id}-primary`, "model", modelNames, decisions);
        const profileId = profileIdentity.status === "adopted" ? profileIdentity.id : undefined;
        if (profileId) {
          const profile: JsonObject = {
            schema: "kxm.model.v1",
            provider: selector.provider as string,
            model: selector.model as string,
            thinking,
          };
          models.set(profileId, profile);
          agent.model = { profile: profileId };
        }
      } else {
        recordUnmapped(plan, source.path, `${pointer}/thinking`, thinking, false);
      }
    }
    // Legacy workers ran with an interactive tool allowlist chosen at launch;
    // the migrated definition declares the narrowest portable ceiling.
    agent.tools = { preset: "workspace-writer" };
    agent.defaultRepositoryAccess = "none";
    agent.network = "provider-only";
    plan.permissionChanges.push({
      sourcePath: source.path,
      targetPath: `.kxm/agents/${id}.yaml`,
      direction: "unknown",
      summary: `agent ${elide(name, 200)}: legacy workers used launch-time tool flags the converter cannot observe; migrated ceiling is workspace-writer tools, no repository access, provider-only network`,
      decisionKey: `permission:${keyFragment(name)}`,
    });
    agents.set(id, agent);
    if (!rawNames.has(name)) rawNames.set(name, id);
  }
  return { agents, models, rawNames, pendingRawNames, identityPending };
}

/* ------------------------- gates roster --------------------------- */

const IMPLEMENTED_GATES = new Set(["test", "scm-delivery"]);

function convertGatesRoster(
  plan: MutablePlan,
  source: KxmLegacySource,
  decisions: Readonly<Record<string, JsonValue>>,
): void {
  const root = asObject(source.value);
  if (!root) {
    resolveDecision(
      plan,
      `unsupported:${source.path}:/`,
      "unsupported",
      source.path,
      "gates.json must be a JSON object with a gates array; confirm it is dropped from conversion",
      ["drop"],
      decisions,
    );
    return;
  }
  recordUnknownFields(plan, source.path, "", root, new Set(["schema", "gates"]));
  if (root.schema !== undefined && root.schema !== "kxm.gates.v1") recordUnmapped(plan, source.path, "/schema", root.schema, false);
  const list = Array.isArray(root.gates) ? root.gates : [];
  for (const [index, entry] of list.entries()) {
    const pointer = `/gates/${index}`;
    const record = asObject(entry);
    if (!record) {
      recordUnmapped(plan, source.path, pointer, entry, false);
      continue;
    }
    recordUnknownFields(plan, source.path, pointer, record, KNOWN_GATE_FIELDS);
    const name = asString(record.name) ?? `gate-${index}`;
    if (!IMPLEMENTED_GATES.has(name)) {
      resolveDecision(
        plan,
        `gate:${keyFragment(name)}`,
        "unsupported",
        source.path,
        `gate ${JSON.stringify(elide(name, 200))} has no registered deterministic runner in KXM; it is preserved in the migration report only`,
        ["report-only"],
        decisions,
      );
      recordUnmapped(plan, source.path, pointer, entry as JsonValue, false);
    }
  }
}

/* ------------------------- workflows ------------------------------ */

interface StageContext {
  workflowId: string;
  /** Stable decision-key fragment derived from the raw legacy workflow id. */
  workflowKey: string;
  stageIds: string[];
  renamesByKind: Map<string, string>;
}

function mapStageRef(context: StageContext, raw: string): string {
  return context.renamesByKind.get(raw) ?? normalizeIdentifier(raw);
}

function convertTransition(
  plan: MutablePlan,
  source: KxmLegacySource,
  context: StageContext,
  stageId: string,
  stageKey: string,
  outcome: string,
  rawOutcome: string,
  rawValue: JsonValue,
  decisions: Readonly<Record<string, JsonValue>>,
  stagePointer: string,
): JsonValue | undefined {
  const pointer = `${stagePointer}/on/${pointerEscape(rawOutcome)}`;
  const rule = typeof rawValue === "string" ? { target: rawValue } : asObject(rawValue);
  if (!rule) {
    recordUnmapped(plan, source.path, pointer, rawValue, false);
    return undefined;
  }
  if (typeof rawValue !== "string") recordUnknownFields(plan, source.path, pointer, rule, KNOWN_TRANSITION_FIELDS);
  const target = asString(rule.target);
  if (!target) {
    recordUnmapped(plan, source.path, pointer, rawValue, false);
    return undefined;
  }
  const sourceIndex = context.stageIds.indexOf(stageId);
  if (target === "$terminal") {
    // Legacy $terminal always completes the run successfully regardless of
    // outcome; KXM requires an explicit terminal status.
    const chosen = resolveDecision(
      plan,
      `terminal:${context.workflowKey}:${stageKey}:${outcome}`,
      "terminal-status",
      source.path,
      `legacy transition ${context.workflowId}/${stageId} outcome ${outcome} ends the run; choose the KXM terminal status (legacy semantics completed the run even on failure outcomes)`,
      outcome === "passed" ? ["completed"] : ["completed", "failed", "cancelled"],
      decisions,
    );
    const status = typeof chosen === "string" && ["completed", "failed", "cancelled"].includes(chosen)
      ? chosen
      : "completed";
    const objectRule = asObject(rawValue);
    const result: JsonObject = { target: "$terminal", terminalStatus: status };
    if (typeof objectRule?.maxTransitions === "number") {
      if (Number.isInteger(objectRule.maxTransitions) && objectRule.maxTransitions >= 1 && objectRule.maxTransitions <= 100) {
        result.maxTransitions = objectRule.maxTransitions;
      } else {
        recordUnmapped(plan, source.path, `${pointer}/maxTransitions`, objectRule.maxTransitions, false);
      }
    }
    return result;
  }
  const targetId = mapStageRef(context, target);
  const targetIndex = context.stageIds.indexOf(targetId);
  if (targetIndex < 0) {
    resolveDecision(
      plan,
      `transition-target:${context.workflowKey}:${stageKey}:${outcome}`,
      "identity",
      source.path,
      `transition target ${JSON.stringify(elide(target, 200))} is not a stage of workflow ${context.workflowId}; confirm the edge is dropped`,
      ["drop"],
      decisions,
    );
    recordUnmapped(plan, source.path, pointer, rawValue, false);
    return undefined;
  }
  const objectRule = asObject(rawValue);
  let explicitBudget: number | undefined;
  if (typeof objectRule?.maxTransitions === "number") {
    if (Number.isInteger(objectRule.maxTransitions) && objectRule.maxTransitions >= 1 && objectRule.maxTransitions <= 100) {
      explicitBudget = objectRule.maxTransitions;
    } else {
      // Out-of-range per-edge budget: preserve it and treat the edge as
      // unbounded (back-edges then require an explicit budget decision).
      recordUnmapped(plan, source.path, `${pointer}/maxTransitions`, objectRule.maxTransitions, false);
    }
  }
  const isBackEdge = targetIndex <= sourceIndex;
  if (isBackEdge && explicitBudget === undefined) {
    const chosen = resolveDecision(
      plan,
      `backedge:${context.workflowKey}:${stageKey}:${outcome}`,
      "transition-budget",
      source.path,
      `back-edge ${context.workflowId}/${stageId} -> ${targetId} (outcome ${outcome}) has no per-edge budget in legacy; KXM requires maxTransitions (1-100)`,
      [2, 3, 4, 5],
      decisions,
    );
    const budget = typeof chosen === "number" && Number.isInteger(chosen) && chosen >= 1 && chosen <= 100 ? chosen : 2;
    return { target: targetId, maxTransitions: budget };
  }
  if (explicitBudget !== undefined) return { target: targetId, maxTransitions: explicitBudget };
  return targetId;
}

function convertWorkflowFile(
  plan: MutablePlan,
  source: KxmLegacySource,
  decisions: Readonly<Record<string, JsonValue>>,
  agentIds: ReadonlyMap<string, JsonObject>,
  agentRawNames: ReadonlyMap<string, string>,
  pendingAgentRawNames: ReadonlySet<string>,
  rosterIdentityPending: boolean,
  workflowNames: Map<string, string>,
): Map<string, JsonObject> {
  const workflows = new Map<string, JsonObject>();
  const list = Array.isArray(source.value) ? source.value : [source.value];
  for (const [definitionIndex, entry] of list.entries()) {
    const definition = asObject(entry);
    const basePointer = Array.isArray(source.value) ? `/${definitionIndex}` : "";
    if (!definition) {
      recordUnmapped(plan, source.path, basePointer || "/", entry, false);
      continue;
    }
    recordUnknownFields(plan, source.path, basePointer, definition, KNOWN_WORKFLOW_FIELDS);
    const fileStem = source.path.slice(source.path.lastIndexOf("/") + 1).replace(/\.json$/u, "");
    const rawId = asString(definition.id) ?? `${fileStem}-${definitionIndex}`;
    const workflowIdentity = mapIdentity(plan, source.path, rawId, "workflow", workflowNames, decisions, basePointer || "/", definition);
    // An approved drop removes the workflow entirely; a pending identity
    // decision uses a reserved preview id so every downstream decision
    // (secrets, budgets, terminals) is still listed in this plan. The
    // placeholder can never be applied: its identity ambiguity blocks it.
    if (workflowIdentity.status === "dropped") continue;
    const workflowId = workflowIdentity.status === "adopted"
      ? workflowIdentity.id
      : `preview-${(normalizeIdentifier(rawId) || "unnamed").slice(0, 46).replace(/[-_]+$/u, "")}-${createHash("sha256").update(`${rawId}#${source.path}#${definitionIndex}`, "utf8").digest("hex").slice(0, 8)}`;
    const workflowKey = keyFragment(rawId);

    // Hub/webhook-specific fields have no KXM workflow equivalent; the
    // trigger surface is a later phase. Record them (secrets hashed).
    for (const field of ["source", "project", "event", "filter", "delivery", "ttlMs", "promptTemplate"] as const) {
      if (definition[field] !== undefined) recordUnmapped(plan, source.path, `${basePointer}/${field}`, definition[field], false);
    }
    for (const field of ["secret", "signalSecret", "secretEnv", "signalSecretEnv"] as const) {
      if (definition[field] !== undefined) {
        recordUnmapped(plan, source.path, `${basePointer}/${field}`, definition[field], true);
        resolveDecision(
          plan,
          `secret:${workflowKey}:${field}`,
          "secret-reference",
          source.path,
          `workflow ${workflowId} field ${field} configures a webhook secret; KXM workflows never embed secrets — confirm the field is dropped and re-granted through scoped secret references when the trigger surface lands`,
          ["drop"],
          decisions,
        );
      }
    }

    const rawTarget = asString(definition.target);
    const normalizedTarget = rawTarget ? normalizeIdentifier(rawTarget) : undefined;
    // Exact raw roster match first, then case-insensitive raw match; a bare
    // normalized lookup could silently bind a collision-renamed agent.
    let stepAgent = rawTarget !== undefined ? agentRawNames.get(rawTarget) : undefined;
    if (!stepAgent && rawTarget !== undefined && pendingAgentRawNames.has(rawTarget)) {
      // Exact pending-raw match wins over any adopted case-fold sibling.
      stepAgent = undefined;
    } else if (!stepAgent && rawTarget !== undefined) {
      const foldedTarget = rawTarget.toLocaleLowerCase("en-US");
      for (const [rawName, id] of agentRawNames) {
        if (rawName.toLocaleLowerCase("en-US") === foldedTarget) { stepAgent = id; break; }
      }
    }
    if (!stepAgent && agentRawNames.size === 0 && normalizedTarget && agentIds.has(normalizedTarget)) {
      // No roster: a normalized lookup cannot misbind a collision rename.
      stepAgent = normalizedTarget;
    }
    const targetIsPendingAgent = rawTarget !== undefined
      && [...pendingAgentRawNames].some((pending) => pending === rawTarget || pending.toLocaleLowerCase("en-US") === rawTarget.toLocaleLowerCase("en-US"));
    if (!stepAgent && targetIsPendingAgent) {
      // The target is a roster agent whose identity decision is still
      // pending: no separate coordinator decision (it would be unstable);
      // the placeholder binds by raw name once identities resolve.
      stepAgent = normalizedTarget && IDENTIFIER.test(normalizedTarget) && normalizedTarget.length <= 64 ? normalizedTarget : "coordinator";
    }
    if (!stepAgent) {
      if (agentIds.size === 0 && rosterIdentityPending) {
        // Every roster identity is still pending: the coordinator choice
        // resolves itself once the identity decisions land, so no separate
        // coordinator decision is offered (its ambiguity would be unstable).
        stepAgent = normalizedTarget && IDENTIFIER.test(normalizedTarget) && normalizedTarget.length <= 64 ? normalizedTarget : "coordinator";
      } else if (agentIds.size === 0) {
        const dropped = resolveDecision(
          plan,
          `coordinator:${workflowKey}`,
          "identity",
          source.path,
          `workflow ${workflowId} target ${JSON.stringify(rawTarget === undefined ? "" : elide(rawTarget, 200))} matches no migrated agent and the roster is empty; confirm the workflow is dropped`,
          ["drop"],
          decisions,
        );
        if (dropped === "drop") continue;
        stepAgent = normalizedTarget && IDENTIFIER.test(normalizedTarget) && normalizedTarget.length <= 64 ? normalizedTarget : "coordinator";
      } else {
        const chosen = resolveDecision(
          plan,
          `coordinator:${workflowKey}`,
          "identity",
          source.path,
          `workflow ${workflowId} target ${JSON.stringify(rawTarget === undefined ? "" : elide(rawTarget, 200))} is not a migrated agent; choose the roster agent that executes its steps`,
          [...agentIds.keys()].sort(compareCodeUnits).slice(0, 64),
          decisions,
        );
        if (typeof chosen === "string" && agentIds.has(chosen)) {
          stepAgent = chosen;
          if (rawTarget) plan.renames.push({ from: elide(rawTarget), to: chosen, kind: "agent" });
        } else {
          if (chosen !== undefined && !plan.invalidDecisions.includes(`coordinator:${workflowKey}`)) {
            plan.invalidDecisions.push(`coordinator:${workflowKey}`);
          }
          if (chosen !== undefined && !plan.ambiguities.some((ambiguity) => ambiguity.key === `coordinator:${workflowKey}`)) {
            plan.ambiguities.push({
              key: `coordinator:${workflowKey}`,
              category: "identity",
              sourcePath: source.path,
              message: `decision value ${JSON.stringify(typeof chosen === "string" ? elide(chosen, 200) : chosen)} for workflow ${workflowId} is not a migrated agent`,
              allowedValues: [...agentIds.keys()].sort(compareCodeUnits).slice(0, 64),
            });
          }
          // Preview placeholder: keep converting so every downstream decision
          // (terminal status, budgets, policies) is already listed in this
          // plan. Semantic validation only gates the fully resolved plan.
          stepAgent = normalizedTarget && IDENTIFIER.test(normalizedTarget) && normalizedTarget.length <= 64 ? normalizedTarget : "coordinator";
        }
      }
    }

    const rawStages = Array.isArray(definition.stages) ? definition.stages : [];
    const stageIds: string[] = [];
    const stageRename = new Map<string, string>();
    const stepIdByIndex = new Map<number, string>();
    const stageKeyByRaw = new Map<string, string>();
    const droppedStageIndexes = new Set<number>();
    const takenSteps = new Map<string, string>();
    for (const [stageIndex, stageEntry] of rawStages.entries()) {
      const stage = asObject(stageEntry);
      if (!stage) {
        recordUnmapped(plan, source.path, `${basePointer}/stages/${stageIndex}`, stageEntry, false);
        droppedStageIndexes.add(stageIndex);
        continue;
      }
      const rawStageId = asString(stage.id);
      if (!rawStageId) {
        recordUnmapped(plan, source.path, `${basePointer}/stages/${stageIndex}`, stage, false);
        droppedStageIndexes.add(stageIndex);
        continue;
      }
      // An approved drop removes the stage; a pending step identity decision
      // uses a preview id (unique per stage index) so its transitions and
      // evidence still register in this plan.
      const stepIdentity = mapIdentity(plan, source.path, rawStageId, "step", takenSteps, decisions, `${basePointer}/stages/${stageIndex}`, stage);
      if (stepIdentity.status === "dropped") {
        droppedStageIndexes.add(stageIndex);
        continue;
      }
      const stepId = stepIdentity.status === "adopted" ? stepIdentity.id : `preview-${(normalizeIdentifier(rawStageId) || "unnamed").slice(0, 46).replace(/[-_]+$/u, "")}-${createHash("sha256").update(`${rawStageId}#${stageIndex}`, "utf8").digest("hex").slice(0, 8)}`;
      const stepKey = keyFragment(rawStageId);
      stageKeyByRaw.set(rawStageId, stepKey);
      // Instruction-less stages are excluded up front (with their drop
      // decision registered here) so explicit edges and the default passed
      // edge flow through the transition-target drop decision and skip to the
      // next surviving stage.
      if (!asString(stage.instructions)) {
        resolveDecision(
          plan,
          `instructions:${workflowKey}:${stepKey}`,
          "unsupported",
          source.path,
          `stage ${stepId} has no instructions; KXM agent steps require executable instructions — confirm the stage is dropped`,
          ["drop"],
          decisions,
        );
        recordUnmapped(plan, source.path, `${basePointer}/stages/${stageIndex}`, stage, false);
        droppedStageIndexes.add(stageIndex);
        continue;
      }
      if (!stageRename.has(rawStageId)) stageRename.set(rawStageId, stepId);
      stepIdByIndex.set(stageIndex, stepId);
      stageIds.push(stepId);
    }
    const context: StageContext = { workflowId, workflowKey, stageIds, renamesByKind: stageRename };

    const steps: JsonObject[] = [];
    for (const [stageIndex, stageEntry] of rawStages.entries()) {
      if (droppedStageIndexes.has(stageIndex)) continue;
      const stage = asObject(stageEntry);
      if (!stage) continue;
      const rawStageId = asString(stage.id);
      if (!rawStageId) continue;
      const stepId = stepIdByIndex.get(stageIndex);
      if (!stepId) continue;
      const stepKey = stageKeyByRaw.get(rawStageId) ?? keyFragment(rawStageId);
      const pointer = `${basePointer}/stages/${stageIndex}`;
      recordUnknownFields(plan, source.path, pointer, stage, KNOWN_STAGE_FIELDS);
      const label = asString(stage.label);
      const instructions = asString(stage.instructions);
      if (!instructions) continue; // excluded in the pre-pass above
      const step: JsonObject = {
        id: stepId,
        kind: "agent",
        agent: stepAgent,
      };
      if (label) step.description = label;
      let maxAttempts = 3;
      if (typeof stage.maxAttempts === "number" && Number.isInteger(stage.maxAttempts) && stage.maxAttempts >= 1 && stage.maxAttempts <= 20) {
        maxAttempts = stage.maxAttempts;
      } else if (stage.maxAttempts !== undefined) {
        // Out-of-range or non-numeric: preserve and use the legacy default.
        recordUnmapped(plan, source.path, `${pointer}/maxAttempts`, stage.maxAttempts, false);
      }
      step.maxAttempts = maxAttempts;
      step.instructions = instructions;

      const requiredEvidence: JsonObject[] = [];
      const policyProducers = new Set<string>();
      let policyProducerMinimum = 0;
      const rawEvidence = Array.isArray(stage.requiredEvidence) ? stage.requiredEvidence : [];
      const seenKeys = new Set<string>();
      for (const [evidenceIndex, evidenceEntry] of rawEvidence.entries()) {
        const rawKey = asString(evidenceEntry);
        if (!rawKey) {
          recordUnmapped(plan, source.path, `${pointer}/requiredEvidence/${evidenceIndex}`, evidenceEntry, false);
          continue;
        }
        const key = normalizeIdentifier(rawKey);
        if (!IDENTIFIER.test(key) || key.length > 64) {
          recordUnmapped(plan, source.path, `${pointer}/requiredEvidence/${evidenceIndex}`, evidenceEntry, false);
          continue;
        }
        if (seenKeys.has(key)) {
          recordUnmapped(plan, source.path, `${pointer}/requiredEvidence/${evidenceIndex}`, evidenceEntry, false);
          continue;
        }
        if (key !== rawKey) plan.renames.push({ from: elide(rawKey), to: key, kind: "evidence" });
        seenKeys.add(key);
        requiredEvidence.push({ key, kind: "assignment-result" });
      }
      const policies = asObject(stage.evidencePolicies as JsonValue | undefined);
      if (policies) {
        const seenPolicies = new Set<string>();
        for (const [rawPolicyKey, policyEntry] of Object.entries(policies).sort(([left], [right]) => compareCodeUnits(left, right))) {
          const policy = asObject(policyEntry);
          const policyKey = normalizeIdentifier(rawPolicyKey);
          if (seenPolicies.has(policyKey)) {
            recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}`, policyEntry, false);
            continue;
          }
          seenPolicies.add(policyKey);
          const requirement = requiredEvidence.find((candidate) => candidate.key === policyKey);
          if (!policy || !requirement) {
            recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}`, policyEntry, false);
            continue;
          }
          recordUnknownFields(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}`, policy, KNOWN_POLICY_FIELDS);
          let minProducers = 1;
          if (typeof policy.minProducers === "number" && Number.isInteger(policy.minProducers) && policy.minProducers >= 1 && policy.minProducers <= 16) {
            minProducers = policy.minProducers;
          } else if (policy.minProducers !== undefined) {
            recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}/minProducers`, policy.minProducers, false);
          }
          if (policy.eligibleAgents !== undefined && !Array.isArray(policy.eligibleAgents)) {
            recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}/eligibleAgents`, policy.eligibleAgents, false);
          }
          const eligible = Array.isArray(policy.eligibleAgents) ? policy.eligibleAgents : [];
          const eligibleIds: string[] = [];
          for (const [eligibleIndex, candidate] of eligible.entries()) {
            const rawName = asString(candidate);
            if (!rawName) {
              recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}/eligibleAgents/${eligibleIndex}`, candidate, false);
              continue;
            }
            const rawBound = pendingAgentRawNames.has(rawName)
              ? undefined
              : agentRawNames.get(rawName)
                ?? [...agentRawNames].find(([candidateName]) => candidateName.toLocaleLowerCase("en-US") === rawName.toLocaleLowerCase("en-US"))?.[1];
            if (rawBound) {
              if (!eligibleIds.includes(rawBound)) eligibleIds.push(rawBound);
              continue;
            }
            if ([...pendingAgentRawNames].some((pending) => pending === rawName || pending.toLocaleLowerCase("en-US") === rawName.toLocaleLowerCase("en-US"))) {
              // The producer is a roster agent whose identity is pending; it
              // binds by raw name once identities resolve. Preview with the
              // normalized form so policy decisions still register.
              const previewId = normalizeIdentifier(rawName);
              if (IDENTIFIER.test(previewId) && previewId.length <= 64 && !eligibleIds.includes(previewId)) {
                eligibleIds.push(previewId);
              }
              continue;
            }
            const normalized = normalizeIdentifier(rawName);
            if (agentRawNames.size === 0 && agentIds.has(normalized)) {
              // Empty roster map means no agents.json: allow the plain
              // normalized lookup (no rename collisions are possible).
              if (!eligibleIds.includes(normalized)) eligibleIds.push(normalized);
              continue;
            }
            if (agentIds.size === 0) {
              recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}/eligibleAgents/${eligibleIndex}`, candidate, false);
              continue;
            }
            const mapped = resolveDecision(
              plan,
              `producer:${workflowKey}:${stepKey}:${keyFragment(rawName)}`,
              "evidence-policy",
              source.path,
              `evidence policy on ${stepId}.${policyKey} names producer ${JSON.stringify(elide(rawName, 200))} which is not a migrated agent; choose the roster agent that takes this producer role`,
              [...agentIds.keys()].sort(compareCodeUnits).slice(0, 64),
              decisions,
            );
            if (typeof mapped === "string" && agentIds.has(mapped)) {
              plan.renames.push({ from: elide(rawName), to: mapped, kind: "agent" });
              if (!eligibleIds.includes(mapped)) eligibleIds.push(mapped);
            } else if (mapped !== undefined) {
              if (!plan.invalidDecisions.includes(`producer:${workflowKey}:${stepKey}:${keyFragment(rawName)}`)) {
                plan.invalidDecisions.push(`producer:${workflowKey}:${stepKey}:${keyFragment(rawName)}`);
              }
              if (!plan.ambiguities.some((ambiguity) => ambiguity.key === `producer:${workflowKey}:${stepKey}:${keyFragment(rawName)}`)) {
              plan.ambiguities.push({
                key: `producer:${workflowKey}:${stepKey}:${keyFragment(rawName)}`,
                category: "evidence-policy",
                sourcePath: source.path,
                message: `decision value ${JSON.stringify(typeof mapped === "string" ? elide(mapped, 200) : mapped)} for producer ${JSON.stringify(elide(rawName, 200))} is not a migrated agent`,
                allowedValues: [...agentIds.keys()].sort(compareCodeUnits).slice(0, 64),
              });
              }
            }
          }
          const acceptedStatusesMalformed = policy.acceptedStatuses !== undefined && !Array.isArray(policy.acceptedStatuses);
          if (acceptedStatusesMalformed) {
            recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}/acceptedStatuses`, policy.acceptedStatuses, false);
          }
          const accepted = acceptedStatusesMalformed ? [] : (Array.isArray(policy.acceptedStatuses) ? policy.acceptedStatuses : ["replied"]);
          if (Array.isArray(policy.acceptedStatuses) && policy.acceptedStatuses.length === 0) {
            recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}/acceptedStatuses`, policy.acceptedStatuses, false);
          }
          let acceptedStatuses: string[] | undefined = accepted.length > 0 && accepted.every((status) => status === "replied") ? ["passed"] : undefined;
          if (!acceptedStatuses) {
            const chosen = resolveDecision(
              plan,
              `statuses:${workflowKey}:${stepKey}:${policyKey}`,
              "evidence-policy",
              source.path,
              acceptedStatusesMalformed
                ? `evidence policy ${policyKey} acceptedStatuses is malformed (not an array) and was preserved in the report; confirm mapping the policy to KXM 'passed'`
                : `evidence policy ${policyKey} accepted statuses ${JSON.stringify(elide(accepted.map((candidate) => String(candidate)).join(","), 200))} cannot map losslessly; confirm mapping to KXM 'passed'`,
              ["passed"],
              decisions,
            );
            if (chosen === "passed") acceptedStatuses = ["passed"];
          }
          if (acceptedStatuses) {
            // Register the strengthening decision whenever the policy's
            // statuses map, even before producers resolve, so the first plan
            // already lists every required decision key.
            plan.permissionChanges.push({
              sourcePath: source.path,
              targetPath: `.kxm/workflows/${workflowId}.yaml`,
              direction: "narrowing",
              summary: `evidence ${policyKey} on ${stepId}: legacy peer-reply policy (status 'replied') migrates to assignment-result producer policy requiring 'passed'`,
              decisionKey: `evidence:${workflowKey}:${stepKey}:${policyKey}`,
            });
            plan.permissionChanges.push({
              sourcePath: source.path,
              targetPath: `.kxm/workflows/${workflowId}.yaml`,
              direction: "expansion",
              summary: `step ${stepId}: assignment pool widens from the single legacy coordinator to coordinator plus evidence producers so KXM producer evidence stays in scope`,
              decisionKey: `evidence:${workflowKey}:${stepKey}:${policyKey}`,
            });
            resolveDecision(
              plan,
              `evidence:${workflowKey}:${stepKey}:${policyKey}`,
              "evidence-policy",
              source.path,
              `approve strengthening ${stepId}.${policyKey} from 'peer replied' to 'peer assignment passed' and widening the step assignment pool to include the producers`,
              ["approve"],
              decisions,
            );
          }
          if (eligibleIds.length > 0 && acceptedStatuses) {
            requirement.kind = "assignment-result";
            requirement.producerPolicy = {
              minimumProducers: minProducers,
              eligibleAgents: eligibleIds,
              acceptedStatuses,
            };
            for (const producer of eligibleIds) policyProducers.add(producer);
            policyProducerMinimum = Math.max(policyProducerMinimum, minProducers);
            const degradation = asObject(policy.degradation as JsonValue | undefined);
            if (degradation && degradation.minProducers !== undefined) {
              if (typeof degradation.minProducers === "number" && Number.isInteger(degradation.minProducers)
                && degradation.minProducers >= 1 && degradation.minProducers <= 15 && degradation.minProducers < minProducers) {
                (requirement.producerPolicy as JsonObject).degradation = { minimumProducers: degradation.minProducers };
              } else {
                recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}/degradation`, policy.degradation as JsonValue, false);
              }
            }
          } else {
            // The policy could not be honored (unresolved producers or
            // unmappable statuses); preserve it in the report.
            recordUnmapped(plan, source.path, `${pointer}/evidencePolicies/${pointerEscape(rawPolicyKey)}`, policyEntry, false);
          }
        }
      }
      if (requiredEvidence.length > 0) step.requiredEvidence = requiredEvidence;
      if (policyProducers.size > 0) {
        // KXM evidence producers must execute within the step assignment
        // pool: widen it beyond the legacy single-coordinator shape.
        const pool = [stepAgent, ...[...policyProducers].filter((candidate) => candidate !== stepAgent).sort(compareCodeUnits)];
        step.assignments = {
          allowedAgents: pool,
          minimum: 1,
          target: Math.max(1, policyProducerMinimum),
          maximum: pool.length,
          maxParallel: pool.length,
        };
      }

      const on = asObject(stage.on as JsonValue | undefined);
      const transitions: JsonObject = {};
      if (on) {
        const seenOutcomes = new Set<string>();
        for (const [rawOutcome, rawTransition] of Object.entries(on).sort(([left], [right]) => compareCodeUnits(left, right))) {
          const outcome = normalizeIdentifier(rawOutcome);
          if (!IDENTIFIER.test(outcome) || outcome.length > 64) {
            recordUnmapped(plan, source.path, `${pointer}/on/${pointerEscape(rawOutcome)}`, rawTransition, false);
            continue;
          }
          if (seenOutcomes.has(outcome)) {
            // Two legacy outcome keys normalize to the same KXM outcome;
            // never merge their edges last-wins.
            recordUnmapped(plan, source.path, `${pointer}/on/${pointerEscape(rawOutcome)}`, rawTransition, false);
            continue;
          }
          seenOutcomes.add(outcome);
          if (outcome !== rawOutcome) plan.renames.push({ from: elide(rawOutcome), to: outcome, kind: "outcome" });
          const converted = convertTransition(plan, source, context, stepId, stepKey, outcome, rawOutcome, rawTransition, decisions, pointer);
          if (converted !== undefined) transitions[outcome] = converted;
        }
        // v0.4 semantics: an undeclared (or decision-dropped) passed outcome
        // keeps the default edge to the next surviving stage.
        if (transitions.passed === undefined) {
          const nextId = stageIds[stageIds.indexOf(stepId) + 1];
          transitions.passed = nextId ?? { target: "$terminal", terminalStatus: "completed" };
        }
      } else {
        // v0.4 default edges: passed -> next stage (or completed), failure
        // retries within maxAttempts then fails the run.
        const nextId = stageIds[stageIds.indexOf(stepId) + 1];
        transitions.passed = nextId ?? { target: "$terminal", terminalStatus: "completed" };
      }
      step.on = transitions;
      if (typeof stage.maxTransitions === "number") {
        // Legacy per-stage transition budgets have no KXM equivalent;
        // per-edge budgets and the global limit cover the same bound.
        recordUnmapped(plan, source.path, `${pointer}/maxTransitions`, stage.maxTransitions, false);
      }
      if (stage.area !== undefined) recordUnmapped(plan, source.path, `${pointer}/area`, stage.area, false);
      steps.push(step);
    }

    if (steps.length === 0) {
      resolveDecision(
        plan,
        `stages:${workflowKey}`,
        "unsupported",
        source.path,
        `workflow ${workflowId} produced no convertible steps; confirm it is dropped`,
        ["drop"],
        decisions,
      );
      continue;
    }

    const workflow: JsonObject = {
      schema: "kxm.workflow.v1",
      coordinator: stepAgent,
      steps,
    };
    if (typeof definition.maxTransitions === "number" && Number.isInteger(definition.maxTransitions) && definition.maxTransitions >= 1 && definition.maxTransitions <= 1000) {
      workflow.limits = { maxTransitions: definition.maxTransitions };
    } else if (definition.maxTransitions !== undefined) {
      recordUnmapped(plan, source.path, `${basePointer}/maxTransitions`, definition.maxTransitions, false);
    }
    if (workflow.limits === undefined) {
      // KXM requires a global budget whenever any back-edge exists.
      const hasBackEdge = steps.some((step) => Object.values(asObject(step.on as JsonValue) ?? {}).some((rule) => {
        const target = typeof rule === "string" ? rule : asObject(rule)?.target;
        return typeof target === "string" && target !== "$terminal" && stageIds.indexOf(target) <= stageIds.indexOf(String(step.id));
      }));
      if (hasBackEdge) {
        const chosen = resolveDecision(
          plan,
          `budget:${workflowKey}`,
          "transition-budget",
          source.path,
          `workflow ${workflowId} has back-edges but no legacy global maxTransitions; KXM requires limits.maxTransitions (1-1000)`,
          [28],
          decisions,
        );
        workflow.limits = { maxTransitions: typeof chosen === "number" && Number.isInteger(chosen) && chosen >= 1 && chosen <= 1000 ? chosen : 28 };
      }
    }
    for (const oracleField of ["reproOracle", "planHash"] as const) {
      const oracle = asObject(definition[oracleField] as JsonValue | undefined);
      if (!oracle) continue;
      const oracleStage = asString(oracle.stageId);
      const oracleEvidence = asString(oracle.evidenceKey);
      if (!oracleStage || !oracleEvidence) {
        recordUnmapped(plan, source.path, `${basePointer}/${oracleField}`, definition[oracleField], false);
        continue;
      }
      const mappedStage = context.renamesByKind.get(oracleStage);
      if (!mappedStage) {
        // The referenced stage did not survive conversion (dropped by
        // decision or unconvertible); preserve the oracle and omit it rather
        // than hard-failing the fully-decided plan.
        if (!context.stageIds.includes(normalizeIdentifier(oracleStage))) {
          recordUnmapped(plan, source.path, `${basePointer}/${oracleField}`, definition[oracleField], false);
          continue;
        }
      }
      workflow[oracleField] = {
        stageId: mappedStage ?? normalizeIdentifier(oracleStage),
        evidenceKey: normalizeIdentifier(oracleEvidence),
      };
    }
    if (Array.isArray(definition.requirePlanHash)) {
      const mapped: string[] = [];
      for (const [requireIndex, candidate] of definition.requirePlanHash.entries()) {
        const rawStage = asString(candidate);
        if (!rawStage) {
          recordUnmapped(plan, source.path, `${basePointer}/requirePlanHash/${requireIndex}`, candidate, false);
          continue;
        }
        const mappedStage = context.renamesByKind.get(rawStage);
        if (!mappedStage && !context.stageIds.includes(normalizeIdentifier(rawStage))) {
          recordUnmapped(plan, source.path, `${basePointer}/requirePlanHash/${requireIndex}`, candidate, false);
          continue;
        }
        mapped.push(mappedStage ?? normalizeIdentifier(rawStage));
      }
      if (mapped.length > 0) workflow.requirePlanHash = [...new Set(mapped)].sort(compareCodeUnits);
    }
    workflows.set(workflowId, workflow);
  }
  return workflows;
}

/* ------------------------- plan assembly -------------------------- */

export interface KxmMigrationPlanResult {
  plan: JsonObject;
  resources: Map<string, JsonObject>;
  ambiguities: readonly KxmMigrationAmbiguity[];
  decisionKeys: ReadonlySet<string>;
  decisionAllowedValues: ReadonlyMap<string, readonly (string | number)[]>;
  invalidDecisions: readonly string[];
  decisions: Readonly<Record<string, JsonValue>>;
  sources: readonly KxmLegacySource[];
}

export interface KxmMigrationOptions extends KxmConfigOptions {
  decisions?: Readonly<Record<string, JsonValue>>;
  projectId?: string;
  projectName?: string;
}

const PROJECT_ID = /^prj_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

function sortedRecord<T>(map: ReadonlyMap<string, T>, prefix: string): Map<string, T> {
  return new Map([...map.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([key, value]) => [`${prefix}${key}.yaml`, value] as [string, T]));
}

/** Resolve the authoritative Git worktree root for migration commands. */
function migrationGitRoot(start: string): string {
  const root = discoverGitRoot(start);
  if (!root) {
    throw new KxmConfigError([migrateIssue("discovery", "git_root_required", ".", "kxm migrate must run inside the authoritative Git worktree")]);
  }
  return root;
}

/** Convert legacy configuration into a deterministic, schema-shaped migration plan. */
export function planKxmMigration(projectRoot: string, options: KxmMigrationOptions = {}): KxmMigrationPlanResult {
  const root = migrationGitRoot(projectRoot);
  const registry = new KxmSchemaRegistry(options.schemasDir);
  const sources = readKxmLegacySources(root);
  if (sources.length === 0) {
    throw new KxmConfigError([migrateIssue("discovery", "legacy_sources_missing", ".kxm/config", "no legacy configuration files found to migrate")]);
  }
  const decisions = options.decisions ?? {};
  const plan: MutablePlan = { ambiguities: [], invalidDecisions: [], decisionKeys: new Set(), decisionAllowedValues: new Map(), unmapped: [], renames: [], permissionChanges: [] };
  const agentNames = new Map<string, string>();
  const workflowNames = new Map<string, string>();

  const agentsSource = sources.find((source) => source.path === ".kxm/config/agents.json");
  const gatesSource = sources.find((source) => source.path === ".kxm/config/gates.json");
  const converted = agentsSource
    ? convertAgentsRoster(plan, agentsSource, decisions, agentNames)
    : { agents: new Map<string, JsonObject>(), models: new Map<string, JsonObject>(), rawNames: new Map<string, string>(), pendingRawNames: new Set<string>(), identityPending: false };
  if (!agentsSource) {
    resolveDecision(
      plan,
      "agents-missing",
      "unsupported",
      ".kxm/config/agents.json",
      "no agents.json roster; workflows convert against an empty agent set — confirm conversion continues",
      ["continue"],
      decisions,
    );
  }
  if (gatesSource) convertGatesRoster(plan, gatesSource, decisions);

  const workflows = new Map<string, JsonObject>();
  for (const source of sources) {
    if (!source.path.startsWith(".kxm/config/workflows/")) continue;
    const convertedWorkflows = convertWorkflowFile(
      plan,
      source,
      decisions,
      converted.agents,
      converted.rawNames,
      converted.pendingRawNames,
      converted.identityPending,
      workflowNames,
    );
    for (const [id, workflow] of convertedWorkflows) workflows.set(id, workflow);
  }

  const projectId = options.projectId ?? `prj_mig${sha256Of(legacySourceDigest(sources)).slice(7, 39)}`;
  if (!PROJECT_ID.test(projectId)) {
    throw new KxmConfigError([migrateIssue("semantic", "project_id_invalid", ".kxm/project.yaml", "project ID must satisfy the kxm.project.v1 opaque ID grammar and use the prj_ prefix")]);
  }
  const projectName = options.projectName ?? "Migrated legacy project";
  if (projectName.length < 1 || projectName.length > 120 || /[\u0000\r\n]/.test(projectName)) {
    throw new KxmConfigError([migrateIssue("semantic", "project_name_invalid", ".kxm/project.yaml", "project name must contain 1-120 characters on one line")]);
  }

  const resources = new Map<string, JsonObject>();
  resources.set(".kxm/project.yaml", {
    schema: "kxm.project.v1",
    id: projectId,
    name: projectName,
    ...(workflows.size > 0 ? { defaultWorkflow: [...workflows.keys()].sort(compareCodeUnits)[0] } : {}),
    defaultExecutor: "local",
    repositories: [{ id: "control", role: "control", required: true, pathHint: "." }],
    workspace: {
      dirtySnapshot: {
        untracked: "ask",
        dirtySubmodules: "fail",
      },
    },
  });
  resources.set(".kxm/repo/repo.yaml", {
    schema: "kxm.repository.v1",
    projectId,
    repositoryId: "control",
    description: "Authoritative project configuration and repository content.",
    defaultAccess: "write",
  });
  for (const [path, value] of sortedRecord(converted.agents, ".kxm/agents/")) resources.set(path, value);
  for (const [path, value] of sortedRecord(converted.models, ".kxm/models/")) resources.set(path, value);
  for (const [path, value] of sortedRecord(workflows, ".kxm/workflows/")) resources.set(path, value);

  // Validate every converted resource against its exact schema before the
  // plan is considered applicable.
  const schemaIssues: KxmConfigIssue[] = [];
  const kindOf = (path: string): KxmResourceKind => path === ".kxm/project.yaml" ? "project"
    : path.endsWith("repo.yaml") ? "repository"
    : path.startsWith(".kxm/agents/") ? "agent"
    : path.startsWith(".kxm/models/") ? "model"
    : "workflow";
  const idOf = (path: string): string | undefined => path === ".kxm/project.yaml" || path.endsWith("repo.yaml")
    ? undefined
    : path.slice(path.lastIndexOf("/") + 1, -".yaml".length);
  const semanticResources = new Map<string, { kind: KxmResourceKind; id?: string; value: JsonObject }>();
  for (const [path, value] of [...resources.entries()].sort(([left], [right]) => compareCodeUnits(left, right))) {
    const kind = kindOf(path);
    schemaIssues.push(...registry.validate(kind, value, path));
    const id = idOf(path);
    semanticResources.set(path, kind === "repository" ? { kind, id: "control", value } : { kind, ...(id === undefined ? {} : { id }), value });
  }
  if (schemaIssues.length > 0) throw new KxmConfigError(schemaIssues);
  // Full semantic validation gates a resolved plan: while ambiguities remain,
  // the intermediate resource set may legitimately be incomplete (for example
  // a workflow whose coordinator decision is still pending), and the operator
  // needs the plan listing those ambiguities rather than a validation error.
  // Apply always re-plans and requires zero ambiguities, so this check still
  // runs before any write.
  if (plan.ambiguities.length === 0) {
    const semanticIssues = validateKxmResources(semanticResources, options);
    if (semanticIssues.length > 0) throw new KxmConfigError(semanticIssues);
  }

  const planRecord: JsonObject = {
    schema: "kxm.migration-plan.v1",
    projectId,
    projectName,
    sourceDigest: legacySourceDigest(sources),
    sources: sources.map((source) => ({ path: source.path, sha256: source.sha256, bytes: source.bytes })),
    resources: [...resources.keys()].sort(compareCodeUnits).map((path) => {
      const bytes = Buffer.from(stringify(resources.get(path), { lineWidth: 0 }), "utf8");
      return { path, sha256: sha256Of(bytes), bytes: bytes.byteLength };
    }),
    ambiguities: [...plan.ambiguities].sort((left, right) => compareCodeUnits(left.key, right.key)).map((ambiguity) => ({
      key: ambiguity.key,
      category: ambiguity.category,
      sourcePath: ambiguity.sourcePath,
      message: ambiguity.message,
      allowedValues: [...ambiguity.allowedValues],
    })),
    unmapped: [...plan.unmapped].sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath) || compareCodeUnits(left.jsonPointer, right.jsonPointer)).map((entry) => ({ ...entry })),
    renames: [...new Map(plan.renames.map((rename) => [JSON.stringify([rename.kind, rename.from, rename.to]), rename])).values()]
      .sort((left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.from, right.from))
      .map((entry) => ({ ...entry })),
    permissionChanges: [...plan.permissionChanges].sort((left, right) => compareCodeUnits(left.decisionKey, right.decisionKey)).map((entry) => ({ ...entry })),
    canApply: plan.ambiguities.length === 0,
  };
  const planIssues = registry.validateMigrationPlan(planRecord, "kxm.migration-plan.v1");
  if (planIssues.length > 0) throw new KxmConfigError(planIssues);

  return {
    plan: planRecord,
    resources,
    ambiguities: plan.ambiguities,
    decisionKeys: plan.decisionKeys,
    decisionAllowedValues: plan.decisionAllowedValues,
    invalidDecisions: plan.invalidDecisions,
    decisions,
    sources,
  };
}

/* ------------------------- decisions file -------------------------- */

export function readKxmMigrationDecisions(path: string, schemasDir?: string): JsonObject {
  if (!existsSync(path)) {
    throw new KxmConfigError([migrateIssue("discovery", "decisions_missing", path, "migration decisions file does not exist")]);
  }
  const registry = new KxmSchemaRegistry(schemasDir);
  const value = parseRestrictedYaml(readFileSync(path), path);
  const issues = registry.validateMigrationDecision(value, path);
  if (issues.length > 0) throw new KxmConfigError(issues);
  return value;
}

function resolutionsOf(decisions: JsonObject): Record<string, JsonValue> {
  const resolutions = decisions.resolutions;
  if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)) return {};
  return { ...(resolutions as JsonObject) };
}

/* ------------------------- apply / verify -------------------------- */

export interface KxmMigrationApplyResult {
  action: "applied" | "planned" | "already-migrated";
  projectRoot: string;
  receiptPath?: string;
  configRevision?: string;
  files: readonly string[];
  plan?: JsonObject;
}

export interface KxmMigrationApplyOptions extends KxmMigrationOptions {
  dryRun?: boolean;
  decisionsFile?: string;
  localStateRoot?: string;
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeDurable(path: string, content: Buffer): void {
  const temp = `${path}.kxm-migration-tmp-${process.pid}-${createHash("sha256").update(`${path}${Date.now()}${Math.random()}`, "utf8").digest("hex").slice(0, 12)}`;
  let created = false;
  try {
    const descriptor = openSync(temp, "wx", 0o600);
    created = true;
    try {
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temp, path);
    try { chmodSync(path, 0o600); } catch { /* Windows may ignore modes. */ }
    syncDirectory(join(path, ".."));
  } finally {
    if (created && existsSync(temp)) rmSync(temp, { force: true });
  }
}

/** Apply a reviewed migration: stage, validate the complete target, install, and receipt. */
export function applyKxmMigration(projectRoot: string, options: KxmMigrationApplyOptions = {}): KxmMigrationApplyResult {
  const root = migrationGitRoot(projectRoot);
  const storeOptions: KxmLocalBindingStoreOptions = {
    ...(options.localStateRoot === undefined ? {} : { stateRoot: options.localStateRoot }),
    ...(options.schemasDir === undefined ? {} : { schemasDir: options.schemasDir }),
  };

  const execute = (lock: KxmLocalBindingLock | undefined): KxmMigrationApplyResult => {
    const receiptAbsolute = join(root, ...KXM_MIGRATION_RECEIPT_PATH.split("/"));
    // Already-migrated detection precedes planning and decision checks: a
    // validated receipt makes re-apply an idempotent no-op even when legacy
    // sources were later removed or no decisions are supplied.
    if (existsSync(receiptAbsolute)) {
      const stat = lstatSync(receiptAbsolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new KxmConfigError([migrateIssue("path", "migration_receipt_invalid", KXM_MIGRATION_RECEIPT_PATH, "migration receipt must be a regular file, not a link")]);
      }
      const existing = loadKxmProject(root, options);
      return {
        action: "already-migrated",
        projectRoot: root,
        receiptPath: KXM_MIGRATION_RECEIPT_PATH,
        configRevision: existing.configRevision,
        files: [],
      };
    }

    const decisionsRecord = options.decisionsFile ? readKxmMigrationDecisions(options.decisionsFile, options.schemasDir) : undefined;
    const decisions = decisionsRecord ? resolutionsOf(decisionsRecord) : (options.decisions ?? {});
    // Plan once with the real decisions: resolveDecision validates every
    // supplied value inline, so an invalid value can never masquerade as a
    // semantic plan error. A second decision-free plan enumerates the
    // universe the operator reviewed; decision keys are accepted from the
    // union of both plans because binding decisions (coordinator, identities)
    // can make plan-1 keys unnecessary without invalidating the review.
    const first = planKxmMigration(root, { ...options, decisions });
    if (decisionsRecord) {
      if (decisionsRecord.projectId !== first.plan.projectId) {
        throw new KxmConfigError([migrateIssue("semantic", "decision_project_mismatch", options.decisionsFile ?? "<decisions>", "decisions file projectId does not match the recomputed plan")]);
      }
      if (decisionsRecord.projectName !== first.plan.projectName) {
        throw new KxmConfigError([migrateIssue("semantic", "decision_project_mismatch", options.decisionsFile ?? "<decisions>", "decisions file projectName does not match the recomputed plan")]);
      }
      if (decisionsRecord.sourceDigest !== first.plan.sourceDigest) {
        throw new KxmConfigError([migrateIssue("semantic", "decision_source_changed", options.decisionsFile ?? "<decisions>", "legacy sources changed after the decisions file was reviewed")]);
      }
    }
    if (Object.keys(decisions).length > 0) {
      // Keys decided-plan registered were validated inline by resolveDecision.
      // Keys only the undecided universe registered (reviewed but now no-ops,
      // e.g. a coordinator choice superseded by a raw-name binding) are
      // validated against the universe's allowed values here. Anything else
      // was never part of any review.
      const universe = planKxmMigration(root, { ...options, decisions: {} });
      const unknown: string[] = [];
      const invalid: string[] = [];
      for (const [key, value] of Object.entries(decisions)) {
        if (first.decisionKeys.has(key)) continue;
        const universeAllowed = universe.decisionAllowedValues.get(key);
        if (!universeAllowed) {
          unknown.push(key);
        } else if (!decisionValueAllowed(key, value, universeAllowed)) {
          invalid.push(key);
        }
      }
      if (unknown.length > 0) {
        throw new KxmConfigError(unknown.sort(compareCodeUnits).map((key) => migrateIssue("semantic", "decision_unknown", key, "decision key does not match any current ambiguity")));
      }
      const allInvalid = [...new Set([...invalid, ...first.invalidDecisions])].sort(compareCodeUnits);
      if (allInvalid.length > 0) {
        throw new KxmConfigError(allInvalid.map((key) => migrateIssue("semantic", "decision_value_invalid", key, "decision value is not one of the plan's allowed values")));
      }
    }
    if (first.ambiguities.length > 0) {
      return { action: "planned", projectRoot: root, files: [], plan: first.plan };
    }

    const files = [...first.resources.entries()].sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([path, value]) => ({ path, bytes: Buffer.from(stringify(value, { lineWidth: 0 }), "utf8") }));
    // Refuse to overwrite any existing KXM state or legacy inputs.
    const collisions = files.filter((file) => existsSync(join(root, ...file.path.split("/"))));
    if (collisions.length > 0) {
      throw new KxmConfigError(collisions.map((file) => migrateIssue("semantic", "migration_target_exists", file.path, "target resource already exists; refusing to overwrite")));
    }
    // Never write through a linked or non-directory parent component: walk
    // every target parent from the project root before the first write.
    const parentIssues: KxmConfigIssue[] = [];
    for (const file of files) {
      const segments = file.path.split("/");
      let current = root;
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        if (!existsSync(current)) continue;
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          parentIssues.push(migrateIssue("path", "migration_target_parent_invalid", file.path, `migration target parent ${segment} must be a regular directory, not a link`));
          break;
        }
      }
    }
    if (parentIssues.length > 0) throw new KxmConfigError(parentIssues);

    if (options.dryRun) {
      // Preflight is complete (decisions, collisions, linked parents); a
      // real apply would proceed past this point.
      return { action: "planned", projectRoot: root, files: files.map((file) => file.path), plan: first.plan };
    }
    if (!lock) throw new Error("project mutation lock is required to apply a migration");

    const written: string[] = [];
    try {
      for (const file of files) {
        const absolute = join(root, ...file.path.split("/"));
        mkdirSync(join(absolute, ".."), { recursive: true });
        // Record before writing: the path was verified absent, so rollback may
        // remove it even when a post-rename directory sync fails mid-write.
        written.push(absolute);
        writeDurable(absolute, file.bytes);
      }
      // Validate the complete installed bundle before issuing the receipt.
      const bundle = loadKxmProject(root, { ...options, allowUnreceiptedLegacyConfig: true });
      const receipt: JsonObject = {
        schema: "kxm.migration-receipt.v1",
        migrationId: `mig_${sha256Of(`${first.plan.sourceDigest}\n${bundle.configRevision}`).slice(7, 39)}`,
        projectId: String(first.plan.projectId),
        sourceDigest: String(first.plan.sourceDigest),
        decisionDigest: sha256Of(kxmCanonicalJson((decisionsRecord ?? { schema: "kxm.migration-decision.v1", projectId: first.plan.projectId, projectName: first.plan.projectName, sourceDigest: first.plan.sourceDigest, resolutions: decisions }) as JsonObject)),
        configRevision: bundle.configRevision,
        sources: first.plan.sources as JsonValue,
        resources: files.map((file) => ({ path: file.path, sha256: sha256Of(file.bytes), bytes: file.bytes.byteLength })),
      };
      receipt.receiptSha256 = migrationReceiptSelfHash(receipt);
      const registry = new KxmSchemaRegistry(options.schemasDir);
      const receiptIssues = registry.validateMigrationReceipt(receipt, KXM_MIGRATION_RECEIPT_PATH);
      if (receiptIssues.length > 0) throw new KxmConfigError(receiptIssues);
      written.push(receiptAbsolute);
      writeDurable(receiptAbsolute, Buffer.from(stringify(receipt, { lineWidth: 0 }), "utf8"));
      // The receipt must make the mixed tree loadable.
      const verified = loadKxmProject(root, options);
      return {
        action: "applied",
        projectRoot: root,
        receiptPath: KXM_MIGRATION_RECEIPT_PATH,
        configRevision: verified.configRevision,
        files: files.map((file) => file.path),
        plan: first.plan,
      };
    } catch (error) {
      // Roll back this apply's writes so a later retry is not blocked by
      // migration_target_exists on state we created. Only files written by
      // this run (all verified absent before the first write) are removed.
      for (const absolute of written.reverse()) {
        try { rmSync(absolute, { force: true }); } catch { /* best effort rollback */ }
      }
      throw error;
    }
  };

  if (options.dryRun) return execute(undefined);
  return withKxmLocalBindingLock(root, storeOptions, (lock) => execute(lock));
}

/* ------------------------- verify ---------------------------------- */

export interface KxmMigrationVerifyResult {
  ok: boolean;
  projectRoot: string;
  receiptPath: string;
  configRevision?: string;
  issues: readonly KxmConfigIssue[];
}

/** Re-check a migration receipt against current legacy sources and the target bundle. No writes. */
export function verifyKxmMigration(projectRoot: string, options: KxmConfigOptions = {}): KxmMigrationVerifyResult {
  const root = migrationGitRoot(projectRoot);
  const receiptAbsolute = join(root, ...KXM_MIGRATION_RECEIPT_PATH.split("/"));
  if (!existsSync(receiptAbsolute)) {
    return {
      ok: false,
      projectRoot: root,
      receiptPath: KXM_MIGRATION_RECEIPT_PATH,
      issues: [migrateIssue("discovery", "migration_receipt_missing", KXM_MIGRATION_RECEIPT_PATH, "no migration receipt exists")],
    };
  }
  try {
    const bundle = loadKxmProject(root, options);
    const receipt = bundle.migrationReceipt;
    if (!receipt) {
      if (legacyConfigFilesAt(root).length === 0) {
        // Every legacy source was removed after migration: the receipt was
        // never consulted at load. Read it directly; readKxmMigrationReceipt
        // surfaces one migration_source_missing issue per declared source.
        const direct = readKxmMigrationReceipt(root, options);
        return {
          ok: false,
          projectRoot: root,
          receiptPath: KXM_MIGRATION_RECEIPT_PATH,
          configRevision: bundle.configRevision,
          issues: direct.issues.length > 0 ? direct.issues : [migrateIssue("semantic", "migration_receipt_invalid", KXM_MIGRATION_RECEIPT_PATH, "receipt did not validate")],
        };
      }
      return {
        ok: false,
        projectRoot: root,
        receiptPath: KXM_MIGRATION_RECEIPT_PATH,
        configRevision: bundle.configRevision,
        issues: [migrateIssue("semantic", "migration_receipt_invalid", KXM_MIGRATION_RECEIPT_PATH, "receipt did not validate during project load")],
      };
    }
    const targetIssues = verifyKxmMigrationReceiptTarget(root, receipt, bundle.resources, bundle.configRevision);
    return {
      ok: targetIssues.length === 0,
      projectRoot: root,
      receiptPath: KXM_MIGRATION_RECEIPT_PATH,
      configRevision: bundle.configRevision,
      issues: targetIssues,
    };
  } catch (error) {
    if (error instanceof KxmConfigError) {
      return { ok: false, projectRoot: root, receiptPath: KXM_MIGRATION_RECEIPT_PATH, issues: error.issues };
    }
    throw error;
  }
}

