import { HubClient } from "../plugins/kxm/src/client.ts";
import { createMeshHub } from "../plugins/kxm/src/hub.ts";

const token = "local-example-token";
const hub = createMeshHub({ port: 0, authToken: token, rateLimit: false });
const address = await hub.start();
const planner = new HubClient({
  serverUrl: address.url,
  authToken: token,
  name: "example-planner",
  purpose: "Delegates a focused example task",
  project: "example",
});
const reviewer = new HubClient({
  serverUrl: address.url,
  authToken: token,
  name: "example-reviewer",
  purpose: "Returns a deterministic example review",
  project: "example",
});

try {
  await reviewer.start(async (event) => {
    if (event.type !== "message") return;
    await reviewer.acknowledge(event.message.id);
    await reviewer.reply(event.message.id, `Reviewed: ${event.message.content}`);
  });
  await planner.start(() => undefined);
  const peers = await planner.listAgents();
  const request = await planner.send({
    target: "example-reviewer",
    content: "Check the rollout plan",
    idempotencyKey: "example-roundtrip-1",
    ttlMs: 10_000,
  });
  const completed = await planner.awaitResponse(request.id, 3_000);
  process.stdout.write(`${JSON.stringify({
    peers: peers.map((peer) => peer.name),
    messageId: completed.id,
    status: completed.status,
    reply: completed.reply?.content,
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled([planner.stop(), reviewer.stop()]);
  await hub.close();
}
