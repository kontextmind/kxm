import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubClient, HubHttpError } from "../../plugins/kxm/src/client.ts";
import {
  ExternalEffectsLedger,
  claimSharedEffect,
  commitSharedEffect,
  computeEffectKey,
  deterministicRunBranch,
  effectRequiresHubLease,
  heartbeatSharedEffect,
} from "../../plugins/kxm/src/external-effects.ts";
import { createMeshHub } from "../../plugins/kxm/src/hub.ts";
import { MAX_BODY_BYTES, type AgentRecord } from "../../plugins/kxm/src/protocol.ts";
import type { WebhookWorkflowDefinition } from "../../plugins/kxm/src/workflow.ts";
import { createTestMesh, responseJson, waitFor } from "../helpers.ts";

interface RawIdentity {
  agent: AgentRecord;
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
    "x-kxm-agent-id": identity.agent.id,
    "x-kxm-agent-key": identity.agentKey,
  };
}

function sseData(response: Response): { next: () => Promise<Record<string, unknown>>; close: () => Promise<void> } {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: string[] = [];
  return {
    async next() {
      while (true) {
        const frame = frames.shift();
        if (frame !== undefined) {
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data) return JSON.parse(data) as Record<string, unknown>;
          continue;
        }
        const result = await reader.read();
        if (result.done) throw new Error("SSE stream ended before the next data frame");
        buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        frames.push(...parts);
      }
    },
    async close() {
      await reader.cancel();
    },
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
  const metricsText = await metrics.text();
  assert.match(metricsText, /kxm_requests_total/);
  assert.doesNotMatch(metricsText, /pi_mesh_/);
  assert.doesNotMatch(metricsText, /pi_kxm_/);
  assert.match(metricsText, /kxm_context_requests_total/);
  assert.match(metricsText, /kxm_attempt_latency_seconds_total/);
  assert.match(metricsText, /kxm_metered_cost_usd_total/);
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
      "x-kxm-agent-id": alpha.agent!.id,
      "x-kxm-agent-key": String((alpha as unknown as { agentKey: string }).agentKey),
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

test("agent listing reports host label, lease expiry, and offline members only when asked", async (context) => {
  const staleAfterMs = 150;
  // The sweep is parked far out on purpose: `stale` is exactly the window
  // between a lease expiring on the hub clock and the sweep retiring the
  // agent, so it can only be observed while the sweep has not run.
  const mesh = await createTestMesh(context, { staleAfterMs, cleanupIntervalMs: 60_000 });
  const { address, token } = mesh;

  const oversizedHost = await registerRaw(address.url, token, {
    name: "wide-host",
    purpose: "test",
    project: "test-project",
    host: "h".repeat(65),
  });
  assert.equal(oversizedHost.response.status, 400);

  const reader = (await registerRaw(address.url, token, {
    name: "reader", purpose: "read", project: "test-project", host: "box-a",
  })).identity!;
  const peer = (await registerRaw(address.url, token, {
    name: "peer", purpose: "work", project: "test-project", host: "box-b",
  })).identity!;
  await registerRaw(address.url, token, {
    name: "outsider", purpose: "work", project: "other-project", host: "box-c",
  });
  assert.equal(peer.agent.host, "box-b");

  const list = async (query = ""): Promise<AgentRecord[]> => {
    const response = await fetch(`${address.url}/v1/agents${query}`, { headers: identityHeaders(reader, token) });
    assert.equal(response.status, 200);
    return (await responseJson(response)).agents as AgentRecord[];
  };
  const find = (agents: AgentRecord[], id: string) => agents.find((agent) => agent.id === id);

  const online = await list();
  assert.deepEqual(online.map((agent) => agent.name).sort(), ["peer", "reader"]);
  for (const agent of online) {
    // The hub's own projection (not a wall-clock race): the agent is online because
    // its lease has not expired on the hub clock, and the lease is exactly
    // lastSeenAt + the configured staleAfterMs.
    assert.equal(agent.presence, "online", `${agent.name} should hold its lease`);
    assert.equal(Date.parse(agent.leaseExpiresAt!) - Date.parse(agent.lastSeenAt), staleAfterMs,
      `${agent.name} lease is exactly lastSeenAt + staleAfterMs`);
  }
  assert.equal(find(online, peer.agent.id)?.host, "box-b");

  // Presence and the lease are derived on read; the stored record grows by the
  // host label alone. This fixture runs the hub in memory (no SQLite file), so
  // the in-memory agent map IS the store; a file-backed variant would assert the
  // same fields on the `record` JSON column.
  const stored = mesh.hub.state.agents.get(peer.agent.id)!;
  assert.equal(stored.host, "box-b");
  assert.equal("presence" in stored, false);
  assert.equal("leaseExpiresAt" in stored, false);

  // The reader's own requests renew only the reader's lease, so the silent
  // peer's lease expires on the hub clock while it is still registered.
  await waitFor(async () => find(await list(), peer.agent.id)?.presence === "stale");
  const expired = find(await list(), peer.agent.id)!;
  assert.equal(expired.online, true, "a lease expires before the sweep retires the agent");
  assert.ok(Date.parse(expired.leaseExpiresAt ?? "") <= Date.now());

  const unregistered = await fetch(`${address.url}/v1/agents/${peer.agent.id}`, {
    method: "DELETE",
    headers: identityHeaders(peer, token),
  });
  assert.equal(unregistered.status, 204);

  assert.deepEqual((await list()).map((agent) => agent.name), ["reader"]);
  assert.deepEqual((await list("?includeOffline=false")).map((agent) => agent.name), ["reader"]);

  const withOffline = await list("?includeOffline=true");
  assert.deepEqual(withOffline.map((agent) => agent.name).sort(), ["peer", "reader"]);
  const offlinePeer = find(withOffline, peer.agent.id)!;
  assert.equal(offlinePeer.presence, "offline");
  assert.equal(offlinePeer.host, "box-b");
  assert.equal(Date.parse(offlinePeer.leaseExpiresAt ?? "") - Date.parse(offlinePeer.lastSeenAt), staleAfterMs);
  assert.equal(withOffline.some((agent) => agent.name === "outsider"), false, "offline members stay project-scoped");
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

  const spoofedAffinity = await sender.send({
    target: receiver.agent!.id,
    content: "caller affinity must be ignored",
    workflowRunId: `run_${"a".repeat(32)}`,
  } as Parameters<typeof sender.send>[0]);
  assert.equal(spoofedAffinity.workflowRunId, undefined);
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
    assert.ok(error instanceof HubHttpError);
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
  assert.match(metrics, /kxm_messages_purged_total 1/);
  assert.doesNotMatch(metrics, /pi_mesh_/);
  assert.doesNotMatch(metrics, /pi_kxm_/);
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
  const database = join(directory, "kxm.db");
  const token = "persistent-token";
  const hub1 = createMeshHub({ port: 0, authToken: token, dataPath: database, rateLimit: false });
  const address1 = await hub1.start();
  const sender1 = new HubClient({ serverUrl: address1.url, authToken: token, name: "sender", purpose: "send", project: "persist" });
  const receiver1 = new HubClient({ serverUrl: address1.url, authToken: token, name: "receiver", purpose: "receive", project: "persist" });
  await Promise.all([sender1.start(() => undefined), receiver1.start(() => undefined)]);
  const originalSenderId = sender1.agent!.id;
  const originalReceiverId = receiver1.agent!.id;
  const message = await sender1.send({ target: "receiver", content: "survive restart" });
  await Promise.all([sender1.stop(), receiver1.stop()]);
  await hub1.close();

  const hub2 = createMeshHub({ port: 0, authToken: token, dataPath: database, rateLimit: false });
  const address2 = await hub2.start();
  const sender2 = new HubClient({ serverUrl: address2.url, authToken: token, name: "sender", purpose: "send", project: "persist" });
  const receiver2 = new HubClient({ serverUrl: address2.url, authToken: token, name: "receiver", purpose: "receive", project: "persist" });
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

test("admin ops SSE publishes project-scoped metadata without message bodies", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("ops-sender");
  const receiver = mesh.makeClient("ops-receiver");
  await sender.start(() => undefined);
  await receiver.start(() => undefined);

  const unauthorized = await fetch(`${mesh.address.url}/v1/ops/snapshot?project=test-project`, {
    headers: { authorization: "Bearer wrong-token" },
  });
  assert.equal(unauthorized.status, 401);

  const headers = { authorization: `Bearer ${mesh.token}` };
  const eventsResponse = await fetch(`${mesh.address.url}/v1/ops/events?project=test-project`, { headers });
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = sseData(eventsResponse);
  context.after(() => events.close());
  const ready = await events.next();
  assert.deepEqual({ type: ready.type, project: ready.project, topic: ready.topic }, {
    type: "ops",
    project: "test-project",
    topic: "agents",
  });

  const bodyMarker = "BODY_MUST_NEVER_ENTER_OPS_OUTPUT";
  const sent = await sender.send({ target: "ops-receiver", content: bodyMarker, delivery: "followUp" });
  const queuedEvent = await events.next();
  assert.equal(queuedEvent.topic, "messages");
  assert.doesNotMatch(JSON.stringify(queuedEvent), new RegExp(bodyMarker));

  const queuedSnapshotResponse = await fetch(`${mesh.address.url}/v1/ops/snapshot?project=test-project`, { headers });
  assert.equal(queuedSnapshotResponse.status, 200);
  const queuedSnapshot = await responseJson(queuedSnapshotResponse) as unknown as {
    project: string;
    agents: Array<{ name: string }>;
    openMessages: Array<Record<string, unknown>>;
    openMessageTotal: number;
    runs: unknown[];
    runTotal: number;
  };
  assert.equal(queuedSnapshot.project, "test-project");
  assert.deepEqual(queuedSnapshot.agents.map((agent) => agent.name).sort(), ["ops-receiver", "ops-sender"]);
  assert.equal(queuedSnapshot.openMessageTotal, 1);
  assert.equal(queuedSnapshot.openMessages[0]?.id, sent.id);
  assert.equal(queuedSnapshot.openMessages[0]?.status, "queued");
  assert.equal("content" in queuedSnapshot.openMessages[0]!, false);
  assert.equal("reply" in queuedSnapshot.openMessages[0]!, false);
  assert.doesNotMatch(JSON.stringify(queuedSnapshot), new RegExp(bodyMarker));

  await receiver.acknowledge(sent.id);
  assert.equal((await events.next()).topic, "messages");
  await receiver.reply(sent.id, "REPLY_BODY_MUST_NOT_APPEAR");
  assert.equal((await events.next()).topic, "messages");
  const terminalSnapshot = await responseJson(await fetch(
    `${mesh.address.url}/v1/ops/snapshot?project=test-project`,
    { headers },
  )) as { openMessageTotal?: number };
  assert.equal(terminalSnapshot.openMessageTotal, 0);
  assert.doesNotMatch(JSON.stringify(terminalSnapshot), /BODY_MUST_NEVER|REPLY_BODY_MUST_NOT/);
});

test("legacy TUI fallback receives presence-only SSE and never queued message bodies", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("presence-sender");
  await sender.start(() => undefined);
  const observerRegistration = await registerRaw(mesh.address.url, mesh.token, {
    name: "presence-observer",
    purpose: "metadata observer",
    project: "test-project",
    model: "tui",
  });
  assert.equal(observerRegistration.response.status, 201);
  const observer = observerRegistration.identity!;
  const eventsResponse = await fetch(
    `${mesh.address.url}/v1/events?agentId=${encodeURIComponent(observer.agent.id)}&presenceOnly=true`,
    { headers: identityHeaders(observer, mesh.token) },
  );
  assert.equal(eventsResponse.status, 200);
  assert.equal(eventsResponse.headers.get("x-kxm-events-mode"), "presence");
  const events = sseData(eventsResponse);
  context.after(() => events.close());
  await events.next(); // ready

  const bodyMarker = "PRESENCE_STREAM_MUST_NOT_LOAD_THIS_BODY";
  const queued = await sender.send({ target: observer.agent.id, content: bodyMarker });
  const newcomer = mesh.makeClient("presence-newcomer");
  await newcomer.start(() => undefined);
  const presence = await events.next();
  assert.equal(presence.type, "presence");
  assert.equal((presence.agent as { name?: string }).name, "presence-newcomer");
  assert.doesNotMatch(JSON.stringify(presence), new RegExp(bodyMarker));
  assert.equal(mesh.hub.state.messages.get(queued.id)?.status, "queued");
});

test("operations metadata requires a configured admin credential even on loopback", async (context) => {
  const mesh = await createTestMesh(context, { authToken: "" });
  const response = await fetch(`${mesh.address.url}/v1/ops/snapshot?project=test-project`);
  assert.equal(response.status, 503);
  assert.equal((await responseJson(response)).code, "admin_auth_not_configured");
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
  const sent = entries.find((entry) => entry.event === "message_sent");
  const replied = entries.find((entry) => entry.event === "message_replied");
  assert.equal(sent?.fromName, "sender");
  assert.equal(sent?.toName, "receiver");
  assert.equal(sent?.status, "queued");
  assert.equal(sent?.fromOnline, true);
  assert.equal(sent?.toOnline, true);
  assert.equal(replied?.fromName, "receiver");
  assert.equal(replied?.toName, "sender");
  assert.equal(replied?.status, "replied");
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
  assert.equal(mesh.hub.state.messages.get(acceptedBody.run.messageId)?.workflowRunId, runId);
  await waitFor(() => inbound?.includes("PROD-42") ?? false);
  assert.match(inbound!, /kxm_workflow_record/);
  assert.equal((await sendWebhook("jira-delivery-42")).status, 200);
  assert.equal((await coordinator.listWorkflows()).length, 1);
  await assert.rejects(() => observer.getWorkflow(runId), (error: unknown) => {
    assert.ok(error instanceof HubHttpError);
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
    evidence: { trace: "first" },
  });
  assert.equal(retry.retry, true);
  assert.match(retry.instruction, /Correct/);
  const advance = await coordinator.checkpointWorkflow(runId, {
    stageId: "reproduce",
    status: "passed",
    summary: "Reproduced with a failing test",
    evidence: { "failing test": "test:checkout.spec.ts" },
  });
  assert.equal(advance.run.currentStage, "quality");
  const complete = await coordinator.checkpointWorkflow(runId, {
    stageId: "quality",
    status: "passed",
    summary: "All repository gates passed",
    evidence: {
      lint: "pass",
      build: "pass",
      security: "pass",
      playwright: "pass",
    },
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
  assert.ok(Array.isArray(report.signals));
  assert.ok(report.signals.length >= 1);
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
    headers: { "content-type": "application/json", "x-kxm-delivery-id": "unsigned" },
    body: payload,
  });
  assert.equal(unsigned.status, 401);
  assert.equal((await responseJson(unsigned)).code, "webhook_signature_missing");
  const unknown = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kxm-delivery-id": "unknown",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  assert.equal(unknown.status, 409);
  assert.equal((await responseJson(unknown)).code, "workflow_target_unavailable");
});

test("a coordinator that settles before passing checkpoints fails the run and records an error", async (context) => {
  const assetsDir = mkdtempSync(join(tmpdir(), "pi-mesh-premature-"));
  context.after(() => rmSync(assetsDir, { recursive: true, force: true }));
  const secret = "premature-settlement-secret";
  const mesh = await createTestMesh(context, {
    assetsDir,
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
      "x-kxm-delivery-id": "premature-1",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  const accepted = await response.json() as { run: { id: string; messageId: string } };
  await coordinator.reply(accepted.run.messageId, "I stopped early");
  const result = await coordinator.getWorkflow(accepted.run.id);
  assert.equal(result.run.status, "failed");
  assert.ok(result.journal.some((entry) => entry.category === "error" && entry.area === "workflow"));
  const settlementError = result.journal.find((entry) => entry.category === "error" && entry.area === "workflow");
  assert.equal(settlementError?.stageId, "gate");
  assert.equal(settlementError?.attempt, 1);
  const lateJournal = await coordinator.recordWorkflowEntry(accepted.run.id, {
    category: "lesson",
    area: "workflow",
    summary: "Journal remains available after premature settlement",
    evidence: ["class:premature_settlement"],
  });
  assert.equal(lateJournal.category, "lesson");
  // Late entries and promotions refresh the terminal run's retrospective.
  const retrospectivePath = join(assetsDir, "retrospectives", `${accepted.run.id}.json`);
  const readRetrospective = () => JSON.parse(readFileSync(retrospectivePath, "utf8")) as {
    entries: Array<{ id: string; promotionState?: string }>;
  };
  assert.ok(readRetrospective().entries.some((entry) => entry.id === lateJournal.id));
  const skillCandidate = await coordinator.recordWorkflowEntry(accepted.run.id, {
    category: "skill-candidate",
    area: "workflow",
    summary: "Checkpoint every stage before settling the turn",
    evidence: ["receipt:premature-1/verify"],
  });
  const promotion = await fetch(`${mesh.address.url}/v1/journal/${skillCandidate.id}/promotion`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mesh.token}` },
    body: JSON.stringify({ to: "approved", evidenceRefs: ["eval:static-review", "eval:sandbox"], reason: "protected eval passed" }),
  });
  assert.equal(promotion.status, 200);
  assert.equal(
    readRetrospective().entries.find((entry) => entry.id === skillCandidate.id)?.promotionState,
    "approved",
  );
  await assert.rejects(() => coordinator.checkpointWorkflow(accepted.run.id, {
    stageId: "gate",
    status: "passed",
    summary: "too late",
    evidence: { result: "too late" },
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
      { id: "checks", label: "CI checks", instructions: "Wait for CI", requiredEvidence: ["local review", "github.check:ci"], maxAttempts: 2 },
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
    evidence: { "local review": "review.md" },
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
    evidence: { "github.check:ci": "https://ci.example/pr/42" },
  });
  assert.equal((await signal("github-pr-42-checks", "bad-signature", passedChecks, "sha256=bad")).status, 401);
  assert.equal((await signal(
    "github-pr-42-checks",
    "start-secret-cannot-signal",
    passedChecks,
    `sha256=${createHmac("sha256", secret).update(passedChecks).digest("hex")}`,
  )).status, 401);
  assert.equal((await signal("wrong-key", "wrong-key", passedChecks)).status, 409);
  for (const [contextKey, invalidValue] of [
    ["workflow.run", "run_wrong"],
    ["workflow.stage", "merge"],
    ["workflow.signal", "github-pr-42-other"],
  ] as const) {
    const mismatchedContext = JSON.stringify({
      status: "passed",
      summary: `Reject mismatched ${contextKey}`,
      evidence: {
        "github.check:ci": "https://ci.example/pr/42",
        [contextKey]: invalidValue,
      },
    });
    const rejected = await signal(
      "github-pr-42-checks",
      `mismatched-${contextKey}`,
      mismatchedContext,
    );
    assert.equal(rejected.status, 409);
    const rejectedBody = await responseJson(rejected) as { code?: string; contextKey?: string };
    assert.equal(rejectedBody.code, "workflow_signal_context_mismatch");
    assert.equal(rejectedBody.contextKey, contextKey);
    const unchanged = await coordinator.getWorkflow(runId);
    assert.equal(unchanged.run.status, "waiting");
    assert.equal(unchanged.run.currentStage, "checks");
    assert.equal(unchanged.run.signalReceipts?.length ?? 0, 0);
  }
  const unrelatedVolume = JSON.stringify({
    status: "passed",
    summary: "Context and check volume cannot replace named evidence",
    evidence: {
      "workflow.run": runId,
      "workflow.stage": "checks",
      "workflow.signal": "github-pr-42-checks",
      "github.check:build": "pass",
      "github.check:lint": "pass",
      "github.check:test": "pass",
    },
  });
  const incomplete = await signal("github-pr-42-checks", "unrelated-volume", unrelatedVolume);
  assert.equal(incomplete.status, 400);
  const incompleteBody = await responseJson(incomplete) as { code?: string; missingRequirements?: string[] };
  assert.equal(incompleteBody.code, "workflow_evidence_incomplete");
  assert.deepEqual(incompleteBody.missingRequirements, ["github.check:ci"]);
  assert.equal((await coordinator.getWorkflow(runId)).run.status, "waiting");
  const resumed = await signal("github-pr-42-checks", "checks-passed", passedChecks);
  assert.equal(resumed.status, 202);
  const resumedPayload = await resumed.json() as Record<string, unknown>;
  assert.equal(resumedPayload.resumed, true);
  assert.equal("run" in resumedPayload, false);
  assert.equal("message" in resumedPayload, false);
  assert.equal("receipt" in resumedPayload, false);
  await waitFor(() => messageIds.length === 2);
  assert.equal(mesh.hub.state.messages.get(messageIds[1]!)?.workflowRunId, runId);
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
    evidence: { "github.check:ci": "https://ci.example/pr/42/conflict" },
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
    evidence: { "merge URL": "https://github.example/pr/42#protection" },
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
    evidence: { "merge URL": "https://github.example/pr/42/merge" },
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
      "x-kxm-delivery-id": "timeout-start",
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
      "x-kxm-delivery-id": "offline-1",
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

test("a peer request to a known offline agent queues, delivers once on resumption, and expires by its TTL", async (context) => {
  const mesh = await createTestMesh(context, { cleanupIntervalMs: 25 });
  const sender = mesh.makeClient("sender");
  const first = mesh.makeClient("receiver");
  await sender.start(() => undefined);
  await first.start(() => undefined);
  const durableId = first.agent!.id;
  await first.stop();

  await assert.rejects(
    () => sender.send({ target: "receiver", content: "must be online" }),
    (error: unknown) => {
      assert.ok(error instanceof HubHttpError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "target_not_found");
      return true;
    },
  );
  await assert.rejects(
    () => sender.send({ target: "missing", content: "unknown", allowOffline: true }),
    (error: unknown) => {
      assert.ok(error instanceof HubHttpError);
      assert.equal(error.code, "target_not_found");
      return true;
    },
  );

  const queued = await sender.send({
    target: "receiver",
    content: "OFFLINE-PEER-1",
    allowOffline: true,
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.to, durableId);
  assert.equal(queued.deliveredAt, undefined);
  assert.equal(mesh.hub.state.messages.get(queued.id)?.status, "queued");

  let deliveries = 0;
  const resumed = mesh.makeClient("receiver");
  await resumed.start(async (event) => {
    if (event.type === "message" && event.message.id === queued.id) deliveries += 1;
  });
  assert.equal(resumed.agent!.id, durableId);
  await waitFor(() => deliveries === 1);
  assert.equal(deliveries, 1);
  assert.equal(mesh.hub.state.messages.get(queued.id)?.status, "queued");

  // Acknowledge the delivered message so the cursor advances past it
  await resumed.acknowledge(queued.id);
  await resumed.stop();

  // A second reconnect must NOT replay the acknowledged message — a barrier
  // message proves once-only delivery: the barrier arrives, the old one does not
  const barrier = await sender.send({ target: "receiver", content: "BARRIER", allowOffline: true });
  let barrierDelivered = 0;
  let queuedReplayed = 0;
  const reconnect = mesh.makeClient("receiver");
  await reconnect.start(async (event) => {
    if (event.type === "message" && event.message.id === barrier.id) barrierDelivered += 1;
    if (event.type === "message" && event.message.id === queued.id) queuedReplayed += 1;
  });
  await waitFor(() => barrierDelivered === 1);
  assert.equal(barrierDelivered, 1, "the barrier message is delivered on reconnection");
  assert.equal(queuedReplayed, 0, "the acknowledged message is not replayed on reconnection");
  await reconnect.stop();

  // The expired message is never replayed either
  const shortLived = await sender.send({
    target: "receiver",
    content: "OFFLINE-PEER-EXPIRE",
    allowOffline: true,
    ttlMs: 1_000,
  });
  assert.equal(shortLived.status, "queued");
  await waitFor(async () => (await sender.getMessage(shortLived.id)).status === "expired", 2_000);
  const expired = await sender.getMessage(shortLived.id);
  assert.equal(expired.status, "expired");
  assert.match(expired.error ?? "", /expired/);

  // Reconnect after expiry: the expired message must not arrive
  let expiredReplayed = 0;
  const postExpiry = mesh.makeClient("receiver");
  await postExpiry.start(async (event) => {
    if (event.type === "message" && event.message.id === shortLived.id) expiredReplayed += 1;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(expiredReplayed, 0, "the expired message is not replayed on reconnection");
  await postExpiry.stop();
});

test("a shared external effect cannot commit with a fencing token the hub has superseded", async (context) => {
  // Expiry is the hub's clock, so the test moves that clock rather than sleeping
  // through a real TTL or guessing at elapsed time.
  let hubClockMs = Date.parse("2026-04-01T00:00:00.000Z");
  const mesh = await createTestMesh(context, { now: () => hubClockMs });
  const boxA = mesh.makeClient("pusher-a");
  const boxB = mesh.makeClient("pusher-b");
  await boxA.start(() => undefined);
  await boxB.start(() => undefined);

  // Two boxes, two ledgers: neither can see the other's receipts, so the hub
  // lease is the only thing standing between them and the same push.
  const ledgerA = new ExternalEffectsLedger(":memory:");
  const ledgerB = new ExternalEffectsLedger(":memory:");
  context.after(() => {
    ledgerA.close();
    ledgerB.close();
  });

  const targetRef = "refs/heads/main";
  const runA = "run_aaaaaaaa";
  const runB = "run_bbbbbbbb";
  const leaseResource = "test-project/refs/heads/main";
  const shared = { stepId: "push", actionKind: "git-push", targetRef, leaseTtlMs: 5_000 } as const;

  // Only genuinely shared targets take a lease. This run's own branch, and the
  // kinds that write a namespace the run already owns, stay lease-free.
  assert.equal(effectRequiresHubLease("git-push", deterministicRunBranch(runA), runA), false);
  assert.equal(effectRequiresHubLease("git-branch", targetRef, runA), false);
  assert.equal(effectRequiresHubLease("git-commit", targetRef, runA), false);
  assert.equal(effectRequiresHubLease("git-push", targetRef, runA), true);
  assert.equal(effectRequiresHubLease("pr-create", "kontextmind/kxm#274", runA), true);

  const claimA = await claimSharedEffect({ ledger: ledgerA, lease: boxA, runId: runA, attemptId: "att_a1", ...shared });
  if (!claimA.ok) throw new Error(`box A should have taken the lease: ${claimA.error}`);
  assert.equal(claimA.fencingToken, 1);
  assert.equal(claimA.leaseResource, leaseResource);
  const openReceipt = ledgerA.getReceipt(claimA.effectKey)!;
  assert.equal(openReceipt.status, "in-flight");
  assert.equal(openReceipt.leaseResource, leaseResource);
  assert.equal(openReceipt.fencingToken, 1);

  // The rival is refused before it claims anything: no ledger row, nothing executed.
  const contended = await claimSharedEffect({ ledger: ledgerB, lease: boxB, runId: runB, attemptId: "att_b1", ...shared });
  assert.equal(contended.ok, false);
  assert.equal(!contended.ok && contended.code, "effect_lease_held");
  assert.equal(ledgerB.getReceipt(computeEffectKey(runB, "push", "git-push", targetRef)), undefined);

  // The Q6 heartbeat renews the hub lease under the same token.
  hubClockMs += 3_000;
  const beat = await heartbeatSharedEffect({ ledger: ledgerA, lease: boxA, effectKey: claimA.effectKey, leaseTtlMs: 5_000 });
  if (!beat.ok) throw new Error(`the holder's heartbeat should renew: ${beat.error}`);
  assert.equal(beat.leaseExpiresAt, new Date(hubClockMs + 5_000).toISOString());
  assert.equal(ledgerA.getReceipt(claimA.effectKey)?.fencingToken, 1, "a renewal never moves the token");

  // Past the deadline the resource is free again, and the takeover — the only
  // thing that moves the token — hands box B token 2.
  hubClockMs += 6_000;
  const takeover = await claimSharedEffect({ ledger: ledgerB, lease: boxB, runId: runB, attemptId: "att_b2", ...shared });
  if (!takeover.ok) throw new Error(`the TTL should have freed the resource: ${takeover.error}`);
  assert.equal(takeover.fencingToken, 2);
  assert.equal(takeover.leaseResource, leaseResource);

  // Box A comes back and tries to land its push. The hub has superseded its
  // token, so the commit is refused: the effect stays in-flight and the attempt
  // parks uncertain, because nobody can prove whether the push landed.
  const lateCommit = await commitSharedEffect({
    ledger: ledgerA,
    lease: boxA,
    effectKey: claimA.effectKey,
    receiptPayload: { pushedSha: "deadbeef" },
  });
  assert.equal(lateCommit.ok, false);
  assert.equal(!lateCommit.ok && lateCommit.code, "effect_lease_superseded");
  assert.equal(!lateCommit.ok && lateCommit.attemptState, "blocked_uncertain");
  const parked = ledgerA.getReceipt(claimA.effectKey)!;
  assert.equal(parked.status, "uncertain", "the uncertainty is persisted, not just returned");
  assert.equal(parked.completedAt, undefined);
  assert.equal(parked.fencingToken, 1, "nothing re-acquired on the loser's behalf");
  assert.deepEqual(parked.receiptPayload, {}, "a refused commit writes no receipt payload");

  // Nothing retries: the resource belongs to box B until B is done with it.
  const stillHeld = await boxA.acquireLease(targetRef, 5_000).then(
    () => undefined,
    (error: unknown) => error as HubHttpError,
  );
  assert.equal(stillHeld?.statusCode, 409);
  assert.equal(stillHeld?.code, "lease_held");
  assert.equal((stillHeld?.extras?.lease as { fencingToken?: number } | undefined)?.fencingToken, 2);

  // The winner commits under the token the hub actually holds.
  const winner = await commitSharedEffect({
    ledger: ledgerB,
    lease: boxB,
    effectKey: takeover.effectKey,
    receiptPayload: { pushedSha: "cafebabe" },
  });
  if (!winner.ok) throw new Error(`the lease holder should commit: ${winner.error}`);
  assert.equal(winner.receipt.status, "committed");
  assert.equal(winner.receipt.leaseResource, leaseResource);
  assert.equal(winner.receipt.fencingToken, 2);
  assert.deepEqual(winner.receipt.receiptPayload, { pushedSha: "cafebabe" });

  // A clean release ends the fence — there is no stale writer left to keep a
  // token for — so the next holder starts over at 1.
  const afterRelease = await boxA.acquireLease(targetRef, 5_000);
  assert.equal(afterRelease.lease.fencingToken, 1);
  assert.equal(afterRelease.lease.holderAgentId, boxA.agent!.id);
  await boxA.releaseLease(targetRef, afterRelease.lease.fencingToken);

  // A shared effect never executes unfenced: an unreachable hub refuses the
  // claim outright rather than falling back to running it.
  const unreachable = new HubClient({
    serverUrl: "http://127.0.0.1:9",
    name: "orphan",
    purpose: "a client whose hub is gone",
    project: "test-project",
    requestTimeoutMs: 250,
  });
  const offlineHub = await claimSharedEffect({
    ledger: ledgerB,
    lease: unreachable,
    runId: "run_cccccccc",
    attemptId: "att_c1",
    ...shared,
  });
  assert.equal(offlineHub.ok, false);
  assert.equal(!offlineHub.ok && offlineHub.code, "effect_lease_unavailable");
  assert.equal(ledgerB.getReceipt(computeEffectKey("run_cccccccc", "push", "git-push", targetRef)), undefined);
});
