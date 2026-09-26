import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdSuggest } from "../../plugins/kxm/src/cli/tasks.ts";
import type { Runtime } from "../../plugins/kxm/src/cli/types.ts";
import { probeHarnesses } from "../../plugins/kxm/src/harness.ts";
import { suggestWorkflowAndRoles } from "../../plugins/kxm/src/suggest.ts";

function inventory(claudeAuth: boolean | null = true) {
  return probeHarnesses({
    platform: "linux",
    env: {},
    runCommand: (command, args) => {
      const key = [command, ...args].join(" ");
      const stdout = key === "claude --version" ? "2.1.280\n"
        : key === "claude auth status" ? JSON.stringify(claudeAuth === null ? {} : { loggedIn: claudeAuth, authMethod: "claude.ai" })
        : key === "codex --version" ? "codex 0.1\n"
        : key === "codex login status" ? "Logged in using ChatGPT\n"
        : key === "grok --version" ? "1.1.0\n"
        : key === "grok models" ? "You are logged in with grok.com.\n"
        : undefined;
      return stdout === undefined
        ? { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" }
        : { ok: true, code: 0, stdout, stderr: "" };
    },
  });
}

function captureRuntime(cwd: string, dryRun = false) {
  let stdout = "";
  let stderr = "";
  const runtime: Runtime = {
    cwd,
    env: {},
    json: true,
    dryRun,
    io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    dirs: { workdir: cwd, workspace: cwd, config: cwd, logs: cwd, assets: cwd, state: cwd },
    serverUrl: "http://unused.invalid",
    fetchImpl: async () => { throw new Error("suggest must not call a hub"); },
  };
  return { runtime, read: () => ({ stdout, stderr }) };
}

test("suggest uses the probed Claude route exclusively for supported read-only work", () => {
  const availableHarnesses = inventory().harnesses;
  for (const constraint of ["using Claude only", "using only Claude Code", "Claude-only", "exclusively with Claude"]) {
    const suggestion = suggestWorkflowAndRoles(`Investigate an architecture spike ${constraint}`, { availableHarnesses });
    assert.equal(suggestion.template, "spec-and-plan");
    assert.deepEqual(suggestion.roles.map((role) => [role.agent, role.harness]), [["coordinator", "claude"]]);
    if (!suggestion.execution.supported) assert.fail(suggestion.execution.reason);
    assert.match(suggestion.execution.createCommand, /^kxm run architecture-spike -- /);
    assert.equal(suggestion.execution.driveCommand, "kxm runs drive <runId> --wait");
    assert.equal(suggestion.execution.statusCommand, "kxm runs status <runId>");
    assert.equal(suggestion.execution.receiptCommand, "kxm runs receipt <runId>");
  }
});

test("suggested creation command passes shell metacharacters and smart quotes as one literal prompt", () => {
  const prompt = "Investigate an architecture spike using Claude only '‘’‚‛; echo INJECTED; # $HOME $(echo expanded) `echo expanded`\nnext line";
  const suggestion = suggestWorkflowAndRoles(prompt, { availableHarnesses: inventory().harnesses });
  if (!suggestion.execution.supported) assert.fail(suggestion.execution.reason);
  const script = process.platform === "win32"
    ? `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); function kxm { ConvertTo-Json -Compress -InputObject @($args) }; ${suggestion.execution.createCommand}`
    : `kxm() { printf '%s' "$4"; }; ${suggestion.execution.createCommand}`;
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" })
    : spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  if (process.platform === "win32") {
    assert.deepEqual(JSON.parse(result.stdout), ["run", suggestion.workflowId, prompt]);
  } else {
    assert.equal(result.stdout, prompt);
  }
});

test("suggest refuses an unavailable required Claude harness instead of silently substituting Codex", () => {
  const availableHarnesses = inventory(false).harnesses;
  const constrained = suggestWorkflowAndRoles("Investigate an architecture spike using Claude only", { availableHarnesses });
  assert.equal(constrained.execution.supported, false);
  if (constrained.execution.supported) assert.fail("unauthenticated Claude must not be recommended");
  assert.equal(constrained.execution.error, "harness_unavailable");
  assert.deepEqual(constrained.roles, []);
  assert.equal("createCommand" in constrained.execution, false);
  assert.ok(constrained.execution.nextSteps.some((step) => step.includes("claude auth login")));

  const unconstrained = suggestWorkflowAndRoles("Investigate an architecture spike", { availableHarnesses });
  assert.equal(unconstrained.execution.supported, true);
  assert.deepEqual(unconstrained.roles.map((role) => role.harness), ["codex"]);
});

test("suggest exposes live writer admission and real verification prerequisites for an authenticated Grok writer", () => {
  const availableHarnesses = inventory().harnesses.filter((entry) => entry.id === "grok");
  const suggestion = suggestWorkflowAndRoles("Fix a bug in an isolated worktree", { availableHarnesses });
  assert.equal(suggestion.workflowId, "bug-fix");
  assert.equal(suggestion.template, "implement-and-verify");
  assert.deepEqual(suggestion.roles, [{ agent: "implementer", harness: "grok", role: "implement" }]);
  if (!suggestion.execution.supported) assert.fail(suggestion.execution.reason);
  assert.match(suggestion.execution.createCommand, /^kxm run bug-fix -- /);
  assert.equal(suggestion.execution.driveCommand, "kxm runs drive <runId> --wait");
  const prerequisites = suggestion.execution.prerequisites.join("\n");
  assert.match(prerequisites, /\.kxm\/agents\/implementer\.yaml/);
  assert.match(prerequisites, /harness grok/);
  assert.match(prerequisites, /role on/);
  assert.match(prerequisites, /\.kxm\/routes\.yaml/);
  assert.match(prerequisites, /assignments\.maximum: 1/);
  assert.match(prerequisites, /limits\.maxConcurrentRuns: 1/);
  assert.match(prerequisites, /\.kxm\/project\.yaml/);
  assert.match(prerequisites, /writer role roster/);
  assert.match(prerequisites, /status is admitted/);
  assert.match(prerequisites, /permissions contain edit/);
  assert.match(prerequisites, /\.kxm\/gates\.yaml/);
  assert.match(prerequisites, /kind: command.*argv/);
});

test("suggest refuses an unsupported selected writer and does not bypass missing writer authentication", () => {
  const availableHarnesses = inventory().harnesses;
  const codex = suggestWorkflowAndRoles("Fix a bug", {
    availableHarnesses: availableHarnesses.filter((entry) => entry.id === "codex"),
  });
  if (codex.execution.supported) assert.fail("Codex has no audited live writer profile");
  assert.equal(codex.execution.error, "live_write_unsupported");
  assert.deepEqual(codex.roles, []);
  assert.equal("createCommand" in codex.execution, false);

  const grok = availableHarnesses.find((entry) => entry.id === "grok")!;
  const unauthenticated = suggestWorkflowAndRoles("Fix a bug", {
    availableHarnesses: [{ ...grok, authenticated: false }],
  });
  if (unauthenticated.execution.supported) assert.fail("a writer profile does not bypass authentication");
  assert.equal(unauthenticated.execution.error, "harness_unavailable");
  assert.equal("createCommand" in unauthenticated.execution, false);
});

test("suggest refuses to drive an existing workflow whose routing has not been checked", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-suggest-existing-"));
  try {
    const file = join(root, ".kxm", "workflows", "architecture-spike.yml");
    mkdirSync(join(root, ".kxm", "workflows"), { recursive: true });
    const existing = "schema: kxm.workflow.v1\nsteps:\n  - id: inspect\n    kind: agent\n    agent: codex-reviewer\n    on:\n      passed:\n        target: $terminal\n        terminalStatus: completed\n";
    writeFileSync(file, existing);
    const captured = captureRuntime(root);
    assert.equal(await cmdSuggest(captured.runtime, ["Investigate an architecture spike using Claude only"], async () => inventory()), 1);
    const result = JSON.parse(captured.read().stderr);
    assert.equal(result.error, "workflow_already_exists");
    assert.deepEqual(result.roles, []);
    assert.equal("createCommand" in result.execution, false);
    assert.equal(readFileSync(file, "utf8"), existing);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("suggest never treats missing, empty, unknown-auth, absent, or blocked inventory as universal availability", () => {
  const claude = inventory().harnesses.find((entry) => entry.id === "claude")!;
  const inventories = [
    undefined,
    [],
    inventory(null).harnesses.filter((entry) => entry.id === "claude"),
    [{ ...claude, detected: false }],
    [{ ...claude, dispatch: { status: "no" as const, supported: false, reason: "permission_profile_unaudited" } }],
  ];
  for (const availableHarnesses of inventories) {
    const suggestion = suggestWorkflowAndRoles("Investigate an architecture spike using Claude only", { availableHarnesses });
    assert.equal(suggestion.execution.supported, false);
    if (suggestion.execution.supported) assert.fail("an unverified route cannot execute");
    assert.equal(suggestion.execution.error, "harness_unavailable");
    assert.deepEqual(suggestion.roles, []);
  }
});

test("suggest CLI preserves actual probe authentication and separates installation, creation, and live driving", async () => {
  const captured = captureRuntime(process.cwd());
  const code = await cmdSuggest(captured.runtime, ["Investigate an architecture spike using Claude only"], async () => inventory());
  assert.equal(code, 0, captured.read().stderr);
  const result = JSON.parse(captured.read().stdout);
  assert.equal(result.ok, true);
  assert.equal(result.suggestedCommand, "kxm workflow add architecture-spike --template spec-and-plan");
  assert.deepEqual(result.roles.map((role: { harness: string }) => role.harness), ["claude"]);
  assert.equal(result.execution.supported, true);
  assert.equal(result.execution.driveCommand, "kxm runs drive <runId> --wait");
});

test("suggest CLI refuses a Claude-only writer without substituting the available audited Grok writer", async () => {
  const captured = captureRuntime(process.cwd());
  const code = await cmdSuggest(captured.runtime, ["Fix a bug in an isolated worktree using Claude only"], async () => inventory());
  assert.equal(code, 1);
  assert.equal(captured.read().stdout, "");
  const result = JSON.parse(captured.read().stderr);
  assert.equal(result.ok, false);
  assert.equal(result.error, "live_write_unsupported");
  assert.equal(result.workflowId, "bug-fix");
  assert.deepEqual(result.roles, []);
  assert.equal("createCommand" in result.execution, false);
});

test("suggest dry-run skips native probes and leaves the worktree unchanged", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-suggest-dry-"));
  try {
    const captured = captureRuntime(cwd, true);
    let probes = 0;
    const code = await cmdSuggest(captured.runtime, ["Investigate an architecture spike using Claude only"], async () => {
      probes += 1;
      throw new Error("authentication probes may initialize native CLI state");
    });
    assert.equal(code, 1);
    assert.equal(probes, 0);
    assert.deepEqual(readdirSync(cwd), []);
    const result = JSON.parse(captured.read().stderr);
    assert.equal(result.dryRun, true);
    assert.equal(result.error, "harness_unavailable");
    assert.equal("createCommand" in result.execution, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
