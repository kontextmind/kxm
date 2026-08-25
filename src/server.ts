import { createMeshHub } from "./hub.ts";
import { DEFAULT_PORT } from "./protocol.ts";

const host = process.env.PI_MESH_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PI_MESH_PORT ?? String(DEFAULT_PORT), 10);
const authToken = process.env.PI_MESH_AUTH_TOKEN;

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PI_MESH_PORT must be an integer between 0 and 65535");
}

const hub = createMeshHub({
  host,
  port,
  authToken,
  logger(entry) {
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
  },
});

const address = await hub.start();
process.stdout.write(`pi-mesh hub listening at ${address.url}\n`);

async function shutdown(signal: string): Promise<void> {
  process.stdout.write(`received ${signal}; shutting down\n`);
  await hub.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

