import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { KxmConfigError, loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
import {
  DEFAULT_HARNESS,
  type HarnessCommandResult,
  eligibleHarnesses,
  probeHarnesses,
} from "../../plugins/kxm/src/harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

interface WorkflowStep {
  id: string;
  on?: Record<string, string | { target?: string }>;
}

function targetsOf(step: WorkflowStep): string[] {
  const targets: string[] = [];
  for (const value of Object.values(step.on ?? {})) {
    if (typeof value === "string") targets.push(value);
    else if (value && typeof value.target === "string") targets.push(value.target);
  }
  return targets;
}

// Rule 1: A harness cannot declare a model it does not host
test("agent validation refuses harness and model as retired routing fields", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-harness-unhosted-"));
  try {
    cpSync(join(repoRoot, "examples/project"), root, { recursive: true });
    makeGitRoot(root);
    makeGitRoot(join(root, "repositories", "api"));
    makeGitRoot(join(root, "repositories", "web"));
    const agentFile = join(root, ".kxm", "agents", "critic-2.yaml");
    writeFileSync(agentFile, `${readFileSync(agentFile, "utf8").trimEnd()}\nharness: claude\nmodel:\n  profile: critic-grok\n`);
    assert.throws(
      () => loadKxmProject(root),
      (error: unknown) => {
        assert(error instanceof KxmConfigError, `expected KxmConfigError, received ${String(error)}`);
        return error.issues.some((i) => i.code === "retired_agent_routing_fields");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Rule 2: Eligibility selection over an inventory returns only authenticated harnesses and fails closed on empty set
test("eligibility selection over an inventory returns only authenticated harnesses and fails closed", () => {
  const runner = (calls: Record<string, HarnessCommandResult>) => (cmd: string, args: readonly string[]): HarnessCommandResult => {
    const key = [cmd, ...args].join(" ");
    return calls[key] ?? { ok: false, code: 1, stdout: "", stderr: "command not found" };
  };

  const inventory = probeHarnesses({
    runCommand: runner({
      "kimi --version": { ok: true, code: 0, stdout: "kimi 0.1\n", stderr: "" },
      "kimi provider list": {
        ok: true,
        code: 0,
        stdout: "managed:kimi-code  type=kimi  models=4  source=oauth\n\nDefault model: kimi-code/kimi-for-coding\n",
        stderr: "",
      },
      "gemini --version": { ok: true, code: 0, stdout: "gemini 0.1\n", stderr: "" },
      "deepseek --version": { ok: true, code: 0, stdout: "deepseek 0.1\n", stderr: "" },
    }),
  });

  const kimiStatus = inventory.harnesses.find((h) => h.id === "kimi");
  const geminiStatus = inventory.harnesses.find((h) => h.id === "gemini");
  const deepseekStatus = inventory.harnesses.find((h) => h.id === "deepseek");

  // Official CLI command probe authenticates kimi
  assert.equal(kimiStatus?.authenticated, true);
  // Gemini and deepseek report unknown
  assert.equal(geminiStatus, undefined);
  assert.equal(deepseekStatus?.authenticated, null);

  // Eligibility returns only authenticated harnesses
  const eligible = eligibleHarnesses(inventory);
  assert.deepEqual([...eligible], ["kimi"]);

  // Unknown and null are never eligible; fails closed on empty set
  const emptyInventory = {
    defaultHarness: DEFAULT_HARNESS as typeof DEFAULT_HARNESS,
    harnesses: [geminiStatus!, deepseekStatus!],
  };
  assert.throws(() => eligibleHarnesses(emptyInventory), /no_authenticated_harness/);
});

// Rule 3: verify precedes ready in this repository's own quick workflow (and workflow validation enforces it)
test("workflow validation enforces that verify precedes ready", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-workflow-verify-ready-"));
  try {
    cpSync(join(repoRoot, "examples/project"), root, { recursive: true });
    makeGitRoot(root);
    makeGitRoot(join(root, "repositories", "api"));
    makeGitRoot(join(root, "repositories", "web"));
    const workflowFile = join(root, ".kxm", "workflows", "default.yaml");
    // Modify default.yaml so implement points directly to ready, bypassing verify
    const content = readFileSync(workflowFile, "utf8").replace("passed: verify", "passed: ready");
    writeFileSync(workflowFile, content);
    assert.throws(
      () => loadKxmProject(root),
      (error: unknown) => {
        assert(error instanceof KxmConfigError, `expected KxmConfigError, received ${String(error)}`);
        return error.issues.some((i) => i.code === "verify_must_precede_ready");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default.yaml declared graph routes ready only through verify", () => {
  const workflow = parse(readFileSync(join(repoRoot, "examples/project/.kxm/workflows/default.yaml"), "utf8")) as {
    steps: WorkflowStep[];
  };
  const steps = workflow.steps;
  assert.equal(steps[0]?.id, "plan");
  const verify = steps.find((step) => step.id === "verify");
  const ready = steps.find((step) => step.id === "ready");
  assert(verify, "default.yaml must declare verify");
  assert(ready, "default.yaml must declare ready");
  assert(targetsOf(verify).includes("ready"), "verify must have an edge into ready");
  const incoming = steps.filter((step) => targetsOf(step).includes("ready")).map((step) => step.id);
  assert.deepEqual(incoming, ["verify"]);
  assert(!incoming.includes("plan"));
  assert(!incoming.includes("implement"));
});

