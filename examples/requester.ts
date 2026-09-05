import { randomUUID } from "node:crypto";
import { HubClient } from "../plugins/kxm/src/client.ts";

const [target, ...contentParts] = process.argv.slice(2);
if (!target || contentParts.length === 0) {
  throw new Error("usage: requester.ts <target> <request text>");
}

const authToken = process.env.KXM_AUTH_TOKEN;
const client = new HubClient({
  serverUrl: process.env.KXM_SERVER_URL ?? "http://127.0.0.1:7331",
  name: process.env.KXM_AGENT_NAME ?? `example-requester-${process.pid}`,
  purpose: process.env.KXM_AGENT_PURPOSE ?? "Sends a request from the command line",
  project: process.env.KXM_PROJECT ?? "example",
  ...(authToken ? { authToken } : {}),
});

try {
  await client.start(() => undefined);
  const request = await client.send({
    target,
    content: contentParts.join(" "),
    idempotencyKey: randomUUID(),
  });
  process.stdout.write(`sent ${request.id}; waiting for ${target}\n`);
  const completed = await client.awaitResponse(request.id);
  process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
} finally {
  await client.stop();
}
