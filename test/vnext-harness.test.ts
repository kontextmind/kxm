import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadVnextProject, VnextConfigError } from "../plugins/kxm/src/vnext-config.ts";
import { initializeVnextProject } from "../plugins/kxm/src/vnext-init.ts";
import {
  BUILTIN_HARNESS_IDS,
  DEFAULT_HARNESS,
  formatHarnessInventory,
  planHarnessUpdate,
  probeHarnesses,
  runHarnessUpdate,
  type HarnessCommandResult,
} from "../plugins/kxm/src/vnext-harness.ts";
import { computeVnextResourcePermissionDiff } from "../plugins/kxm/src/vnext-permission.ts";

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

function runner(handlers: Record<string, HarnessCommandResult>): (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult {
  return (command, args) => {
    const key = [command, ...args].join(" ");
    return handlers[key] ?? { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" };
  };
}

test("builtin catalog defaults to headless Pi and lists known harnesses", () => {
  assert.equal(DEFAULT_HARNESS, "pi");
  assert.deepEqual([...BUILTIN_HARNESS_IDS], ["pi", "claude", "kimi", "codex", "gemini", "deepseek"]);
});

test("probe reports detect/auth without a preferences overlay", () => {
  const inventory = probeHarnesses({
    runCommand: runner({
      "pi --version": { ok: true, code: 0, stdout: "pi 0.84.4\n", stderr: "" },
      "pi auth check": { ok: true, code: 0, stdout: "ok\n", stderr: "" },
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": { ok: false, code: 1, stdout: "", stderr: "logged out" },
    }),
  });
  const pi = inventory.harnesses.find((entry) => entry.id === "pi");
  const claude = inventory.harnesses.find((entry) => entry.id === "claude");
  const kimi = inventory.harnesses.find((entry) => entry.id === "kimi");
  assert.equal(pi?.detected, true);
  assert.equal(pi?.authenticated, true);
  assert.equal(pi?.mode, "headless");
  assert.equal(claude?.detected, true);
  assert.equal(claude?.authenticated, false);
  assert.equal(kimi?.detected, false);
  assert.match(formatHarnessInventory(inventory), /default harness: pi/);
  assert(!JSON.stringify(inventory).includes("preferences"));
});

test("update plans native commands and dry-run does not spawn", () => {
  const inventory = probeHarnesses({
    runCommand: runner({
      "pi --version": { ok: true, code: 0, stdout: "pi\n", stderr: "" },
      "pi auth check": { ok: true, code: 0, stdout: "ok\n", stderr: "" },
    }),
  });
  const planned = planHarnessUpdate(inventory, { scope: "all" });
  assert(planned.some((step) => step.harness === "pi" && step.scope === "self" && step.args.includes("--self")));
  assert(planned.some((step) => step.harness === "pi" && step.scope === "extensions"));
  assert(planned.some((step) => step.harness === "pi" && step.scope === "models"));
  assert(planned.every((step) => step.harness !== "claude"), "absent harnesses are not updated");
  const dry = runHarnessUpdate(planned, { dryRun: true, runCommand: () => { throw new Error("spawned"); } });
  assert(dry.every((step) => step.outcome === "would"));
});

test("unknown harness update is skipped fail-closed", () => {
  const inventory = probeHarnesses({ runCommand: () => ({ ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" }) });
  const steps = planHarnessUpdate(inventory, { harness: "nope", scope: "self" });
  assert.equal(steps[0]?.detail, "unknown_harness");
});

test("omitted agent harness equals pi; unknown ids fail closed; claude is a customization", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-harness-config-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-harness-state-"));
  try {
    makeGitRoot(root);
    initializeVnextProject(root, { projectId: "prj_01JHARNESSTEST00000000000", projectName: "Harness", localStateRoot: stateRoot });
    const bundle = loadVnextProject(root);
    assert.equal(bundle.project.value.defaultHarness, "pi");
    const implementer = bundle.agents.get("implementer");
    assert.equal(implementer?.value.harness, undefined);

    writeFileSync(join(root, ".kxm", "agents", "implementer.yaml"), [
      "schema: kxm.agent.v1",
      "purpose: Implement the approved change within the declared repository scope.",
      "harness: nope",
      "tools:",
      "  preset: workspace-writer",
      "defaultRepositoryAccess: none",
      "repositories:",
      "  control: write",
      "network: provider-only",
      "resultSchema: kxm.assignment-result.v1",
      "",
    ].join("\n"));
    assert.throws(() => loadVnextProject(root), (error: unknown) => error instanceof VnextConfigError && error.issues.some((issue) => issue.code === "harness_unknown"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("changing harness away from pi is a permission expansion; explicit pi matches omit", () => {
  const base = { schema: "kxm.agent.v1", purpose: "x" };
  const same = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, harness: "pi" });
  assert.equal(same.filter((change) => change.field === "harness").length, 0);
  const expanded = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, harness: "claude" });
  assert.equal(expanded[0]?.field, "harness");
  assert.equal(expanded[0]?.direction, "expansion");
});
