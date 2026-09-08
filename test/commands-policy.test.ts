import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_COMMANDS_MAP,
  enforceToolPolicy,
  isToolAllowed,
  mintAttemptToken,
  mintSessionToken,
  parseAttemptToken,
  parseSessionToken,
} from "../plugins/kxm/src/commands.ts";
import { runCli as runCliImplementation, type CliIo } from "../plugins/kxm/src/cli.ts";
import { initializeVnextProject } from "../plugins/kxm/src/vnext-init.ts";

function capture() {
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
}

async function runCli(argv: string[], env: NodeJS.ProcessEnv = {}, io?: CliIo, cwd = process.cwd()): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cap = capture();
  const actualIo = io ?? cap;
  const isolatedLogs = mkdtempSync(join(tmpdir(), "kxm-cli-policy-"));
  try {
    const exit = await runCliImplementation(
      argv,
      { KXM_LOGS_DIR: isolatedLogs, KXM_STATE_HOME: isolatedLogs, ...env },
      actualIo,
      cwd,
    );
    return { exit, ...cap.read() };
  } finally {
    rmSync(isolatedLogs, { recursive: true, force: true });
  }
}

test("attempt tokens and session tokens mint and parse accurately", () => {
  const attemptToken = mintAttemptToken({
    runId: "run_test_1",
    stageId: "stage_test_1",
    attempt: 1,
    allowedTools: ["kxm_list", "kxm_send"],
    deniedTools: ["kxm_workflow_checkpoint"],
  });

  const parsedAttempt = parseAttemptToken(attemptToken);
  assert.ok(parsedAttempt);
  assert.equal(parsedAttempt.runId, "run_test_1");
  assert.equal(parsedAttempt.stageId, "stage_test_1");
  assert.equal(parsedAttempt.attempt, 1);
  assert.deepEqual(parsedAttempt.toolPolicy?.allowedTools, ["kxm_list", "kxm_send"]);
  assert.deepEqual(parsedAttempt.toolPolicy?.deniedTools, ["kxm_workflow_checkpoint"]);

  const sessionToken = mintSessionToken({
    sessionId: "sess_test_1",
    agentName: "agent-1",
    preset: "read-only",
  });

  const parsedSession = parseSessionToken(sessionToken);
  assert.ok(parsedSession);
  assert.equal(parsedSession.sessionId, "sess_test_1");
  assert.equal(parsedSession.agentName, "agent-1");
  assert.equal(parsedSession.toolPolicy?.preset, "read-only");
});

test("isToolAllowed enforces explicit allowedTools, deniedTools, and read-only presets", () => {
  // Empty policy allows all tools
  assert.equal(isToolAllowed("kxm_send", {}), true);

  // Explicit allowedTools restricts to that set
  assert.equal(isToolAllowed("kxm_send", { allowedTools: ["kxm_list"] }), false);
  assert.equal(isToolAllowed("kxm_list", { allowedTools: ["kxm_list"] }), true);

  // Explicit deniedTools denies matching tools
  assert.equal(isToolAllowed("kxm_send", { deniedTools: ["kxm_send"] }), false);
  assert.equal(isToolAllowed("kxm_list", { deniedTools: ["kxm_send"] }), true);

  // read-only preset allows queries but denies mutations
  const readOnlyPolicy = { preset: "read-only" as const };
  assert.equal(isToolAllowed("kxm_list", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_get", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_inbox", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_workflow_list", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_workflow_get", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_improvement_report", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_context", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_recall", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_state", readOnlyPolicy), true);
  assert.equal(isToolAllowed("kxm_episode", readOnlyPolicy), true);

  assert.equal(isToolAllowed("kxm_send", readOnlyPolicy), false);
  assert.equal(isToolAllowed("kxm_reply", readOnlyPolicy), false);
  assert.equal(isToolAllowed("kxm_fanout", readOnlyPolicy), false);
  assert.equal(isToolAllowed("kxm_workflow_checkpoint", readOnlyPolicy), false);
  assert.equal(isToolAllowed("kxm_workflow_record", readOnlyPolicy), false);
  assert.equal(isToolAllowed("kxm_promote", readOnlyPolicy), false);
});

test("enforceToolPolicy reads KXM_ATTEMPT_TOKEN and fails closed with tool_policy_denied", () => {
  const originalAttempt = process.env.KXM_ATTEMPT_TOKEN;
  const originalSession = process.env.KXM_SESSION_TOKEN;
  try {
    delete process.env.KXM_ATTEMPT_TOKEN;
    delete process.env.KXM_SESSION_TOKEN;

    // Without tokens, all tools are permitted
    assert.equal(enforceToolPolicy("kxm_send").allowed, true);

    // With attempt token that denies kxm_send
    process.env.KXM_ATTEMPT_TOKEN = mintAttemptToken({
      runId: "r1",
      stageId: "s1",
      attempt: 1,
      deniedTools: ["kxm_send"],
    });

    const checkDenied = enforceToolPolicy("kxm_send");
    assert.equal(checkDenied.allowed, false);
    assert.equal(checkDenied.error, "tool_policy_denied");
    assert.match(checkDenied.detail ?? "", /denied by attempt tool policy/);

    const checkAllowed = enforceToolPolicy("kxm_list");
    assert.equal(checkAllowed.allowed, true);

    // With session token with read-only preset
    delete process.env.KXM_ATTEMPT_TOKEN;
    process.env.KXM_SESSION_TOKEN = mintSessionToken({
      sessionId: "s1",
      preset: "read-only",
    });

    const checkReadOnlyDenied = enforceToolPolicy("kxm_reply");
    assert.equal(checkReadOnlyDenied.allowed, false);
    assert.equal(checkReadOnlyDenied.error, "tool_policy_denied");
    assert.match(checkReadOnlyDenied.detail ?? "", /denied by session tool policy/);

    const checkReadOnlyAllowed = enforceToolPolicy("kxm_state");
    assert.equal(checkReadOnlyAllowed.allowed, true);
  } finally {
    if (originalAttempt !== undefined) process.env.KXM_ATTEMPT_TOKEN = originalAttempt;
    else delete process.env.KXM_ATTEMPT_TOKEN;
    if (originalSession !== undefined) process.env.KXM_SESSION_TOKEN = originalSession;
    else delete process.env.KXM_SESSION_TOKEN;
  }
});

test("peer await command strictly caps timeoutMs at 60,000 ms (60 seconds)", () => {
  const awaitCmd = AGENT_COMMANDS_MAP.get("kxm_await")!;
  assert.ok(awaitCmd);

  // Check parameter schema cap
  const timeoutProp = awaitCmd.parameters.properties.timeoutMs as { maximum: number; minimum: number };
  assert.equal(timeoutProp.maximum, 60_000);
  assert.equal(timeoutProp.minimum, 100);

  // Check execution clamping: mock client to inspect requested timeout
  let requestedTimeout: number | undefined;
  const mockClient = {
    async awaitResponse(_messageId: string, timeoutMs?: number) {
      requestedTimeout = timeoutMs;
      return { status: "pending" };
    },
  };

  // When timeoutMs is above 60,000, it clamps to 60,000
  awaitCmd.execute(mockClient as any, { messageId: "m1", timeoutMs: 120_000 });
  assert.equal(requestedTimeout, 60_000);

  // When timeoutMs is within bounds, it is preserved
  awaitCmd.execute(mockClient as any, { messageId: "m1", timeoutMs: 30_000 });
  assert.equal(requestedTimeout, 30_000);
});

test("kxm peer and workflow CLI commands fail closed when tool policy denies", async () => {
  const token = mintAttemptToken({
    runId: "run_cli_test",
    stageId: "stage_cli_test",
    attempt: 1,
    deniedTools: ["kxm_send", "kxm_workflow_checkpoint"],
  });

  const res = await runCli(["peer", "send", "other-agent", "hello", "--json"], {
    KXM_ATTEMPT_TOKEN: token,
  });

  assert.equal(res.exit, 1);
  assert.match(res.stderr, /tool_policy_denied/);
  const parsed = JSON.parse(res.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "tool_policy_denied");
});

test("SKILL.md teaches kxm peer and workflow commands with zero mesh_ or MCP-only instructions", () => {
  const skillPath = join(process.cwd(), "plugins/kxm/skills/kxm/SKILL.md");
  const content = readFileSync(skillPath, "utf8");

  // Zero occurrences of legacy mesh_
  assert.equal(content.includes("mesh_"), false, "SKILL.md must not contain mesh_");

  // Zero occurrences of MCP-only mcp__
  assert.equal(content.includes("mcp__"), false, "SKILL.md must not contain mcp__");

  // Teaches kxm peer and kxm workflow
  assert.match(content, /kxm peer/);
  assert.match(content, /kxm workflow/);
  assert.match(content, /tool_policy_denied/);
  assert.match(content, /60 second/);
});

test("kxm workflow wait and signal support dry-run binding for vNext runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-vnext-test-"));
  try {
    spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", dir], { encoding: "utf8", windowsHide: true });
    initializeVnextProject(dir, { projectId: "prj_01JRUNTEST000000000000", projectName: "Test vNext" });
    const fakeRunId = "run_0123456789abcdef0123456789abcdef";
    const waitRes = await runCli([
      "workflow", "wait",
      fakeRunId,
      "stage-1",
      "test-signal",
      "waiting for signal",
      "--dry-run",
      "--json",
    ], {}, undefined, dir);
    assert.equal(waitRes.exit, 0);
    assert.match(waitRes.stdout, /"dryRun":true/);

    const signalRes = await runCli([
      "workflow", "signal",
      fakeRunId,
      "test-signal",
      "passed",
      "signal summary",
      "--dry-run",
      "--json",
    ], {}, undefined, dir);
    assert.equal(signalRes.exit, 0);
    assert.match(signalRes.stdout, /would post signal to vNext run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
