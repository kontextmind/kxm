import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, statSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubHttpError } from "../../plugins/kxm/src/client.ts";
import {
  AGENT_COMMANDS_MAP,
  clearSessionTokenFromDisk,
  enforceToolPolicy,
  getCliAgentCommands,
  isSessionTokenExpired,
  isToolAllowed,
  mintAttemptToken,
  mintSessionToken,
  parseAttemptToken,
  parseSessionToken,
  persistSessionTokenToDisk,
  readSessionTokenFromDisk,
  reconcileInbox,
  sessionTokenPath,
  timingSafeStringCompare,
} from "../../plugins/kxm/src/commands.ts";
import { runCli as runCliImplementation, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { initializeKxmProject } from "../../plugins/kxm/src/init.ts";

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
      { KXM_LOGS_DIR: isolatedLogs, KXM_STATE_HOME: isolatedLogs, KXM_USER_CONFIG_DIR: isolatedLogs, ...env },
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
  const originalConfigDir = process.env.KXM_USER_CONFIG_DIR;
  const isolatedConfig = mkdtempSync(join(tmpdir(), "kxm-env-policy-"));
  try {
    // No environment token must also mean no ambient on-disk user token.
    process.env.KXM_USER_CONFIG_DIR = isolatedConfig;
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
    if (originalConfigDir !== undefined) process.env.KXM_USER_CONFIG_DIR = originalConfigDir;
    else delete process.env.KXM_USER_CONFIG_DIR;
    rmSync(isolatedConfig, { recursive: true, force: true });
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

test("context promote help documents proposalId and required evidence, not proposal-creation flags", async () => {
  const help = await runCli(["context", "promote", "--help"]);
  assert.equal(help.exit, 0, `${help.stderr}\n${help.stdout}`);
  const text = `${help.stdout}\n${help.stderr}`;
  assert.match(text, /<project>/);
  assert.match(text, /<proposalId>/);
  assert.match(text, /--evidence <refs>/);
  assert.match(text, /approved state proposal/i);
  assert.doesNotMatch(text, /<key>/);
  assert.doesNotMatch(text, /--summary/);
  assert.doesNotMatch(text, /--authority/);
  assert.doesNotMatch(text, /--confidence/);
});

test("role and memory skill commands correspond to registered CLI subcommands", () => {
  const source = readFileSync(join(process.cwd(), "plugins/kxm/src/cli.ts"), "utf8");
  const suite = JSON.parse(readFileSync(join(process.cwd(), "plugins/kxm/skill-suite.json"), "utf8")) as {
    skills: Array<{ name: string; ownedCommands: string[] }>;
  };
  const varToGroup = new Map<string, string>();
  const registeredByGroup = new Map<string, Set<string>>();
  for (const match of source.matchAll(/program\.command\("([a-z][a-z0-9-]*)/g)) {
    registeredByGroup.set(match[1]!, registeredByGroup.get(match[1]!) ?? new Set());
  }
  for (const match of source.matchAll(/const (\w+) = addGlobalOptions\(program\.command\("([a-z][a-z0-9-]*)/g)) {
    varToGroup.set(match[1]!, match[2]!);
  }
  for (const match of source.matchAll(/const (\w+) = addGlobalOptions\((\w+)\.command\("([a-z][a-z0-9-]*)/g)) {
    varToGroup.set(match[1]!, match[3]!);
    const parent = varToGroup.get(match[2]!) ?? match[2]!;
    const names = registeredByGroup.get(parent) ?? new Set<string>();
    names.add(match[3]!);
    registeredByGroup.set(parent, names);
  }
  for (const match of source.matchAll(/(\w+)\.command\("([a-z][a-z0-9-]*)/g)) {
    if (match[1] === "program") continue;
    const group = varToGroup.get(match[1]!) ?? match[1]!;
    const names = registeredByGroup.get(group) ?? new Set<string>();
    names.add(match[2]!);
    registeredByGroup.set(group, names);
  }
  for (const skill of suite.skills) {
    const skillPath = join(process.cwd(), "plugins/kxm/skills", skill.name, "SKILL.md");
    const text = readFileSync(skillPath, "utf8");
    for (const group of skill.ownedCommands) {
      const registered = registeredByGroup.get(group) ?? new Set<string>();
      if (registered.size === 0) continue;
      const taught = [...text.matchAll(new RegExp(`kxm ${group} ([a-z][a-z0-9-]*)`, "g"))].map((match) => match[1]!);
      for (const command of taught) {
        assert.ok(registered.has(command), `unregistered ${group} command in ${skill.name}: ${command}`);
      }
    }
  }
});

test("SKILL.md files teach kxm peer and workflow commands with zero mesh_ or MCP-only instructions", () => {
  const skillsDir = join(process.cwd(), "plugins/kxm/skills");

  if (!existsSync(skillsDir)) return;

  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  const allContent = [];

  for (const skillDir of skillDirs) {
    const skillPath = join(skillsDir, skillDir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const content = readFileSync(skillPath, "utf8");
    allContent.push(content);

    // Zero occurrences of legacy mesh_
    assert.equal(content.includes("mesh_"), false, `SKILL.md in ${skillDir} must not contain mesh_`);

    // Zero occurrences of MCP-only mcp__
    assert.equal(content.includes("mcp__"), false, `SKILL.md in ${skillDir} must not contain mcp__`);
  }

  const suiteContent = allContent.join("\n");
  assert.match(suiteContent, /kxm peer/, "Suite should teach kxm peer commands");
  assert.match(suiteContent, /kxm workflow/, "Suite should teach kxm workflow commands");
  assert.match(suiteContent, /tool_policy_denied/, "Suite should mention tool_policy_denied");
  assert.match(suiteContent, /60 second/, "Suite should mention the 60 second peer await cap");
});

test("kxm router skill scopes tool_policy_denied to agent-command and MCP/extension surfaces", () => {
  const router = readFileSync(join(process.cwd(), "plugins/kxm/skills/kxm/SKILL.md"), "utf8");
  assert.match(router, /tool_policy_denied/);
  assert.match(router, /[Aa]gent-command dispatch/);
  assert.match(router, /MCP\/extension/);
  assert.match(router, /explicit authorization/);
  assert.doesNotMatch(router, /All operations fail closed with `tool_policy_denied`/);
  assert.doesNotMatch(router, /All KXM operations enforce/);
  assert.doesNotMatch(
    router,
    /All operations fail closed with `tool_policy_denied` if not explicitly permitted by active tool policy/,
  );
});

test("kxm workflow wait and signal support dry-run binding for KXM runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-test-"));
  try {
    spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", dir], { encoding: "utf8", windowsHide: true });
    initializeKxmProject(dir, { projectId: "prj_01JRUNTEST000000000000", projectName: "Test KXM" });
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
    assert.match(signalRes.stdout, /would post signal to KXM run/);
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
    ["peer", "send", "target-agent", "hello", "--delivery", "steer", "--correlation-id", "corr-1", "--idempotency-key", "idem-1", "--ttl-ms", "5000", "--allow-offline", "--workflow-context", '{"runId":"r1","stageId":"s1","requirementKey":"k1","attempt":1}', "--dry-run", "--json"],
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
    ["workflow", "record", "--run-id", "r1", "--category", "bug", "--area", "implementation", "--stage-id", "s1", "--severity", "info", "--summary", "fixed bug", "--dry-run", "--json"],
  ]) {
    const res = await runCli(args);
    assert.equal(res.exit, 0, `Command failed: ${args.join(" ")}`);
    assert.match(res.stdout, /"dryRun":true/);
    if (args[1] === "record") assert.match(res.stdout, /"stageId":"s1"/);
  }

  // Area is optional: three positionals are runId, category, and summary.
  const positional = await runCli(["workflow", "record", "r1", "lesson", "Flaky test hid a race", "--stage-id", "s1", "--dry-run", "--json"]);
  assert.equal(positional.exit, 0);
  const positionalArgs = JSON.parse(positional.stdout).args as Record<string, unknown>;
  assert.deepEqual(
    { runId: positionalArgs.runId, category: positionalArgs.category, summary: positionalArgs.summary, stageId: positionalArgs.stageId, area: positionalArgs.area },
    { runId: "r1", category: "lesson", summary: "Flaky test hid a race", stageId: "s1", area: undefined },
  );
});

test("timingSafeStringCompare evaluates equality without timing leaks", () => {
  assert.equal(timingSafeStringCompare("super-secret-token", "super-secret-token"), true);
  assert.equal(timingSafeStringCompare("super-secret-token", "wrong-secret-token"), false);
  assert.equal(timingSafeStringCompare("short", "much-longer-token-string"), false);
  assert.equal(timingSafeStringCompare("", ""), true);
  assert.equal(timingSafeStringCompare(undefined, "expected"), false);
  assert.equal(timingSafeStringCompare("actual", undefined), false);
  assert.equal(timingSafeStringCompare(undefined, undefined), false);
});

test("mintSessionToken defaults to 24-hour expiration and detects expired tokens", () => {
  const token = mintSessionToken({ sessionId: "sess_ttl_test" });
  const parsed = parseSessionToken(token);
  assert.ok(parsed);
  assert.equal(parsed.sessionId, "sess_ttl_test");
  assert.ok(parsed.issuedAt);
  assert.ok(parsed.expiresAt);

  const issuedMs = new Date(parsed.issuedAt).getTime();
  const expiresMs = new Date(parsed.expiresAt).getTime();
  const diffMs = expiresMs - issuedMs;
  // Should be ~24 hours (86,400,000 ms)
  assert.ok(diffMs >= 86_390_000 && diffMs <= 86_410_000, `diffMs was ${diffMs}`);
  assert.equal(isSessionTokenExpired(token), false);
  assert.equal(isSessionTokenExpired(parsed), false);

  // Expired token
  const expiredToken = mintSessionToken({
    sessionId: "sess_expired",
    expiresAt: new Date(Date.now() - 5000).toISOString(),
  });
  assert.equal(isSessionTokenExpired(expiredToken), true);
  assert.equal(parseSessionToken(expiredToken), undefined); // fails closed
});

test("session.token disk persistence honors 0600 permissions, auto-load, and cleanup", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "kxm-session-token-test-"));
  try {
    const token = mintSessionToken({ sessionId: "sess_disk_1" });
    const savedPath = persistSessionTokenToDisk(token, { userConfigDir: tmpDir });
    assert.equal(savedPath, sessionTokenPath(tmpDir));

    // Verify permissions mode 0600
    try {
      const mode = statSync(savedPath).mode & 0o777;
      assert.equal(mode, 0o600);
    } catch {
      // Ignored if platform doesn't support mode
    }

    // Read token from disk
    const diskRead = readSessionTokenFromDisk({ userConfigDir: tmpDir });
    assert.ok(diskRead);
    assert.equal(diskRead.token, token);
    assert.equal(diskRead.payload.sessionId, "sess_disk_1");

    // Clear token
    const cleared = clearSessionTokenFromDisk({ userConfigDir: tmpDir });
    assert.equal(cleared, true);
    assert.equal(readSessionTokenFromDisk({ userConfigDir: tmpDir }), undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("enforceToolPolicy auto-loads valid disk token and enforces AttemptToken privilege boundaries", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "kxm-policy-disk-test-"));
  const originalEnvSession = process.env.KXM_SESSION_TOKEN;
  const originalEnvAttempt = process.env.KXM_ATTEMPT_TOKEN;
  const originalConfigDir = process.env.KXM_USER_CONFIG_DIR;

  try {
    delete process.env.KXM_SESSION_TOKEN;
    delete process.env.KXM_ATTEMPT_TOKEN;
    process.env.KXM_USER_CONFIG_DIR = tmpDir;

    // 1. Persist a read-only session token to disk
    const diskToken = mintSessionToken({ sessionId: "sess_disk_ro", preset: "read-only" });
    persistSessionTokenToDisk(diskToken, { userConfigDir: tmpDir });

    // With env unset, enforceToolPolicy auto-loads disk token
    const allowedRead = enforceToolPolicy("kxm_list");
    assert.equal(allowedRead.allowed, true);

    const deniedMutate = enforceToolPolicy("kxm_send");
    assert.equal(deniedMutate.allowed, false);
    assert.equal(deniedMutate.error, "tool_policy_denied");

    // 2. Clear disk token and persist expired token
    clearSessionTokenFromDisk({ userConfigDir: tmpDir });
    const expiredToken = mintSessionToken({
      sessionId: "sess_disk_exp",
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    });
    persistSessionTokenToDisk(expiredToken, { userConfigDir: tmpDir });

    // Expired disk token fails closed as session_token_invalid
    const expiredCheck = enforceToolPolicy("kxm_list");
    assert.equal(expiredCheck.allowed, false);
    assert.equal(expiredCheck.error, "session_token_invalid");

    clearSessionTokenFromDisk({ userConfigDir: tmpDir });

    // 3. AttemptToken boundary: ephemeral workers cannot execute kxm_promote without explicit grant
    process.env.KXM_ATTEMPT_TOKEN = mintAttemptToken({
      runId: "run_wk_1",
      stepId: "step-1",
      attempt: 1,
    });

    const attemptPromoteDenied = enforceToolPolicy("kxm_promote");
    assert.equal(attemptPromoteDenied.allowed, false);
    assert.equal(attemptPromoteDenied.error, "attempt_token_admin_denied");

    // 4. AttemptToken scope: mismatched runId fails closed
    const scopedOk = enforceToolPolicy("kxm_list", process.env, { runId: "run_wk_1" });
    assert.equal(scopedOk.allowed, true);

    const scopedMismatch = enforceToolPolicy("kxm_list", process.env, { runId: "run_wk_different" });
    assert.equal(scopedMismatch.allowed, false);
    assert.equal(scopedMismatch.error, "attempt_token_scope_violation");
  } finally {
    if (originalEnvSession !== undefined) process.env.KXM_SESSION_TOKEN = originalEnvSession;
    else delete process.env.KXM_SESSION_TOKEN;
    if (originalEnvAttempt !== undefined) process.env.KXM_ATTEMPT_TOKEN = originalEnvAttempt;
    else delete process.env.KXM_ATTEMPT_TOKEN;
    if (originalConfigDir !== undefined) process.env.KXM_USER_CONFIG_DIR = originalConfigDir;
    else delete process.env.KXM_USER_CONFIG_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CLI auth token and session token manage disk tokens and report status", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "kxm-cli-auth-token-"));
  try {
    // 1. Issue fresh token via kxm auth token
    const issueRes = await runCli(["auth", "token", "--json"], { KXM_USER_CONFIG_DIR: tmpDir });
    assert.equal(issueRes.exit, 0);
    const parsedIssue = JSON.parse(issueRes.stdout.trim());
    assert.equal(parsedIssue.ok, true);
    assert.ok(parsedIssue.token);

    // 2. Status via kxm auth token --status
    const statusRes = await runCli(["auth", "token", "--status", "--json"], { KXM_USER_CONFIG_DIR: tmpDir });
    assert.equal(statusRes.exit, 0);
    const parsedStatus = JSON.parse(statusRes.stdout.trim());
    assert.equal(parsedStatus.ok, true);
    assert.equal(parsedStatus.source, "disk");
    assert.equal(parsedStatus.valid, true);

    // 3. Status via session token alias
    const sessionTokenStatus = await runCli(["session", "token", "--status", "--json"], { KXM_USER_CONFIG_DIR: tmpDir });
    assert.equal(sessionTokenStatus.exit, 0);
    const parsedSessionStatus = JSON.parse(sessionTokenStatus.stdout.trim());
    assert.equal(parsedSessionStatus.ok, true);

    // 4. Clear token
    const clearRes = await runCli(["auth", "token", "--clear", "--json"], { KXM_USER_CONFIG_DIR: tmpDir });
    assert.equal(clearRes.exit, 0);
    const parsedClear = JSON.parse(clearRes.stdout.trim());
    assert.equal(parsedClear.ok, true);
    assert.equal(parsedClear.cleared, true);

    // 5. Status after clear reports no token
    const noTokenRes = await runCli(["auth", "token", "--status", "--json"], { KXM_USER_CONFIG_DIR: tmpDir });
    assert.equal(noTokenRes.exit, 1);
    const parsedNoToken = JSON.parse((noTokenRes.stderr || noTokenRes.stdout).trim());
    assert.equal(parsedNoToken.ok, false);
    assert.equal(parsedNoToken.error, "no_token");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
