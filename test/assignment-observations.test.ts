import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { attributeAssignment, COST_OBSERVATION_SCHEMA, observeAssignmentCost, runAssignment, witnessAssignment, type CostObservation } from "../scripts/assignment-run.mjs";
import { makeGitRoot } from "./helpers/git-root.ts";

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
