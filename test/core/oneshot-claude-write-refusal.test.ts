import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { isolateSessionEnvironment } from "../helpers/session-env.ts";
import { removeTempDir } from "../helpers.ts";
import {
  createKxmOneShotProducer,
  defaultSpawn,
} from "../../plugins/kxm/src/oneshot-producer.ts";
import { oneShotReadOnlyArgs } from "../../plugins/kxm/src/harness.ts";
import type { KxmProducerRequest } from "../../plugins/kxm/src/engine.ts";

let restoreSession: () => void;
before(() => { restoreSession = isolateSessionEnvironment(); });
after(() => { restoreSession(); });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(repoRoot, "test/fixtures/harness/claude-write-refuse.mjs");
const CLAUDE_READ_ONLY = [
  "--tools", "Read,Glob,Grep",
  "--restricted",
  "--safe-mode",
  "--permission-mode", "plan",
  "--permission-prompts", "none",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--disable-slash-commands",
  "--no-session-persistence",
] as const;
const WRITE_TOOLS = /(?:^|,)(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|REPL)(?:,|$)/i;
const PROBE_NAME = "WRITE_PROBE.txt";
const WRITE_PROMPT = `Create the file ${PROBE_NAME} in the current working directory with the exact contents kxm-write-probe. You must persist the file on disk. If you cannot write, do not claim success.`;

function authenticated() {
  return {
    id: "claude",
    label: "Claude",
    default: false,
    mode: "either" as const,
    detected: true,
    authenticated: true as const,
    authMethod: "claude.ai" as const,
    canUpdate: { self: false, extensions: false, models: false },
    issues: [],
  };
}

function request(overrides: Partial<KxmProducerRequest> = {}): KxmProducerRequest {
  return {
    runId: "run_claude_write_refusal",
    stepId: "review",
    stepAttempt: 1,
    assignmentId: "asg_claude_write_refusal",
    attemptId: "att_claude_write_refusal",
    agentId: "critic",
    harness: "claude",
    capability: "fixture-only",
    allowedOutcomes: ["passed", "failed"],
    prompt: WRITE_PROMPT,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function privateEvidenceRoot(sandbox: string): string {
  const evidenceRoot = join(sandbox, "evidence");
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  chmodSync(evidenceRoot, 0o700);
  return evidenceRoot;
}

test("claude read-only argv profile refuses write-capable tools and required isolation flags", () => {
  const profile = Array.from(oneShotReadOnlyArgs("claude") ?? [], (flag) => String(flag));
  assert.deepEqual(profile, [...CLAUDE_READ_ONLY]);
  const tools = profile[profile.indexOf("--tools") + 1];
  assert.equal(tools, "Read,Glob,Grep");
  assert.equal(WRITE_TOOLS.test(tools ?? ""), false);
  assert.ok(profile.includes("--restricted"));
  assert.ok(profile.includes("--safe-mode"));
  assert.ok(profile.includes("--permission-mode"));
  assert.ok(profile.includes("--permission-prompts"));
  assert.equal(profile[profile.indexOf("--permission-mode") + 1], "plan");
  assert.equal(profile[profile.indexOf("--permission-prompts") + 1], "none");
  assert.equal(profile.some((flag) => /Write|Edit|Bash|--dangerously-skip-permissions|--allowedTools|--bare/.test(flag) && flag !== "Read,Glob,Grep"), false);
});

test("fixture harness writes only when the claude read-only profile is weakened", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "kxm-claude-fixture-profile-"));
  const probe = join(sandbox, PROBE_NAME);
  try {
    const refused = await defaultSpawn(process.execPath, [fixture, ...CLAUDE_READ_ONLY], {
      cwd: sandbox,
      env: { ...process.env, KXM_WRITE_PROBE_NAME: PROBE_NAME },
      input: WRITE_PROMPT,
      timeoutMs: 5_000,
    });
    assert.equal(refused.code, 0);
    assert.equal(existsSync(probe), false);
    const refusedPayload = JSON.parse(refused.stdout) as { is_error?: boolean; result?: string };
    assert.equal(refusedPayload.is_error, true);
    assert.match(refusedPayload.result ?? "", /"outcome":"passed"/);

    const weakenedDroppedFlags = await defaultSpawn(
      process.execPath,
      [fixture, "--tools", "Read,Write", "--restricted", "--safe-mode"],
      {
        cwd: sandbox,
        env: { ...process.env, KXM_WRITE_PROBE_NAME: PROBE_NAME },
        input: WRITE_PROMPT,
        timeoutMs: 5_000,
      },
    );
    assert.equal(weakenedDroppedFlags.code, 0);
    assert.equal(existsSync(probe), true, "dropping --permission-mode/--permission-prompts must allow a write");
    unlinkSync(probe);
    assert.equal(existsSync(probe), false);

    const fullPinWithWriteTools = CLAUDE_READ_ONLY.map((flag, index, flags) => (
      flags[index - 1] === "--tools" ? "Read,Glob,Grep,Write" : flag
    ));
    const weakenedWriteTools = await defaultSpawn(
      process.execPath,
      [fixture, ...fullPinWithWriteTools],
      {
        cwd: sandbox,
        env: { ...process.env, KXM_WRITE_PROBE_NAME: PROBE_NAME },
        input: WRITE_PROMPT,
        timeoutMs: 5_000,
      },
    );
    assert.equal(weakenedWriteTools.code, 0);
    assert.equal(existsSync(probe), true, "full pin with --tools Read,Glob,Grep,Write must allow a write");
  } finally {
    removeTempDir(sandbox);
  }
});

test("write-refused Claude fixture cannot settle as passed and does not land a file", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "kxm-claude-write-refuse-"));
  const probe = join(sandbox, PROBE_NAME);
  const timeoutMs = 15_000;
  let capturedArgs: readonly string[] = [];
  const producer = createKxmOneShotProducer({
    projectRoot: sandbox,
    evidenceRoot: privateEvidenceRoot(sandbox),
    defaultModel: "fable",
    timeoutMs,
    probeHarness: authenticated,
    spawnProcess: async (command, args, options) => {
      assert.equal(command, "claude");
      capturedArgs = args;
      return defaultSpawn(process.execPath, [fixture, ...args], {
        ...options,
        env: { ...options.env, KXM_WRITE_PROBE_NAME: PROBE_NAME },
      });
    },
  });
  try {
    const result = await producer.produce(request());
    assert.equal(existsSync(probe), false, "read-only Claude fixture must not land a write");
    assert.notEqual(result.outcome, "passed");
    assert.equal(result.outcome, "failed");
    assert.equal(result.providerMetadata?.processStatus, "completed");
    assert.ok((result.latencyMs ?? Number.POSITIVE_INFINITY) < timeoutMs);
    for (const flag of CLAUDE_READ_ONLY) assert.ok(capturedArgs.includes(flag), `missing ${flag}`);
    assert.equal(capturedArgs[capturedArgs.indexOf("--tools") + 1], "Read,Glob,Grep");
    assert.equal(result.tokensIn, 12);
    assert.equal(result.tokensOut, 8);
  } finally {
    await producer.close();
    removeTempDir(sandbox);
  }
});

const smokeTest = process.env.KXM_SMOKE ? test : test.skip;
smokeTest("live Claude read-only one-shot refuses a write in a temp sandbox", { timeout: 180_000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "kxm-claude-live-write-refuse-"));
  const probe = join(sandbox, PROBE_NAME);
  const timeoutMs = 120_000;
  const before = new Set(readdirSync(sandbox));
  const producer = createKxmOneShotProducer({
    projectRoot: sandbox,
    evidenceRoot: privateEvidenceRoot(sandbox),
    defaultModel: "fable",
    timeoutMs,
  });
  try {
    const result = await producer.produce(request({
      runId: "smoke_claude_write_refusal",
      assignmentId: "asg_smoke_claude_write_refusal",
      attemptId: "att_smoke_claude_write_refusal",
      capability: "smoke-only",
    }));
    assert.equal(existsSync(probe), false, "Claude read-only one-shot must not persist WRITE_PROBE.txt");
    const extras = readdirSync(sandbox).filter((name) => !before.has(name) && name !== "evidence");
    assert.deepEqual(extras, [], `unexpected sandbox writes: ${extras.join(", ")}`);
    assert.notEqual(result.outcome, "passed", "write refusal must not settle as passed");
    assert.equal(result.providerMetadata?.processStatus, "completed");
    assert.equal(result.providerMetadata?.processExitCode, 0);
    assert.ok((result.tokensOut ?? 0) > 0, "live witness must reach the model (tokensOut > 0)");
    assert.ok((result.latencyMs ?? Number.POSITIVE_INFINITY) < timeoutMs);
    assert.equal(result.harness, "claude");
  } finally {
    await producer.close();
    removeTempDir(sandbox);
  }
});
