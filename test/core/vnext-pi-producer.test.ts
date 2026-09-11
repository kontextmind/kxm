import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadVnextProject } from "../../plugins/kxm/src/vnext-config.ts";
import {
  driveVnextRun,
  pinVnextCompiledPlan,
} from "../../plugins/kxm/src/vnext-engine.ts";
import {
  acceptVnextRun,
  closeVnextRuntimeContext,
  openVnextRuntimeContext,
} from "../../plugins/kxm/src/vnext-runtime.ts";
import {
  createVnextPiProducer,
  formatPiSessionDisplayName,
  formatPiSessionKey,
  PiSession,
  type PiRpcProcess,
} from "../../plugins/kxm/src/vnext-pi-producer.ts";
import { loadPriceCatalog } from "../../plugins/kxm/src/prices.ts";
import { admitDefaultWriterRoute, engineProject } from "../helpers/vnext-project.ts";
import { removeTempDir } from "../helpers.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function createMockPiProcess(
  onCommand?: (cmd: Record<string, unknown>, emit: (evt: Record<string, unknown>) => void) => void,
): { process: PiRpcProcess; sentLines: string[] } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const sentLines: string[] = [];

  let lineBuffer = "";
  const stdin = {
    write(chunk: string): boolean {
      sentLines.push(chunk);
      lineBuffer += chunk;
      let idx: number;
      while ((idx = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const cmd = JSON.parse(line) as Record<string, unknown>;
          if (cmd.type === "prompt") {
            stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: "prompt", success: true }) + "\n");
            if (onCommand) {
              onCommand(cmd, (evt) => stdout.write(JSON.stringify(evt) + "\n"));
            } else {
              stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
              stdout.write(JSON.stringify({
                type: "message_update",
                usage: { input: 1500, output: 250, cacheRead: 100, cacheWrite: 50, totalTokens: 1900 },
              }) + "\n");
              stdout.write(JSON.stringify({
                type: "turn_end",
                message: { role: "assistant", content: "Work passed successfully." },
              }) + "\n");
              stdout.write(JSON.stringify({ type: "agent_end", willRetry: false }) + "\n");
              stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
            }
          } else if (cmd.type === "abort") {
            stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: "abort", success: true }) + "\n");
            if (onCommand) {
              onCommand(cmd, (evt) => stdout.write(JSON.stringify(evt) + "\n"));
            } else {
              stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
            }
          } else if (onCommand) {
            onCommand(cmd, (evt) => stdout.write(JSON.stringify(evt) + "\n"));
          } else {
            stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n");
          }
        } catch {
          // ignore
        }
      }
      return true;
    },
  };

  const proc: PiRpcProcess = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill() {
      emitter.emit("close", 0, null);
      return true;
    },
  });

  return { process: proc, sentLines };
}

test("formatPiSessionKey and formatPiSessionDisplayName follow vNext rules", () => {
  // Coordinator session: keyed by coordinator:${runId}
  assert.equal(
    formatPiSessionKey({ runId: "run_01JHARNESS0001", agentId: "coordinator" }),
    "coordinator:run_01JHARNESS0001",
  );
  assert.equal(
    formatPiSessionDisplayName({ runId: "run_01JHARNESS0001", agentId: "coordinator" }),
    "coordinator@run_01JH",
  );

  // Agent session: keyed by {runId}:{agentId}:{instanceNo}:{scopeEpoch}
  assert.equal(
    formatPiSessionKey({ runId: "run_01JHARNESS0001", agentId: "implementer", instanceNo: 1, scopeEpoch: 1 }),
    "run_01JHARNESS0001:implementer:1:1",
  );
  assert.equal(
    formatPiSessionDisplayName({ runId: "run_01JHARNESS0001", agentId: "implementer", instanceNo: 1, scopeEpoch: 1 }),
    "implementer@run_01JH#1.1",
  );

  // Different instance or epoch
  assert.equal(
    formatPiSessionKey({ runId: "run_01JHARNESS0001", agentId: "critic-2", instanceNo: 2, scopeEpoch: 3 }),
    "run_01JHARNESS0001:critic-2:2:3",
  );
  assert.equal(
    formatPiSessionDisplayName({ runId: "run_01JHARNESS0001", agentId: "critic-2", instanceNo: 2, scopeEpoch: 3 }),
    "critic-2@run_01JH#2.3",
  );
});

test("Pi producer reuses coordinator session within run and isolates across runs", async () => {
  const spawnedProcesses: string[] = [];
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  const producer = createVnextPiProducer({
    probeHarness: fakeAuth as any,
    spawnProcess: (command, args) => {
      const name = args[args.indexOf("--name") + 1] ?? "unknown";
      spawnedProcesses.push(name);
      return createMockPiProcess().process;
    },
  });

  try {
    const controller = new AbortController();

    // First coordinator turn in run-1
    await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "step-1",
      stepAttempt: 1,
      assignmentId: "asg_1",
      attemptId: "att_1",
      agentId: "coordinator",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });

    // Second coordinator turn in run-1 reuses existing session
    await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "step-2",
      stepAttempt: 1,
      assignmentId: "asg_2",
      attemptId: "att_2",
      agentId: "coordinator",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });

    // Coordinator turn in run-2 creates separate session
    await producer.produce({
      runId: "run_01JHARNESS0002",
      stepId: "step-1",
      stepAttempt: 1,
      assignmentId: "asg_3",
      attemptId: "att_3",
      agentId: "coordinator",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });

    assert.equal(spawnedProcesses.length, 2);
    assert.equal(spawnedProcesses[0], "coordinator@run_01JH");
    assert.equal(spawnedProcesses[1], "coordinator@run_01JH");
    assert.equal(producer.sessions.size, 2);
    assert.ok(producer.sessions.has("coordinator:run_01JHARNESS0001"));
    assert.ok(producer.sessions.has("coordinator:run_01JHARNESS0002"));
  } finally {
    await producer.close();
  }
});

test("Pi producer keys agent sessions by run, agent, instance, and scopeEpoch", async () => {
  const spawnedSessions: string[] = [];
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  const producer = createVnextPiProducer({
    probeHarness: fakeAuth as any,
    spawnProcess: (command, args) => {
      const name = args[args.indexOf("--name") + 1] ?? "unknown";
      spawnedSessions.push(name);
      return createMockPiProcess().process;
    },
  });

  try {
    const controller = new AbortController();

    // Base agent turn
    await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "step-1",
      stepAttempt: 1,
      assignmentId: "asg_1",
      attemptId: "att_1",
      agentId: "implementer",
      instanceNo: 1,
      scopeEpoch: 1,
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });

    // Same instance & epoch reuses session
    await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "step-1",
      stepAttempt: 2,
      assignmentId: "asg_2",
      attemptId: "att_2",
      agentId: "implementer",
      instanceNo: 1,
      scopeEpoch: 1,
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });

    // New instance creates fresh session
    await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "step-1",
      stepAttempt: 1,
      assignmentId: "asg_3",
      attemptId: "att_3",
      agentId: "implementer",
      instanceNo: 2,
      scopeEpoch: 1,
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });

    // New scope epoch creates fresh session
    await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "step-2",
      stepAttempt: 1,
      assignmentId: "asg_4",
      attemptId: "att_4",
      agentId: "implementer",
      instanceNo: 1,
      scopeEpoch: 2,
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });

    assert.equal(spawnedSessions.length, 3);
    assert.deepEqual(spawnedSessions, [
      "implementer@run_01JH#1.1",
      "implementer@run_01JH#2.1",
      "implementer@run_01JH#1.2",
    ]);
  } finally {
    await producer.close();
  }
});

test("Pi producer preflight fails closed when Pi or provider is unauthenticated", async () => {
  const unauthProbe = () => ({ detected: true, authenticated: false as const, issues: ["not_authenticated"] });
  const producer = createVnextPiProducer({
    probeHarness: unauthProbe as any,
    spawnProcess: () => {
      throw new Error("spawn should not be reached when auth fails");
    },
  });

  try {
    const controller = new AbortController();
    await assert.rejects(async () => {
      await producer.produce({
        runId: "run_01JHARNESS0001",
        stepId: "step-1",
        stepAttempt: 1,
        assignmentId: "asg_1",
        attemptId: "att_1",
        agentId: "implementer",
        capability: "secret",
        allowedOutcomes: ["passed"],
        signal: controller.signal,
      });
    }, /pi_not_authenticated/);
  } finally {
    await producer.close();
  }
});

test("Pi producer captures usage events and calculates metered cost for catalog models (Grok and GLM)", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });
  const priceCatalog = loadPriceCatalog(repoRoot);
  assert.ok(priceCatalog, "price catalog must load from repo root");

  const producer = createVnextPiProducer({
    probeHarness: fakeAuth as any,
    priceCatalog,
    spawnProcess: () => {
      return createMockPiProcess((cmd, emit) => {
        emit({ type: "agent_start" });
        emit({
          type: "message_update",
          usage: { input: 100_000, output: 10_000, cacheRead: 20_000, cacheWrite: 5_000, totalTokens: 135_000 },
        });
        emit({
          type: "turn_end",
          message: { role: "assistant", content: "Finished implementation. passed" },
        });
        emit({ type: "agent_end", willRetry: false });
        emit({ type: "agent_settled" });
      }).process;
    },
  });

  try {
    const controller = new AbortController();

    // Test Grok catalog row
    const grokResult = await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "implement",
      stepAttempt: 1,
      assignmentId: "asg_grok",
      attemptId: "att_grok",
      agentId: "implementer",
      model: "xai/grok-4.6",
      provider: "xai",
      capability: "secret",
      allowedOutcomes: ["passed", "failed"],
      signal: controller.signal,
    });

    assert.equal(grokResult.outcome, "passed");
    assert.equal(grokResult.harness, "pi");
    assert.equal(grokResult.provider, "xai");
    assert.equal(grokResult.requestedModel, "grok-4.6");
    assert.equal(grokResult.costBasis, "metered");
    assert.equal(grokResult.tokensIn, 100_000);
    assert.equal(grokResult.tokensOut, 10_000);
    assert.equal(grokResult.cacheReadTokens, 20_000);
    assert.equal(grokResult.cacheWriteTokens, 5_000);
    // Cost: 100k/1M * 2.00 = 0.20; 10k/1M * 10.00 = 0.10; 20k/1M * 0.50 = 0.01; 5k/1M * 2.00 = 0.01 -> total = 0.32
    assert.equal(grokResult.costUsd, 0.32);
    assert.equal(grokResult.priceRef, `${priceCatalog.date}#xai/grok-4.6`);

    // Test GLM catalog row
    const glmResult = await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "implement",
      stepAttempt: 2,
      assignmentId: "asg_glm",
      attemptId: "att_glm",
      agentId: "implementer",
      model: "zhipu/glm-4-plus",
      provider: "zhipu",
      capability: "secret",
      allowedOutcomes: ["passed", "failed"],
      signal: controller.signal,
    });

    assert.equal(glmResult.costBasis, "metered");
    assert.equal(glmResult.provider, "zhipu");
    assert.equal(glmResult.requestedModel, "glm-4-plus");
    // Cost: 100k/1M * 1.40 = 0.14; 10k/1M * 1.40 = 0.014; 20k/1M * 0.14 = 0.0028; 5k/1M * 1.40 = 0.007 -> total = 0.1638
    assert.equal(glmResult.costUsd, 0.1638);
    assert.equal(glmResult.priceRef, `${priceCatalog.date}#zhipu/glm-4-plus`);

    // Test uncataloged model -> costBasis: unknown
    const unknownResult = await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "implement",
      stepAttempt: 3,
      assignmentId: "asg_unk",
      attemptId: "att_unk",
      agentId: "implementer",
      model: "custom/unpriced-model",
      provider: "custom",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });

    assert.equal(unknownResult.costBasis, "unknown");
    assert.equal(unknownResult.costUsd, null);
    assert.equal(unknownResult.priceRef, undefined);
  } finally {
    await producer.close();
  }
});

test("Pi producer abort signal triggers RPC abort command", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });
  let abortReceived = false;

  const producer = createVnextPiProducer({
    probeHarness: fakeAuth as any,
    spawnProcess: () => {
      return createMockPiProcess((cmd, emit) => {
        if (cmd.type === "prompt") {
          // Do not settle prompt yet; keep in-flight waiting for abort
        } else if (cmd.type === "abort") {
          abortReceived = true;
          emit({ type: "agent_settled" });
        }
      }).process;
    },
  });

  try {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 20);

    const result = await producer.produce({
      runId: "run_01JHARNESS0001",
      stepId: "step-1",
      stepAttempt: 1,
      assignmentId: "asg_1",
      attemptId: "att_1",
      agentId: "implementer",
      capability: "secret",
      allowedOutcomes: ["passed", "cancelled"],
      signal: controller.signal,
    });

    assert.ok(abortReceived, "abort RPC command was received");
    assert.equal(result.outcome, "cancelled");
  } finally {
    await producer.close();
  }
});

test("Pi producer executes end-to-end inside vNext engine driver", async () => {
  const { root, stateRoot } = engineProject("kxm-pi-driver-");
  try {
    admitDefaultWriterRoute(root);
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JDRIVER0000000000000000" });

    const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });
    const producer = createVnextPiProducer({
      projectRoot: root,
      probeHarness: fakeAuth as any,
      spawnProcess: () => {
        return createMockPiProcess((cmd, emit) => {
          emit({ type: "agent_start" });
          emit({
            type: "message_update",
            usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 250 },
          });
          emit({
            type: "turn_end",
            message: { role: "assistant", content: "Completed. passed" },
          });
          emit({ type: "agent_end", willRetry: false });
          emit({ type: "agent_settled" });
        }).process;
      },
    });

    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "test prompt" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      const result = await driveVnextRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(result.state.status, "completed");

      // Verify routing records were emitted with harness: pi
      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      const routingEvents = events.filter((e) => e.eventType === "routing.attempt.recorded");
      assert.ok(routingEvents.length > 0);
      for (const ev of routingEvents) {
        const routing = (ev.payload as any).routing;
        assert.equal(routing.harness, "pi");
      }
    } finally {
      await producer.close();
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("PiSession direct methods and event handling edge cases", async () => {
  const { process: proc } = createMockPiProcess((cmd, emit) => {
    if (cmd.type === "test_command") {
      emit({ id: cmd.id, type: "response", success: false, error: "bad command" });
    } else if (cmd.type === "ok_command") {
      emit({ id: cmd.id, type: "response", success: true });
    }
  });
  const session = new PiSession({
    key: "test_key",
    displayName: "test_display",
    runId: "run_test",
    agentId: "implementer",
    instanceNo: 1,
    scopeEpoch: 1,
    process: proc,
  });

  assert.equal(session.isClosed(), false);
  assert.equal(session.isBusy(), false);

  // Send non-JSON output and empty lines to stdout (ignored)
  proc.stdout.emit("data", "not-json\n\n\r\n");

  // Send command that fails
  await assert.rejects(session.sendCommand({ type: "test_command" }), /bad command/);

  // Send command that succeeds
  const resp = await session.sendCommand({ type: "ok_command" });
  assert.equal((resp as any).success, true);

  // Prompt with pre-aborted signal
  const abortedController = new AbortController();
  abortedController.abort();
  const preAbortedResult = await session.prompt("hello", ["passed", "cancelled"], abortedController.signal);
  assert.equal(preAbortedResult.outcome, "cancelled");

  // Prompt with array content and contextUsage
  const promptPromise = session.prompt("hello", ["passed", "failed"]);
  assert.equal(session.isBusy(), true);

  // Attempting another prompt while busy throws
  await assert.rejects(session.prompt("concurrent", ["passed"]), /pi_session_busy/);

  // Emit turn_end with array content
  proc.stdout.emit(
    "data",
    JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ text: "part 1" }, { text: "outcome: passed" }],
      },
    }) + "\n",
  );

  // Emit agent_end with assistant messages and usage
  proc.stdout.emit(
    "data",
    JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: "extra content",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 135,
            contextUsage: { tokens: 120, contextWindow: 8000, percent: 1.5 },
          },
        },
      ],
    }) + "\n",
  );

  // Emit agent_settled
  proc.stdout.emit("data", JSON.stringify({ type: "agent_settled" }) + "\n");
  const promptResult = await promptPromise;
  assert.equal(promptResult.outcome, "passed");
  assert.equal(promptResult.usage?.contextUsage?.tokens, 120);

  // Test determineOutcome with JSON outcome
  const promptPromise2 = session.prompt("test json outcome", ["completed", "failed"]);
  proc.stdout.emit(
    "data",
    JSON.stringify({
      type: "turn_end",
      message: { role: "assistant", content: 'Result is {"outcome": "failed"}' },
    }) + "\n",
  );
  proc.stdout.emit("data", JSON.stringify({ type: "agent_settled" }) + "\n");
  const promptResult2 = await promptPromise2;
  assert.equal(promptResult2.outcome, "failed");

  // Close session
  await session.close();
  assert.equal(session.isClosed(), true);
  await assert.rejects(session.sendCommand({ type: "any" }), /pi_session_closed/);
  await assert.rejects(session.prompt("any", ["passed"]), /pi_session_closed/);
});

test("PiSession handles process error and close events", async () => {
  const { process: proc } = createMockPiProcess(() => {
    // Keep command pending without auto-reply
  });
  const session = new PiSession({
    key: "test_key",
    displayName: "test_display",
    runId: "run_test",
    agentId: "implementer",
    instanceNo: 1,
    scopeEpoch: 1,
    process: proc,
  });

  const cmdPromise = session.sendCommand({ type: "cmd" });
  (proc as any).emit("close", 1, null);
  await assert.rejects(cmdPromise, /pi_process_closed/);
  assert.equal(session.isClosed(), true);

  // Test error event
  const { process: proc2 } = createMockPiProcess(() => {});
  const session2 = new PiSession({
    key: "test_key2",
    displayName: "test_display2",
    runId: "run_test2",
    agentId: "implementer",
    instanceNo: 1,
    scopeEpoch: 1,
    process: proc2,
  });
  const promptPromise = session2.prompt("hello", ["passed"]);
  (proc2 as any).emit("error", new Error("process crashed"));
  await assert.rejects(promptPromise, /process crashed/);
  assert.equal(session2.isClosed(), true);
});

test("createVnextPiProducer handles resolveModel, inventory checks, probe failures, and closeRun", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  // resolveModel option
  const producer = createVnextPiProducer({
    defaultModel: "grok-4.6",
    resolveModel: (agentId, runId) => {
      if (agentId === "reviewer") {
        return { provider: "anthropic", model: "claude-3-5-sonnet", thinking: "high" };
      }
      return undefined;
    },
    probeHarness: fakeAuth as any,
    spawnProcess: () => {
      return createMockPiProcess((cmd, emit) => {
        emit({ type: "agent_settled" });
      }).process;
    },
  });

  try {
    const res = await producer.produce({
      runId: "run_1",
      stepId: "s1",
      stepAttempt: 1,
      assignmentId: "asg_1",
      attemptId: "att_1",
      agentId: "reviewer",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: new AbortController().signal,
    });
    assert.equal(res.provider, "anthropic");
    assert.equal(res.requestedModel, "claude-3-5-sonnet");
    assert.equal(res.thinking, "high");

    // Produce for another run
    await producer.produce({
      runId: "run_2",
      stepId: "s2",
      stepAttempt: 1,
      assignmentId: "asg_2",
      attemptId: "att_2",
      agentId: "implementer",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: new AbortController().signal,
    });
    assert.equal(producer.sessions.size, 2);

    // closeRun closes only run_1 sessions
    await producer.closeRun("run_1");
    assert.equal(producer.sessions.size, 1);
  } finally {
    await producer.close();
  }

  // Inventory auth check - failure
  const unauthInventory = {
    generatedAt: "2026-09-07T00:00:00Z",
    harnesses: [{ id: "pi", detected: true, authenticated: false, issues: ["not logged in"] }],
  };
  const unauthProducer = createVnextPiProducer({
    inventory: unauthInventory as any,
    probeHarness: fakeAuth as any,
  });
  await assert.rejects(
    unauthProducer.produce({
      runId: "run_inv",
      stepId: "s1",
      stepAttempt: 1,
      assignmentId: "asg_inv",
      attemptId: "att_inv",
      agentId: "implementer",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: new AbortController().signal,
    }),
    /pi_not_authenticated: pi harness not authenticated in inventory/,
  );

  // Probe not detected
  const notDetectedProbe = () => ({ detected: false, authenticated: false as const, issues: ["pi binary missing"] });
  const notDetectedProducer = createVnextPiProducer({
    probeHarness: notDetectedProbe as any,
  });
  await assert.rejects(
    notDetectedProducer.produce({
      runId: "run_nd",
      stepId: "s1",
      stepAttempt: 1,
      assignmentId: "asg_nd",
      attemptId: "att_nd",
      agentId: "implementer",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: new AbortController().signal,
    }),
    /pi_not_authenticated: pi harness not detected/,
  );
});

// Opt-in real Pi test behind KXM_SMOKE
const smokeTest = process.env.KXM_SMOKE ? test : test.skip;
smokeTest("real Pi RPC dispatch behind KXM_SMOKE", async () => {
  const producer = createVnextPiProducer();
  try {
    const controller = new AbortController();
    const result = await producer.produce({
      runId: "smoke_run_1",
      stepId: "smoke_step",
      stepAttempt: 1,
      assignmentId: "asg_smoke",
      attemptId: "att_smoke",
      agentId: "implementer",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });
    assert.equal(result.harness, "pi");
  } finally {
    await producer.close();
  }
});
