import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { mintSessionToken, persistSessionTokenToDisk } from "../../plugins/kxm/src/commands.ts";
import { workflowWebhookHeaders } from "../../plugins/kxm/src/workflow.ts";
import { HUB_ENV_SCHEMA, writeHubEnvRecord } from "../../plugins/kxm/src/hub-env.ts";
import { createTestMesh, waitFor } from "../helpers.ts";
import { isolatedMcpEnv, type IsolatedMcpEnvOptions } from "../helpers/mcp-spawn.ts";

type RpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/** Spawn environment for one test: isolated from the developer's state, removed afterwards. */
function spawnEnvFor(context: TestContext, options: IsolatedMcpEnvOptions = {}) {
  const spawnEnv = isolatedMcpEnv(options);
  context.after(spawnEnv.cleanup);
  return spawnEnv;
}

/** Start dist/mcp-server.js over stdio with an isolated environment and complete the MCP
 * handshake. Every spawn in this file goes through here. */
async function startMcpServer(
  context: TestContext,
  spawnEnv: { env: NodeJS.ProcessEnv; cwd: string },
  clientName = "kxm-mcp-test",
) {
  const child = spawn(process.execPath, [resolve("plugins/kxm/dist/mcp-server.js")], {
    cwd: spawnEnv.cwd,
    env: spawnEnv.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const notifications: Array<Record<string, unknown>> = [];
  const pending = new Map<number, { resolve(value: RpcResponse): void; reject(error: Error): void }>();
  let nextId = 1;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as RpcResponse & { method?: string };
    if (typeof message.id !== "number") {
      notifications.push(message as Record<string, unknown>);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message);
  });
  child.once("exit", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`MCP server exited with ${String(code)}: ${stderr}`));
    }
    pending.clear();
  });

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    lines.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill();
    await exited;
  }
  context.after(stop);

  function request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = nextId++;
    const response = new Promise<RpcResponse>((resolveResponse, reject) => pending.set(id, { resolve: resolveResponse, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  function tool(name: string, args: Record<string, unknown> = {}): Promise<RpcResponse> {
    return request("tools/call", { name, arguments: args });
  }

  function text(response: RpcResponse): string {
    const content = response.result?.content as Array<{ type: string; text: string }>;
    return content[0]!.text;
  }

  function value(response: RpcResponse): Record<string, unknown> {
    return JSON.parse(text(response)) as Record<string, unknown>;
  }

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: clientName, version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { child, initialized, notifications, request, tool, text, value, stop, stderr: () => stderr };
}

test("bundled MCP server initializes and publishes the mesh tool catalog", async (context) => {
  const server = await startMcpServer(context, spawnEnvFor(context), "pi-mesh-test");
  assert.equal(server.initialized.result?.protocolVersion, "2025-06-18");
  assert.deepEqual(server.initialized.result?.capabilities, {
    experimental: { "claude/channel": {} },
    tools: {},
  });

  const listed = await server.request("tools/list", {});
  const tools = listed.result?.tools as Array<{
    name: string;
    description: string;
    inputSchema: { properties: Record<string, Record<string, unknown>> };
  }>;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "kxm_list",
      "kxm_send",
      "kxm_get",
      "kxm_fanout",
      "kxm_await",
      "kxm_cancel",
      "kxm_inbox",
      "kxm_reply",
      "kxm_workflow_list",
      "kxm_workflow_get",
      "kxm_workflow_checkpoint",
      "kxm_workflow_record",
      "kxm_workflow_wait",
      "kxm_improvement_report",
      "kxm_context",
      "kxm_recall",
      "kxm_state",
      "kxm_episode",
      "kxm_promote",
    ],
  );
  const sendTool = tools.find((tool) => tool.name === "kxm_send")!;
  assert.deepEqual(
    (sendTool.inputSchema.properties.workflowContext!.required as string[]),
    ["runId", "stageId", "requirementKey", "attempt"],
  );
  assert.match(
    String(sendTool.inputSchema.properties.idempotencyKey!.description),
    /not a workflow security or evidence binding/,
  );
  const checkpointTool = tools.find((tool) => tool.name === "kxm_workflow_checkpoint")!;
  const evidenceRefValue = checkpointTool.inputSchema.properties.evidenceRefs!.additionalProperties as {
    properties: { messageIds: { maxItems: number } };
  };
  assert.equal(evidenceRefValue.properties.messageIds.maxItems, 16);
  assert.equal(server.stderr(), "");
});

test("bundled MCP tools cover outbound, inbound, reply, cancellation, and channel delivery", async (context) => {
  const webhookSecret = "mcp-webhook-secret-value";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "mcp-workflow",
      source: "generic",
      project: "test-project",
      target: "claude-under-test",
      secret: webhookSecret,
      delivery: "followUp",
      promptTemplate: "Handle {{task.id}}",
      stages: [{
        id: "work",
        label: "Work",
        instructions: "Do the work",
        requiredEvidence: ["checks"],
        maxAttempts: 2,
        evidencePolicies: {
          checks: {
            kind: "peer-reply",
            minProducers: 1,
            eligibleAgents: ["reviewer"],
            acceptedStatuses: ["replied"],
          },
        },
      }],
    }],
  });
  const peer = mesh.makeClient("reviewer");
  await peer.start(async (event) => {
    if (event.type !== "message") return;
    await peer.acknowledge(event.message.id);
    if (
      event.message.content === "review this"
      || event.message.content === "workflow provenance send"
      || event.message.content === "workflow provenance fanout"
    ) {
      await peer.reply(event.message.id, "review complete");
    }
  });

  const server = await startMcpServer(context, spawnEnvFor(context, {
    hubUrl: mesh.address.url,
    authToken: mesh.token,
    agentName: "claude-under-test",
    project: "test-project",
    extra: { KXM_AGENT_PURPOSE: "MCP integration test" },
  }), "live-test");
  const { notifications, tool } = server;
  const toolValue = server.value;

  const listed = toolValue(await tool("kxm_list"));
  assert.match(JSON.stringify(listed), /reviewer/);
  const sent = toolValue(await tool("kxm_send", {
    target: "reviewer",
    content: "review this",
    correlationId: "mcp-outbound",
    idempotencyKey: "mcp-send-1",
    ttlMs: 5_000,
  }));
  const outboundId = String(sent.messageId);
  const completed = toolValue(await tool("kxm_await", { messageId: outboundId, timeoutMs: 2_000 }));
  assert.equal((completed.reply as { content: string }).content, "review complete");
  assert.equal(toolValue(await tool("kxm_get", { messageId: outboundId })).status, "replied");
  const panel = toolValue(await tool("kxm_fanout", {
    targets: ["reviewer"],
    content: "review this",
    correlationId: "mcp-panel",
    idempotencyKeyPrefix: "mcp-panel",
    timeoutMs: 2_000,
  }));
  assert.match(JSON.stringify(panel), /review complete/);
  const pendingPanel = toolValue(await tool("kxm_fanout", {
    targets: ["reviewer"],
    content: "review after the local wait ends",
    correlationId: "mcp-panel-timeout",
    idempotencyKeyPrefix: "mcp-panel-timeout",
    ttlMs: 5_000,
    timeoutMs: 100,
  }));
  const [pendingResponse] = pendingPanel.responses as Array<Record<string, unknown>>;
  assert.equal(pendingResponse?.status, "pending");
  assert.equal(pendingResponse?.waitStatus, "timed_out");
  assert.ok(pendingResponse?.messageId);
  assert.ok(pendingResponse?.expiresAt);
  assert.ok(pendingResponse?.messageStatus === "queued" || pendingResponse?.messageStatus === "delivered");

  const cancellable = toolValue(await tool("kxm_send", { target: "reviewer", content: "cancel this" }));
  const cancelled = toolValue(await tool("kxm_cancel", { messageId: cancellable.messageId }));
  assert.equal(cancelled.status, "cancelled");

  const inbound = await peer.send({ target: "claude-under-test", content: "incoming review" });
  await waitFor(() => notifications.some((notification) => notification.method === "notifications/claude/channel"));
  const channel = notifications.find((notification) => notification.method === "notifications/claude/channel")!;
  assert.match(JSON.stringify(channel), /incoming review/);
  assert.match(JSON.stringify(channel), new RegExp(inbound.id));
  const inbox = toolValue(await tool("kxm_inbox"));
  assert.match(JSON.stringify(inbox), new RegExp(inbound.id));
  const replied = toolValue(await tool("kxm_reply", { messageId: inbound.id, content: "inbound complete" }));
  assert.equal(replied.status, "replied");
  assert.equal((await peer.awaitResponse(inbound.id, 2_000)).reply?.content, "inbound complete");
  assert.doesNotMatch(JSON.stringify(toolValue(await tool("kxm_inbox"))), new RegExp(inbound.id));

  const cancelledInbound = await peer.send({ target: "claude-under-test", content: "cancel incoming work" });
  await waitFor(async () => JSON.stringify(toolValue(await tool("kxm_inbox"))).includes(cancelledInbound.id));
  assert.equal((await peer.cancel(cancelledInbound.id)).status, "cancelled");
  await waitFor(async () => !JSON.stringify(toolValue(await tool("kxm_inbox"))).includes(cancelledInbound.id));

  const missedTerminalEvent = await peer.send({ target: "claude-under-test", content: "reconcile missed cancellation" });
  await waitFor(async () => JSON.stringify(toolValue(await tool("kxm_inbox"))).includes(missedTerminalEvent.id));
  const missedRecord = mesh.hub.state.messages.get(missedTerminalEvent.id)!;
  missedRecord.status = "cancelled";
  missedRecord.cancelledAt = new Date().toISOString();
  await waitFor(async () => !JSON.stringify(toolValue(await tool("kxm_inbox"))).includes(missedTerminalEvent.id));

  const expiredInbound = await peer.send({
    target: "claude-under-test",
    content: "expire incoming work",
    ttlMs: 1_000,
  });
  await waitFor(async () => JSON.stringify(toolValue(await tool("kxm_inbox"))).includes(expiredInbound.id));
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal((await peer.getMessage(expiredInbound.id)).status, "expired");
  await waitFor(async () => !JSON.stringify(toolValue(await tool("kxm_inbox"))).includes(expiredInbound.id));

  const workflowPayload = JSON.stringify({ event: "task", task: { id: "MCP-9" } });
  const webhook = await fetch(`${mesh.address.url}/v1/webhooks/mcp-workflow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...workflowWebhookHeaders({ secret: webhookSecret, scope: { definitionId: "mcp-workflow" }, deliveryId: "mcp-delivery-9", body: workflowPayload }),
    },
    body: workflowPayload,
  });
  const workflow = await webhook.json() as { run: { id: string; messageId: string } };
  await waitFor(async () => JSON.stringify(toolValue(await tool("kxm_inbox"))).includes(workflow.run.messageId));
  assert.match(JSON.stringify(toolValue(await tool("kxm_workflow_list"))), /mcp-workflow/);
  assert.match(JSON.stringify(toolValue(await tool("kxm_workflow_get", { runId: workflow.run.id }))), /in_progress/);
  const provenanceContext = {
    runId: workflow.run.id,
    stageId: "work",
    requirementKey: "checks",
    attempt: 1,
  };
  const provenanceSend = toolValue(await tool("kxm_send", {
    target: "reviewer",
    content: "workflow provenance send",
    correlationId: workflow.run.id,
    idempotencyKey: "mcp-workflow-provenance-send-1",
    workflowContext: provenanceContext,
  }));
  const provenanceSendId = String(provenanceSend.messageId);
  await tool("kxm_await", { messageId: provenanceSendId, timeoutMs: 2_000 });
  const provenanceMessage = toolValue(await tool("kxm_get", { messageId: provenanceSendId }));
  assert.equal(provenanceMessage.workflowRunId, workflow.run.id);
  assert.deepEqual(provenanceMessage.workflowContext, {
    schema: "pi-mesh.workflow-message-context.v1",
    ...provenanceContext,
  });
  const provenanceFanout = toolValue(await tool("kxm_fanout", {
    targets: ["reviewer"],
    content: "workflow provenance fanout",
    correlationId: workflow.run.id,
    idempotencyKeyPrefix: "mcp-workflow-provenance-fanout",
    workflowContext: provenanceContext,
    timeoutMs: 2_000,
  }));
  const [provenanceFanoutResult] = provenanceFanout.responses as Array<{ messageId: string }>;
  const provenanceFanoutMessage = toolValue(await tool("kxm_get", {
    messageId: provenanceFanoutResult!.messageId,
  }));
  assert.equal(provenanceFanoutMessage.workflowRunId, workflow.run.id);
  assert.deepEqual(provenanceFanoutMessage.workflowContext, {
    schema: "pi-mesh.workflow-message-context.v1",
    ...provenanceContext,
  });
  const recorded = toolValue(await tool("kxm_workflow_record", {
    runId: workflow.run.id,
    category: "lesson",
    area: "harness",
    severity: "warning",
    summary: "Keep the coordinator alive while work is queued",
    evidence: ["MCP-9"],
  }));
  assert.equal(recorded.category, "lesson");
  const invalidWait = await tool("kxm_workflow_wait", {
    runId: workflow.run.id,
    stageId: "work",
    signalKey: "external-check",
    summary: "Wait for external check",
    evidenceRefs: { checks: { messageIds: ["msg_missing_surface_reference"] } },
  });
  assert.equal(invalidWait.result?.isError, true);
  assert.match(JSON.stringify(invalidWait.result), /peer evidence message not found/);
  const checkpoint = toolValue(await tool("kxm_workflow_checkpoint", {
    runId: workflow.run.id,
    stageId: "work",
    status: "passed",
    summary: "Completed with checks",
    evidenceRefs: { checks: { messageIds: [provenanceSendId] } },
  }));
  assert.equal(checkpoint.completed, true);
  assert.match(JSON.stringify(toolValue(await tool("kxm_improvement_report"))), /harness/);
  assert.equal(toolValue(await tool("kxm_reply", {
    messageId: workflow.run.messageId,
    content: "workflow complete",
  })).status, "replied");

  const invalid = await tool("kxm_send", { content: "missing target" });
  assert.equal(invalid.result?.isError, true);
  assert.match(JSON.stringify(invalid.result), /target is required/);
  assert.equal(server.stderr(), "");
});

test("MCP inbox rehydrates one unacked message record after process restart", async (context) => {
  const mesh = await createTestMesh(context);
  const peer = mesh.makeClient("restart-sender");
  await peer.start(() => undefined);
  async function startMcp() {
    return await startMcpServer(context, spawnEnvFor(context, {
      hubUrl: mesh.address.url,
      authToken: mesh.token,
      agentName: "claude-restart-test",
      project: "test-project",
      extra: { KXM_AGENT_PURPOSE: "MCP restart integration test" },
    }), "restart-test");
  }

  const first = await startMcp();
  await first.tool("kxm_list");
  await waitFor(async () => (await peer.listAgents()).some((agent) => agent.name === "claude-restart-test"));
  await first.stop();

  const durableAgent = [...mesh.hub.state.agents.values()].find((agent) => agent.name === "claude-restart-test")!;
  durableAgent.online = true;
  const inbound = await peer.send({ target: "claude-restart-test", content: "resume this queued request" });
  assert.equal((await peer.getMessage(inbound.id)).status, "queued");
  durableAgent.online = false;

  const second = await startMcp();
  await second.tool("kxm_list");
  await waitFor(() => second.notifications.some((notification) => JSON.stringify(notification).includes(inbound.id)));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(second.notifications.filter((notification) => JSON.stringify(notification).includes(inbound.id)).length, 1);
  assert.match(JSON.stringify(second.value(await second.tool("kxm_inbox"))), new RegExp(inbound.id));
  const reply = second.value(await second.tool("kxm_reply", {
    messageId: inbound.id,
    content: "restart reply complete",
  }));
  assert.equal(reply.status, "replied");
  assert.equal((await peer.awaitResponse(inbound.id, 2_000)).reply?.content, "restart reply complete");
  assert.equal([...mesh.hub.state.messages.values()].filter((message) => message.id === inbound.id).length, 1);
  await second.stop();
});

test("isolated MCP spawn env points project dir, state, user config and hub URL at throwaway locations", (context) => {
  const leaked = {
    CLAUDE_PROJECT_DIR: process.cwd(),
    KXM_SESSION_TOKEN: "leaked-session-token",
    KXM_ATTEMPT_TOKEN: "leaked-attempt-token",
    KXM_PROJECT_TOKENS: JSON.stringify({ leaked: "leaked-project-token" }),
    KXM_AUTH_TOKEN: "leaked-auth-token",
  };
  const previous = Object.fromEntries(Object.keys(leaked).map((key) => [key, process.env[key]]));
  Object.assign(process.env, leaked);
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const plain = spawnEnvFor(context);
  assert.equal(plain.cwd, plain.env.KXM_PROJECT_DIR);
  for (const path of [plain.cwd, plain.env.KXM_STATE_HOME!, plain.env.KXM_USER_CONFIG_DIR!]) {
    assert.ok(path.startsWith(tmpdir()), `${path} is under the OS temp dir`);
    assert.equal(existsSync(path), true);
  }
  assert.equal(existsSync(join(plain.cwd, ".kxm")), false);
  assert.equal(plain.env.KXM_SERVER_URL, "http://127.0.0.1:1");
  for (const key of Object.keys(leaked)) assert.equal(plain.env[key], undefined, `${key} is not inherited`);

  const project = spawnEnvFor(context, { withKxmDir: true, authToken: "explicit-token" });
  assert.ok(project.cwd.startsWith(tmpdir()));
  assert.equal(existsSync(join(project.cwd, ".kxm")), true);
  assert.equal(existsSync(join(dirname(project.cwd), ".kxm")), false, "only the throwaway project dir gets .kxm");
  assert.equal(project.env.KXM_AUTH_TOKEN, "explicit-token");
});

test("every test that spawns dist/mcp-server.js uses the isolated spawn helper", () => {
  const testDir = fileURLToPath(new URL(".", import.meta.url));
  const spawners = readdirSync(testDir)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => /spawn\([^)]*mcp-server\.js/.test(readFileSync(join(testDir, file), "utf8")));
  assert.ok(spawners.includes("mcp.test.ts"), "the scan sees this file's spawn");
  assert.ok(spawners.includes("commands-drift.test.ts"), "the scan sees the drift test's spawn");
  for (const file of spawners) {
    assert.match(
      readFileSync(join(testDir, file), "utf8"),
      /import\s*\{[^}]*\bisolatedMcpEnv\b[^}]*\}\s*from\s*"\.\.\/helpers\/mcp-spawn\.ts"/,
      `${file} spawns dist/mcp-server.js without isolatedMcpEnv`,
    );
  }
});

test("MCP server never registers with the persisted admin token", async (context) => {
  const adminToken = "kxm_admin_mcp-must-not-use-this";
  const mesh = await createTestMesh(context, { authToken: adminToken });
  const spawnEnv = spawnEnvFor(context, {
    hubUrl: mesh.address.url,
    project: "test-project",
    agentName: "claude-admin-fallback",
  });
  writeHubEnvRecord({
    schema: HUB_ENV_SCHEMA,
    createdAt: "2026-09-23T00:00:00.000Z",
    authToken: adminToken,
    projectTokens: { "other-project": "other-project-token" },
  }, spawnEnv.env);
  const server = await startMcpServer(context, spawnEnv);

  const listed = await server.tool("kxm_list");
  assert.equal(listed.result?.isError, true);
  const text = server.text(listed);
  assert.match(text, /no project token for project test-project/);
  assert.match(text, /Ask the user/);
  assert.doesNotMatch(text, new RegExp(adminToken));
  assert.doesNotMatch(text, /other-project-token/);
  assert.equal([...mesh.hub.state.agents.values()].some((agent) => agent.name === "claude-admin-fallback"), false);
});

test("MCP tools send one hop past the open inbound requests, so the hub hop limit bounds a forwarding chain", async (context) => {
  const mesh = await createTestMesh(context);
  const upstream = mesh.makeClient("hop-upstream");
  const downstream = mesh.makeClient("hop-downstream");
  const forwarded: Array<{ hops: number; maxHops: number }> = [];
  await upstream.start(() => undefined);
  await downstream.start((event) => {
    if (event.type === "message") forwarded.push(event.message);
  });
  const server = await startMcpServer(context, spawnEnvFor(context, {
    hubUrl: mesh.address.url,
    authToken: mesh.token,
    agentName: "claude-hop-relay",
    project: "test-project",
  }));
  const forward = (content: string) => server.tool("kxm_send", { target: "hop-downstream", content });
  const receive = async (hops: number) => {
    const inbound = await upstream.send({ target: "claude-hop-relay", content: `relay at ${hops}`, hops, maxHops: 5 });
    await waitFor(async () => JSON.stringify(server.value(await server.tool("kxm_inbox"))).includes(inbound.id));
    return inbound.id;
  };

  // Handling nothing, a request starts a new chain.
  assert.notEqual((await forward("fresh")).result?.isError, true);
  await waitFor(() => forwarded.length === 1);
  assert.deepEqual([forwarded[0]!.hops, forwarded[0]!.maxHops], [0, 5]);

  // Handling a request three hops into a five-hop chain, the next request is hop four.
  await receive(3);
  assert.notEqual((await forward("forwarded")).result?.isError, true);
  await waitFor(() => forwarded.length === 2);
  assert.deepEqual([forwarded[1]!.hops, forwarded[1]!.maxHops], [4, 5]);

  // With a request at hop four also open, the furthest counts and one more forward is refused.
  const deeper = await receive(4);
  const refused = await forward("one too many");
  assert.equal(refused.result?.isError, true);
  assert.match(server.text(refused), /hop limit reached \(5\/5\)/);
  await server.tool("kxm_reply", { messageId: deeper, content: "answered directly" });
  assert.notEqual((await forward("after reply")).result?.isError, true);
  await waitFor(() => forwarded.length === 3);
  assert.equal(forwarded[2]!.hops, 4);
});

test("MCP tool call asks the user to start the hub when it is unreachable", async (context) => {
  const server = await startMcpServer(context, spawnEnvFor(context, {
    authToken: "unreachable-project-token",
    project: "test-project",
  }));
  const listed = await server.tool("kxm_list");
  assert.equal(listed.result?.isError, true);
  const text = server.text(listed);
  assert.match(text, /http:\/\/127\.0\.0\.1:1\b/);
  assert.match(text, /Ask the user/);
  assert.match(text, /kxm hub start/);
  assert.match(text, /\/plugin configure kxm@kxm/);
  assert.doesNotMatch(text, /unreachable-project-token/);
});

test("MCP policy error for an expired disk token asks the user to clear it and never mentions --issue", async (context) => {
  const spawnEnv = spawnEnvFor(context, { project: "test-project" });
  const expired = mintSessionToken({ preset: "operator", expiresAt: new Date(Date.now() - 60_000).toISOString() });
  persistSessionTokenToDisk(expired, { userConfigDir: spawnEnv.env.KXM_USER_CONFIG_DIR });
  const server = await startMcpServer(context, spawnEnv);

  const listed = await server.tool("kxm_list");
  assert.equal(listed.result?.isError, true);
  const text = server.text(listed);
  assert.match(text, /^tool_policy_denied: Session token on disk is malformed or expired\./);
  assert.match(text, /kxm session token --clear/);
  assert.match(text, /No active session token found/);
  assert.doesNotMatch(text, /--issue/);
  assert.doesNotMatch(text, /shows its expiry/);
  assert.equal(text.includes(expired), false);
});

test("MCP policy error for an invalid KXM_SESSION_TOKEN asks the user to fix the launch environment", async (context) => {
  const expired = mintSessionToken({ preset: "operator", expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const server = await startMcpServer(context, spawnEnvFor(context, {
    project: "test-project",
    extra: { KXM_SESSION_TOKEN: expired },
  }));

  const listed = await server.tool("kxm_list");
  assert.equal(listed.result?.isError, true);
  const text = server.text(listed);
  assert.match(text, /^tool_policy_denied: KXM_SESSION_TOKEN is malformed or expired\./);
  assert.match(text, /unset or replace KXM_SESSION_TOKEN/);
  assert.doesNotMatch(text, /session token --clear/);
  assert.doesNotMatch(text, /--issue/);
  assert.equal(text.includes(expired), false);
});

test("second MCP session with the same agent name registers with a pid suffix", async (context) => {
  const projectToken = "duplicate-name-project-token";
  const mesh = await createTestMesh(context, { projectTokens: { "test-project": projectToken } });
  const options = { hubUrl: mesh.address.url, authToken: projectToken, project: "test-project", agentName: "claude" };
  const first = await startMcpServer(context, spawnEnvFor(context, options));
  assert.notEqual(first.value(await first.tool("kxm_list")), undefined);
  const second = await startMcpServer(context, spawnEnvFor(context, options));
  const listed = await second.tool("kxm_list");
  assert.notEqual(listed.result?.isError, true, second.text(listed));

  const substitute = `claude-${second.child.pid}`;
  const online = [...mesh.hub.state.agents.values()]
    .filter((agent) => agent.project === "test-project" && agent.online)
    .map((agent) => agent.name)
    .sort();
  assert.deepEqual(online, ["claude", substitute].sort());
  assert.equal(first.stderr(), "");
  assert.equal(
    second.stderr(),
    `kxm: agent name claude is already active in project test-project; this session registers as ${substitute}\n`,
  );
});

test("MCP server registers with the hub before any tool call in a KXM project", async (context) => {
  const adminToken = "kxm_admin_presence-admin-token";
  const projectToken = "presence-project-token";
  const mesh = await createTestMesh(context, { authToken: adminToken, projectTokens: { "test-project": projectToken } });
  const peer = mesh.makeClient("presence-peer", { token: projectToken });
  await peer.start(() => undefined);
  const record = {
    schema: HUB_ENV_SCHEMA,
    createdAt: "2026-09-23T00:00:00.000Z",
    // The hub expects the project token for test-project, so a session that picked the
    // admin token here would fail to register.
    authToken: adminToken,
    projectTokens: { "test-project": projectToken },
  };

  const outside = spawnEnvFor(context, { hubUrl: mesh.address.url, project: "test-project", agentName: "claude-outside" });
  writeHubEnvRecord(record, outside.env);
  await startMcpServer(context, outside);
  const inside = spawnEnvFor(context, {
    hubUrl: mesh.address.url,
    project: "test-project",
    agentName: "claude-presence",
    withKxmDir: true,
  });
  writeHubEnvRecord(record, inside.env);
  const server = await startMcpServer(context, inside);

  await waitFor(async () => (await peer.listAgents()).some((agent) => agent.name === "claude-presence"), 3_000);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  assert.equal((await peer.listAgents()).some((agent) => agent.name === "claude-outside"), false);

  // A client that goes away closes stdin; the session leaves the hub instead of staying online.
  const exited = new Promise<number | null>((resolveExit) => server.child.once("exit", resolveExit));
  server.child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal((await peer.listAgents()).some((agent) => agent.name === "claude-presence"), false);
});

test("MCP instructions point at kxm_context and stay under 800 characters", async (context) => {
  const server = await startMcpServer(context, spawnEnvFor(context));
  const instructions = server.initialized.result?.instructions;
  assert.equal(typeof instructions, "string");
  const text = instructions as string;
  assert.ok(text.length < 800, `instructions are ${text.length} characters`);
  assert.match(text, /call kxm_context with your role and task before planning/);
  assert.match(text, /continue without KXM and tell the user the next step it names/);
  assert.match(text, /ten categories \(plan, decision, contradiction, error, lesson, observation, hypothesis, experiment, state-change, skill-candidate\)/);
  assert.match(text, /stageId/);
});
