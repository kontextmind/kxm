import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createInterface } from "node:readline";
import test from "node:test";
import { createTestMesh, waitFor } from "./helpers.ts";

type RpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

test("bundled MCP server initializes and publishes the mesh tool catalog", async (context) => {
  const child = spawn(process.execPath, ["plugins/pi-mesh-comms/dist/mcp-server.js"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let stderr = "";
  const pending = new Map<number, { resolve(value: RpcResponse): void; reject(error: Error): void }>();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  lines.on("line", (line) => {
    const response = JSON.parse(line) as RpcResponse;
    if (typeof response.id !== "number") return;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) waiter.reject(new Error(response.error.message));
    else waiter.resolve(response);
  });

  child.once("exit", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`MCP server exited with ${String(code)}: ${stderr}`));
    }
    pending.clear();
  });

  context.after(() => {
    lines.close();
    if (!child.killed) child.kill();
  });

  function request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = nextId++;
    const response = new Promise<RpcResponse>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pi-mesh-test", version: "1.0.0" },
  });
  assert.equal(initialized.result?.protocolVersion, "2025-06-18");
  assert.deepEqual(initialized.result?.capabilities, {
    experimental: { "claude/channel": {} },
    tools: {},
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request("tools/list", {});
  const tools = listed.result?.tools as Array<{ name: string }>;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "mesh_list",
      "mesh_send",
      "mesh_get",
      "mesh_fanout",
      "mesh_await",
      "mesh_cancel",
      "mesh_inbox",
      "mesh_reply",
      "mesh_workflow_list",
      "mesh_workflow_get",
      "mesh_workflow_checkpoint",
      "mesh_workflow_record",
      "mesh_workflow_wait",
      "mesh_improvement_report",
    ],
  );
  assert.equal(stderr, "");
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
      stages: [{ id: "work", label: "Work", instructions: "Do the work", requiredEvidence: ["checks"], maxAttempts: 2 }],
    }],
  });
  const peer = mesh.makeClient("reviewer");
  await peer.start(async (event) => {
    if (event.type !== "message") return;
    await peer.acknowledge(event.message.id);
    if (event.message.content === "review this") await peer.reply(event.message.id, "review complete");
  });

  const child = spawn(process.execPath, ["plugins/pi-mesh-comms/dist/mcp-server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_MESH_SERVER_URL: mesh.address.url,
      PI_MESH_AUTH_TOKEN: mesh.token,
      PI_MESH_AGENT_NAME: "claude-under-test",
      PI_MESH_AGENT_PURPOSE: "MCP integration test",
      PI_MESH_PROJECT: "test-project",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let stderr = "";
  const notifications: Array<Record<string, unknown>> = [];
  const pending = new Map<number, { resolve(value: RpcResponse): void; reject(error: Error): void }>();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as RpcResponse & { method?: string; params?: Record<string, unknown> };
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
  context.after(() => {
    lines.close();
    if (!child.killed) child.kill();
  });

  function request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = nextId++;
    const response = new Promise<RpcResponse>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  function tool(name: string, args: Record<string, unknown> = {}): Promise<RpcResponse> {
    return request("tools/call", { name, arguments: args });
  }

  function toolValue(response: RpcResponse): Record<string, unknown> {
    const content = response.result?.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "live-test", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = toolValue(await tool("mesh_list"));
  assert.match(JSON.stringify(listed), /reviewer/);
  const sent = toolValue(await tool("mesh_send", {
    target: "reviewer",
    content: "review this",
    correlationId: "mcp-outbound",
    idempotencyKey: "mcp-send-1",
    ttlMs: 5_000,
  }));
  const outboundId = String(sent.messageId);
  const completed = toolValue(await tool("mesh_await", { messageId: outboundId, timeoutMs: 2_000 }));
  assert.equal((completed.reply as { content: string }).content, "review complete");
  assert.equal(toolValue(await tool("mesh_get", { messageId: outboundId })).status, "replied");
  const panel = toolValue(await tool("mesh_fanout", {
    targets: ["reviewer"],
    content: "review this",
    correlationId: "mcp-panel",
    idempotencyKeyPrefix: "mcp-panel",
    timeoutMs: 2_000,
  }));
  assert.match(JSON.stringify(panel), /review complete/);

  const cancellable = toolValue(await tool("mesh_send", { target: "reviewer", content: "cancel this" }));
  const cancelled = toolValue(await tool("mesh_cancel", { messageId: cancellable.messageId }));
  assert.equal(cancelled.status, "cancelled");

  const inbound = await peer.send({ target: "claude-under-test", content: "incoming review" });
  await waitFor(() => notifications.some((notification) => notification.method === "notifications/claude/channel"));
  const channel = notifications.find((notification) => notification.method === "notifications/claude/channel")!;
  assert.match(JSON.stringify(channel), /incoming review/);
  assert.match(JSON.stringify(channel), new RegExp(inbound.id));
  const inbox = toolValue(await tool("mesh_inbox"));
  assert.match(JSON.stringify(inbox), new RegExp(inbound.id));
  const replied = toolValue(await tool("mesh_reply", { messageId: inbound.id, content: "inbound complete" }));
  assert.equal(replied.status, "replied");
  assert.equal((await peer.awaitResponse(inbound.id, 2_000)).reply?.content, "inbound complete");
  assert.doesNotMatch(JSON.stringify(toolValue(await tool("mesh_inbox"))), new RegExp(inbound.id));

  const workflowPayload = JSON.stringify({ event: "task", task: { id: "MCP-9" } });
  const webhook = await fetch(`${mesh.address.url}/v1/webhooks/mcp-workflow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": "mcp-delivery-9",
      "x-hub-signature": `sha256=${createHmac("sha256", webhookSecret).update(workflowPayload).digest("hex")}`,
    },
    body: workflowPayload,
  });
  const workflow = await webhook.json() as { run: { id: string; messageId: string } };
  await waitFor(async () => JSON.stringify(toolValue(await tool("mesh_inbox"))).includes(workflow.run.messageId));
  assert.match(JSON.stringify(toolValue(await tool("mesh_workflow_list"))), /mcp-workflow/);
  assert.match(JSON.stringify(toolValue(await tool("mesh_workflow_get", { runId: workflow.run.id }))), /in_progress/);
  const recorded = toolValue(await tool("mesh_workflow_record", {
    runId: workflow.run.id,
    category: "lesson",
    area: "harness",
    severity: "warning",
    summary: "Keep the coordinator alive while work is queued",
    evidence: ["MCP-9"],
  }));
  assert.equal(recorded.category, "lesson");
  const invalidWait = await tool("mesh_workflow_wait", {
    runId: workflow.run.id,
    stageId: "missing",
    signalKey: "external-check",
    summary: "Wait for external check",
  });
  assert.equal(invalidWait.result?.isError, true);
  assert.match(JSON.stringify(invalidWait.result), /not found/);
  const checkpoint = toolValue(await tool("mesh_workflow_checkpoint", {
    runId: workflow.run.id,
    stageId: "work",
    status: "passed",
    summary: "Completed with checks",
    evidence: ["checks:pass"],
  }));
  assert.equal(checkpoint.completed, true);
  assert.match(JSON.stringify(toolValue(await tool("mesh_improvement_report"))), /harness/);
  assert.equal(toolValue(await tool("mesh_reply", {
    messageId: workflow.run.messageId,
    content: "workflow complete",
  })).status, "replied");

  const invalid = await tool("mesh_send", { content: "missing target" });
  assert.equal(invalid.result?.isError, true);
  assert.match(JSON.stringify(invalid.result), /target is required/);
  assert.equal(stderr, "");
});
