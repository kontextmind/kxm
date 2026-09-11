import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginOneShotEvidence } from "../../plugins/kxm/src/vnext-oneshot-evidence.ts";
import { createVnextOneShotProducer } from "../../plugins/kxm/src/vnext-oneshot-producer.ts";

const intent = { runId: "run_fixture", stepId: "review", attemptId: "att_fixture", assignmentId: "asg_fixture", harness: "claude", provider: "anthropic", model: "fable", cwd: "/fixture", command: "claude", args: ["-p"] };
const request = { ...intent, stepAttempt: 1, agentId: "critic", capability: "fixture-only", allowedOutcomes: ["passed", "failed"], signal: new AbortController().signal };
const authenticated = () => ({ id: "claude", label: "Claude", default: false, mode: "either" as const, detected: true, authenticated: true, canUpdate: { self: false, extensions: false, models: false }, issues: [] });

test("private process evidence is redacted, identity-bound, digest-referenced, and retained", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-evidence-"));
  try {
    const secret = "fixture-private-token-123456";
    const evidence = await beginOneShotEvidence(root, { ...intent, input: `api_key=${secret}` }, [secret]);
    const sha = await evidence.finish({ stdout: secret, stderr: "", code: 1, started: true, observedChildExit: true }, { tokensIn: 32 });
    const dir = join(root, evidence.id);
    const raw = readFileSync(join(dir, "result.json"), "utf8");
    assert.equal(sha, `sha256:${createHash("sha256").update(raw).digest("hex")}`);
    assert.equal(raw.includes(secret), false);
    assert.match(raw, /REDACTED/);
    assert.equal(JSON.parse(readFileSync(join(dir, "intent.json"), "utf8")).attemptId, intent.attemptId);
    assert.deepEqual(readdirSync(dir).sort(), ["intent.json", "result.json"]);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "result.json")).mode & 0o777, 0o600);
    await assert.rejects(evidence.finish({ stdout: "", stderr: "", code: 0 }, {}), /already_finished/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unsafe evidence root refuses before provider spawn", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-evidence-deny-"));
  let spawns = 0;
  const producer = createVnextOneShotProducer({ evidenceRoot: root, probeHarness: authenticated, spawnProcess: async () => { spawns++; return { stdout: "", stderr: "", code: 0 }; } });
  try {
    chmodSync(root, 0o755);
    await assert.rejects(producer.produce(request), /evidence_root_not_private/);
    assert.equal(spawns, 0);
  } finally { await producer.close(); rmSync(root, { recursive: true, force: true }); }
});

test("evidence symlinks and post-execution persistence failures do not become successful settlement", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-evidence-failure-"));
  try {
    symlinkSync(root, join(root, "link"));
    await assert.rejects(beginOneShotEvidence(join(root, "link"), intent, []), /evidence_root_not_private/);
    const producer = createVnextOneShotProducer({ evidenceRoot: root, probeHarness: authenticated, spawnProcess: async () => {
      const dir = readdirSync(root).find((name) => name.startsWith("evd_"))!;
      chmodSync(join(root, dir), 0o755);
      return { stdout: JSON.stringify({ result: '{"outcome":"passed"}', usage: { input_tokens: 5 } }), stderr: "", code: 0, started: true, observedChildExit: true };
    } });
    try {
      const result = await producer.produce(request);
      assert.equal(result.effectUncertain, true);
      assert.equal(result.outcome, "failed");
      assert.equal(result.tokensIn, 5);
      assert.equal(result.providerMetadata?.evidenceWriteFailed, true);
    } finally { await producer.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
