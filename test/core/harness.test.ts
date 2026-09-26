import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadKxmProject, KxmConfigError } from "../../plugins/kxm/src/project-config.ts";
import { initializeKxmProject } from "../../plugins/kxm/src/init.ts";
import * as kxmHarness from "../../plugins/kxm/src/harness.ts";
import {
  BUILTIN_HARNESS_IDS,
  BUILTIN_HARNESSES,
  DEFAULT_HARNESS,
  eligibleHarnesses,
  findWinNpmInnerExe,
  formatHarnessInventory,
  harnessCommandCandidates,
  harnessSpawnUsesShell,
  isWindowsHarnessShim,
  planHarnessUpdate,
  probeHarnessAssignment,
  probeHarnessAssignmentAsync,
  probeHarnesses,
  probeHarnessesAsync,
  probeHarnessesForModel,
  probeHarnessesForModelAsync,
  runHarnessUpdate,
  validateHarnessModelPair,
  type HarnessCommandResult,
  type HarnessInventory,
  type HarnessStatus,
} from "../../plugins/kxm/src/harness.ts";
import { computeKxmResourcePermissionDiff } from "../../plugins/kxm/src/permission.ts";
import { makeGitRoot } from "../helpers/git-root.ts";

function runner(handlers: Record<string, HarnessCommandResult>): (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult {
  return (command, args) => {
    const key = [command, ...args].join(" ");
    return handlers[key] ?? { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" };
  };
}

function recordingRunner(handlers: Record<string, HarnessCommandResult>): {
  runCommand: (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    runCommand: (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      return handlers[key] ?? { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" };
    },
  };
}

function status(inventory: HarnessInventory, id: string): HarnessStatus {
  const entry = inventory.harnesses.find((candidate) => candidate.id === id);
  assert(entry, `missing harness ${id}`);
  return entry;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const grokLoginFixture = JSON.parse(readFileSync(join(repoRoot, "test/fixtures/harness/auth-fixtures.json"), "utf8")) as {
  grok: { stdout: string; stderr: string; exitCode: number };
};

function issueCodes(error: unknown): string[] {
  assert(error instanceof KxmConfigError, `expected KxmConfigError, received ${String(error)}`);
  return error.issues.map((candidate) => candidate.code);
}

test("builtin catalog defaults to headless Pi and lists known harnesses", () => {
  assert.equal(DEFAULT_HARNESS, "pi");
  assert.deepEqual([...BUILTIN_HARNESS_IDS], ["pi", "omp", "claude", "kimi", "codex", "deepseek", "grok", "agy"]);
});

test("Claude catalog pins documented read-only one-shot flags without write-capable tools", () => {
  const entry = BUILTIN_HARNESSES.find((candidate) => candidate.id === "claude");
  const readOnly = [
    "--tools", "Read,Glob,Grep",
    "--restricted",
    "--safe-mode",
    "--permission-mode", "plan",
    "--permission-prompts", "none",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
  assert.deepEqual(entry?.oneShot?.argv, ["-p", ...readOnly, "--output-format", "json"]);
  assert.equal(entry?.oneShot?.promptVia, "stdin");
  const tools = readOnly[readOnly.indexOf("--tools") + 1];
  assert.equal(tools, "Read,Glob,Grep");
  assert.equal(/(?:^|,)(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|REPL)(?:,|$)/.test(tools ?? ""), false);
  assert.equal(readOnly.includes("--dangerously-skip-permissions"), false);
  assert.equal(readOnly.includes("--allowedTools"), false);
});

test("Codex catalog pins documented read-only noninteractive flags and keeps exec-policy rules", () => {
  const entry = BUILTIN_HARNESSES.find((candidate) => candidate.id === "codex");
  assert.deepEqual(entry?.oneShot?.argv, [
    "exec", "--sandbox", "read-only", "--ignore-user-config",
    "-c", 'approval_policy="never"', "--json", "-",
  ]);
  assert.equal(entry?.oneShot?.promptVia, "stdin");
});

test("AGY and Kimi catalogs pin documented read-only sandboxed flags", () => {
  const agyEntry = BUILTIN_HARNESSES.find((candidate) => candidate.id === "agy");
  assert.deepEqual(agyEntry?.oneShot?.argv, [
    "--mode", "plan", "--sandbox", "--disable-slash-commands", "--output-format", "json", "-p",
  ]);
  assert.equal(agyEntry?.oneShot?.promptVia, "arg");

  const kimiEntry = BUILTIN_HARNESSES.find((candidate) => candidate.id === "kimi");
  assert.deepEqual(kimiEntry?.oneShot?.argv, [
    "--plan", "--output-format", "stream-json", "-p",
  ]);
  assert.equal(kimiEntry?.oneShot?.promptVia, "arg");
});

test("win32 harness probe tries .exe then npm .cmd after a missing bare command", () => {
  assert.deepEqual([...harnessCommandCandidates("claude", "linux")], ["claude"]);
  assert.deepEqual([...harnessCommandCandidates("claude", "win32")], ["claude", "claude.exe", "claude.cmd"]);
  assert.deepEqual([...harnessCommandCandidates("claude.exe", "win32")], ["claude.exe"]);
  assert.equal(harnessSpawnUsesShell("claude", "win32"), false);
  assert.equal(harnessSpawnUsesShell("claude.cmd", "win32"), true);
  assert.equal(harnessSpawnUsesShell("claude.cmd", "linux"), false);
  assert.equal(harnessSpawnUsesShell("claude.cmd & calc.exe", "win32"), false);
  assert.equal(isWindowsHarnessShim("claude.cmd"), true);
  assert.equal(isWindowsHarnessShim("claude"), false);

  const recorded = recordingRunner({
    "claude --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
    "claude.exe --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
    "claude.cmd --version": { ok: true, code: 0, stdout: "2.1.263 (Claude Code)\n", stderr: "" },
    "claude.cmd auth status": {
      ok: true,
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      stderr: "",
    },
  });
  const inventory = probeHarnesses({
    platform: "win32",
    runCommand: recorded.runCommand,
  });
  const claude = status(inventory, "claude");
  assert.equal(claude.detected, true);
  assert.equal(claude.command, "claude.cmd");
  assert.equal(claude.authenticated, true);
  assert.equal(claude.dispatch?.status, "yes");
  assert(claude.issues.includes("windows_shim"));
  const piShim = probeHarnesses({
    platform: "win32",
    runCommand: runner({
      "pi --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
      "pi.exe --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
      "pi.cmd --version": { ok: true, code: 0, stdout: "0.85.1\n", stderr: "" },
    }),
  });
  assert.equal(status(piShim, "pi").detected, true);
  assert.equal(status(piShim, "pi").command, "pi.cmd");
  assert.equal(status(piShim, "pi").dispatch?.reason, "auth_context_required");
  assert(status(piShim, "pi").issues.includes("windows_shim"));
  assert.deepEqual(recorded.calls.filter((call) => call.startsWith("claude")), [
    "claude --version",
    "claude.exe --version",
    "claude.cmd --version",
    "claude.cmd auth status",
  ]);

  const linux = probeHarnesses({
    platform: "linux",
    runCommand: runner({
      "claude --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
    }),
  });
  assert.equal(status(linux, "claude").detected, false);
  assert.equal(status(linux, "claude").dispatch?.reason, "not_detected");
});

test("win32 assignment probe uses the npm .cmd shim for Claude Code", () => {
  const probed = probeHarnessAssignment({
    harness: "claude",
    platform: "win32",
    runCommand: runner({
      "claude --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
      "claude.exe --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
      "claude.cmd --version": { ok: true, code: 0, stdout: "2.1.263\n", stderr: "" },
      "claude.cmd auth status": {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod: "console" }),
        stderr: "",
      },
    }),
  });
  assert.equal(probed.detected, true);
  assert.equal(probed.command, "claude.cmd");
  assert.equal(probed.authenticated, true);
  assert(probed.issues.includes("windows_shim"));
});

test("win32 probe prefers the npm-package claude.exe over the .cmd shim", () => {
  const npmDir = String.raw`C:\Users\me\AppData\Roaming\npm`;
  const inner = String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`;
  const cmdShim = String.raw`C:\Users\me\AppData\Roaming\npm\claude.cmd`;
  assert.equal(
    findWinNpmInnerExe("claude", {
      platform: "win32",
      pathEnv: npmDir,
      existsSync: (path) => path === cmdShim || path === inner,
    }),
    inner,
  );
  assert.equal(
    findWinNpmInnerExe("claude", {
      platform: "linux",
      pathEnv: npmDir,
      existsSync: () => true,
    }),
    undefined,
  );

  const recorded = recordingRunner({
    "claude --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
    "claude.exe --version": { ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" },
    [`${inner} --version`]: { ok: true, code: 0, stdout: "2.1.263 (Claude Code)\n", stderr: "" },
    [`${inner} auth status`]: {
      ok: true,
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      stderr: "",
    },
  });
  const inventory = probeHarnesses({
    platform: "win32",
    env: { PATH: npmDir },
    existsSync: (path) => path === cmdShim || path === inner,
    runCommand: recorded.runCommand,
  });
  const claude = status(inventory, "claude");
  assert.equal(claude.detected, true);
  assert.equal(claude.command, inner);
  assert.equal(claude.authenticated, true);
  assert.equal(claude.dispatch?.status, "yes");
  assert.equal(claude.issues.includes("windows_shim"), false);
  assert.deepEqual(recorded.calls.filter((call) => call.includes("claude")), [
    "claude --version",
    "claude.exe --version",
    `${inner} --version`,
    `${inner} auth status`,
  ]);
});

test("probe reports detect/auth without a preferences overlay", () => {
  const inventory = probeHarnesses({
    runCommand: runner({
      "pi --version": { ok: true, code: 0, stdout: "pi 0.84.4\n", stderr: "" },
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": { ok: false, code: 1, stdout: "", stderr: "logged out" },
    }),
  });
  const pi = inventory.harnesses.find((entry) => entry.id === "pi");
  const claude = inventory.harnesses.find((entry) => entry.id === "claude");
  const kimi = inventory.harnesses.find((entry) => entry.id === "kimi");
  assert.equal(pi?.detected, true);
  assert.equal(pi?.authenticated, null);
  assert(pi?.issues.includes("auth_context_required"));
  assert.equal(pi?.mode, "headless");
  assert.equal(claude?.detected, true);
  assert.equal(claude?.authenticated, null);
  assert(claude?.issues.includes("auth_unparsed"));
  assert.equal(kimi?.detected, false);
  assert.match(formatHarnessInventory(inventory), /default harness: pi/);
  assert(!JSON.stringify(inventory).includes("preferences"));
});

test("inventory selects the requested project default even when that harness is unavailable", async () => {
  const inventory = await probeHarnessesAsync({
    defaultHarness: "claude",
    runCommand: runner({
      "pi --version": { ok: true, code: 0, stdout: "pi\n", stderr: "" },
    }),
  });
  assert.equal(inventory.defaultHarness, "claude");
  assert.deepEqual(inventory.harnesses.filter((entry) => entry.default).map((entry) => entry.id), ["claude"]);
  assert.equal(inventory.harnesses.find((entry) => entry.id === "claude")?.detected, false);
  assert.match(formatHarnessInventory(inventory), /^claude\s+yes\s+no\b/m);
});

test("update plans native commands and dry-run does not spawn", () => {
  const inventory = probeHarnesses({
    runCommand: runner({
      "pi --version": { ok: true, code: 0, stdout: "pi\n", stderr: "" },
    }),
  });
  const planned = planHarnessUpdate(inventory, { scope: "all" });
  assert(planned.some((step) => step.harness === "pi" && step.scope === "self" && step.args.includes("--self")));
  assert(planned.some((step) => step.harness === "pi" && step.scope === "extensions"));
  assert(planned.some((step) => step.harness === "pi" && step.scope === "models"));
  assert(planned.every((step) => step.harness !== "claude"), "absent harnesses are not updated");
  const dry = runHarnessUpdate(planned, { dryRun: true, runCommand: () => { throw new Error("spawned"); } });
  assert(dry.every((step) => step.outcome === "would"));
});

test("unknown harness update is skipped fail-closed", () => {
  const inventory = probeHarnesses({ runCommand: () => ({ ok: false, code: null, stdout: "", stderr: "", error: "ENOENT" }) });
  const steps = planHarnessUpdate(inventory, { harness: "nope", scope: "self" });
  assert.equal(steps[0]?.detail, "unknown_harness");
});

test("fresh template names admitted harnesses; omitted harness still loads; unknown ids fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-harness-config-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-harness-state-"));
  try {
    makeGitRoot(root);
    initializeKxmProject(root, { projectId: "prj_01JHARNESSTEST00000000000", projectName: "Harness", localStateRoot: stateRoot });
    const bundle = loadKxmProject(root);
    assert.equal(bundle.project.value.defaultHarness, "pi");
    assert.equal(bundle.agents.get("implementer")?.value.role, "writer");
    assert.equal(bundle.agents.get("coordinator")?.value.role, "planner");
    writeFileSync(join(root, ".kxm", "agents", "coordinator.yaml"), [
      "schema: kxm.agent.v1",
      "purpose: Coordinate the pinned workflow and emit schema-validated commands.",
      "tools:",
      "  preset: coordinator",
      "defaultRepositoryAccess: read",
      "repositories:",
      "  control: read",
      "network: provider-only",
      "resultSchema: kxm.assignment-result.v1",
      "",
    ].join("\n"));
    const omitted = loadKxmProject(root);
    assert.equal(omitted.agents.get("coordinator")?.value.harness, undefined);

    writeFileSync(join(root, ".kxm", "agents", "implementer.yaml"), [
      "schema: kxm.agent.v1",
      "purpose: Implement the approved change within the declared repository scope.",
      "harness: nope",
      "tools:",
      "  preset: workspace-writer",
      "defaultRepositoryAccess: none",
      "repositories:",
      "  control: write",
      "network: provider-only",
      "resultSchema: kxm.assignment-result.v1",
      "",
    ].join("\n"));
    assert.throws(() => loadKxmProject(root), (error: unknown) => error instanceof KxmConfigError && error.issues.some((issue) => issue.code === "harness_unknown"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("changing harness away from pi is a permission expansion; explicit pi matches omit", () => {
  const base = { schema: "kxm.agent.v1", purpose: "x" };
  const same = computeKxmResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, harness: "pi" });
  assert.equal(same.filter((change) => change.field === "harness").length, 0);
  const expanded = computeKxmResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, harness: "claude" });
  assert.equal(expanded[0]?.field, "harness");
  assert.equal(expanded[0]?.direction, "expansion");
});

test("claude auth parses JSON loggedIn and does not treat exit-0 garbage as yes", () => {
  const inventory = probeHarnesses({
    runCommand: runner({
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": {
        ok: true,
        code: 0,
        stdout: `${JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })}\n`,
        stderr: "",
      },
    }),
  });
  const claude = status(inventory, "claude");
  assert.equal(claude.detected, true);
  assert.equal(claude.authenticated, true);
  assert.match(formatHarnessInventory(inventory), /^claude\s+no\s+yes\s+yes\b/m);

  const garbage = probeHarnesses({
    runCommand: runner({
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": { ok: true, code: 0, stdout: "logged in maybe\n", stderr: "" },
    }),
  });
  const unparsed = status(garbage, "claude");
  assert.equal(unparsed.authenticated, null);
  assert(unparsed.issues.includes("auth_unparsed"));
  assert.match(formatHarnessInventory(garbage), /\bclaude\b.+\bunknown\b/);

  const loggedOut = probeHarnesses({
    runCommand: runner({
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": {
        ok: true,
        code: 0,
        stdout: `${JSON.stringify({ loggedIn: false, authMethod: "claude.ai" })}\n`,
        stderr: "",
      },
    }),
  });
  assert.equal(status(loggedOut, "claude").authenticated, false);

  const nonzeroUnparsed = probeHarnesses({
    runCommand: runner({
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": { ok: false, code: 1, stdout: "", stderr: "logged out" },
    }),
  });
  assert.equal(status(nonzeroUnparsed, "claude").authenticated, null);
  assert(status(nonzeroUnparsed, "claude").issues.includes("auth_unparsed"));

  const nonzeroLoggedOut = probeHarnesses({
    runCommand: runner({
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": {
        ok: false,
        code: 1,
        stdout: `${JSON.stringify({ loggedIn: false })}\n`,
        stderr: "",
      },
    }),
  });
  assert.equal(status(nonzeroLoggedOut, "claude").authenticated, false);

  const spawnError = probeHarnesses({
    runCommand: runner({
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": { ok: false, code: null, stdout: "", stderr: "", error: "ETIMEDOUT" },
    }),
  });
  assert.equal(status(spawnError, "claude").authenticated, null);
  assert(status(spawnError, "claude").issues.includes("auth_probe_error"));

  const conflict = probeHarnesses({
    runCommand: runner({
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": {
        ok: true,
        code: 1,
        stdout: `${JSON.stringify({ loggedIn: true })}\n`,
        stderr: "",
      },
    }),
  });
  assert.equal(status(conflict, "claude").authenticated, null);
  assert(status(conflict, "claude").issues.includes("auth_conflict:ok,code"));
});

test("codex login status matches only known ChatGPT and API-key shapes", () => {
  const chatgpt = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "", stderr: "Logged in using ChatGPT\n" },
    }),
  });
  const chatgptStatus = status(chatgpt, "codex");
  assert.equal(chatgptStatus.authenticated, true);
  assert(!chatgptStatus.issues.includes("auth_api_key"));

  const apiKeyExact = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "", stderr: "Logged in using an API key\n" },
    }),
  });
  const apiKeyExactStatus = status(apiKeyExact, "codex");
  assert.equal(apiKeyExactStatus.authenticated, true);
  assert(apiKeyExactStatus.issues.includes("auth_api_key"));
  assert.match(formatHarnessInventory(apiKeyExact), /^codex\s+no\s+yes\s+yes\b.*API key/m);

  const apiKeySpaced = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "", stderr: "Logged in using an API key - sk-***mask\n" },
    }),
  });
  const apiKeySpacedStatus = status(apiKeySpaced, "codex");
  assert.equal(apiKeySpacedStatus.authenticated, true);
  assert(apiKeySpacedStatus.issues.includes("auth_api_key"));
  assert.doesNotMatch(`${JSON.stringify(apiKeySpaced)}\n${formatHarnessInventory(apiKeySpaced)}`, /sk-\*\*\*mask/);

  const generic = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "Logged in\n", stderr: "" },
    }),
  });
  const genericStatus = status(generic, "codex");
  assert.equal(genericStatus.authenticated, null);
  assert(genericStatus.issues.includes("auth_unparsed"));

  const garbage = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "garbage", stderr: "nope" },
    }),
  });
  assert.equal(status(garbage, "codex").authenticated, null);
  assert(status(garbage, "codex").issues.includes("auth_unparsed"));

  const negative = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "Not logged in\n", stderr: "" },
    }),
  });
  assert.equal(status(negative, "codex").authenticated, false);

  const nonzeroUnparsed = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: false, code: 1, stdout: "", stderr: "error" },
    }),
  });
  assert.equal(status(nonzeroUnparsed, "codex").authenticated, null);
  assert(status(nonzeroUnparsed, "codex").issues.includes("auth_unparsed"));

  const nonzeroLogout = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: false, code: 1, stdout: "Not logged in\n", stderr: "" },
    }),
  });
  assert.equal(status(nonzeroLogout, "codex").authenticated, false);

  const keyGarbage = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "", stderr: "Logged in using an API key-nonsense\n" },
    }),
  });
  assert.equal(status(keyGarbage, "codex").authenticated, null);
  assert(status(keyGarbage, "codex").issues.includes("auth_unparsed"));

  const hyphenNoSpaces = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "", stderr: "Logged in using an API key -\n" },
    }),
  });
  assert.equal(status(hyphenNoSpaces, "codex").authenticated, null);

  const conflictPositive = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: true, code: 1, stdout: "", stderr: "Logged in using ChatGPT\n" },
    }),
  });
  assert.equal(status(conflictPositive, "codex").authenticated, null);
  assert(status(conflictPositive, "codex").issues.includes("auth_conflict:ok,code"));

  const errorWithLogout = probeHarnesses({
    runCommand: runner({
      "codex --version": { ok: true, code: 0, stdout: "codex 0.1\n", stderr: "" },
      "codex login status": { ok: false, code: 1, stdout: "Not logged in\n", stderr: "", error: "EACCES" },
    }),
  });
  assert.equal(status(errorWithLogout, "codex").authenticated, null);
  assert(status(errorWithLogout, "codex").issues.includes("auth_probe_error"));
});

test("pi inventory without a named provider or model is unknown and skips global auth check", () => {
  const recorded = recordingRunner({
    "pi --version": { ok: true, code: 0, stdout: "pi 0.84.4\n", stderr: "" },
    "pi auth check": { ok: true, code: 0, stdout: "openrouter  ready\n", stderr: "" },
  });
  const inventory = probeHarnesses({ runCommand: recorded.runCommand });
  const pi = status(inventory, "pi");
  assert.equal(pi.detected, true);
  assert.equal(pi.authenticated, null);
  assert(pi.issues.includes("auth_context_required"));
  assert(!recorded.calls.includes("pi auth check"));
  assert.match(formatHarnessInventory(inventory), /^pi\s+yes\s+yes\s+unknown\b/m);
  assert.doesNotMatch(JSON.stringify(inventory), /openrouter  ready/);
});

test("grok catalog is observational either-mode and parses the confirmed login line", () => {
  assert(BUILTIN_HARNESS_IDS.includes("grok"));
  const grokEntry = BUILTIN_HARNESSES.find((entry) => entry.id === "grok");
  assert.equal(grokEntry?.mode, "either");
  assert.equal(grokEntry?.default, false);
  assert.deepEqual(grokEntry?.update.self, ["update"]);
  assert.equal(grokEntry?.update.models, undefined);
  assert(!("price" in (grokEntry ?? {})));
  assert(!JSON.stringify(BUILTIN_HARNESSES).includes("supervised"));

  const loggedIn = probeHarnesses({
    runCommand: runner({
      "grok --version": { ok: true, code: 0, stdout: "grok 0.1.150\n", stderr: "" },
      "grok models": {
        ok: grokLoginFixture.grok.exitCode === 0,
        code: grokLoginFixture.grok.exitCode,
        stdout: grokLoginFixture.grok.stdout,
        stderr: grokLoginFixture.grok.stderr,
      },
    }),
  });
  assert.equal(status(loggedIn, "grok").authenticated, true);

  const garbage = probeHarnesses({
    runCommand: runner({
      "grok --version": { ok: true, code: 0, stdout: "grok 0.1.150\n", stderr: "" },
      "grok models": { ok: true, code: 0, stdout: "Available models:\n", stderr: "" },
    }),
  });
  assert.equal(status(garbage, "grok").authenticated, null);
  assert(status(garbage, "grok").issues.includes("auth_unparsed"));

  const commandFailure = probeHarnesses({
    runCommand: runner({
      "grok --version": { ok: true, code: 0, stdout: "grok 0.1.150\n", stderr: "" },
      "grok models": { ok: false, code: 1, stdout: "", stderr: "unavailable" },
    }),
  });
  assert.equal(status(commandFailure, "grok").authenticated, null);
  assert(status(commandFailure, "grok").issues.includes("auth_unparsed"));
});

test("agy catalog is observational either-mode and parses the committed models probe", () => {
  assert(BUILTIN_HARNESS_IDS.includes("agy"));
  const agyEntry = BUILTIN_HARNESSES.find((entry) => entry.id === "agy");
  assert.equal(agyEntry?.label, "Antigravity CLI");
  assert.equal(agyEntry?.mode, "either");
  assert.equal(agyEntry?.default, false);
  assert.deepEqual([...agyEntry?.commands ?? []], ["agy"]);
  assert.deepEqual([...agyEntry?.versionArgs ?? []], ["--version"]);
  assert.deepEqual([...agyEntry?.authArgs ?? []], ["models"]);
  assert.deepEqual(agyEntry?.update.self, ["update"]);
  assert.equal(agyEntry?.update.models, undefined);
  const probe = readFileSync(join(repoRoot, "test/fixtures/harness/agy-models-probe.txt"), "utf8");
  const loggedIn = probeHarnesses({
    runCommand: runner({
      "agy --version": { ok: true, code: 0, stdout: "agy 1.1.27\n", stderr: "" },
      "agy models": { ok: true, code: 0, stdout: probe, stderr: "" },
    }),
  });
  assert.equal(status(loggedIn, "agy").authenticated, true);
  assert.equal(status(loggedIn, "agy").detected, true);

  const empty = probeHarnesses({
    runCommand: runner({
      "agy --version": { ok: true, code: 0, stdout: "agy 1.1.27\n", stderr: "" },
      "agy models": { ok: true, code: 0, stdout: "", stderr: "" },
    }),
  });
  assert.equal(status(empty, "agy").authenticated, false);
  assert(status(empty, "agy").issues.includes("not_authenticated"));

  const nonzero = probeHarnesses({
    runCommand: runner({
      "agy --version": { ok: true, code: 0, stdout: "agy 1.1.27\n", stderr: "" },
      "agy models": { ok: false, code: 1, stdout: "", stderr: "unauthenticated" },
    }),
  });
  assert.equal(status(nonzero, "agy").authenticated, false);
  assert(status(nonzero, "agy").issues.includes("not_authenticated"));

  const garbage = probeHarnesses({
    runCommand: runner({
      "agy --version": { ok: true, code: 0, stdout: "agy 1.1.27\n", stderr: "" },
      "agy models": { ok: true, code: 0, stdout: "Fetching available models...\n", stderr: "" },
    }),
  });
  assert.equal(status(garbage, "agy").authenticated, null);
  assert(status(garbage, "agy").issues.includes("auth_unparsed"));

  const eligible = kxmHarness.eligibleHarnesses({
    defaultHarness: "pi",
    harnesses: [
      { id: "pi", label: "Pi", default: true, mode: "headless", detected: true, authenticated: null, canUpdate: { self: true, extensions: true, models: true }, issues: ["auth_context_required"] },
      { id: "agy", label: "Antigravity CLI", default: false, mode: "either", detected: true, authenticated: true, canUpdate: { self: true, extensions: false, models: false }, issues: [] },
    ],
  });
  assert.deepEqual([...eligible], ["agy"]);
});

test("deepseek stays unknown without a secret-bearing config-list command", () => {
  const recorded = recordingRunner({
    "kimi --version": { ok: true, code: 0, stdout: "kimi 0.1\n", stderr: "" },
    "deepseek --version": { ok: true, code: 0, stdout: "deepseek 0.1\n", stderr: "" },
    "kimi provider list": { ok: true, code: 0, stdout: "managed:kimi-code type=kimi models=4 source=oauth\n", stderr: "" },
    "kimi provider list --json": { ok: true, code: 0, stdout: "{\"apiKey\":\"sk-secret\"}\n", stderr: "" },
  });
  const inventory = probeHarnesses({ runCommand: recorded.runCommand });
  const kimiEntry = status(inventory, "kimi");
  assert.equal(kimiEntry.detected, true);
  assert.equal(kimiEntry.authenticated, true);
  assert.match(formatHarnessInventory(inventory), /^kimi\s+no\s+yes\s+yes\b/m);

  for (const id of ["deepseek"] as const) {
    const entry = status(inventory, id);
    assert.equal(entry.detected, true);
    assert.equal(entry.authenticated, null);
    assert(entry.issues.includes("auth_unknown"));
    assert.match(formatHarnessInventory(inventory), new RegExp(`^${id}\\s+no\\s+yes\\s+unknown\\b`, "m"));
  }
  assert(!recorded.calls.some((call) => call.includes("--json") || call.includes("doctor") || call === "gemini"));
  assert.doesNotMatch(JSON.stringify(inventory), /sk-secret|apiKey/);
});

test("eligibleHarnesses is pure inventory filtering and fail-closes when empty", () => {
  assert.equal(typeof kxmHarness.eligibleHarnesses, "function");
  const eligible = kxmHarness.eligibleHarnesses({
    defaultHarness: "pi",
    harnesses: [
      { id: "pi", label: "Pi", default: true, mode: "headless", detected: true, authenticated: null, canUpdate: { self: true, extensions: true, models: true }, issues: ["auth_context_required"] },
      { id: "claude", label: "Claude Code", default: false, mode: "either", detected: true, authenticated: true, canUpdate: { self: true, extensions: true, models: false }, issues: [] },
      { id: "codex", label: "Codex", default: false, mode: "either", detected: true, authenticated: false, canUpdate: { self: true, extensions: false, models: false }, issues: ["not_authenticated"] },
      { id: "kimi", label: "Kimi Code", default: false, mode: "either", detected: true, authenticated: null, canUpdate: { self: true, extensions: false, models: false }, issues: ["auth_unknown"] },
      { id: "grok", label: "Grok", default: false, mode: "either", detected: true, authenticated: true, canUpdate: { self: true, extensions: false, models: false }, issues: [] },
      { id: "ghost", label: "Ghost", default: false, mode: "either", detected: false, authenticated: true, canUpdate: { self: false, extensions: false, models: false }, issues: [] },
    ],
  });
  assert.deepEqual([...eligible], ["claude", "grok"]);

  assert.throws(
    () => kxmHarness.eligibleHarnesses({
      defaultHarness: "pi",
      harnesses: [
        { id: "pi", label: "Pi", default: true, mode: "headless", detected: true, authenticated: null, canUpdate: { self: true, extensions: true, models: true }, issues: ["auth_context_required"] },
        { id: "claude", label: "Claude Code", default: false, mode: "either", detected: true, authenticated: false, canUpdate: { self: true, extensions: true, models: false }, issues: ["not_authenticated"] },
      ],
    }),
    /no_authenticated_harness/,
  );
});

test("harness inventory JSON and text never echo raw auth output", () => {
  const inventory = probeHarnesses({
    runCommand: runner({
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": {
        ok: true,
        code: 0,
        stdout: `${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "user@example.com", token: "sk-secret" })}\n`,
        stderr: "",
      },
      "codex --version": { ok: true, code: 0, stdout: "codex\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "", stderr: "Logged in using ChatGPT\naccount=user@example.com\n" },
    }),
  });
  const serialized = `${JSON.stringify(inventory)}\n${formatHarnessInventory(inventory)}`;
  assert.doesNotMatch(serialized, /user@example.com|sk-secret|Logged in using ChatGPT|"token"/);
  assert.match(formatHarnessInventory(inventory), /\bunknown\b|\byes\b|\bno\b/);
  assert.doesNotMatch(formatHarnessInventory(inventory), /\bn\/a\b/);
});

test("config with a Grok model under harness claude is rejected at validation", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-harness-matrix-"));
  try {
    cpSync(join(repoRoot, "examples/project"), root, { recursive: true });
    makeGitRoot(root);
    makeGitRoot(join(root, "repositories", "api"));
    makeGitRoot(join(root, "repositories", "web"));
    const agentFile = join(root, ".kxm", "agents", "critic-2.yaml");
    writeFileSync(agentFile, `${readFileSync(agentFile, "utf8").trimEnd()}\nharness: claude\n`);
    assert.throws(() => loadKxmProject(root), (error: unknown) => issueCodes(error).includes("harness_unhosted_model"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateHarnessModelPair rejects unhosted models and native Pi impersonation", () => {
  // Unknown harness
  assert.equal(validateHarnessModelPair("unknown", "model").valid, false);
  assert.equal(validateHarnessModelPair("unknown", "model").issue, "harness_unknown");

  // Claude: only Anthropic
  assert.equal(validateHarnessModelPair("claude", { provider: "anthropic", model: "fable" }).valid, true);
  assert.equal(validateHarnessModelPair("claude", "claude-3-5-sonnet").valid, true);
  assert.equal(validateHarnessModelPair("claude", { provider: "xai", model: "grok-4.6" }).valid, false);
  assert.equal(validateHarnessModelPair("claude", { provider: "xai", model: "grok-4.6" }).issue, "harness_unhosted_model");
  assert.equal(validateHarnessModelPair("claude", "grok-4.6").valid, false);

  // Codex: only OpenAI
  assert.equal(validateHarnessModelPair("codex", { provider: "openai", model: "gpt-5.6-sol" }).valid, true);
  assert.equal(validateHarnessModelPair("codex", "gpt-4o").valid, true);
  assert.equal(validateHarnessModelPair("codex", { provider: "google", model: "gemini-3.8-flash-high" }).valid, false);
  assert.equal(validateHarnessModelPair("codex", "gemini-3.8-flash-high").valid, false);

  // Grok: only xAI
  assert.equal(validateHarnessModelPair("grok", { provider: "xai", model: "grok-4.6" }).valid, true);
  assert.equal(validateHarnessModelPair("grok", "grok-4.6").valid, true);
  assert.equal(validateHarnessModelPair("grok", { provider: "anthropic", model: "fable" }).valid, false);
  assert.equal(validateHarnessModelPair("grok", "claude-3-5-sonnet").valid, false);

  // Agy: only Google Gemini
  assert.equal(validateHarnessModelPair("agy", { provider: "google", model: "gemini-3.8-flash-high" }).valid, true);
  assert.equal(validateHarnessModelPair("agy", "gemini-3.8-flash-high").valid, true);
  assert.equal(validateHarnessModelPair("agy", { provider: "openai", model: "gpt-5.6-sol" }).valid, false);
  assert.equal(validateHarnessModelPair("agy", "gpt-5.6-sol").valid, false);

  // Pi: allowed aggregators vs native brake
  assert.equal(validateHarnessModelPair("pi", { provider: "openrouter", model: "qwen/qwen3-coder-plus" }).valid, true);
  assert.equal(validateHarnessModelPair("pi", "openrouter/qwen/qwen3-coder-plus").valid, true);
  assert.equal(validateHarnessModelPair("pi", { provider: "nous-portal", model: "tencent/hy4-preview" }).valid, true);
  assert.equal(validateHarnessModelPair("pi", "nous-portal/tencent/hy4-preview").valid, true);
  assert.equal(validateHarnessModelPair("pi", { provider: "anthropic", model: "claude-sonnet-4-6" }).valid, false);
  assert.equal(validateHarnessModelPair("pi", { provider: "anthropic", model: "claude-sonnet-4-6" }).issue, "pi_native_impersonation_blocked");
  assert.equal(validateHarnessModelPair("pi", { provider: "xai", model: "grok-4.6" }).valid, false);
  assert.equal(validateHarnessModelPair("pi", { provider: "xai", model: "grok-4.6" }).issue, "pi_native_impersonation_blocked");
  assert.equal(validateHarnessModelPair("pi", "anthropic/claude-sonnet-4-6").valid, false);
});

test("Pi brake refuses a native vendor's model under any Pi provider id, not just the first segment", () => {
  for (const selector of [
    "openrouter/x-ai/grok-4.6",
    "openrouter/anthropic/claude-fable-5",
    "nous-portal/openai/gpt-5.6-sol",
    "openai-codex/gpt-5.6-sol",
    "kimi-coding/k3",
    "moonshotai/kimi-k3",
    "google-vertex/gemini-2.5-pro",
    "claude-bridge/claude-fable-5",
    "antigravity/claude-sonnet-4-6",
    "antigravity/google/gemini-3.8-flash",
  ]) {
    assert.equal(validateHarnessModelPair("pi", selector).issue, "pi_native_impersonation_blocked", selector);
  }
  assert.equal(validateHarnessModelPair("pi", { provider: "openrouter", model: "moonshotai/kimi-k3" }).valid, false);
  // The decided Google route and the admitted non-native routes stay open.
  for (const selector of ["antigravity/gemini-3.8-flash-high", "openrouter/qwen/qwen3-coder-plus", "openrouter/z-ai/glm-5.3-flash", "zai-coding-cn/glm-5.3"]) {
    assert.equal(validateHarnessModelPair("pi", selector).valid, true, selector);
  }
});

test("probeHarnessAssignment supplies exact provider/model context to Pi and validates hosting", () => {
  const runCommand = runner({
    "pi --version": { ok: true, code: 0, stdout: "0.85.1\n", stderr: "" },
    "pi auth check --provider openrouter --json": {
      ok: true,
      code: 0,
      stdout: JSON.stringify({ status: "ready", provider: "openrouter", authType: "api_key" }),
      stderr: "",
    },
    "pi auth check --provider unavailable --json": {
      ok: false,
      code: 1,
      stdout: JSON.stringify({ status: "not_ready", provider: "unavailable", reason: "provider_not_found" }),
      stderr: "",
    },
    "pi auth check --model qwen-token-plan/qwen3.8-flash --json": {
      ok: true,
      code: 0,
      stdout: JSON.stringify({ status: "ready", provider: "qwen-token-plan", authType: "api_key" }),
      stderr: "",
    },
    "pi auth check --model openrouter/qwen/qwen3-coder-plus --json": {
      ok: true,
      code: 0,
      stdout: JSON.stringify({ status: "ready", provider: "openrouter", authType: "api_key" }),
      stderr: "",
    },
    "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
    "claude auth status": {
      ok: true,
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      stderr: "",
    },
  });

  // Pi without context reports auth_context_required
  const piNoContext = probeHarnessAssignment({ harness: "pi", runCommand });
  assert.equal(piNoContext.detected, true);
  assert.equal(piNoContext.authenticated, null);
  assert.deepEqual([...piNoContext.issues], ["auth_context_required"]);

  // Pi with openrouter context reports authenticated: true
  const piOpenRouter = probeHarnessAssignment({ harness: "pi", provider: "openrouter", runCommand });
  assert.equal(piOpenRouter.detected, true);
  assert.equal(piOpenRouter.authenticated, true);
  assert.deepEqual([...piOpenRouter.issues], []);

  // Pi with unavailable provider reports authenticated: false
  const piUnavailable = probeHarnessAssignment({ harness: "pi", provider: "unavailable", runCommand });
  assert.equal(piUnavailable.detected, true);
  assert.equal(piUnavailable.authenticated, false);
  assert.deepEqual([...piUnavailable.issues], ["not_authenticated"]);

  // A bare model plus a separate provider is the engine's request shape; `pi auth check
  // --model` requires the provider-qualified id (a bare model answers "invalid", which
  // used to read as not_authenticated and hide the real auth state).
  const piBareModel = probeHarnessAssignment({ harness: "pi", provider: "qwen-token-plan", model: "qwen3.8-flash", runCommand });
  assert.equal(piBareModel.authenticated, true, "bare model + provider probes the qualified id");

  // An internal namespace gets its provider prefix (openrouter/qwen/... is the full id)
  const piNamespaced = probeHarnessAssignment({ harness: "pi", provider: "openrouter", model: "qwen/qwen3-coder-plus", runCommand });
  assert.equal(piNamespaced.authenticated, true, "an internal namespace is probed under its provider prefix");

  // An already-prefixed model goes through unchanged — always-prefixing would ask for
  // openrouter/openrouter/... and fail the same way as-is probing failed
  const piPrefixed = probeHarnessAssignment({ harness: "pi", provider: "openrouter", model: "openrouter/qwen/qwen3-coder-plus", runCommand });
  assert.equal(piPrefixed.authenticated, true, "an already-prefixed model probes as-is");

  // Pi with direct anthropic model triggers native brake and does not spawn
  const piAnthropic = probeHarnessAssignment({ harness: "pi", provider: "anthropic", model: "claude-sonnet-4-6", runCommand });
  assert.equal(piAnthropic.authenticated, false);
  assert.deepEqual([...piAnthropic.issues], ["pi_native_impersonation_blocked"]);

  // Claude with unhosted model fails closed without spawning auth
  const claudeUnhosted = probeHarnessAssignment({ harness: "claude", provider: "xai", model: "grok-4.6", runCommand });
  assert.equal(claudeUnhosted.authenticated, false);
  assert.deepEqual([...claudeUnhosted.issues], ["harness_unhosted_model"]);

  // Claude with hosted model probes auth normally
  const claudeHosted = probeHarnessAssignment({ harness: "claude", provider: "anthropic", model: "fable", runCommand });
  assert.equal(claudeHosted.detected, true);
  assert.equal(claudeHosted.authenticated, true);
  assert.deepEqual([...claudeHosted.issues], []);
});

test("probeHarnessesForModel supplies model context across inventory and satisfies eligibleHarnesses", () => {
  const inventory = probeHarnessesForModel(
    { provider: "openrouter", model: "qwen/qwen3-coder-plus" },
    {
      runCommand: runner({
        "pi --version": { ok: true, code: 0, stdout: "0.85.1\n", stderr: "" },
        "pi auth check --model openrouter/qwen/qwen3-coder-plus --json": {
          ok: true,
          code: 0,
          stdout: JSON.stringify({ status: "ready", provider: "openrouter", authType: "api_key" }),
          stderr: "",
        },
        "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
        "grok --version": { ok: true, code: 0, stdout: "grok 0.1\n", stderr: "" },
      }),
    },
  );

  const pi = inventory.harnesses.find((h) => h.id === "pi");
  assert.equal(pi?.detected, true);
  assert.equal(pi?.authenticated, true);

  const claude = inventory.harnesses.find((h) => h.id === "claude");
  assert.equal(claude?.authenticated, false);
  assert.deepEqual([...(claude?.issues ?? [])], ["harness_unhosted_model"]);

  const grok = inventory.harnesses.find((h) => h.id === "grok");
  assert.equal(grok?.authenticated, false);
  assert.deepEqual([...(grok?.issues ?? [])], ["harness_unhosted_model"]);

  const eligible = eligibleHarnesses(inventory);
  assert.deepEqual([...eligible], ["pi"]);
});

test("probeHarnesses reports dispatch status with reasons across inventory", () => {
  const inventory = probeHarnesses({
    runCommand: runner({
      "pi --version": { ok: true, code: 0, stdout: "0.85.1\n", stderr: "" },
      "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
      "claude auth status": { ok: true, code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" },
      "kimi --version": { ok: true, code: 0, stdout: "1.0.0\n", stderr: "" },
      "kimi provider list": { ok: true, code: 0, stdout: "managed:kimi-code type=kimi models=4 source=oauth\nDefault model: kimi-code/kimi-for-coding\n", stderr: "" },
      "codex --version": { ok: true, code: 0, stdout: "0.1.0\n", stderr: "" },
      "codex login status": { ok: true, code: 0, stdout: "", stderr: "Logged in using ChatGPT\n" },
      "grok --version": { ok: true, code: 0, stdout: "0.1.0\n", stderr: "" },
      "grok models": { ok: true, code: 0, stdout: "You are logged in with grok.com.\nAvailable models:\ngrok-4.6\n", stderr: "" },
      "agy --version": { ok: true, code: 0, stdout: "1.0.0\n", stderr: "" },
      "agy models": { ok: true, code: 0, stdout: "gemini-2.5-pro\tGemini 2.5 Pro\n", stderr: "" },
    }),
  });

  const pi = status(inventory, "pi");
  assert.equal(pi.dispatch?.status, "no");
  assert.equal(pi.dispatch?.reason, "auth_context_required");

  const claude = status(inventory, "claude");
  assert.equal(claude.dispatch?.status, "yes");
  assert.equal(claude.dispatch?.supported, true);

  const kimi = status(inventory, "kimi");
  assert.equal(kimi.dispatch?.status, "yes");
  assert.equal(kimi.dispatch?.supported, true);

  const codex = status(inventory, "codex");
  assert.equal(codex.dispatch?.status, "yes");
  assert.equal(codex.dispatch?.supported, true);

  const deepseek = status(inventory, "deepseek");
  assert.equal(deepseek.dispatch?.status, "no");
  assert.equal(deepseek.dispatch?.reason, "not_detected");

  const grok = status(inventory, "grok");
  assert.equal(grok.dispatch?.status, "yes");
  assert.equal(grok.dispatch?.supported, true);

  const agy = status(inventory, "agy");
  assert.equal(agy.dispatch?.status, "yes");
  assert.equal(agy.dispatch?.supported, true);

  const formatted = formatHarnessInventory(inventory);
  assert.match(formatted, /dispatch/);
  assert.match(formatted, /deepseek\s+no\s+no\s+no\s+no \(not_detected\)/);
  assert.match(formatted, /agy\s+no\s+yes\s+yes\s+yes/);
});

test("probeHarnessesAsync replays the same fail-closed policy without spawnSync", async () => {
  const handlers = {
    "pi --version": { ok: true, code: 0, stdout: "0.85.1\n", stderr: "" },
    "claude --version": { ok: true, code: 0, stdout: "2.1.260\n", stderr: "" },
    "claude auth status": { ok: false, code: 1, stdout: "", stderr: "error" },
  };
  const runCommand = runner(handlers);
  const sync = probeHarnesses({ runCommand });
  const asyncInventory = await probeHarnessesAsync({
    runCommand: async (command, args, timeoutMs) => {
      await new Promise((resolve) => setImmediate(resolve));
      return runCommand(command, args, timeoutMs);
    },
  });
  assert.deepEqual(asyncInventory, sync);
  assert.notEqual(status(asyncInventory, "claude").authenticated, true);
  assert.notEqual(status(asyncInventory, "pi").authenticated, true);
  const assignment = await probeHarnessAssignmentAsync({
    harness: "claude",
    runCommand: async (command, args, timeoutMs) => runCommand(command, args, timeoutMs),
  });
  assert.notEqual(assignment.authenticated, true);
  const forModel = await probeHarnessesForModelAsync({ provider: "anthropic", model: "fable" }, {
    runCommand: async (command, args, timeoutMs) => runCommand(command, args, timeoutMs),
  });
  assert.equal(status(forModel, "claude").detected, true);
});


test("async inventory probes yield to sibling timers instead of blocking spawnSync", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-async-probe-"));
  // A /bin/sh fixture answers immediately: no node cold start and no artificial delay
  // racing the probe timeout. Only builtins run, so the isolated PATH needs nothing else.
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'fixture-cli\\n'; else printf '{"loggedIn":false}\\n'; fi\n`,
    { mode: 0o700 },
  );
  // Barrier, not a timer guess: count event-loop turns while the probe is pending. A
  // spawnSync regression settles the probe through microtasks alone, so zero turns pass.
  let settled = false;
  let turns = 0;
  const turn = () => {
    if (settled) return;
    turns += 1;
    setImmediate(turn);
  };
  setImmediate(turn);
  try {
    const inventory = await probeHarnessesAsync({ env: { PATH: dir }, timeoutMs: 3000 }).finally(() => { settled = true; });
    assert.ok(turns > 0, "auth/capability probes must not block the event loop");
    assert.equal(status(inventory, "claude").detected, true);
    assert.equal(status(inventory, "claude").authenticated, false);
    for (const id of BUILTIN_HARNESS_IDS) {
      if (id === "claude") continue;
      assert.equal(status(inventory, id).detected, false, `${id} must not be reachable from the isolated PATH`);
    }
  } finally {
    settled = true;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async inventory probe test does not inherit ambient PATH", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const marker = "async inventory probes yield to sibling timers instead of blocking spawnSync";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const next = source.indexOf("\ntest(", start + marker.length);
  const body = source.slice(start, next === -1 ? source.length : next);
  assert.match(body, /env:\s*\{\s*PATH:\s*dir\s*[,}]/);
  assert.doesNotMatch(body, /\.\.\.process\.env/);
  assert.doesNotMatch(body, /process\.env\.PATH/);
  assert.doesNotMatch(body, /process\.env\["PATH"\]/);
});



test("parsePiOneShotUsage reads the final assistant message from the NDJSON stream", () => {
  const assistant = (text: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], ...over } });
  const stream = [
    JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "prompt" }] } }),
    JSON.stringify({ type: "message_update", usage: { input: 0 }, assistantMessageEvent: { type: "text_delta", delta: "ignored" } }),
    // an EARLIER assistant turn with different values — the final one must win wholesale
    assistant('{"outcome":"stale"}', { model: "old-model", usage: { input: 1, output: 1 } }),
    // an interleaved user event must not reset or confuse the selection
    JSON.stringify({ type: "turn_end", message: { role: "user", content: [{ type: "text", text: "again" }] } }),
    assistant('{"outcome":"passed","summary":"witness"}', { model: "qwen3.8-flash", usage: { input: 456, output: 28, cacheRead: 0, cacheWrite: 0 } }),
    "not json at all",
  ].join("\n");
  const parsed = kxmHarness.parsePiOneShotUsage(stream, "");
  assert.equal(parsed.text, '{"outcome":"passed","summary":"witness"}', "the final assistant message wins");
  assert.equal(parsed.effectiveModel, "qwen3.8-flash", "model comes from the same final message");
  assert.equal(parsed.usage?.tokensIn, 456);
  assert.equal(parsed.usage?.tokensOut, 28);
  assert.ok(!parsed.text.includes("stale"));

  // No assistant message at all: fail closed with empty text — never the raw stream,
  // which would hand back thinking deltas or diagnostics as if they were the answer.
  const fallback = kxmHarness.parsePiOneShotUsage("a shape we do not know yet", "");
  assert.equal(fallback.text, "");
  assert.equal(fallback.isError, true);

  // A final assistant message with an error/aborted stop reason is a failed turn even
  // with exit code zero and PASS text riding along.
  for (const stopReason of ["error", "aborted"]) {
    const errored = kxmHarness.parsePiOneShotUsage([
      assistant('{"outcome":"passed"}', { stopReason, model: "qwen3.8-flash", usage: { input: 9, output: 9 } }),
    ].join("\n"), "");
    assert.equal(errored.isError, true, `stopReason ${stopReason} fails the turn`);
    assert.equal(errored.usage?.tokensIn, 9, "the failed turn's usage is still reported");
    assert.equal(errored.effectiveModel, "qwen3.8-flash", "the failed turn's model is still reported");
  }

  // An EMPTY final assistant message inherits nothing from the earlier turn
  const emptyFinal = kxmHarness.parsePiOneShotUsage([
    assistant('{"outcome":"stale"}', { model: "old-model", usage: { input: 5, output: 5 } }),
    JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 7, output: 3 } } }),
  ].join("\n"), "");
  assert.equal(emptyFinal.text, "");
  assert.equal(emptyFinal.isError, true, "an empty final turn fails closed");
  assert.equal(emptyFinal.usage?.tokensIn, 7, "usage from the failed final is still reported");
  assert.equal(emptyFinal.usage?.tokensOut, 3);

  // Multi-part replies join with newlines; thinking parts never leak into the text
  const multi = kxmHarness.parsePiOneShotUsage([
    JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ], model: "m", usage: { input: 1, output: 2 } } }),
  ].join("\n"), "");
  assert.equal(multi.text, "line one\nline two");
  assert.ok(!multi.text.includes("secret reasoning"));

  // A thinking-only stream never surfaces the reasoning as the answer
  const thinkingOnly = kxmHarness.parsePiOneShotUsage([
    JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private chain of thought" },
    ], model: "m", usage: { input: 1, output: 2 } } }),
  ].join("\n"), "");
  assert.equal(thinkingOnly.text, "");
  assert.equal(thinkingOnly.isError, true);
  assert.ok(!JSON.stringify(thinkingOnly).includes("private chain of thought"));
});

test("pi one-shot profile is total containment: no tools, no ambient code, ephemeral", () => {
  assert.deepEqual([...kxmHarness.oneShotReadOnlyArgs("pi")!], [
    "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session",
  ], "no tools at all, no extension/hook/skill/template/context discovery, nothing persists");
});
