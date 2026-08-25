import type { TestContext } from "node:test";
import { MeshClient } from "../plugins/pi-mesh-comms/src/client.ts";
import { createMeshHub, type MeshHub, type MeshHubOptions } from "../plugins/pi-mesh-comms/src/hub.ts";

export interface TestMesh {
  hub: MeshHub;
  address: { host: string; port: number; url: string };
  token: string;
  clients: MeshClient[];
  makeClient(name: string, options?: { project?: string; token?: string; purpose?: string }): MeshClient;
}

export async function createTestMesh(context: TestContext, options: MeshHubOptions = {}): Promise<TestMesh> {
  const token = options.authToken ?? "test-token";
  const hub = createMeshHub({
    port: 0,
    rateLimit: false,
    shutdownGraceMs: 50,
    ...options,
    ...(token ? { authToken: token } : {}),
  });
  const address = await hub.start();
  const clients: MeshClient[] = [];
  context.after(async () => {
    await Promise.allSettled(clients.map((client) => client.stop()));
    await hub.close();
  });
  const mesh: TestMesh = {
    hub,
    address,
    token,
    clients,
    makeClient(name, clientOptions = {}) {
      const client = new MeshClient({
        serverUrl: address.url,
        authToken: clientOptions.token ?? token,
        name,
        purpose: clientOptions.purpose ?? `${name} purpose`,
        project: clientOptions.project ?? "test-project",
        heartbeatMs: 100,
        reconnectMs: 20,
        requestTimeoutMs: 1_000,
      });
      clients.push(client);
      return client;
    },
  };
  return mesh;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

export async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}
