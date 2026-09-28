import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeGitRoot } from "../helpers/git-root.ts";
import { loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
import {
  createKxmSimulatedProducer,
  driveKxmRun,
  pinKxmCompiledPlan,
} from "../../plugins/kxm/src/engine.ts";
import { readEngineRoutingRecords } from "../../plugins/kxm/src/improve-sources.ts";
import { buildImprovementReport } from "../../plugins/kxm/src/improve.ts";
import {
  acceptKxmRun,
  closeKxmRuntimeContext,
  openKxmRuntimeContext,
} from "../../plugins/kxm/src/runtime-service.ts";
import { formatRoutingReport, generateRoutingReport } from "../../plugins/kxm/src/routing.ts";
import {
  buildFallbackChain,
  carryForwardPrompt,
  classifyRouteFailure,
  decideRouteSwitch,
  loadAgentFallback,
  parseSessionCarry,
  type ChainModel,
  type FallbackPolicy,
} from "../../plugins/kxm/src/route-fallback.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOME = "rtm_01JROUTEFALLBACK00000000";
// A Windows absolute execPath contains backslashes. Gate argv[0] must be a
// bare executable or an absolute POSIX path, so Windows uses `node` on PATH.
const NODE = process.platform === "win32" ? "node" : process.execPath;

function model(partial: Partial<ChainModel> & Pick<ChainModel, "routeId" | "model" | "vendor">): ChainModel {
  return {
    harness: "claude",
    status: "admitted",
    permissions: ["read-only"],
    tags: [],
    capabilities: [],
    priority: 0,
    fallbacks: [],
    hosted: true,
    writerReady: false,
    onWriterRoster: false,
    ...partial,
  };
}

const policy: FallbackPolicy = { onError: ["rate_limit", "transport", "provider_unavailable"], maxSwitches: 1, revert: "next_run" };

test("classifies retryable provider failures and refuses cancellation, policy, and auth", () => {
  assert.equal(classifyRouteFailure({ httpStatus: 429 }).class, "rate_limit");
  assert.equal(classifyRouteFailure({ text: "HTTP 429 Too Many Requests" }).walkable, true);
  assert.equal(classifyRouteFailure({ code: "process_timeout", text: "process_timeout" }).class, "transport");
  assert.equal(classifyRouteFailure({ text: "connect ECONNRESET" }).class, "transport");
  assert.equal(classifyRouteFailure({ httpStatus: 503, text: "model unavailable" }).class, "provider_unavailable");
  assert.equal(classifyRouteFailure({ text: "maximum context length exceeded" }).class, "context_overflow");
  assert.equal(classifyRouteFailure({ text: "context_overflow" }).walkable, true);

  for (const text of ["user_cancelled", "content_policy refusal", "grok_not_authenticated: logged out", "harness_unhosted_model", "gate_failed", "permission_profile_unaudited", "producer_route_not_admitted"]) {
    const failure = classifyRouteFailure({ code: text.split(":")[0], text, name: text.startsWith("user_") ? "AbortError" : undefined });
    assert.equal(failure.walkable, false, text);
  }
  assert.equal(classifyRouteFailure({ name: "AbortError", text: "The operation was aborted" }).class, "cancelled");
  assert.equal(classifyRouteFailure({ httpStatus: 401, text: "unauthorized" }).class, "auth");
});

test("selects the next admitted selector and skips a critic vendor collision", () => {
  const models = [
    model({
      routeId: "primary",
      model: "claude-sonnet-4-6",
      vendor: "anthropic",
      fallbacks: [{ profile: "backup" }, { tag: "spare", capabilities: ["tools"] }, { provider: "google", model: "gemini-3-flash" }],
    }),
    model({ routeId: "backup", model: "claude-fable-5-1", vendor: "anthropic", priority: 10 }),
    model({ routeId: "tagged", model: "claude-haiku", vendor: "anthropic", tags: ["spare"], capabilities: ["tools"], priority: 5 }),
    model({ routeId: "untagged", model: "claude-other", vendor: "anthropic", tags: ["spare"], capabilities: [] }),
    model({ routeId: "gemini", harness: "agy", model: "gemini-3-flash", vendor: "google" }),
    model({ routeId: "retired", model: "claude-old", vendor: "anthropic", status: "retired" }),
    model({ routeId: "extended", model: "claude-extended", vendor: "openai", harness: "codex" }),
  ];
  const chain = buildFallbackChain({
    roster: [{ route: "primary", effort: "medium" }],
    extendsRoster: [{ route: "extended", effort: "high" }],
    models,
    admitted: [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-haiku",
      "google/gemini-3-flash",
      "openai/claude-extended",
    ],
    disabled: [],
    liveWrite: false,
    vendorIndependenceRequired: true,
    criticVendors: ["google"],
  });
  assert.deepEqual(chain.map((item) => item.routeId), ["primary", "backup", "tagged", "extended"]);
  assert.equal(chain[1]?.effort, "medium");
  assert.equal(chain[3]?.effort, "high");
  assert.equal(chain.find((item) => item.routeId === "gemini"), undefined);

  const writeChain = buildFallbackChain({
    roster: [{ route: "primary" }, { route: "backup" }],
    models: [
      model({ routeId: "primary", model: "grok-4.7", vendor: "xai", harness: "grok", permissions: ["edit"], writerReady: true, onWriterRoster: true }),
      model({ routeId: "backup", model: "claude-sonnet-4-6", vendor: "anthropic", permissions: ["read-only"], writerReady: false, onWriterRoster: false }),
    ],
    admitted: ["xai/grok-4.7", "anthropic/claude-sonnet-4-6"],
    disabled: [],
    liveWrite: true,
  });
  assert.deepEqual(writeChain.map((item) => item.routeId), ["primary"]);
});

test("stops at the switch budget and leaves an empty onError list unwound", () => {
  const chain = buildFallbackChain({
    roster: [{ route: "a" }, { route: "b" }, { route: "c" }],
    models: [
      model({ routeId: "a", model: "claude-a", vendor: "anthropic" }),
      model({ routeId: "b", model: "claude-b", vendor: "anthropic" }),
      model({ routeId: "c", model: "claude-c", vendor: "anthropic" }),
    ],
    admitted: ["anthropic/claude-a", "anthropic/claude-b", "anthropic/claude-c"],
    disabled: [],
    liveWrite: false,
  });
  const rateLimit = classifyRouteFailure({ httpStatus: 429 });
  const first = decideRouteSwitch({ policy, chain, currentRouteId: "a", switchesUsed: 0, failure: rateLimit });
  assert.equal(first.action, "switch");
  if (first.action === "switch") assert.equal(first.to.routeId, "b");
  const exhausted = decideRouteSwitch({ policy, chain, currentRouteId: "b", switchesUsed: 1, failure: rateLimit });
  assert.deepEqual(exhausted, { action: "continue", cause: "budget" });
  const transport = decideRouteSwitch({
    policy: { ...policy, onError: ["transport"], maxSwitches: 2 },
    chain,
    currentRouteId: "a",
    switchesUsed: 0,
    failure: classifyRouteFailure({ text: "timed out" }),
  });
  assert.equal(transport.action, "switch");
  const disabled = decideRouteSwitch({ policy: undefined, chain, currentRouteId: "a", switchesUsed: 0, failure: rateLimit });
  assert.deepEqual(disabled, { action: "continue", cause: "disabled" });
  const empty = decideRouteSwitch({
    policy: { onError: [], maxSwitches: 3, revert: "next_run" },
    chain,
    currentRouteId: "a",
    switchesUsed: 0,
    failure: rateLimit,
  });
  assert.deepEqual(empty, { action: "continue", cause: "disabled" });
  const cancelled = decideRouteSwitch({
    policy,
    chain,
    currentRouteId: "a",
    switchesUsed: 0,
    failure: classifyRouteFailure({ name: "AbortError", text: "cancelled" }),
  });
  assert.deepEqual(cancelled, { action: "continue", cause: "not_walkable" });
});

test("carries a bounded tool transcript into the next prompt", () => {
  const carry = parseSessionCarry({
    transcript: [
      { role: "assistant", text: "started" },
      { role: "tool", text: "tool-state-token" },
      { role: "nope", text: "drop" },
      { role: "user", text: "x".repeat(5000) },
    ],
  });
  assert.ok(carry);
  assert.equal(carry?.transcript[1]?.text, "tool-state-token");
  assert.ok((carry?.transcript.find((item) => item.role === "user")?.text.length ?? 0) <= 2000);
  const prompt = carryForwardPrompt("original task", carry);
  assert.match(prompt ?? "", /original task/);
  assert.match(prompt ?? "", /tool-state-token/);
  assert.equal(carryForwardPrompt("original task", undefined), "original task");
});

test("loads profile, tag, and provider selectors through the route validator names", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-fallback-load-"));
  try {
    mkdirSync(join(root, ".kxm", "agents"), { recursive: true });
    mkdirSync(join(root, ".kxm", "roles"), { recursive: true });
    mkdirSync(join(root, ".kxm", "models"), { recursive: true });
    writeFileSync(join(root, ".kxm", "agents", "planner.yaml"), "schema: kxm.agent.v1\nrole: planner\n");
    writeFileSync(join(root, ".kxm", "roles", "planner.yaml"), `schema: kxm.role.v2
id: planner
purpose: planner
permission: read-only
description: Plans.
roster:
  - route: primary-alias
    effort: low
policy:
  fallback:
    onError: [rate_limit, context_overflow]
    maxSwitches: 2
    revert: never
`);
    writeFileSync(join(root, ".kxm", "roles", "base.yaml"), `schema: kxm.role.v2
id: base
purpose: experiment
permission: read-only
description: Extended roster.
roster:
  - route: extended
    effort: high
`);
    writeFileSync(join(root, ".kxm", "models", "claude-sonnet.yaml"), `schema: kxm.model.v2
id: claude-sonnet
aliases: [primary-alias]
harness: claude
model: claude-sonnet-4-6
vendor: anthropic
status: admitted
permissions: [read-only]
tags: [planner]
fallbacks:
  - profile: claude-fable
  - tag: spare
    capabilities: [tools]
  - provider: google
    model: gemini-3-flash
`);
    writeFileSync(join(root, ".kxm", "models", "claude-fable.yaml"), `schema: kxm.model.v2
id: claude-fable
harness: claude
model: claude-fable-5-1
vendor: anthropic
status: admitted
permissions: [read-only]
`);
    writeFileSync(join(root, ".kxm", "models", "tagged.yaml"), `schema: kxm.model.v2
id: tagged
harness: claude
model: claude-haiku
vendor: anthropic
status: admitted
permissions: [read-only]
tags: [spare]
capabilities: [tools]
priority: 20
`);
    writeFileSync(join(root, ".kxm", "models", "gemini.yaml"), `schema: kxm.model.v2
id: gemini
harness: agy
model: gemini-3-flash
vendor: google
status: admitted
permissions: [read-only]
`);
    writeFileSync(join(root, ".kxm", "models", "extended.yaml"), `schema: kxm.model.v2
id: extended
harness: claude
model: claude-extended
vendor: anthropic
status: admitted
permissions: [read-only]
`);
    writeFileSync(join(root, ".kxm", "routes.yaml"), `schema: kxm.routes.v2
admitted:
  - anthropic/claude-sonnet-4-6
  - anthropic/claude-fable-5-1
  - anthropic/claude-haiku
  - google/gemini-3-flash
  - anthropic/claude-extended
disabled: []
`);
    writeFileSync(join(root, ".kxm", "roles", "planner.yaml"), `schema: kxm.role.v2
id: planner
purpose: planner
permission: read-only
description: Plans.
extends: base
roster:
  - route: primary-alias
    effort: low
policy:
  vendorIndependenceRequired: true
  fallback:
    onError: [rate_limit, context_overflow]
    maxSwitches: 2
    revert: never
`);
    writeFileSync(join(root, ".kxm", "roles", "reviewer-arch.yaml"), `schema: kxm.role.v2
id: reviewer-arch
purpose: reviewer-arch
permission: read-only
description: Critic.
roster:
  - route: gemini
`);
    const loaded = loadAgentFallback(root, "planner", { liveWrite: false });
    assert.ok(loaded);
    assert.equal(loaded?.policy.maxSwitches, 2);
    assert.equal(loaded?.policy.revert, "never");
    assert.deepEqual(loaded?.policy.onError, ["rate_limit", "context_overflow"]);
    assert.deepEqual(loaded?.chain.map((item) => item.routeId), ["claude-sonnet", "claude-fable", "tagged", "extended"]);
    assert.equal(loadAgentFallback(root, "missing", { liveWrite: false }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupProject(prefix: string): { root: string; stateRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stateRoot = mkdtempSync(join(tmpdir(), `${prefix}state-`));
  cpSync(join(repoRoot, "examples/project"), root, { recursive: true });
  makeGitRoot(root);
  makeGitRoot(join(root, "repositories", "api"));
  makeGitRoot(join(root, "repositories", "web"));
  const gateScriptPath = join(root, "gate-script.cjs");
  writeFileSync(gateScriptPath, "process.exit(0);\n");
  writeFileSync(join(root, ".kxm", "gates.yaml"), `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: [${JSON.stringify(NODE)}, ${JSON.stringify(gateScriptPath)}]
    timeoutMs: 3600000
  scm-delivery:
    kind: command
    argv: [${JSON.stringify(NODE)}, ${JSON.stringify(gateScriptPath)}]
    timeoutMs: 1800000
`);
  spawnSync("git", ["-C", root, "add", "-A"], { windowsHide: true });
  spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });
  return {
    root,
    stateRoot,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

function optInPlanner(root: string): void {
  const implementation = join(root, ".kxm", "models", "implementation.yaml");
  writeFileSync(implementation, `schema: kxm.model.v2
harness: claude
model: claude-sonnet-4-6
vendor: anthropic
status: admitted
permissions:
  - read-only
thinking: high
fallbacks:
  - profile: critic-claude
`);
  writeFileSync(join(root, ".kxm", "roles", "planner.yaml"), `schema: kxm.role.v2
id: planner
purpose: planner
permission: read-only
description: Plans the change before implementation.
roster:
  - route: implementation
    effort: medium
policy:
  fallback:
    onError: [rate_limit, transport, provider_unavailable]
    maxSwitches: 1
    revert: next_run
`);
  writeFileSync(join(root, ".kxm", "routes.yaml"), `schema: kxm.routes.v2
admitted:
  - anthropic/claude-sonnet-4-6
  - anthropic/claude-fable-5-1
disabled: []
`);
}

test("a run with no fallback configured fails the attempt exactly as before", async () => {
  const env = setupProject("kxm-fallback-none-");
  try {
    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "no fallback" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);
      let calls = 0;
      const driven = await driveKxmRun(context, accepted.run.runId, createKxmSimulatedProducer(async (request) => {
        if (request.stepId === "plan") {
          calls += 1;
          assert.equal(request.model, undefined);
          throw new Error("429 rate_limit");
        }
        return { outcome: "passed" };
      }), { allowLimits: true });
      assert.equal(driven.state.status, "failed");
      assert.equal(calls, 1);
      const switches = context.eventStore.events(accepted.run.runId, 0, 500).filter((event) => event.eventType === "routing.route_switched");
      assert.equal(switches.length, 0);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("a mid-run rate limit continues on the fallback route and the reports show the switch", async () => {
  const env = setupProject("kxm-fallback-walk-");
  const logs: Array<Record<string, unknown>> = [];
  try {
    optInPlanner(env.root);
    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, {
      stateRoot: env.stateRoot,
      homeRuntimeId: HOME,
      logger: (entry) => logs.push(entry),
    });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "fallback walk" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);
      const seen: string[] = [];
      const driven = await driveKxmRun(context, accepted.run.runId, createKxmSimulatedProducer(async (request) => {
        if (request.stepId !== "plan") return { outcome: "passed" };
        seen.push(request.model ?? "");
        if (seen.length === 1) {
          const error = new Error("429 rate_limit") as Error & { sessionCarry?: unknown };
          error.sessionCarry = { transcript: [{ role: "tool", text: "tool-state-token" }] };
          throw error;
        }
        assert.match(request.prompt ?? "", /tool-state-token/);
        return { outcome: "passed" };
      }), { allowLimits: true });
      assert.equal(driven.state.status, "completed");
      assert.deepEqual(seen, ["claude-sonnet-4-6", "claude-fable-5-1"]);
      const switches = context.eventStore.events(accepted.run.runId, 0, 800).filter((event) => event.eventType === "routing.route_switched");
      assert.equal(switches.length, 1);
      const payload = switches[0]?.payload as { routeSwitch?: { from?: string; to?: string; reason?: string; effort?: string } };
      assert.equal(payload.routeSwitch?.from, "implementation");
      assert.equal(payload.routeSwitch?.to, "critic-claude");
      assert.equal(payload.routeSwitch?.reason, "rate_limit");
      assert.equal(payload.routeSwitch?.effort, "medium");
      assert.equal(logs.some((entry) => entry.event === "route_switch" && entry.to === "critic-claude"), true);

      const read = readEngineRoutingRecords(context.eventStore.path);
      assert.equal(read.routeSwitches.length, 1);
      const report = generateRoutingReport([], { routeSwitches: read.routeSwitches, now: () => "2026-09-27T00:00:00.000Z" });
      assert.equal(report.routeSwitches?.length, 1);
      assert.match(formatRoutingReport(report), /implementation -> critic-claude \(rate_limit effort medium\)/);
      const improvement = buildImprovementReport([], { routeSwitches: read.routeSwitches, dryRun: true, projectRoot: env.root });
      assert.equal(improvement.routeSwitches?.length, 1);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("budget exhaustion records one switch and then fails the run", async () => {
  const env = setupProject("kxm-fallback-budget-");
  try {
    optInPlanner(env.root);
    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "budget" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);
      let calls = 0;
      const driven = await driveKxmRun(context, accepted.run.runId, createKxmSimulatedProducer(async (request) => {
        if (request.stepId === "plan") {
          calls += 1;
          throw new Error("connect ECONNRESET");
        }
        return { outcome: "passed" };
      }), { allowLimits: true });
      assert.equal(driven.state.status, "failed");
      assert.equal(calls, 2);
      const switches = context.eventStore.events(accepted.run.runId, 0, 500).filter((event) => event.eventType === "routing.route_switched");
      assert.equal(switches.length, 1);
      assert.equal((switches[0]?.payload as { routeSwitch?: { reason?: string } }).routeSwitch?.reason, "transport");
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});
