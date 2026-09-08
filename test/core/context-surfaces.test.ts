import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli as runCliImplementation, type CliIo } from "../../plugins/kxm/src/cli.ts";
import piMeshExtension from "../../plugins/kxm/src/extension.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTestMesh } from "../helpers.ts";

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd = process.cwd()): Promise<number> {
  const isolatedLogs = mkdtempSync(join(tmpdir(), "kxm-cli-context-"));
  try {
    return await runCliImplementation(argv, { KXM_LOGS_DIR: isolatedLogs, KXM_STATE_HOME: isolatedLogs, ...env }, io, cwd);
  } finally {
    rmSync(isolatedLogs, { recursive: true, force: true });
  }
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    read: () => ({ stdout, stderr }),
  };
}

test("kxm context CLI commands call the hub context API with parity", async () => {
  const io = capture();
  const calls: Array<{ path: string; body: Record<string, unknown>; auth?: string | undefined }> = [];
  const ok = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
  const exit = await runCli([
    "context", "get", "test-project", "--role", "planner", "--task", "plan the fix",
    "--run", "run_1", "--stage", "implement", "--budget", "8192", "--kinds", "state,knowledge",
  ], {}, {
    ...io,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({
        path: url.replace(/^https?:\/\/[^/]+/, ""),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return ok({ ok: true, packet: { estimatedTokens: 128 }, audit: { selectedIds: ["ctx_1"] } });
    },
  });
  assert.equal(exit, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, "/v1/context/get");
  assert.deepEqual(calls[0]!.body, {
    project: "test-project",
    role: "planner",
    task: "plan the fix",
    workflowRunId: "run_1",
    stageId: "implement",
    budgetTokens: 8192,
    includeKinds: ["state", "knowledge"],
  });
  assert.match(io.read().stdout, /context get/);

  // Recall, state, episode, explain post to the same hub endpoints.
  const requested: string[] = [];
  const sharedFetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requested.push(`${new URL(url).pathname} ${String(init?.body ?? "{}")}`);
    return ok({ ok: true, items: [], state: null, episodes: [], found: false, lineage: [], evidenceRefs: [], sources: [], audit: { pages: ["index.md"], contradictions: 0 }, lint: [] });
  };
  assert.equal(await runCli(["context", "recall", "test-project", "--query", "flaky", "--limit", "5"], {}, { ...capture(), fetchImpl: sharedFetch }), 0);
  assert.equal(await runCli(["context", "state", "test-project", "ci.pipeline", "--as-of", "2026-01-01T00:00:00.000Z"], {}, { ...capture(), fetchImpl: sharedFetch }), 0);
  assert.equal(await runCli(["context", "episode", "test-project", "--run", "run_1"], {}, { ...capture(), fetchImpl: sharedFetch }), 0);
  assert.equal(await runCli(["context", "explain", "test-project", "ctx_1"], {}, { ...capture(), fetchImpl: sharedFetch }), 0);
  assert.equal(await runCli(["context", "wiki-compile", "test-project"], {}, { ...capture(), fetchImpl: sharedFetch }), 0);
  assert.equal(await runCli(["context", "wiki-lint", "test-project"], {}, { ...capture(), fetchImpl: sharedFetch }), 0);
  assert.equal(await runCli(["context", "promote", "test-project", "ctx_prop1", "--evidence", "eval:1,eval:2"], {}, {
    ...capture(),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return ok({ ok: true, state: { id: "ctx_new" } });
    },
  }), 0);
  assert.equal(calls[calls.length - 1]!.path, "/v1/context/state/promote");
  assert.deepEqual(calls[calls.length - 1]!.body, { project: "test-project", proposalId: "ctx_prop1", evidence: ["eval:1", "eval:2"] });
  const recallCall = requested.find((line) => line.startsWith("/v1/context/recall"))!;
  assert.match(recallCall, /"query":"flaky"/);
  assert.match(recallCall, /"limit":5/);

  // Validation failures exit 2 without calling the hub.
  const badBudget = capture();
  assert.equal(await runCli(["context", "get", "p", "--role", "planner", "--task", "t", "--budget", "1"], {}, {
    ...badBudget, fetchImpl: async () => { throw new Error("must not be called"); },
  }), 2);
  assert.match(badBudget.read().stderr, /budget/);
  const badEvidence = capture();
  assert.equal(await runCli(["context", "promote", "p", "ctx_prop1", "--evidence", ","], {}, {
    ...badEvidence, fetchImpl: async () => { throw new Error("must not be called"); },
  }), 2);
  assert.match(badEvidence.read().stderr, /evidence/);

  // Hub errors exit 1.
  const httpFail = capture();
  assert.equal(await runCli(["context", "state", "p", "k"], {}, {
    ...httpFail, fetchImpl: async () => new Response(JSON.stringify({ error: "x" }), { status: 403 }),
  }), 1);
});

test("Pi extension kxm_* tools expose the context API with project isolation", async (context) => {
  const mesh = await createTestMesh(context);
  const keys = ["KXM_SERVER_URL", "KXM_AUTH_TOKEN", "KXM_PROJECT", "KXM_AGENT_NAME", "KXM_STATE_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "context-agent",
    KXM_STATE_DIR: mkdtempSync(join(tmpdir(), "kxm-ext-state-")),
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fake = fakePi();
  piMeshExtension(fake.api);
  const ui = { setStatus() {}, notify() {} };
  await fake.emit("session_start", {}, { cwd: process.cwd(), model: { provider: "test", id: "model" }, ui });

  for (const name of ["kxm_context", "kxm_recall", "kxm_state", "kxm_episode", "kxm_promote"]) {
    assert.ok(fake.tools.has(name), `expected tool ${name} to be registered`);
  }

  const packet = await fake.tools.get("kxm_context")!.execute("ctx", {
    role: "planner",
    task: "plan the CI migration",
  }) as { details: { packet: { estimatedTokens: number }; audit: { request: { project: string } } } };
  assert.equal(packet.details.audit.request.project, "test-project");

  const recall = await fake.tools.get("kxm_recall")!.execute("recall", { query: "anything" }) as { details: { items: unknown[] } };
  assert.deepEqual(recall.details.items, []);

  const state = await fake.tools.get("kxm_state")!.execute("state", { key: "ci.pipeline" }) as { details: { state: unknown } };
  assert.equal(state.details.state, null);

  const episodes = await fake.tools.get("kxm_episode")!.execute("episode", {}) as { details: { episodes: unknown[] } };
  assert.deepEqual(episodes.details.episodes, []);

  const proposed = await fake.tools.get("kxm_promote")!.execute("promote", {
    key: "ci.pipeline",
    summary: "retry flaky gates",
    authority: "evidence",
    confidence: "probable",
    evidenceRefs: ["journal:1"],
  }) as { details: { proposalId: string } };
  assert.match(proposed.details.proposalId, /^ctx_/);

  await fake.emit("session_shutdown");
});

function fakePi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown | Promise<unknown>>>();
  const tools = new Map<string, { name: string; execute: (id: string, params: unknown) => Promise<unknown> }>();
  const api = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    registerTool(tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    sendMessage() {},
    getSessionName() {
      return "kxm-context-surface-test";
    },
  } as unknown as ExtensionAPI;
  async function emit(name: string, ...args: unknown[]): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler(...args);
  }
  return { api, tools, emit };
}
