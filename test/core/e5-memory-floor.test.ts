import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { arbitrate, journalEntryToContextItem } from "../../plugins/kxm/src/arbiter.ts";
import {
  parseContextItem,
  type ContextItem,
  type ContextScope,
} from "../../plugins/kxm/src/context.ts";
import { createMeshHub } from "../../plugins/kxm/src/hub.ts";
import { SkillLifecycle, skillContentSha256 } from "../../plugins/kxm/src/skills.ts";
import { MeshStore } from "../../plugins/kxm/src/store.ts";
import { NativeStateProvider } from "../../plugins/kxm/src/state.ts";
import { loadVnextProject } from "../../plugins/kxm/src/vnext-config.ts";
import {
  acceptVnextRun,
  closeVnextRuntimeContext,
  computeVnextMemoryRevision,
  openVnextRuntimeContext,
} from "../../plugins/kxm/src/vnext-runtime.ts";
import { newVnextCommandId } from "../../plugins/kxm/src/vnext-runtime-store.ts";
import { committedProject } from "../helpers/vnext-project.ts";
import { removeTempDir } from "../helpers.ts";

test("Rule 1: promotion requires configured admin token with no loopback bypass and records real caller", async () => {
  // 1. Hub without authToken rejects promotion even on loopback (no loopback bypass)
  const hubWithoutToken = createMeshHub({ host: "127.0.0.1", port: 0 });
  const addr1 = await hubWithoutToken.start();
  try {
    const res = await fetch(`${addr1.url}/v1/context/state/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "proj-1", proposalId: "prop-1", evidence: ["receipt:1"] }),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { code: string };
    assert.equal(body.code, "admin_auth_not_configured");
  } finally {
    await hubWithoutToken.close();
  }

  // 2. Hub with authToken requires valid token and records real caller
  const dir = mkdtempSync(join(tmpdir(), "kxm-e5-rule1-"));
  const dbPath = join(dir, "kxm.db");
  const hubWithToken = createMeshHub({
    host: "127.0.0.1",
    port: 0,
    authToken: "admin-secret-token",
    dataPath: dbPath,
  });
  const addr2 = await hubWithToken.start();
  try {
    // Missing or invalid token
    const res401 = await fetch(`${addr2.url}/v1/context/state/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "proj-1", proposalId: "prop-1", evidence: ["receipt:1"] }),
    });
    assert.equal(res401.status, 401);

    const proposeRes1 = await fetch(`${addr2.url}/v1/context/state/propose`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret-token",
        "x-kxm-caller-id": "agent-planner",
      },
      body: JSON.stringify({
        project: "proj-1",
        key: "deploy.target",
        summary: "target is production",
        authority: "instruction",
        confidence: "verified",
        evidenceRefs: ["doc:deploy"],
      }),
    });
    assert.equal(proposeRes1.status, 201);
    const { proposalId } = await proposeRes1.json() as { proposalId: string };

    // Valid token with real caller specified
    const promoteRes = await fetch(`${addr2.url}/v1/context/state/promote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret-token",
      },
      body: JSON.stringify({
        project: "proj-1",
        proposalId,
        evidence: ["receipt:verified-deploy"],
        promotedBy: "operator-eddie",
      }),
    });
    assert.equal(promoteRes.status, 200);
    const promotedBody = await promoteRes.json() as { state: ContextItem };
    assert.equal(promotedBody.state.status, "current");
    assert.equal(promotedBody.state.provenance.sourceRef, "promoted-by:operator-eddie");

    // Self-promotion is rejected: author cannot promote their own proposal
    const proposeRes2 = await fetch(`${addr2.url}/v1/context/state/propose`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret-token",
        "x-kxm-caller-id": "operator-eddie",
      },
      body: JSON.stringify({
        project: "proj-1",
        key: "deploy.env",
        summary: "staging",
        authority: "instruction",
        confidence: "verified",
        evidenceRefs: ["doc:env"],
      }),
    });
    assert.equal(proposeRes2.status, 201);
    const { proposalId: proposalId2 } = await proposeRes2.json() as { proposalId: string };

    const selfPromoteRes = await fetch(`${addr2.url}/v1/context/state/promote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret-token",
      },
      body: JSON.stringify({
        project: "proj-1",
        proposalId: proposalId2,
        evidence: ["receipt:env"],
        promotedBy: "operator-eddie",
      }),
    });
    assert.equal(selfPromoteRes.status, 400);
    const selfBody = await selfPromoteRes.json() as { code: string };
    assert.equal(selfBody.code, "state_promotion_invalid");
  } finally {
    await hubWithToken.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rule 2: proposed items never reach a packet's skills or current state; arbiter reads promoted skills by hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-e5-rule2-"));
  try {
    const skillsRoot = join(dir, "skills");
    const lifecycle = new SkillLifecycle(skillsRoot);

    // Create and promote a skill
    const skillContent = "export function run() { return 42; }";
    const skillPath = join(dir, "SKILL.md");
    writeFileSync(skillPath, skillContent);
    const candidate = lifecycle.create({
      name: "valid-skill",
      content: skillContent,
      description: "A promoted helper skill",
      createdBy: "agent-1",
      compatibility: {
        harness: "pi",
        models: ["claude-3-5-sonnet"],
      },
      sources: { runIds: ["run-1"], journalEntryIds: [], evidenceReceipts: [] },
    });
    for (const kind of ["static-review", "sandbox", "functional", "safety"] as const) {
      lifecycle.evaluate(candidate.id, {
        kind,
        passed: true,
        evaluatorVersion: "1.0",
        evaluatedBy: "critic",
      });
    }
    lifecycle.promote(candidate.id, {
      decidedBy: "admin",
      reason: "passed evaluations",
      evidenceRefs: ["eval:all-pass"],
    });

    // Create a second skill and tamper with its content after promotion
    const tamperedContent = "export function tampered() { return 0; }";
    writeFileSync(skillPath, tamperedContent);
    const candidate2 = lifecycle.create({
      name: "tampered-skill",
      content: tamperedContent,
      description: "Will be tampered with",
      createdBy: "agent-1",
      compatibility: {
        harness: "pi",
        models: ["claude-3-5-sonnet"],
      },
      sources: { runIds: ["run-1"], journalEntryIds: [], evidenceReceipts: [] },
    });
    for (const kind of ["static-review", "sandbox", "functional", "safety"] as const) {
      lifecycle.evaluate(candidate2.id, {
        kind,
        passed: true,
        evaluatorVersion: "1.0",
        evaluatedBy: "critic",
      });
    }
    lifecycle.promote(candidate2.id, {
      decidedBy: "admin",
      reason: "passed evaluations",
      evidenceRefs: ["eval:all-pass"],
    });
    // Tamper with the promoted file
    const promotedSkillFile = join(skillsRoot, "promoted", candidate2.id, "SKILL.md");
    writeFileSync(promotedSkillFile, "tampered content out of band");

    // Pool contains proposed items
    const proposedState: ContextItem = parseContextItem({
      id: "ctx-prop-state",
      kind: "state",
      project: "proj-1",
      summary: "proposed state change",
      provenance: { sourceType: "tool" },
      authority: "evidence",
      confidence: "verified",
      stateKey: "feature.flag",
      status: "proposed",
    });

    const proposedSkill: ContextItem = parseContextItem({
      id: "ctx-prop-skill",
      kind: "skill",
      project: "proj-1",
      summary: "unreviewed skill candidate",
      provenance: { sourceType: "tool" },
      authority: "evidence",
      confidence: "verified",
      status: "proposed",
    });

    const journalCandidate = journalEntryToContextItem({
      id: "j-skill-1",
      runId: "run-1",
      agentId: "agent-1",
      category: "skill-candidate",
      area: "implementation",
      severity: "info",
      summary: "candidate from journal",
      evidence: [],
      relatedEntryIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }, "proj-1");

    const pool = [proposedState, proposedSkill, journalCandidate];
    const outcome = arbitrate(
      { project: "proj-1", role: "implementer", task: "code" },
      pool,
      { skillLifecycle: lifecycle },
    );

    // Proposed items must NEVER reach packet.skills or packet.currentState
    assert.equal(outcome.packet.currentState.some((item) => item.status === "proposed"), false);
    assert.equal(outcome.packet.currentState.some((item) => item.id === "ctx-prop-state"), false);
    assert.equal(outcome.packet.skills.some((item) => item.status === "proposed"), false);
    assert.equal(outcome.packet.skills.some((item) => item.id === "ctx-prop-skill"), false);
    assert.equal(outcome.packet.skills.some((item) => item.id === "journal_j-skill-1"), false);

    // Valid promoted skill whose content matches hash IS in packet.skills
    const validPromotedSkill = outcome.packet.skills.find((item) => item.id === `skill_${candidate.id}`);
    assert.ok(validPromotedSkill, "valid promoted skill must be included in packet.skills");
    assert.equal(validPromotedSkill.status, "current");

    // Tampered skill (content hash mismatch) must NOT be in packet.skills
    const tamperedInPacket = outcome.packet.skills.find((item) => item.id === `skill_${candidate2.id}`);
    assert.equal(tamperedInPacket, undefined, "tampered skill must be rejected by hash check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rule 3: no record carries a control-plane field, redact at parse, and scope on record", () => {
  // 1. Control-plane field rejection
  for (const field of ["permissions", "tools", "allow", "deny", "grants", "approval", "policy", "scopes", "credentials", "secrets", "token", "apiKey", "password"]) {
    assert.throws(
      () => parseContextItem({
        id: "ctx-bad",
        kind: "knowledge",
        project: "proj-1",
        summary: "text",
        provenance: { sourceType: "tool" },
        authority: "instruction",
        confidence: "verified",
        [field]: "smuggled-grant",
      }),
      /may not carry control-plane field/,
      `must reject control plane field ${field}`,
    );
  }

  // 2. Redaction at parse: secrets in summary or sourceRef are redacted immediately
  const parsedWithSecret = parseContextItem({
    id: "ctx-secret-1",
    kind: "knowledge",
    project: "proj-1",
    summary: "API key is sk-1234567890abcdef and token is ghp_12345678901234567890",
    provenance: {
      sourceType: "tool",
      sourceRef: "Bearer sk-9876543210fedcba",
    },
    authority: "evidence",
    confidence: "verified",
  });
  assert.equal(parsedWithSecret.summary.includes("sk-1234567890abcdef"), false);
  assert.equal(parsedWithSecret.summary.includes("ghp_12345678901234567890"), false);
  assert.equal(parsedWithSecret.summary.includes("[redacted]"), true);
  assert.equal(parsedWithSecret.provenance.sourceRef?.includes("sk-9876543210fedcba"), false);
  assert.equal(parsedWithSecret.provenance.sourceRef?.includes("[redacted]"), true);

  // 3. Scope field on record (agent, project, run, operator)
  for (const scope of ["agent", "project", "run", "operator"] as ContextScope[]) {
    const itemWithScope = parseContextItem({
      id: `ctx-scope-${scope}`,
      scope,
      kind: "knowledge",
      project: "proj-1",
      summary: `item with scope ${scope}`,
      provenance: { sourceType: "tool" },
      authority: "evidence",
      confidence: "verified",
    });
    assert.equal(itemWithScope.scope, scope);
  }

  // Invalid scope fails closed
  assert.throws(
    () => parseContextItem({
      id: "ctx-bad-scope",
      scope: "invalid-scope",
      kind: "knowledge",
      project: "proj-1",
      summary: "text",
      provenance: { sourceType: "tool" },
      authority: "evidence",
      confidence: "verified",
    }),
    /context item scope must be one of agent, project, run, operator/,
  );
});

test("Memory revision is computed at run creation from Git-authored set + promoted-state snapshot and pinned", () => {
  const { root, stateRoot } = committedProject("kxm-e5-memrev-");
  try {
    const bundle = loadVnextProject(root);
    const baselineRevision = computeVnextMemoryRevision(bundle);
    assert.match(baselineRevision, /^ctxrev_[a-f0-9]{64}$/);

    // 1. Adding Git-authored memory file changes the memory revision
    const memoryDir = join(root, ".kxm", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "guidelines.md"), "# Guidelines\nAlways verify before commit.");
    const revWithMemory = computeVnextMemoryRevision(bundle);
    assert.notEqual(revWithMemory, baselineRevision);
    assert.match(revWithMemory, /^ctxrev_[a-f0-9]{64}$/);

    // 2. Candidates in .kxm/memory/candidates are ignored (do not change memory revision)
    const candidatesDir = join(memoryDir, "candidates");
    mkdirSync(candidatesDir, { recursive: true });
    writeFileSync(join(candidatesDir, "draft.md"), "# Draft candidate\nUnreviewed idea.");
    const revWithCandidate = computeVnextMemoryRevision(bundle);
    assert.equal(revWithCandidate, revWithMemory, "memory candidates must be excluded from revision");

    // 3. Adding promoted skills changes the memory revision
    const skillsDir = join(root, ".kxm", "skills");
    const promotedSkillDir = join(skillsDir, "promoted", "skill-1");
    mkdirSync(promotedSkillDir, { recursive: true });
    writeFileSync(join(promotedSkillDir, "SKILL.md"), "export const a = 1;");
    writeFileSync(join(promotedSkillDir, "metadata.json"), JSON.stringify({ name: "skill-1", contentSha256: "abc" }));
    const revWithSkill = computeVnextMemoryRevision(bundle);
    assert.notEqual(revWithSkill, revWithMemory, "promoted skill must change memory revision");

    // 4. Promoted-state snapshot changes the memory revision
    const currentStateItem: ContextItem = parseContextItem({
      id: "ctx-state-1",
      kind: "state",
      project: "prj_01JRUNTIMETEST0000000000",
      summary: "pinned state",
      provenance: { sourceType: "human", sourceRef: "admin" },
      authority: "instruction",
      confidence: "verified",
      stateKey: "feature.auth",
      status: "current",
    });
    const proposedStateItem: ContextItem = parseContextItem({
      id: "ctx-state-2",
      kind: "state",
      project: "prj_01JRUNTIMETEST0000000000",
      summary: "unpromoted state",
      provenance: { sourceType: "tool" },
      authority: "evidence",
      confidence: "verified",
      stateKey: "feature.draft",
      status: "proposed",
    });
    const revWithState = computeVnextMemoryRevision(bundle, { promotedState: [currentStateItem, proposedStateItem] });
    assert.notEqual(revWithState, revWithSkill);
    // Proposed state items must not affect the revision
    const revWithOnlyCurrent = computeVnextMemoryRevision(bundle, { promotedState: [currentStateItem] });
    assert.equal(revWithState, revWithOnlyCurrent, "proposed items in promotedState snapshot must be ignored");

    // 5. acceptVnextRun pins the computed revision
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JTEST000000000000000000" });
    try {
      const commandId = newVnextCommandId();
      const acceptance = acceptVnextRun(context, bundle, {
        commandId,
        workflowId: "default",
        prompt: "test run creation memory revision",
      }, {
        promotedState: [currentStateItem],
      });
      assert.equal(acceptance.run.memoryRevision, revWithOnlyCurrent);
      assert.equal(acceptance.event.memoryRevision, revWithOnlyCurrent);

      // Idempotent retry returns the exact same pinned revision
      const retry = acceptVnextRun(context, bundle, {
        commandId,
        workflowId: "default",
        prompt: "test run creation memory revision",
      });
      assert.equal(retry.idempotent, true);
      assert.equal(retry.run.memoryRevision, revWithOnlyCurrent);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});
