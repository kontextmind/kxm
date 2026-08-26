import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MeshClient, MeshHttpError } from "../plugins/pi-mesh-comms/src/client.ts";
import { createMeshHub } from "../plugins/pi-mesh-comms/src/hub.ts";
import { MAX_BODY_BYTES } from "../plugins/pi-mesh-comms/src/protocol.ts";
import type { WebhookWorkflowDefinition } from "../plugins/pi-mesh-comms/src/workflow.ts";
import { createTestMesh, responseJson, waitFor } from "./helpers.ts";

interface RawIdentity {
  agent: { id: string; name: string; project: string };
  agentKey: string;
  resumed?: boolean;
}

async function registerRaw(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; identity?: RawIdentity }> {
  const response = await fetch(`${url}/v1/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const value = await responseJson(response);
  return { response, ...(response.ok ? { identity: value as unknown as RawIdentity } : {}) };
}

function identityHeaders(identity: RawIdentity, token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "x-mesh-agent-id": identity.agent.id,
    "x-mesh-agent-key": identity.agentKey,
  };
}

test("health, readiness, metrics, request IDs, and security headers are operational", async (context) => {
  const { address, token } = await createTestMesh(context);
  const health = await fetch(`${address.url}/health`, { headers: { "x-request-id": "health-check-1" } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-request-id"), "health-check-1");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(await health.json(), { ok: true, agents: 0 });

  const ready = await fetch(`${address.url}/ready`);
  assert.deepEqual(await ready.json(), { ok: true, storage: "memory" });

  const denied = await fetch(`${address.url}/metrics`);
  assert.equal(denied.status, 401);
  const metrics = await fetch(`${address.url}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /pi_mesh_requests_total/);
});

test("registration validates content type, JSON shape, required fields, and size", async (context) => {
  const { address, token } = await createTestMesh(context);
  const headers = { authorization: `Bearer ${token}` };
  const unsupported = await fetch(`${address.url}/v1/agents/register`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(unsupported.status, 415);
  assert.equal((await responseJson(unsupported)).code, "unsupported_media_type");

  const malformed = await fetch(`${address.url}/v1/agents/register`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await responseJson(malformed)).code, "invalid_json");

  const array = await fetch(`${address.url}/v1/agents/register`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "[]",
  });
  assert.equal(array.status, 400);

  const missing = await registerRaw(address.url, token, { name: "agent" });
  assert.equal(missing.response.status, 400);

  const oversized = await fetch(`${address.url}/v1/agents/register`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "large", project: "test", padding: "x".repeat(MAX_BODY_BYTES) }),
  });
  assert.equal(oversized.status, 413);
});

test("project tokens isolate authentication and discovery", async (context) => {
  const mesh = await createTestMesh(context, {
    authToken: "admin-token",
    projectTokens: { alpha: "alpha-token" },
  });
  const denied = await registerRaw(mesh.address.url, "admin-token", {
    name: "alpha-denied",
    purpose: "test",
    project: "alpha",
  });
  assert.equal(denied.response.status, 401);

  const alpha = mesh.makeClient("alpha-agent", { project: "alpha", token: "alpha-token" });
  const beta = mesh.makeClient("beta-agent", { project: "beta", token: "admin-token" });
  await alpha.start(() => undefined);
  await beta.start(() => undefined);
  assert.deepEqual((await alpha.listAgents()).map((agent) => agent.name), ["alpha-agent"]);
  assert.deepEqual((await beta.listAgents()).map((agent) => agent.name), ["beta-agent"]);

  const wrongProjectToken = await fetch(`${mesh.address.url}/v1/agents`, {
    headers: {
      authorization: "Bearer admin-token",
      "x-mesh-agent-id": alpha.agent!.id,
      "x-mesh-agent-key": String((alpha as unknown as { agentKey: string }).agentKey),
    },
  });
  assert.equal(wrongProjectToken.status, 401);
});

test("offline names resume the durable identity and rotate its key", async (context) => {
  const { address, token } = await createTestMesh(context);
  const first = await registerRaw(address.url, token, { name: "builder", purpose: "build", project: "test-project" });
  assert.equal(first.response.status, 201);
  const duplicate = await registerRaw(address.url, token, { name: "BUILDER", purpose: "build", project: "test-project" });
  assert.equal(duplicate.response.status, 409);

  const stopped = await fetch(`${address.url}/v1/agents/${first.identity!.agent.id}`, {
    method: "DELETE",
    headers: identityHeaders(first.identity!, token),
  });
  assert.equal(stopped.status, 204);
  const resumed = await registerRaw(address.url, token, { name: "builder", purpose: "new purpose", project: "test-project" });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.identity!.agent.id, first.identity!.agent.id);
  assert.equal(resumed.identity!.resumed, true);
  assert.notEqual(resumed.identity!.agentKey, first.identity!.agentKey);

  const oldKey = await fetch(`${address.url}/v1/agents`, { headers: identityHeaders(first.identity!, token) });
  assert.equal(oldKey.status, 401);
});

test("stale agents are marked offline and logged", async (context) => {
  const entries: Array<Record<string, unknown>> = [];
  const mesh = await createTestMesh(context, {
    staleAfterMs: 120,
    cleanupIntervalMs: 25,
    logger: (entry) => entries.push(entry),
  });
  const raw = await registerRaw(mesh.address.url, mesh.token, {
    name: "short-lived",
    purpose: "test",
    project: "test-project",
  });
  await waitFor(() => mesh.hub.state.agents.get(raw.identity!.agent.id)?.online === false, 1_000);
  assert.ok(entries.some((entry) => entry.event === "agent_stale"));
});

test("message fields, delivery modes, hop limits, TTLs, and target rules are validated", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("sender");
  const receiver = mesh.makeClient("receiver");
  await sender.start(() => undefined);
  await receiver.start(() => undefined);

  for (const delivery of ["followUp", "steer", "nextTurn"] as const) {
    const message = await sender.send({
      target: receiver.agent!.id,
      content: `mode ${delivery}`,
      delivery,
      correlationId: `corr-${delivery}`,
      replyTo: "root-message",
      ttlMs: 5_000,
    });
    assert.equal(message.delivery, delivery);
    assert.equal(message.correlationId, `corr-${delivery}`);
    assert.equal(message.replyTo, "root-message");
    assert.ok(Date.parse(message.expiresAt) > Date.parse(message.createdAt));
  }

  await assert.rejects(() => sender.send({ target: "sender", content: "self" }), /cannot send/);
  await assert.rejects(() => sender.send({ target: "missing", content: "none" }), /not found/);
  await assert.rejects(() => sender.send({ target: "receiver", content: "hop", hops: 5, maxHops: 5 }), /hop limit/);
  await assert.rejects(() => sender.send({ target: "receiver", content: "ttl", ttlMs: 10 }), /ttlMs/);
});

test("message acknowledgement, visibility, reply, and terminal-state authorization are enforced", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("sender");
  const receiver = mesh.makeClient("receiver");
  const observer = mesh.makeClient("observer");
  await Promise.all([sender.start(() => undefined), receiver.start(() => undefined), observer.start(() => undefined)]);
  const message = await sender.send({ target: "receiver", content: "review" });

  await assert.rejects(() => observer.acknowledge(message.id), (error: unknown) => {
    assert.ok(error instanceof MeshHttpError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "message_forbidden");
    assert.ok(error.requestId);
    return true;
  });
  await assert.rejects(() => observer.getMessage(message.id), /not visible/);
  assert.equal((await receiver.acknowledge(message.id)).status, "delivered");
  assert.equal((await receiver.acknowledge(message.id)).status, "delivered");
  assert.equal((await receiver.reply(message.id, "approved")).status, "replied");
  assert.equal((await sender.getMessage(message.id)).reply?.content, "approved");
  await assert.rejects(() => receiver.reply(message.id, "again"), /already has a reply/);
  await assert.rejects(() => receiver.acknowledge(message.id), /cannot acknowledge/);
  await assert.rejects(() => sender.cancel(message.id), /cannot cancel/);
});

test("senders can cancel pending work and recipients cannot reply afterward", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("sender");
  const receiver = mesh.makeClient("receiver");
  await Promise.all([sender.start(() => undefined), receiver.start(() => undefined)]);
  const message = await sender.send({ target: "receiver", content: "cancel me" });
  await receiver.acknowledge(message.id);
  const cancelled = await sender.cancel(message.id);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelledAt);
  assert.equal((await sender.cancel(message.id)).status, "cancelled");
  assert.equal((await sender.awaitResponse(message.id, 1_000)).status, "cancelled");
  await assert.rejects(() => receiver.reply(message.id, "too late"), /cannot reply/);
  await assert.rejects(() => receiver.cancel(message.id), /only the sender/);
});

test("messages expire and become terminal", async (context) => {
  const mesh = await createTestMesh(context, { messageTtlMs: 1_000, cleanupIntervalMs: 25 });
  const sender = mesh.makeClient("sender");
  const receiver = mesh.makeClient("receiver");
  await Promise.all([sender.start(() => undefined), receiver.start(() => undefined)]);
  const message = await sender.send({ target: "receiver", content: "expire" });
  await waitFor(() => mesh.hub.state.messages.get(message.id)?.status === "expired", 2_000);
  const expired = await sender.awaitResponse(message.id, 1_000);
  assert.equal(expired.status, "expired");
  assert.match(expired.error ?? "", /expired/);
  await assert.rejects(() => receiver.reply(message.id, "late"), /cannot reply/);
});

test("terminal messages are removed after the configured retention window", async (context) => {
  const mesh = await createTestMesh(context, { messageRetentionMs: 1_000, cleanupIntervalMs: 25 });
  const sender = mesh.makeClient("sender");
  const receiver = mesh.makeClient("receiver");
  await Promise.all([sender.start(() => undefined), receiver.start(() => undefined)]);
  const message = await sender.send({ target: "receiver", content: "temporary" });
  await sender.cancel(message.id);
  await waitFor(() => !mesh.hub.state.messages.has(message.id), 4_000);
  await assert.rejects(() => sender.getMessage(message.id), /not found/);
  const metrics = await fetch(`${mesh.address.url}/metrics`, {
    headers: { authorization: `Bearer ${mesh.token}` },
  }).then((response) => response.text());
  assert.match(metrics, /pi_mesh_messages_purged_total 1/);
});

test("idempotency keys deduplicate exact retries and reject conflicting reuse", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("sender");
  const receiver = mesh.makeClient("receiver");
  await Promise.all([sender.start(() => undefined), receiver.start(() => undefined)]);
  const options = { target: "receiver", content: "once", idempotencyKey: "task-123" };
  const first = await sender.send(options);
  const second = await sender.send(options);
  assert.equal(second.id, first.id);
  assert.equal(mesh.hub.state.messages.size, 1);
  await assert.rejects(
    () => sender.send({ ...options, content: "different" }),
    /idempotency key was already used/,
  );
  await assert.rejects(
    () => sender.send({ ...options, ttlMs: 5_000 }),
    /idempotency key was already used/,
  );
});

test("fanout gathers one to three independent planning responses and preserves partial errors", async (context) => {
  const mesh = await createTestMesh(context);
  const coordinator = mesh.makeClient("coordinator");
  const planners = ["planner-a", "planner-b", "planner-c"].map((name) => mesh.makeClient(name));
  await Promise.all(planners.map((planner) => planner.start(async (event) => {
    if (event.type !== "message") return;
    await planner.acknowledge(event.message.id);
    await planner.reply(event.message.id, `${planner.options.name} proposal`);
  })));
  await coordinator.start(() => undefined);
  const results = await coordinator.fanout({
    targets: ["planner-a", "planner-b", "planner-c"],
    content: "Propose an independent fix plan",
    correlationId: "PROD-42",
    idempotencyKeyPrefix: "PROD-42:planning",
    timeoutMs: 2_000,
  });
  assert.deepEqual(results.map((result) => result.status), ["replied", "replied", "replied"]);
  assert.deepEqual(results.map((result) => result.reply), ["planner-a proposal", "planner-b proposal", "planner-c proposal"]);
  const exactRetry = await coordinator.fanout({
    targets: ["planner-a", "planner-b", "planner-c"],
    content: "Propose an independent fix plan",
    correlationId: "PROD-42",
    idempotencyKeyPrefix: "PROD-42:planning",
    timeoutMs: 2_000,
  });
  assert.deepEqual(
    exactRetry.map((result) => result.messageId),
    results.map((result) => result.messageId),
  );
  const nextWorkflow = await coordinator.fanout({
    targets: ["planner-a", "planner-b", "planner-c"],
    content: "Propose an independent follow-up plan",
    correlationId: "PROD-43",
    idempotencyKeyPrefix: "PROD-42:planning",
    timeoutMs: 2_000,
  });
  assert.deepEqual(nextWorkflow.map((result) => result.status), ["replied", "replied", "replied"]);
  assert.ok(nextWorkflow.every((result, index) => result.messageId !== results[index]!.messageId));
  const normalizedDuplicate = await coordinator.fanout({
    targets: [" planner-a ", "Planner-A"],
    content: "Normalize panel identities",
    correlationId: "PROD-44",
    idempotencyKeyPrefix: "PROD-44:planning",
    timeoutMs: 2_000,
  });
  assert.equal(normalizedDuplicate.length, 1);
  assert.equal(normalizedDuplicate[0]!.target, "planner-a");
  assert.equal(normalizedDuplicate[0]!.status, "replied");
  const messageCountBeforeConflict = mesh.hub.state.messages.size;
  const changedContent = await coordinator.fanout({
    targets: ["planner-a"],
    content: "Changed content under the same durable scope",
    correlationId: "PROD-44",
    idempotencyKeyPrefix: "PROD-44:planning",
    timeoutMs: 2_000,
  });
  assert.equal(changedContent[0]!.status, "error");
  assert.match(changedContent[0]!.error ?? "", /idempotency key was already used/);
  assert.equal(mesh.hub.state.messages.size, messageCountBeforeConflict);
  const longPrefix = await coordinator.fanout({
    targets: ["planner-b"],
    content: "Bound the derived retry key",
    correlationId: "PROD-45",
    idempotencyKeyPrefix: "stage:" + "x".repeat(500),
    timeoutMs: 2_000,
  });
  const storedLongPrefixMessage = mesh.hub.state.messages.get(longPrefix[0]!.messageId!);
  assert.equal(storedLongPrefixMessage?.idempotencyKey?.length, 71);
  assert.match(storedLongPrefixMessage?.idempotencyKey ?? "", /^fanout:[a-f0-9]{64}$/);
  const partial = await coordinator.fanout({ targets: ["planner-a", "missing"], content: "Compare", timeoutMs: 2_000 });
  assert.equal(partial[0]!.status, "replied");
  assert.equal(partial[1]!.status, "error");
  await assert.rejects(
    () => coordinator.fanout({ targets: ["a", "b", "c", "d"], content: "too many" }),
    /one and three/,
  );
});

test("rate limiting returns retry guidance and resets after the window", async (context) => {
  const mesh = await createTestMesh(context, { rateLimit: { maxRequests: 2, windowMs: 150 } });
  const registered = await registerRaw(mesh.address.url, mesh.token, {
    name: "limited",
    purpose: "test",
    project: "test-project",
  });
  const headers = identityHeaders(registered.identity!, mesh.token);
  assert.equal((await fetch(`${mesh.address.url}/v1/agents`, { headers })).status, 200);
  assert.equal((await fetch(`${mesh.address.url}/v1/agents`, { headers })).status, 200);
  const limited = await fetch(`${mesh.address.url}/v1/agents`, { headers });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
  assert.equal((await responseJson(limited)).code, "rate_limited");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal((await fetch(`${mesh.address.url}/v1/agents`, { headers })).status, 200);
});

test("SQLite persistence retains messages and resumes identities across hub restarts", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-test-"));
  const database = join(directory, "mesh.db");
  const token = "persistent-token";
  const hub1 = createMeshHub({ port: 0, authToken: token, dataPath: database, rateLimit: false });
  const address1 = await hub1.start();
  const sender1 = new MeshClient({ serverUrl: address1.url, authToken: token, name: "sender", purpose: "send", project: "persist" });
  const receiver1 = new MeshClient({ serverUrl: address1.url, authToken: token, name: "receiver", purpose: "receive", project: "persist" });
  await Promise.all([sender1.start(() => undefined), receiver1.start(() => undefined)]);
  const originalSenderId = sender1.agent!.id;
  const originalReceiverId = receiver1.agent!.id;
  const message = await sender1.send({ target: "receiver", content: "survive restart" });
  await Promise.all([sender1.stop(), receiver1.stop()]);
  await hub1.close();

  const hub2 = createMeshHub({ port: 0, authToken: token, dataPath: database, rateLimit: false });
  const address2 = await hub2.start();
  const sender2 = new MeshClient({ serverUrl: address2.url, authToken: token, name: "sender", purpose: "send", project: "persist" });
  const receiver2 = new MeshClient({ serverUrl: address2.url, authToken: token, name: "receiver", purpose: "receive", project: "persist" });
  context.after(async () => {
    await Promise.allSettled([sender2.stop(), receiver2.stop()]);
    await hub2.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([sender2.start(() => undefined), receiver2.start(() => undefined)]);
  assert.equal(sender2.agent!.id, originalSenderId);
  assert.equal(receiver2.agent!.id, originalReceiverId);
  assert.equal((await sender2.getMessage(message.id)).content, "survive restart");
  await receiver2.acknowledge(message.id);
  await receiver2.reply(message.id, "still here");
  assert.equal((await sender2.awaitResponse(message.id, 1_000)).reply?.content, "still here");
});

test("unsafe hub configuration is rejected", () => {
  assert.throws(() => createMeshHub({ host: "0.0.0.0" }), /AUTH_TOKEN/);
  assert.throws(() => createMeshHub({ staleAfterMs: 10 }), /below supported minimums/);
  assert.throws(() => createMeshHub({ messageTtlMs: 10 }), /below supported minimums/);
  assert.throws(() => createMeshHub({ messageRetentionMs: 10 }), /below supported minimums/);
  assert.throws(() => createMeshHub({ rateLimit: { maxRequests: 0 } }), /rate limit settings/);
});

test("structured logs never include prompt or reply bodies", async (context) => {
  const entries: Array<Record<string, unknown>> = [];
  const mesh = await createTestMesh(context, { logger: (entry) => entries.push(entry) });
  const sender = mesh.makeClient("sender");
  const receiver = mesh.makeClient("receiver");
  await Promise.all([sender.start(() => undefined), receiver.start(() => undefined)]);
  const message = await sender.send({ target: "receiver", content: "SECRET_PROMPT_BODY" });
  await receiver.reply(message.id, "SECRET_REPLY_BODY");
  const logs = JSON.stringify(entries);
  assert.doesNotMatch(logs, /SECRET_PROMPT_BODY|SECRET_REPLY_BODY/);
  assert.match(logs, /message_sent/);
  assert.match(logs, /message_replied/);
});

test("signed Jira webhooks start durable workflows, deduplicate retries, journal learning, and enforce gates", async (context) => {
  const assetsDir = mkdtempSync(join(tmpdir(), "pi-mesh-retrospectives-"));
  context.after(() => rmSync(assetsDir, { recursive: true, force: true }));
  const secret = "jira-webhook-secret-with-entropy";
  const definition: WebhookWorkflowDefinition = {
    id: "jira-development",
    source: "jira",
    project: "test-project",
    target: "coordinator",
    secret,
    event: "jira:issue_updated",
    filter: { path: "issue.fields.status.name", equals: "In Progress" },
    delivery: "followUp",
    promptTemplate: "Handle {{issue.key}}: {{issue.fields.summary}}",
    stages: [
      { id: "reproduce", label: "Reproduce", instructions: "Reproduce", requiredEvidence: ["failing test"], maxAttempts: 3 },
      { id: "quality", label: "Quality gates", instructions: "Run gates", requiredEvidence: ["lint", "build", "security", "playwright"], maxAttempts: 2 },
    ],
  };
  const mesh = await createTestMesh(context, { webhookWorkflows: [definition], assetsDir });
  let inbound: string | undefined;
  const coordinator = mesh.makeClient("coordinator");
  const observer = mesh.makeClient("observer");
  await coordinator.start(async (event) => {
    if (event.type === "message") {
      inbound = event.message.content;
      await coordinator.acknowledge(event.message.id);
    }
  });
  await observer.start(() => undefined);
  const payload = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    issue: { key: "PROD-42", fields: { summary: "Checkout fails", status: { name: "In Progress" } } },
  });
  const sendWebhook = (deliveryId: string, body = payload, suppliedSignature?: string) => fetch(
    `${mesh.address.url}/v1/webhooks/jira-development`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": suppliedSignature
          ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        "x-atlassian-webhook-identifier": deliveryId,
      },
      body,
    },
  );

  assert.equal((await sendWebhook("invalid", payload, "sha256=bad")).status, 401);
  const ignoredPayload = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    issue: { key: "PROD-41", fields: { summary: "Backlog", status: { name: "To Do" } } },
  });
  assert.equal((await sendWebhook("ignored", ignoredPayload)).status, 204);
  const accepted = await sendWebhook("jira-delivery-42");
  assert.equal(accepted.status, 202);
  const acceptedBody = await responseJson(accepted) as unknown as { run: { id: string; messageId: string } };
  const runId = acceptedBody.run.id;
  await waitFor(() => inbound?.includes("PROD-42") ?? false);
  assert.match(inbound!, /mesh_workflow_record/);
  assert.equal((await sendWebhook("jira-delivery-42")).status, 200);
  assert.equal((await coordinator.listWorkflows()).length, 1);
  await assert.rejects(() => observer.getWorkflow(runId), (error: unknown) => {
    assert.ok(error instanceof MeshHttpError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "workflow_forbidden");
    assert.equal(error.extras?.operation, "get");
    assert.equal(error.extras?.nextAction, "use_assigned_coordinator");
    assert.equal(error.extras?.assignedCoordinatorName, "coordinator");
    assert.match(error.message, /not visible/);
    return true;
  });

  const plan = await coordinator.recordWorkflowEntry(runId, {
    category: "plan",
    area: "implementation",
    summary: "Reproduce before changing code",
    evidence: ["PROD-42"],
  });
  const contradiction = await coordinator.recordWorkflowEntry(runId, {
    category: "contradiction",
    area: "gates",
    severity: "warning",
    summary: "Two planners disagree on whether the browser test is flaky",
    relatedEntryIds: [plan.id],
  });
  assert.equal(contradiction.category, "contradiction");
  await assert.rejects(() => coordinator.recordWorkflowEntry(runId, {
    category: "decision",
    area: "workflow",
    summary: "Invalid relation",
    relatedEntryIds: ["journal_missing"],
  }), /same workflow run/);
  const retry = await coordinator.checkpointWorkflow(runId, {
    stageId: "reproduce",
    status: "warning",
    summary: "Reproduction is not deterministic",
    evidence: ["trace:first"],
  });
  assert.equal(retry.retry, true);
  assert.match(retry.instruction, /Correct/);
  const advance = await coordinator.checkpointWorkflow(runId, {
    stageId: "reproduce",
    status: "passed",
    summary: "Reproduced with a failing test",
    evidence: ["test:checkout.spec.ts"],
  });
  assert.equal(advance.run.currentStage, "quality");
  const complete = await coordinator.checkpointWorkflow(runId, {
    stageId: "quality",
    status: "passed",
    summary: "All repository gates passed",
    evidence: ["lint:pass", "build:pass", "security:pass", "playwright:pass"],
  });
  assert.equal(complete.completed, true);
  assert.equal((await coordinator.getWorkflow(runId)).run.status, "completed");
  const retrospectiveJson = join(assetsDir, "retrospectives", `${runId}.json`);
  const retrospectiveMarkdown = join(assetsDir, "retrospectives", `${runId}.md`);
  assert.equal(existsSync(retrospectiveJson), true);
  assert.equal(existsSync(retrospectiveMarkdown), true);
  assert.match(readFileSync(retrospectiveJson, "utf8"), /"reviewDecision": "proposed"/);
  const report = await coordinator.improvementReport();
  assert.equal(report.entries, 3);
  assert.equal(report.reports.find((item) => item.area === "gates")?.contradictions, 1);
  assert.equal(report.reports.find((item) => item.area === "workflow")?.errors, 1);
  await coordinator.reply(acceptedBody.run.messageId, "Workflow complete with evidence");
  assert.equal((await coordinator.getWorkflow(runId)).run.status, "completed");
});

test("webhook workflows reject unsigned deliveries and unknown coordinators", async (context) => {
  const secret = "unknown-target-secret-value";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "unknown-target",
      source: "generic",
      project: "test-project",
      target: "not-registered",
      secret,
      delivery: "followUp",
      promptTemplate: "Handle {{task}}",
      stages: [{ id: "work", label: "Work", instructions: "Work", requiredEvidence: [], maxAttempts: 1 }],
    }],
  });
  const payload = JSON.stringify({ task: "test" });
  const url = `${mesh.address.url}/v1/webhooks/unknown-target`;
  const unsigned = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mesh-delivery-id": "unsigned" },
    body: payload,
  });
  assert.equal(unsigned.status, 401);
  assert.equal((await responseJson(unsigned)).code, "webhook_signature_missing");
  const unknown = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": "unknown",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  assert.equal(unknown.status, 409);
  assert.equal((await responseJson(unknown)).code, "workflow_target_unavailable");
});

test("a coordinator that settles before passing checkpoints fails the run and records an error", async (context) => {
  const secret = "premature-settlement-secret";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "premature",
      source: "generic",
      project: "test-project",
      target: "coordinator",
      secret,
      delivery: "followUp",
      promptTemplate: "Handle {{task}}",
      stages: [{ id: "gate", label: "Gate", instructions: "Run gate", requiredEvidence: ["result"], maxAttempts: 2 }],
    }],
  });
  const coordinator = mesh.makeClient("coordinator");
  await coordinator.start(async (event) => {
    if (event.type === "message") await coordinator.acknowledge(event.message.id);
  });
  const payload = JSON.stringify({ task: "premature" });
  const response = await fetch(`${mesh.address.url}/v1/webhooks/premature`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": "premature-1",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  const accepted = await response.json() as { run: { id: string; messageId: string } };
  await coordinator.reply(accepted.run.messageId, "I stopped early");
  const result = await coordinator.getWorkflow(accepted.run.id);
  assert.equal(result.run.status, "failed");
  assert.ok(result.journal.some((entry) => entry.category === "error" && entry.area === "workflow"));
  const lateJournal = await coordinator.recordWorkflowEntry(accepted.run.id, {
    category: "lesson",
    area: "workflow",
    summary: "Journal remains available after premature settlement",
  });
  assert.equal(lateJournal.category, "lesson");
  await assert.rejects(() => coordinator.checkpointWorkflow(accepted.run.id, {
    stageId: "gate",
    status: "passed",
    summary: "too late",
    evidence: ["result"],
  }), /workflow is failed/);
});

test("signed external signals resume, retry, deduplicate, and complete a settled workflow", async (context) => {
  const secret = "external-signal-secret-with-entropy";
  const signalSecret = "separate-callback-secret-with-entropy";
  const definition: WebhookWorkflowDefinition = {
    id: "external-signals",
    source: "github",
    project: "test-project",
    target: "coordinator",
    secret,
    signalSecret,
    delivery: "followUp",
    promptTemplate: "Handle PR {{pull_request.number}}",
    stages: [
      { id: "checks", label: "CI checks", instructions: "Wait for CI", requiredEvidence: ["check URL"], maxAttempts: 2 },
      { id: "merge", label: "Merge", instructions: "Wait for merge", requiredEvidence: ["merge URL"], maxAttempts: 2 },
    ],
  };
  const mesh = await createTestMesh(context, { webhookWorkflows: [definition] });
  const messages: string[] = [];
  const messageIds: string[] = [];
  const coordinator = mesh.makeClient("coordinator");
  await coordinator.start(async (event) => {
    if (event.type !== "message") return;
    messages.push(event.message.content);
    messageIds.push(event.message.id);
    await coordinator.acknowledge(event.message.id);
  });
  const startBody = JSON.stringify({ pull_request: { number: 42 } });
  const started = await fetch(`${mesh.address.url}/v1/webhooks/external-signals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "workflow-start-42",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(startBody).digest("hex")}`,
    },
    body: startBody,
  });
  const startedBody = await started.json() as { run: { id: string; messageId: string } };
  const runId = startedBody.run.id;
  await waitFor(() => messageIds.length === 1);
  const wait = await coordinator.waitForWorkflowSignal(runId, {
    stageId: "checks",
    signalKey: "github-pr-42-checks",
    summary: "GitHub Actions is running",
    timeoutMs: 60_000,
  });
  assert.equal(wait.run.status, "waiting");
  await coordinator.reply(startedBody.run.messageId, "Waiting for CI callback");
  assert.equal((await coordinator.getWorkflow(runId)).run.status, "waiting");

  const signal = (signalKey: string, deliveryId: string, body: string, signature?: string) => fetch(
    `${mesh.address.url}/v1/webhooks/external-signals/runs/${runId}/signals/${signalKey}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signature
          ?? `sha256=${createHmac("sha256", signalSecret).update(body).digest("hex")}`,
      },
      body,
    },
  );
  const passedChecks = JSON.stringify({
    status: "passed",
    summary: "CI passed",
    evidence: ["https://ci.example/pr/42"],
  });
  assert.equal((await signal("github-pr-42-checks", "bad-signature", passedChecks, "sha256=bad")).status, 401);
  assert.equal((await signal(
    "github-pr-42-checks",
    "start-secret-cannot-signal",
    passedChecks,
    `sha256=${createHmac("sha256", secret).update(passedChecks).digest("hex")}`,
  )).status, 401);
  assert.equal((await signal("wrong-key", "wrong-key", passedChecks)).status, 409);
  const resumed = await signal("github-pr-42-checks", "checks-passed", passedChecks);
  assert.equal(resumed.status, 202);
  const resumedPayload = await resumed.json() as Record<string, unknown>;
  assert.equal(resumedPayload.resumed, true);
  assert.equal("run" in resumedPayload, false);
  assert.equal("message" in resumedPayload, false);
  assert.equal("receipt" in resumedPayload, false);
  await waitFor(() => messageIds.length === 2);
  assert.match(messages[1]!, /CI passed/);
  let current = await coordinator.getWorkflow(runId);
  assert.equal(current.run.status, "running");
  assert.equal(current.run.currentStage, "merge");
  const duplicate = await signal("github-pr-42-checks", "checks-passed", passedChecks);
  assert.equal(duplicate.status, 200);
  const duplicatePayload = await duplicate.json() as Record<string, unknown>;
  assert.equal(duplicatePayload.duplicate, true);
  assert.equal("run" in duplicatePayload, false);
  assert.equal("message" in duplicatePayload, false);
  assert.equal(messageIds.length, 2);
  const conflictingDelivery = JSON.stringify({
    status: "failed",
    summary: "Conflicting reuse",
    evidence: ["https://ci.example/pr/42/conflict"],
  });
  assert.equal((await signal("github-pr-42-checks", "checks-passed", conflictingDelivery)).status, 409);

  await coordinator.waitForWorkflowSignal(runId, {
    stageId: "merge",
    signalKey: "github-pr-42-merge",
    summary: "Merge queue is running",
  });
  await coordinator.reply(messageIds[1]!, "Waiting for merge queue");
  const failedMerge = JSON.stringify({
    status: "failed",
    summary: "Branch protection rejected the merge",
    evidence: ["https://github.example/pr/42#protection"],
  });
  const retry = await signal("github-pr-42-merge", "merge-failed", failedMerge);
  assert.equal(retry.status, 202);
  await waitFor(() => messageIds.length === 3);
  current = await coordinator.getWorkflow(runId);
  assert.equal(current.run.status, "running");
  assert.equal(current.run.stages[1]!.attempts, 1);
  assert.ok(current.journal.some((entry) => entry.summary.includes("Branch protection")));

  await coordinator.waitForWorkflowSignal(runId, {
    stageId: "merge",
    signalKey: "github-pr-42-merge-rerun",
    summary: "Merge queue retry is running",
  });
  await coordinator.reply(messageIds[2]!, "Waiting for merge retry");
  const passedMerge = JSON.stringify({
    status: "passed",
    summary: "PR merged",
    evidence: ["https://github.example/pr/42/merge"],
  });
  const completed = await signal("github-pr-42-merge-rerun", "merge-passed", passedMerge);
  assert.equal(completed.status, 200);
  current = await coordinator.getWorkflow(runId);
  assert.equal(current.run.status, "completed");
  assert.equal(current.run.signalReceipts?.length, 3);
});

test("an expired external signal wait fails durably and records the timeout", async (context) => {
  const secret = "external-timeout-secret-value";
  const mesh = await createTestMesh(context, {
    cleanupIntervalMs: 20,
    webhookWorkflows: [{
      id: "external-timeout",
      source: "generic",
      project: "test-project",
      target: "coordinator",
      secret,
      delivery: "followUp",
      promptTemplate: "Wait for {{task}}",
      stages: [{ id: "gate", label: "External gate", instructions: "Wait", requiredEvidence: [], maxAttempts: 1 }],
    }],
  });
  const messageIds: string[] = [];
  const messages: string[] = [];
  const coordinator = mesh.makeClient("coordinator");
  await coordinator.start(async (event) => {
    if (event.type !== "message") return;
    messageIds.push(event.message.id);
    messages.push(event.message.content);
    await coordinator.acknowledge(event.message.id);
  });
  const payload = JSON.stringify({ task: "slow-check" });
  const response = await fetch(`${mesh.address.url}/v1/webhooks/external-timeout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": "timeout-start",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  const started = await response.json() as { run: { id: string } };
  await waitFor(() => messageIds.length === 1);
  await coordinator.waitForWorkflowSignal(started.run.id, {
    stageId: "gate",
    signalKey: "slow-check",
    summary: "Waiting for a bounded external check",
    timeoutMs: 1_000,
  });
  await coordinator.reply(messageIds[0]!, "Waiting for callback");
  await waitFor(() => mesh.hub.state.workflowRuns.get(started.run.id)?.status === "failed", 2_500);
  await waitFor(() => messageIds.length === 2);
  const result = await coordinator.getWorkflow(started.run.id);
  assert.equal(result.run.waiting, undefined);
  assert.equal(result.run.stages[0]!.status, "failed");
  assert.ok(result.journal.some((entry) => entry.summary.includes("timed out")));
  assert.equal(result.run.messageId, messageIds[1]);
  assert.match(messages[1]!, /failed while waiting for external signal slow-check/);
});

test("webhook prompts queue for a known offline coordinator and deliver after identity resumption", async (context) => {
  const secret = "offline-coordinator-secret";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "offline",
      source: "generic",
      project: "test-project",
      target: "coordinator",
      secret,
      delivery: "followUp",
      promptTemplate: "Resume {{task}}",
      stages: [{ id: "resume", label: "Resume", instructions: "Resume", requiredEvidence: [], maxAttempts: 1 }],
    }],
  });
  const first = mesh.makeClient("coordinator");
  await first.start(() => undefined);
  const durableId = first.agent!.id;
  await first.stop();
  const payload = JSON.stringify({ task: "OFFLINE-1" });
  const accepted = await fetch(`${mesh.address.url}/v1/webhooks/offline`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": "offline-1",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  assert.equal(accepted.status, 202);
  let delivered = false;
  const resumed = mesh.makeClient("coordinator");
  await resumed.start(async (event) => {
    if (event.type === "message") delivered = event.message.content.includes("OFFLINE-1");
  });
  assert.equal(resumed.agent!.id, durableId);
  await waitFor(() => delivered);
});
