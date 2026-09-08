import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CONTEXT_ITEM_SCHEMA,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_ID_REFS,
  MAX_CONTEXT_SUMMARY_CHARS,
  MAX_CONTEXT_ITEMS,
  MIN_CONTEXT_BUDGET_TOKENS,
  authorityRank,
  contextItemAuditMetadata,
  deriveContextItem,
  estimateContextTokens,
  parseContextItem,
  parseContextRequest,
  provenanceSummaryOf,
  validateContextPacketContents,
  type ContextItem,
  type ContextPacket,
} from "../../plugins/kxm/src/context.ts";
import {
  ContextProviderRegistry,
  type ContextProvider,
  type StateChangeProposal,
  type StateProvider,
} from "../../plugins/kxm/src/context/providers.ts";
import { MeshStore } from "../../plugins/kxm/src/store.ts";

function item(overrides: Record<string, unknown> = {}): ContextItem {
  return parseContextItem({
    id: "ctx_test1",
    kind: "evidence",
    project: "kxm",
    summary: "repro test failed on CI worker 2",
    provenance: { sourceType: "workflow", sourceRef: "run_1/stage/repro" },
    authority: "evidence",
    confidence: "verified",
    ...overrides,
  });
}

test("parseContextItem round-trips every item kind with stable schema", () => {
  const kinds = ["evidence", "state", "episode", "knowledge", "skill"] as const;
  for (const kind of kinds) {
    const stateExtras = kind === "state" ? { stateKey: "ci.pipeline", status: "current" } : {};
    const parsed = item({ id: `ctx_${kind}`, kind, ...stateExtras });
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.project, "kxm");
    assert.equal(parsed.provenance.sourceType, "workflow");
    assert.equal(parsed.authority, "evidence");
    assert.equal(parsed.confidence, "verified");
    // JSON round-trip must be lossless for deterministic storage.
    const restored = parseContextItem(JSON.parse(JSON.stringify(parsed)));
    assert.deepEqual(restored, parsed);
  }
  assert.equal(CONTEXT_ITEM_SCHEMA, "kxm.context-item.v1");
});

test("parseContextItem fails closed on invalid and hostile input", () => {
  assert.throws(() => parseContextItem(null), /must be an object/);
  assert.throws(() => parseContextItem("text"), /must be an object/);
  assert.throws(() => parseContextItem({}), /id/);
  assert.throws(() => item({ kind: "policy" }), /kind/);
  assert.throws(() => item({ summary: "x".repeat(MAX_CONTEXT_SUMMARY_CHARS + 1) }), /exceeds/);
  assert.throws(() => item({ authority: "root" }), /authority/);
  assert.throws(() => item({ confidence: "surely" }), /confidence/);
  assert.throws(() => item({ status: "archived" }), /status/);
  assert.throws(() => item({ provenance: { sourceType: "hallucination" } }), /sourceType/);
  assert.throws(() => item({ observedAt: "yesterday" }), /ISO-8601/);
  assert.throws(() => item({ id: "ctx_self", supersedes: ["ctx_self"] }), /cannot supersede itself/);
  assert.throws(
    () => item({ evidenceRefs: Array.from({ length: MAX_CONTEXT_ID_REFS + 1 }, (_, index) => `ref_${index}`) }),
    /exceeds/,
  );
  assert.throws(() => item({ evidenceRefs: ["a", "a"] }), /duplicate reference/);
});

test("parseContextRequest enforces project scoping and budget bounds", () => {
  const request = parseContextRequest({
    project: "kxm",
    role: "planner",
    task: "plan the fix",
    budgetTokens: 8_000,
    includeKinds: ["state", "knowledge"],
  });
  assert.equal(request.project, "kxm");
  assert.equal(request.role, "planner");
  assert.equal(request.budgetTokens, 8_000);
  assert.deepEqual(request.includeKinds, ["state", "knowledge"]);

  assert.throws(() => parseContextRequest({ role: "planner", task: "t" }), /project/);
  assert.throws(() => parseContextRequest({ project: "kxm", task: "t" }), /role/);
  assert.throws(() => parseContextRequest({ project: "kxm", role: "planner" }), /task/);
  assert.throws(
    () => parseContextRequest({ project: "kxm", role: "planner", task: "t", budgetTokens: MIN_CONTEXT_BUDGET_TOKENS - 1 }),
    /budgetTokens/,
  );
  assert.throws(
    () => parseContextRequest({ project: "kxm", role: "planner", task: "t", budgetTokens: MAX_CONTEXT_BUDGET_TOKENS + 1 }),
    /budgetTokens/,
  );
  assert.throws(
    () => parseContextRequest({ project: "kxm", role: "planner", task: "t", includeKinds: [] }),
    /includeKinds/,
  );
  assert.equal(parseContextRequest({ project: "kxm", role: "critic", task: "t" }).budgetTokens, undefined);
  assert.equal(DEFAULT_CONTEXT_BUDGET_TOKENS, 32_000);
});

test("validateContextPacketContents fails closed on cross-project and unrequested kinds", () => {
  const request = parseContextRequest({ project: "kxm", role: "planner", task: "t" });
  const packet: ContextPacket = {
    workingState: {},
    currentState: [item()],
    knowledge: [],
    episodes: [],
    skills: [],
    contradictions: [],
    unresolvedGaps: [],
    provenanceSummary: {},
    estimatedTokens: 16,
  };
  validateContextPacketContents(request, packet);

  const foreign = item({ id: "ctx_foreign", project: "other-project" });
  assert.throws(
    () => validateContextPacketContents(request, { ...packet, currentState: [foreign] }),
    /cross-project/,
  );

  const scopedRequest = parseContextRequest({
    project: "kxm",
    role: "planner",
    task: "t",
    includeKinds: ["state"],
  });
  assert.throws(
    () => validateContextPacketContents(scopedRequest, packet),
    /unrequested kind evidence/,
  );

  const flood = Array.from({ length: MAX_CONTEXT_ITEMS + 1 }, (_, index) =>
    item({ id: `ctx_flood_${index}` }),
  );
  assert.throws(
    () => validateContextPacketContents(request, { ...packet, currentState: flood }),
    /exceeds/,
  );
});

test("authority cannot increase through derivation", () => {
  const evidence = item({ id: "ctx_ev1", authority: "evidence", confidence: "verified" });
  const hypothesis = item({ id: "ctx_hy1", authority: "hypothesis" });

  const summaryOfSummaries = deriveContextItem(
    { project: "kxm", kind: "knowledge", summary: "compiled from evidence" },
    "instruction",
    [evidence, hypothesis],
    "wiki/compiler",
  );
  assert.equal(summaryOfSummaries.provenance.sourceType, "derived");
  assert.deepEqual(summaryOfSummaries.provenance.derivedFrom, ["ctx_ev1", "ctx_hy1"]);
  // Claimed instruction authority over evidence lineage must clamp down.
  assert.equal(summaryOfSummaries.authority, "evidence");

  const plain = deriveContextItem(
    { project: "kxm", kind: "knowledge", summary: "derived note" },
    "hypothesis",
    [evidence],
  );
  assert.equal(plain.authority, "hypothesis");
  assert.equal(authorityRank("policy") > authorityRank("instruction"), true);
  assert.equal(authorityRank("instruction") > authorityRank("evidence"), true);
  assert.equal(authorityRank("evidence") > authorityRank("hypothesis"), true);
});

test("audit metadata and token estimation never expose raw bodies", () => {
  const metadata = contextItemAuditMetadata(item());
  assert.deepEqual(metadata, {
    id: "ctx_test1",
    kind: "evidence",
    authority: "evidence",
    confidence: "verified",
    sourceType: "workflow",
    sourceRef: "run_1/stage/repro",
    derived: false,
    lineageDepth: 0,
  });
  assert.equal("summary" in metadata, false);
  assert.equal(JSON.stringify(metadata).includes("repro test failed"), false);

  const tokens = estimateContextTokens([item()]);
  assert.ok(tokens > 0);
  assert.equal(estimateContextTokens([]), 0);

  const summary = provenanceSummaryOf([item(), item({ id: "ctx_test2", provenance: { sourceType: "peer" } })]);
  assert.deepEqual(summary, { peer: 1, workflow: 1 });
});

test("provider registry fails closed and hides provider failures", async () => {
  const registry = new ContextProviderRegistry();
  const healthy: ContextProvider = {
    name: "native",
    recall: async (request) => [item({ id: `ctx_${request.project}` })],
    healthy: async () => true,
  };
  const broken: ContextProvider = {
    name: "broken",
    recall: async () => {
      throw new Error("backend exploded");
    },
    healthy: async () => false,
  };
  registry.registerContextProvider(healthy);
  registry.registerContextProvider(broken);
  const results = await registry.recallFromAll({ project: "kxm", kinds: ["evidence"], limit: 4 });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.project, "kxm");
  assert.deepEqual(registry.contextProviderNames, ["broken", "native"]);
});

test("state provider seam carries the v1 proposal schema", () => {
  const proposal: StateChangeProposal = {
    schema: "kxm.state-change-proposal.v1",
    project: "kxm",
    key: "ci.pipeline",
    summary: "pipeline moved to gitlab",
    authority: "evidence",
    confidence: "verified",
    evidenceRefs: ["ctx_ev1"],
    proposedBy: "agent_repro",
  };
  assert.equal(proposal.schema, "kxm.state-change-proposal.v1");
  const provider: StateProvider = {
    name: "native",
    get: async () => null,
    propose: async () => "proposal_1",
    promote: async () => item({ id: "ctx_state1", kind: "state", status: "current" }),
    supersededBy: async () => null,
  };
  const registry = new ContextProviderRegistry();
  registry.registerStateProvider(provider);
  assert.deepEqual(registry.stateProviderNames, ["native"]);
});

test("context items persist project-isolated across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "kxm-context-"));
  const path = join(directory, "kxm.db");
  try {
    const first = new MeshStore(path);
    first.saveContextItem(item({ id: "ctx_keep", project: "kxm" }));
    first.saveContextItem(item({ id: "ctx_other", project: "other" }));
    first.close();

    const second = new MeshStore(path);
    const kxmItems = second.listContextItems("kxm");
    assert.equal(kxmItems.length, 1);
    assert.equal(kxmItems[0]?.id, "ctx_keep");
    assert.equal(second.listContextItems("other").length, 1);
    assert.equal(second.listContextItems("missing").length, 0);
    // Cross-project lookup by ID fails closed to undefined.
    assert.equal(second.getContextItem("ctx_other", "kxm"), undefined);
    assert.equal(second.getContextItem("ctx_keep", "kxm")?.id, "ctx_keep");
    assert.equal(second.getContextItem("ctx_missing"), undefined);
    // Kind filtering is honored.
    assert.equal(second.listContextItems("kxm", ["state"]).length, 0);
    assert.equal(second.listContextItems("kxm", ["evidence"]).length, 1);
    second.close();

    // v0.4 databases upgrade in place to the context schema.
    const legacy = join(directory, "legacy.db");
    const database = new DatabaseSync(legacy);
    database.exec("PRAGMA user_version = 2");
    database.close();
    const upgraded = new MeshStore(legacy);
    const version = (upgraded as unknown as { database: DatabaseSync }).database
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    assert.equal(version.user_version, 3);
    assert.equal(upgraded.listContextItems("kxm").length, 0);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
