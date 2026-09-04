import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  SessionConfigError,
  loadNamedWorkers,
  rosterNames,
} from "../plugins/kxm/src/session.ts";

function withConfig(context: TestContext, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kxm-session-test-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

const AGENTS = JSON.stringify({
  schema: "kxm.agents.v1",
  agents: [
    { name: "grok", kind: "agent", driver: "ai", model: "xai/grok-4.6", thinking: "xhigh", purpose: "writer" },
    { name: "kimi", kind: "agent", driver: "ai", purpose: "scout" },
  ],
});

const GATES = JSON.stringify({
  schema: "kxm.gates.v1",
  gates: [
    { name: "validate", kind: "gate", driver: "code", purpose: "parse definitions" },
    { name: "artifacts-exist", kind: "gate", driver: "code" },
  ],
});

test("roster loads agents and gates with their declared roles", (context) => {
  const config = withConfig(context, { "agents.json": AGENTS, "gates.json": GATES });
  const workers = loadNamedWorkers(config, ["grok", "validate"], "payk12");
  assert.equal(workers[0]!.kind, "agent");
  assert.equal(workers[0]!.driver, "ai");
  assert.equal(workers[0]!.project, "payk12");
  assert.equal((workers[0] as { model?: string }).model, "xai/grok-4.6");
  assert.equal(workers[1]!.kind, "gate");
  assert.equal(workers[1]!.driver, "code");
  assert.deepEqual(rosterNames(config).sort(), ["artifacts-exist", "grok", "kimi", "validate"]);
});

test("unknown mix names fail closed instead of minting a gate", (context) => {
  const config = withConfig(context, { "agents.json": AGENTS, "gates.json": GATES });
  assert.throws(
    () => loadNamedWorkers(config, ["grok", "qulity"]),
    (error: unknown) => error instanceof SessionConfigError && /unknown worker name/.test((error as Error).message),
  );
});

test("kind/driver mismatches and invalid discriminator values fail closed", (context) => {
  const mismatch = withConfig(context, {
    "agents.json": JSON.stringify({ agents: [{ name: "weird", kind: "agent", driver: "code" }] }),
  });
  assert.throws(() => loadNamedWorkers(mismatch, ["weird"]), /kind\/driver mismatch/);

  const badKind = withConfig(context, {
    "agents.json": JSON.stringify({ agents: [{ name: "weird", kind: "robot" }] }),
  });
  assert.throws(() => loadNamedWorkers(badKind, ["weird"]), /invalid kind/);

  const badDriver = withConfig(context, {
    "gates.json": JSON.stringify({ gates: [{ name: "weird", driver: "magic" }] }),
  });
  assert.throws(() => loadNamedWorkers(badDriver, ["weird"]), /invalid driver/);

  const unselectedMismatch = withConfig(context, {
    "agents.json": JSON.stringify({ agents: [
      { name: "valid", kind: "agent", driver: "ai" },
      { name: "unselected-bad", kind: "agent", driver: "code" },
    ] }),
  });
  assert.throws(() => loadNamedWorkers(unselectedMismatch, ["valid"]), /unselected-bad.*kind\/driver mismatch/);
  assert.throws(() => rosterNames(unselectedMismatch), /unselected-bad.*kind\/driver mismatch/);
});

test("duplicate worker names across roster files fail closed", (context) => {
  const config = withConfig(context, {
    "agents.json": JSON.stringify({ agents: [{ name: "grok", kind: "agent", driver: "ai" }] }),
    "gates.json": JSON.stringify({ gates: [{ name: "Grok", kind: "gate", driver: "code" }] }),
  });
  assert.throws(() => rosterNames(config), /duplicate worker name/i);
  assert.throws(() => loadNamedWorkers(config, ["grok"]), /duplicate worker name/i);
});

test("malformed roster files fail closed; missing files stay empty", (context) => {
  const malformed = withConfig(context, { "agents.json": "{not json" });
  assert.throws(() => rosterNames(malformed), /not valid JSON/);

  const wrongShape = withConfig(context, { "agents.json": JSON.stringify({ workers: [] }) });
  assert.throws(() => rosterNames(wrongShape), /must contain a "agents" array/);

  const nameless = withConfig(context, { "gates.json": JSON.stringify({ gates: [{ kind: "gate" }] }) });
  assert.throws(() => rosterNames(nameless), /non-empty name/);

  const empty = withConfig(context, {});
  assert.deepEqual(rosterNames(empty), []);
  assert.throws(() => loadNamedWorkers(empty, ["grok"]), SessionConfigError);
});
