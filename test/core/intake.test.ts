import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadKxmProject, kxmCanonicalJson, type JsonValue } from "../../plugins/kxm/src/project-config.ts";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/project.ts";
import { closeKxmRuntimeContext, openKxmRuntimeContext } from "../../plugins/kxm/src/runtime-service.ts";
import { isTransactionContention, TRANSACTION_BUSY_BACKOFF_MS, withDatabaseTransaction } from "../../plugins/kxm/src/database.ts";
import { DatabaseSync as KxmDatabaseSync } from "../../plugins/kxm/src/sqlite.ts";
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

test("duplicate ingress yields one message and one admission record; altered payloads are refused", () => {
  // "One admission record" is deliberate: admitting writes the dispatch state and
  // the run id it belongs to. This contract does not create a task — the task
  // surface is the M2 consumer that has to come along.
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

test("resume drains past a thousand pages and leaves none behind", () => {
  // Astra's findings, in order: a single capped page stranded the 501st message,
  // and the first fix for that capped the loop at 1,000 pages. So this test forces
  // a one-row page and 1,002 held rows: the drain needs more than 1,000 pages to
  // finish, which is what makes it fail if any page cap comes back.
  const { root, stateRoot, context } = intakeContext("kxm-intake-drain-");
  try {
    const { coordinator } = bound(context);
    setKxmProjectPause(context, { paused: true, actor: OPERATOR, reason: "flood" });
    const total = 1_002;
    for (let index = 0; index < total; index += 1) {
      acceptKxmIntakeMessage(context, {
        coordinatorId: coordinator.coordinatorId,
        idempotencyKey: `job-${String(index)}`,
        content: `payload ${index}`,
        source: { kind: "schedule", id: "cron" },
      });
    }
    // Force the smallest possible page so the page count is the row count + 1.
    const realPages = context.eventStore.intakeInStates.bind(context.eventStore);
    let pages = 0;
    context.eventStore.intakeInStates = (projectId, states, limit) => {
      pages += 1;
      return realPages(projectId, states, 1);
    };
    try {
      const resumed = setKxmProjectPause(context, { paused: false, actor: OPERATOR });
      assert.equal(resumed.released.length, total, `every held row must release, saw ${String(resumed.released.length)}`);
      assert.ok(pages > 1_000, `the drain must cross the page count a 1,000-page cap would stop at, saw ${String(pages)}`);
      assert.equal(realPages(context.projectId, ["held_paused"], 5).length, 0, "nothing stays stranded after resume");
    } finally {
      // Restore the real paging before anything else reads through this store: the
      // one-row page is a lie the rest of the suite must not inherit.
      delete (context.eventStore as unknown as { intakeInStates?: unknown }).intakeInStates;
    }
    assert.equal(listKxmDispatchableIntake(context, total + 10).length, total);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("a drain that cannot progress rolls the whole resume back", () => {
  // Half-resuming is worse than failing: the control row would say "running"
  // while rows stayed held. So a page that releases nothing throws inside the
  // caller's transaction, and the rollback must undo the control write too.
  const { root, stateRoot, context } = intakeContext("kxm-intake-drain-stall-");
  try {
    const { coordinator } = bound(context);
    setKxmProjectPause(context, { paused: true, actor: OPERATOR, reason: "hold" });
    acceptKxmIntakeMessage(context, {
      coordinatorId: coordinator.coordinatorId,
      idempotencyKey: "job-stalled",
      content: "stays held",
      source: { kind: "schedule", id: "cron" },
    });
    const realUpdate = context.eventStore.updateIntakeDispatch.bind(context.eventStore);
    context.eventStore.updateIntakeDispatch = (messageId, expected, next) =>
      expected === "held_paused" ? false : realUpdate(messageId, expected, next);
    try {
      assert.throws(
        () => setKxmProjectPause(context, { paused: false, actor: OPERATOR }),
        /intake_drain_stalled/,
      );
    } finally {
      delete (context.eventStore as unknown as { updateIntakeDispatch?: unknown }).updateIntakeDispatch;
    }
    assert.equal(isKxmProjectPaused(context), true, "the failed resume must not leave the project looking unpaused");
    assert.equal(context.eventStore.intakeInStates(context.projectId, ["held_paused"], 5).length, 1);
    // A real resume after the induced stall still drains.
    const resumed = setKxmProjectPause(context, { paused: false, actor: OPERATOR });
    assert.equal(resumed.released.length, 1);
    assert.equal(isKxmProjectPaused(context), false);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("a held row whose state column contradicts its record fails resume closed", () => {
  // The drain makes progress by moving state and record together, so a row whose
  // columns disagree is the case that could look like endless progress. The store
  // validates every row it selects, so the throw lands before the page is returned
  // and the resume rolls its own control write back.
  const { root, stateRoot, context } = intakeContext("kxm-intake-divergent-");
  try {
    const { coordinator } = bound(context);
    // Accepted while unpaused, so the record legitimately says `ready`; the forged
    // half is the index column, which is what puts the row in the drain's selection.
    const stored = acceptKxmIntakeMessage(context, {
      coordinatorId: coordinator.coordinatorId,
      idempotencyKey: "job-divergent",
      content: "state column lies",
      source: { kind: "schedule", id: "cron" },
    });
    setKxmProjectPause(context, { paused: true, actor: OPERATOR, reason: "hold" });
    const tamper = new DatabaseSync(context.eventStore.path);
    try {
      tamper.prepare("UPDATE intake_messages SET dispatch_state = 'held_paused' WHERE message_id = ?")
        .run(stored.message.messageId);
    } finally {
      tamper.close();
    }

    assert.throws(
      () => setKxmProjectPause(context, { paused: false, actor: OPERATOR }),
      /intake_record_divergent/,
      "a contradictory row must stop the drain, not spin it",
    );
    assert.equal(isKxmProjectPaused(context), true, "a failed resume must roll its own control write back");
    const reader = new DatabaseSync(context.eventStore.path);
    try {
      const raw = reader.prepare("SELECT dispatch_state AS s FROM intake_messages WHERE message_id = ?")
        .get(stored.message.messageId) as { s: string };
      assert.equal(raw.s, "held_paused", "a failed resume must not rewrite a row it could not validate");
    } finally {
      reader.close();
    }
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
    assert.equal(again.created, false, "reordering set members is not a ceiling change");
    assert.equal(again.coordinator.coordinatorId, first.coordinator.coordinatorId);
    assert.equal(again.coordinator.ceilingHash, first.coordinator.ceilingHash);
    assert.deepEqual(again.coordinator.authority.effects, ["dispatch", "write-file"]);

    // Repeats are the other half of "a set is a set". The binder rejects them as
    // input, so equivalence has to be proved one layer down, on the fingerprint.
    const reordered = { repositoryAccess: "none", effects: ["dispatch", "write-file"] } as const;
    const shuffled = { repositoryAccess: "none", effects: ["write-file", "dispatch"] } as const;
    assert.equal(kxmCeilingHash(reordered), kxmCeilingHash(shuffled),
      "fingerprinting must not depend on the order a caller happened to write");
    assert.equal(kxmCeilingHash({ repositoryAccess: "none", effects: ["dispatch", "dispatch", "write-file"] }), kxmCeilingHash(reordered),
      "a repeated member must not change the ceiling");
    assert.notEqual(kxmCeilingHash({ repositoryAccess: "none", effects: ["dispatch"] }), kxmCeilingHash(reordered),
      "a real narrowing must still change it");
    assert.throws(
      () => bindKxmCoordinator(context, { role: "ordered", authority: { ...shuffled, effects: ["dispatch", "dispatch", "write-file"] }, actor: OPERATOR }),
      /coordinator_authority_invalid/,
      "the binder itself refuses repeated members rather than silently de-duping",
    );

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

/** The first config-issue code of a KxmConfigError, or `undefined` for anything else. */
function errorCodeOf(error: unknown): string | undefined {
  const issue = (error as { issues?: Array<{ code?: string }> } | undefined)?.issues?.[0];
  return typeof issue?.code === "string" ? issue.code : undefined;
}

function captureError(work: () => unknown): { error: unknown; ms: number } {
  const startedAt = Date.now();
  try {
    work();
    return { error: undefined, ms: Date.now() - startedAt };
  } catch (error) {
    return { error, ms: Date.now() - startedAt };
  }
}

function deferredMsOf(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  return Number(/retry deferred (\d+)ms/.exec(message)?.[1] ?? Number.NaN);
}

test("a busy database fails the transaction, throttles monotonically, and recovers", async () => {
  // `activeTransactions` used to be claimed before BEGIN, so BEGIN sitting outside
  // the try/finally left the connection permanently marked as in-transaction: every
  // later transaction failed with a misleading "nested transactions are not
  // allowed". The throttle that replaced the accidental fast-fail is a bounded,
  // per-connection, monotonic refusal — this test pins all three words.
  const { root, stateRoot, context } = intakeContext("kxm-intake-txn-busy-");
  const other = new DatabaseSync(context.eventStore.path);
  const attemptPause = () => context.eventStore.transaction(() => setKxmProjectPause(context, { paused: true, actor: OPERATOR }));
  try {
    other.exec("BEGIN IMMEDIATE");
    other.prepare("INSERT INTO project_controls (project_id, paused, reason, updated_at, actor, schema, record) VALUES (?, 1, 'lock', '2026-09-18T00:00:00.000Z', 'human:other', 'kxm.project-control.v1', '{}')")
      .run(context.projectId);

    // First attempt pays the real busy timeout and is reported as contention.
    const blocked = captureError(attemptPause);
    assert.equal(errorCodeOf(blocked.error), "runtime_transaction_busy");
    assert.match((blocked.error as Error).message, /blocked by another transaction/);

    // A retry inside the window refuses fast, and says how long it is refusing
    // for. The bound is the assertion: an unbounded or wall-clock deadline is the
    // defect this replaces.
    const retry = captureError(attemptPause);
    assert.equal(errorCodeOf(retry.error), "runtime_transaction_busy");
    assert.match((retry.error as Error).message, /retry deferred/);
    assert.ok(retry.ms < TRANSACTION_BUSY_BACKOFF_MS, `the throttle must fail fast, not re-wait the timeout: ${String(retry.ms)}ms`);
    const deferred = deferredMsOf(retry.error);
    assert.ok(deferred > 0 && deferred <= TRANSACTION_BUSY_BACKOFF_MS, `refusal must stay inside the documented window: ${String(deferred)}ms`);

    // Whether the deadline is monotonic rather than wall-clock is proven in the next
    // test, deterministically and without sleeping through a timeout.
  } finally {
    try { other.exec("ROLLBACK"); } catch { /* lock released by close */ }
    other.close();
  }

  // The lock is gone now. A different connection to the same file is not infected
  // by this one's bad luck, while the throttled connection is still refused.
  const neighbour = new KxmDatabaseSync(context.eventStore.path);
  try {
    assert.equal(withDatabaseTransaction(neighbour, () => "unthrottled"), "unthrottled");
    assert.equal(errorCodeOf(captureError(attemptPause).error), "runtime_transaction_busy");
  } finally {
    neighbour.close();
  }

  // Once the window passes, the same connection works again: the marker was never
  // left set by the failed BEGIN, and the expiry clears the throttle.
  await new Promise((resolve) => setTimeout(resolve, TRANSACTION_BUSY_BACKOFF_MS + 150));
  try {
    const paused = setKxmProjectPause(context, { paused: true, actor: OPERATOR, reason: "after busy" });
    assert.equal(paused.control.paused, true);
    assert.equal(isKxmProjectPaused(context), true);
    // And a success clears the throttle, so a later contention pays the timeout
    // once instead of inheriting an old deadline.
    assert.equal(captureError(() => context.eventStore.transaction(() => 1)).error, undefined);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("the throttle is bounded by monotonic time, not by the wall clock", () => {
  // The first version stored `Date.now() + 1000`, so a clock step backwards kept a
  // long-gone write lock refusing transactions for hours and a step forward ended
  // the throttle early. The clock is driven here instead: both directions are
  // checked without sleeping, and the sleep-free assertion is the point — a test
  // that waits out its own deadline proves nothing about how it is measured.
  const { root, stateRoot } = engineProject("kxm-intake-txn-clock-");
  const file = join(stateRoot, "clock-probe.db");
  const holder = new KxmDatabaseSync(file);
  const probe = new KxmDatabaseSync(file);
  const attempt = (label: number) => String(captureError(() => withDatabaseTransaction(probe, () => label, "IMMEDIATE", clock)).error);
  let monotonicMs = 5_000;
  function clock(): number {
    return monotonicMs;
  }
  try {
    probe.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO probe (id) VALUES (1)");

    // No busy timeout on this handle, so contention reports at once and the
    // deadline is set from the injected clock.
    assert.match(attempt(1), /runtime_transaction_busy/);
    monotonicMs += TRANSACTION_BUSY_BACKOFF_MS - 1;
    assert.match(attempt(2), /retry deferred 1ms/);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() - 3_600_000;
      assert.match(attempt(3), /retry deferred 1ms/, "a backward clock step must not extend the throttle");
      Date.now = () => realNow() + 86_400_000;
      assert.match(attempt(4), /retry deferred 1ms/, "a forward clock step must not end the throttle early");
    } finally {
      Date.now = realNow;
    }

    // One monotonic millisecond later the window is over. The other writer has
    // committed, so this connection works again — and a successful BEGIN clears
    // the throttle rather than leaving a stale deadline behind.
    holder.exec("COMMIT");
    monotonicMs += 1;
    assert.equal(withDatabaseTransaction(probe, () => "after the window", "IMMEDIATE", clock), "after the window");

    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO probe (id) VALUES (2)");
    assert.match(attempt(5), /runtime_transaction_busy/, "a fresh contention arms a fresh window");
    monotonicMs += 1;
    assert.match(attempt(6), /retry deferred 999ms/, "the refusal counts down from the new window, not the cleared one");

    // And the **default** clock, because that is what production runs on. A fresh
    // handle with no busy timeout reports contention immediately, so the wall clock
    // can be stepped without sleeping through anything: a wall-clock deadline would
    // either report hours of refusal here or vanish entirely on the forward step.
    const wall = new KxmDatabaseSync(file);
    try {
      assert.match(String(captureError(() => withDatabaseTransaction(wall, () => 1)).error), /runtime_transaction_busy/);
      const realNow = Date.now;
      try {
        Date.now = () => realNow() - 3_600_000;
        const backward = deferredMsOf(captureError(() => withDatabaseTransaction(wall, () => 2)).error);
        assert.ok(backward > 0 && backward <= TRANSACTION_BUSY_BACKOFF_MS,
          `the default deadline must not be the wall clock: ${String(backward)}ms`);
        Date.now = () => realNow() + 3_600_000;
        const forward = deferredMsOf(captureError(() => withDatabaseTransaction(wall, () => 3)).error);
        assert.ok(forward > 0 && forward <= TRANSACTION_BUSY_BACKOFF_MS,
          `a forward clock step must not end the throttle early: ${String(forward)}ms`);
      } finally {
        Date.now = realNow;
      }
    } finally {
      wall.close();
    }
  } finally {
    holder.close();
    probe.close();
    removeTempDir(root, stateRoot);
  }
});

test("a throttle armed by one clock cannot contaminate another, nor be cleared by it", () => {
  // The injectable clock exists for tests, so the hazard it introduces has to be
  // gated: the first version kept one deadline per connection and subtracted
  // whichever clock the next call supplied. A valid monotonic clock that merely sat
  // an hour ahead therefore throttled an unrelated production-shaped caller for an
  // hour, and `() => NaN` let calls through with no deadline at all.
  const { root, stateRoot } = engineProject("kxm-intake-txn-domains-");
  const file = join(stateRoot, "domains-probe.db");
  const holder = new KxmDatabaseSync(file);
  const probe = new KxmDatabaseSync(file);
  // An origin an hour away from the default clock, because that is the exact case
  // round 4 found: a *valid* monotonic clock, simply in another domain.
  let fakeMs = Number(process.hrtime.bigint() / 1_000_000n) + 3_600_000;
  const fakeClock = () => fakeMs;
  const attemptWith = (clock: (() => number) | undefined, label: number) =>
    String(captureError(() =>
      clock === undefined
        ? withDatabaseTransaction(probe, () => label)
        : withDatabaseTransaction(probe, () => label, "IMMEDIATE", clock)).error);
  try {
    probe.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO probe (id) VALUES (1)");

    assert.match(attemptWith(fakeClock, 1), /runtime_transaction_busy/, "the fake domain arms its own deadline");
    // A caller with no clock at all must neither inherit nor clear that deadline.
    const inherited = attemptWith(undefined, 2);
    assert.match(inherited, /runtime_transaction_busy/);
    assert.match(inherited, /blocked by another transaction/, "the default domain must reach BEGIN, not a borrowed refusal");
    assert.match(attemptWith(fakeClock, 3), /retry deferred/, "and the foreign deadline must still be intact afterwards");

    // Two distinct functions that read the *same* numbers are still two domains,
    // because the key is identity and not value: neither may borrow the other's
    // deadline, and arming one does not arm the other.
    const twinA = () => fakeMs;
    const twinB = () => fakeMs;
    // "busy" is not enough: a borrowed deadline reports the same label as fresh
    // contention. Each twin's first attempt must actually reach BEGIN, and each must
    // then be refused inside its own window.
    assert.match(attemptWith(twinA, 31), /blocked by another transaction/, "twin A reaches BEGIN");
    assert.match(attemptWith(twinB, 32), /blocked by another transaction/, "twin B reaches BEGIN independently");
    assert.match(attemptWith(twinA, 33), /retry deferred/, "twin A is refused inside its own window");
    assert.match(attemptWith(twinB, 34), /retry deferred/, "twin B is refused inside its own window too");

    // The default domain armed its own on attempt 2, so a second default call is
    // refused inside a bounded window.
    const deferred = deferredMsOf(captureError(() => withDatabaseTransaction(probe, () => 4)).error);
    assert.ok(deferred > 0 && deferred <= TRANSACTION_BUSY_BACKOFF_MS,
      `the default window is bounded: ${String(deferred)}ms`);

    // A clock that cannot produce a number fails closed instead of meaning "no
    // deadline", and cannot unlock the domain that is genuinely throttled.
    assert.match(attemptWith(() => Number.NaN, 5), /runtime_transaction_clock_invalid/);
    assert.match(attemptWith(undefined, 6), /retry deferred/, "an unusable clock must not clear another domain's throttle");
    // The guard runs where throttle state is read or armed, and nowhere else. Counting
    // the reads is the only way to say that: a discarded extra read, or a read on the
    // success path, would otherwise be invisible while still being a claim untested.
    const quiet = new KxmDatabaseSync(join(stateRoot, "quiet.db"));
    try {
      assert.equal(withDatabaseTransaction(quiet, () => "ran", "IMMEDIATE", () => Number.NaN), "ran",
        "an uncontended transaction with no pending entry must not consult a broken clock");
      let reads = 0;
      const counting = () => { reads += 1; return Number(process.hrtime.bigint() / 1_000_000n); };
      assert.equal(withDatabaseTransaction(quiet, () => "ran again", "IMMEDIATE", counting), "ran again");
      assert.equal(reads, 0, `a clean success must read the clock zero times, saw ${String(reads)}`);
      assert.equal(withDatabaseTransaction(quiet, () => "deferred", "DEFERRED", counting), "deferred",
        "DEFERRED skips the deadline check entirely");
      assert.equal(reads, 0, `a DEFERRED transaction must read the clock zero times, saw ${String(reads)}`);

      // The row the round-11 probe measured and the committed test did not: a
      // DEFERRED success while another domain holds a pending deadline. Zero reads
      // is what the table in the code comment claims, so it has to be counted here.
      const pending = new KxmDatabaseSync(join(stateRoot, "deferred-pending.db"));
      const pendingLock = new KxmDatabaseSync(join(stateRoot, "deferred-pending.db"));
      try {
        pending.exec("CREATE TABLE pending (id INTEGER PRIMARY KEY)");
        pendingLock.exec("BEGIN IMMEDIATE");
        pendingLock.exec("INSERT INTO pending (id) VALUES (1)");
        let pendingArmReads = 0;
        const pendingClock = () => { pendingArmReads += 1; return Number(process.hrtime.bigint() / 1_000_000n); };
        assert.match(String(captureError(() => withDatabaseTransaction(pending, () => 1, "IMMEDIATE", pendingClock)).error),
          /blocked by another transaction/, "arm a pending deadline on this connection");
        const beforeDeferred = pendingArmReads;
        assert.equal(withDatabaseTransaction(pending, () => "deferred while pending", "DEFERRED", pendingClock),
          "deferred while pending");
        assert.equal(pendingArmReads - beforeDeferred, 0,
          `a DEFERRED success with a pending deadline must read zero times, saw ${String(pendingArmReads - beforeDeferred)}`);
        assert.match(String(captureError(() => withDatabaseTransaction(pending, () => 2, "IMMEDIATE", pendingClock)).error),
          /retry deferred/, "and the pending write deadline must survive that DEFERRED success");
      } finally {
        try { pendingLock.exec("ROLLBACK"); } catch { /* closed below */ }
        pending.close();
        pendingLock.close();
      }

      // The exact read budget on the contention path: one read to arm, one to refuse.
      // Anything more is a read the documents do not claim, and a discarded read is the
      // kind of drift that made the previous two wordings wrong.
      const busy = new KxmDatabaseSync(join(stateRoot, "counted-busy.db"));
      const locker = new KxmDatabaseSync(join(stateRoot, "counted-busy.db"));
      try {
        busy.exec("CREATE TABLE counted (id INTEGER PRIMARY KEY)");
        locker.exec("BEGIN IMMEDIATE");
        locker.exec("INSERT INTO counted (id) VALUES (1)");
        let counted = 0;
        const countingClock = () => { counted += 1; return Number(process.hrtime.bigint() / 1_000_000n); };
        const arm = () => captureError(() => withDatabaseTransaction(busy, () => "x", "IMMEDIATE", countingClock));
        void counted;
        assert.match(String(arm().error), /blocked by another transaction/);
        assert.equal(counted, 1, `arming must read the clock exactly once, saw ${String(counted)}`);
        assert.match(String(arm().error), /retry deferred/);
        assert.equal(counted, 2, `refusing must read the clock exactly once, saw ${String(counted)}`);
        // Expired deadline followed by renewed contention: the expiry check reads once,
        // then arming reads again. This is the path the earlier "consulted twice" prose
        // quietly ignored, and the reason the claim is now a counted table.
        // An expired deadline followed by renewed contention reads **twice in that
        // call** — once to discover the deadline is gone, once to arm the new one. The
        // earlier prose ("consulted twice") implied a global budget and hid this path;
        // the assertion is a delta on a stepped clock, not a sleep.
        let stepped = 0;
        let stepReads = 0;
        const stepClock = () => { stepReads += 1; return stepped; };
        assert.match(String(captureError(() => withDatabaseTransaction(busy, () => "x", "IMMEDIATE", stepClock)).error),
          /blocked by another transaction/);
        assert.equal(stepReads, 1, `arming on a fresh domain reads once, saw ${String(stepReads)}`);
        stepped = TRANSACTION_BUSY_BACKOFF_MS;
        stepReads = 0;
        assert.match(String(captureError(() => withDatabaseTransaction(busy, () => "x", "IMMEDIATE", stepClock)).error),
          /blocked by another transaction/);
        assert.equal(stepReads, 2,
          `an expired deadline followed by renewed contention reads twice in that call, saw ${String(stepReads)}`);
        // Zero-read paths: a nested rejection and a permanent BEGIN failure never reach a
        // reading, which is what makes the old "only an uncontended success skips it"
        // wording wrong in the other direction.
        let untouched = 0;
        const counting2 = () => { untouched += 1; return Number(process.hrtime.bigint() / 1_000_000n); };
        assert.match(String(captureError(() => withDatabaseTransaction(busy, () => {
          withDatabaseTransaction(busy, () => 1, "IMMEDIATE", counting2);
        }, "DEFERRED", counting2)).error), /runtime_transaction_nested/);
        assert.equal(untouched, 0, `a nested rejection must read the clock zero times, saw ${String(untouched)}`);
        const permanent = new KxmDatabaseSync(":memory:");
        try {
          permanent.exec("BEGIN IMMEDIATE");
          let permanentReads = 0;
          const permanentClock = () => { permanentReads += 1; return Number.NaN; };
          assert.match(String(captureError(() => withDatabaseTransaction(permanent, () => 1, "IMMEDIATE", permanentClock)).error),
            /cannot start a transaction within a transaction/);
          assert.equal(permanentReads, 0,
            `a permanent BEGIN failure must read the clock zero times, saw ${String(permanentReads)}`);
        } finally {
          permanent.close();
        }
      } finally {
        try { locker.exec("ROLLBACK"); } catch { /* closed below */ }
        busy.close();
        locker.close();
      }
    } finally {
      quiet.close();
    }

    // Expiry is per domain too: stepping the fake clock cannot release the default
    // caller that is still inside its own window, and the released domain must
    // actually reach BEGIN rather than failing some other way.
    fakeMs += TRANSACTION_BUSY_BACKOFF_MS + 1;
    assert.match(attemptWith(undefined, 7), /retry deferred/);
    assert.match(attemptWith(fakeClock, 8), /blocked by another transaction/,
      "an expired domain must reach BEGIN, not merely avoid the deferred message");
  } finally {
    holder.close();
    probe.close();
    removeTempDir(root, stateRoot);
  }
});

test("the throttle is scoped to the modes that can lose the write race", () => {
  // The check used to run before the mode was considered, so a DEFERRED
  // transaction — which takes no write lock and cannot lose a race — was refused
  // by another caller's contention. A plain file connection with no busy timeout
  // makes the blocked BEGIN fail at once, so this is deterministic.
  const { root, stateRoot } = engineProject("kxm-intake-txn-mode-");
  const file = join(stateRoot, "mode-probe.db");
  const holder = new KxmDatabaseSync(file);
  const probe = new KxmDatabaseSync(file);
  try {
    probe.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO probe (id) VALUES (1)");

    const blocked = captureError(() => withDatabaseTransaction(probe, () => "immediate"));
    assert.equal(errorCodeOf(blocked.error), "runtime_transaction_busy");
    assert.match(String(captureError(() => withDatabaseTransaction(probe, () => "immediate")).error), /retry deferred/);

    assert.equal(
      withDatabaseTransaction(probe, () => Number((probe.prepare("SELECT COUNT(*) AS n FROM probe").get() as { n: number }).n), "DEFERRED"),
      0,
      "a DEFERRED transaction must run, and must see the pre-commit state",
    );
    // Reading successfully proves nothing about the write slot, so it must not have
    // cleared the throttle either.
    assert.match(String(captureError(() => withDatabaseTransaction(probe, () => "immediate again")).error), /retry deferred/,
      "a DEFERRED success must not clear a write-mode throttle");
  } finally {
    try { holder.exec("ROLLBACK"); } catch { /* closed below */ }
    holder.close();
    probe.close();
    removeTempDir(root, stateRoot);
  }
});

test("a BEGIN failure that is not contention is neither relabelled nor throttled", () => {
  // Marking every BEGIN error as "busy" turns a programming bug into something a
  // caller will retry forever, and it installs the throttle for an error that has
  // nothing to do with lock contention.
  const database = new KxmDatabaseSync(":memory:");
  try {
    assert.equal(isTransactionContention(new Error("database is locked")), true);
    assert.equal(isTransactionContention(new Error("SQLITE_BUSY: database is busy")), true);
    assert.equal(isTransactionContention(new Error("cannot start a transaction within a transaction")), false);
    assert.equal(isTransactionContention(new Error("no such table: coordinators")), false);

    database.exec("BEGIN IMMEDIATE");
    const caught = captureError(() => withDatabaseTransaction(database, () => 1));
    assert.equal(errorCodeOf(caught.error), undefined, "the original error must survive untranslated");
    assert.match((caught.error as Error).message, /cannot start a transaction within a transaction/);
    assert.doesNotThrow(() => database.exec("COMMIT"), "the outer transaction must still be live and own its own end");

    // No throttle: the helper works the moment the caller's own transaction ends.
    assert.equal(withDatabaseTransaction(database, () => "recovered"), "recovered");
  } finally {
    database.close();
  }
});

test("contention is decided by SQLite's result code, not by whoever quoted a message", () => {
  // Real Node SQLite errors carry `errcode`; the primary code is `code & 0xff`, so
  // the extended forms land on their primaries. Message text is the fallback for a
  // runtime that gives no code, and it must not fire on an error that has one.
  const sqliteError = (errcode: number, errstr: string) =>
    Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });

  assert.equal(isTransactionContention(sqliteError(5, "database is locked")), true, "SQLITE_BUSY");
  assert.equal(isTransactionContention(sqliteError(261, "database is locked (recovery)")), true, "SQLITE_BUSY_RECOVERY");
  // 517 exercises the extended-to-primary arithmetic only. Its real meaning is
  // upgrading an already-open read transaction, so this assertion is not evidence
  // that a fresh `BEGIN IMMEDIATE` can produce it.
  assert.equal(isTransactionContention(sqliteError(517, "database is locked (snapshot)")), true, "SQLITE_BUSY_SNAPSHOT");
  assert.equal(isTransactionContention(sqliteError(6, "database table is locked")), true, "SQLITE_LOCKED");
  assert.equal(isTransactionContention(sqliteError(262, "database schema is locked: main")), true, "SQLITE_LOCKED_SHAREDCACHE");
  assert.equal(isTransactionContention(sqliteError(15, "locking protocol")), true, "SQLITE_PROTOCOL is a retry condition under WAL");

  assert.equal(isTransactionContention(sqliteError(13, "database or disk is full")), false, "SQLITE_FULL is not contention");
  assert.equal(isTransactionContention(sqliteError(14, "unable to open database file")), false, "SQLITE_CANTOPEN is not contention");
  assert.equal(isTransactionContention(sqliteError(8, "attempt to write a readonly database")), false, "SQLITE_READONLY is not contention");
  assert.equal(isTransactionContention(sqliteError(1, "no such table: coordinators")), false);
  // The false positive that message-only matching cannot avoid: a permanent error
  // whose text merely quotes an older busy one.
  assert.equal(isTransactionContention(sqliteError(1, "wrapped: 'database is locked' was the underlying cause")), false);

  // `bun:sqlite` spells the same number `errno` and puts the symbolic name in
  // `code`; a classifier that only reads Node's spelling loses both. Reproduced on
  // Bun 1.3.14 as `errno: 262`, `code: "SQLITE_LOCKED_SHAREDCACHE"`, message
  // "database schema is locked: shared".
  assert.equal(isTransactionContention(Object.assign(new Error("database schema is locked: shared"),
    { code: "SQLITE_LOCKED_SHAREDCACHE", errno: 262 })), true, "bun:sqlite extended code");
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { code: "SQLITE_BUSY", errno: 5 })), true, "bun:sqlite primary code");
  assert.equal(isTransactionContention(Object.assign(new Error("locked"),
    { code: "SQLITE_BUSY_RECOVERY" })), true, "symbolic name with no number");
  // Where a number exists it wins over the text, in both directions: a permanent
  // code carrying a busy-sounding message is not contention, and this is the case
  // that anchored message matching alone would get wrong.
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { code: "SQLITE_FULL", errno: 13 })), false, "a numeric code must not be argued out of by text");
  assert.equal(isTransactionContention(Object.assign(new Error("attempt to write a readonly database"),
    { code: "SQLITE_READONLY", errno: 8 })), false);

  // A result **name** decides with or without a number: the round-6 probe found that
  // a permanent symbolic name fell through to the text fallback, so `SQLITE_FULL`
  // quoting "database is locked" was still called contention.
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { code: "SQLITE_FULL" })), false, "a symbolic permanent code must not lose to message text");
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { name: "SQLITE_CANTOPEN" })), false);
  assert.equal(isTransactionContention(Object.assign(new Error("whatever the message says"),
    { code: "SQLITE_PROTOCOL" })), true, "and a symbolic contention name does not need a number");
  // Node's own error kind is not a SQLite result name, so it stays silent and the
  // message gets its turn.
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { code: "ERR_SQLITE_ERROR" })), true);

  // **Precedence**, not just recognition: agreeing examples prove nothing about the
  // order, so these disagree on purpose. Delete the `errno` lookup and the first one
  // flips; move the symbolic name ahead of the number and the second one flips.
  assert.equal(isTransactionContention(Object.assign(new Error("whatever the text says"),
    { code: "SQLITE_LOCKED_SHAREDCACHE", errno: 5 })), true, "bun's number beats its own name");
  assert.equal(isTransactionContention(Object.assign(new Error("whatever the text says"),
    { code: "SQLITE_BUSY", errno: 13 })), false, "a permanent number beats a busy name");
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { errcode: 13, errno: 5 })), false, "the first integer value in the list decides; `errno` must not override it");
  // The direction the two agreeing fixtures above cannot test: a permanent *name*
  // must not veto a contention *number*. A mutant that checks `SQLITE_FULL` before the
  // numbers and returns false survives every agreeing example.
  assert.equal(isTransactionContention(Object.assign(new Error("text says nothing useful"),
    { errno: 5, code: "SQLITE_FULL" })), true, "a number beats a permanent name");
  assert.equal(isTransactionContention(Object.assign(new Error("text says nothing useful"),
    { errno: 13, code: "SQLITE_BUSY" })), false, "and beats a contention name the other way");

  // The last two directions a field-order mutant survives: which *string* field wins,
  // and whether a zero is a decision or an absence. `SQLITE_OK` is 0, so treating it as
  // "no code here" and falling through to the message would call a success a lock.
  assert.equal(isTransactionContention(Object.assign(new Error("text says nothing useful"),
    { code: "SQLITE_FULL", name: "SQLITE_BUSY" })), false, "a present `code` decides before `name`");
  assert.equal(isTransactionContention(Object.assign(new Error("text says nothing useful"),
    { code: "SQLITE_BUSY", name: "SQLITE_FULL" })), true, "and the first matching name decides");
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { errcode: 0 })), false, "SQLITE_OK is a result, not an absent code");
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { errcode: 0, code: "SQLITE_FULL" })), false, "a zero number still beats the text");
  assert.equal(isTransactionContention(Object.assign(new Error("database is locked"),
    { errcode: 0, code: "SQLITE_BUSY" })), false, "and a zero still beats a contention name");

  // `errCode` had no fixture of its own, so moving or deleting it was untested.
  assert.equal(isTransactionContention(Object.assign(new Error("whatever the text says"),
    { errcode: 13, errCode: 5 })), false, "a present `errcode` decides before `errCode`");
  assert.equal(isTransactionContention(Object.assign(new Error("whatever the text says"),
    { errCode: 13, errno: 5 })), false, "`errCode` outranks `errno`");
  assert.equal(isTransactionContention(Object.assign(new Error("whatever the text says"),
    { errCode: 5, errcode: 13 })), false, "the first integer value in the list decides; a later number is not consulted");
  assert.equal(isTransactionContention(Object.assign(new Error("whatever the text says"),
    { errCode: 5 })), true, "and `errCode` is consulted at all, not merely tolerated");

  // No numeric or symbolic code at all (a plain Error): text decides.
  assert.equal(isTransactionContention(new Error("database is locked")), true);
  assert.equal(isTransactionContention(new Error("database table is locked: coordinators")), true);
  assert.equal(isTransactionContention(new Error("locking protocol")), true);
  assert.equal(isTransactionContention(new Error("nested transactions are not allowed")), false);
  assert.equal(isTransactionContention(new Error("something mentioned database is locked in passing")), false,
    "anchored matching only: quoting a busy message inside other text is not evidence");
  assert.equal(isTransactionContention(undefined), false);
});

test("a transaction that fails at COMMIT still leaves the connection usable", () => {
  // The marker is cleared in `finally`, which is bookkeeping, not proof that
  // SQLite exited the transaction. A deferred foreign key makes COMMIT itself
  // fail, which is the case where that distinction matters.
  const database = new KxmDatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("CREATE TABLE parents (id INTEGER PRIMARY KEY)");
    database.exec("CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)");
    const caught = captureError(() => withDatabaseTransaction(database, () => {
      database.exec("PRAGMA defer_foreign_keys = ON");
      database.prepare("INSERT INTO children (id, parent_id) VALUES (1, 999)").run();
    }));
    assert.match((caught.error as Error).message, /FOREIGN KEY constraint failed|constraint failed/i);
    assert.equal(withDatabaseTransaction(database, () => "usable"), "usable");
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM children").get() as { n: number }).n, 0, "the failed transaction must not be half-applied");
  } finally {
    database.close();
  }
});

test("a lost create race against a legacy-format coordinator stays idempotent", () => {
  // The initial lookup accepts a pre-normalisation row; the read-back after a lost
  // INSERT OR IGNORE asked the same question a second way and used to answer it
  // differently, turning an idempotent bind into coordinator_write_lost.
  const { root, stateRoot, context } = intakeContext("kxm-intake-legacy-race-");
  const legacyEffects = ["zeta", "alpha"];
  const legacyHash = `sha256:${createHash("sha256")
    .update(kxmCanonicalJson({ repositoryAccess: "none", effects: legacyEffects } as unknown as JsonValue), "utf8")
    .digest("hex")}`;
  try {
    const legacyRow = {
      coordinatorId: "crd_legacyrace0000000000000000",
      projectId: context.projectId,
      role: "racer",
      channel: "primary",
      ceilingHash: legacyHash,
      configRevision: legacyHash,
      boundAt: "2026-09-17T00:00:00.000Z",
      record: kxmCanonicalJson({
        schema: "kxm.coordinator.v1",
        coordinatorId: "crd_legacyrace0000000000000000",
        projectId: context.projectId,
        role: "racer",
        channel: "primary",
        authority: { repositoryAccess: "none", effects: legacyEffects },
        boundAt: "2026-09-17T00:00:00.000Z",
        boundBy: { kind: "human", id: "root" },
        configRevision: legacyHash,
        ceilingHash: legacyHash,
      } as unknown as JsonValue),
    };
    assert.notEqual(legacyHash, kxmCeilingHash({ repositoryAccess: "none", effects: legacyEffects }));

    const realInsert = context.eventStore.insertCoordinatorIfAbsent.bind(context.eventStore);
    let loser = false;
    context.eventStore.insertCoordinatorIfAbsent = (row) => {
      if (!loser) {
        // Install the winner the way a competing process would, then run **this**
        // call's insert for real and hand back whatever SQLite says. The `false` is
        // not authored here; `INSERT OR IGNORE` against a taken slot produces it.
        loser = true;
        realInsert(legacyRow);
      }
      return realInsert(row);
    };
    try {
      const bound = bindKxmCoordinator(context, {
        role: "racer",
        authority: { repositoryAccess: "none", effects: legacyEffects },
        actor: OPERATOR,
      });
      assert.equal(bound.created, false, "the loser did not create anything");
      assert.equal(bound.coordinator.coordinatorId, legacyRow.coordinatorId);
    } finally {
      delete (context.eventStore as unknown as { insertCoordinatorIfAbsent?: unknown }).insertCoordinatorIfAbsent;
    }
    // And the slot really is the legacy row: no second identity was minted.
    assert.equal(context.eventStore.coordinatorInSlot(context.projectId, "racer", "primary")?.coordinatorId, legacyRow.coordinatorId);
  } finally {
    closeIntakeContext(context);
    removeTempDir(root, stateRoot);
  }
});

test("a lost rebind write against a legacy-format winner stays idempotent", () => {
  // Same defect shape as the create race, second read-back: the slot lookup saw one
  // row, a third process replaced it with a legacy-fingerprint equivalent, and the
  // rebind's own read-back answered "conflict" to a question the lookup had already
  // answered "equivalent".
  const { root, stateRoot, context } = intakeContext("kxm-intake-legacy-rebind-");
  const legacyEffects = ["zeta", "alpha"];
  const legacyHash = `sha256:${createHash("sha256")
    .update(kxmCanonicalJson({ repositoryAccess: "none", effects: legacyEffects } as unknown as JsonValue), "utf8")
    .digest("hex")}`;
  const legacyId = "crd_legacyrebind000000000000000";
  try {
    const first = bindKxmCoordinator(context, {
      role: "rebound",
      authority: { repositoryAccess: "none", effects: ["alpha", "zeta", "beta"] },
      actor: OPERATOR,
    });
    assert.equal(first.created, true);

    const legacyRow = {
      coordinatorId: legacyId,
      projectId: context.projectId,
      role: "rebound",
      channel: "primary",
      ceilingHash: legacyHash,
      configRevision: legacyHash,
      boundAt: "2026-09-17T00:00:00.000Z",
      record: kxmCanonicalJson({
        schema: "kxm.coordinator.v1",
        coordinatorId: legacyId,
        projectId: context.projectId,
        role: "rebound",
        channel: "primary",
        authority: { repositoryAccess: "none", effects: legacyEffects },
        boundAt: "2026-09-17T00:00:00.000Z",
        boundBy: { kind: "human", id: "root" },
        configRevision: legacyHash,
        ceilingHash: legacyHash,
      } as unknown as JsonValue),
    };
    const store = context.eventStore;
    const realReplace = store.replaceCoordinatorInSlot.bind(store);
    assert.notEqual(legacyHash, kxmCeilingHash({ repositoryAccess: "none", effects: legacyEffects }),
      "the fixture must really be a pre-normalisation fingerprint");
    try {
      store.replaceCoordinatorInSlot = (expectedId, row) => {
        // A competing process installs the legacy equivalent in this exact moment, so
        // our own guarded update — run for real against a slot that no longer holds
        // the row it expected — is what reports the loss.
        realReplace(expectedId, legacyRow);
        return realReplace(expectedId, row);
      };
      const rebound = bindKxmCoordinator(context, {
        role: "rebound",
        authority: { repositoryAccess: "none", effects: ["alpha", "zeta"] },
        actor: OPERATOR,
        rebind: { approvedBy: OPERATOR, reason: "reviewed narrowing" },
      });
      assert.equal(rebound.created, false, "a lost rebind did not create anything");
      assert.equal(rebound.coordinator.coordinatorId, legacyId);
      assert.equal(store.coordinatorInSlot(context.projectId, "rebound", "primary")?.coordinatorId, legacyId);
    } finally {
      delete (store as unknown as { replaceCoordinatorInSlot?: unknown }).replaceCoordinatorInSlot;
    }
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
