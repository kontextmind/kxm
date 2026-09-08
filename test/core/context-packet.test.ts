import { strict as assert } from "node:assert";
import test from "node:test";
import {
  CONTEXT_PACKET_SCHEMA,
  HANDOFF_MANIFEST_SCHEMA,
  buildFormalContextPacket,
  formatContextPacketForPrompt,
  buildHandoffManifest,
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
