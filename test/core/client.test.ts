import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { HubClient } from "../../plugins/kxm/src/client.ts";
import { createMeshHub } from "../../plugins/kxm/src/hub.ts";
import { createTestMesh, waitFor } from "../helpers.ts";

test("client lifecycle prevents double start and makes stop idempotent", async (context) => {
  const mesh = await createTestMesh(context);
  const client = mesh.makeClient("lifecycle");
  await client.start(() => undefined);
  await assert.rejects(() => client.start(() => undefined), /already started/);
  await client.stop();
  await client.stop();
  assert.equal(client.agent, undefined);
});

test("awaitResponse supports cancellation and timeout", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("sender");
  const receiver = mesh.makeClient("receiver");
  await Promise.all([sender.start(() => undefined), receiver.start(() => undefined)]);
  const message = await sender.send({ target: "receiver", content: "wait" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30).unref();
  await assert.rejects(() => sender.awaitResponse(message.id, 2_000, controller.signal), /await cancelled/);
  await assert.rejects(() => sender.awaitResponse(message.id, 100), /timed out/);
});

test("fanout timeouts return durable pending handles and exact retries reuse the request", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("fanout-sender");
  const receiver = mesh.makeClient("fanout-receiver");
  await receiver.start(async (event) => {
    if (event.type === "message") await receiver.acknowledge(event.message.id);
  });
  await sender.start(() => undefined);

  const options = {
    targets: ["fanout-receiver"],
    content: "Review this asynchronously",
    correlationId: "durable-timeout",
    idempotencyKeyPrefix: "durable-timeout:review",
    ttlMs: 5_000,
    timeoutMs: 50,
  };
  const [pending] = await sender.fanout(options);
  assert.ok(pending);
  assert.equal(pending.status, "pending");
  assert.ok(pending.messageStatus === "queued" || pending.messageStatus === "delivered");
  assert.equal(pending.waitStatus, "timed_out");
  assert.ok(pending.messageId);
  assert.ok(pending.expiresAt && Date.parse(pending.expiresAt) > Date.now());
  assert.equal(mesh.hub.state.messages.size, 1);
  const [durableMessage] = [...mesh.hub.state.messages.values()];
  const legacyScope = JSON.stringify({
    prefix: options.idempotencyKeyPrefix,
    correlationId: options.correlationId,
    target: options.targets[0],
  });
  assert.equal(
    durableMessage!.idempotencyKey,
    `fanout:${createHash("sha256").update(legacyScope).digest("hex")}`,
  );

  await receiver.reply(pending.messageId, "late review complete");
  const [retried] = await sender.fanout(options);
  assert.ok(retried);
  assert.equal(retried.messageId, pending.messageId);
  assert.equal(retried.status, "replied");
  assert.equal(retried.reply, "late review complete");
  assert.equal(mesh.hub.state.messages.size, 1);
});

test("fanout performs a final read at the timeout boundary", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("race-sender");
  const receiver = mesh.makeClient("race-receiver");
  await Promise.all([sender.start(() => undefined), receiver.start(() => undefined)]);
  const originalGetMessage = sender.getMessage.bind(sender);
  let reads = 0;
  sender.getMessage = async (messageId) => {
    reads += 1;
    if (reads === 2) await receiver.reply(messageId, "reply at deadline");
    return await originalGetMessage(messageId);
  };

  const [result] = await sender.fanout({
    targets: ["race-receiver"],
    content: "Race the local deadline",
    timeoutMs: 20,
  });
  assert.ok(result);
  assert.equal(reads, 2);
  assert.equal(result.status, "replied");
  assert.equal(result.reply, "reply at deadline");
});

test("fanout abort returns promptly while preserving every sent message handle", async (context) => {
  const mesh = await createTestMesh(context);
  const sender = mesh.makeClient("abort-sender");
  const receiver = mesh.makeClient("abort-receiver");
  await receiver.start(async (event) => {
    if (event.type === "message") await receiver.acknowledge(event.message.id);
  });
  await sender.start(() => undefined);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30).unref();

  const startedAt = Date.now();
  const [pending] = await sender.fanout({
    targets: ["abort-receiver"],
    content: "Keep this request durable",
    timeoutMs: 2_000,
    signal: controller.signal,
  });
  assert.ok(pending);
  assert.equal(pending.status, "pending");
  assert.equal(pending.waitStatus, "aborted");
  assert.ok(pending.messageId);
  assert.ok(pending.messageStatus === "queued" || pending.messageStatus === "delivered");
  assert.ok(pending.expiresAt);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(mesh.hub.state.messages.size, 1);
});

test("client registration fails with a bounded request timeout", async (context) => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new HubClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    name: "timeout",
    purpose: "test",
    project: "test",
    requestTimeoutMs: 50,
  });
  await assert.rejects(() => client.start(() => undefined), /request timed out after 50ms/);
});

test("client rejects invalid JSON hub responses", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" }).end("not-json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new HubClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    name: "invalid-json",
    purpose: "test",
    project: "test",
  });
  await assert.rejects(() => client.start(() => undefined), /returned invalid JSON/);
});

test("event loop automatically re-registers after an in-memory hub restart", async (context) => {
  const token = "restart-token";
  const firstHub = createMeshHub({ host: "127.0.0.1", port: 0, authToken: token, rateLimit: false });
  const firstAddress = await firstHub.start();
  const client = new HubClient({
    serverUrl: firstAddress.url,
    authToken: token,
    name: "restartable",
    purpose: "test recovery",
    project: "restart",
    heartbeatMs: 50,
    reconnectMs: 20,
    requestTimeoutMs: 500,
  });
  await client.start(() => undefined);
  const firstId = client.agent!.id;
  await firstHub.close();

  const secondHub = createMeshHub({
    host: "127.0.0.1",
    port: firstAddress.port,
    authToken: token,
    rateLimit: false,
  });
  context.after(async () => {
    await client.stop();
    await secondHub.close();
  });
  await secondHub.start();
  await waitFor(() => Boolean(client.agent && client.agent.id !== firstId), 3_000);
  assert.equal(client.agent!.name, "restartable");
  assert.deepEqual((await client.listAgents()).map((agent) => agent.name), ["restartable"]);
});
