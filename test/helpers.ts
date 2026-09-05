import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { HubClient } from "../plugins/kxm/src/client.ts";
import { createMeshHub, type MeshHub, type MeshHubOptions } from "../plugins/kxm/src/hub.ts";

export interface TestMesh {
  hub: MeshHub;
  address: { host: string; port: number; url: string };
  token: string;
  clients: HubClient[];
  makeClient(name: string, options?: {
    project?: string;
    token?: string;
    purpose?: string;
    requestTimeoutMs?: number;
  }): HubClient;
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
  const clients: HubClient[] = [];
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
      const client = new HubClient({
        serverUrl: address.url,
        authToken: clientOptions.token ?? token,
        name,
        purpose: clientOptions.purpose ?? `${name} purpose`,
        project: clientOptions.project ?? "test-project",
        heartbeatMs: 100,
        reconnectMs: 20,
        requestTimeoutMs: clientOptions.requestTimeoutMs ?? 1_000,
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

/** Remove a test temp directory. On Windows a SIGKILLed or SIGTERMed child
 * (or its own child) can hold the directory open for a while, so retry for a
 * few seconds and then tolerate a lingering lock: leaking an OS temp dir is
 * not a test failure. Any other error still throws. */
export function removeTempDir(...paths: string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      process.stderr.write(`removeTempDir: leaving ${path} behind after ${code}\n`);
    }
  }
}

/** Concatenate every log under <workdir>/.kxm/logs for failure messages. */
export function workerLogs(workdir: string): string {
  const dir = join(workdir, ".kxm", "logs");
  if (!existsSync(dir)) return "(no logs)";
  return readdirSync(dir)
    .map((name) => `--- ${name} ---\n${readFileSync(join(dir, name), "utf8")}`)
    .join("\n");
}
