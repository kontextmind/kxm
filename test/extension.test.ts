import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piMeshExtension from "../plugins/pi-mesh-comms/src/extension.ts";
import { createTestMesh, waitFor } from "./helpers.ts";

type EventHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type Tool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
};
type Command = {
  handler: (...args: unknown[]) => unknown | Promise<unknown>;
};

function fakePi() {
  const handlers = new Map<string, EventHandler[]>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const api = {
    on(name: string, handler: EventHandler) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
      sent.push({ message, options });
    },
    getSessionName() {
      return "pi-extension-test";
    },
  } as unknown as ExtensionAPI;

  async function emit(name: string, ...args: unknown[]): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler(...args);
  }
  return { api, tools, commands, sent, emit };
}

test("Pi extension registers tools, exchanges work, queues inbound turns, and reports status", async (context) => {
  const webhookSecret = "extension-webhook-secret-value";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "extension-workflow",
      source: "generic",
      project: "test-project",
      target: "pi-under-test",
      secret: webhookSecret,
      delivery: "followUp",
      promptTemplate: "Handle {{task.id}}",
      stages: [{ id: "work", label: "Work", instructions: "Do the work", requiredEvidence: ["test"], maxAttempts: 2 }],
    }],
  });
  const peer = mesh.makeClient("reviewer");
  await peer.start(async (event) => {
    if (event.type !== "message") return;
    await peer.acknowledge(event.message.id);
    if (event.message.content === "outbound review") await peer.reply(event.message.id, "outbound approved");
  });

  const previous = {
    url: process.env.PI_MESH_SERVER_URL,
    token: process.env.PI_MESH_AUTH_TOKEN,
    project: process.env.PI_MESH_PROJECT,
    name: process.env.PI_MESH_AGENT_NAME,
    purpose: process.env.PI_MESH_AGENT_PURPOSE,
  };
  Object.assign(process.env, {
    PI_MESH_SERVER_URL: mesh.address.url,
    PI_MESH_AUTH_TOKEN: mesh.token,
    PI_MESH_PROJECT: "test-project",
    PI_MESH_AGENT_NAME: "pi-under-test",
    PI_MESH_AGENT_PURPOSE: "Tests native Pi integration",
  });
  context.after(() => {
    for (const [key, value] of Object.entries({
      PI_MESH_SERVER_URL: previous.url,
      PI_MESH_AUTH_TOKEN: previous.token,
      PI_MESH_PROJECT: previous.project,
      PI_MESH_AGENT_NAME: previous.name,
      PI_MESH_AGENT_PURPOSE: previous.purpose,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fake = fakePi();
  piMeshExtension(fake.api);
  assert.deepEqual([...fake.tools.keys()], [
    "mesh_list",
    "mesh_send",
    "mesh_get",
    "mesh_fanout",
    "mesh_await",
    "mesh_cancel",
    "mesh_workflow_list",
    "mesh_workflow_get",
    "mesh_workflow_checkpoint",
    "mesh_workflow_wait",
    "mesh_workflow_record",
    "mesh_improvement_report",
  ]);
  assert.ok(fake.commands.has("mesh-status"));

  const statuses: string[] = [];
  const notices: Array<{ message: string; type: string }> = [];
  const ui = {
    setStatus(_key: string, value: string) {
      statuses.push(value);
    },
    notify(message: string, type: string) {
      notices.push({ message, type });
    },
  };
  await fake.emit("session_start", {}, {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    ui,
  });
  assert.ok(statuses.includes("mesh:pi-under-test"));
  await waitFor(async () => (await peer.listAgents()).some((agent) => agent.name === "pi-under-test"));

  const listed = await fake.tools.get("mesh_list")!.execute("call-list", {});
  assert.match(JSON.stringify(listed.details), /reviewer/);
  const sent = await fake.tools.get("mesh_send")!.execute("call-send", {
    target: "reviewer",
    content: "outbound review",
    delivery: "followUp",
    correlationId: "extension-test",
    idempotencyKey: "extension-send-1",
    ttlMs: 5_000,
  });
  const sentId = (sent.details as { messageId: string }).messageId;
  const awaited = await fake.tools.get("mesh_await")!.execute("call-await", { messageId: sentId, timeoutMs: 2_000 });
  assert.match(JSON.stringify(awaited.details), /outbound approved/);
  const fetched = await fake.tools.get("mesh_get")!.execute("call-get", { messageId: sentId });
  assert.match(JSON.stringify(fetched.details), /replied/);
  const panel = await fake.tools.get("mesh_fanout")!.execute("call-fanout", {
    targets: ["reviewer"],
    content: "outbound review",
    correlationId: "extension-panel",
    idempotencyKeyPrefix: "extension-panel",
    timeoutMs: 2_000,
  });
  assert.match(JSON.stringify(panel.details), /outbound approved/);

  const firstInbound = await peer.send({ target: "pi-under-test", content: "first inbound", delivery: "followUp" });
  const secondInbound = await peer.send({ target: "pi-under-test", content: "second inbound", delivery: "nextTurn" });
  await waitFor(() => fake.sent.length === 1);
  assert.equal(fake.sent[0]!.options.triggerTurn, true);
  assert.equal(fake.sent[0]!.options.deliverAs, "followUp");
  await fake.emit("message_start", { message: fake.sent[0]!.message });
  await fake.emit("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "first result" }] }],
  });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(firstInbound.id, 2_000)).reply?.content, "first result");
  await waitFor(() => fake.sent.length === 2);
  assert.equal(fake.sent[1]!.options.triggerTurn, false);
  await fake.emit("message_start", { message: fake.sent[1]!.message });
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: "second result" }] });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(secondInbound.id, 2_000)).reply?.content, "second result");

  const workflowPayload = JSON.stringify({ event: "task", task: { id: "TASK-7" } });
  const workflowResponse = await fetch(`${mesh.address.url}/v1/webhooks/extension-workflow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": "extension-delivery-7",
      "x-hub-signature": `sha256=${createHmac("sha256", webhookSecret).update(workflowPayload).digest("hex")}`,
    },
    body: workflowPayload,
  });
  const workflowBody = await workflowResponse.json() as { run: { id: string } };
  await waitFor(() => fake.sent.length === 3);
  const workflowRunId = workflowBody.run.id;
  await fake.emit("message_start", { message: fake.sent[2]!.message });
  await fake.emit("tool_result", { toolName: "bash", toolCallId: "tool-failure-1", isError: true });
  assert.match(JSON.stringify((await fake.tools.get("mesh_workflow_list")!.execute("workflow-list", {})).details), /TASK|extension-workflow/);
  assert.match(JSON.stringify((await fake.tools.get("mesh_workflow_get")!.execute("workflow-get", { runId: workflowRunId })).details), /in_progress/);
  await fake.tools.get("mesh_workflow_record")!.execute("workflow-record", {
    runId: workflowRunId,
    category: "decision",
    area: "implementation",
    summary: "Use the smallest safe change",
  });
  await assert.rejects(() => fake.tools.get("mesh_workflow_wait")!.execute("workflow-wait-invalid", {
    runId: workflowRunId,
    stageId: "missing",
    signalKey: "external-check",
    summary: "Wait for external check",
  }), /not found/);
  const checkpoint = await fake.tools.get("mesh_workflow_checkpoint")!.execute("workflow-checkpoint", {
    runId: workflowRunId,
    stageId: "work",
    status: "passed",
    summary: "Work and test complete",
    evidence: ["test:pass"],
  });
  assert.equal((checkpoint.details as { completed: boolean }).completed, true);
  assert.match(JSON.stringify((await fake.tools.get("mesh_improvement_report")!.execute("improvements", {})).details), /implementation/);
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: "workflow complete" }] });
  await fake.emit("agent_settled");

  const exactLimitInbound = await peer.send({
    target: "pi-under-test",
    content: "return an exact-limit response",
    delivery: "followUp",
  });
  await waitFor(() => fake.sent.length === 4);
  await fake.emit("message_start", { message: fake.sent[3]!.message });
  const exactLimitReply = "x".repeat(32_000);
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: exactLimitReply }] });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(exactLimitInbound.id, 2_000)).reply?.content, exactLimitReply);

  const oversizedInbound = await peer.send({
    target: "pi-under-test",
    content: "return an oversized response",
    delivery: "followUp",
  });
  await waitFor(() => fake.sent.length === 5);
  await fake.emit("message_start", { message: fake.sent[4]!.message });
  const oversizedReply = "x".repeat(32_001);
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: oversizedReply }] });
  await fake.emit("agent_settled");
  const boundedReply = (await peer.awaitResponse(oversizedInbound.id, 2_000)).reply?.content ?? "";
  assert.equal(boundedReply.length, 32_000);
  assert.match(boundedReply, /response truncated from 32001 characters to fit the message limit/);

  const cancellable = await fake.tools.get("mesh_send")!.execute("call-send-cancel", {
    target: "reviewer",
    content: "do not complete",
  });
  const cancelled = await fake.tools.get("mesh_cancel")!.execute("call-cancel", {
    messageId: (cancellable.details as { messageId: string }).messageId,
  });
  assert.match(JSON.stringify(cancelled.details), /cancelled/);

  await fake.commands.get("mesh-status")!.handler("", { ui });
  assert.ok(notices.some((notice) => notice.message.includes("pi-under-test") && notice.type === "info"));
  await fake.emit("session_shutdown");
  await fake.commands.get("mesh-status")!.handler("", { ui });
  assert.ok(notices.some((notice) => notice.message === "pi-mesh is offline" && notice.type === "warning"));
  await assert.rejects(() => fake.tools.get("mesh_list")!.execute("offline", {}), /not connected/);
});
