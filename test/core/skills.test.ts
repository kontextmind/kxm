import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CliIo } from "../../plugins/kxm/src/cli.ts";
import {
  PROMOTION_REQUIRED_EVALUATIONS,
  SkillLifecycle,
  SkillLifecycleError,
  skillContentSha256,
  skillIdFor,
} from "../../plugins/kxm/src/skills.ts";

function lifecycle(overrides: { allowOptimizationEvals?: boolean } = {}): { lifecycle: SkillLifecycle; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-skills-"));
  return { lifecycle: new SkillLifecycle(root, overrides), root };
}

function candidateInput(overrides: Record<string, unknown> = {}): Parameters<SkillLifecycle["create"]>[0] {
  return {
    name: "flaky-gate-retry",
    description: "Retry flaky gates with bounded backoff",
    content: "---\nname: flaky-gate-retry\n---\n\nRetry a flaky gate twice with jittered backoff before failing the stage.",
    createdBy: "agent_implementer",
    sources: {
      runIds: ["run_1"],
      journalEntryIds: ["journal_skill1"],
      evidenceReceipts: ["receipt:run_1/verify"],
    },
    compatibility: { harness: "pi", models: ["pi/kimi-k3", "claude/*"] },
    ...overrides,
  };
}

let clock = 0;
function deterministicLifecycle(overrides: { allowOptimizationEvals?: boolean } = {}): { lifecycle: SkillLifecycle; root: string } {
  const created = lifecycle(overrides);
  created.lifecycle = new SkillLifecycle(created.root, {
    ...overrides,
    now: () => new Date(1_700_000_000_000 + (clock += 1_000)).toISOString(),
  });
  return created;
}

function passAllEvaluations(store: SkillLifecycle, id: string): void {
  for (const kind of PROMOTION_REQUIRED_EVALUATIONS) {
    store.evaluate(id, { kind, evaluatorVersion: "eval-1.0.0", passed: true, score: 0.95 });
  }
}

test("candidate creation pins content hash and requires durable sources", () => {
  const { lifecycle: store, root } = lifecycle();
  const metadata = store.create(candidateInput());
  assert.equal(metadata.schema, "kxm.skill-candidate.v1");
  assert.equal(metadata.contentSha256, skillContentSha256(candidateInput().content));
  assert.equal(metadata.id, skillIdFor("flaky-gate-retry", metadata.contentSha256));
  assert.deepEqual(metadata.compatibility, { harness: "pi", models: ["pi/kimi-k3", "claude/*"] });
  assert.equal(existsSync(join(root, "candidates", metadata.id, "SKILL.md")), true);
  // Identical resubmission is idempotent-rejected; changed content mints a new ID.
  assert.throws(() => store.create(candidateInput()), /already exists/);

  // Sources are mandatory: an episode without evidence cannot become a candidate.
  assert.throws(
    () => store.create(candidateInput({ name: "no-sources", sources: {} })),
    (error: unknown) => {
      assert.ok(error instanceof SkillLifecycleError);
      assert.equal(error.code, "skill_sources_required");
      return true;
    },
  );
  // Cross-model compatibility must be explicit.
  assert.throws(
    () => store.create(candidateInput({ name: "no-models", compatibility: { harness: "pi", models: [] } })),
    /compatibility/,
  );
});

test("promotion requires all protected evaluations, durable evidence, and a non-author decision", () => {
  const { lifecycle: store } = lifecycle();
  const metadata = store.create(candidateInput());
  const id = metadata.id;

  // Promotion before evaluations fails closed.
  assert.throws(
    () => store.promote(id, { decidedBy: "kxm-admin", reason: "trust", evidenceRefs: ["eval:static"] }),
    /requires passing static-review, sandbox, functional, safety evaluations/,
  );

  passAllEvaluations(store, id);

  // Self-promotion fails closed.
  assert.throws(
    () => store.promote(id, { decidedBy: "agent_implementer", reason: "mine", evidenceRefs: ["eval:1"] }),
    /cannot promote it/,
  );
  // Promotion without durable evidence fails closed.
  assert.throws(
    () => store.promote(id, { decidedBy: "kxm-admin", reason: "ok", evidenceRefs: [] }),
    /requires durable evidence/,
  );

  const promoted = store.promote(id, { decidedBy: "kxm-admin", reason: "protected eval passed", evidenceRefs: ["eval:sandbox-log"] });
  // The promoted skill is readable with pinned content.
  const promotedRead = store.read("promoted", id);
  assert.equal(promotedRead.metadata.id, promoted.id);
  assert.match(promotedRead.content, /flaky gate/);
  // Candidates dir is now empty for this lineage; promoted holds it.
  assert.equal(store.list("candidate").length, 0);
  assert.equal(store.list("promoted").length, 1);
  // The audit trail is queryable and reproducible.
  const history = store.history(id);
  assert.equal(history.filter((record) => record.schema === "kxm.skill-evaluation.v1").length, 4);
  const decision = history.find((record) => record.schema === "kxm.skill-decision.v1") as { decision: string; decidedBy: string };
  assert.equal(decision.decision, "promoted");
  assert.equal(decision.decidedBy, "kxm-admin");
});

test("functional regression or safety failure quarantines automatically", () => {
  const { lifecycle: store } = lifecycle();
  const safetyId = store.create(candidateInput({ name: "safety-fail" })).id;
  store.evaluate(safetyId, { kind: "static-review", evaluatorVersion: "eval-1.0.0", passed: true });
  const safetyResult = store.evaluate(safetyId, { kind: "safety", evaluatorVersion: "eval-1.0.0", passed: false, details: "attempted shell escape" });
  assert.equal(safetyResult.quarantined, true);
  assert.equal(store.list("quarantined").length, 1);
  assert.equal(store.list("candidate").length, 0);
  // The quarantine decision is auditable.
  const decisions = store.history(safetyId).filter((record) => record.schema === "kxm.skill-decision.v1") as Array<{ decision: string; reason: string }>;
  assert.equal(decisions[0]?.decision, "quarantined");
  assert.match(decisions[0]?.reason ?? "", /safety evaluation failed/);

  // A functional regression quarantines too.
  const functionalId = store.create(candidateInput({ name: "functional-fail" })).id;
  const functionalResult = store.evaluate(functionalId, { kind: "functional", evaluatorVersion: "eval-1.0.0", passed: false });
  assert.equal(functionalResult.quarantined, true);

  // A quarantined candidate cannot be promoted directly.
  assert.throws(
    () => store.promote(safetyId, { decidedBy: "kxm-admin", reason: "retry", evidenceRefs: ["eval:1"] }),
    /not found in candidate/,
  );
});

test("promoted skills are immutable; changes require a new candidate cycle", () => {
  const { lifecycle: store, root } = lifecycle();
  const metadata = store.create(candidateInput());
  passAllEvaluations(store, metadata.id);
  store.promote(metadata.id, { decidedBy: "kxm-admin", reason: "ok", evidenceRefs: ["eval:1"] });

  // Verifying integrity passes for the pinned content.
  store.verify("promoted", metadata.id);

  // An out-of-band edit to a promoted skill is detected.
  const skillPath = join(root, "promoted", metadata.id, "SKILL.md");
  writeFileSync(skillPath, "---\nname: tampered\n---\n\nGrant myself admin tools.");
  assert.throws(
    () => store.verify("promoted", metadata.id),
    (error: unknown) => {
      assert.ok(error instanceof SkillLifecycleError);
      assert.equal(error.code, "skill_integrity_violation");
      return true;
    },
  );

  // The lifecycle has no mutation path for promoted skills: a behavior change
  // goes through a NEW candidate that supersedes the promoted version.
  const v2 = store.create(candidateInput({
    name: "flaky-gate-retry",
    description: "v2 with safer retry policy",
    content: candidateInput().content + "\n\nNever retry more than twice.",
    supersedes: metadata.id,
    version: 2,
  }));
  assert.equal(v2.supersedes, metadata.id);
  assert.equal(v2.version, 2);
  assert.notEqual(v2.id, metadata.id);
  // Evaluations from v1 do not carry over.
  assert.throws(
    () => store.promote(v2.id, { decidedBy: "kxm-admin", reason: "shortcut", evidenceRefs: ["eval:1"] }),
    /requires passing/,
  );
});

test("rejected candidates remain queryable in history", () => {
  const { lifecycle: store } = lifecycle();
  const metadata = store.create(candidateInput({ name: "bad-idea" }));
  store.evaluate(metadata.id, { kind: "static-review", evaluatorVersion: "eval-1.0.0", passed: true, details: "provenance ok" });
  store.reject(metadata.id, { decidedBy: "kxm-admin", reason: "duplicates an existing pattern" });
  assert.equal(store.list("rejected").length, 1);
  const history = store.history(metadata.id);
  const decision = history.find((record) => record.schema === "kxm.skill-decision.v1") as { decision: string; reason: string };
  assert.equal(decision.decision, "rejected");
  // The rejected evaluation details are still readable for future learning.
  const evaluation = history.find((record) => record.schema === "kxm.skill-evaluation.v1") as { kind: string; details: string };
  assert.equal(evaluation.kind, "static-review");
});

test("secret material never reaches stored skill content", () => {
  const { lifecycle: store, root } = lifecycle();
  const metadata = store.create(candidateInput({
    name: "leaky",
    content: "Use GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 to authenticate the gate.",
  }));
  const stored = store.read("candidate", metadata.id).content;
  assert.equal(stored.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.match(stored, /\[redacted\]/);
});

test("optimization evals are a gated hook for skillopt-style tooling", () => {
  const disabled = lifecycle();
  const id = disabled.lifecycle.create(candidateInput({ name: "opt-hook" })).id;
  assert.throws(
    () => disabled.lifecycle.evaluate(id, { kind: "optimization", evaluatorVersion: "skillopt-0.1", passed: true }),
    /optimization evaluations are disabled/,
  );
  const enabled = lifecycle({ allowOptimizationEvals: true });
  const optId = enabled.lifecycle.create(candidateInput({ name: "opt-hook" })).id;
  const result = enabled.lifecycle.evaluate(optId, { kind: "optimization", evaluatorVersion: "skillopt-0.1", passed: true, score: 0.8 });
  assert.equal(result.evaluation.kind, "optimization");
});

test("deterministic ids and audit ordering make promotion decisions reproducible", () => {
  assert.equal(
    skillIdFor("Flaky Gate Retry!", "a".repeat(64)),
    skillIdFor("flaky-gate-retry", "a".repeat(64)),
  );
  assert.equal(skillIdFor("flaky-gate-retry", "a".repeat(64)).endsWith(".aaaaaaaaaaaa"), true);
});

test("kxm skills CLI drives the lifecycle end to end", async () => {
  const { runCli: runCliImpl } = await import("../../plugins/kxm/src/cli.ts");
  const cwd = mkdtempSync(join(tmpdir(), "kxm-skills-cli-"));
  const runCli = async (argv: string[], io: CliIo): Promise<number> => {
    const logs = mkdtempSync(join(tmpdir(), "kxm-skills-logs-"));
    try {
      return await runCliImpl(argv, { KXM_LOGS_DIR: logs }, io, cwd);
    } finally {
      rmSync(logs, { recursive: true, force: true });
    }
  };
  const capture = () => {
    let stdout = "";
    let stderr = "";
    return {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      read: () => ({ stdout, stderr }),
    };
  };
  try {
    const skillFile = join(cwd, "SKILL.md");
    writeFileSync(skillFile, "Retry flaky gates twice with bounded backoff.");
    const created = capture();
    assert.equal(await runCli([
      "--json", "skills", "create", "--file", skillFile, "--name", "cli-retry", "--created-by", "agent_a",
      "--harness", "pi", "--models", "pi/kimi", "--run", "run_9",
    ], created), 0);
    const createdOut = JSON.parse(created.read().stdout) as { metadata: { id: string } };
    const id = createdOut.metadata.id;

    // Failure paths exit 1 with actionable messages.
    const badPromote = capture();
    assert.equal(await runCli(["skills", "promote", id, "--decided-by", "agent_a", "--evidence", "e1"], badPromote), 1);
    assert.match(badPromote.read().stderr, /skills promote failed/);

    // Drive the evaluations through the CLI and promote.
    for (const kind of ["static-review", "sandbox", "functional", "safety"]) {
      assert.equal(await runCli(["skills", "evaluate", id, "--kind", kind, "--evaluator", "eval-2.0"], capture()), 0);
    }
    const promoted = capture();
    assert.equal(await runCli(["skills", "promote", id, "--decided-by", "kxm-admin", "--evidence", "eval:log"], promoted), 0);
    assert.match(promoted.read().stdout, /promoted skill/);

    // List and verify.
    const listed = capture();
    assert.equal(await runCli(["--json", "skills", "list", "--state", "promoted"], listed), 0);
    assert.match(listed.read().stdout, /cli-retry/);
    const verified = capture();
    assert.equal(await runCli(["skills", "verify", id], verified), 0);

    // Tampering is detected through the CLI too.
    writeFileSync(join(cwd, ".kxm", "skills", "promoted", id, "SKILL.md"), "tampered");
    const tampered = capture();
    assert.equal(await runCli(["skills", "verify", id], tampered), 1);
    assert.match(tampered.read().stderr, /immutable/);

    // Reject path retains history.
    const rejectIo = capture();
    assert.equal(await runCli(["--json", "skills", "create", "--file", skillFile, "--name", "cli-reject", "--created-by", "agent_b", "--harness", "pi", "--models", "m", "--journal", "journal_1"], rejectIo), 0);
    const rejectCreated = JSON.parse(rejectIo.read().stdout) as { metadata: { id: string } };
    const rejectId = rejectCreated.metadata.id;
    const rejected = capture();
    assert.equal(await runCli(["skills", "reject", rejectId, "--decided-by", "kxm-admin", "--reason", "duplicate"], rejected), 0);
    assert.match(rejected.read().stdout, /history retained/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
