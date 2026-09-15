import { createHash } from "node:crypto";
import { RestrictedYamlError, parseRestrictedYaml } from "./restricted-yaml.mjs";

export const POLICY_DRAFT_MODEL_SCHEMA = "kxm.model.v2";
export const POLICY_DRAFT_ROLE_SCHEMA = "kxm.role.v2";
export const POLICY_DRAFT_PURPOSES = Object.freeze([
  "writer",
  "planner",
  "reviewer-arch",
  "reviewer-cli",
  "experiment",
]);
export const POLICY_DRAFT_PERMISSIONS = Object.freeze(["edit", "read-only"]);
export const POLICY_DRAFT_STATUSES = Object.freeze(["admitted", "candidate", "retired"]);

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /[\s\x00-\x1f]/u;
const EFFORTS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODES = Object.freeze(["headless", "interactive", "either"]);
const MODEL_KEYS = Object.freeze([
  "schema", "id", "harness", "model", "vendor", "status", "permissions", "origin",
  "thinking", "tags", "capabilities", "priority", "fallbacks", "limits",
]);
const ROLE_KEYS = Object.freeze([
  "schema", "id", "purpose", "permission", "description", "roster",
  "skills", "tools", "produces", "consumes", "policy",
]);
const ORIGIN_KEYS = Object.freeze(["source", "sha256"]);
const LIMIT_KEYS = Object.freeze(["contextTokens", "outputTokens", "timeoutMs"]);
const TOOL_KEYS = Object.freeze(["preset", "allow", "deny"]);
const TEMPLATE_KEYS = Object.freeze(["template", "schema"]);
const POLICY_KEYS = Object.freeze(["vendorIndependenceRequired", "maxTransitions", "requiresGateVerification"]);
const ROSTER_ENTRY_KEYS = Object.freeze(["route", "effort", "mode"]);
const CRITIC_PURPOSES = Object.freeze(["reviewer-arch", "reviewer-cli"]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortIssues(issues) {
  return [...issues].sort((left, right) => compareCodeUnits(left.file, right.file)
    || compareCodeUnits(left.phase, right.phase)
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.message, right.message));
}

function issue(phase, code, file, message) {
  return { phase, code, file, message };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(object, key) {
  return Object.hasOwn(object, key);
}

function extraKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256Bytes(input) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalVendor(value, aliases) {
  if (typeof value !== "string") return "";
  const lower = value.toLowerCase();
  return own(aliases, lower) ? aliases[lower] : lower;
}

function identifier(value, max = 64) {
  return typeof value === "string" && value.length >= 1 && value.length <= max && IDENTIFIER.test(value);
}

function routeId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && ROUTE_ID.test(value);
}

function nonemptyToken(value, max = 512) {
  return typeof value === "string" && value.length >= 1 && value.length <= max && !TOKEN.test(value);
}

function codePointCount(value) {
  return [...value].length;
}

function sourcePath(value) {
  if (!nonemptyToken(value)) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..");
}

function uniqueStringList(value, allowed, { min = 1, max = 64 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  if (new Set(value).size !== value.length) return false;
  return value.every((item) => allowed.includes(item));
}

function identifierList(value, { maxItems = 32, itemMax = 64 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  if (new Set(value).size !== value.length) return false;
  return value.every((item) => identifier(item, itemMax));
}

function parseDocument(value, label, issues) {
  if (typeof value === "string" || value instanceof Uint8Array) {
    try {
      return parseRestrictedYaml(value, label);
    } catch (error) {
      if (error instanceof RestrictedYamlError) issues.push(...error.issues);
      else issues.push(issue("parse", "invalid_yaml", label, error instanceof Error ? error.message : "invalid YAML"));
      return undefined;
    }
  }
  if (isObject(value)) return value;
  issues.push(issue("schema", "root_not_object", label, "resource root must be a mapping"));
  return undefined;
}

function collectDocuments(raw, kind, issues) {
  const collected = [];
  const seen = new Set();
  if (raw === undefined) return collected;
  if (Array.isArray(raw)) {
    for (const [index, value] of raw.entries()) {
      const label = `${kind}[${index}]`;
      const document = parseDocument(value, label, issues);
      if (!document) continue;
      const declared = document.id;
      if (!routeId(declared) && !(kind === "roles" && identifier(declared))) {
        issues.push(issue("schema", "missing_id", label, `${kind.slice(0, -1)} identity is missing or invalid`));
        continue;
      }
      if (seen.has(declared)) {
        issues.push(issue("schema", kind === "models" ? "duplicate_route_id" : "duplicate_role_id", label, `duplicate ${kind.slice(0, -1)} identity ${declared}`));
        continue;
      }
      seen.add(declared);
      collected.push({ id: declared, label: `${kind}/${declared}`, document });
    }
    return collected;
  }
  if (!isObject(raw)) {
    issues.push(issue("schema", "root_not_object", kind, `${kind} must be a mapping or array`));
    return collected;
  }
  for (const id of Object.keys(raw).sort(compareCodeUnits)) {
    const label = `${kind}/${id}`;
    if (kind === "models" ? !routeId(id) : !identifier(id)) {
      issues.push(issue("schema", "invalid_id", label, `invalid ${kind.slice(0, -1)} identity`));
      continue;
    }
    if (seen.has(id)) {
      issues.push(issue("schema", kind === "models" ? "duplicate_route_id" : "duplicate_role_id", label, `duplicate ${kind.slice(0, -1)} identity ${id}`));
      continue;
    }
    seen.add(id);
    const document = parseDocument(raw[id], label, issues);
    if (!document) continue;
    if (document.id !== undefined && document.id !== id) {
      issues.push(issue("schema", "identity_mismatch", label, `declared id ${String(document.id)} does not match ${id}`));
      continue;
    }
    collected.push({ id, label, document });
  }
  return collected;
}

function closedObject(value, allowed, label, issues, code = "schema_additionalProperties") {
  if (!isObject(value)) {
    issues.push(issue("schema", "root_not_object", label, "value must be a mapping"));
    return false;
  }
  const unexpected = extraKeys(value, allowed);
  if (unexpected.length > 0) {
    issues.push(issue("schema", code, label, `unexpected properties: ${unexpected.join(", ")}`));
    return false;
  }
  return true;
}

function required(value, keys, label, issues) {
  for (const key of keys) {
    if (!own(value, key)) issues.push(issue("schema", "schema_required", label, `missing ${key}`));
  }
}

function validateOrigin(origin, label, issues) {
  if (!closedObject(origin, ORIGIN_KEYS, `${label}.origin`, issues)) return;
  required(origin, ORIGIN_KEYS, `${label}.origin`, issues);
  if (origin.source !== undefined && !sourcePath(origin.source)) {
    issues.push(issue("schema", "origin_source_invalid", `${label}.origin`, "origin source must be a contained relative path"));
  }
  if (origin.sha256 !== undefined && (typeof origin.sha256 !== "string" || !SHA256.test(origin.sha256))) {
    issues.push(issue("schema", "origin_hash_invalid", `${label}.origin`, "origin sha256 must be a 64-character hex digest"));
  }
}

function validateModelShape(document, id, label, issues) {
  if (!closedObject(document, MODEL_KEYS, label, issues)) return;
  required(document, ["schema", "harness", "model", "vendor", "status", "permissions"], label, issues);
  if (document.schema !== undefined && document.schema !== POLICY_DRAFT_MODEL_SCHEMA) {
    issues.push(issue("schema", "schema_identity_mismatch", label, `expected ${POLICY_DRAFT_MODEL_SCHEMA}, received ${String(document.schema)}`));
  }
  if (document.id !== undefined && document.id !== id) {
    issues.push(issue("schema", "identity_mismatch", label, `declared id ${String(document.id)} does not match ${id}`));
  }
  if (document.harness !== undefined && !identifier(document.harness)) {
    issues.push(issue("schema", "schema_pattern", label, "harness must be an identifier"));
  }
  if (document.model !== undefined && (typeof document.model !== "string" || codePointCount(document.model) < 1 || codePointCount(document.model) > 200)) {
    issues.push(issue("schema", "schema_pattern", label, "model must be a nonempty string"));
  }
  if (document.vendor !== undefined && !nonemptyToken(document.vendor, 64)) {
    issues.push(issue("schema", "schema_pattern", label, "vendor must be a nonempty token"));
  }
  if (document.status !== undefined && !POLICY_DRAFT_STATUSES.includes(document.status)) {
    issues.push(issue("schema", "unsupported_status", label, "status must be admitted, candidate, or retired"));
  }
  if (document.permissions !== undefined && !uniqueStringList(document.permissions, POLICY_DRAFT_PERMISSIONS, { min: 1, max: 2 })) {
    issues.push(issue("schema", "schema_enum", label, "permissions must be unique edit and/or read-only"));
  }
  if (document.harness === "pi" && !own(document, "origin")) {
    issues.push(issue("schema", "schema_required", label, "Pi routes require origin source and sha256"));
  }
  if (own(document, "origin")) validateOrigin(document.origin, label, issues);
  if (document.thinking !== undefined && (typeof document.thinking !== "string" || document.thinking.length < 1 || document.thinking.length > 64)) {
    issues.push(issue("schema", "schema_pattern", label, "thinking must be a short string"));
  }
  if (document.tags !== undefined && !identifierList(document.tags)) {
    issues.push(issue("schema", "schema_pattern", label, "tags must be unique identifiers"));
  }
  if (document.capabilities !== undefined && !identifierList(document.capabilities)) {
    issues.push(issue("schema", "schema_pattern", label, "capabilities must be unique identifiers"));
  }
  if (document.priority !== undefined && (!Number.isInteger(document.priority) || document.priority < -10000 || document.priority > 10000)) {
    issues.push(issue("schema", "schema_type", label, "priority must be an integer in range"));
  }
  if (document.fallbacks !== undefined) {
    if (!Array.isArray(document.fallbacks) || document.fallbacks.length > 8) {
      issues.push(issue("schema", "schema_type", label, "fallbacks must be a bounded array"));
    } else {
      for (const [index, fallback] of document.fallbacks.entries()) {
        if (!isObject(fallback)) {
          issues.push(issue("schema", "root_not_object", `${label}.fallbacks[${index}]`, "fallback must be a mapping"));
          continue;
        }
        const keys = Object.keys(fallback);
        const profile = keys.length === 1 && own(fallback, "profile") && identifier(fallback.profile);
        const tag = own(fallback, "tag") && identifier(fallback.tag)
          && extraKeys(fallback, ["tag", "capabilities"]).length === 0
          && (fallback.capabilities === undefined || identifierList(fallback.capabilities));
        const provider = own(fallback, "provider") && own(fallback, "model")
          && extraKeys(fallback, ["provider", "model"]).length === 0
          && identifier(fallback.provider)
          && typeof fallback.model === "string"
          && codePointCount(fallback.model) >= 1 && codePointCount(fallback.model) <= 200;
        if (!profile && !tag && !provider) {
          issues.push(issue("schema", "schema_oneOf", `${label}.fallbacks[${index}]`, "fallback does not match a retained v1 selector"));
        }
      }
    }
  }
  if (document.limits !== undefined) {
    if (!closedObject(document.limits, LIMIT_KEYS, `${label}.limits`, issues)) return;
    for (const key of ["contextTokens", "outputTokens"]) {
      if (document.limits[key] !== undefined && (!Number.isInteger(document.limits[key]) || document.limits[key] < 1)) {
        issues.push(issue("schema", "schema_type", `${label}.limits`, `${key} must be a positive integer`));
      }
    }
    if (document.limits.timeoutMs !== undefined && (!Number.isInteger(document.limits.timeoutMs) || document.limits.timeoutMs < 0 || document.limits.timeoutMs > 31536000000)) {
      issues.push(issue("schema", "schema_type", `${label}.limits`, "timeoutMs must be a non-negative integer between 0 and 31536000000"));
    }
  }
}

function validateTemplateList(value, label, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue("schema", "schema_type", label, "must be an array"));
    return;
  }
  for (const [index, entry] of value.entries()) {
    const path = `${label}[${index}]`;
    if (!closedObject(entry, TEMPLATE_KEYS, path, issues)) continue;
    if (typeof entry.template !== "string" || !entry.template) {
      issues.push(issue("schema", "schema_required", path, "template is required"));
    }
    if (entry.schema !== undefined && typeof entry.schema !== "string") {
      issues.push(issue("schema", "schema_type", path, "schema must be a string"));
    }
  }
}

function validateRoleShape(document, id, label, issues) {
  if (!closedObject(document, ROLE_KEYS, label, issues)) return;
  required(document, ["schema", "purpose", "permission", "description", "roster"], label, issues);
  if (document.schema !== undefined && document.schema !== POLICY_DRAFT_ROLE_SCHEMA) {
    issues.push(issue("schema", "schema_identity_mismatch", label, `expected ${POLICY_DRAFT_ROLE_SCHEMA}, received ${String(document.schema)}`));
  }
  if (document.id !== undefined && document.id !== id) {
    issues.push(issue("schema", "identity_mismatch", label, `declared id ${String(document.id)} does not match ${id}`));
  }
  if (document.purpose !== undefined && !POLICY_DRAFT_PURPOSES.includes(document.purpose)) {
    issues.push(issue("schema", "unsupported_purpose", label, "purpose must be a runner role label"));
  }
  if (document.permission !== undefined && !POLICY_DRAFT_PERMISSIONS.includes(document.permission)) {
    issues.push(issue("schema", "schema_enum", label, "permission must be edit or read-only"));
  }
  if (document.description !== undefined && (typeof document.description !== "string" || document.description.length < 1 || document.description.length > 2000)) {
    issues.push(issue("schema", "schema_type", label, "description must be a bounded string"));
  }
  if (document.roster !== undefined) {
    if (!Array.isArray(document.roster) || document.roster.length > 32) {
      issues.push(issue("schema", "schema_type", label, "roster must be a bounded array"));
    } else {
      const seenRoutes = new Set();
      for (const [index, entry] of document.roster.entries()) {
        const path = `${label}.roster[${index}]`;
        if (!closedObject(entry, ROSTER_ENTRY_KEYS, path, issues)) continue;
        if (!routeId(entry.route)) {
          issues.push(issue("schema", "schema_pattern", path, "roster route must be a route identity"));
          continue;
        }
        if (seenRoutes.has(entry.route)) {
          issues.push(issue("schema", "duplicate_route_id", path, `duplicate roster route ${entry.route}`));
        }
        seenRoutes.add(entry.route);
        if (entry.effort !== undefined && !EFFORTS.includes(entry.effort)) {
          issues.push(issue("schema", "schema_enum", path, "effort is not a known helper effort"));
        }
        if (entry.mode !== undefined && !MODES.includes(entry.mode)) {
          issues.push(issue("schema", "schema_enum", path, "mode must be headless, interactive, or either"));
        }
      }
    }
  }
  if (document.skills !== undefined) {
    if (!Array.isArray(document.skills) || document.skills.length > 64
      || document.skills.some((item) => typeof item !== "string" || item.length < 1 || item.length > 128)) {
      issues.push(issue("schema", "schema_type", label, "skills must be bounded strings"));
    }
  }
  if (document.tools !== undefined) {
    if (!closedObject(document.tools, TOOL_KEYS, `${label}.tools`, issues)) return;
    if (document.tools.preset !== undefined && typeof document.tools.preset !== "string") {
      issues.push(issue("schema", "schema_type", `${label}.tools`, "preset must be a string"));
    }
    for (const key of ["allow", "deny"]) {
      if (document.tools[key] !== undefined && (!Array.isArray(document.tools[key]) || document.tools[key].some((item) => typeof item !== "string"))) {
        issues.push(issue("schema", "schema_type", `${label}.tools`, `${key} must be a string array`));
      }
    }
  }
  if (document.produces !== undefined) validateTemplateList(document.produces, `${label}.produces`, issues);
  if (document.consumes !== undefined) validateTemplateList(document.consumes, `${label}.consumes`, issues);
  if (document.policy !== undefined) {
    if (!closedObject(document.policy, POLICY_KEYS, `${label}.policy`, issues)) return;
    if (document.policy.vendorIndependenceRequired !== undefined && typeof document.policy.vendorIndependenceRequired !== "boolean") {
      issues.push(issue("schema", "schema_type", `${label}.policy`, "vendorIndependenceRequired must be boolean"));
    }
    if (document.policy.requiresGateVerification !== undefined && typeof document.policy.requiresGateVerification !== "boolean") {
      issues.push(issue("schema", "schema_type", `${label}.policy`, "requiresGateVerification must be boolean"));
    }
    if (document.policy.maxTransitions !== undefined && (!Number.isInteger(document.policy.maxTransitions) || document.policy.maxTransitions < 1)) {
      issues.push(issue("schema", "schema_type", `${label}.policy`, "maxTransitions must be a positive integer"));
    }
  }
}

function subset(values, allowed) {
  return values.every((value) => allowed.includes(value));
}

function validateModelSemantics(model, label, options, evidence, issues) {
  const aliases = options.vendorAliases ?? {};
  const ceiling = options.ceilings[model.harness];
  if (!ceiling) {
    issues.push(issue("semantic", "unsupported_harness", label, `no code-owned ceiling for harness ${String(model.harness)}`));
    return;
  }
  const vendor = canonicalVendor(model.vendor, aliases);
  if (options.piAllowedProviders.includes(vendor)) {
    issues.push(issue("semantic", "vendor_aggregator", label, "vendor must name the model vendor, not a billing aggregator"));
  }
  if (!subset(model.permissions, ceiling.permissions)) {
    issues.push(issue("semantic", "permission_escalation", label, "route permissions exceed the harness ceiling"));
  }
  if (Array.isArray(ceiling.models) && ceiling.models.length > 0 && !ceiling.models.includes(model.model)) {
    issues.push(issue("semantic", "model_not_in_ceiling", label, "exact model is not listed on the harness ceiling"));
  }
  if (model.harness === "pi") {
    const parts = typeof model.model === "string" ? model.model.split("/") : [];
    const nativeVendors = isObject(options.piNativeVendorProviders) ? options.piNativeVendorProviders : {};
    const provider = parts[0];
    const owned = own(nativeVendors, provider) ? canonicalVendor(nativeVendors[provider], aliases) : "";
    const minParts = owned ? 2 : 3;
    const maxParts = owned ? 2 : Number.POSITIVE_INFINITY;
    if (
      parts.length < minParts
      || parts.length > maxParts
      || parts.some((part) => !part)
      || !options.piAllowedProviders.includes(provider)
      || (owned && !/^gemini-[a-z0-9.-]+$/.test(parts[1]))
    ) {
      issues.push(issue("semantic", "unsupported_pi_model", label, "Pi model must use an allowlisted aggregator prefix"));
    } else if (owned) {
      if (owned !== vendor) {
        issues.push(issue("semantic", "pi_native_vendor_forbidden", label, "native vendor cannot use Pi"));
      }
    } else {
      const prefix = canonicalVendor(parts[1], aliases);
      if (options.nativePiBrakeProviders.includes(prefix) || options.nativePiBrakeProviders.includes(vendor)) {
        issues.push(issue("semantic", "pi_native_vendor_forbidden", label, "native vendor cannot use Pi"));
      }
    }
    const origin = model.origin;
    if (isObject(origin) && typeof origin.source === "string" && typeof origin.sha256 === "string") {
      if (!own(evidence, origin.source)) {
        issues.push(issue("semantic", "origin_evidence_missing", label, `missing evidence bytes for ${origin.source}`));
      } else if (sha256Bytes(evidence[origin.source]) !== origin.sha256) {
        issues.push(issue("semantic", "origin_hash_mismatch", label, "origin evidence hash does not match supplied bytes"));
      }
    }
  } else {
    if (vendor !== ceiling.provider || (typeof model.model === "string" && model.model.includes("/"))) {
      issues.push(issue("semantic", "native_vendor_mismatch", label, "native route vendor or model does not match the harness ceiling"));
    }
    if (own(model, "origin")) {
      issues.push(issue("semantic", "origin_unexpected", label, "origin is only valid for Pi routes"));
    }
  }
}

function admittedRoute(model) {
  return model.status === "admitted";
}

function validateRoleSemantics(role, id, label, models, options, issues) {
  if (!Array.isArray(role.roster)) return;
  for (const [index, entry] of role.roster.entries()) {
    const path = `${label}.roster[${index}]`;
    const model = models.get(entry.route);
    if (!model) {
      issues.push(issue("reference", "route_unknown", path, `roster references unknown route ${entry.route}`));
      continue;
    }
    const ceiling = options.ceilings[model.harness];
    if (!ceiling) continue;
    if (Array.isArray(ceiling.roles) && ceiling.roles.length > 0 && !ceiling.roles.includes(role.purpose)) {
      issues.push(issue("semantic", "purpose_ceiling_mismatch", path, `purpose ${role.purpose} is not allowed on harness ${model.harness}`));
    }
    if (!model.permissions.includes(role.permission)) {
      issues.push(issue("semantic", "permission_escalation", path, "role permission is not granted by the route"));
    }
    if (!ceiling.permissions.includes(role.permission)) {
      issues.push(issue("semantic", "permission_escalation", path, "role permission exceeds the harness ceiling"));
    }
    if (Array.isArray(ceiling.efforts) && ceiling.efforts.length > 0 && entry.effort !== undefined && !ceiling.efforts.includes(entry.effort)) {
      issues.push(issue("semantic", "effort_ceiling_mismatch", path, "effort is not allowed on the harness ceiling"));
    }
    if (!admittedRoute(model)) {
      issues.push(issue("semantic", "route_not_admitted", path, `route ${entry.route} is ${model.status} and is not treated as admitted`));
    }
    if (model.harness === "pi") {
      if (role.permission === "edit" && !["writer", "experiment"].includes(role.purpose)) {
        issues.push(issue("semantic", "permission_escalation", path, "Pi critic/planner cannot edit"));
      }
      if (role.purpose === "writer" && (model.permissions.length !== 1 || model.permissions[0] !== "edit")) {
        issues.push(issue("semantic", "permission_escalation", path, "Pi writer requires edit permission only"));
      }
    }
  }

  if (id === role.purpose && CRITIC_PURPOSES.includes(role.purpose)) {
    const admitted = role.roster
      .map((entry) => models.get(entry.route))
      .filter((model) => model && admittedRoute(model));
    if (admitted.length !== 1) {
      issues.push(issue("semantic", "critic_route_count", label, "required critic purpose files must list exactly one admitted route"));
    } else if (admitted[0].permissions.length !== 1 || admitted[0].permissions[0] !== "read-only" || role.permission !== "read-only") {
      issues.push(issue("semantic", "permission_escalation", label, "critic purpose files must be read-only"));
    }
  }
}

function validateCriticVendors(roles, models, options, issues) {
  const aliases = options.vendorAliases ?? {};
  const critics = [];
  for (const purpose of CRITIC_PURPOSES) {
    const role = roles.get(purpose);
    if (!role || role.purpose !== purpose) continue;
    const admitted = (role.roster ?? [])
      .map((entry) => models.get(entry.route))
      .filter((model) => model && admittedRoute(model));
    if (admitted.length === 1) critics.push({ purpose, vendor: canonicalVendor(admitted[0].vendor, aliases) });
  }
  if (critics.length === 2 && critics[0].vendor === critics[1].vendor) {
    issues.push(issue("semantic", "critic_vendor_collision", "roles/reviewer-arch", "required critics must have independent vendors"));
  }
  const writer = roles.get("writer");
  if (writer && critics.length > 0) {
    for (const entry of writer.roster ?? []) {
      const model = models.get(entry.route);
      if (!model || !admittedRoute(model)) continue;
      const vendor = canonicalVendor(model.vendor, aliases);
      if (critics.some((critic) => critic.vendor === vendor)) {
        issues.push(issue("semantic", "writer_critic_vendor_collision", "roles/writer", "writer and critics must have independent vendors"));
      }
    }
  }
}

/** Pure draft validation. Not admission, not a trusted loader, and not file I/O. */
export function validatePolicyDraft(input, options) {
  const issues = [];
  if (!isObject(input)) {
    return { ok: false, issues: [issue("schema", "root_not_object", "<draft>", "draft input must be a mapping")] };
  }
  const unexpected = extraKeys(input, ["models", "roles", "evidence"]);
  if (unexpected.length > 0) {
    issues.push(issue("schema", "schema_additionalProperties", "<draft>", `unexpected properties: ${unexpected.join(", ")}`));
  }
  if (!isObject(options) || !isObject(options.ceilings)
    || !Array.isArray(options.nativePiBrakeProviders)
    || !Array.isArray(options.piAllowedProviders)) {
    issues.push(issue("semantic", "ceilings_required", "<options>", "code-owned ceilings and vendor brakes must be supplied explicitly"));
    return { ok: false, issues: sortIssues(issues) };
  }
  const evidence = isObject(input.evidence) ? input.evidence : {};
  if (input.evidence !== undefined && !isObject(input.evidence)) {
    issues.push(issue("schema", "root_not_object", "evidence", "evidence must be a mapping of source path to bytes"));
  }

  const modelDocs = collectDocuments(input.models, "models", issues);
  const roleDocs = collectDocuments(input.roles, "roles", issues);
  for (const entry of modelDocs) validateModelShape(entry.document, entry.id, entry.label, issues);
  for (const entry of roleDocs) validateRoleShape(entry.document, entry.id, entry.label, issues);
  if (issues.length > 0) return { ok: false, issues: sortIssues(issues) };

  const models = new Map();
  for (const entry of modelDocs) {
    validateModelSemantics(entry.document, entry.label, options, evidence, issues);
    const normalized = cloneJson(entry.document);
    normalized.id = entry.id;
    models.set(entry.id, normalized);
  }
  const roles = new Map();
  for (const entry of roleDocs) {
    validateRoleSemantics(entry.document, entry.id, entry.label, models, options, issues);
    const normalized = cloneJson(entry.document);
    normalized.id = entry.id;
    roles.set(entry.id, normalized);
  }
  validateCriticVendors(roles, models, options, issues);
  if (issues.length > 0) return { ok: false, issues: sortIssues(issues) };

  const data = freezeDeep({
    models: Object.fromEntries([...models.entries()].sort(([left], [right]) => compareCodeUnits(left, right))),
    roles: Object.fromEntries([...roles.entries()].sort(([left], [right]) => compareCodeUnits(left, right))),
  });
  return { ok: true, data };
}
