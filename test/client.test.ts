import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { MeshClient } from "../plugins/pi-mesh-comms/src/client.ts";
import { createMeshHub } from "../plugins/pi-mesh-comms/src/hub.ts";
import { createTestMesh, waitFor } from "./helpers.ts";

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

test("client registration fails with a bounded request timeout", async (context) => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new MeshClient({
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
  const client = new MeshClient({
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
  const client = new MeshClient({
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
