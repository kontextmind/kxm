import assert from "node:assert/strict";
import test from "node:test";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/project.ts";
import { closeKxmRuntimeContext, openKxmRuntimeContext } from "../../plugins/kxm/src/runtime-service.ts";
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

test("pause holds dispatch intent durably and resume releases it in received order", () => {
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
    // Written out of order on purpose: release must follow received_at, not key order.
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
      ["first", "second", "third", "fourth"],
    );
    assert.equal(third.message.classification, "project");
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
