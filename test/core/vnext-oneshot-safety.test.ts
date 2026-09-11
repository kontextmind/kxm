import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { before, after } from "node:test";
import { isolateSessionEnvironment } from "../helpers/session-env.ts";
let restoreSession: () => void;
before(() => { restoreSession = isolateSessionEnvironment(); });
after(() => { restoreSession(); });
import { createVnextOneShotProducer, defaultSpawn, type VnextOneShotProcessResult } from "../../plugins/kxm/src/vnext-oneshot-producer.ts";
import type { VnextProducerRequest } from "../../plugins/kxm/src/vnext-engine.ts";

function request(overrides: Partial<VnextProducerRequest> = {}): VnextProducerRequest {
  return { runId: "run_safety", stepId: "review", stepAttempt: 1, assignmentId: "asg_safety", attemptId: "att_safety", agentId: "critic", capability: "test-only", allowedOutcomes: ["passed", "failed", "cancelled"], signal: new AbortController().signal, ...overrides };
}
const authenticated = () => ({ id: "claude", label: "Claude", default: false, mode: "either" as const,
  detected: true, authenticated: true, canUpdate: { self: false, extensions: false, models: false }, issues: [] });
const reply = (text = '{"outcome":"passed"}') => JSON.stringify({ result: text, usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } });
async function produce(processResult: VnextOneShotProcessResult, overrides: Partial<VnextProducerRequest> = {}) {
  const producer = createVnextOneShotProducer({
    projectRoot: resolve("examples/vnext"), defaultHarness: "claude", defaultModel: "fable",
    probeHarness: authenticated,
    spawnProcess: async () => processResult,
  });
  try { return await producer.produce(request(overrides)); }
  finally { await producer.close(); }
}

for (const [name, result] of [
  ["nonzero exit", { stdout: reply(), stderr: "", code: 1 }],
  ["signal termination", { stdout: reply(), stderr: "", code: null }],
  ["timeout", { stdout: reply(), stderr: "", code: null, error: new Error("process_timeout") }],
  ["invalid final JSON", { stdout: reply("The old tests passed, but this review is incomplete."), stderr: "", code: 0 }],
  ["malformed envelope", { stdout: '{"outcome":"passed"}', stderr: "", code: 0 }],
  ["empty output", { stdout: "", stderr: "", code: 0 }],
] as const) {
  test(`one-shot fails closed on ${name}, including success-only outcome lists`, async () => {
    const res = await produce(result, { allowedOutcomes: ["passed"] });
    assert.notEqual(res.outcome, "passed");
    if (result.stdout === reply()) {
      assert.equal(res.tokensIn, 12);
      assert.equal(res.tokensOut, 8);
    }
  });
}

test("one-shot cancellation preserves reported usage and does not invent effective model identity", async () => {
  const res = await produce({ stdout: reply(), stderr: "", code: null, error: new Error("process_aborted") });
  assert.equal(res.outcome, "cancelled");
  assert.equal(res.tokensIn, 12);
  assert.equal(res.cacheWriteTokens, 3);
  assert.equal(res.effectiveModel, "unknown");
});

for (const harness of ["pi", "deepseek"]) {
  test(`unaudited ${harness} one-shot permissions refuse before authentication and execution`, async () => {
    let probes = 0;
    let spawns = 0;
    const producer = createVnextOneShotProducer({ defaultHarness: harness,
      probeHarness: () => { probes++; return authenticated(); },
      spawnProcess: async () => { spawns++; return { stdout: reply(), stderr: "", code: 0 }; },
    });
    try {
      await assert.rejects(producer.produce(request()), /permission_profile_unaudited/);
      assert.equal(probes, 0);
      assert.equal(spawns, 0);
    } finally { await producer.close(); }
  });
}

test("audited agy and kimi one-shot dispatches apply sandboxed read-only flags", async () => {
  let capturedAgyArgs: readonly string[] = [];
  const agyProducer = createVnextOneShotProducer({
    defaultHarness: "agy",
    probeHarness: () => ({
      id: "agy", label: "AGY", default: false, mode: "either" as const,
      detected: true, authenticated: true as const, authMethod: "antigravity-oauth",
      canUpdate: { self: false, extensions: false, models: false }, issues: [],
    }),
    spawnProcess: async (_cmd, args) => {
      capturedAgyArgs = args;
      return { stdout: reply(), stderr: "", code: 0 };
    },
  });
  try {
    const res = await agyProducer.produce(request({ model: "gemini-3.8-flash-high" }));
    assert.equal(res.outcome, "passed");
    assert.ok(capturedAgyArgs.includes("--mode"));
    assert.ok(capturedAgyArgs.includes("plan"));
    assert.ok(capturedAgyArgs.includes("--sandbox"));
    assert.ok(capturedAgyArgs.includes("--disable-slash-commands"));
  } finally {
    await agyProducer.close();
  }

  let capturedKimiArgs: readonly string[] = [];
  const kimiProducer = createVnextOneShotProducer({
    defaultHarness: "kimi",
    probeHarness: () => ({
      id: "kimi", label: "Kimi", default: false, mode: "either" as const,
      detected: true, authenticated: true as const,
      canUpdate: { self: false, extensions: false, models: false }, issues: [],
    }),
    spawnProcess: async (_cmd, args) => {
      capturedKimiArgs = args;
      return {
        stdout: JSON.stringify({ role: "assistant", content: '{"outcome":"passed"}' }) + "\n",
        stderr: "",
        code: 0,
      };
    },
  });
  try {
    const res = await kimiProducer.produce(request({ model: "kimi-k2" }));
    assert.equal(res.outcome, "passed");
    assert.ok(capturedKimiArgs.includes("--plan"));
  } finally {
    await kimiProducer.close();
  }
});

test("pre-aborted producer performs no authentication or execution", async () => {
  let probes = 0;
  const producer = createVnextOneShotProducer({
    probeHarness: () => { probes++; return authenticated(); },
    spawnProcess: async () => { throw new Error("must not spawn"); },
  });
  const res = await producer.produce(request({ signal: AbortSignal.abort() }));
  assert.equal(res.outcome, "cancelled");
  assert.equal(probes, 0);
});

test("native auth preflight yields to sibling timers", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-async-auth-"));
  // A fake native command on a private PATH: no provider/authentication calls.
  writeFileSync(join(dir, "claude"), '#!/bin/sh\nsleep 0.15\nif [ "$1" = "--version" ]; then echo "fixture-cli"; else echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; fi\n', { mode: 0o700 });
  let progressed = false;
  const timer = setTimeout(() => { progressed = true; }, 20);
  const producer = createVnextOneShotProducer({
    projectRoot: dir, defaultHarness: "claude", defaultModel: "fable",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    spawnProcess: async () => {
      assert.equal(progressed, true, "auth must not block sibling kill/drain timers");
      return { stdout: reply(), stderr: "", code: 0 };
    },
  });
  try { assert.equal((await producer.produce(request())).outcome, "passed"); }
  finally { clearTimeout(timer); await producer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("close cancels and drains pending async authentication before model spawn", { timeout: 5000 }, async () => {
  let entered!: () => void;
  const probing = new Promise<void>((resolve) => { entered = resolve; });
  let spawned = 0;
  const producer = createVnextOneShotProducer({
    probeHarness: async (options) => {
      entered();
      await new Promise<void>((resolve) => {
        if (options.signal) options.signal.addEventListener("abort", () => resolve(), { once: true });
        else resolve();
      });
      return authenticated();
    },
    spawnProcess: async () => { spawned++; return { stdout: reply(), stderr: "", code: 0 }; },
  });
  const pending = producer.produce(request());
  await probing;
  await producer.close();
  assert.equal((await pending).outcome, "cancelled");
  assert.equal(spawned, 0);
});

test("process pre-abort cannot execute the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-preabort-"));
  const marker = join(dir, "spawned");
  try {
    const res = await defaultSpawn(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`], { signal: AbortSignal.abort() });
    assert.equal(res.error?.message, "process_aborted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("process escalates ignored SIGTERM within a bounded grace", { timeout: 5000 }, async () => {
  const started = Date.now();
  const res = await defaultSpawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000); setTimeout(() => process.exit(99), 4000)"], { timeoutMs: 300 });
  assert.equal(res.error?.message, "process_timeout");
  assert.match(res.stdout, /ready/);
  assert.ok(Date.now() - started < 3000);
});

for (const detached of [false, true]) {
  test(`parent close cannot establish descendant quiescence (detached=${detached})`, { skip: process.platform === "win32", timeout: 7000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "kxm-stop-close-"));
    const marker = join(dir, "late-effect");
    let descendant = 0;
    try {
      const descendantCode = `process.on('SIGTERM', () => {}); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 1400); setTimeout(() => process.exit(), 4000);`;
      const parentCode = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio:'ignore', detached:${detached}}); console.log(c.pid); process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(99), 5000);`;
      const result = await defaultSpawn(process.execPath, ["-e", parentCode], { timeoutMs: 500 });
      descendant = Number(result.stdout.trim());
      assert.ok(Number.isInteger(descendant) && descendant > 1);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!detached) assert.equal(existsSync(marker), false, "close must not clear group SIGKILL escalation");
      const classified = await produce({ ...result, stdout: reply() });
      assert.equal(classified.effectUncertain, true, "direct-child exit cannot attest escaped descendant effects");
    } finally {
      if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* fixture already exited */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("process bounds stdout/stderr and catches closed stdin without crashing the parent", { timeout: 5000 }, async () => {
  const overflow = await defaultSpawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(10 * 1024 * 1024)); setInterval(() => {}, 1000)"], { timeoutMs: 2000 });
  assert.equal(overflow.error?.message, "process_output_limit");
  assert.ok(Buffer.byteLength(overflow.stdout) <= 8 * 1024 * 1024);
  const closed = await defaultSpawn(process.execPath, ["-e", "process.stdin.destroy(); process.exit(1)"], { input: "x".repeat(2 * 1024 * 1024), timeoutMs: 2000 });
  assert.ok(closed.code !== 0 || closed.error);
});

test("descendant-held pipes cannot prolong a completed child's execution indefinitely", { timeout: 5000, skip: process.platform === "win32" }, async () => {
  const script = `const {spawn} = require('child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(99),3500)"], {stdio:['ignore','inherit','inherit']});
    child.unref(); console.log('parent completed');`;
  const started = Date.now();
  const res = await defaultSpawn(process.execPath, ["-e", script], { timeoutMs: 2000 });
  assert.equal(res.code, 0);
  assert.equal(res.observedChildExit, true);
  assert.equal(res.error?.message, "process_stdio_unclosed");
  assert.ok(Date.now() - started < 3000);
});

test("unknown auth billing and missing usage are not a zero-priced metered attempt", async () => {
  const res = await produce({ stdout: JSON.stringify({ result: '{"outcome":"passed"}' }), stderr: "", code: 0 });
  assert.equal(res.outcome, "passed");
  assert.equal(res.costBasis, "unknown");
  assert.equal(res.costUsd, null);
  assert.equal(res.tokensIn, null);
  assert.equal(res.providerMetadata?.listCostUsd, undefined);
});

test("unobserved termination is explicitly uncertain, never a settled failure to replay", async () => {
  const res = await produce({ stdout: reply(), stderr: "", code: null, observedChildExit: false, error: new Error("process_exit_unobserved") });
  assert.equal(res.effectUncertain, true);
  assert.notEqual(res.outcome, "passed");
  assert.equal(res.tokensIn, 12);
});

test("closing a producer cancels and drains its active subprocesses", { timeout: 5000 }, async () => {
  let started!: () => void;
  const launched = new Promise<void>((resolve) => { started = resolve; });
  const producer = createVnextOneShotProducer({
    projectRoot: resolve("examples/vnext"), probeHarness: authenticated,
    spawnProcess: (_command, _args, options) => {
      const work = defaultSpawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], options);
      started();
      return work;
    },
  });
  const work = producer.produce(request());
  await launched;
  await producer.close();
  assert.equal((await work).outcome, "cancelled");
  await assert.rejects(producer.produce(request()), /oneshot_producer_closed/);
});
