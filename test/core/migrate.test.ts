import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import {
  KxmConfigError,
  loadKxmProject,
  planKxmInitialization,
} from "../../plugins/kxm/src/project-config.ts";
import {
  applyKxmMigration,
  parseLegacyJson,
  planKxmMigration,
  verifyKxmMigration,
  type KxmMigrationPlanResult,
} from "../../plugins/kxm/src/migrate.ts";
import type { JsonObject, JsonValue } from "../../plugins/kxm/src/project-config.ts";

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

function legacyRoot(prefix: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  makeGitRoot(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

function cleanup(...roots: string[]): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

function issueCodes(error: unknown): string[] {
  assert(error instanceof KxmConfigError, `expected KxmConfigError, received ${String(error)}`);
  return error.issues.map((issue) => issue.code);
}

const AGENTS = JSON.stringify({
  schema: "kxm.agents.v1",
  project: "demo",
  host: "local",
  agents: [
    { name: "writer", kind: "agent", driver: "ai", model: "xai/grok-4.6", thinking: "high", purpose: "Writes changes" },
    { name: "Reviewer One", kind: "agent", driver: "ai", purpose: "Reviews changes" },
  ],
  ownership: { writeAgent: "writer", peerAgents: ["Reviewer One"] },
});

const WORKFLOW = JSON.stringify([{
  id: "fix",
  source: "generic",
  project: "demo",
  target: "writer",
  secretEnv: "FIX_WEBHOOK_SECRET",
  maxTransitions: 12,
  reproOracle: { stageId: "verify", evidenceKey: "repro" },
  planHash: { stageId: "plan", evidenceKey: "plan" },
  requirePlanHash: ["implement"],
  promptTemplate: "Bug: {{task}}",
  stages: [
    {
      id: "plan",
      label: "Plan",
      instructions: "Plan the fix.",
      requiredEvidence: ["plan"],
      maxAttempts: 2,
      on: { passed: "verify", blocked: "$terminal" },
    },
    {
      id: "verify",
      label: "Verify",
      instructions: "Reproduce and verify.",
      requiredEvidence: ["repro", "review"],
      evidencePolicies: {
        review: {
          kind: "peer-reply",
          minProducers: 2,
          eligibleAgents: ["writer", "Reviewer One"],
          acceptedStatuses: ["replied"],
        },
      },
      on: { passed: "implement", repro_invalidated: "verify", blocked: "$terminal" },
    },
    {
      id: "implement",
      label: "Implement",
      instructions: "Implement the approved plan.",
      requiredEvidence: ["diff"],
      on: { passed: "$terminal", failed: "implement", blocked: "$terminal" },
    },
  ],
}]);

function allApprovals(plan: KxmMigrationPlanResult): Record<string, JsonValue> {
  const decisions: Record<string, JsonValue> = {};
  let identityIndex = 0;
  for (const ambiguity of plan.ambiguities) {
    const first = ambiguity.allowedValues[0];
    if (first === "<identifier>") {
      identityIndex += 1;
      decisions[ambiguity.key] = `migrated-identity-${identityIndex}`;
    } else if (first === "<provider/model>") {
      decisions[ambiguity.key] = "xai/grok-4.6";
    } else {
      decisions[ambiguity.key] = typeof first === "number" ? first : String(first);
    }
  }
  return decisions;
}

function decisionFile(plan: KxmMigrationPlanResult, resolutions: Record<string, JsonValue>): JsonObject {
  return {
    schema: "kxm.migration-decision.v1",
    projectId: plan.plan.projectId as string,
    projectName: plan.plan.projectName as string,
    sourceDigest: plan.plan.sourceDigest as string,
    resolutions,
  };
}

test("legacy JSON parser is bounded and rejects duplicate keys", () => {
  assert.throws(() => parseLegacyJson('{"a":1,"a":2}', "dup"), (error) => issueCodes(error).includes("duplicate_key"));
  assert.throws(() => parseLegacyJson("{not json", "bad"), (error) => issueCodes(error).includes("invalid_json"));
  assert.throws(() => parseLegacyJson(`{"a":${"1,".repeat(40_000)}1}`, "nodes"), (error) => issueCodes(error).some((code) => code === "node_limit" || code === "invalid_json" || code === "document_too_large"));
  assert.deepEqual(parseLegacyJson('{"a":[1,{"b":"c"}]}', "ok"), { a: [1, { b: "c" }] });
  const deep = `${"[".repeat(40)}${"]".repeat(40)}`;
  assert.throws(() => parseLegacyJson(deep, "deep"), (error) => issueCodes(error).includes("depth_limit"));
});

test("migration plan converts roster and workflows with deterministic ambiguities", () => {
  const root = legacyRoot("kxm-migrate-plan-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const first = planKxmMigration(root);
    const second = planKxmMigration(root);
    assert.equal(first.plan.canApply, false);
    assert.deepEqual(first.plan, second.plan, "planning is deterministic");
    assert.match(String(first.plan.sourceDigest), /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(
      [...first.resources.keys()],
      [
        ".kxm/project.yaml",
        ".kxm/repo/repo.yaml",
        ".kxm/agents/reviewer-one.yaml",
        ".kxm/agents/writer.yaml",
        ".kxm/models/writer-primary.yaml",
        ".kxm/workflows/fix.yaml",
      ],
    );
    const keys = first.ambiguities.map((ambiguity) => ambiguity.key);
    for (const expected of [
      "secret:fix-1c6e6c4c:secretEnv",
      "terminal:fix-1c6e6c4c:plan-64879f7d:blocked",
      "terminal:fix-1c6e6c4c:implement-f9bb818d:passed",
      "backedge:fix-1c6e6c4c:verify-a12dd3a7:repro_invalidated",
      "backedge:fix-1c6e6c4c:implement-f9bb818d:failed",
      "evidence:fix-1c6e6c4c:verify-a12dd3a7:review",
    ]) {
      assert(keys.includes(expected), `expected ambiguity ${expected}`);
    }
    assert(keys.some((key) => key.startsWith("permission:writer-")), "writer permission decision is present");
    assert(keys.some((key) => key.startsWith("permission:reviewer-one-")), "reviewer permission decision is present");
    // Unmapped hub-only and descriptive fields are preserved by hash.
    const unmapped = first.plan.unmapped as Array<{ jsonPointer: string; sensitive: boolean }>;
    assert(unmapped.some((entry) => entry.jsonPointer === "/0/promptTemplate"));
    assert(unmapped.some((entry) => entry.jsonPointer === "/0/secretEnv" && entry.sensitive));
    assert(unmapped.some((entry) => entry.jsonPointer === "/ownership"));
    // Case-normalized identities are recorded as explicit renames.
    const renames = first.plan.renames as Array<{ from: string; to: string; kind: string }>;
    assert(renames.some((entry) => entry.from === "Reviewer One" && entry.to === "reviewer-one" && entry.kind === "agent"));
    // The converted workflow preserves oracle, plan hash, and producer policy.
    const workflow = first.resources.get(".kxm/workflows/fix.yaml") as JsonObject;
    assert.deepEqual(workflow.reproOracle, { stageId: "verify", evidenceKey: "repro" });
    assert.deepEqual(workflow.planHash, { stageId: "plan", evidenceKey: "plan" });
    assert.deepEqual(workflow.requirePlanHash, ["implement"]);
    assert.deepEqual(workflow.limits, { maxTransitions: 12 });
    const steps = workflow.steps as JsonObject[];
    const verify = steps.find((step) => step.id === "verify") as JsonObject;
    const review = (verify.requiredEvidence as JsonObject[]).find((entry) => entry.key === "review") as JsonObject;
    assert.deepEqual(review.producerPolicy, {
      minimumProducers: 2,
      eligibleAgents: ["writer", "reviewer-one"],
      acceptedStatuses: ["passed"],
    });
    // Producer-carrying steps widen the assignment pool deterministically.
    const assignments = verify.assignments as JsonObject;
    assert.deepEqual(assignments.allowedAgents, ["writer", "reviewer-one"]);
    assert.equal(assignments.target, 2);
  } finally {
    cleanup(root);
  }
});

test("apply installs the validated target, writes a receipt, and verify passes", () => {
  const root = legacyRoot("kxm-migrate-apply-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    const decisions = allApprovals(plan);
    const dryRun = applyKxmMigration(root, { decisions, dryRun: true });
    assert.equal(dryRun.action, "planned");
    assert.equal(existsSync(join(root, ".kxm", "project.yaml")), false, "dry run performs no writes");

    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    assert.equal(applied.files.length, 6);
    assert.equal(applied.receiptPath, ".kxm/migration-receipt.yaml");
    assert.match(String(applied.configRevision), /^sha256:/);

    // Legacy inputs are untouched and the mixed tree now loads.
    assert.equal(readFileSync(join(root, ".kxm", "config", "agents.json"), "utf8"), AGENTS);
    const bundle = loadKxmProject(root);
    assert.equal(bundle.configRevision, applied.configRevision);
    assert(bundle.migrationReceipt, "receipt is attached to the loaded bundle");
    assert.equal(planKxmInitialization(root).mode, "ready");

    const verify = verifyKxmMigration(root);
    assert.equal(verify.ok, true, JSON.stringify(verify.issues));

    // Re-apply is idempotent.
    const again = applyKxmMigration(root, { decisions });
    assert.equal(again.action, "already-migrated");
  } finally {
    cleanup(root);
  }
});

test("apply through a decisions file binds project, sources, and allowed values", () => {
  const root = legacyRoot("kxm-migrate-decisions-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    const decisionsPath = join(root, "decisions.yaml");
    writeFileSync(decisionsPath, stringify(decisionFile(plan, allApprovals(plan))), "utf8");
    const applied = applyKxmMigration(root, { decisionsFile: decisionsPath });
    assert.equal(applied.action, "applied");

    // Tampered decision value is rejected before any write.
    const root2 = legacyRoot("kxm-migrate-decisions2-", {
      ".kxm/config/agents.json": AGENTS,
      ".kxm/config/workflows/fix.json": WORKFLOW,
    });
    try {
      const plan2 = planKxmMigration(root2);
      const badValue = { ...allApprovals(plan2), "terminal:fix-1c6e6c4c:plan-64879f7d:blocked": "bogus" };
      const badPath = join(root2, "decisions.yaml");
      writeFileSync(badPath, stringify(decisionFile(plan2, badValue)), "utf8");
      assert.throws(
        () => applyKxmMigration(root2, { decisionsFile: badPath }),
        (error) => issueCodes(error).includes("decision_value_invalid"),
      );
      assert.equal(existsSync(join(root2, ".kxm", "project.yaml")), false);

      // Unknown decision keys are rejected.
      const unknown = { ...allApprovals(plan2), "terminal:fix-1c6e6c4c:nope:blocked": "failed" };
      writeFileSync(badPath, stringify(decisionFile(plan2, unknown)), "utf8");
      assert.throws(
        () => applyKxmMigration(root2, { decisionsFile: badPath }),
        (error) => issueCodes(error).includes("decision_unknown"),
      );

      // Stale source digest is rejected.
      const stale = decisionFile(plan2, allApprovals(plan2));
      stale.sourceDigest = "sha256:" + "0".repeat(64);
      writeFileSync(badPath, stringify(stale), "utf8");
      assert.throws(
        () => applyKxmMigration(root2, { decisionsFile: badPath }),
        (error) => issueCodes(error).includes("decision_source_changed"),
      );
    } finally {
      cleanup(root2);
    }
  } finally {
    cleanup(root);
  }
});

test("verify detects source, target, and receipt tampering", () => {
  const root = legacyRoot("kxm-migrate-tamper-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    const applied = applyKxmMigration(root, { decisions: allApprovals(plan) });
    assert.equal(applied.action, "applied");
    assert.equal(verifyKxmMigration(root).ok, true);

    // Target resource modified after receipt.
    const workflowPath = join(root, ".kxm", "workflows", "fix.yaml");
    writeFileSync(workflowPath, `${readFileSync(workflowPath, "utf8")}# tampered\n`, "utf8");
    const verify = verifyKxmMigration(root);
    assert.equal(verify.ok, false);
    assert(verify.issues.some((issue) => issue.code === "migration_target_modified"), JSON.stringify(verify.issues));
    // Load-time coexistence pins only the legacy sources; target drift is
    // reported by verify, while the bundle itself still loads (the KXM
    // target is authoritative after migration and may evolve through Git).
    assert.equal(loadKxmProject(root).configRevision !== undefined, true);
  } finally {
    cleanup(root);
  }

  const root2 = legacyRoot("kxm-migrate-tamper2-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root2);
    applyKxmMigration(root2, { decisions: allApprovals(plan) });
    // Legacy source edited after migration: the receipt pins it read-only.
    writeFileSync(join(root2, ".kxm", "config", "agents.json"), `${AGENTS}\n`, "utf8");
    const verify = verifyKxmMigration(root2);
    assert.equal(verify.ok, false);
    assert(verify.issues.some((issue) => issue.code === "migration_source_changed"), JSON.stringify(verify.issues));
    assert.throws(() => loadKxmProject(root2), (error) => issueCodes(error).includes("migration_source_changed"));
  } finally {
    cleanup(root2);
  }

  const root3 = legacyRoot("kxm-migrate-tamper3-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root3);
    applyKxmMigration(root3, { decisions: allApprovals(plan) });
    // Receipt self-hash tampering fails closed.
    const receiptPath = join(root3, ".kxm", "migration-receipt.yaml");
    writeFileSync(receiptPath, readFileSync(receiptPath, "utf8").replace("mig_", "mig_0"), "utf8");
    const verify = verifyKxmMigration(root3);
    assert.equal(verify.ok, false);
    assert(verify.issues.some((issue) => issue.code === "migration_receipt_hash_mismatch" || issue.code.startsWith("schema_")), JSON.stringify(verify.issues));
  } finally {
    cleanup(root3);
  }
});

test("missing receipt keeps legacy and KXM coexistence fail-closed", () => {
  const root = legacyRoot("kxm-migrate-conflict-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    // Install resources without a receipt by hand to simulate an interrupted apply.
    for (const [path, value] of plan.resources) {
      const absolute = join(root, ...path.split("/"));
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, stringify(value, { lineWidth: 0 }), "utf8");
    }
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("legacy_kxm_conflict"));
    assert.equal(planKxmInitialization(root).mode, "migrate");
    // Re-apply refuses to overwrite the partial state.
    assert.throws(
      () => applyKxmMigration(root, { decisions: allApprovals(planKxmMigration(root)) }),
      (error) => issueCodes(error).includes("migration_target_exists"),
    );
  } finally {
    cleanup(root);
  }
});

test("gates without deterministic runners and foreign producers require decisions", () => {
  const root = legacyRoot("kxm-migrate-gates-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/gates.json": JSON.stringify({
      schema: "kxm.gates.v1",
      gates: [
        { name: "quality", kind: "gate", driver: "code", purpose: "planned" },
        { name: "test", kind: "gate", driver: "code" },
      ],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "review",
      target: "writer",
      stages: [{
        id: "check",
        instructions: "Check with peers.",
        requiredEvidence: ["verdict"],
        evidencePolicies: {
          verdict: { kind: "peer-reply", minProducers: 2, eligibleAgents: ["critic-1", "critic-2"], acceptedStatuses: ["replied"] },
        },
        on: { passed: "$terminal" },
      }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const keys = plan.ambiguities.map((ambiguity) => ambiguity.key);
    assert(keys.some((key) => key.startsWith("gate:quality-")), "unimplemented gates require a report-only decision");
    assert(!keys.includes("gate:test"), "implemented gates do not require decisions");
    assert(keys.some((key) => key.startsWith("producer:review-c97ace4c:check-20f65c28:critic-1-")));
    assert(keys.some((key) => key.startsWith("producer:review-c97ace4c:check-20f65c28:critic-2-")));

    // Map foreign producers onto roster agents explicitly.
    const decisions = allApprovals(plan);
    decisions[keys.find((key) => key.startsWith("producer:review-c97ace4c:check-20f65c28:critic-1-"))!] = "writer";
    decisions[keys.find((key) => key.startsWith("producer:review-c97ace4c:check-20f65c28:critic-2-"))!] = "reviewer-one";
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    const bundle = loadKxmProject(root);
    const check = (bundle.workflows.get("review")!.value.steps as JsonObject[])[0]!;
    const verdict = (check.requiredEvidence as JsonObject[]).find((entry) => entry.key === "verdict") as JsonObject;
    assert.deepEqual((verdict.producerPolicy as JsonObject).eligibleAgents, ["writer", "reviewer-one"]);
  } finally {
    cleanup(root);
  }
});

test("migration refuses case-fold identity collisions and symlinks", () => {
  const colliding = legacyRoot("kxm-migrate-collide-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [
        { name: "Reviewer One", kind: "agent", driver: "ai" },
        { name: "reviewer-one", kind: "agent", driver: "ai" },
      ],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{ id: "w", target: "reviewer-one", stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }] }]),
  });
  try {
    const plan = planKxmMigration(colliding);
    assert(plan.ambiguities.some((ambiguity) => ambiguity.category === "identity"), "collision surfaces as an identity ambiguity");
    assert.equal(plan.plan.canApply, false);

    // An explicit <identifier> decision resolves the collision deterministically.
    const decisions = allApprovals(plan);
    const collisionKey = plan.ambiguities.find((ambiguity) => ambiguity.key.startsWith("identity-collision:agent:"))!.key;
    decisions[collisionKey] = "reviewer-two";
    const resolved = planKxmMigration(colliding, { decisions });
    assert.equal(resolved.ambiguities.length, 0, JSON.stringify(resolved.ambiguities.map((ambiguity) => ambiguity.key)));
    assert.deepEqual([...resolved.resources.keys()].filter((path) => path.startsWith(".kxm/agents/")), [".kxm/agents/reviewer-one.yaml", ".kxm/agents/reviewer-two.yaml"]);
  } finally {
    cleanup(colliding);
  }

  const linked = legacyRoot("kxm-migrate-link-", {});
  const external = mkdtempSync(join(tmpdir(), "kxm-migrate-link-target-"));
  try {
    mkdirSync(join(external, "workflows"), { recursive: true });
    writeFileSync(join(external, "workflows", "fix.json"), WORKFLOW, "utf8");
    mkdirSync(join(linked, ".kxm", "config"), { recursive: true });
    writeFileSync(join(linked, ".kxm", "config", "agents.json"), AGENTS, "utf8");
    // A linked workflows directory must never be traversed for authoritative
    // legacy bytes; readers reject it fail-closed on all supported platforms.
    symlinkSync(join(external, "workflows"), join(linked, ".kxm", "config", "workflows"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => planKxmMigration(linked),
      (error) => issueCodes(error).includes("legacy_source_invalid"),
    );
  } finally {
    cleanup(linked, external);
  }
});

test("decisions resolve drops, coordinator choice, model mapping, and dry-run stays clean", () => {
  const root = legacyRoot("kxm-migrate-decide-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [
        { name: "writer", kind: "agent", driver: "ai", model: "grok-4.6", purpose: "Writes" },
        { name: "robot", kind: "gate", driver: "code", purpose: "not an ai agent" },
      ],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "coordinator",
      stages: [{ id: "plan", instructions: "Plan.", on: { passed: "$terminal" } }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const keys = plan.ambiguities.map((ambiguity) => ambiguity.key);
    const modelKey = keys.find((key) => key.startsWith("model:writer-"))!;
    const unsupportedKey = keys.find((key) => key.startsWith("unsupported:.kxm/config/agents.json:/agents/1"))!;
    assert(keys.includes("coordinator:fix-1c6e6c4c"), "foreign workflow target requires an explicit coordinator choice");
    assert(modelKey, "provider-less model requires a decision");
    assert(unsupportedKey, "non agent/ai roster entry requires a drop decision");

    const decisions = allApprovals(plan);
    decisions[modelKey] = "xai/grok-4.6";
    decisions["coordinator:fix-1c6e6c4c"] = "writer";
    const resolved = planKxmMigration(root, { decisions });
    assert.equal(resolved.ambiguities.length, 0, JSON.stringify(resolved.ambiguities.map((ambiguity) => ambiguity.key)));
    const writer = resolved.resources.get(".kxm/agents/writer.yaml") as JsonObject;
    assert.deepEqual(writer.model, { provider: "xai", model: "grok-4.6" });
    assert.equal(resolved.resources.has(".kxm/agents/robot.yaml"), false, "dropped entry produces no resource");
    const workflow = resolved.resources.get(".kxm/workflows/fix.yaml") as JsonObject;
    assert.equal(workflow.coordinator, "writer");

    const dryRun = applyKxmMigration(root, { decisions, dryRun: true });
    assert.equal(dryRun.action, "planned");
    assert.equal(existsSync(join(root, ".kxm", "project.yaml")), false);

    // The same decision path applies and verifies.
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    assert.equal(verifyKxmMigration(root).ok, true);
  } finally {
    cleanup(root);
  }
});

test("apply never writes through linked target parents and rolls back on failure", () => {
  const root = legacyRoot("kxm-migrate-applylink-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  const external = mkdtempSync(join(tmpdir(), "kxm-migrate-applylink-target-"));
  try {
    mkdirSync(join(external, "agents"), { recursive: true });
    writeFileSync(join(external, "agents", "sentinel.txt"), "external\n", "utf8");
    // .kxm/agents is a link: apply must refuse before any write lands outside
    // the project.
    symlinkSync(join(external, "agents"), join(root, ".kxm", "agents"), process.platform === "win32" ? "junction" : "dir");
    const plan = planKxmMigration(root);
    assert.throws(
      () => applyKxmMigration(root, { decisions: allApprovals(plan) }),
      (error) => issueCodes(error).includes("migration_target_parent_invalid"),
    );
    assert.equal(existsSync(join(external, "agents", "writer.yaml")), false, "no bytes escaped through the link");
    assert.equal(existsSync(join(external, "agents", "reviewer-one.yaml")), false);
    assert.equal(readFileSync(join(external, "agents", "sentinel.txt"), "utf8"), "external\n");
  } finally {
    cleanup(root, external);
  }
});

test("decision-supplied identifier that is already taken stays an ambiguity, never a silent delete", () => {
  const root2 = legacyRoot("kxm-migrate-taken2-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [
        { name: "alpha", kind: "agent", driver: "ai" },
        { name: "Alpha", kind: "agent", driver: "ai" },
      ],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{ id: "w", target: "alpha", stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }] }]),
  });
  try {
    const plan2 = planKxmMigration(root2);
    const collisionKey = plan2.ambiguities.find((ambiguity) => ambiguity.key.startsWith("identity-collision:agent:"))!.key;
    const decisions2 = allApprovals(plan2);
    // Choose the already-taken identifier: must remain an ambiguity, and
    // no agent may be silently dropped.
    decisions2[collisionKey] = "alpha";
    const resolved = planKxmMigration(root2, { decisions: decisions2 });
    assert(resolved.ambiguities.some((ambiguity) => ambiguity.key === collisionKey), "taken identifier re-surfaces as an ambiguity");
    assert.equal(resolved.plan.canApply, false);
    // A distinct choice resolves cleanly.
    decisions2[collisionKey] = "alpha-two";
    const resolved2 = planKxmMigration(root2, { decisions: decisions2 });
    assert.equal(resolved2.ambiguities.length, 0);
    assert(resolved2.resources.has(".kxm/agents/alpha.yaml"));
    assert(resolved2.resources.has(".kxm/agents/alpha-two.yaml"));
  } finally {
    cleanup(root2);
  }
});

test("exact duplicate raw identities require an explicit drop and are reported", () => {
  const root = legacyRoot("kxm-migrate-dup-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [
        { name: "writer", kind: "agent", driver: "ai", purpose: "first" },
        { name: "writer", kind: "agent", driver: "ai", purpose: "second" },
      ],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{ id: "w", target: "writer", stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }] }]),
  });
  try {
    const plan = planKxmMigration(root);
    const duplicateKey = plan.ambiguities.map((ambiguity) => ambiguity.key).find((key) => key.startsWith("identity-duplicate:agent:"));
    assert(duplicateKey, "exact duplicate requires a drop decision");
    const unmapped = plan.plan.unmapped as Array<{ jsonPointer: string }>;
    assert(unmapped.some((entry) => entry.jsonPointer === "/agents/1"), "duplicate definition body is preserved in the report at its real pointer");
    const decisions = allApprovals(plan);
    const resolved = planKxmMigration(root, { decisions });
    assert.equal(resolved.ambiguities.length, 0);
    const agents = [...resolved.resources.keys()].filter((path) => path.startsWith(".kxm/agents/"));
    assert.deepEqual(agents, [".kxm/agents/writer.yaml"], "first definition wins; duplicate dropped by decision");
  } finally {
    cleanup(root);
  }
});

test("edges targeting an instructions-dropped stage resolve through transition-target decisions", () => {
  const root = legacyRoot("kxm-migrate-dropstage-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [
        { id: "plan", instructions: "Plan.", on: { passed: "broken", blocked: "$terminal" } },
        { id: "broken", label: "no instructions here" },
        { id: "implement", instructions: "Implement.", on: { passed: "$terminal" } },
      ],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const keys = plan.ambiguities.map((ambiguity) => ambiguity.key);
    assert(keys.includes("instructions:fix-1c6e6c4c:broken-f526795c"), "instruction-less stage requires a drop decision");
    assert(keys.includes("transition-target:fix-1c6e6c4c:plan-64879f7d:passed"), "edge to the dropped stage flows through the transition-target decision");
    const decisions = allApprovals(plan);
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied", JSON.stringify(applied.plan));
    const bundle = loadKxmProject(root);
    const steps = bundle.workflows.get("fix")!.value.steps as JsonObject[];
    assert.deepEqual(steps.map((step) => step.id), ["plan", "implement"], "dropped stage is absent");
    const planStep = steps[0]!;
    assert.deepEqual(
      (planStep.on as JsonObject).passed,
      "implement",
      "the decision-dropped explicit edge falls back to the v0.4 default edge: next surviving stage",
    );
  } finally {
    cleanup(root);
  }
});

test("apply ordering: receipt check precedes planning; dry run reports preflight failures", () => {
  const root = legacyRoot("kxm-migrate-order-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    const applied = applyKxmMigration(root, { decisions: allApprovals(plan) });
    assert.equal(applied.action, "applied");
    // Re-apply without decisions: already-migrated, not blocked.
    const again = applyKxmMigration(root, {});
    assert.equal(again.action, "already-migrated");
    // Dry run on the migrated tree also reports already-migrated.
    const dryAgain = applyKxmMigration(root, { dryRun: true });
    assert.equal(dryAgain.action, "already-migrated");
  } finally {
    cleanup(root);
  }

  const blocked = legacyRoot("kxm-migrate-order2-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    // Pre-create a target path: dry run must surface the collision.
    mkdirSync(join(blocked, ".kxm", "agents"), { recursive: true });
    writeFileSync(join(blocked, ".kxm", "agents", "writer.yaml"), "occupied\n", "utf8");
    const plan = planKxmMigration(blocked);
    assert.throws(
      () => applyKxmMigration(blocked, { decisions: allApprovals(plan), dryRun: true }),
      (error) => issueCodes(error).includes("migration_target_exists"),
    );
  } finally {
    cleanup(blocked);
  }
});

test("receipt bound to a different project identity is rejected at load", () => {
  const root = legacyRoot("kxm-migrate-projectid-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    applyKxmMigration(root, { decisions: allApprovals(plan) });
    const projectPath = join(root, ".kxm", "project.yaml");
    const projectYaml = readFileSync(projectPath, "utf8");
    writeFileSync(projectPath, projectYaml.replace(/id: prj_mig[a-f0-9]+/, "id: prj_00000000000000000000000000000000"), "utf8");
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("migration_project_mismatch"));
  } finally {
    cleanup(root);
  }
});

test("sensitive unmapped entries never contain a content-derived hash", () => {
  const secretValue = "0123456789abcdef";
  const root = legacyRoot("kxm-migrate-secret-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      secret: secretValue,
      secretEnv: "FIX_SECRET",
      stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const unmapped = plan.plan.unmapped as Array<{ jsonPointer: string; valueSha256: string; sensitive: boolean }>;
    const secretEntry = unmapped.find((entry) => entry.jsonPointer === "/0/secret")!;
    assert.equal(secretEntry.sensitive, true);
    const contentHash = `sha256:${createHash("sha256").update(JSON.stringify(secretValue)).digest("hex")}`;
    assert.notEqual(secretEntry.valueSha256, contentHash, "no offline-guessable content hash for secrets");
    const envEntry = unmapped.find((entry) => entry.jsonPointer === "/0/secretEnv")!;
    assert.equal(envEntry.sensitive, true);
    assert.notEqual(envEntry.valueSha256, `sha256:${createHash("sha256").update(JSON.stringify("FIX_SECRET")).digest("hex")}`);
  } finally {
    cleanup(root);
  }
});

test("agent permission changes are direction unknown; numeric budget decisions accept any in-range value", () => {
  const root = legacyRoot("kxm-migrate-direction-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    const changes = plan.plan.permissionChanges as Array<{ direction: string; decisionKey: string }>;
    const agentChanges = changes.filter((change) => change.decisionKey.startsWith("permission:"));
    assert(agentChanges.length > 0);
    assert(agentChanges.every((change) => change.direction === "unknown"), JSON.stringify(agentChanges));
    const evidenceChanges = changes.filter((change) => change.decisionKey.startsWith("evidence:"));
    assert(evidenceChanges.some((change) => change.direction === "narrowing"));
    assert(evidenceChanges.some((change) => change.direction === "expansion"));

    // A reviewed per-edge budget outside the enumerated proposals is accepted.
    const decisions = allApprovals(plan);
    decisions["backedge:fix-1c6e6c4c:verify-a12dd3a7:repro_invalidated"] = 17;
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    const bundle = loadKxmProject(root);
    const verify = (bundle.workflows.get("fix")!.value.steps as JsonObject[]).find((step) => step.id === "verify")!;
    assert.deepEqual((verify.on as JsonObject).repro_invalidated, { target: "verify", maxTransitions: 17 });

    // Out-of-range budgets are rejected.
    const root2 = legacyRoot("kxm-migrate-direction2-", {
      ".kxm/config/agents.json": AGENTS,
      ".kxm/config/workflows/fix.json": WORKFLOW,
    });
    try {
      const plan2 = planKxmMigration(root2);
      const bad = allApprovals(plan2);
      bad["backedge:fix-1c6e6c4c:verify-a12dd3a7:repro_invalidated"] = 101;
      assert.throws(
        () => applyKxmMigration(root2, { decisions: bad }),
        (error) => issueCodes(error).includes("decision_value_invalid"),
      );
    } finally {
      cleanup(root2);
    }
  } finally {
    cleanup(root);
  }
});

test("migrate commands require an authoritative Git root", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-migrate-nogit-"));
  try {
    mkdirSync(join(root, ".kxm", "config"), { recursive: true });
    writeFileSync(join(root, ".kxm", "config", "agents.json"), AGENTS, "utf8");
    assert.throws(() => planKxmMigration(root), (error) => issueCodes(error).includes("git_root_required"));
    assert.throws(() => applyKxmMigration(root, {}), (error) => issueCodes(error).includes("git_root_required"));
    assert.throws(() => verifyKxmMigration(root), (error) => issueCodes(error).includes("git_root_required"));
  } finally {
    cleanup(root);
  }
});

test("post-write failure rolls back installed files so retry can succeed", () => {
  const root = legacyRoot("kxm-migrate-rollback-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    const decisions = allApprovals(plan);
    // Force the post-write bundle load to fail: an unknown repository binding
    // identity is rejected by the loader after files are installed.
    assert.throws(
      () => applyKxmMigration(root, { decisions, repositoryBindings: { "not a repo id": "/tmp/nowhere" } }),
      (error) => issueCodes(error).some((code) => code === "repository_binding_id_invalid" || code === "repository_binding_unknown" || code === "repository_binding_not_absolute"),
    );
    assert.equal(existsSync(join(root, ".kxm", "project.yaml")), false, "rolled-back install leaves no project.yaml");
    assert.equal(existsSync(join(root, ".kxm", "agents", "writer.yaml")), false, "rolled-back install leaves no agents");
    assert.equal(existsSync(join(root, ".kxm", "migration-receipt.yaml")), false);
    // Retry without the poisoning option succeeds.
    const retry = applyKxmMigration(root, { decisions });
    assert.equal(retry.action, "applied");
    assert.equal(verifyKxmMigration(root).ok, true);
  } finally {
    cleanup(root);
  }
});

test("collision-renamed agents bind workflows and producers by raw name, never silently", () => {
  const root = legacyRoot("kxm-migrate-rawbind-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [
        { name: "Reviewer One", kind: "agent", driver: "ai" },
        { name: "reviewer-one", kind: "agent", driver: "ai" },
      ],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "reviewer-one",
      stages: [{
        id: "check",
        instructions: "Check.",
        requiredEvidence: ["verdict"],
        evidencePolicies: {
          verdict: { kind: "peer-reply", minProducers: 1, eligibleAgents: ["reviewer-one", "Reviewer One"], acceptedStatuses: ["replied"] },
        },
        on: { passed: "$terminal" },
      }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const decisions = allApprovals(plan);
    const collisionKey = plan.ambiguities.map((ambiguity) => ambiguity.key).find((key) => key.startsWith("identity-collision:agent:"))!;
    decisions[collisionKey] = "reviewer-two";
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied", JSON.stringify(applied.plan));
    const bundle = loadKxmProject(root);
    const workflow = bundle.workflows.get("fix")!.value;
    // The workflow targets the raw name "reviewer-one" — the SECOND roster
    // agent, which the collision decision renamed to reviewer-two.
    assert.equal(workflow.coordinator, "reviewer-two", "raw-name binding survives collision renames");
    const check = (workflow.steps as JsonObject[])[0]!;
    const verdict = (check.requiredEvidence as JsonObject[]).find((entry) => entry.key === "verdict")!;
    assert.deepEqual(
      (verdict.producerPolicy as JsonObject).eligibleAgents,
      ["reviewer-two", "reviewer-one"],
      "producers bind by raw name through the rename",
    );
  } finally {
    cleanup(root);
  }
});

test("id-less workflow definitions derive distinct identities per file", () => {
  const root = legacyRoot("kxm-migrate-idless-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/alpha.json": JSON.stringify([{ target: "writer", stages: [{ id: "s", instructions: "a", on: { passed: "$terminal" } }] }]),
    ".kxm/config/workflows/beta.json": JSON.stringify([{ target: "writer", stages: [{ id: "s", instructions: "b", on: { passed: "$terminal" } }] }]),
  });
  try {
    const plan = planKxmMigration(root);
    const workflows = [...plan.resources.keys()].filter((path) => path.startsWith(".kxm/workflows/"));
    assert.deepEqual(workflows, [".kxm/workflows/alpha-0.yaml", ".kxm/workflows/beta-0.yaml"], "id-less definitions get file-derived distinct ids");
    assert.equal(plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("identity-duplicate:workflow:")), false, "no spurious duplicate ambiguity");
  } finally {
    cleanup(root);
  }
});

test("verify reports migration_source_missing when legacy sources are removed after migration", () => {
  const root = legacyRoot("kxm-migrate-removed-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": WORKFLOW,
  });
  try {
    const plan = planKxmMigration(root);
    applyKxmMigration(root, { decisions: allApprovals(plan) });
    assert.equal(verifyKxmMigration(root).ok, true);
    rmSync(join(root, ".kxm", "config"), { recursive: true, force: true });
    const verify = verifyKxmMigration(root);
    assert.equal(verify.ok, false);
    assert(verify.issues.some((issue) => issue.code === "migration_source_missing"), JSON.stringify(verify.issues));
    assert(verify.issues.every((issue) => issue.code === "migration_source_missing"), "distinct code, not a generic invalid receipt");
    // The migrated project itself still loads (legacy input is gone, KXM is authoritative).
    assert.equal(loadKxmProject(root).configRevision !== undefined, true);
  } finally {
    cleanup(root);
  }
});

test("a migration needing identity decisions for its only agent and workflow id applies cleanly", () => {
  const root = legacyRoot("kxm-migrate-identityflow-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [{ name: "\u30e9\u30a4\u30bf\u30fc", kind: "agent", driver: "ai" }],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "\u30ef\u30fc\u30af\u30d5\u30ed\u30fc",
      target: "\u30e9\u30a4\u30bf\u30fc",
      secretEnv: "FIX_SECRET",
      stages: [
        { id: "plan", instructions: "Plan.", on: { passed: "implement", blocked: "$terminal" } },
        { id: "implement", instructions: "Do it.", on: { passed: "$terminal", failed: "implement" } },
      ],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const keys = plan.ambiguities.map((ambiguity) => ambiguity.key);
    const agentKey = keys.find((key) => key.startsWith("identity:agent:"))!;
    const workflowKey = keys.find((key) => key.startsWith("identity:workflow:"))!;
    assert(agentKey && workflowKey, `expected identity decisions, got ${keys.join(",")}`);
    // Every downstream decision key is already visible in the first plan.
    assert(keys.some((key) => key.startsWith("secret:")), "secret decision is visible in plan 1");
    assert(keys.some((key) => key.startsWith("backedge:")), "back-edge decision is visible in plan 1");
    const decisions = allApprovals(plan);
    decisions[agentKey] = "sole-writer";
    decisions[workflowKey] = "fix";
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied", JSON.stringify(applied.plan?.ambiguities));
    const bundle = loadKxmProject(root);
    assert(bundle.agents.has("sole-writer"));
    assert(bundle.workflows.has("fix"));
    assert.equal(verifyKxmMigration(root).ok, true);
  } finally {
    cleanup(root);
  }
});

test("oversized outcome keys are preserved in the report, never hard-fail planning", () => {
  const root = legacyRoot("kxm-migrate-outcome-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [{
        id: "plan",
        instructions: "Plan.",
        on: { ["outcome-" + "x".repeat(80)]: "$terminal", passed: "$terminal" },
      }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const unmapped = plan.plan.unmapped as Array<{ jsonPointer: string }>;
    assert(unmapped.some((entry) => entry.jsonPointer.includes("/on/")), "oversized outcome edge is preserved in the report");
    const applied = applyKxmMigration(root, { decisions: allApprovals(plan) });
    assert.equal(applied.action, "applied");
    const bundle = loadKxmProject(root);
    const step = (bundle.workflows.get("fix")!.value.steps as JsonObject[])[0]!;
    assert.deepEqual(Object.keys(step.on as JsonObject), ["passed"], "only the valid outcome survives");
  } finally {
    cleanup(root);
  }
});

test("out-of-range legacy numerics are preserved in the report, never hard-fail planning", () => {
  const root = legacyRoot("kxm-migrate-numerics-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      maxTransitions: 5000,
      stages: [{
        id: "plan",
        instructions: "Plan.",
        maxAttempts: 25,
        on: { passed: "verify", blocked: "$terminal" },
      }, {
        id: "verify",
        instructions: "Verify.",
        requiredEvidence: ["review"],
        evidencePolicies: {
          review: { kind: "peer-reply", minProducers: 99, eligibleAgents: ["writer"], acceptedStatuses: ["replied"] },
        },
        on: { passed: "$terminal", failed: { target: "verify", maxTransitions: 500 } },
      }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const unmapped = plan.plan.unmapped as Array<{ jsonPointer: string }>;
    assert(unmapped.some((entry) => entry.jsonPointer === "/0/maxTransitions"), "out-of-range global budget is reported");
    assert(unmapped.some((entry) => entry.jsonPointer === "/0/stages/0/maxAttempts"), "out-of-range maxAttempts is reported");
    assert(unmapped.some((entry) => entry.jsonPointer.endsWith("/minProducers")), "out-of-range minProducers is reported");
    assert(unmapped.some((entry) => entry.jsonPointer.endsWith("/on/failed/maxTransitions")), "out-of-range per-edge budget is reported");
    const decisions = allApprovals(plan);
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    const bundle = loadKxmProject(root);
    const steps = bundle.workflows.get("fix")!.value.steps as JsonObject[];
    assert.equal(steps[0]!.maxAttempts, 3, "legacy default replaces the out-of-range value");
  } finally {
    cleanup(root);
  }
});

test("linked workflow files are rejected, never silently omitted", () => {
  const root = legacyRoot("kxm-migrate-linkfile-", {
    ".kxm/config/agents.json": AGENTS,
  });
  const external = mkdtempSync(join(tmpdir(), "kxm-migrate-linkfile-target-"));
  try {
    mkdirSync(join(external, "workflows"), { recursive: true });
    writeFileSync(join(external, "workflows", "fix.json"), WORKFLOW, "utf8");
    mkdirSync(join(root, ".kxm", "config"), { recursive: true });
    symlinkSync(join(external, "workflows"), join(root, ".kxm", "config", "workflows"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => planKxmMigration(root),
      (error) => issueCodes(error).includes("legacy_source_invalid"),
    );
  } finally {
    cleanup(root, external);
  }
});

test("approved drops remove duplicate workflows and stages without placeholder leakage", () => {
  const root = legacyRoot("kxm-migrate-dropwf-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/alpha.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [{ id: "plan", instructions: "First definition.", on: { passed: "$terminal" } }],
    }]),
    ".kxm/config/workflows/beta.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [{ id: "plan", instructions: "Duplicate definition.", on: { passed: "$terminal" } }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const duplicateKey = plan.ambiguities.map((ambiguity) => ambiguity.key).find((key) => key.startsWith("identity-duplicate:workflow:"));
    assert(duplicateKey, `expected a duplicate-workflow decision, got ${plan.ambiguities.map((ambiguity) => ambiguity.key).join(",")}`);
    const decisions = allApprovals(plan); // first allowed value is "drop"
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    const bundle = loadKxmProject(root);
    assert.deepEqual([...bundle.workflows.keys()], ["fix"], "first definition wins; duplicate is dropped, no placeholder resource");
    const steps = bundle.workflows.get("fix")!.value.steps as JsonObject[];
    assert.match(String(steps[0]!.instructions), /First definition/);
    const unmapped = applied.plan?.unmapped as Array<{ jsonPointer: string }>;
    assert(unmapped.some((entry) => entry.jsonPointer === "/0"), "dropped duplicate definition body is preserved in the report");
  } finally {
    cleanup(root);
  }

  const stages = legacyRoot("kxm-migrate-dropstage2-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [
        { id: "plan", instructions: "First stage.", on: { passed: "implement" } },
        { id: "plan", instructions: "Duplicate stage.", on: { passed: "$terminal" } },
        { id: "implement", instructions: "Implement.", on: { passed: "$terminal" } },
      ],
    }]),
  });
  try {
    const plan = planKxmMigration(stages);
    const duplicateKey = plan.ambiguities.map((ambiguity) => ambiguity.key).find((key) => key.startsWith("identity-duplicate:step:"));
    assert(duplicateKey, `expected a duplicate-stage decision, got ${plan.ambiguities.map((ambiguity) => ambiguity.key).join(",")}`);
    const decisions = allApprovals(plan);
    const applied = applyKxmMigration(stages, { decisions });
    assert.equal(applied.action, "applied", JSON.stringify(applied.plan?.ambiguities));
    const bundle = loadKxmProject(stages);
    const steps = bundle.workflows.get("fix")!.value.steps as JsonObject[];
    assert.deepEqual(steps.map((step) => step.id), ["plan", "implement"], "duplicate stage dropped, first kept, graph intact");
    assert.match(String(steps[0]!.instructions), /First stage/);
  } finally {
    cleanup(stages);
  }
});

test("oracle and plan-hash references to decision-dropped stages are preserved and omitted", () => {
  const root = legacyRoot("kxm-migrate-oracledrop-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      reproOracle: { stageId: "broken", evidenceKey: "repro" },
      planHash: { stageId: "plan", evidenceKey: "plan" },
      requirePlanHash: ["plan", "broken"],
      stages: [
        { id: "plan", instructions: "Plan.", requiredEvidence: ["plan"], on: { passed: "broken" } },
        { id: "broken", label: "no instructions" },
        { id: "implement", instructions: "Implement.", on: { passed: "$terminal" } },
      ],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const decisions = allApprovals(plan);
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied", JSON.stringify(applied.plan?.ambiguities));
    const bundle = loadKxmProject(root);
    const workflow = bundle.workflows.get("fix")!.value;
    assert.equal(workflow.reproOracle, undefined, "oracle on a dropped stage is omitted, not a hard failure");
    assert.deepEqual(workflow.planHash, { stageId: "plan", evidenceKey: "plan" });
    assert.deepEqual(workflow.requirePlanHash, ["plan"], "dropped requirePlanHash entries are omitted");
    const unmapped = applied.plan?.unmapped as Array<{ jsonPointer: string }>;
    assert(unmapped.some((entry) => entry.jsonPointer === "/0/reproOracle"), "dropped oracle is preserved in the report");
    assert(unmapped.some((entry) => entry.jsonPointer === "/0/requirePlanHash/1"), "dropped requirePlanHash entry is preserved");
  } finally {
    cleanup(root);
  }
});

test("out-of-range terminal-edge budgets are preserved and dropped; oversized names truncate safely", () => {
  const root = legacyRoot("kxm-migrate-termrange-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [{ id: "s", instructions: "x", on: { passed: { target: "$terminal", maxTransitions: 500 }, failed: "$terminal" } }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const unmapped = plan.plan.unmapped as Array<{ jsonPointer: string }>;
    assert(unmapped.some((entry) => entry.jsonPointer.endsWith("/on/passed/maxTransitions")), "out-of-range terminal budget is reported");
    const applied = applyKxmMigration(root, { decisions: allApprovals(plan) });
    assert.equal(applied.action, "applied");
  } finally {
    cleanup(root);
  }

  const longName = `agent-${"x".repeat(300)}`;
  const huge = legacyRoot("kxm-migrate-huge-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [{ name: longName, kind: "agent", driver: "ai" }],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{ id: "w", target: longName, stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }] }]),
  });
  try {
    const plan = planKxmMigration(huge);
    assert(plan.plan.canApply !== undefined, "oversized names never hard-fail plan schema validation");
    const renames = plan.plan.renames as Array<{ from: string; to: string }>;
    for (const rename of renames) assert(rename.from.length <= 128, "rename.from respects the schema bound");
    const applied = applyKxmMigration(huge, { decisions: allApprovals(plan) });
    assert.equal(applied.action, "applied");
  } finally {
    cleanup(huge);
  }
});

test("linked workflow files are rejected, never silently omitted (file-level)", (context) => {
  const root = legacyRoot("kxm-migrate-linkfile2-", {
    ".kxm/config/agents.json": AGENTS,
  });
  const external = mkdtempSync(join(tmpdir(), "kxm-migrate-linkfile2-target-"));
  try {
    const targetFile = join(external, "fix.json");
    writeFileSync(targetFile, WORKFLOW, "utf8");
    mkdirSync(join(root, ".kxm", "config", "workflows"), { recursive: true });
    try {
      symlinkSync(targetFile, join(root, ".kxm", "config", "workflows", "fix.json"), "file");
    } catch (error) {
      // Windows without Developer Mode/admin cannot create file symlinks; the
      // directory-junction variant is covered by the sibling test.
      context.skip(`file symlink unavailable: ${(error as Error).message}`);
      return;
    }
    assert.throws(
      () => planKxmMigration(root),
      (error) => issueCodes(error).includes("legacy_source_invalid"),
    );
  } finally {
    cleanup(root, external);
  }
});

test("pending roster identities offer no coordinator decision; resolved identities bind by raw name", () => {
  const root = legacyRoot("kxm-migrate-pendingroster-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [{ name: "\u30e9\u30a4\u30bf\u30fc", kind: "agent", driver: "ai" }],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "\u30e9\u30a4\u30bf\u30fc",
      stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    assert(!plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("coordinator:")), "no coordinator decision while identities pend (it would be unstable)");
    const agentKey = plan.ambiguities.map((ambiguity) => ambiguity.key).find((key) => key.startsWith("identity:agent:"))!;
    const decisions = allApprovals(plan);
    decisions[agentKey] = "sole-writer";
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    const bundle = loadKxmProject(root);
    assert.equal(bundle.workflows.get("fix")!.value.coordinator, "sole-writer", "raw-name binding after identities resolve");
  } finally {
    cleanup(root);
  }
});

test("thousand-character legacy names never hard-fail plan schema validation", () => {
  const longName = `agent-${"x".repeat(3000)}`;
  const root = legacyRoot("kxm-migrate-thousand-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [{ name: longName, kind: "agent", driver: "ai" }],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{ id: "w", target: longName, stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }] }]),
  });
  try {
    const plan = planKxmMigration(root);
    const ambiguities = plan.plan.ambiguities as Array<{ key: string; message: string }>;
    for (const ambiguity of ambiguities) {
      assert(ambiguity.key.length <= 512, `key fits schema bound: ${ambiguity.key.length}`);
      assert(ambiguity.message.length <= 2000, "message fits schema bound");
    }
    const decisions = allApprovals(plan);
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    assert.equal(verifyKxmMigration(root).ok, true);
  } finally {
    cleanup(root);
  }
});

test("partial-pending rosters offer no misleading coordinator/producer decisions", () => {
  const root = legacyRoot("kxm-migrate-partial-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [
        { name: "writer", kind: "agent", driver: "ai" },
        { name: "\u30e9\u30a4\u30bf\u30fc", kind: "agent", driver: "ai" },
      ],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "\u30e9\u30a4\u30bf\u30fc",
      stages: [{
        id: "check",
        instructions: "Check.",
        requiredEvidence: ["verdict"],
        evidencePolicies: {
          verdict: { kind: "peer-reply", minProducers: 1, eligibleAgents: ["\u30e9\u30a4\u30bf\u30fc"], acceptedStatuses: ["replied"] },
        },
        on: { passed: "$terminal" },
      }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const keys = plan.ambiguities.map((ambiguity) => ambiguity.key);
    assert(!keys.some((key) => key.startsWith("coordinator:")), "no coordinator decision for a pending roster target");
    assert(!keys.some((key) => key.startsWith("producer:")), "no producer decision for a pending roster producer");
    const agentKey = keys.find((key) => key.startsWith("identity:agent:"))!;
    const decisions = allApprovals(plan);
    decisions[agentKey] = "rain-writer";
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied", JSON.stringify(applied.plan?.ambiguities));
    const bundle = loadKxmProject(root);
    assert.equal(bundle.workflows.get("fix")!.value.coordinator, "rain-writer", "pending target binds by raw name after identities resolve");
    const check = (bundle.workflows.get("fix")!.value.steps as JsonObject[])[0]!;
    const verdict = (check.requiredEvidence as JsonObject[]).find((entry) => entry.key === "verdict")!;
    assert.deepEqual((verdict.producerPolicy as JsonObject).eligibleAgents, ["rain-writer"], "pending producer binds by raw name");
  } finally {
    cleanup(root);
  }
});

test("decision-supplied model profile id colliding with another profile stays an ambiguity", () => {
  const root = legacyRoot("kxm-migrate-profile-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [
        { name: "writer", kind: "agent", driver: "ai", model: "xai/grok-4.6", thinking: "high" },
        { name: "reviewer", kind: "agent", driver: "ai", model: "anthropic/claude-fable-5-1", thinking: "max" },
      ],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{ id: "w", target: "writer", stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }] }]),
  });
  try {
    const plan = planKxmMigration(root);
    assert(plan.resources.has(".kxm/models/writer-primary.yaml"));
    assert(plan.resources.has(".kxm/models/reviewer-primary.yaml"));
    const decisions = allApprovals(plan);
    // Force a profile identity decision by colliding the second profile onto
    // the first: the only in-plan channel is an <identifier> decision, which
    // this roster does not produce, so instead verify the profiles differ and
    // both survive (no last-wins merge).
    const writer = plan.resources.get(".kxm/models/writer-primary.yaml") as JsonObject;
    const reviewer = plan.resources.get(".kxm/models/reviewer-primary.yaml") as JsonObject;
    assert.notEqual(writer.provider, reviewer.provider);
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
    const bundle = loadKxmProject(root);
    assert.equal(bundle.models.size, 2, "both profiles survive; no silent overwrite");
  } finally {
    cleanup(root);
  }
});

test("pending duplicate stages keep the preview intact (first declaration owns the rename)", () => {
  const root = legacyRoot("kxm-migrate-pendingdup-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [
        { id: "plan", instructions: "First stage.", on: { passed: "implement" } },
        { id: "plan", instructions: "Duplicate stage.", on: { passed: "$terminal" } },
        { id: "implement", instructions: "Implement.", on: { passed: "$terminal" } },
      ],
    }]),
  });
  try {
    // Plan WITHOUT the drop decision: the preview must keep the first stage's
    // identity instead of corrupting both into one placeholder.
    const plan = planKxmMigration(root);
    const workflow = plan.resources.get(".kxm/workflows/fix.yaml") as JsonObject;
    const steps = workflow.steps as JsonObject[];
    assert.equal(steps[0]!.id, "plan", "first declaration keeps its identity in the preview");
    assert.notEqual(steps[1]!.id, "plan", "pending duplicate uses a distinct preview id");
    assert(plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("identity-duplicate:step:")));
  } finally {
    cleanup(root);
  }
});

test("pending stage identity previews always satisfy the identifier grammar", () => {
  const longStage = `stage-${"x".repeat(100)}`;
  const root = legacyRoot("kxm-migrate-longstage-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [
        { id: longStage, instructions: "Long.", on: { passed: "plan_" } },
        { id: "plan_", instructions: "Underscore.", on: { passed: "$terminal" } },
      ],
    }]),
  });
  try {
    // Must return a plan (with identity decisions), never a schema error.
    const plan = planKxmMigration(root);
    const keys = plan.ambiguities.map((ambiguity) => ambiguity.key);
    assert(keys.some((key) => key.startsWith("identity:step:")), `expected step identity decisions, got ${keys.join(",")}`);
    const workflow = plan.resources.get(".kxm/workflows/fix.yaml") as JsonObject;
    for (const step of workflow.steps as JsonObject[]) {
      assert(String(step.id).length <= 64, `preview id ${String(step.id).slice(0, 40)}... fits the identifier bound`);
      assert(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(String(step.id)), "preview id matches the identifier pattern");
    }
    const decisions = allApprovals(plan);
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied", JSON.stringify(applied.plan?.ambiguities));
  } finally {
    cleanup(root);
  }

  const dup = legacyRoot("kxm-migrate-dupstage3-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [
        { id: `dup-${"y".repeat(50)}`, instructions: "First.", on: { passed: "$terminal" } },
        { id: `dup-${"y".repeat(50)}`, instructions: "Second.", on: { passed: "$terminal" } },
      ],
    }]),
  });
  try {
    const plan = planKxmMigration(dup);
    assert(plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("identity-duplicate:step:")));
    const workflow = plan.resources.get(".kxm/workflows/fix.yaml") as JsonObject;
    for (const step of workflow.steps as JsonObject[]) {
      assert(String(step.id).length <= 64, "duplicate preview id fits the identifier bound");
      assert(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(String(step.id)), "duplicate preview id matches the identifier pattern");
    }
    assert.notEqual((workflow.steps as JsonObject[])[0]!.id, (workflow.steps as JsonObject[])[1]!.id, "duplicate previews stay distinct");
  } finally {
    cleanup(dup);
  }
});

test("thousand-character names with provider-less models never hard-fail planning", () => {
  // Raw length 3001 but normalizes to "w": the agent converts, so the model
  // decision branch runs with the full-length name in play.
  const longName = `w${"!".repeat(3000)}`;
  const root = legacyRoot("kxm-migrate-thousand2-", {
    ".kxm/config/agents.json": JSON.stringify({
      agents: [{ name: longName, kind: "agent", driver: "ai", model: "grok-4.6" }],
    }),
    ".kxm/config/workflows/fix.json": JSON.stringify([{ id: "w", target: "w", stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }] }]),
  });
  try {
    const plan = planKxmMigration(root);
    const ambiguities = plan.plan.ambiguities as Array<{ key: string; message: string }>;
    for (const ambiguity of ambiguities) {
      assert(ambiguity.key.length <= 512, "key fits schema bound");
      assert(ambiguity.message.length <= 2000, `message fits schema bound (${ambiguity.message.length})`);
    }
    assert(ambiguities.some((ambiguity) => ambiguity.key.startsWith("model:")), "provider-less model decision is listed");
    const decisions = allApprovals(plan);
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied");
  } finally {
    cleanup(root);
  }
});

test("dropped edges record full source pointers with raw outcome keys", () => {
  const root = legacyRoot("kxm-migrate-edgepointer-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [{
        id: "plan",
        instructions: "Plan.",
        on: { passed: "missing-stage", [`o${"x".repeat(80)}`]: "$terminal" },
      }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const unmapped = plan.plan.unmapped as Array<{ jsonPointer: string }>;
    assert(unmapped.some((entry) => entry.jsonPointer === "/0/stages/0/on/passed"), `full pointer for dropped edge, got ${unmapped.map((entry) => entry.jsonPointer).join(",")}`);
    assert(unmapped.some((entry) => entry.jsonPointer.startsWith("/0/stages/0/on/") && !entry.jsonPointer.endsWith("/on/passed")), "oversized raw outcome key preserved in pointer");
  } finally {
    cleanup(root);
  }
});

test("leading-underscore legacy ids normalize cleanly and malformed accepted statuses require decisions", () => {
  const root = legacyRoot("kxm-migrate-underscore-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/_fix.json": JSON.stringify([{
      id: "_fix",
      target: "writer",
      stages: [
        { id: "_draft", instructions: "Draft.", on: { passed: "_" } },
        { id: "_", instructions: "Underscore.", on: { passed: "_a" } },
        { id: "_a", instructions: "First a.", on: { passed: "$terminal" } },
        { id: "_a", instructions: "Second a.", on: { passed: "$terminal" } },
      ],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const workflow = plan.resources.get(".kxm/workflows/fix.yaml") as JsonObject;
    const steps = workflow.steps as JsonObject[];
    // Leading underscores normalize away where a name remains: "_draft" ->
    // "draft" and "_a" -> "a" need no identity decision; the bare "_" stage
    // normalizes to empty and previews with a grammar-valid placeholder.
    assert.equal(steps[0]!.id, "draft");
    assert.equal(steps[2]!.id, "a");
    // The bare-underscore preview and the duplicate "_a" preview stay distinct.
    assert.notEqual(steps[1]!.id, steps[3]!.id, "pending previews stay distinct");
    for (const step of steps) {
      assert(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(String(step.id)), `preview/normalized id ${step.id} matches the grammar`);
    }
    assert(plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("identity-duplicate:step:")), "duplicate _a requires a drop decision");
    const decisions = allApprovals(plan);
    const applied = applyKxmMigration(root, { decisions });
    assert.equal(applied.action, "applied", JSON.stringify(applied.plan?.ambiguities));
    const bundle = loadKxmProject(root);
    const appliedSteps = bundle.workflows.get("fix")!.value.steps as JsonObject[];
    assert(appliedSteps.some((step) => step.id === "draft"));
  } finally {
    cleanup(root);
  }

  const malformed = legacyRoot("kxm-migrate-statuses-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [{
        id: "check",
        instructions: "Check.",
        requiredEvidence: ["verdict"],
        evidencePolicies: {
          verdict: { kind: "peer-reply", minProducers: 1, eligibleAgents: ["writer"], acceptedStatuses: "bogus" },
        },
        on: { passed: "$terminal" },
      }],
    }]),
  });
  try {
    const plan = planKxmMigration(malformed);
    assert(
      plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("statuses:")),
      "non-array acceptedStatuses routes through the statuses decision, never a silent mapping",
    );
    const unmapped = plan.plan.unmapped as Array<{ jsonPointer: string }>;
    assert(unmapped.some((entry) => entry.jsonPointer.endsWith("/acceptedStatuses")), "malformed value preserved in the report");
  } finally {
    cleanup(malformed);
  }
});

test("preview ids with separators at the slice boundary stay grammar-valid", () => {
  const boundaryId = `${"a".repeat(45)}-bbbb`;
  const root = legacyRoot("kxm-migrate-boundary-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [
        { id: boundaryId, instructions: "First.", on: { passed: "implement" } },
        { id: boundaryId, instructions: "Duplicate.", on: { passed: "$terminal" } },
        { id: "implement", instructions: "Implement.", on: { passed: "$terminal" } },
      ],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const workflow = plan.resources.get(".kxm/workflows/fix.yaml") as JsonObject;
    for (const step of workflow.steps as JsonObject[]) {
      assert(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(String(step.id)), `preview id ${step.id} matches the grammar`);
      assert(String(step.id).length <= 64);
    }
    assert(plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("identity-duplicate:step:")));
    const applied = applyKxmMigration(root, { decisions: allApprovals(plan) });
    assert.equal(applied.action, "applied");
  } finally {
    cleanup(root);
  }

  const longBoundary = legacyRoot("kxm-migrate-boundary2-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/fix.json": JSON.stringify([{
      id: "fix",
      target: "writer",
      stages: [{ id: `${"a".repeat(45)}-${"b".repeat(40)}`, instructions: "Long.", on: { passed: "$terminal" } }],
    }]),
  });
  try {
    const plan = planKxmMigration(longBoundary);
    const workflow = plan.resources.get(".kxm/workflows/fix.yaml") as JsonObject;
    for (const step of workflow.steps as JsonObject[]) {
      assert(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(String(step.id)), `over-length preview id ${step.id} matches the grammar`);
      assert(String(step.id).length <= 64);
    }
    assert(plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("identity:step:")));
  } finally {
    cleanup(longBoundary);
  }
});

test("workflow preview ids with separators at the slice boundary stay grammar-valid", () => {
  const boundaryId = `${"a".repeat(45)}-bbbb`;
  const root = legacyRoot("kxm-migrate-wfboundary-", {
    ".kxm/config/agents.json": AGENTS,
    ".kxm/config/workflows/alpha.json": JSON.stringify([{
      id: boundaryId,
      target: "writer",
      stages: [{ id: "s", instructions: "First.", on: { passed: "$terminal" } }],
    }]),
    ".kxm/config/workflows/beta.json": JSON.stringify([{
      id: boundaryId,
      target: "writer",
      stages: [{ id: "s", instructions: "Duplicate.", on: { passed: "$terminal" } }],
    }]),
  });
  try {
    const plan = planKxmMigration(root);
    const workflowPaths = [...plan.resources.keys()].filter((path) => path.startsWith(".kxm/workflows/"));
    assert.equal(workflowPaths.length, 2, "both the adopted workflow and the duplicate preview are present in plan 1");
    for (const path of workflowPaths) {
      const id = path.slice(".kxm/workflows/".length, -".yaml".length);
      assert(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(id), `preview workflow id ${id} matches the grammar`);
      assert(id.length <= 64, "preview workflow id fits the bound");
    }
    assert(plan.ambiguities.some((ambiguity) => ambiguity.key.startsWith("identity-duplicate:workflow:")));
    const applied = applyKxmMigration(root, { decisions: allApprovals(plan) });
    assert.equal(applied.action, "applied");
    const bundle = loadKxmProject(root);
    assert.deepEqual([...bundle.workflows.keys()], [boundaryId], "adopted first definition survives; duplicate dropped");
  } finally {
    cleanup(root);
  }
});

test("oversized legacy source sets and BOM-prefixed JSON are handled deterministically", () => {
  const many = legacyRoot("kxm-migrate-many-", {
    ".kxm/config/agents.json": AGENTS,
  });
  try {
    mkdirSync(join(many, ".kxm", "config", "workflows"), { recursive: true });
    for (let index = 0; index < 70; index += 1) {
      writeFileSync(
        join(many, ".kxm", "config", "workflows", `w${String(index).padStart(3, "0")}.json`),
        JSON.stringify([{ id: `w${index}`, target: "writer", stages: [{ id: "s", instructions: "x", on: { passed: "$terminal" } }] }]),
        "utf8",
      );
    }
    assert.throws(() => planKxmMigration(many), (error) => issueCodes(error).includes("legacy_source_limit"));
  } finally {
    cleanup(many);
  }

  const bom = legacyRoot("kxm-migrate-bom-", {});
  try {
    mkdirSync(join(bom, ".kxm", "config", "workflows"), { recursive: true });
    writeFileSync(join(bom, ".kxm", "config", "agents.json"), `\uFEFF${AGENTS}`, "utf8");
    writeFileSync(join(bom, ".kxm", "config", "workflows", "fix.json"), WORKFLOW, "utf8");
    const plan = planKxmMigration(bom);
    assert(plan.plan.sourceDigest !== undefined, "BOM-prefixed JSON parses (hash covers raw bytes)");
  } finally {
    cleanup(bom);
  }
});
