import assert from "node:assert/strict";
import test from "node:test";
import {
  ROLE_POLICIES,
  arbitrate,
  explainContextItem,
  journalEntryToContextItem,
  memoryRecordToContextItem,
  rolePolicy,
  type RoleContextPolicy,
} from "../../plugins/kxm/src/arbiter.ts";
import { parseContextItem, type ContextItem } from "../../plugins/kxm/src/context.ts";
import { rankRecall, relevanceTokens, scoreRelevance } from "../../plugins/kxm/src/relevance.ts";
import { workflowWebhookHeaders, type WorkflowJournalEntry } from "../../plugins/kxm/src/workflow.ts";

function poolItem(overrides: Record<string, unknown> = {}): ContextItem {
  return parseContextItem({
    id: "ctx_pool1",
    kind: "knowledge",
    project: "kxm",
    summary: "architecture uses a durable workflow journal",
    provenance: { sourceType: "workflow", sourceRef: "journal:1" },
    authority: "evidence",
    confidence: "probable",
    ...overrides,
  });
}

function journalEntry(overrides: Partial<WorkflowJournalEntry> = {}): WorkflowJournalEntry {
  return {
    id: "journal_1",
    runId: "run_1",
    agentId: "agent_coord",
    category: "error",
    area: "gates",
    severity: "warning",
    summary: "flaky playwright gate timed out",
    evidence: ["class:flaky_gate"],
    relatedEntryIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as WorkflowJournalEntry;
}

test("role policies cover the five default roles with fixed budgets", () => {
  assert.deepEqual(ROLE_POLICIES.map((policy) => policy.role), [
    "repro",
    "planner",
    "critic",
    "implementer",
    "verifier",
  ]);
  const budgetOf = (role: string): number => ROLE_POLICIES.find((policy) => policy.role === role)!.budgetTokens;
  assert.equal(budgetOf("repro"), 8_000);
  assert.equal(budgetOf("planner"), 16_000);
  assert.equal(budgetOf("critic"), 12_000);
  assert.equal(budgetOf("implementer"), 16_000);
  assert.equal(budgetOf("verifier"), 8_000);
  // Custom roles get a safe generic policy.
  const custom: RoleContextPolicy = rolePolicy("triage");
  assert.equal(custom.role, "triage");
  assert.equal(custom.budgetTokens, 32_000);

  // Every journal category a role recalls reaches a delivered section of that
  // role's packet (contradictions route to their own section).
  for (const policy of ROLE_POLICIES) {
    for (const category of policy.journalCategories) {
      if (category === "contradiction") continue;
      const item = journalEntryToContextItem(journalEntry({ id: `journal_${category}`, category }), "kxm");
      const { packet } = arbitrate({ project: "kxm", role: policy.role, task: "x" }, [item]);
      const delivered = [
        ...packet.currentState,
        ...packet.knowledge,
        ...packet.evidence,
        ...packet.episodes,
        ...packet.skills,
      ].map((candidate) => candidate.id);
      assert.equal(delivered.includes(item.id), true, `${policy.role} must receive its ${category} entries`);
    }
  }
});

test("arbitrate assembles role-aware packets deterministically", () => {
  const pool = [
    poolItem({ id: "ctx_k1", kind: "knowledge", confidence: "verified" }),
    poolItem({ id: "ctx_e1", kind: "evidence", confidence: "verified" }),
    poolItem({ id: "ctx_s1", kind: "state", stateKey: "ci.pipeline", status: "current" }),
    poolItem({ id: "ctx_ep1", kind: "episode" }),
    poolItem({ id: "ctx_sk1", kind: "skill", evidenceRefs: ["receipt:run_1"] }),
    poolItem({ id: "ctx_dead", kind: "knowledge", status: "superseded" }),
  ];
  const request = { project: "kxm", role: "planner", task: "plan the CI migration" };
  const first = arbitrate(request, pool);
  const second = arbitrate(request, pool);
  // Same inputs, same packet: deterministic selection.
  assert.deepEqual(first.packet, second.packet);
  assert.deepEqual(first.audit, second.audit);

  // Planner policy prefers state/knowledge/evidence; superseded excluded.
  assert.equal(first.audit.excludedSuperseded, 1);
  assert.equal(first.packet.currentState.some((item) => item.id === "ctx_s1"), true);
  assert.equal(first.packet.knowledge.some((item) => item.id === "ctx_k1"), true);
  assert.equal(first.packet.contradictions.length, 0);
  assert.equal(first.packet.estimatedTokens <= 16_000, true);
  assert.equal(first.audit.budgetTokens, 16_000);
  assert.equal(JSON.stringify(first.audit.selectedIds).includes("ctx_dead"), false);

  // Verifier role gets a different, evidence-first packet from the same pool.
  const verifier = arbitrate({ project: "kxm", role: "verifier", task: "verify the fix" }, pool);
  assert.deepEqual(verifier.packet, arbitrate({ project: "kxm", role: "verifier", task: "verify the fix" }, pool).packet);
});

test("arbitrate enforces token budgets and records unresolved gaps", () => {
  // 3900 chars parses (limit is 4000) but estimates well over 512 tokens.
  const big = poolItem({ id: "ctx_big", summary: "x".repeat(3_900) });
  const small = poolItem({ id: "ctx_small", kind: "evidence", summary: "tiny" });
  const outcome = arbitrate(
    { project: "kxm", role: "verifier", task: "verify", budgetTokens: 512 },
    [big, small],
  );
  // The oversized candidate is deferred, not silently truncated.
  assert.equal(outcome.packet.knowledge.some((item) => item.id === "ctx_big"), false);
  assert.equal(outcome.audit.unresolvedGaps.some((gap) => gap.includes("budget")), true);
  assert.equal(outcome.packet.estimatedTokens <= 512, true);
  assert.deepEqual(outcome.audit.selectedIds, ["ctx_small"]);
  assert.deepEqual(outcome.packet.evidence.map((item) => item.id), ["ctx_small"]);
  assert.deepEqual(outcome.audit.unresolvedGaps, ["budget of 512 tokens reached; 1 candidates deferred"]);

  // First-fit: the top-ranked oversized item is skipped and reported while a
  // smaller eligible item still fills the budget; the skill is not eligible
  // for the verifier, so it is not counted as deferred.
  const oversized = poolItem({ id: "ctx_1", kind: "evidence", summary: "flaky ".repeat(500) });
  const fits = poolItem({ id: "ctx_2", kind: "evidence", summary: "small" });
  const ineligible = poolItem({ id: "ctx_3", kind: "skill", summary: "x" });
  const firstFit = arbitrate(
    { project: "kxm", role: "verifier", task: "flaky", budgetTokens: 512 },
    [oversized, fits, ineligible],
  );
  assert.deepEqual(firstFit.audit.selectedIds, ["ctx_2"]);
  assert.deepEqual(firstFit.audit.unresolvedGaps, ["budget of 512 tokens reached; 1 candidates deferred"]);

  const nothingFits = arbitrate(
    { project: "kxm", role: "verifier", task: "flaky", budgetTokens: 512 },
    [oversized],
  );
  assert.deepEqual(nothingFits.audit.unresolvedGaps, ["budget of 512 tokens cannot fit any selected context"]);
});

test("arbitrate ranks task-relevant candidates first, delivers every selected item in a packet section, orders ties newest first, and reports relevance", () => {
  // Deterministic lexical primitives: no model, no clock, no randomness.
  assert.deepEqual(
    relevanceTokens("The flaky Playwright gates timed-out on CI; retries: 2"),
    ["flaky", "playwright", "gate", "timed", "out", "ci", "retry"],
  );
  const scores = scoreRelevance("reproduce the flaky playwright gate", [
    "flaky playwright gate timed out",
    "gate slow",
    "retry flaky gates",
    "docs typo fixed",
  ]);
  assert.equal(scores[0]! > scores[2]!, true);
  assert.equal(scores[2]! > scores[1]!, true);
  assert.equal(scores[1]! > scores[3]!, true);
  assert.equal(scores[3], 0);
  assert.deepEqual(scoreRelevance("the of", ["the flaky gate", "one of the gates"]), [0, 0]);

  // Recall ranking: exact-phrase hits, then any-token BM25 hits, then id.
  const recallPool = [
    poolItem({ id: "ctx_a", summary: "docs typo fixed" }),
    poolItem({ id: "ctx_b", summary: "gate slow on CI" }),
    poolItem({ id: "ctx_c", summary: "flaky playwright gate needs bounded retries" }),
  ];
  const tokenHits = rankRecall("flaky gate", recallPool, 25);
  assert.deepEqual(tokenHits.map((hit) => hit.item.id), ["ctx_c", "ctx_b"]);
  assert.equal(tokenHits[1]!.relevance > 0, true);
  assert.equal(tokenHits[0]!.relevance > tokenHits[1]!.relevance, true);
  assert.deepEqual(rankRecall("flak", recallPool, 25).map((hit) => hit.item.id), ["ctx_c"]);
  assert.deepEqual(rankRecall("", recallPool, 2).map((hit) => hit.item.id), ["ctx_a", "ctx_b"]);

  // Task-matched candidates outrank role kind priority; the rest keep it.
  const pool = [
    poolItem({ id: "ctx_e_aaa", kind: "evidence", summary: "docs build is slow" }),
    poolItem({ id: "ctx_e_zzz", kind: "evidence", summary: "flaky playwright gate fails on first run" }),
    poolItem({ id: "ctx_k_mmm", kind: "knowledge", summary: "playwright gate owner is QA" }),
  ];
  const outcome = arbitrate({ project: "kxm", role: "verifier", task: "verify the flaky playwright gate fix" }, pool);
  assert.deepEqual(outcome.audit.selectedIds, ["ctx_e_zzz", "ctx_k_mmm", "ctx_e_aaa"]);
  assert.deepEqual(outcome.packet.evidence.map((item) => item.id), ["ctx_e_zzz", "ctx_e_aaa"]);
  // Every selected item is delivered in exactly one packet section.
  const delivered = [
    ...outcome.packet.currentState,
    ...outcome.packet.knowledge,
    ...outcome.packet.evidence,
    ...outcome.packet.episodes,
    ...outcome.packet.skills,
    ...outcome.packet.contradictions,
  ].map((item) => item.id).sort();
  assert.deepEqual(delivered, [...outcome.audit.selectedIds].sort());
  // Relevance audit is numbers only.
  assert.equal(outcome.audit.relevance.taskTokens, 5);
  assert.equal(outcome.audit.relevance.matchedCandidates, 2);
  const selectedRelevance = outcome.audit.relevance.selected;
  assert.equal(selectedRelevance.length, outcome.audit.selectedIds.length);
  for (let index = 1; index < selectedRelevance.length; index += 1) {
    assert.equal(selectedRelevance[index - 1]! > selectedRelevance[index]!, true);
  }
  assert.equal(selectedRelevance.at(-1), 0);
  for (const value of selectedRelevance) assert.equal(Math.round(value * 1000) / 1000, value);

  // No task match: role kind priority, then id (no recency on these items).
  assert.deepEqual(
    arbitrate({ project: "kxm", role: "verifier", task: "verify" }, pool).audit.selectedIds,
    ["ctx_e_aaa", "ctx_e_zzz", "ctx_k_mmm"],
  );

  // Recency: equally relevant journal evidence orders newest first, not by id.
  const older = journalEntryToContextItem(
    journalEntry({ id: "journal_0000", summary: "gate timed out", createdAt: "2026-01-01T00:00:00.000Z" }),
    "kxm",
  );
  const newer = journalEntryToContextItem(
    journalEntry({ id: "journal_ffff", summary: "gate timed out", createdAt: "2026-01-02T00:00:00.000Z" }),
    "kxm",
  );
  const recency = arbitrate({ project: "kxm", role: "verifier", task: "gate" }, [older, newer]);
  assert.deepEqual(recency.audit.selectedIds, ["journal_journal_ffff", "journal_journal_0000"]);
  assert.deepEqual(recency.packet.evidence.map((item) => item.id), ["journal_journal_ffff", "journal_journal_0000"]);
});

test("arbitrate routes contradictions and reports empty pools", () => {
  const a = poolItem({ id: "ctx_prop_a", kind: "state", stateKey: "ci.pipeline", status: "proposed" });
  const b = poolItem({ id: "ctx_prop_b", kind: "state", stateKey: "ci.pipeline", status: "proposed" });
  const outcome = arbitrate(
    { project: "kxm", role: "critic", task: "review contradictions" },
    [a, b],
    { contradictionIds: ["ctx_prop_a", "ctx_prop_b"] },
  );
  assert.deepEqual(outcome.packet.contradictions.map((item) => item.id).sort(), ["ctx_prop_a", "ctx_prop_b"]);
  assert.equal(outcome.packet.currentState.length, 0);
  assert.equal(outcome.packet.knowledge.length, 0);

  const empty = arbitrate({ project: "kxm", role: "repro", task: "reproduce" }, []);
  assert.deepEqual(empty.packet.knowledge, []);
  assert.deepEqual(empty.audit.unresolvedGaps, ["no context records exist for this project yet"]);
});

test("arbitrate fails closed on cross-project pool content", () => {
  const foreign = poolItem({ id: "ctx_foreign", project: "other" });
  assert.throws(
    () => arbitrate({ project: "kxm", role: "planner", task: "plan" }, [foreign]),
    /cross-project/,
  );
});

test("arbitrate allows _shared items and ranks project items ahead of shared items", () => {
  const sharedItem = poolItem({
    id: "ctx_shared",
    project: "_shared",
    summary: "shared default preference",
  });
  const projectItem = poolItem({
    id: "ctx_proj",
    project: "kxm",
    summary: "project specific knowledge",
  });
  const outcome = arbitrate(
    { project: "kxm", role: "planner", task: "plan", budgetTokens: 16_000 },
    [sharedItem, projectItem],
  );
  assert.equal(outcome.packet.knowledge.length, 2);
  // Project item comes before shared item
  assert.equal(outcome.packet.knowledge[0]?.id, "ctx_proj");
  assert.equal(outcome.packet.knowledge[1]?.id, "ctx_shared");
});

test("memoryRecordToContextItem converts authored memory records correctly", () => {
  const record = {
    schema: "kxm.memory.v1" as const,
    id: "arch_dec_1",
    scope: "project" as const,
    kind: "decision",
    summary: "Use WAL journal mode for SQLite databases",
    provenance: { sourceType: "git", sourceRef: "memory:arch_dec_1.md" },
    authority: "instruction" as const,
    confidence: "verified" as const,
    lifecycle: "active" as const,
    evidenceRefs: ["evidence:e6"],
  };
  const item = memoryRecordToContextItem(record, "kxm");
  assert.equal(item.id, "mem_arch_dec_1");
  assert.equal(item.project, "kxm");
  assert.equal(item.kind, "knowledge");
  assert.equal(item.authority, "instruction");
  assert.equal(item.confidence, "verified");
  assert.equal(item.status, "current");

  // Operator scope routes to _shared project
  const opRecord = { ...record, scope: "operator" as const, id: "op_pref_1" };
  const opItem = memoryRecordToContextItem(opRecord, "kxm");
  assert.equal(opItem.project, "_shared");
});

test("journal entries convert to evidence and knowledge context items", () => {
  const errorItem = journalEntryToContextItem(journalEntry(), "kxm");
  assert.equal(errorItem.kind, "evidence");
  assert.equal(errorItem.provenance.sourceType, "workflow");
  assert.equal(errorItem.provenance.sourceRef, "journal:journal_1");
  assert.equal(errorItem.authority, "evidence");
  assert.deepEqual(errorItem.evidenceRefs, ["class:flaky_gate"]);

  const decisionItem = journalEntryToContextItem(journalEntry({ category: "decision" }), "kxm");
  assert.equal(decisionItem.kind, "knowledge");

  const candidateItem = journalEntryToContextItem(journalEntry({ category: "skill-candidate" }), "kxm");
  assert.equal(candidateItem.kind, "skill");
  assert.equal(candidateItem.status, "proposed");

  // Oversized evidence strings are dropped, not a parse failure.
  const clipped = journalEntryToContextItem(journalEntry({ evidence: ["x".repeat(500), "ok:ref"] }), "kxm");
  assert.deepEqual(clipped.evidenceRefs, ["ok:ref"]);
});

test("explain traces lineage and sources without raw bodies", () => {
  const origin = poolItem({ id: "ctx_origin", provenance: { sourceType: "git", sourceRef: "docs/arch.md" } });
  const derived = poolItem({
    id: "ctx_derived",
    provenance: { sourceType: "derived", derivedFrom: ["ctx_origin"] },
  });
  const pool = [origin, derived];
  const explanation = explainContextItem("ctx_derived", pool);
  assert.equal(explanation.item?.id, "ctx_derived");
  assert.deepEqual(explanation.lineage, ["ctx_origin"]);
  assert.deepEqual(explanation.sources.map((source) => source.id), ["ctx_derived", "ctx_origin"]);
  assert.deepEqual(explanation.sources[1]?.sourceRef, "docs/arch.md");
  // Unknown items explain to a safe empty result.
  assert.deepEqual(explainContextItem("ctx_missing", pool).lineage, []);
});

test("hub context surfaces: role packets, recall, state, episodes, explain, parity", async (context) => {
  const { createTestMesh } = await import("../helpers.ts");
  const secret = "context-hub-secret-with-entropy";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "context-hub",
      source: "generic",
      project: "test-project",
      target: "coordinator",
      secret,
      delivery: "followUp",
      promptTemplate: "Handle {{task}}",
      stages: [{ id: "gate", label: "Gate", instructions: "Run gate", requiredEvidence: ["result"], maxAttempts: 2 }],
    }],
  });
  const coordinator = mesh.makeClient("coordinator");
  await coordinator.start(async (event) => {
    if (event.type === "message") await coordinator.acknowledge(event.message.id);
  });
  const payload = JSON.stringify({ task: "context-hub" });
  const trigger = await fetch(`${mesh.address.url}/v1/webhooks/context-hub`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...workflowWebhookHeaders({ secret: secret, scope: { definitionId: "context-hub" }, deliveryId: "context-hub-1", body: payload }),
    },
    body: payload,
  });
  const accepted = await trigger.json() as { run: { id: string } };
  await coordinator.recordWorkflowEntry(accepted.run.id, {
    category: "lesson",
    area: "gates",
    summary: "flaky playwright gate needs bounded retries",
    evidence: ["class:flaky_gate"],
    stageId: "gate",
  });

  // Agent surface: role-aware packet over the journal-backed pool.
  const packet = await coordinator.contextGet({
    project: "test-project",
    role: "repro",
    task: "reproduce the flaky gate",
    workflowRunId: accepted.run.id,
  });
  assert.equal(packet.packet.episodes.length + packet.packet.knowledge.length >= 1, true);
  assert.equal(packet.audit.request.project, "test-project");
  assert.equal(packet.audit.budgetTokens, 8_000);
  assert.equal(JSON.stringify(packet.audit.selectedIds).includes("journal_"), true);

  // Recall returns metadata only, no raw summaries.
  const recall = await coordinator.contextRecall({
    project: "test-project",
    query: "flaky",
  });
  assert.equal(recall.items.length >= 1, true);
  for (const item of recall.items) {
    assert.equal("summary" in item, false);
    assert.equal(typeof item.id, "string");
  }

  // Episodes surface the journal learning for the run.
  const episodes = await coordinator.contextEpisode({
    project: "test-project",
    workflowRunId: accepted.run.id,
  });
  assert.equal(episodes.episodes.length, 1);
  assert.equal(episodes.episodes[0]?.provenance.sourceRef, `journal:${coordinatorJournalId(episodes.episodes[0]!.id)}`);

  // State propose (agent) then explain.
  const proposed = await coordinator.contextStatePropose({
    project: "test-project",
    key: "ci.pipeline",
    summary: "CI pipeline should retry flaky gates twice",
    authority: "evidence",
    confidence: "probable",
    evidenceRefs: ["journal:lesson"],
  });
  assert.match(proposed.proposalId, /^ctx_/);
  // A proposal is not yet current truth.
  const state = await coordinator.contextState({ project: "test-project", key: "ci.pipeline" });
  assert.equal(state.state, null);

  // Cross-project isolation: an agent cannot query another project.
  await assert.rejects(
    () => coordinator.contextGet({ project: "other-project", role: "planner", task: "plan" }),
    /isolation|forbidden|403|project/,
  );
  await assert.rejects(
    () => coordinator.contextState({ project: "other-project", key: "ci.pipeline" }),
    /isolation|forbidden|403|project/,
  );

  // Explain over a journal-derived item returns lineage and sources.
  const explain = await coordinator.contextExplain({
    project: "test-project",
    id: packet.audit.selectedIds[0]!,
  });
  assert.equal(explain.found, true);
  assert.equal(Array.isArray(explain.sources), true);

  // Parity: CLI and MCP call the same endpoints. The CLI helper posts to the
  // identical paths with the admin token; verify one representative call.
  const { hubContextPost } = await import("../../plugins/kxm/src/cli.ts");
  const cliState = await hubContextPost({
    serverUrl: mesh.address.url,
    path: "/v1/context/state",
    body: { project: "test-project", key: "ci.pipeline" },
    authToken: mesh.token,
    fetchImpl: fetch,
  });
  assert.equal(cliState.ok, true);
  assert.deepEqual(cliState.body, { state: null, key: "ci.pipeline" });

  // Admin promotes the proposal; the state becomes current and historical
  // queries see the previous emptiness.
  const promote = await fetch(`${mesh.address.url}/v1/context/state/promote`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mesh.token}` },
    body: JSON.stringify({ project: "test-project", proposalId: proposed.proposalId, evidence: ["receipt:context-hub-1"] }),
  });
  assert.equal(promote.status, 200);
  const promotedBody = await promote.json() as { state: { status: string; stateKey?: string } };
  assert.equal(promotedBody.state.status, "current");
  assert.equal(promotedBody.state.stateKey, "ci.pipeline");
  const currentState = await coordinator.contextState({ project: "test-project", key: "ci.pipeline" });
  assert.equal(currentState.state?.status, "current");

  // Non-admin promotion is rejected.
  const rejected = await fetch(`${mesh.address.url}/v1/context/state/promote`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ project: "test-project", proposalId: "ctx_missing", evidence: ["x"] }),
  });
  assert.equal(rejected.status, 401);
});

function coordinatorJournalId(itemId: string): string {
  return itemId.replace(/^journal_/, "");
}
