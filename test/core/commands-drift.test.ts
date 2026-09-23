import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENT_COMMANDS,
  AGENT_COMMANDS_MAP,
  getMcpTools,
  getPiToolDefinitions,
} from "../../plugins/kxm/src/commands.ts";
import piMeshExtension from "../../plugins/kxm/src/extension.ts";
import { isolatedMcpEnv } from "../helpers/mcp-spawn.ts";

function fakePi() {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const api = {
    on() {},
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, def: unknown) {
      commands.set(name, def);
    },
    sendMessage() {},
    getSessionName() {
      return "test-session";
    },
  } as unknown as ExtensionAPI;
  return { api, tools, commands };
}

test("AGENT_COMMANDS is the single source of truth for all 19 agent tools and commands", () => {
  assert.equal(AGENT_COMMANDS.length, 19);
  assert.equal(AGENT_COMMANDS_MAP.size, 19);

  const expectedNames = [
    "kxm_list",
    "kxm_send",
    "kxm_get",
    "kxm_fanout",
    "kxm_await",
    "kxm_cancel",
    "kxm_inbox",
    "kxm_reply",
    "kxm_workflow_list",
    "kxm_workflow_get",
    "kxm_workflow_checkpoint",
    "kxm_workflow_record",
    "kxm_workflow_wait",
    "kxm_improvement_report",
    "kxm_context",
    "kxm_recall",
    "kxm_state",
    "kxm_episode",
    "kxm_promote",
  ];

  assert.deepEqual(
    AGENT_COMMANDS.map((c) => c.name),
    expectedNames,
  );
});

test("MCP tools expose the exact same names and schemas as AGENT_COMMANDS", () => {
  const mcpTools = getMcpTools();
  assert.equal(mcpTools.length, AGENT_COMMANDS.length);

  assert.deepEqual(
    mcpTools.map((t) => t.name),
    AGENT_COMMANDS.map((c) => c.name),
  );

  for (const tool of mcpTools) {
    const cmd = AGENT_COMMANDS_MAP.get(tool.name);
    assert.ok(cmd, `Tool ${tool.name} must exist in AGENT_COMMANDS_MAP`);
    assert.equal(tool.description, cmd.description);
    assert.deepEqual(tool.inputSchema, cmd.parameters);
  }
});

test("Pi tool definitions expose the exact same names and schemas as AGENT_COMMANDS", () => {
  const piTools = getPiToolDefinitions();
  assert.equal(piTools.length, AGENT_COMMANDS.length);

  assert.deepEqual(
    piTools.map((t) => t.name),
    AGENT_COMMANDS.map((c) => c.name),
  );

  for (const tool of piTools) {
    const cmd = AGENT_COMMANDS_MAP.get(tool.name);
    assert.ok(cmd, `Tool ${tool.name} must exist in AGENT_COMMANDS_MAP`);
    assert.equal(tool.label, cmd.label);
    assert.equal(tool.description, cmd.description);
    assert.deepEqual(tool.parameters, cmd.parameters);
  }
});

test("Pi extension dynamically registers the exact tool catalog without drift", () => {
  const fake = fakePi();
  piMeshExtension(fake.api);

  assert.deepEqual(
    [...fake.tools.keys()],
    AGENT_COMMANDS.map((c) => c.name),
  );
});

test("Every command declares a valid group and verb mapping to CLI subcommands", () => {
  const peerCommands = AGENT_COMMANDS.filter((c) => c.group === "peer");
  const workflowCommands = AGENT_COMMANDS.filter((c) => c.group === "workflow");
  const contextCommands = AGENT_COMMANDS.filter((c) => c.group === "context");

  assert.equal(peerCommands.length + workflowCommands.length + contextCommands.length, 19);

  assert.deepEqual(
    peerCommands.map((c) => c.verb),
    ["list", "send", "get", "fanout", "await", "cancel", "inbox", "reply"],
  );

  assert.deepEqual(
    workflowCommands.map((c) => c.verb),
    ["runs", "run", "checkpoint", "record", "wait", "improve-report"],
  );

  assert.deepEqual(
    contextCommands.map((c) => c.verb),
    ["get", "recall", "state", "episode", "promote"],
  );
});

test("the MCP server publishes AGENT_COMMANDS plus exactly the hook-only tools", async (context) => {
  // No hook-only tool ships: the failed-tool journal hook stays out until its live Claude Code
  // witness passes. A hook-only tool must be named kxm_hook_* and listed after AGENT_COMMANDS.
  const hookOnlyTools: string[] = [];
  const spawnEnv = isolatedMcpEnv();
  const child = spawn(process.execPath, [resolve("plugins/kxm/dist/mcp-server.js")], {
    cwd: spawnEnv.cwd,
    env: spawnEnv.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    child.kill();
    spawnEnv.cleanup();
  });
  const responses = new Map<number, (value: { result?: { tools?: Array<{ name: string }> } }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
    if (typeof message.id === "number") responses.get(message.id)?.(message);
  });
  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<{ result?: { tools?: Array<{ name: string }> } }>((resolveResponse) => {
      responses.set(id, resolveResponse);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "drift-test", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = (await request(2, "tools/list", {})).result?.tools?.map((tool) => tool.name);

  const agentNames = AGENT_COMMANDS.map((command) => command.name);
  assert.deepEqual(listed, [...agentNames, ...hookOnlyTools]);
  const hookNames = listed!.filter((name) => !agentNames.includes(name));
  assert.deepEqual(hookNames, hookOnlyTools);
  for (const name of hookNames) assert.match(name, /^kxm_hook_/);
  assert.equal(agentNames.some((name) => name.startsWith("kxm_hook_")), false);
});
