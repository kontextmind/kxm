import { strict as assert } from "node:assert";
import test from "node:test";
import {
  CONTEXT_PACKET_SCHEMA,
  HANDOFF_MANIFEST_SCHEMA,
  buildFormalContextPacket,
  formatContextPacketForPrompt,
  buildHandoffManifest,
  pruneContextPacket,
  estimateContextPacketTokens,
} from "../../plugins/kxm/src/context-packet.ts";
import type { ContextItem } from "../../plugins/kxm/src/context.ts";

test("formal context packet builds valid kxm.context-packet.v2 structure", () => {
  const items: ContextItem[] = [
    {
      id: "mem_shared_001",
      project: "_shared",
      kind: "knowledge",
      authority: "instruction",
      summary: "All PRs must include witness verification receipts",
      confidence: "verified",
      provenance: { sourceType: "git" },
      evidenceRefs: [],
    },
    {
      id: "mem_proj_001",
      project: "kxm",
      kind: "knowledge",
      authority: "instruction",
      summary: "Access control plane must support keyboard actions in TUI",
      confidence: "probable",
      provenance: { sourceType: "human" },
      evidenceRefs: [],
    },
    {
      id: "state_001",
      project: "kxm",
      kind: "state",
      authority: "policy",
      summary: "Run run_123 in progress",
      confidence: "verified",
      provenance: { sourceType: "workflow" },
      evidenceRefs: [],
    },
  ];

  const packet = buildFormalContextPacket({
    project: "kxm",
    targetRole: "writer",
    task: {
      taskId: "task_456",
      stepId: "step_write",
      stepAttempt: 1,
      objective: "Implement TUI access control plane keys",
      allowedOutcomes: ["passed", "failed"],
      permissionCeiling: "edit",
    },
    acceptanceCriteria: [
      {
        id: "crit_01",
        description: "npm run verify passes exit 0",
        verificationKind: "witness",
        required: true,
      },
    ],
    plan: {
      planHash: "plan_sha256_xyz",
      activeStepIndex: 1,
      totalSteps: 3,
      settledDecisions: ["Use Node 22 native sqlite"],
    },
    arbitratedItems: items,
    tokenBudget: 8000,
  });

  assert.equal(packet.schema, CONTEXT_PACKET_SCHEMA);
  assert.equal(packet.project, "kxm");
  assert.equal(packet.targetRole, "writer");
  assert.equal(packet.task.permissionCeiling, "edit");
  assert.equal(packet.acceptanceCriteria.length, 1);
  assert.equal(packet.plan.planHash, "plan_sha256_xyz");
  assert.equal(packet.environment.sharedDefaults.length, 1);
  assert.equal(packet.environment.sharedDefaults[0]?.id, "mem_shared_001");
  assert.equal(packet.environment.projectKnowledge.length, 1);
  assert.equal(packet.environment.currentState.length, 1);
  assert.ok(packet.budget.estimatedTokens > 0);
  assert.ok(packet.budget.allocatedTokens === 8000);

  // Formatted prompt text
  const formatted = formatContextPacketForPrompt(packet);
  assert.match(formatted, /# Context Packet/);
  assert.match(formatted, /Implement TUI access control plane keys/);
  assert.match(formatted, /npm run verify passes exit 0/);
  assert.match(formatted, /All PRs must include witness verification receipts/);
});

test("structured handoff manifest builds valid kxm.handoff-manifest.v1 structure", () => {
  const manifest = buildHandoffManifest({
    taskId: "task_456",
    workflowRunId: "run_123",
    source: {
      role: "writer",
      agentId: "grok-native",
      harness: "grok",
      model: "grok-4.6",
      stepId: "step_write",
      attemptId: "att_001",
    },
    target: {
      role: "reviewer-arch",
      permission: "read-only",
    },
    intent: "request_review",
    baseCommit: "abcdef1234567890",
    candidateTreeHash: "9876543210abcdef",
    deliverables: {
      patches: ["plugins/kxm/src/tui.ts"],
      reports: ["Artifacts synced"],
      artifacts: [{ name: "witness-receipt", artifactRef: "artifact:logs/witness.json@sha256:111" }],
    },
    verificationEvidence: {
      witnessExitCode: 0,
      witnessPassed: true,
      criticVerdicts: [
        { critic: "reviewer-arch", verdict: "PASS", summary: "Clean separation of tokens" },
      ],
    },
    openQuestions: ["Should degrade open a worktree directly?"],
  });

  assert.equal(manifest.schema, HANDOFF_MANIFEST_SCHEMA);
  assert.equal(manifest.taskId, "task_456");
  assert.equal(manifest.workflowRunId, "run_123");
  assert.equal(manifest.source.role, "writer");
  assert.equal(manifest.target.role, "reviewer-arch");
  assert.equal(manifest.intent, "request_review");
  assert.equal(manifest.verificationEvidence.witnessPassed, true);
  assert.equal(manifest.openQuestions?.length, 1);
});

test("pruneContextPacket strictly executes Decision Q4 pruning hierarchy: L1 Defaults -> L2 Episodes -> L2 Docs -> L5 Artifacts with inviolable L3", () => {
  const sharedDefaults = [
    { id: "def_1", summary: "Default system rule: always lint before push with deterministic gates" },
    { id: "def_2", summary: "Default system rule: always preserve test evidence and witness proofs" },
  ];
  const projectKnowledge: ContextItem[] = [
    {
      id: "doc_1",
      project: "kxm",
      kind: "knowledge",
      authority: "instruction",
      summary: "Documentation on hub routing table architecture and failover mechanisms",
      confidence: "verified",
      provenance: { sourceType: "git" },
      evidenceRefs: [],
    },
  ];
  const currentState: ContextItem[] = [
    {
      id: "ep_1",
      project: "kxm",
      kind: "episode",
      authority: "evidence",
      summary: "Historical episode: worker timeout on large diff caused retry loop in previous run",
      confidence: "verified",
      provenance: { sourceType: "workflow" },
      evidenceRefs: [],
    },
    {
      id: "state_1",
      project: "kxm",
      kind: "state",
      authority: "policy",
      summary: "Current run state active",
      confidence: "verified",
      provenance: { sourceType: "workflow" },
      evidenceRefs: [],
    },
  ];
  const predecessors = [
    {
      stepId: "step_plan",
      role: "planner",
      status: "passed" as const,
      summary: "Plan settled with 3 steps and strict CAS leasing",
      settledAt: new Date().toISOString(),
      artifacts: [
        {
          name: "plan-spec",
          kind: "plan" as const,
          artifactRef: "artifact:plan.md",
          contentSnippet: "Step 1: Security\nStep 2: Context\nStep 3: Effects",
        },
      ],
      decisions: ["Use Node 22 native SQLite"],
    },
  ];

  const packet = buildFormalContextPacket({
    project: "kxm",
    targetRole: "writer",
    task: {
      taskId: "task_prune",
      stepId: "step_write",
      stepAttempt: 1,
      objective: "Implement token budget pruning engine",
      allowedOutcomes: ["passed", "failed"],
      permissionCeiling: "edit",
    },
    acceptanceCriteria: [
      { id: "ac_1", description: "All pruning stages verified", verificationKind: "witness", required: true },
    ],
    plan: {
      planHash: "plan_hash_1",
      activeStepIndex: 1,
      totalSteps: 2,
      settledDecisions: [],
    },
    predecessors,
    environment: {
      sharedDefaults,
      projectKnowledge,
      currentState,
      contradictions: [],
      activeSkills: [],
    },
  });

  const fullTokens = estimateContextPacketTokens(packet);
  assert.ok(fullTokens > 100);

  // Case 1: Budget ample -> no pruning
  const noPrune = pruneContextPacket(packet, fullTokens + 50);
  assert.equal(noPrune.audit.prunedStages.length, 0);
  assert.equal(noPrune.packet.environment.sharedDefaults.length, 2);

  // Case 2: Budget slightly below -> stage 1 L1 defaults pruned first
  const tightL1Budget = fullTokens - 15;
  const prunedL1 = pruneContextPacket(packet, tightL1Budget);
  assert.ok(prunedL1.audit.prunedStages.includes("L1_defaults"));
  assert.ok(prunedL1.packet.environment.sharedDefaults.length < 2);

  // Case 3: Budget forces through L1 and L2 (Episodes & Docs)
  const tightL2Budget = fullTokens - 60;
  const prunedL2 = pruneContextPacket(packet, tightL2Budget);
  assert.ok(prunedL2.audit.prunedStages.includes("L1_defaults"));
  assert.ok(prunedL2.audit.prunedStages.includes("L2_episodes") || prunedL2.audit.prunedStages.includes("L2_docs"));

  // Case 4: Severe budget pruning L1, L2, and L5 (Artifacts)
  const severeBudget = 60;
  const prunedSevere = pruneContextPacket(packet, severeBudget);
  assert.ok(prunedSevere.audit.prunedStages.includes("L1_defaults"));
  assert.ok(prunedSevere.audit.prunedStages.includes("L5_artifacts"));
  for (const pred of prunedSevere.packet.predecessors) {
    for (const art of pred.artifacts) {
      assert.equal(art.contentSnippet, undefined);
    }
  }

  // Case 5: L3 Task Objective Inviolable
  // Even with impossible budget (5 tokens), task objective, plan, and acceptance criteria are NEVER stripped
  const impossibleBudget = 5;
  const prunedImpossible = pruneContextPacket(packet, impossibleBudget);
  assert.equal(prunedImpossible.packet.task.objective, "Implement token budget pruning engine");
  assert.equal(prunedImpossible.packet.task.taskId, "task_prune");
  assert.equal(prunedImpossible.packet.plan.planHash, "plan_hash_1");
  assert.equal(prunedImpossible.packet.acceptanceCriteria.length, 1);
  assert.ok(prunedImpossible.audit.unresolvedGaps.includes("context_budget_exceeded_task_inviolable"));
});
