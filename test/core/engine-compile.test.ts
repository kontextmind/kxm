import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import type { Node } from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";
import { visitEachChild } from "typescript/unstable/ast/visitor";
import { parseRestrictedYaml, kxmCanonicalJson, type JsonObject, type JsonValue } from "../../plugins/kxm/src/project-config.ts";
import {
  KXM_COMPILED_WORKFLOW_SCHEMA,
  KXM_RESERVED_STEP_KINDS,
  KxmEngineCompileError,
  compileKxmWorkflow,
  type KxmCompiledPlan,
  type KxmCompiledStep,
  type KxmEngineCompileIssue,
} from "../../plugins/kxm/src/engine-compile.ts";

// Loader validation of these fixtures is covered in test/project-config.test.ts.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultPath = resolve(repoRoot, "examples/project/.kxm/workflows/default.yaml");
const fixPath = resolve(repoRoot, "examples/project/.kxm/workflows/fix.yaml");
const compileModulePath = resolve(repoRoot, "plugins/kxm/src/engine-compile.ts");

function loadWorkflow(file: string): JsonObject {
  return parseRestrictedYaml(readFileSync(file), file);
}

function compileFixture(id: "default" | "fix"): KxmCompiledPlan {
  const file = id === "default" ? defaultPath : fixPath;
  return compileKxmWorkflow({ id, value: loadWorkflow(file), logicalPath: file });
}

function document(steps: JsonObject[], extra: JsonObject = {}): JsonObject {
  return { schema: "kxm.workflow.v1", steps, ...extra };
}

function terminal(status: string, extra: JsonObject = {}): JsonObject {
  return { target: "$terminal", terminalStatus: status, ...extra };
}

function passedTerminal(): JsonObject {
  return { passed: terminal("completed") };
}

function compile(value: JsonObject, id = "case"): KxmCompiledPlan {
  return compileKxmWorkflow({ id, value });
}

function issuesOf(value: JsonObject, id = "case"): KxmEngineCompileIssue[] {
  try {
    compile(value, id);
  } catch (error) {
    assert(error instanceof KxmEngineCompileError, `expected KxmEngineCompileError, received ${String(error)}`);
    return [...error.issues];
  }
  assert.fail("expected compile to fail");
}

function codesOf(value: JsonObject): string[] {
  return issuesOf(value).map((issue) => issue.code);
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function canonical(value: unknown): string {
  return kxmCanonicalJson(asJson(value));
}

function assertFrozenGraph(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(value instanceof Map, false, "compiled plan must not contain Map");
  assert.equal(value instanceof Set, false, "compiled plan must not contain Set");
  assert.equal(Object.isFrozen(value), true);
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertFrozenGraph(entry, seen);
    return;
  }
  for (const entry of Object.values(value)) assertFrozenGraph(entry, seen);
}

function stepOf(plan: KxmCompiledPlan, id: string): KxmCompiledStep {
  const step = plan.steps[id];
  assert.ok(step, `missing compiled step ${id}`);
  return step;
}

test("default.yaml compiles to the slim four-step plan", () => {
  const plan = compileFixture("default");
  assert.equal(plan.schema, KXM_COMPILED_WORKFLOW_SCHEMA);
  assert.equal(plan.workflowId, "default");
  assert.equal(plan.sourcePath, defaultPath);
  assert.equal(plan.coordinator, "coordinator");
  assert.deepEqual([...plan.order], ["plan", "implement", "verify", "ready"]);
  assert.deepEqual(Object.keys(plan.steps), ["plan", "implement", "verify", "ready"]);
  assert.equal(plan.entryStepId, "plan");
  assert.equal(plan.transitionBudget, 8);
  assert.equal(plan.hasBackEdges, true);
  assert.equal(plan.requirePlanHash.length, 0);

  const implement = stepOf(plan, "implement");
  assert.equal(implement.kind, "agent");
  assert.equal(implement.maxAttempts, 3);
  if (implement.kind === "agent" || implement.kind === "moa") {
    assert.equal(implement.agent, "implementer");
  }
  assert.deepEqual([...implement.assignments.allowedAgents], ["implementer"]);
  assert.equal(implement.assignments.minimum, 1);
  assert.equal(implement.assignments.target, 1);
  assert.equal(implement.assignments.maximum, 2);
  assert.equal(implement.assignments.maxParallel, 1);
  assert.equal(implement.assignments.maxAttemptsPerAssignment, 2);
  assert.equal(implement.assignments.maxWriteRepositories, 1);

  const verify = stepOf(plan, "verify");
  assert.equal(verify.kind, "gate");
  if (verify.kind === "gate") {
    assert.equal(verify.gate, "test");
    assert.equal(verify.expect, "pass");
    assert.equal("agent" in verify, false);
    assert.equal("signal" in verify, false);
  }
  const back = verify.transitions["implementation-failure"];
  assert.ok(back);
  assert.equal(back.to, "step");
  if (back.to === "step") {
    assert.equal(back.target, "implement");
    assert.equal(back.edge, "back");
    assert.equal(back.maxTransitions, 3);
  }

  const ready = stepOf(plan, "ready");
  const completed = ready.transitions.passed;
  assert.ok(completed);
  assert.equal(completed.to, "terminal");
  if (completed.to === "terminal") {
    assert.equal(completed.terminalStatus, "completed");
    assert.equal("maxTransitions" in completed, false);
  }

  const planEvidence = stepOf(plan, "plan").requiredEvidence[0];
  assert.ok(planEvidence);
  assert.equal(planEvidence.minimum, 1);
  assert.equal(planEvidence.reusableAcrossAttempts, false);
});

test("fix.yaml compiles all 13 declared steps and preserves full policy", () => {
  const plan = compileFixture("fix");
  assert.equal(plan.order.length, 13);
  assert.equal(Object.keys(plan.steps).length, 13);
  assert.equal(plan.transitionBudget, 28);
  assert.equal(plan.limits.maxModelCost, 40);
  assert.equal(plan.limits.currency, "USD");
  assert.deepEqual(plan.reproOracle, { stageId: "repro-review", evidenceKey: "repro" });
  assert.deepEqual(plan.planHash, { stageId: "final-plan", evidenceKey: "plan" });
  assert.deepEqual([...plan.requirePlanHash], ["implement", "local-verify", "delivery"]);

  assert.equal(plan.limits.maxRunDurationMs, 43200000);
  assert.equal(plan.limits.maxAgentTimeMs, 86400000);

  const review = stepOf(plan, "repro-review");
  assert.equal(review.kind, "moa");
  assert.deepEqual([...review.assignments.distinctBy], []);
  assert.equal(review.model, undefined);
  assert.equal(review.join.strategy, "all-settled");
  assert.equal(review.join.minimumPassed, 2);
  assert.equal(review.join.cancelRemaining, false);
  const reviewEvidence = review.requiredEvidence.find((item) => item.key === "review");
  assert.ok(reviewEvidence?.producerPolicy);
  assert.equal(reviewEvidence.producerPolicy.minimumProducers, 2);
  assert.deepEqual([...reviewEvidence.producerPolicy.eligibleAgents], ["critic-1", "critic-2"]);
  assert.deepEqual([...reviewEvidence.producerPolicy.acceptedStatuses], ["passed"]);

  const approval = stepOf(plan, "approval");
  assert.equal(approval.kind, "approval");
  const cancelled = approval.transitions.cancelled;
  assert.ok(cancelled);
  assert.equal(cancelled.to, "terminal");
  if (cancelled.to === "terminal") {
    assert.equal(cancelled.terminalStatus, "cancelled");
    assert.equal("maxTransitions" in cancelled, false);
  }

  const wait = stepOf(plan, "ci-watch");
  assert.equal(wait.kind, "wait");
  if (wait.kind === "wait") assert.equal(wait.signal, "ci-review");

  const implement = stepOf(plan, "implement");
  assert.deepEqual(implement.repositories, { control: "read", api: "write", web: "write" });
  assert.equal(implement.timeoutMs, 3600000);
  const repro = implement.requiredEvidence.find((item) => item.key === "repro");
  const diff = implement.requiredEvidence.find((item) => item.key === "diff");
  assert.equal(repro?.reusableAcrossAttempts, true);
  assert.equal(diff?.reusableAcrossAttempts, false);
  for (const id of plan.order) {
    assert.equal(stepOf(plan, id).requiresPlanHash, id === "implement" || id === "local-verify" || id === "delivery");
  }

  const selfLoop = stepOf(plan, "repro-write").transitions.failed;
  assert.ok(selfLoop);
  assert.equal(selfLoop.to, "step");
  if (selfLoop.to === "step") {
    assert.equal(selfLoop.target, "repro-write");
    assert.equal(selfLoop.edge, "back");
    assert.equal(selfLoop.maxTransitions, 2);
  }
});

test("empty validated description, instructions, and logicalPath stay present; omitted fields stay absent", () => {
  const emptyStrings = compile(document([
    {
      id: "plan",
      kind: "agent",
      agent: "planner",
      description: "",
      instructions: "",
      on: passedTerminal(),
    },
  ]));
  const emptyStep = stepOf(emptyStrings, "plan");
  assert.equal(Object.hasOwn(emptyStep, "description"), true);
  assert.equal(Object.hasOwn(emptyStep, "instructions"), true);
  assert.equal(emptyStep.description, "");
  assert.equal(emptyStep.instructions, "");

  const omittedStrings = compile(document([
    {
      id: "plan",
      kind: "agent",
      agent: "planner",
      on: passedTerminal(),
    },
  ]));
  const omittedStep = stepOf(omittedStrings, "plan");
  assert.equal(Object.hasOwn(omittedStep, "description"), false);
  assert.equal(Object.hasOwn(omittedStep, "instructions"), false);

  const emptyPath = compileKxmWorkflow({
    id: "case",
    value: document([
      {
        id: "plan",
        kind: "agent",
        agent: "planner",
        on: passedTerminal(),
      },
    ]),
    logicalPath: "",
  });
  assert.equal(Object.hasOwn(emptyPath, "sourcePath"), true);
  assert.equal(emptyPath.sourcePath, "");

  const omittedPath = compileKxmWorkflow({
    id: "case",
    value: document([
      {
        id: "plan",
        kind: "agent",
        agent: "planner",
        on: passedTerminal(),
      },
    ]),
  });
  assert.equal(Object.hasOwn(omittedPath, "sourcePath"), false);
});

test("compile is deterministic and serializes by canonical JSON", () => {
  const value = loadWorkflow(fixPath);
  const first = compileKxmWorkflow({ id: "fix", value });
  const second = compileKxmWorkflow({ id: "fix", value });
  assert.equal(canonical(first), canonical(second));
  assert.notEqual(first.steps, second.steps);
  assert.deepEqual([...first.order], Object.keys(first.steps));
  assert.deepEqual([...stepOf(first, "local-verify").outcomes], ["blocked", "implementation-failure", "passed", "plan_invalidated"]);
  const roundTrip = JSON.parse(JSON.stringify(first)) as JsonValue;
  assert.equal(canonical(roundTrip), canonical(first));
});

test("compiled plans are frozen, null-prototype, and unaliased", () => {
  const value = loadWorkflow(defaultPath);
  const plan = compileKxmWorkflow({ id: "default", value });
  assert.equal(Object.getPrototypeOf(plan.steps), null);
  assertFrozenGraph(plan);
  assert.throws(() => {
    (plan as { workflowId: string }).workflowId = "other";
  }, TypeError);
  const evidence = stepOf(plan, "plan").requiredEvidence[0];
  assert.ok(evidence);
  assert.throws(() => {
    (evidence as { minimum: number }).minimum = 9;
  }, TypeError);
  assert.throws(() => {
    (plan.order as string[]).push("extra");
  }, TypeError);

  const before = canonical(plan);
  const steps = value.steps;
  assert(Array.isArray(steps));
  const first = steps[0];
  assert(first && typeof first === "object" && !Array.isArray(first));
  first.id = "mutated";
  const evidenceList = first.requiredEvidence;
  assert(Array.isArray(evidenceList));
  evidenceList.push({ key: "injected", kind: "artifact" });
  const on = first.on;
  assert(on && typeof on === "object" && !Array.isArray(on));
  on.passed = "mutated";
  assert.equal(canonical(plan), before);
});

test("Defaults: omitted and partial assignment policy match the loader formula", () => {
  const omittedMoa = compile(document([
    {
      id: "panel",
      kind: "moa",
      agent: "critic-1",
      on: passedTerminal(),
    },
  ]));
  const moa = stepOf(omittedMoa, "panel");
  assert.deepEqual([...moa.assignments.allowedAgents], ["critic-1"]);
  assert.equal(moa.assignments.minimum, 1);
  assert.equal(moa.assignments.target, 1);
  assert.equal(moa.assignments.maximum, 1);
  assert.equal(moa.assignments.maxParallel, 1);
  assert.equal(moa.assignments.maxAttemptsPerAssignment, 1);
  assert.deepEqual([...moa.assignments.distinctBy], []);
  assert.deepEqual(moa.join, { strategy: "all" });
  assert.equal("minimumPassed" in moa.join, false);
  assert.equal(moa.maxAttempts, 1);

  const chained = compile(document([
    {
      id: "partial",
      kind: "agent",
      agent: "implementer",
      assignments: { minimum: 2 },
      on: passedTerminal(),
    },
  ]));
  const partial = stepOf(chained, "partial");
  assert.equal(partial.assignments.minimum, 2);
  assert.equal(partial.assignments.target, 2);
  assert.equal(partial.assignments.maximum, 2);
  assert.equal(partial.assignments.maxParallel, 2);

  const paired = compile(document([
    {
      id: "as-agent",
      kind: "agent",
      agent: "planner",
      on: { passed: "as-moa" },
    },
    {
      id: "as-moa",
      kind: "moa",
      agent: "planner",
      on: passedTerminal(),
    },
  ]));
  assert.equal(canonical(stepOf(paired, "as-agent").assignments), canonical(stepOf(paired, "as-moa").assignments));
  assert.equal(canonical(stepOf(paired, "as-agent").join), canonical(stepOf(paired, "as-moa").join));

  const policy = compile(document([
    {
      id: "work",
      kind: "agent",
      agent: "implementer",
      on: { passed: "check" },
    },
    {
      id: "check",
      kind: "gate",
      gate: "test",
      assignments: { minimum: 2, target: 2, maximum: 2, maxParallel: 1 },
      join: { strategy: "all-settled", minimumPassed: 2 },
      on: { passed: "sign" },
    },
    {
      id: "sign",
      kind: "approval",
      on: passedTerminal(),
    },
  ]));
  const gate = stepOf(policy, "check");
  assert.equal(gate.kind, "gate");
  assert.deepEqual([...gate.assignments.allowedAgents], []);
  assert.equal(gate.assignments.minimum, 2);
  assert.equal(gate.assignments.target, 2);
  assert.equal(gate.assignments.maximum, 2);
  assert.equal(gate.assignments.maxParallel, 1);
  assert.deepEqual(gate.join, { strategy: "all-settled", minimumPassed: 2 });
  assert.equal("agent" in gate, false);
  assert.equal("signal" in gate, false);
  const approval = stepOf(policy, "sign");
  assert.deepEqual([...approval.assignments.allowedAgents], []);
  assert.equal(approval.assignments.minimum, 1);
  assert.equal(approval.assignments.target, 1);
  assert.equal(approval.assignments.maximum, 1);
  assert.equal(approval.assignments.maxParallel, 1);
  assert.deepEqual(approval.join, { strategy: "all" });

  const stray = compile(document([
    {
      id: "check",
      kind: "gate",
      gate: "test",
      agent: "planner",
      on: passedTerminal(),
    },
  ]));
  const strayGate = stepOf(stray, "check");
  assert.deepEqual([...strayGate.assignments.allowedAgents], ["planner"]);
  assert.equal("agent" in strayGate, false);
});

test("terminal edges preserve a declared maxTransitions and omit an absent one", () => {
  const plan = compile(document([
    {
      id: "done",
      kind: "approval",
      on: {
        passed: terminal("completed", { maxTransitions: 4 }),
        cancelled: terminal("cancelled"),
      },
    },
  ]));
  const step = stepOf(plan, "done");
  const passed = step.transitions.passed;
  const cancelled = step.transitions.cancelled;
  assert.ok(passed && cancelled);
  assert.equal(passed.to, "terminal");
  assert.equal(cancelled.to, "terminal");
  if (passed.to === "terminal") assert.equal(passed.maxTransitions, 4);
  if (cancelled.to === "terminal") assert.equal("maxTransitions" in cancelled, false);
});

test("unknown transition target names the step and outcome", () => {
  const issues = issuesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: { passed: "missing" } },
  ]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "transition_target_unknown");
  assert.equal(issues[0]?.stepId, "plan");
  assert.equal(issues[0]?.outcome, "passed");
});

test("$terminal requires a valid status and step targets reject one", () => {
  assert.deepEqual(codesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: { passed: { target: "$terminal" } } },
  ])), ["transition_terminal_status_missing"]);
  assert.deepEqual(codesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: { passed: terminal("exploded") } },
  ])), ["transition_terminal_status_invalid"]);
  const unexpected = issuesOf(document([
    {
      id: "plan",
      kind: "agent",
      agent: "planner",
      on: { passed: { target: "ready", terminalStatus: "completed" } },
    },
    { id: "ready", kind: "agent", agent: "planner", on: passedTerminal() },
  ]));
  assert.equal(unexpected[0]?.code, "transition_terminal_status_unexpected");
  assert.equal(unexpected[0]?.stepId, "plan");
  assert.equal(unexpected[0]?.outcome, "passed");
});

test("back edges require per-edge and global transition budgets", () => {
  const unboundedEdge = issuesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: { passed: "work" } },
    { id: "work", kind: "agent", agent: "planner", on: { failed: "plan", passed: terminal("completed") } },
  ], { limits: { maxTransitions: 4 } }));
  assert.equal(unboundedEdge[0]?.code, "back_edge_unbounded");
  assert.equal(unboundedEdge[0]?.stepId, "work");
  assert.equal(unboundedEdge[0]?.outcome, "failed");

  const unboundedCycle = issuesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: { passed: "work" } },
    {
      id: "work",
      kind: "agent",
      agent: "planner",
      on: { failed: { target: "plan", maxTransitions: 2 }, passed: terminal("completed") },
    },
  ]));
  assert.deepEqual(unboundedCycle.map((issue) => issue.code), ["workflow_cycle_unbounded"]);
});

test("duplicate, empty, and unsupported workflow envelopes fail closed", () => {
  assert.ok(codesOf({ schema: "kxm.workflow.v1", steps: [] }).includes("steps_empty"));
  assert.ok(codesOf({ schema: "other.workflow.v1", steps: [
    { id: "plan", kind: "agent", agent: "planner", on: passedTerminal() },
  ] }).includes("workflow_schema_unsupported"));
  assert.equal(issuesOf(document([
    { id: "Plan", kind: "agent", agent: "planner", on: passedTerminal() },
  ]))[0]?.code, "step_id_invalid");
  const duplicate = issuesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: passedTerminal() },
    { id: "plan", kind: "agent", agent: "planner", on: passedTerminal() },
  ]));
  assert.equal(duplicate[0]?.code, "step_id_duplicate");
  assert.equal(duplicate[0]?.stepId, "plan");
  assert.equal(issuesOf(document([
    { id: "plan", kind: "agent", agent: "planner" },
  ]))[0]?.code, "transitions_missing");
});

test("kind workflow is reserved and unknown kinds are rejected", () => {
  assert.deepEqual([...KXM_RESERVED_STEP_KINDS], ["workflow"]);
  const reserved = issuesOf(document([
    { id: "nested", kind: "workflow", on: passedTerminal() },
  ]));
  assert.equal(reserved[0]?.code, "step_kind_reserved");
  assert.match(reserved[0]?.message ?? "", /not yet supported/);
  const unknown = issuesOf(document([
    { id: "plan", kind: "pipeline", on: passedTerminal() },
  ]));
  assert.equal(unknown[0]?.code, "step_kind_unknown");
});

test("kind-required fields are mandatory", () => {
  assert.equal(issuesOf(document([
    { id: "plan", kind: "agent", on: passedTerminal() },
  ]))[0]?.code, "step_agent_missing");
  assert.equal(issuesOf(document([
    { id: "check", kind: "gate", on: passedTerminal() },
  ]))[0]?.code, "step_gate_missing");
  assert.equal(issuesOf(document([
    { id: "wait", kind: "wait", on: passedTerminal() },
  ]))[0]?.code, "step_signal_missing");
});

test("evidence, oracle, and plan-hash references fail closed", () => {
  assert.equal(issuesOf(document([
    {
      id: "plan",
      kind: "agent",
      agent: "planner",
      requiredEvidence: [
        { key: "plan", kind: "artifact" },
        { key: "plan", kind: "artifact" },
      ],
      on: passedTerminal(),
    },
  ]))[0]?.code, "evidence_key_duplicate");
  assert.equal(issuesOf(document([
    { id: "plan", kind: "agent", agent: "planner", requiredEvidence: [{ key: "plan", kind: "artifact" }], on: passedTerminal() },
  ], { reproOracle: { stageId: "missing", evidenceKey: "plan" } }))[0]?.code, "oracle_stage_unknown");
  assert.equal(issuesOf(document([
    { id: "plan", kind: "agent", agent: "planner", requiredEvidence: [{ key: "plan", kind: "artifact" }], on: passedTerminal() },
  ], { reproOracle: { stageId: "plan", evidenceKey: "diff" } }))[0]?.code, "oracle_evidence_unknown");
  assert.equal(issuesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: passedTerminal() },
  ], { requirePlanHash: ["implement"] }))[0]?.code, "plan_hash_stage_unknown");
});

test("independent faults are collected and sorted by step, outcome, then code", () => {
  const issues = issuesOf(document([
    { id: "beta", kind: "agent", agent: "planner", on: { passed: "missing" } },
    { id: "alpha", kind: "agent", on: passedTerminal() },
  ]));
  assert.deepEqual(issues.map((issue) => issue.code), ["step_agent_missing", "transition_target_unknown"]);
  assert.deepEqual(issues.map((issue) => issue.stepId), ["alpha", "beta"]);
  assert.equal(issues[1]?.outcome, "passed");
});

test("numeric domains split count, cost, and duration", () => {
  assert.ok(codesOf(document([
    { id: "plan", kind: "agent", agent: "planner", maxAttempts: 1.5, on: passedTerminal() },
  ])).includes("count_invalid"));
  assert.ok(codesOf(document([
    { id: "plan", kind: "agent", agent: "planner", timeoutMs: -1, on: passedTerminal() },
  ])).includes("duration_invalid"));
  assert.ok(codesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: passedTerminal() },
  ], { limits: { maxModelCost: 0 } })).includes("cost_invalid"));
  assert.ok(codesOf(document([
    { id: "plan", kind: "agent", agent: "planner", on: passedTerminal() },
  ], { limits: { maxTransitions: 2.2 } })).includes("count_invalid"));
});

test("compile module has no I/O or runtime-store value imports", () => {
  const api = new API({ cwd: process.cwd() });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [resolve(repoRoot, "tsconfig.json")] });
    const project = snapshot.getProjects()[0];
    assert.ok(project);
    const sourceFile = project.program.getSourceFile(compileModulePath);
    assert.ok(sourceFile, "compile module AST is missing");
    const specifiers: Array<{ specifier: string; typeOnly: boolean }> = [];
    const visit = (node: Node): void => {
      const candidate = node as Node & {
        moduleSpecifier?: { text?: string };
        importClause?: { isTypeOnly?: boolean };
        isTypeOnly?: boolean;
      };
      if (is.isImportDeclaration(node) && candidate.moduleSpecifier?.text) {
        specifiers.push({
          specifier: candidate.moduleSpecifier.text,
          typeOnly: candidate.importClause?.isTypeOnly === true,
        });
      }
      visitEachChild(node, (child) => {
        visit(child);
        return child;
      });
    };
    visit(sourceFile as Node);
    assert.deepEqual(specifiers, [{ specifier: "./project-config.ts", typeOnly: true }]);
    const banned = ["node:fs", "node:child_process", "node:net", "./runtime-store.ts", "./runtime-service.ts"];
    for (const specifier of specifiers) {
      assert.equal(banned.includes(specifier.specifier), false, `banned import ${specifier.specifier}`);
    }
  } finally {
    api.close();
  }
});
