import assert from "node:assert/strict";
import test from "node:test";
import { oneShotReadOnlyArgs } from "../../plugins/kxm/src/harness.ts";
import {
  assertCommandSeatbelt,
  DESTRUCTIVE_COMMAND_PATTERNS,
  isRtkBypassRequired,
  assertPinnedSshHostKeyPolicy,
} from "../../plugins/kxm/src/safety-integrity.ts";
import { killProcessTree } from "../../plugins/kxm/src/oneshot-process.ts";

test("Stage 1: oneShotReadOnlyArgs exposes pinned sandboxed flags for agy and kimi", () => {
  const agyArgs = oneShotReadOnlyArgs("agy");
  assert.deepEqual(agyArgs, ["--mode", "plan", "--sandbox", "--disable-slash-commands"]);

  const kimiArgs = oneShotReadOnlyArgs("kimi");
  assert.deepEqual(kimiArgs, ["--plan"]);

  assert.deepEqual(oneShotReadOnlyArgs("claude"), [
    "--tools", "Read,Glob,Grep",
    "--restricted",
    "--safe-mode",
    "--permission-mode", "plan",
    "--permission-prompts", "none",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
  ]);
  assert.ok(oneShotReadOnlyArgs("claude")?.includes("--restricted"));
  assert.ok(oneShotReadOnlyArgs("codex")?.includes("read-only"));
  assert.ok(oneShotReadOnlyArgs("grok")?.includes("read-only"));

  // Pi is audited for one-shot since S5: total containment — no tools, no ambient
  // extension/hook/skill/template/context discovery, ephemeral session. It remains the
  // long-lived RPC worker too; both shapes exist, and this profile is what a live drive
  // uses on a tenant box.
  assert.deepEqual(oneShotReadOnlyArgs("pi"), [
    "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session",
  ]);
  assert.equal(oneShotReadOnlyArgs("unknown_harness"), undefined);
});

test("Stage 2: assertCommandSeatbelt blocks destructive shell mutations and allows safe commands", () => {
  const destructiveCommands = [
    "rm -rf ./build",
    "rm -fr /var/log",
    "rm -r -f node_modules",
    "git reset --hard HEAD~1",
    "git reset --hard",
    "git clean -f",
    "git clean -fd",
    "git checkout -- .",
    "git checkout -- src/file.ts",
    "git restore .",
    "git restore *",
    "git restore --staged .",
  ];

  for (const cmd of destructiveCommands) {
    assert.throws(
      () => assertCommandSeatbelt(cmd),
      (err: Error) => {
        assert.match(err.message, /Command blocked by KXM safety seatbelt/);
        return true;
      },
      `Expected seatbelt to block: ${cmd}`,
    );
  }

  const safeCommands = [
    "git status",
    "git diff HEAD~1",
    "npm test",
    "npm run verify",
    "git checkout -b new-branch",
    "rm single-file.txt",
    "git add -A",
    "git commit -m 'feat: test'",
  ];

  for (const cmd of safeCommands) {
    assert.doesNotThrow(() => assertCommandSeatbelt(cmd), `Safe command threw unexpectedly: ${cmd}`);
  }
});

test("Stage 3: killProcessTree invokes negative PGID termination on POSIX", () => {
  let killedSignal: NodeJS.Signals | null = null;
  let killedTarget: number | null = null;

  const originalKill = process.kill;
  try {
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      killedTarget = pid;
      killedSignal = (typeof signal === "string" ? signal : "SIGKILL") as NodeJS.Signals;
      return true;
    }) as typeof process.kill;

    const mockChild = {
      pid: 12345,
      kill(signal?: NodeJS.Signals) {
        killedSignal = signal ?? "SIGKILL";
        return true;
      },
    } as any;

    killProcessTree(mockChild, "SIGTERM");

    if (process.platform !== "win32") {
      assert.equal(killedTarget, -12345, "Should target process group with -pid on POSIX");
      assert.equal(killedSignal, "SIGTERM");
    } else {
      assert.equal(killedSignal, "SIGTERM");
    }
  } finally {
    process.kill = originalKill;
  }
});

test("Stage 5: isRtkBypassRequired mandates unbypassable raw byte fidelity for gates and critics", () => {
  // Gates must never be lossy compressed
  assert.equal(isRtkBypassRequired({ stepKind: "gate" }), true);

  // Critic roles and presets must never be lossy compressed
  assert.equal(isRtkBypassRequired({ agentRole: "critic-arch" }), true);
  assert.equal(isRtkBypassRequired({ agentRole: "critic-cli" }), true);
  assert.equal(isRtkBypassRequired({ agentRole: "auditor" }), true);
  assert.equal(isRtkBypassRequired({ preset: "critic-arch" }), true);
  assert.equal(isRtkBypassRequired({ preset: "auditor" }), true);

  // Standard non-critic steps may use token reduction
  assert.equal(isRtkBypassRequired({ stepKind: "task", agentRole: "writer" }), false);
  assert.equal(isRtkBypassRequired({ stepKind: "task", agentRole: "implementer" }), false);
  assert.equal(isRtkBypassRequired({ stepKind: "plan", agentRole: "planner" }), false);
});

test("Stage 6: assertPinnedSshHostKeyPolicy rejects TOFU and disabled verification in headless SSH", () => {
  const insecureArgSets = [
    ["-o", "StrictHostKeyChecking=accept-new"],
    ["-o", "StrictHostKeyChecking=no"],
    ["-o", "StrictHostKeyChecking=off"],
    ["-o", "UserKnownHostsFile=/dev/null"],
  ];

  for (const args of insecureArgSets) {
    assert.throws(
      () => assertPinnedSshHostKeyPolicy(args),
      /Insecure SSH host key policy rejected/,
      `Expected failure for: ${args.join(" ")}`,
    );
  }

  const secureArgs = [
    "-o", "StrictHostKeyChecking=yes",
    "-o", "BatchMode=yes",
    "-o", "UserKnownHostsFile=.kxm/known_hosts",
  ];

  assert.doesNotThrow(() => assertPinnedSshHostKeyPolicy(secureArgs));
});
