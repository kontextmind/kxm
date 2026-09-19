import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadKxmProject, kxmCanonicalJson, type JsonValue } from "../../plugins/kxm/src/project-config.ts";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/project.ts";
import { closeKxmRuntimeContext, openKxmRuntimeContext } from "../../plugins/kxm/src/runtime-service.ts";
import { TRANSACTION_BUSY_BACKOFF_MS } from "../../plugins/kxm/src/database.ts";
import type { KxmRuntimeContext } from "../../plugins/kxm/src/runtime-service.ts";
import {
  MAX_INTAKE_CONTENT_BYTES,
  acceptKxmIntakeMessage,
  admitKxmIntakeRun,
  bindKxmCoordinator,
  isKxmProjectPaused,
  kxmCeilingHash,
  listKxmDispatchableIntake,
  resolveKxmCoordinator,
  setKxmProjectPause,
  type KxmCoordinatorAuthority,
  type KxmIntakeMessage,
} from "../../plugins/kxm/src/intake.ts";

const HOME = "rtm_01JINTAKE000000000000000";
const OPERATOR = { kind: "human" as const, id: "root" };
const READ_ONLY = { repositoryAccess: "none" as const, effects: ["message-read"] };

function intakeContext(prefix: string): { root: string; stateRoot: string; context: KxmRuntimeContext } {
  const { root, stateRoot } = engineProject(prefix);
  return { root, stateRoot, context: openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: HOME }) };
}

function closeIntakeContext(...contexts: KxmRuntimeContext[]): void {
  for (const context of contexts) closeKxmRuntimeContext(context);
}

function bound(context: KxmRuntimeContext) {
  return bindKxmCoordinator(context, { role: "coordinator", authority: READ_ONLY, actor: OPERATOR });
}

test("coordinator binding is create-once and idempotent for the same ceiling", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-coordinator-");
  try {
    const first = bound(context);
    assert.equal(first.created, true);
    assert.match(first.coordinator.coordinatorId, /^crd_[A-Za-z0-9]{6,}$/);
    assert.equal(first.coordinator.projectId, context.projectId);
    assert.equal(first.coordinator.channel, "primary");

    const again = bound(context);
    assert.equal(again.created, false, "the same ceiling must not mint a second identity");
    assert.deepEqual(again.coordinator, first.coordinator);
    assert.equal(resolveKxmCoordinator(context, first.coordinator.coordinatorId).coordinatorId, first.coordinator.coordinatorId);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("a different ceiling is a rebind: refused without policy, never allowed to widen", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-rebind-");
  try {
    const first = bound(context);
    assert.throws(
      () => bindKxmCoordinator(context, { role: "coordinator", authority: { repositoryAccess: "read", effects: [] }, actor: OPERATOR }),
      /coordinator_rebind_requires_policy/,
    );

    // Wider repository access is refused even with an explicit approval.
    assert.throws(
      () => bindKxmCoordinator(context, {
        role: "coordinator",
        authority: { repositoryAccess: "write", effects: ["message-read"] },
        actor: OPERATOR,
        rebind: { approvedBy: OPERATOR, reason: "incident" },
      }),
      /coordinator_rebind_widens_access/,
    );

    // Extra effects are refused even when access stays the same.
    assert.throws(
      () => bindKxmCoordinator(context, {
        role: "coordinator",
        authority: { repositoryAccess: "none", effects: ["message-read", "dispatch"] },
        actor: OPERATOR,
        rebind: { approvedBy: OPERATOR, reason: "incident" },
      }),
      /coordinator_rebind_widens_effects/,
    );

    // Narrowing with policy succeeds and records its subject.
    const narrowed = bindKxmCoordinator(context, {
      role: "coordinator",
      authority: { repositoryAccess: "none", effects: [] },
      actor: OPERATOR,
      rebind: { approvedBy: OPERATOR, reason: "least privilege after review" },
    });
    assert.equal(narrowed.created, true);
    assert.equal(narrowed.coordinator.rebindOf, first.coordinator.coordinatorId);
    assert.equal(narrowed.coordinator.rebindReason, "least privilege after review");
    assert.notEqual(narrowed.coordinator.ceilingHash, first.coordinator.ceilingHash);
    assert.equal(narrowed.coordinator.ceilingHash, kxmCeilingHash({ repositoryAccess: "none", effects: [] }));

    // Rebinding with no prior identity fails closed rather than inventing history.
    assert.throws(
      () => bindKxmCoordinator(context, {
        role: "fresh",
        authority: READ_ONLY,
        actor: OPERATOR,
        rebind: { approvedBy: OPERATOR, reason: "no subject" },
      }),
      /coordinator_rebind_without_subject/,
    );
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("duplicate ingress yields one message and one admitted task; altered payloads are refused", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-dedupe-");
  try {
    const { coordinator } = bound(context);
    const base = { coordinatorId: coordinator.coordinatorId, idempotencyKey: "task-42", content: "ship it", source: { kind: "hub" as const, id: "hub-1" } };

    const first = acceptKxmIntakeMessage(context, base);
    assert.equal(first.duplicate, false);
    assert.equal(first.message.dispatch.state, "ready");
    assert.match(first.message.contentHash, /^sha256:[a-f0-9]{64}$/);

    const second = acceptKxmIntakeMessage(context, base);
    assert.equal(second.duplicate, true);
    assert.equal(second.message.messageId, first.message.messageId, "the same key and content must not create another message");

    assert.throws(
      () => acceptKxmIntakeMessage(context, { ...base, content: "ship it, but differently" }),
      /intake_payload_conflict/,
    );

    const admitted = admitKxmIntakeRun(context, first.message.messageId, { runId: "run_01JINTAKE000000000000000000" });
    assert.equal(admitted.dispatch.state, "admitted");
    assert.equal(admitted.dispatch.runId, "run_01JINTAKE000000000000000000");

    const again = admitKxmIntakeRun(context, first.message.messageId, { runId: "run_01JINTAKE000000000000000000" });
    assert.deepEqual(again, admitted, "admission is idempotent for the same run");
    assert.throws(
      () => admitKxmIntakeRun(context, first.message.messageId, { runId: "run_01JINTAKE111111111111111111" }),
      /intake_second_admission/,
      "a duplicate must never create a second task",
    );
    assert.deepEqual(listKxmDispatchableIntake(context).map((m) => m.messageId), [], "an admitted message leaves the dispatchable set");
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("pause holds dispatch intent durably and resume releases it in arrival order", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-pause-");
  try {
    const { coordinator } = bound(context);
    assert.equal(isKxmProjectPaused(context), false);

    const beforePause = acceptKxmIntakeMessage(context, {
      coordinatorId: coordinator.coordinatorId,
      idempotencyKey: "first",
      content: "one",
      source: { kind: "operator", id: "root" },
      now: "2026-09-18T00:00:01.000Z",
    });
    const third = acceptKxmIntakeMessage(context, {
      coordinatorId: coordinator.coordinatorId,
      idempotencyKey: "third",
      content: "three",
      source: { kind: "operator", id: "root" },
      now: "2026-09-18T00:00:03.000Z",
    });
    // Written out of order on purpose: the Runtime owns ordering, so a caller
    // cannot jump the queue with a backdated `now`.
    const middle = acceptKxmIntakeMessage(context, {
      coordinatorId: coordinator.coordinatorId,
      idempotencyKey: "second",
      content: "two",
      source: { kind: "operator", id: "root" },
      now: "2026-09-18T00:00:02.000Z",
    });
    const paused = setKxmProjectPause(context, { paused: true, actor: OPERATOR, reason: "release freeze" });
    assert.deepEqual(paused.released, [], "pausing releases nothing");
    assert.equal(paused.control.paused, true);
    assert.equal(isKxmProjectPaused(context), true);

    // Fresh dispatch is blocked, and a message arriving while paused is held, not lost.
    assert.throws(
      () => admitKxmIntakeRun(context, beforePause.message.messageId, { runId: "run_01JINTAKE000000000000000000" }),
      /intake_paused/,
    );
    const heldWhilePaused = acceptKxmIntakeMessage(context, {
      coordinatorId: coordinator.coordinatorId,
      idempotencyKey: "fourth",
      content: "four",
      source: { kind: "schedule", id: "cron" },
      now: "2026-09-18T00:00:04.000Z",
    });
    assert.equal(heldWhilePaused.message.dispatch.state, "held_paused");
    assert.equal(heldWhilePaused.message.dispatch.reason, "project_paused");
    assert.deepEqual(listKxmDispatchableIntake(context), [], "nothing is dispatchable while paused");

    const resumed = setKxmProjectPause(context, { paused: false, actor: OPERATOR });
    assert.equal(resumed.control.paused, false);
    const releasedKeys = resumed.released.map((message: KxmIntakeMessage) => message.idempotencyKey);
    assert.deepEqual(releasedKeys, ["fourth"], "only intent that arrived during the pause transitions on resume");
    assert.deepEqual(
      listKxmDispatchableIntake(context).map((message) => message.idempotencyKey),
      ["first", "third", "second", "fourth"],
      "release follows Runtime arrival order, not a caller-supplied timestamp",
    );
    assert.equal(middle.message.idempotencyKey, "second");
    assert.equal(middle.message.dispatch.state, "ready");
    assert.equal(third.message.classification, "project");
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("resume drains more held intent than one page and leaves none behind", () => {
  // Astra's finding: a single capped page stranded the 501st message behind a
  // claim that resume releases held intent.
  const { root, stateRoot, context } = intakeContext("kxm-intake-drain-");
  try {
    const { coordinator } = bound(context);
    setKxmProjectPause(context, { paused: true, actor: OPERATOR, reason: "flood" });
    const total = 601;
    for (let index = 0; index < total; index += 1) {
      acceptKxmIntakeMessage(context, {
        coordinatorId: coordinator.coordinatorId,
        idempotencyKey: `job-${String(index)}`,
        content: `payload ${index}`,
        source: { kind: "schedule", id: "cron" },
      });
    }
    const resumed = setKxmProjectPause(context, { paused: false, actor: OPERATOR });
    assert.equal(resumed.released.length, total, `every held row must release, saw ${String(resumed.released.length)}`);
    assert.equal(context.eventStore.intakeInStates(context.projectId, ["held_paused"], 5).length, 0, "nothing stays stranded after resume");
    assert.equal(listKxmDispatchableIntake(context, total + 10).length, total);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("a tool ceiling may only narrow: preset changes, lifted denials and dropped policy are refusals", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-tools-");
  try {
    const base = {
      repositoryAccess: "read" as const,
      effects: ["dispatch"],
      tools: { preset: "read-only", allow: ["read", "search"], deny: ["write", "shell"] },
    };
    bindKxmCoordinator(context, { role: "gated", authority: base, actor: OPERATOR });
    const rebind = (authority: KxmCoordinatorAuthority) => bindKxmCoordinator(context, {
      role: "gated",
      authority,
      actor: OPERATOR,
      rebind: { approvedBy: OPERATOR, reason: "reviewed narrowing" },
    });

    assert.throws(() => rebind({ ...base, tools: { preset: "workspace-writer", allow: ["read", "search"], deny: ["write", "shell"] } }), /coordinator_rebind_changes_preset/);
    assert.throws(() => rebind({ ...base, tools: { preset: "read-only", allow: ["read", "search"], deny: ["write"] } }), /coordinator_rebind_removes_denials/);
    assert.throws(() => rebind({ repositoryAccess: "read", effects: ["dispatch"] }), /coordinator_rebind_widens_tools/);
    assert.throws(() => rebind({ ...base, tools: { preset: "read-only", allow: ["read", "search", "write"], deny: ["write", "shell"] } }), /coordinator_rebind_widens_tools/);
    // An absent or empty allow list imposes no restriction (`commands.ts` gates
    // only on a non-empty list), so dropping one is a widening, not a cleanup.
    assert.throws(() => rebind({ ...base, tools: { preset: "read-only", allow: [], deny: ["write", "shell"] } }), /coordinator_rebind_clears_allowlist/);
    assert.throws(
      () => rebind({ repositoryAccess: "read", effects: ["dispatch"], tools: { preset: "read-only", deny: ["write", "shell"] } }),
      /coordinator_rebind_clears_allowlist/,
    );

    // Genuine narrowing still works: fewer allowances, more denials.
    const narrowed = rebind({ ...base, tools: { preset: "read-only", allow: ["read"], deny: ["write", "shell", "network"] } });
    assert.equal(narrowed.created, true);
    assert.deepEqual(narrowed.coordinator.authority.tools?.allow, ["read"]);
    assert.deepEqual(narrowed.coordinator.authority.tools?.deny, ["network", "shell", "write"]);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("equivalent ceilings hash alike and carry the real configuration revision", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-canonical-");
  try {
    const bundle = loadKxmProject(root);
    const first = bindKxmCoordinator(context, {
      role: "ordered",
      authority: { repositoryAccess: "none", effects: ["write-file", "dispatch"], tools: { preset: "read-only", allow: ["b", "a"], deny: ["z"] } },
      actor: OPERATOR,
    });
    const again = bindKxmCoordinator(context, {
      role: "ordered",
      authority: { repositoryAccess: "none", effects: ["dispatch", "write-file"], tools: { preset: "read-only", allow: ["a", "b"], deny: ["z"] } },
      actor: OPERATOR,
    });
    assert.equal(again.created, false, "reordering or repeating set members is not a ceiling change");
    assert.equal(again.coordinator.coordinatorId, first.coordinator.coordinatorId);
    assert.equal(again.coordinator.ceilingHash, first.coordinator.ceilingHash);
    assert.deepEqual(again.coordinator.authority.effects, ["dispatch", "write-file"]);

    // The revision is the loaded configuration's, not a hash of where the project
    // happens to live.
    assert.match(first.coordinator.configRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.coordinator.configRevision, bundle.configRevision);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("a duplicate may not be re-labelled, and a persisted record that disagrees fails closed", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-integrity-");
  try {
    const { coordinator } = bound(context);
    const base = {
      coordinatorId: coordinator.coordinatorId,
      idempotencyKey: "label-swap",
      content: "top secret",
      source: { kind: "adapter" as const, id: "pi" },
    };
    acceptKxmIntakeMessage(context, { ...base, classification: "project" });
    assert.throws(
      () => acceptKxmIntakeMessage(context, { ...base, classification: "secret" }),
      /intake_classification_conflict/,
      "a retry may not relabel a stored plaintext row as secret, or launder a withheld row",
    );

    // Corrupt the persisted payload while leaving its index columns intact.
    const row = context.eventStore.intakeBySlot(context.projectId, coordinator.coordinatorId, "label-swap");
    assert.ok(row);
    const tampered = (JSON.parse(row!.record) as KxmIntakeMessage & { idempotencyKey?: string });
    tampered.idempotencyKey = "rewritten-offline";
    const database = new DatabaseSync(context.eventStore.path);
    try {
      database.prepare("UPDATE intake_messages SET record = ? WHERE message_id = ?").run(JSON.stringify(tampered), row!.messageId);
    } finally {
      database.close();
    }
    assert.throws(() => context.eventStore.intakeMessage(row!.messageId), /intake_record_divergent/);

    // Known limit, stated as an assertion rather than prose: a rewrite that touches
    // only non-indexed payload (the content body) is NOT detected, because the
    // record carries no digest column. Ticketed in Tracking as the v6 follow-up.
    const bodyOnly = (JSON.parse(row!.record) as KxmIntakeMessage & { content?: string });
    bodyOnly.content = "silently replaced";
    const clean = new DatabaseSync(context.eventStore.path);
    try {
      clean.prepare("UPDATE intake_messages SET record = ? WHERE message_id = ?").run(JSON.stringify(bodyOnly), row!.messageId);
    } finally {
      clean.close();
    }
    assert.doesNotThrow(() => context.eventStore.intakeMessage(row!.messageId), "payload-only tampering is still readable: no record digest exists yet");
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("a coordinator written before set canonicalisation still matches an equivalent bind", () => {
  // Rows created by the released 0.7.46 code hashed the authority as supplied, so
  // an unsorted `effects` list carries a fingerprint the canonicaliser will not
  // reproduce. Upgrading must not force every one of them through a policy rebind.
  const { root, stateRoot, context } = intakeContext("kxm-intake-legacy-hash-");
  const legacyEffects = ["zeta", "alpha"];
  const legacyHash = `sha256:${createHash("sha256")
    .update(kxmCanonicalJson({ repositoryAccess: "none", effects: legacyEffects } as unknown as JsonValue), "utf8")
    .digest("hex")}`;
  try {
    const legacy = {
      schema: "kxm.coordinator.v1",
      coordinatorId: "crd_legacy0000000000000000000000",
      projectId: context.projectId,
      role: "legacy",
      channel: "primary",
      authority: { repositoryAccess: "none", effects: legacyEffects },
      boundAt: "2026-09-17T00:00:00.000Z",
      boundBy: { kind: "human", id: "root" },
      configRevision: legacyHash,
      ceilingHash: legacyHash,
    };
    context.eventStore.insertCoordinatorIfAbsent({
      coordinatorId: legacy.coordinatorId,
      projectId: legacy.projectId,
      role: legacy.role,
      channel: legacy.channel,
      ceilingHash: legacy.ceilingHash,
      configRevision: legacy.configRevision,
      boundAt: legacy.boundAt,
      record: kxmCanonicalJson(legacy as unknown as JsonValue),
    });

    assert.notEqual(legacyHash, kxmCeilingHash({ repositoryAccess: "none", effects: legacyEffects }),
      "the legacy fingerprint really does differ from the canonical one");
    const rebound = bindKxmCoordinator(context, {
      role: "legacy",
      authority: { repositoryAccess: "none", effects: legacyEffects },
      actor: OPERATOR,
    });
    assert.equal(rebound.created, false, "an equivalent authority must not demand a policy rebind after upgrade");
    assert.equal(rebound.coordinator.coordinatorId, legacy.coordinatorId);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("a busy database fails the transaction, backs off, and recovers", async () => {
  // `activeTransactions` used to be claimed before BEGIN, so BEGIN sitting outside
  // the try/finally left the connection permanently marked as in-transaction: every
  // later transaction failed with a misleading "nested transactions are not
  // allowed". The fix must not turn that into a 5-second stall per attempt either,
  // hence the bounded backoff asserted below.
  const { root, stateRoot, context } = intakeContext("kxm-intake-txn-busy-");
  const other = new DatabaseSync(context.eventStore.path);
  let firstFailureMs = 0;
  try {
    other.exec("BEGIN IMMEDIATE");
    other.prepare("INSERT INTO project_controls (project_id, paused, reason, updated_at, actor, schema, record) VALUES (?, 1, 'lock', '2026-09-18T00:00:00.000Z', 'human:other', 'kxm.project-control.v1', '{}')")
      .run(context.projectId);
    const startedAt = Date.now();
    assert.throws(() => context.eventStore.transaction(() => setKxmProjectPause(context, { paused: true, actor: OPERATOR })), /runtime_transaction_busy/);
    firstFailureMs = Date.now() - startedAt;

    // Still holding the lock: the next attempt must refuse fast, not pay the busy
    // timeout again.
    const retryStartedAt = Date.now();
    assert.throws(() => context.eventStore.transaction(() => setKxmProjectPause(context, { paused: true, actor: OPERATOR })), /retry deferred/);
    const retryMs = Date.now() - retryStartedAt;
    assert.ok(retryMs < 500, `the backoff must fail fast instead of re-waiting the busy timeout: ${String(retryMs)}ms vs first ${String(firstFailureMs)}ms`);
  } finally {
    try { other.exec("ROLLBACK"); } catch { /* lock released by close */ }
    other.close();
  }
  try {
    // Once the backoff window passes, the same connection works again: the marker
    // was never left set by the failed BEGIN.
    await new Promise((resolve) => setTimeout(resolve, TRANSACTION_BUSY_BACKOFF_MS + 150));
    const paused = setKxmProjectPause(context, { paused: true, actor: OPERATOR, reason: "after busy" });
    assert.equal(paused.control.paused, true);
    assert.equal(isKxmProjectPaused(context), true);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("intake never persists a secret-classified payload and bounds oversized content", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-secrets-");
  try {
    const { coordinator } = bound(context);
    const secret = acceptKxmIntakeMessage(context, {
      coordinatorId: coordinator.coordinatorId,
      idempotencyKey: "api-key-rotation",
      content: "hunter2-do-not-store-me",
      classification: "secret",
      source: { kind: "adapter", id: "pi" },
    });
    assert.equal(secret.message.content, undefined, "secret content must not be persisted");
    assert.equal(secret.message.contentOmittedReason, "secret-classified");
    assert.match(secret.message.contentHash, /^sha256:[a-f0-9]{64}$/);
    const stored = context.eventStore.intakeMessage(secret.message.messageId);
    assert.ok(stored);
    assert.equal(stored!.record.includes("hunter2-do-not-store-me"), false, "the persisted record must not contain the secret");

    assert.throws(
      () => acceptKxmIntakeMessage(context, {
        coordinatorId: coordinator.coordinatorId,
        idempotencyKey: "too-big",
        content: "x".repeat(MAX_INTAKE_CONTENT_BYTES + 1),
        source: { kind: "hub", id: "hub-1" },
      }),
      /intake_content_too_large/,
    );
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("intake fails closed on unknown identity, bad keys, and empty content", () => {
  const { root, stateRoot, context } = intakeContext("kxm-intake-failclosed-");
  try {
    const { coordinator } = bound(context);
    assert.throws(() => resolveKxmCoordinator(context, "crd_000000000000000000000000000nope"), /coordinator_unknown/);
    assert.throws(
      () => acceptKxmIntakeMessage(context, {
        coordinatorId: "crd_000000000000000000000000000nope",
        idempotencyKey: "k",
        content: "x",
        source: { kind: "hub", id: "hub-1" },
      }),
      /coordinator_unknown/,
    );
    assert.throws(
      () => acceptKxmIntakeMessage(context, { coordinatorId: coordinator.coordinatorId, idempotencyKey: "", content: "x", source: { kind: "hub", id: "hub-1" } }),
      /intake_field_invalid/,
    );
    assert.throws(
      () => acceptKxmIntakeMessage(context, { coordinatorId: coordinator.coordinatorId, idempotencyKey: "k", content: "", source: { kind: "hub", id: "hub-1" } }),
      /intake_content_missing/,
    );
    assert.throws(
      () => acceptKxmIntakeMessage(context, { coordinatorId: coordinator.coordinatorId, idempotencyKey: "k", content: "x", source: { kind: "carrier-pigeon" as never, id: "hub-1" } }),
      /intake_source_invalid/,
    );
    assert.throws(
      () => bindKxmCoordinator(context, { role: "Coordinator One!", authority: READ_ONLY, actor: OPERATOR }),
      /coordinator_identifier_invalid/,
    );
    assert.throws(
      () => bindKxmCoordinator(context, { role: "ok", authority: { repositoryAccess: "everything", effects: [] } as never, actor: OPERATOR }),
      /coordinator_authority_invalid/,
    );
    assert.throws(
      () => admitKxmIntakeRun(context, "msg_0000000000000000000000000000nope", { runId: "run_01JINTAKE000000000000000000" }),
      /intake_message_unknown/,
    );
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("identity, dedupe and dispatch state survive a restart", () => {
  const { root, stateRoot } = engineProject("kxm-intake-restart-");
  const heldKeysBefore: string[] = [];
  let coordinatorId = "";
  let messageId = "";
  try {
    const opening = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const { coordinator } = bound(opening);
      coordinatorId = coordinator.coordinatorId;
      setKxmProjectPause(opening, { paused: true, actor: OPERATOR, reason: "window" });
      const held = acceptKxmIntakeMessage(opening, {
        coordinatorId,
        idempotencyKey: "across-restart",
        content: "durable intent",
        source: { kind: "peer", id: "peer-1" },
      });
      messageId = held.message.messageId;
      heldKeysBefore.push(held.message.dispatch.state);
    } finally {
      closeIntakeContext(opening);
    }

    assert.deepEqual(heldKeysBefore, ["held_paused"]);

    const reopened = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      assert.equal(resolveKxmCoordinator(reopened, coordinatorId).coordinatorId, coordinatorId, "coordinator identity is stable across restart");
      assert.equal(isKxmProjectPaused(reopened), true, "the pause survives restart");
      const duplicate = acceptKxmIntakeMessage(reopened, {
        coordinatorId,
        idempotencyKey: "across-restart",
        content: "durable intent",
        source: { kind: "peer", id: "peer-1" },
      });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.message.messageId, messageId);
      assert.throws(
        () => admitKxmIntakeRun(reopened, messageId, { runId: "run_01JINTAKE000000000000000000" }),
        /intake_paused/,
      );
      const resumed = setKxmProjectPause(reopened, { paused: false, actor: OPERATOR });
      assert.deepEqual(resumed.released.map((message) => message.messageId), [messageId]);
      const admitted = admitKxmIntakeRun(reopened, messageId, { runId: "run_01JINTAKE000000000000000000" });
      assert.equal(admitted.dispatch.state, "admitted");
    } finally {
      closeIntakeContext(reopened);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});
