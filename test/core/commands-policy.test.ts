import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubHttpError } from "../../plugins/kxm/src/client.ts";
import {
  AGENT_COMMANDS_MAP,
  enforceToolPolicy,
  getCliAgentCommands,
  isToolAllowed,
  mintAttemptToken,
  mintSessionToken,
  parseAttemptToken,
  parseSessionToken,
  reconcileInbox,
} from "../../plugins/kxm/src/commands.ts";
import { runCli as runCliImplementation, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { initializeVnextProject } from "../../plugins/kxm/src/vnext-init.ts";

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

test("token parsing and pattern matching error branches fail safely", () => {
  assert.equal(getCliAgentCommands().length, 19);
  assert.equal(parseAttemptToken("not-base64"), undefined);
  assert.equal(parseAttemptToken(Buffer.from("not json").toString("base64url")), undefined);
  assert.equal(parseAttemptToken(Buffer.from(JSON.stringify({ notSchema: 1 })).toString("base64url")), undefined);
  assert.equal(parseSessionToken("not-base64"), undefined);
  assert.equal(parseSessionToken(Buffer.from("not json").toString("base64url")), undefined);
  assert.equal(parseSessionToken(Buffer.from(JSON.stringify({ notSchema: 1 })).toString("base64url")), undefined);

  // Wildcard tool matching
  assert.equal(isToolAllowed("kxm_custom", { allow: ["kxm_*"] }), true);
  assert.equal(isToolAllowed("kxm_custom", { allow: ["other_*"] }), false);
  assert.equal(isToolAllowed("kxm_custom", { deny: ["kxm_*"] }), false);
  assert.equal(isToolAllowed("kxm_custom", { allow: ["*"] }), true);
});

test("workflowContext validation enforces integer attempts between 1 and 20", async () => {
  const sendCmd = AGENT_COMMANDS_MAP.get("kxm_send")!;
  assert.ok(sendCmd);

  const mockClient = {
    async send() {
      return { id: "m1", status: "delivered", toName: "agent-2" };
    },
  };

  // Missing required parameters
  await assert.rejects(async () => {
    await sendCmd.execute(mockClient as any, {});
  }, /target is required/);

  await assert.rejects(async () => {
    await sendCmd.execute(mockClient as any, { target: "t" });
  }, /content is required/);

  // Invalid attempts
  await assert.rejects(async () => {
    await sendCmd.execute(mockClient as any, {
      target: "t",
      content: "c",
      workflowContext: { runId: "r", stageId: "s", requirementKey: "k", attempt: 0 },
    });
  }, /must be an integer between 1 and 20/);

  await assert.rejects(async () => {
    await sendCmd.execute(mockClient as any, {
      target: "t",
      content: "c",
      workflowContext: { runId: "r", stageId: "s", requirementKey: "k", attempt: 21 },
    });
  }, /must be an integer between 1 and 20/);

  await assert.rejects(async () => {
    await sendCmd.execute(mockClient as any, {
      target: "t",
      content: "c",
      workflowContext: { runId: "r", stageId: "s", requirementKey: "k", attempt: 1.5 },
    });
  }, /must be an integer between 1 and 20/);

  // Valid attempt succeeds
  const res = await sendCmd.execute(mockClient as any, {
    target: "t",
    content: "c",
    workflowContext: { runId: "r", stageId: "s", requirementKey: "k", attempt: 2 },
  });
  assert.deepEqual(res, { messageId: "m1", status: "delivered", target: "agent-2" });
});

test("inbox reconciliation and reply handle terminal statuses and error branches", async () => {
  const inbox = new Map<string, any>();
  const notifiedInbox = new Set<string>();

  inbox.set("msg_replied", { id: "msg_replied", status: "pending" });
  inbox.set("msg_cancelled", { id: "msg_cancelled", status: "pending" });
  inbox.set("msg_expired", { id: "msg_expired", status: "pending" });
  inbox.set("msg_error", { id: "msg_error", status: "pending" });
  inbox.set("msg_active", { id: "msg_active", status: "pending" });
  inbox.set("msg_not_found", { id: "msg_not_found", status: "pending" });

  notifiedInbox.add("msg_replied");
  notifiedInbox.add("msg_not_found");

  const mockClient = {
    async getMessage(id: string) {
      if (id === "msg_replied") return { id, status: "replied" };
      if (id === "msg_cancelled") return { id, status: "cancelled" };
      if (id === "msg_expired") return { id, status: "expired" };
      if (id === "msg_error") return { id, status: "error" };
      if (id === "msg_active") return { id, status: "delivered" };
      if (id === "msg_not_found") {
        const err = new Error("not found") as any;
        err.name = "HubHttpError";
        err.statusCode = 404;
        err.code = "message_not_found";
        Object.setPrototypeOf(err, HubHttpError.prototype);
        throw err;
      }
      throw new Error("unexpected id");
    },
  };

  await reconcileInbox(mockClient as any, inbox, notifiedInbox);
  assert.equal(inbox.has("msg_replied"), false);
  assert.equal(inbox.has("msg_cancelled"), false);
  assert.equal(inbox.has("msg_expired"), false);
  assert.equal(inbox.has("msg_error"), false);
  assert.equal(inbox.has("msg_not_found"), false);
  assert.equal(inbox.has("msg_active"), true);
  assert.equal(notifiedInbox.has("msg_replied"), false);
  assert.equal(notifiedInbox.has("msg_not_found"), false);

  // kxm_inbox and kxm_reply with execution context
  const inboxCmd = AGENT_COMMANDS_MAP.get("kxm_inbox")!;
  const replyCmd = AGENT_COMMANDS_MAP.get("kxm_reply")!;

  const listed = await inboxCmd.execute(mockClient as any, {}, { inbox, notifiedInbox }) as { messages: any[] };
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].id, "msg_active");

  const emptyInbox = await inboxCmd.execute(mockClient as any, {}) as { messages: any[] };
  assert.deepEqual(emptyInbox.messages, []);

  // kxm_reply deletes from context inbox
  const mockReplyClient = {
    async reply(id: string, content: string) {
      return { id, status: "replied", fromName: "sender" };
    },
  };
  const replyRes = await replyCmd.execute(mockReplyClient as any, { messageId: "msg_active", content: "ok" }, { inbox, notifiedInbox });
  assert.deepEqual(replyRes, { messageId: "msg_active", status: "replied", recipient: "sender" });
  assert.equal(inbox.has("msg_active"), false);
});

test("CLI subcommands and options parse thoroughly in dry-run mode", async () => {
  // Invalid payload JSON
  const badPayload = await runCli(["peer", "list", "--payload", "bad-json", "--dry-run", "--json"]);
  assert.equal(badPayload.exit, 2);
  assert.match(badPayload.stderr, /invalid_payload/);

  // Valid payload JSON
  const goodPayload = await runCli(["peer", "list", "--payload", '{"custom":"val"}', "--dry-run", "--json"]);
  assert.equal(goodPayload.exit, 0);
  assert.match(goodPayload.stdout, /"dryRun":true/);

  // All peer subcommands with options
  for (const args of [
    ["peer", "list", "--dry-run", "--json"],
    ["peer", "send", "target-agent", "hello", "--delivery", "steer", "--correlation-id", "corr-1", "--idempotency-key", "idem-1", "--ttl-ms", "5000", "--workflow-context", '{"runId":"r1","stageId":"s1","requirementKey":"k1","attempt":1}', "--dry-run", "--json"],
    ["peer", "get", "msg_1", "--dry-run", "--json"],
    ["peer", "await", "msg_1", "--timeout-ms", "3000", "--dry-run", "--json"],
    ["peer", "cancel", "msg_1", "--dry-run", "--json"],
    ["peer", "fanout", "--targets", "a,b", "--content", "hi", "--ttl-ms", "5000", "--timeout-ms", "3000", "--dry-run", "--json"],
    ["peer", "inbox", "--dry-run", "--json"],
    ["peer", "reply", "msg_1", "reply content", "--dry-run", "--json"],
  ]) {
    const res = await runCli(args);
    assert.equal(res.exit, 0, `Command failed: ${args.join(" ")}`);
    assert.match(res.stdout, /"dryRun":true/);
  }

  // Workflow agent subcommands with options
  for (const args of [
    ["workflow", "checkpoint", "--run-id", "r1", "--stage-id", "s1", "--status", "passed", "--summary", "checkpoint summary", "--evidence", '{"check":"pass"}', "--dry-run", "--json"],
    ["workflow", "record", "--run-id", "r1", "--category", "bug", "--area", "implementation", "--severity", "info", "--summary", "fixed bug", "--dry-run", "--json"],
  ]) {
    const res = await runCli(args);
    assert.equal(res.exit, 0, `Command failed: ${args.join(" ")}`);
    assert.match(res.stdout, /"dryRun":true/);
  }
});
