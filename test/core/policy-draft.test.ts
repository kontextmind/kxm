import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { NATIVE_PI_BRAKE_PROVIDERS, PI_ALLOWED_PROVIDERS, PI_NATIVE_VENDOR_PROVIDERS, ROUTES } from "../../scripts/harness-run.mjs";
import { KIND_ROLES, getRosterPolicy } from "../../scripts/assignment-run.mjs";
import { withRosterPolicy } from "../helpers/roster-policy.ts";
import { DEFAULT_ROLES } from "../../plugins/kxm/src/role.ts";
import {
  KxmSchemaRegistry,
  parseRestrictedYaml,
} from "../../plugins/kxm/src/project-config.ts";
import {
  POLICY_DRAFT_MODEL_SCHEMA,
  POLICY_DRAFT_ROLE_SCHEMA,
  validatePolicyDraft,
} from "../../plugins/kxm/src/policy-draft.mjs";

const evidenceText = "Reviewed exact-model evidence for draft validation only.\n";
const evidenceHash = createHash("sha256").update(evidenceText).digest("hex");

function options() {
  return {
    ceilings: ROUTES,
    nativePiBrakeProviders: NATIVE_PI_BRAKE_PROVIDERS,
    piAllowedProviders: PI_ALLOWED_PROVIDERS,
    piNativeVendorProviders: PI_NATIVE_VENDOR_PROVIDERS,
    vendorAliases: { "x-ai": "xai", moonshotai: "moonshot", "google-ai": "google", qwen: "alibaba" },
  };
}

function codes(result: ReturnType<typeof validatePolicyDraft>): string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function model(id: string, fields: Record<string, unknown>) {
  return { schema: POLICY_DRAFT_MODEL_SCHEMA, ...fields, id };
}

function role(id: string, fields: Record<string, unknown>) {
  return { schema: POLICY_DRAFT_ROLE_SCHEMA, description: `${id} draft`, ...fields, id };
}

function currentDraft(overrides: { models?: Record<string, unknown>; roles?: Record<string, unknown>; evidence?: Record<string, string> } = {}) {
  return {
    models: {
      "grok-native": model("grok-native", { harness: "grok", model: "grok-4.7", vendor: "xai", status: "admitted", permissions: ["edit"] }),
      "qwen-openrouter-pi": model("qwen-openrouter-pi", {
        harness: "pi",
        model: "openrouter/qwen/qwen3-coder-plus",
        vendor: "alibaba",
        status: "admitted",
        permissions: ["edit"],
        origin: { source: "evidence.md", sha256: evidenceHash },
      }),
      "fable-claude": model("fable-claude", { harness: "claude", model: "fable", vendor: "anthropic", status: "admitted", permissions: ["read-only"] }),
      "sol-codex": model("sol-codex", { harness: "codex", model: "gpt-5.6-sol", vendor: "openai", status: "admitted", permissions: ["read-only"] }),
      ...overrides.models,
    },
    roles: {
      writer: role("writer", { purpose: "writer", permission: "edit", roster: [{ route: "grok-native" }, { route: "qwen-openrouter-pi" }] }),
      planner: role("planner", { purpose: "planner", permission: "read-only", roster: [{ route: "fable-claude" }] }),
      "reviewer-arch": role("reviewer-arch", { purpose: "reviewer-arch", permission: "read-only", roster: [{ route: "fable-claude" }] }),
      "reviewer-cli": role("reviewer-cli", { purpose: "reviewer-cli", permission: "read-only", roster: [{ route: "sol-codex" }] }),
      ...overrides.roles,
    },
    evidence: { "evidence.md": evidenceText, ...overrides.evidence },
  };
}

test("draft schemas compile closed and reject unknown fields", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const modelSchema = JSON.parse(readFileSync("schemas/policy-draft/model.v2.schema.json", "utf8"));
  const roleSchema = JSON.parse(readFileSync("schemas/policy-draft/role.v2.schema.json", "utf8"));
  const validateModel = ajv.compile(modelSchema);
  const validateRole = ajv.compile(roleSchema);
  assert.equal(validateModel({
    schema: "kxm.model.v2",
    harness: "grok",
    model: "grok-4.7",
    vendor: "xai",
    status: "admitted",
    permissions: ["edit"],
  }), true, ajv.errorsText(validateModel.errors));
  assert.equal(validateModel({
    schema: "kxm.model.v2",
    harness: "grok",
    model: "grok-4.7",
    vendor: "xai",
    status: "admitted",
    permissions: ["edit"],
    extra: true,
  }), false);
  assert.equal(validateRole({
    schema: "kxm.role.v2",
    purpose: "writer",
    permission: "edit",
    description: "writer",
    roster: [{ route: "grok-native" }],
  }), true, ajv.errorsText(validateRole.errors));
  assert.equal(validateRole({
    schema: "kxm.role.v2",
    purpose: "writer",
    permission: "edit",
    description: "writer",
    roster: [{ route: "grok-native" }],
    extra: true,
  }), false);
});

test("validatePolicyDraft accepts current code ceilings and specialty identity", () => {
  const result = validatePolicyDraft({
    ...currentDraft({
      roles: {
        "security-specialist": role("security-specialist", {
          purpose: "reviewer-arch",
          permission: "read-only",
          roster: [{ route: "fable-claude" }],
        }),
      },
    }),
  }, options());
  assert.equal(result.ok, true, result.ok ? "" : result.issues.map((issue) => `${issue.code}:${issue.message}`).join("\n"));
  if (!result.ok) return;
  assert.equal(result.data.models["grok-native"]?.status, "admitted");
  assert.equal(result.data.roles["security-specialist"]?.purpose, "reviewer-arch");
  assert.equal(result.data.roles["security-specialist"]?.id, "security-specialist");
  assert.notEqual(result.data.roles["security-specialist"]?.id, result.data.roles["security-specialist"]?.purpose);
});

test("validatePolicyDraft rejects closed-shape, identity, reference, vendor, hash, and admission errors", () => {
  assert.ok(codes(validatePolicyDraft({
    models: { "grok-native": model("grok-native", { harness: "grok", model: "grok-4.6", vendor: "xai", status: "admitted", permissions: ["edit"] }) },
  }, options())).includes("model_not_in_ceiling"));

  assert.ok(codes(validatePolicyDraft({
    models: { "grok-native": model("grok-native", { harness: "grok", model: "grok-4.7", vendor: "xai", status: "admitted", permissions: ["edit"], unexpected: true }) },
  }, options())).includes("schema_additionalProperties"));

  assert.ok(codes(validatePolicyDraft({
    models: [
      model("grok-native", { harness: "grok", model: "grok-4.7", vendor: "xai", status: "admitted", permissions: ["edit"] }),
      model("grok-native", { harness: "claude", model: "fable", vendor: "anthropic", status: "admitted", permissions: ["read-only"] }),
    ],
  }, options())).includes("duplicate_route_id"));

  assert.ok(codes(validatePolicyDraft({
    models: { "grok-native": model("grok-native", { harness: "grok", model: "grok-4.7", vendor: "xai", status: "admitted", permissions: ["edit"] }) },
    roles: { writer: role("writer", { purpose: "writer", permission: "edit", roster: [{ route: "missing-route" }] }) },
  }, options())).includes("route_unknown"));

  assert.ok(codes(validatePolicyDraft({
    models: { "grok-native": model("grok-native", { harness: "grok", model: "grok-4.7", vendor: "anthropic", status: "admitted", permissions: ["edit"] }) },
  }, options())).includes("native_vendor_mismatch"));

  assert.ok(codes(validatePolicyDraft({
    models: {
      "bad-pi": model("bad-pi", {
        harness: "pi",
        model: "openrouter/anthropic/claude",
        vendor: "anthropic",
        status: "candidate",
        permissions: ["read-only"],
        origin: { source: "evidence.md", sha256: evidenceHash },
      }),
    },
    evidence: { "evidence.md": evidenceText },
  }, options())).includes("pi_native_vendor_forbidden"));

  assert.ok(codes(validatePolicyDraft({
    models: {
      "qwen-openrouter-pi": model("qwen-openrouter-pi", {
        harness: "pi",
        model: "openrouter/qwen/qwen3-coder-plus",
        vendor: "alibaba",
        status: "admitted",
        permissions: ["edit"],
        origin: { source: "evidence.md", sha256: "a".repeat(64) },
      }),
    },
    evidence: { "evidence.md": evidenceText },
  }, options())).includes("origin_hash_mismatch"));

  assert.ok(codes(validatePolicyDraft({
    models: { "fable-claude": model("fable-claude", { harness: "claude", model: "fable", vendor: "anthropic", status: "admitted", permissions: ["read-only"] }) },
    roles: { writer: role("writer", { purpose: "writer", permission: "edit", roster: [{ route: "fable-claude" }] }) },
  }, options())).includes("permission_escalation"));

  assert.ok(codes(validatePolicyDraft(currentDraft({
    models: {
      "sol-codex": model("sol-codex", { harness: "codex", model: "gpt-5.6-sol", vendor: "anthropic", status: "admitted", permissions: ["read-only"] }),
    },
  }), options())).includes("native_vendor_mismatch"));

  const collided = currentDraft({
    models: {
      "sol-codex": model("sol-codex", { harness: "claude", model: "fable", vendor: "anthropic", status: "admitted", permissions: ["read-only"] }),
    },
  });
  assert.ok(codes(validatePolicyDraft(collided, options())).includes("critic_vendor_collision"));

  const candidate = currentDraft({
    models: {
      "grok-native": model("grok-native", { harness: "grok", model: "grok-4.7", vendor: "xai", status: "candidate", permissions: ["edit"] }),
    },
  });
  const candidateCodes = codes(validatePolicyDraft(candidate, options()));
  assert.ok(candidateCodes.includes("route_not_admitted"));
  assert.equal(candidateCodes.includes("ok"), false);
});

test("candidate status is stored as candidate data and never treated as admitted", () => {
  const isolated = validatePolicyDraft({
    models: {
      "grok-native": model("grok-native", { harness: "grok", model: "grok-4.7", vendor: "xai", status: "candidate", permissions: ["edit"] }),
    },
  }, options());
  assert.equal(isolated.ok, true);
  if (isolated.ok) assert.equal(isolated.data.models["grok-native"]?.status, "candidate");

  const used = validatePolicyDraft({
    models: {
      "grok-native": model("grok-native", { harness: "grok", model: "grok-4.7", vendor: "xai", status: "candidate", permissions: ["edit"] }),
    },
    roles: { writer: role("writer", { purpose: "writer", permission: "edit", roster: [{ route: "grok-native" }] }) },
  }, options());
  assert.equal(used.ok, false);
  if (!used.ok) {
    assert.ok(used.issues.some((issue) => issue.code === "route_not_admitted" && issue.message.includes("candidate")));
  }
});

test("draft validator does not read Git, cwd files, or live roster evidence paths", () => {
  const result = validatePolicyDraft({
    models: {
      "qwen-openrouter-pi": model("qwen-openrouter-pi", {
        harness: "pi",
        model: "openrouter/qwen/qwen3-coder-plus",
        vendor: "alibaba",
        status: "admitted",
        permissions: ["edit"],
        origin: { source: "docs/workflow-guide.md", sha256: evidenceHash },
      }),
    },
  }, options());
  assert.ok(codes(result).includes("origin_evidence_missing"));
});

test("active KXM schemas, examples, and roster.yaml remain the live formats", () => {
  const roster = parse(readFileSync(".kxm/roster.yaml", "utf8")) as {
    schema: string;
    routes: Record<string, { status: string; harness: string; model: string }>;
    lineup: Record<string, string[]>;
    required_critics: Record<string, string>;
  };
  assert.equal(roster.schema, "kxm.developer-roster.v1");
  assert.deepEqual(roster.lineup.writer, ["grok-native", "qwen-openrouter-pi"]);
  assert.equal(roster.routes["grok-native"]?.status, "admitted");
  assert.equal(roster.routes["qwen-openrouter-pi"]?.status, "admitted");
  assert.equal(roster.required_critics["review-arch"], "opus-claude");
  assert.equal(roster.required_critics["review-cli"], "sol-codex");
  assert.equal(roster.routes["opus-claude"]?.model, "opus");
  assert.equal(roster.routes["sol-codex"]?.model, "gpt-5.6-sol");

  const primary = parseRestrictedYaml(readFileSync("examples/project/.kxm/models/primary.yaml"), "primary.yaml");
  assert.equal(primary.schema, "kxm.model.v1");
  assert.equal("harness" in primary, false);
  assert.equal("vendor" in primary, false);

  const registry = new KxmSchemaRegistry();
  assert.match(registry.schemasDir.replaceAll("\\", "/"), /\/schemas$/);
  const mismatch = registry.validate("model", {
    schema: "kxm.model.v2",
    provider: "xai",
    model: "grok-4.7",
  }, "draft-as-live.yaml");
  assert.ok(mismatch.some((issue) => issue.code === "schema_identity_mismatch"));

  for (const name of readdirSync(join("examples", "project", ".kxm", "models"))) {
    const value = parseRestrictedYaml(readFileSync(join("examples", "project", ".kxm", "models", name)), name);
    assert.equal(value.schema, "kxm.model.v1");
  }

  assert.equal(DEFAULT_ROLES.writer?.schema, "kxm.role.v1");
  assert.ok(DEFAULT_ROLES.writer?.roster.some((entry) => entry.model === "gemini-2.5-pro"));
  assert.equal(KIND_ROLES.implement, "writer");
  assert.equal(KIND_ROLES["review-arch"], "reviewer-arch");
  assert.equal(KIND_ROLES["review-cli"], "reviewer-cli");

  const policy = getRosterPolicy(withRosterPolicy());
  assert.deepEqual(policy.lineup.writer, ["grok-native", "qwen-openrouter-pi"]);
  assert.equal(Object.hasOwn(policy.routes, "agy-native"), false);

  const assignment = readFileSync("scripts/assignment-run.mjs", "utf8");
  assert.doesNotMatch(assignment, /policy-draft/);
  assert.doesNotMatch(assignment, /validatePolicyDraft/);
  const roleSource = readFileSync("plugins/kxm/src/role.ts", "utf8");
  assert.match(roleSource, /yaml/);
  assert.doesNotMatch(roleSource, /policy-draft/);
});

test("admitted draft fixtures do not change live writer or critic selection", () => {
  const draft = validatePolicyDraft({
    ...currentDraft({
      models: {
        "agy-native": model("agy-native", {
          harness: "agy",
          model: "gemini-3.1-pro-high",
          vendor: "google",
          status: "admitted",
          permissions: ["edit"],
        }),
      },
      roles: {
        writer: role("writer", { purpose: "writer", permission: "edit", roster: [{ route: "agy-native" }] }),
      },
    }),
  }, options());
  assert.equal(draft.ok, true, draft.ok ? "" : draft.issues.map((issue) => `${issue.code}:${issue.message}`).join("\n"));
  const live = parse(readFileSync(".kxm/roster.yaml", "utf8")) as { lineup: Record<string, string[]> };
  assert.deepEqual(live.lineup.writer, ["grok-native", "qwen-openrouter-pi"]);
  assert.equal(getRosterPolicy(withRosterPolicy()).lineup.writer?.includes("agy-native"), false);
});

test("validatePolicyDraft admits antigravity native-vendor Gemini routes and refuses mismatches", () => {
  const admitted = validatePolicyDraft(currentDraft({
    models: {
      "gemini-antigravity-pi": model("gemini-antigravity-pi", {
        harness: "pi",
        model: "antigravity/gemini-3.8-flash",
        vendor: "google",
        status: "admitted",
        permissions: ["read-only", "edit"],
        origin: { source: "evidence.md", sha256: evidenceHash },
      }),
    },
  }), options());
  assert.equal(admitted.ok, true, admitted.ok ? "" : admitted.issues.map((issue) => `${issue.code}:${issue.message}`).join("\n"));

  assert.ok(codes(validatePolicyDraft(currentDraft({
    models: {
      "gemini-antigravity-pi": model("gemini-antigravity-pi", {
        harness: "pi",
        model: "antigravity/gemini-3.8-flash",
        vendor: "anthropic",
        status: "admitted",
        permissions: ["read-only"],
        origin: { source: "evidence.md", sha256: evidenceHash },
      }),
    },
  }), options())).includes("pi_native_vendor_forbidden"));

  assert.ok(codes(validatePolicyDraft(currentDraft({
    models: {
      "gemini-antigravity-pi": model("gemini-antigravity-pi", {
        harness: "pi",
        model: "antigravity/google/gemini-3.8-flash",
        vendor: "google",
        status: "admitted",
        permissions: ["read-only"],
        origin: { source: "evidence.md", sha256: evidenceHash },
      }),
    },
  }), options())).includes("unsupported_pi_model"));

  assert.ok(codes(validatePolicyDraft(currentDraft({
    models: {
      "gemini-antigravity-pi": model("gemini-antigravity-pi", {
        harness: "pi",
        model: "antigravity/claude-sonnet-4-6",
        vendor: "google",
        status: "admitted",
        permissions: ["read-only"],
        origin: { source: "evidence.md", sha256: evidenceHash },
      }),
    },
  }), options())).includes("unsupported_pi_model"));
});

test("policy-draft module ships as plain JS and does not import unshipped scripts", () => {
  const source = readFileSync("plugins/kxm/src/policy-draft.mjs", "utf8");
  assert.doesNotMatch(source, /scripts\//);
  assert.doesNotMatch(source, /loadTrusted/);
  assert.doesNotMatch(source, /readFileSync|execFileSync|spawnSync/);
  const script = `
    import { validatePolicyDraft } from ${JSON.stringify(pathToFileURL(resolve("plugins/kxm/src/policy-draft.mjs")).href)};
    const result = validatePolicyDraft({ models: {} }, {
      ceilings: { grok: { provider: "xai", permissions: ["edit"], roles: ["writer"] } },
      nativePiBrakeProviders: ["anthropic"],
      piAllowedProviders: ["openrouter"],
    });
    if (!result.ok) throw new Error("empty models should pass");
  `;
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
});

test("policy-draft directory is not an active KXM schema or example tree", () => {
  const draftFiles = readdirSync("schemas/policy-draft");
  assert.ok(draftFiles.includes("model.v2.schema.json"));
  assert.ok(draftFiles.includes("role.v2.schema.json"));
  const kxm = readdirSync("schemas");
  assert.ok(kxm.includes("model.schema.json"));
  assert.ok(kxm.includes("role.schema.json"));
  const liveModel = JSON.parse(readFileSync("schemas/model.schema.json", "utf8")) as { properties: { schema: { const: string } } };
  const liveRole = JSON.parse(readFileSync("schemas/role.schema.json", "utf8")) as { properties: { schema: { const: string } } };
  assert.equal(liveModel.properties.schema.const, "kxm.model.v1");
  assert.equal(liveRole.properties.schema.const, "kxm.role.v1");
  const examples = readdirSync(join("examples", "project", ".kxm", "models"));
  assert.ok(examples.every((name) => name.endsWith(".yaml")));
});

function compilePassiveModel() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const modelSchema = JSON.parse(readFileSync("schemas/policy-draft/model.v2.schema.json", "utf8"));
  return ajv.compile(modelSchema);
}

function grokNativeDraft(fields: Record<string, unknown> = {}) {
  return currentDraft({
    models: {
      "grok-native": model("grok-native", {
        harness: "grok",
        model: "grok-4.7",
        vendor: "xai",
        status: "admitted",
        permissions: ["edit"],
        ...fields,
      }),
    },
  });
}

function assertDraftAndModel(draft: ReturnType<typeof currentDraft>, validateModel: ReturnType<typeof compilePassiveModel>, expected: boolean, label: string) {
  const result = validatePolicyDraft(draft, options());
  const modelValue = draft.models["grok-native"];
  assert.equal(result.ok, expected, result.ok
    ? `${label}: expected pure validator ${expected}`
    : `${label}: expected pure validator ${expected}: ${result.issues.map((issue) => `${issue.code}:${issue.message}`).join("\n")}`);
  assert.equal(validateModel(modelValue), expected, `${label}: expected AJV ${expected}`);
}

test("schema versus pure-validator parity: fallback model length constraints", () => {
  const validateModel = compilePassiveModel();
  const baseline = grokNativeDraft();
  assertDraftAndModel(baseline, validateModel, true, "known-good full draft");

  const emoji = "\u{1F600}";
  assert.equal(emoji.length, 2);
  assert.equal([...emoji].length, 1);

  assertDraftAndModel(grokNativeDraft({ fallbacks: [{ provider: "xai", model: "x" }] }), validateModel, true, "1 ASCII fallback model");
  assertDraftAndModel(grokNativeDraft({ fallbacks: [{ provider: "xai", model: "a".repeat(200) }] }), validateModel, true, "200 ASCII fallback model");
  assertDraftAndModel(grokNativeDraft({ fallbacks: [{ provider: "xai", model: "a".repeat(199) + emoji }] }), validateModel, true, "200 code points with supplementary at bound");
  assertDraftAndModel(grokNativeDraft({ fallbacks: [{ provider: "xai", model: emoji.repeat(200) }] }), validateModel, true, "200 supplementary code points");

  assertDraftAndModel(grokNativeDraft({ fallbacks: [{ provider: "xai", model: "" }] }), validateModel, false, "empty fallback model");
  assertDraftAndModel(grokNativeDraft({ fallbacks: [{ provider: "xai", model: "a".repeat(201) }] }), validateModel, false, "201 ASCII fallback model");
  assertDraftAndModel(grokNativeDraft({ fallbacks: [{ provider: "xai", model: "a".repeat(200) + emoji }] }), validateModel, false, "201 code points with supplementary over bound");
  assertDraftAndModel(grokNativeDraft({ fallbacks: [{ provider: "xai", model: emoji.repeat(201) }] }), validateModel, false, "201 supplementary code points");
});

test("schema versus pure-validator parity: direct model length constraints", () => {
  const validateModel = compilePassiveModel();
  const emoji = "\u{1F600}";
  assert.equal(emoji.length, 2);
  assert.equal([...emoji].length, 1);
  const prefix = "openrouter/qwen/";

  function directModelDraft(modelValue: string) {
    return currentDraft({
      models: {
        "qwen-openrouter-pi": model("qwen-openrouter-pi", {
          harness: "pi",
          model: modelValue,
          vendor: "alibaba",
          status: "admitted",
          permissions: ["edit"],
          origin: { source: "evidence.md", sha256: evidenceHash },
        }),
      },
    });
  }

  const ascii200 = prefix + "a".repeat(200 - prefix.length);
  const ascii201 = prefix + "a".repeat(201 - prefix.length);
  const supplementary200 = prefix + emoji.repeat(200 - prefix.length);
  const supplementary201 = prefix + emoji.repeat(201 - prefix.length);
  assert.equal([...ascii200].length, 200);
  assert.equal([...ascii201].length, 201);
  assert.equal([...supplementary200].length, 200);
  assert.equal([...supplementary201].length, 201);

  const validAscii = directModelDraft(ascii200);
  const validAsciiPure = validatePolicyDraft(validAscii, options());
  assert.equal(validAsciiPure.ok, true, validAsciiPure.ok
    ? ""
    : `200 ASCII direct model: expected pure true: ${validAsciiPure.issues.map((issue) => `${issue.code}:${issue.message}`).join("\n")}`);
  assert.equal(validateModel(validAscii.models["qwen-openrouter-pi"]), true, "200 ASCII direct model: expected AJV true");

  const validSupplementary = directModelDraft(supplementary200);
  const validSupplementaryPure = validatePolicyDraft(validSupplementary, options());
  assert.equal(validSupplementaryPure.ok, true, validSupplementaryPure.ok
    ? ""
    : `200 supplementary direct model: expected pure true: ${validSupplementaryPure.issues.map((issue) => `${issue.code}:${issue.message}`).join("\n")}`);
  assert.equal(validateModel(validSupplementary.models["qwen-openrouter-pi"]), true, "200 supplementary direct model: expected AJV true");

  const invalidAscii = directModelDraft(ascii201);
  const invalidAsciiPure = validatePolicyDraft(invalidAscii, options());
  assert.equal(invalidAsciiPure.ok, false, "201 ASCII direct model: expected pure false");
  assert.equal(validateModel(invalidAscii.models["qwen-openrouter-pi"]), false, "201 ASCII direct model: expected AJV false");

  const invalidSupplementary = directModelDraft(supplementary201);
  const invalidSupplementaryPure = validatePolicyDraft(invalidSupplementary, options());
  assert.equal(invalidSupplementaryPure.ok, false, "201 supplementary direct model: expected pure false");
  assert.equal(validateModel(invalidSupplementary.models["qwen-openrouter-pi"]), false, "201 supplementary direct model: expected AJV false");
});

test("schema versus pure-validator parity: timeoutMs constraints", () => {
  const validateModel = compilePassiveModel();
  const baseline = grokNativeDraft();
  assertDraftAndModel(baseline, validateModel, true, "known-good full draft");

  assertDraftAndModel(grokNativeDraft({ limits: { timeoutMs: 0 } }), validateModel, true, "timeoutMs zero");
  assertDraftAndModel(grokNativeDraft({ limits: { timeoutMs: 31536000000 } }), validateModel, true, "timeoutMs maximum");
  assertDraftAndModel(grokNativeDraft({ limits: { timeoutMs: 31536000001 } }), validateModel, false, "timeoutMs maximum plus one");
  assertDraftAndModel(grokNativeDraft({ limits: { timeoutMs: -1 } }), validateModel, false, "timeoutMs negative");
  assertDraftAndModel(grokNativeDraft({ limits: { timeoutMs: 1.5 } }), validateModel, false, "timeoutMs non-integer");
});
