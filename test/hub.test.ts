import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MeshClient } from "../src/client.ts";
import { createMeshHub, type MeshHub } from "../src/hub.ts";

const resources: Array<{ hub: MeshHub; clients: MeshClient[] }> = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()!;
    await Promise.all(resource.clients.map((client) => client.stop()));
    await resource.hub.close();
  }
});

async function setup() {
  const token = "test-token";
  const hub = createMeshHub({ port: 0, authToken: token });
  const address = await hub.start();
  const clients: MeshClient[] = [];
  resources.push({ hub, clients });
  const makeClient = (name: string) => {
    const client = new MeshClient({
      serverUrl: address.url,
      authToken: token,
      name,
      purpose: `${name} purpose`,
      project: "test-project",
      heartbeatMs: 100,
      reconnectMs: 20,
    });
    clients.push(client);
    return client;
  };
  return { hub, address, token, makeClient };
}

test("agents discover peers and complete a request/reply round trip", async () => {
  const { makeClient } = await setup();
  const planner = makeClient("planner");
  const reviewer = makeClient("reviewer");
  await reviewer.start(async (event) => {
    if (event.type !== "message") return;
    await reviewer.acknowledge(event.message.id);
    await reviewer.reply(event.message.id, `reviewed: ${event.message.content}`);
  });
  await planner.start(() => undefined);

  const agents = await planner.listAgents();
  assert.deepEqual(agents.map((agent) => agent.name).sort(), ["planner", "reviewer"]);

  const sent = await planner.send({ target: "reviewer", content: "check the plan" });
  const completed = await planner.awaitResponse(sent.id, 3_000);
  assert.equal(completed.status, "replied");
  assert.equal(completed.reply?.content, "reviewed: check the plan");
  assert.equal(completed.delivery, "followUp");
});

test("hub rejects invalid authentication", async () => {
  const { address } = await setup();
  const response = await fetch(`${address.url}/v1/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ name: "intruder", purpose: "none", project: "test-project" }),
  });
  assert.equal(response.status, 401);
});

test("duplicate live names are rejected within a project", async () => {
  const { makeClient } = await setup();
  const first = makeClient("builder");
  const duplicate = makeClient("builder");
  await first.start(() => undefined);
  await assert.rejects(() => duplicate.start(() => undefined), /already active/);
});

