import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  beginOneShotEvidence,
  ONESHOT_EVIDENCE_SCHEMA,
  parseOneShotEvidenceRecord,
} from "../../plugins/kxm/src/oneshot-evidence.ts";
import { createKxmOneShotProducer } from "../../plugins/kxm/src/oneshot-producer.ts";

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
    const intentRecord = parseOneShotEvidenceRecord(readFileSync(join(dir, "intent.json"), "utf8"));
    const resultRecord = parseOneShotEvidenceRecord(raw);
    assert.equal(intentRecord.schema, ONESHOT_EVIDENCE_SCHEMA);
    assert.equal(resultRecord.schema, ONESHOT_EVIDENCE_SCHEMA);
    assert.equal(intentRecord.attemptId, intent.attemptId);
    assert.deepEqual(readdirSync(dir).sort(), ["intent.json", "result.json"]);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "result.json")).mode & 0o777, 0o600);
    await assert.rejects(evidence.finish({ stdout: "", stderr: "", code: 0 }, {}), /already_finished/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private evidence bounds command lines, redacts argv secrets, and never stores env", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-evidence-bound-"));
  try {
    const secret = "sk-live-fixture-secret-987654";
    const hugeArgv = "x".repeat(70 * 1024);
    const hugeOut = "y".repeat(5 * 1024 * 1024);
    const args = ["-p", `--token=${secret}`, hugeArgv];
    const evidence = await beginOneShotEvidence(root, {
      ...intent,
      command: `claude --token=${secret}`,
      args,
      input: `Bearer ${secret} ${hugeArgv}`,
    }, [secret]);
    const sha = await evidence.finish({
      stdout: hugeOut,
      stderr: `authorization: ${secret}`,
      code: 0,
      started: true,
      observedChildExit: true,
      unverifiedDescendants: true,
    }, { env: { TOKEN: secret } });
    const dir = join(root, evidence.id);
    const intentRaw = readFileSync(join(dir, "intent.json"), "utf8");
    const resultRaw = readFileSync(join(dir, "result.json"), "utf8");
    const intentJson = parseOneShotEvidenceRecord(intentRaw);
    const resultJson = parseOneShotEvidenceRecord(resultRaw);
    const argv = intentJson.argv as { text: string; truncated: boolean; sha256: string };
    const stdin = intentJson.stdin as { text: string; truncated: boolean };
    const stdout = resultJson.stdout as { truncated: boolean };
    const redactedArgv = JSON.stringify(args).replaceAll(secret, "[REDACTED]");
    const rawArgvDigest = `sha256:${createHash("sha256").update(JSON.stringify(args)).digest("hex")}`;
    const redactedArgvDigest = `sha256:${createHash("sha256").update(redactedArgv).digest("hex")}`;
    assert.equal(intentJson.schema, ONESHOT_EVIDENCE_SCHEMA);
    assert.equal(resultJson.schema, ONESHOT_EVIDENCE_SCHEMA);
    assert.equal(intentRaw.includes(secret), false);
    assert.equal(resultRaw.includes(secret), false);
    assert.equal(intentJson.env, null);
    assert.equal(intentJson.command, "claude --token=[REDACTED]");
    assert.match(argv.text, /REDACTED/);
    assert.equal(argv.truncated, true);
    assert.equal(argv.sha256, redactedArgvDigest);
    assert.notEqual(argv.sha256, rawArgvDigest);
    assert.match(stdin.text, /REDACTED/);
    assert.equal(stdout.truncated, true);
    assert.equal(resultJson.unverifiedDescendants, true);
    assert.equal(sha.startsWith("sha256:"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("oneshot evidence readers fail closed on retired v1 and unknown schema ids", () => {
  assert.equal(ONESHOT_EVIDENCE_SCHEMA, "kxm.oneshot-evidence.v2");
  assert.throws(
    () => parseOneShotEvidenceRecord(JSON.stringify({ schema: "kxm.oneshot-evidence.v1", id: "evd_retired" })),
    /oneshot_evidence_schema_retired/,
  );
  assert.throws(
    () => parseOneShotEvidenceRecord(JSON.stringify({ schema: "kxm.oneshot-evidence.v3", id: "evd_future" })),
    /oneshot_evidence_schema_unknown/,
  );
  assert.throws(
    () => parseOneShotEvidenceRecord(JSON.stringify({ schema: "not-a-kxm-schema", id: "evd_unknown" })),
    /oneshot_evidence_schema_unknown/,
  );
  assert.throws(() => parseOneShotEvidenceRecord("{"), /oneshot_evidence_record_invalid/);
  assert.throws(() => parseOneShotEvidenceRecord("[]"), /oneshot_evidence_record_invalid/);
  assert.throws(() => parseOneShotEvidenceRecord(JSON.stringify({ id: "evd_missing" })), /oneshot_evidence_record_invalid/);
  const accepted = parseOneShotEvidenceRecord(JSON.stringify({ schema: ONESHOT_EVIDENCE_SCHEMA, id: "evd_ok" }));
  assert.equal(accepted.schema, "kxm.oneshot-evidence.v2");
});

test("an unsafe evidence root refuses before provider spawn", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-evidence-deny-"));
  let spawns = 0;
  const producer = createKxmOneShotProducer({ evidenceRoot: root, probeHarness: authenticated, spawnProcess: async () => { spawns++; return { stdout: "", stderr: "", code: 0 }; } });
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
    const producer = createKxmOneShotProducer({ evidenceRoot: root, probeHarness: authenticated, spawnProcess: async () => {
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
