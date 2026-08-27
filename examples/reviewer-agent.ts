import { MeshClient } from "../plugins/kxm-mesh/src/client.ts";

const serverUrl = process.env.PI_MESH_SERVER_URL ?? "http://127.0.0.1:7331";
const authToken = process.env.PI_MESH_AUTH_TOKEN;
const project = process.env.PI_MESH_PROJECT ?? "example";
const client = new MeshClient({
  serverUrl,
  name: process.env.PI_MESH_AGENT_NAME ?? "example-reviewer",
  purpose: process.env.PI_MESH_AGENT_PURPOSE ?? "Demonstrates a custom mesh client",
  project,
  ...(authToken ? { authToken } : {}),
});

await client.start(async (event) => {
  if (event.type !== "message") return;
  await client.acknowledge(event.message.id);
  process.stdout.write(`request from ${event.message.fromName}: ${event.message.content}\n`);
  await client.reply(event.message.id, `Example client received: ${event.message.content}`);
});

process.stdout.write(`reviewer connected as ${client.agent!.name} in ${project}\n`);

async function shutdown(): Promise<void> {
  await client.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
