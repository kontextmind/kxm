import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { assembleRosterPolicy, validateRosterDocument, type RosterPolicy } from "../../scripts/roster-policy.mjs";

const qwenEvidence = "qwen origin fixture\n";
const antigravityEvidence = "antigravity origin fixture\n";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const blobs: Record<string, string> = {
  "docs/qwen.md": qwenEvidence,
  "docs/antigravity.md": antigravityEvidence,
};

function readBlob(source: string) {
  if (!Object.hasOwn(blobs, source)) return undefined;
  return blobs[source];
}

function nativeRoute(fields: Record<string, unknown> = {}) {
  return {
    harness: "grok" as const,
    model: "grok-4.6",
    vendor: "xai",
    roles: ["writer"],
    permissions: ["edit" as const],
    status: "admitted" as const,
    ...fields,
  };
}

function basePolicy(overrides: {
  routes?: Record<string, Record<string, unknown>>;
  lineup?: Record<string, string[]>;
  model_origins?: Record<string, unknown>;
} = {}): RosterPolicy {
  return {
    routes: {
      "grok-native": nativeRoute({}),
      "qwen-openrouter-pi": {
        harness: "pi",
        model: "openrouter/qwen/qwen3-coder-plus",
        vendor: "alibaba",
        roles: ["writer"],
        permissions: ["edit"],
        status: "admitted",
      },
      "fable-claude": {
        harness: "claude",
        model: "fable",
        vendor: "anthropic",
        roles: ["planner", "reviewer-arch"],
        permissions: ["read-only"],
        status: "admitted",
      },
      "sol-codex": {
        harness: "codex",
        model: "gpt-5.6-sol",
        vendor: "openai",
        roles: ["reviewer-cli"],
        permissions: ["read-only"],
        status: "admitted",
      },
      ...overrides.routes,
    },
    lineup: {
      writer: ["grok-native", "qwen-openrouter-pi"],
      planner: ["fable-claude"],
      "reviewer-arch": ["fable-claude"],
      "reviewer-cli": ["sol-codex"],
      ...overrides.lineup,
    },
    required_critics: {
      "review-arch": "fable-claude",
      "review-cli": "sol-codex",
    },
    model_origins: {
      "openrouter/qwen/qwen3-coder-plus": {
        vendor: "alibaba",
        evidence: { source: "docs/qwen.md", sha256: sha(qwenEvidence) },
      },
      ...overrides.model_origins,
    },
  } as RosterPolicy;
}

function antigravityRoute(fields: Record<string, unknown> = {}) {
  return {
    harness: "pi",
    model: "antigravity/gemini-3.8-flash",
    vendor: "google",
    roles: ["experiment"],
    permissions: ["read-only", "edit"],
    status: "admitted",
    ...fields,
  };
}

function antigravityOrigin(fields: Record<string, unknown> = {}) {
  return {
    vendor: "google",
    evidence: { source: "docs/antigravity.md", sha256: sha(antigravityEvidence) },
    ...fields,
  };
}

function withAntigravity(routeFields: Record<string, unknown> = {}, originFields?: Record<string, unknown> | false) {
  const route = antigravityRoute(routeFields);
  const origins = originFields === false
    ? {}
    : { [String(route.model)]: antigravityOrigin(originFields ?? {}) };
  return basePolicy({
    routes: { "gemini-antigravity-pi": route },
    model_origins: origins,
  });
}

test("validateRosterDocument accepts a well-formed antigravity experiment route", () => {
  const policy = validateRosterDocument(withAntigravity(), readBlob);
  assert.equal(policy.routes["gemini-antigravity-pi"]?.model, "antigravity/gemini-3.8-flash");
  assert.deepEqual(policy.routes["gemini-antigravity-pi"]?.roles, ["experiment"]);
});

test("validateRosterDocument refuses antigravity vendor mismatch, shape, origin, writer, and google prefix", () => {
  assert.throws(
    () => validateRosterDocument(withAntigravity({ vendor: "anthropic" }, { vendor: "anthropic" }), readBlob),
    /native vendor cannot use Pi/,
  );
  assert.throws(
    () => validateRosterDocument(withAntigravity({ model: "antigravity/google/gemini-3.8-flash" }), readBlob),
    /unsupported Pi provider\/model/,
  );
  assert.throws(
    () => validateRosterDocument(withAntigravity({}, false), readBlob),
    /missing exact model origin/,
  );
  assert.throws(
    () => validateRosterDocument(withAntigravity({
      roles: ["writer"],
      permissions: ["read-only", "edit"],
    }), readBlob),
    /Pi writer requires edit permission only/,
  );
  assert.throws(
    () => validateRosterDocument(basePolicy({
      routes: {
        "google-prefix-pi": {
          harness: "pi",
          model: "openrouter/google/gemini-3.8-flash",
          vendor: "google",
          roles: ["experiment"],
          permissions: ["read-only"],
          status: "admitted",
        },
      },
      model_origins: {
        "openrouter/google/gemini-3.8-flash": {
          vendor: "google",
          evidence: { source: "docs/antigravity.md", sha256: sha(antigravityEvidence) },
        },
      },
    }), readBlob),
    /native vendor cannot use Pi/,
  );
});

test("model origin evidence may pin a source commit and receives it from the reader", () => {
  const pinnedCommit = "a".repeat(40);
  const policy = basePolicy({
    model_origins: {
      "openrouter/qwen/qwen3-coder-plus": {
        vendor: "alibaba",
        evidence: { source: "docs/qwen.md", commit: pinnedCommit, sha256: sha(qwenEvidence) },
      },
    },
  });
  const seen: Array<{ source: string; commit?: string | undefined }> = [];
  const result = validateRosterDocument(policy, (source: string, commit?: string) => {
    seen.push({ source, commit });
    return qwenEvidence;
  });
  assert.equal(result.required_critics["review-arch"], "fable-claude");
  assert.deepEqual(seen, [{ source: "docs/qwen.md", commit: pinnedCommit }]);
});

test("model origin evidence refuses a malformed pinned commit", () => {
  const policy = basePolicy({
    model_origins: {
      "openrouter/qwen/qwen3-coder-plus": {
        vendor: "alibaba",
        evidence: { source: "docs/qwen.md", commit: "not-a-commit", sha256: sha(qwenEvidence) },
      },
    },
  });
  assert.throws(() => validateRosterDocument(policy, () => qwenEvidence), /invalid origin evidence commit/);
});

test("the checkout role and model files assemble a policy that validates", () => {
  const load = (dir: string, skipInventory: boolean) => readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") && !(skipInventory && name === "inventory.yaml"))
    .map((name) => parse(readFileSync(join(dir, name), "utf8")));
  const policy = assembleRosterPolicy(load(".kxm/models", true), load(".kxm/roles", false));
  const routes = readFileSync(".kxm/routes.yaml");
  const validated = validateRosterDocument(policy, (source: string) => source === ".kxm/routes.yaml" ? routes : undefined);
  assert.deepEqual(validated.lineup.writer, ["grok-native", "qwen-openrouter-pi", "gemini-agy"]);
  assert.equal(validated.required_critics["review-arch"], "fable-claude");
  assert.equal(validated.required_critics["review-cli"], "sol-codex");
  assert.equal(validated.routes["qwen-openrouter-pi"]?.permissions[0], "edit");
});

