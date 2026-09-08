import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { attributeAssignment, changeReport, writeCurrentPlan, COST_OBSERVATION_SCHEMA, observeAssignmentCost, runAssignment, witnessAssignment, type CostObservation } from "../../scripts/assignment-run.mjs";
import { makeGitRoot } from "../helpers/git-root.ts";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kxm-observe-")));
  const taskDir = join(root, "task-a");
  mkdirSync(taskDir);
  const source = join(root, "source.json");
  writeFileSync(source, '{"historical":"usage"}\n');
  const value: CostObservation = {
    schema: COST_OBSERVATION_SCHEMA, task_id: "task-a", assignment_id: "import-a", kind: "repair",
    route: { harness: "grok", provider: "xai", model: "grok-4.6", effort: "low" }, status: "failed",
    timing: { started_at: null, finished_at: null, latency_ms: null },
    usage: { input_tokens: 123, output_tokens: null, cache_read_tokens: 9999999999, cache_write_tokens: null,
      reasoning_tokens: null, context_tokens: null, token_basis: "cumulative", cost_basis: "provider-reported",
      cost_usd: 0.125, estimate_usd: null, partial: true },
    sources: [{ path: source, sha256: digest(readFileSync(source)) }], note: "PRIVATE_NOTE_$(touch sentinel)`touch sentinel`",
    accounting: { included: true, reason: "setup" }, cost_only: true, rework: true, rework_of: "historical-attempt",
  };
  return { root, taskDir, value, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const code = (wanted: string) => (error: unknown) => (error as { runnerCode?: string }).runnerCode === wanted;

for (const basis of ["provider-reported", "list", "unmetered", "unknown"] as const) {
  test(`cost-only ${basis} import preserves unknowns, estimates and large cumulative counts`, async () => {
    const f = fixture();
    try {
      f.value.usage.cost_basis = basis;
      f.value.usage.cost_usd = basis === "provider-reported" ? 0.125 : null;
      f.value.usage.estimate_usd = ["list", "unmetered"].includes(basis) ? 1.23 : null;
      const result = observeAssignmentCost({ taskDir: f.taskDir, observation: f.value });
      assert.deepEqual(read(result.path), f.value);
      assert.equal(digest(readFileSync(result.path)), result.sha256);
      assert.equal(JSON.stringify(result).includes("PRIVATE_NOTE"), false);
      if (process.platform !== "win32") assert.equal(statSync(result.path).mode & 0o777, 0o600);
      const dir = join(f.taskDir, f.value.assignment_id);
      assert.deepEqual(readdirSync(dir), ["cost-observation.json"]);
      await assert.rejects(() => witnessAssignment(dir), code("completion_missing"));
      assert.equal(existsSync(join(dir, "completion.json")), false);
    } finally { f.cleanup(); }
  });
}

test("immutable imports reject duplicate identity, duplicate sources and symlink reservations", () => {
  const f = fixture();
  try {
    const result = observeAssignmentCost({ taskDir: f.taskDir, observation: f.value });
    const bytes = readFileSync(result.path);
    assert.throws(() => observeAssignmentCost({ taskDir: f.taskDir, observation: f.value }), code("identity_taken"));
    assert.throws(() => observeAssignmentCost({ taskDir: f.taskDir, observation: { ...f.value, assignment_id: "other" } }), code("source_already_recorded"));
    assert.equal(existsSync(join(f.taskDir, "other")), false);
    symlinkSync(join(f.root, "absent"), join(f.taskDir, "rival"));
    assert.throws(() => observeAssignmentCost({ taskDir: f.taskDir, observation: { ...f.value, assignment_id: "rival" } }), code("identity_taken"));
    assert.deepEqual(readFileSync(result.path), bytes);
  } finally { f.cleanup(); }
});

test("malformed and foreign imports refuse before consuming identity", () => {
  const f = fixture();
  try {
    const changes = [
      (v: CostObservation) => { v.task_id = "foreign"; },
      (v: CostObservation) => { v.assignment_id = "../escape"; },
      (v: CostObservation) => { v.sources = []; },
      (v: CostObservation) => { v.sources[0]!.sha256 = "0".repeat(64); },
      (v: CostObservation) => { v.sources[0]!.path = "relative"; },
      (v: CostObservation) => { v.usage.input_tokens = -1; },
      (v: CostObservation) => { v.usage.cost_basis = "unmetered"; },
      (v: CostObservation) => { delete (v.usage as Partial<CostObservation["usage"]>).partial; },
      (v: CostObservation) => { Object.assign(v, { critic: { verdict: "PASS" } }); },
      (v: CostObservation) => { v.accounting = { included: false, reason: "" }; },
    ];
    for (const change of changes) {
      const value = structuredClone(f.value); change(value);
      assert.throws(() => observeAssignmentCost({ taskDir: f.taskDir, observation: value }));
      assert.deepEqual(readdirSync(f.taskDir), []);
    }
    rmSync(f.value.sources[0]!.path);
    assert.throws(() => observeAssignmentCost({ taskDir: f.taskDir, observation: f.value }), code("source_invalid"));
    assert.deepEqual(readdirSync(f.taskDir), []);
  } finally { f.cleanup(); }
});

test("attribution retains private immutable history and hash-bound latest, without changing its subject", () => {
  const f = fixture();
  try {
    f.value.accounting = { included: false, reason: "separately shipped platform pause" };
    const cost = observeAssignmentCost({ taskDir: f.taskDir, observation: f.value });
    const before = readFileSync(cost.path);
    const recordDir = join(f.taskDir, f.value.assignment_id);
    const first = attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "unclassified", explanation: f.value.note });
    const second = attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "orchestration", explanation: "confirmed input access" });
    const history = join(recordDir, "attribution", "history");
    assert.equal(readdirSync(history).length, 2);
    const firstBytes = readFileSync(join(history, `${first.id}.json`));
    assert.equal(digest(firstBytes), first.sha256);
    const secondValue = read(join(history, `${second.id}.json`));
    assert.deepEqual(secondValue.previous, { id: first.id, sha256: first.sha256 });
    assert.deepEqual(read(join(recordDir, "attribution", "latest.json")), second);
    assert.equal(JSON.stringify(first).includes("PRIVATE_NOTE"), false);
    assert.deepEqual(readFileSync(cost.path), before);
    assert.throws(() => attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "pass", explanation: "no" }), code("attribution_invalid"));
    assert.equal(readdirSync(history).length, 2);
    writeFileSync(join(history, `${second.id}.json`), "{}");
    assert.throws(() => attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "model", explanation: "no" }), code("history_conflict"));
  } finally { f.cleanup(); }
});

test("unsafe attribution history and lock collisions cannot overwrite foreign files", () => {
  const f = fixture();
  try {
    observeAssignmentCost({ taskDir: f.taskDir, observation: f.value });
    const recordDir = join(f.taskDir, f.value.assignment_id);
    const elsewhere = join(f.root, "elsewhere"); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(recordDir, "attribution"), "dir");
    const request = { taskDir: f.taskDir, recordDir, classification: "model", explanation: "private" };
    assert.throws(() => attributeAssignment(request), code("history_conflict"));
    assert.deepEqual(readdirSync(elsewhere), []);
    rmSync(join(recordDir, "attribution"));
    mkdirSync(join(f.taskDir, ".observation-lock"));
    assert.throws(() => attributeAssignment(request), code("history_conflict"));
    assert.equal(existsSync(join(recordDir, "attribution")), false);
  } finally { f.cleanup(); }
});

async function nativeFixture(f: ReturnType<typeof fixture>, mode: "completion" | "refusal" | "incomplete") {
  const cwd = join(f.root, "repo"); mkdirSync(cwd); makeGitRoot(cwd);
  writeFileSync(join(cwd, "README.md"), "repo\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "init");
  const manifest = { schema: "kxm.assignment.v1", task_id: "task-a", assignment_id: "native", kind: "plan",
    harness: "claude", model: "fable", effort: "low", permission: "read-only", cwd, task_dir: f.taskDir,
    base: { kind: "clean", commit: git("rev-parse", "HEAD") }, plan_ref: { kind: "bootstrap", reason: "fixture" }, inputs: [],
    contract: { boundary: "fixture", deliverables: [], witness: { id: "verify" }, deferred: [] }, output_dir: "native/output" };
  if (mode === "refusal") Object.assign(manifest, { extra: "invalid" });
  try { await runAssignment(manifest, { runHarness: async () => { throw new Error("fake provider failure"); } }); }
  catch (error) { if (mode !== "refusal") throw error; }
  const recordDir = join(f.taskDir, "native");
  if (mode === "incomplete") rmSync(join(recordDir, "completion.json"));
  return recordDir;
}

for (const mode of ["completion", "refusal", "incomplete"] as const) {
  test(`attribute ${mode} records without changing native facts or minting telemetry`, async () => {
    const f = fixture();
    try {
      const recordDir = await nativeFixture(f, mode);
      const files = readdirSync(recordDir).filter((name) => statSync(join(recordDir, name)).isFile());
      const before = files.map((name) => [name, digest(readFileSync(join(recordDir, name)))]);
      attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "environment", explanation: "private failure" });
      assert.deepEqual(files.map((name) => [name, digest(readFileSync(join(recordDir, name)))]), before);
      const source = join(recordDir, "manifest.json");
      f.value.sources = [{ path: source, sha256: digest(readFileSync(source)) }];
      assert.throws(() => observeAssignmentCost({ taskDir: f.taskDir, observation: f.value }), code("source_already_recorded"));
      const record = join(recordDir, mode === "completion" ? "completion.json" : mode === "refusal" ? "refusal.json" : "pre-dispatch.json");
      const changed = read(record); changed.task_id = "foreign"; writeFileSync(record, JSON.stringify(changed));
      assert.throws(() => attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "model", explanation: "no" }), code("attribution_invalid"));
    } finally { f.cleanup(); }
  });
}

test("CLI keeps notes private and treats shell-looking file names as literal arguments", () => {
  const f = fixture();
  try {
    const input = join(f.root, "cost $(touch sentinel).json"); writeFileSync(input, JSON.stringify(f.value));
    const script = resolve("scripts/assignment-run.mjs");
    const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: f.root });
    const imported = cli("observe-cost", "--task-dir", f.taskDir, "--input", input);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.includes("PRIVATE_NOTE"), false);
    const note = join(f.root, "explanation `touch sentinel`.txt"); writeFileSync(note, f.value.note);
    const attributed = cli("attribute", "--task-dir", f.taskDir, "--record-dir", join(f.taskDir, "import-a"), "--class", "model", "--explanation-file", note);
    assert.equal(attributed.status, 0, attributed.stderr);
    assert.equal(attributed.stdout.includes("PRIVATE_NOTE"), false);
    assert.equal(existsSync(join(f.root, "sentinel")), false);
    writeFileSync(input, '{"PRIVATE_NOTE":');
    const bad = cli("observe-cost", "--task-dir", f.taskDir, "--input", input);
    assert.equal(bad.status, 1); assert.equal(bad.stderr.includes("PRIVATE_NOTE"), false);
  } finally { f.cleanup(); }
});

for (const mode of ["completion", "incomplete"] as const) {
  test(`historical ${mode} attribution survives a new plan and removed worktree`, async () => {
    const f = fixture();
    try {
      const recordDir = await nativeFixture(f, mode);
      // The original native bootstrap is immutable. A current plan appearing
      // later must not make its provenance ineligible for a handoff note.
      writeFileSync(join(f.taskDir, "plan-current.json"), JSON.stringify({ generation: 2 }));
      rmSync(join(f.root, "repo"), { recursive: true, force: true });
      const name = mode === "completion" ? "completion.json" : "pre-dispatch.json";
      const before = readFileSync(join(recordDir, name));
      attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "orchestration", explanation: "Handoff: include accessible input paths next time." });
      assert.deepEqual(readFileSync(join(recordDir, name)), before);
    } finally { f.cleanup(); }
  });
}

for (const invalid of ["output", "cwd"] as const) {
  test(`a ${invalid} validation refusal cannot poison later cost imports`, async () => {
    const f = fixture();
    try {
      const recordDir = await nativeFixture(f, "refusal");
      const original = read(join(recordDir, "manifest.json"));
      const manifest = { ...original, assignment_id: "refused-unsafe", output_dir: f.taskDir };
      delete manifest.extra;
      if (invalid === "cwd") { manifest.cwd = 42; manifest.output_dir = "refused-unsafe/output"; }
      await assert.rejects(() => runAssignment(manifest));
      assert.equal(existsSync(join(f.taskDir, "refused-unsafe", "refusal.json")), true);
      const imported = observeAssignmentCost({ taskDir: f.taskDir, observation: f.value });
      assert.equal(imported.cost_only, true);
    } finally { f.cleanup(); }
  });
}

test("external native output sources cannot be imported a second time", async () => {
  const f = fixture();
  try {
    const recordDir = await nativeFixture(f, "completion");
    const original = read(join(recordDir, "manifest.json"));
    const output = join(f.root, "native-external-output");
    await runAssignment({ ...original, assignment_id: "external", output_dir: output }, {
      runHarness: async () => { writeFileSync(join(output, "usage.json"), "native-cost"); throw new Error("fake native failure"); },
    });
    const path = join(output, "usage.json");
    f.value.sources = [{ path, sha256: digest(readFileSync(path)) }];
    assert.throws(() => observeAssignmentCost({ taskDir: f.taskDir, observation: f.value }), code("source_already_recorded"));
  } finally { f.cleanup(); }
});

test("legacy bootstrap manifests beside native records do not block explicit historical imports", async () => {
  const f = fixture();
  try {
    await nativeFixture(f, "completion");
    for (const [id, value] of [
      ["old-bootstrap", { schema: "kxm.bootstrap-assignment.v1", task_id: "task-a", assignment_id: "task-a/old-bootstrap" }],
      ["old-shape", { schema: "kxm.assignment.v1", task_id: "task-a", assignment_id: "task-a/old-shape" }],
      ["old-unschematized", { task_id: "task-a", assignment_id: "old-unschematized" }],
    ] as const) {
      const dir = join(f.taskDir, id); mkdirSync(dir); writeFileSync(join(dir, "manifest.json"), JSON.stringify(value));
    }
    assert.equal(observeAssignmentCost({ taskDir: f.taskDir, observation: f.value }).cost_only, true);
  } finally { f.cleanup(); }
});

test("change report separates excluded costs, estimates, unknowns and elapsed time", () => {
  const f = fixture();
  try {
    f.value.timing = { started_at: "2026-09-06T00:00:00.000Z", finished_at: "2026-09-06T00:00:01.000Z", latency_ms: 750 };
    observeAssignmentCost({ taskDir: f.taskDir, observation: f.value });
    const excluded = structuredClone(f.value); excluded.assignment_id = "excluded";
    const path = join(f.root, "excluded-source"); writeFileSync(path, "excluded-source");
    excluded.sources = [{ path, sha256: digest(readFileSync(path)) }];
    excluded.accounting = { included: false, reason: "PRIVATE_NOTE separate platform" };
    excluded.usage.cost_basis = "unmetered"; excluded.usage.cost_usd = null; excluded.usage.estimate_usd = 19;
    observeAssignmentCost({ taskDir: f.taskDir, observation: excluded });
    const unknown = structuredClone(f.value); unknown.assignment_id = "unknown";
    const unknownPath = join(f.root, "unknown-source"); writeFileSync(unknownPath, "unknown-source");
    unknown.sources = [{ path: unknownPath, sha256: digest(readFileSync(unknownPath)) }];
    unknown.usage.cost_basis = "unknown"; unknown.usage.cost_usd = null;
    unknown.timing.latency_ms = null;
    observeAssignmentCost({ taskDir: f.taskDir, observation: unknown });
    mkdirSync(join(f.taskDir, "nested")); mkdirSync(join(f.taskDir, "nested", "invisible"));
    writeFileSync(join(f.taskDir, "nested", "invisible", "cost-observation.json"), JSON.stringify(f.value));
    const report = changeReport({ taskDir: f.taskDir });
    assert.equal(report.assignments.length, 3);
    assert.equal(report.totals.included, 2); assert.equal(report.totals.excluded, 1);
    assert.equal(report.totals.costs["provider-reported"].amount_usd.total, 0.125);
    assert.equal(report.totals.costs.unmetered.amount_usd.total, null);
    assert.equal(report.totals.costs.unknown.assignments, 1);
    assert.equal(report.totals.costs.unknown.amount_usd.total, null);
    assert.equal(report.totals.elapsed_ms, 1000);
    assert.equal(report.totals.summed_native_latency_ms.total, 750);
    assert.equal(report.totals.summed_native_latency_ms.unknown, 1);
    assert.equal(report.ranking, "not-ranked");
    assert.equal(report.orchestration_usage, "unavailable");
    assert.equal(JSON.stringify(report).includes("PRIVATE_NOTE"), false);
    assert.equal(report.assignments[0]!.usage.context_tokens, null);
    assert.ok(report.ignored.some((item) => item.name === "nested"));
  } finally { f.cleanup(); }
});

test("report retains native failure, all gate history, private attribution history and zero-call refusals", async () => {
  const f = fixture();
  try {
    const recordDir = await nativeFixture(f, "completion");
    const completion = readFileSync(join(recordDir, "completion.json"));
    const nativeManifest = read(join(recordDir, "manifest.json"));
    await assert.rejects(() => runAssignment({ ...nativeManifest, assignment_id: "refusal", output_dir: "refusal/output", invalid: true }));
    const missing = join(f.taskDir, "missing"); mkdirSync(missing);
    writeFileSync(join(missing, "manifest.json"), JSON.stringify({ ...nativeManifest, assignment_id: "missing", output_dir: "missing/output" }));
    const gate = (status: number) => ((command: string, args: readonly string[], options: object) => command === "npm"
      ? { status, signal: null, stdout: "fixture gate", stderr: "" } : spawnSync(command, args, options)) as typeof spawnSync;
    await witnessAssignment(recordDir, { spawnSync: gate(0) });
    await witnessAssignment(recordDir, { spawnSync: gate(1) });
    attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "unclassified", explanation: "PRIVATE_NOTE handoff" });
    attributeAssignment({ taskDir: f.taskDir, recordDir, classification: "environment", explanation: "confirmed cause" });
    rmSync(join(recordDir, "attribution", "latest.json"));
    const report = changeReport({ taskDir: f.taskDir });
    assert.equal(report.assignments.length, 3);
    const native = report.assignments.find((item) => item.assignment_id === "native")!;
    assert.equal(native.type, "native"); assert.equal(native.status, "failed");
    assert.equal(native.verification, "failed");
    assert.deepEqual(native.history.witnesses.map((item: { result: string }) => item.result).sort(), ["failed", "passed"]);
    assert.equal(native.history.attributions.length, 2);
    assert.ok(native.history.issues.includes("attribution_latest_missing"));
    assert.equal(report.totals.not_dispatched, 1);
    assert.equal(report.assignments.find((row) => row.type === "refusal")!.usage, null);
    assert.ok(report.assignments.some((row) => row.type === "missing-completion"));
    assert.deepEqual(readFileSync(join(recordDir, "completion.json")), completion);
    assert.equal(JSON.stringify(report).includes("PRIVATE_NOTE"), false);
  } finally { f.cleanup(); }
});

test("plan-current preserves prior plan and pointer bytes and rejects stale or conflicting history", () => {
  const f = fixture();
  try {
    const plan1 = join(f.root, "plan1.md"); writeFileSync(plan1, "# one\n");
    const plan2 = join(f.root, "plan2.md"); writeFileSync(plan2, "# two\n");
    const baseCommit = "a".repeat(40);
    const first = writeCurrentPlan({ taskDir: f.taskDir, plan: plan1, sha256: digest(readFileSync(plan1)), baseCommit, expectedGeneration: 0, settledDecisions: ["bounded scope"] });
    const originalPointer = readFileSync(join(f.taskDir, "plan-current.json"));
    assert.equal(first.generation, 1);
    const request = { taskDir: f.taskDir, plan: plan2, sha256: digest(readFileSync(plan2)), baseCommit, expectedGeneration: 1 };
    const second = writeCurrentPlan(request);
    assert.equal(second.generation, 2);
    assert.deepEqual(second.settled_decisions, ["bounded scope"]);
    assert.deepEqual(readFileSync(join(f.taskDir, "plan-history", "generation-1.json")), originalPointer);
    assert.deepEqual(readFileSync(join(f.taskDir, "plan-history", "generation-1.md")), readFileSync(plan1));
    const secondPointer = readFileSync(join(f.taskDir, "plan-current.json"));
    assert.throws(() => writeCurrentPlan(request), code("history_conflict"));
    assert.deepEqual(readFileSync(join(f.taskDir, "plan-current.json")), secondPointer);
    writeFileSync(plan2, "changed after pointer");
    assert.throws(() => writeCurrentPlan({ ...request, plan: plan1, sha256: digest(readFileSync(plan1)), expectedGeneration: 2 }), code("plan_ref_invalid"));
    assert.deepEqual(readFileSync(join(f.taskDir, "plan-current.json")), secondPointer);
  } finally { f.cleanup(); }
});

test("plan-current refuses unsafe sources, bad generations and history collisions without pointer changes", () => {
  const f = fixture();
  try {
    const plan = join(f.root, "plan.md"); writeFileSync(plan, "plan");
    const request = { taskDir: f.taskDir, plan, sha256: digest(readFileSync(plan)), baseCommit: "b".repeat(40), expectedGeneration: 0 };
    assert.throws(() => writeCurrentPlan({ ...request, sha256: "0".repeat(64) }), code("plan_ref_invalid"));
    assert.equal(existsSync(join(f.taskDir, "plan-current.json")), false);
    const link = join(f.root, "plan-link"); symlinkSync(plan, link);
    assert.throws(() => writeCurrentPlan({ ...request, plan: link }), code("plan_ref_invalid"));
    writeCurrentPlan(request);
    const before = readFileSync(join(f.taskDir, "plan-current.json"));
    assert.throws(() => writeCurrentPlan({ ...request, plan: join(f.taskDir, "plan-current.json"), sha256: digest(before), expectedGeneration: 1 }), code("plan_ref_invalid"));
    mkdirSync(join(f.taskDir, "plan-history"));
    writeFileSync(join(f.taskDir, "plan-history", "generation-1.md"), "rival");
    assert.throws(() => writeCurrentPlan({ ...request, expectedGeneration: 1 }), code("history_conflict"));
    assert.deepEqual(readFileSync(join(f.taskDir, "plan-current.json")), before);
    assert.equal(readFileSync(join(f.taskDir, "plan-history", "generation-1.md"), "utf8"), "rival");
  } finally { f.cleanup(); }
});

test("new just recipes pass literal arguments through the shell", () => {
  const recipes = readFileSync("justfile", "utf8");
  for (const name of ["assign", "witness", "attribute", "observe-cost", "accept", "plan-current", "change-report"]) {
    const match = new RegExp(`^${name}[^\\n]*\\n([^\\n]*)`, "m").exec(recipes);
    assert.ok(match, `${name} recipe present`);
    assert.match(match[1]!, /"\$1"/);
    assert.equal(match[1]!.includes("{{"), false);
  }
  const f = fixture();
  try {
    const plan = join(f.root, "plan $(touch sentinel).md"); writeFileSync(plan, "# plan\n");
    const runRecipe = (name: string, args: string[]) => {
      const body = new RegExp(`^${name}[^\\n]*\\n([^\\n]*)`, "m").exec(recipes)![1]!.trim().replace(/^@/, "");
      return spawnSync("sh", ["-c", body, name, ...args], { encoding: "utf8" });
    };
    const result = runRecipe("plan-current", [f.taskDir, plan, digest(readFileSync(plan)), "a".repeat(40), "0"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(join(f.taskDir, "plan-current.json")).generation, 1);
    assert.equal(existsSync(join(f.root, "sentinel")), false);
    const report = runRecipe("change-report", [f.taskDir]);
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(report.stdout).schema, "kxm.change-report.v1");
  } finally { f.cleanup(); }
});

test("report does not turn an unknown finish time into zero elapsed duration", () => {
  const f = fixture();
  try {
    f.value.timing.started_at = "2026-09-06T00:00:00.000Z";
    observeAssignmentCost({ taskDir: f.taskDir, observation: f.value });
    const report = changeReport({ taskDir: f.taskDir });
    assert.equal(report.totals.elapsed_ms, null);
    assert.equal(report.totals.elapsed_partial, true);
    assert.equal(report.totals.summed_native_latency_ms.total, null);
  } finally { f.cleanup(); }
});
