import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedMcpEnv } from "../helpers/mcp-spawn.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type RpcResponse = { id?: number; result?: Record<string, unknown>; error?: { message: string } };

/** Tool names of the `| `kxm_...` |` rows under the plugin README's `## MCP tools` heading. */
function readmeToolRows(): string[] {
  const readme = readFileSync(resolve(repoRoot, "plugins/kxm/README.md"), "utf8");
  const start = readme.indexOf("\n## MCP tools\n");
  assert.notEqual(start, -1, "plugins/kxm/README.md has no '## MCP tools' section");
  const section = readme.slice(start + 1);
  const end = section.indexOf("\n## ");
  const body = end === -1 ? section : section.slice(0, end);
  return [...body.matchAll(/^\| `(kxm_[a-z0-9_]+)` \|/gm)].map((match) => match[1]!);
}

test("plugin README tool table lists every tool the bundled MCP server publishes", async (context) => {
  // No hub, a project directory without .kxm, throwaway state and config:
  // the server lists its tools without registering anywhere.
  const isolated = isolatedMcpEnv();
  const child = spawn(process.execPath, [resolve(repoRoot, "plugins/kxm/dist/mcp-server.js")], {
    cwd: isolated.cwd,
    env: isolated.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  context.after(() => {
    lines.close();
    if (child.exitCode === null) child.kill();
    isolated.cleanup();
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const pending = new Map<number, (response: RpcResponse) => void>();
  lines.on("line", (line) => {
    const response = JSON.parse(line) as RpcResponse;
    if (typeof response.id === "number") pending.get(response.id)?.(response);
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`MCP server exited with ${String(code)}: ${stderr}`)));
  });
  // Killing the child in context.after must not surface as an unhandled rejection.
  exited.catch(() => undefined);
  let nextId = 1;
  async function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = nextId++;
    const answered = new Promise<RpcResponse>((resolveResponse) => pending.set(id, resolveResponse));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await Promise.race([answered, exited]);
    if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
    return response.result ?? {};
  }

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kxm-plugin-docs-test", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request("tools/list", {});
  const published = (listed.tools as Array<{ name: string }>).map((tool) => tool.name);

  const rows = readmeToolRows();
  const duplicated = rows.filter((name, index) => rows.indexOf(name) !== index);
  assert.deepEqual(duplicated, [], "plugins/kxm/README.md lists a tool more than once");
  const missing = published.filter((name) => !rows.includes(name));
  const stale = rows.filter((name) => !published.includes(name));
  assert.deepEqual(
    { missing, stale },
    { missing: [], stale: [] },
    "plugins/kxm/README.md '## MCP tools' must have one `| `kxm_...` |` row per tool that dist/mcp-server.js publishes",
  );
  assert.ok(published.length > 0, "the MCP server published no tools");
});
