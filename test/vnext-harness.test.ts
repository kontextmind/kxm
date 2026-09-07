import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadVnextProject, VnextConfigError } from "../plugins/kxm/src/vnext-config.ts";
import { initializeVnextProject } from "../plugins/kxm/src/vnext-init.ts";
import * as vnextHarness from "../plugins/kxm/src/vnext-harness.ts";
import {
  BUILTIN_HARNESS_IDS,
  BUILTIN_HARNESSES,
  DEFAULT_HARNESS,
  formatHarnessInventory,
  planHarnessUpdate,
  probeHarnesses,
  runHarnessUpdate,
  type HarnessCommandResult,
  type HarnessInventory,
  type HarnessStatus,
} from "../plugins/kxm/src/vnext-harness.ts";
import { computeVnextResourcePermissionDiff } from "../plugins/kxm/src/vnext-permission.ts";
import { makeGitRoot } from "./helpers/git-root.ts";

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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const grokLoginFixture = JSON.parse(readFileSync(join(repoRoot, "test/fixtures/harness/auth-fixtures.json"), "utf8")) as {
  grok: { stdout: string; stderr: string; exitCode: number };
};

function issueCodes(error: unknown): string[] {
  assert(error instanceof VnextConfigError, `expected VnextConfigError, received ${String(error)}`);
  return error.issues.map((candidate) => candidate.code);
}

test("builtin catalog defaults to headless Pi and lists known harnesses", () => {
  assert.equal(DEFAULT_HARNESS, "pi");
  assert.deepEqual([...BUILTIN_HARNESS_IDS], ["pi", "claude", "kimi", "codex", "gemini", "deepseek", "grok", "agy"]);
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

test("omitted agent harness equals pi; unknown ids fail closed; claude is a customization", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-harness-config-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-harness-state-"));
  try {
    makeGitRoot(root);
    initializeVnextProject(root, { projectId: "prj_01JHARNESSTEST00000000000", projectName: "Harness", localStateRoot: stateRoot });
    const bundle = loadVnextProject(root);
    assert.equal(bundle.project.value.defaultHarness, "pi");
    const implementer = bundle.agents.get("implementer");
    assert.equal(implementer?.value.harness, undefined);

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
    assert.throws(() => loadVnextProject(root), (error: unknown) => error instanceof VnextConfigError && error.issues.some((issue) => issue.code === "harness_unknown"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("changing harness away from pi is a permission expansion; explicit pi matches omit", () => {
  const base = { schema: "kxm.agent.v1", purpose: "x" };
  const same = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, harness: "pi" });
  assert.equal(same.filter((change) => change.field === "harness").length, 0);
  const expanded = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, harness: "claude" });
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

  const eligible = vnextHarness.eligibleHarnesses({
    defaultHarness: "pi",
    harnesses: [
      { id: "pi", label: "Pi", default: true, mode: "headless", detected: true, authenticated: null, canUpdate: { self: true, extensions: true, models: true }, issues: ["auth_context_required"] },
      { id: "agy", label: "Antigravity CLI", default: false, mode: "either", detected: true, authenticated: true, canUpdate: { self: true, extensions: false, models: false }, issues: [] },
      { id: "gemini", label: "Gemini CLI", default: false, mode: "either", detected: true, authenticated: null, canUpdate: { self: true, extensions: false, models: false }, issues: ["auth_unknown"] },
    ],
  });
  assert.deepEqual([...eligible], ["agy"]);
});

test("kimi gemini and deepseek stay unknown without secret-bearing config-list commands", () => {
  const recorded = recordingRunner({
    "kimi --version": { ok: true, code: 0, stdout: "kimi 0.1\n", stderr: "" },
    "gemini --version": { ok: true, code: 0, stdout: "gemini 0.1\n", stderr: "" },
    "deepseek --version": { ok: true, code: 0, stdout: "deepseek 0.1\n", stderr: "" },
    "kimi provider list": { ok: true, code: 0, stdout: "managed:kimi-code type=kimi models=4 source=oauth\n", stderr: "" },
    "kimi provider list --json": { ok: true, code: 0, stdout: "{\"apiKey\":\"sk-secret\"}\n", stderr: "" },
    "gemini": { ok: true, code: 0, stdout: "interactive\n", stderr: "" },
  });
  const inventory = probeHarnesses({ runCommand: recorded.runCommand });
  for (const id of ["kimi", "gemini", "deepseek"] as const) {
    const entry = status(inventory, id);
    assert.equal(entry.detected, true);
    assert.equal(entry.authenticated, null);
    assert(entry.issues.includes("auth_unknown"));
    assert.match(formatHarnessInventory(inventory), new RegExp(`^${id}\\s+no\\s+yes\\s+unknown\\b`, "m"));
  }
  assert(!recorded.calls.some((call) => call.includes("provider list") || call.includes("doctor") || call === "gemini"));
  assert.doesNotMatch(JSON.stringify(inventory), /sk-secret|apiKey|oauth/);
});

test("eligibleHarnesses is pure inventory filtering and fail-closes when empty", () => {
  assert.equal(typeof vnextHarness.eligibleHarnesses, "function");
  const eligible = vnextHarness.eligibleHarnesses({
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
    () => vnextHarness.eligibleHarnesses({
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

test("config with a Grok model under harness claude loads without a static matrix code", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-harness-matrix-"));
  try {
    cpSync(join(repoRoot, "examples/vnext"), root, { recursive: true });
    makeGitRoot(root);
    makeGitRoot(join(root, "repositories", "api"));
    makeGitRoot(join(root, "repositories", "web"));
    const agentFile = join(root, ".kxm", "agents", "critic-2.yaml");
    writeFileSync(agentFile, `${readFileSync(agentFile, "utf8").trimEnd()}\nharness: claude\n`);
    const bundle = loadVnextProject(root);
    assert.equal(bundle.agents.get("critic-2")?.value.harness, "claude");
    assert.equal((bundle.agents.get("critic-2")?.value.model as { profile?: string }).profile, "critic-grok");
  } catch (error) {
    assert(!issueCodes(error).includes("harness_model_incompatible"));
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
