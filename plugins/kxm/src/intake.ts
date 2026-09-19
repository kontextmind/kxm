/**
 * KXM Runtime intake contract (unified plan M1 + M6, the durable part of M2).
 *
 * One persistent, project-scoped coordinator identity carries an authority
 * ceiling; internal messages arrive against that identity with an idempotency
 * key; and a project pause blocks *fresh dispatch* without losing the intent.
 * These are separate facts and are recorded separately: received, persisted,
 * and dispatch-ready each have their own state.
 *
 * Nothing here opens a model, a peer session, or an HTTP surface. The Runtime is
 * the only writer, and adapters that later expose this must stay thin over it.
 * Until they exist, no control is advertised — which is the honest M0 answer:
 * unintegrated capability is unavailable, never a success-shaped stub.
 */

import { createHash } from "node:crypto";
import { newId } from "./protocol.ts";
import {
  kxmCanonicalJson,
  validateCoordinator,
  validateIntakeMessage,
  type JsonValue,
} from "./project-config.ts";
import type { KxmRuntimeContext } from "./runtime-service.ts";
import { runtimeError, type KxmIntakeMessageRow, type KxmProjectControlRow } from "./runtime-store.ts";

/** Largest intake payload we are willing to hash and persist, in bytes. */
export const MAX_INTAKE_CONTENT_BYTES = 16_384;

export type KxmIntakeClassification = "public" | "project" | "sensitive" | "secret";
export type KxmIntakeDispatchState = "ready" | "held_paused" | "admitted" | "refused";
export type KxmIntakeSourceKind = "adapter" | "hub" | "operator" | "peer" | "schedule";

export interface KxmCoordinatorAuthority {
  repositoryAccess: "none" | "read" | "write";
  effects: readonly string[];
  tools?: {
    preset?: string;
    allow?: readonly string[];
    deny?: readonly string[];
  };
}

export interface KxmCoordinatorRecord {
  schema: "kxm.coordinator.v1";
  coordinatorId: string;
  projectId: string;
  role: string;
  channel: string;
  authority: KxmCoordinatorAuthority;
  boundAt: string;
  boundBy: { kind: "human" | "runtime" | "hub" | "agent" | "adapter"; id: string };
  configRevision: string;
  ceilingHash: string;
  rebindOf?: string;
  rebindReason?: string;
}

export interface KxmIntakeMessage {
  schema: "kxm.intake-message.v1";
  messageId: string;
  projectId: string;
  coordinatorId: string;
  receivedAt: string;
  source: { kind: KxmIntakeSourceKind; id: string };
  idempotencyKey: string;
  contentHash: string;
  content?: string;
  contentOmittedReason?: "secret-classified";
  classification: KxmIntakeClassification;
  dispatch: {
    state: KxmIntakeDispatchState;
    reason?: string;
    updatedAt?: string;
    runId?: string;
  };
}

/** The persisted shape behind the project-control columns. */
interface KxmProjectControlRecord {
  schema: "kxm.project-control.v1";
  projectId: string;
  paused: boolean;
  reason?: string;
  updatedAt: string;
  actor: string;
}

const ACCESS_ORDER: Record<KxmCoordinatorAuthority["repositoryAccess"], number> = {
  none: 0,
  read: 1,
  write: 2,
};

const IDENTIFIER_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const COORDINATOR_ID_RE = /^[a-z][a-z0-9]{1,15}_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
const ACTOR_ID_RE = /^.{1,200}$/;

/** Canonical SHA-256 over the authority ceiling — the coordinator's fingerprint. */
export function kxmCeilingHash(authority: KxmCoordinatorAuthority): string {
  return `sha256:${createHash("sha256").update(stableStringify(normalizeAuthority(authority)), "utf8").digest("hex")}`;
}

/**
 * Does an already-stored coordinator express this ceiling?
 *
 * A row written before set normalisation existed carries a fingerprint that
 * `kxmCeilingHash` no longer reproduces, so comparing the stored hash alone is
 * not enough: recompute over the authority it kept. Every path that asks this
 * question — the initial slot lookup and **both** lost-write read-backs — must
 * go through here, or an upgrade makes the same row equivalent on lookup and a
 * `coordinator_write_lost` conflict on the race path.
 *
 * A legacy row is returned as stored, so its `ceilingHash` is historical: a
 * caller must not assume every persisted hash uses today's algorithm.
 */
function ceilingsMatch(stored: KxmCoordinatorRecord, ceilingHash: string): boolean {
  return stored.ceilingHash === ceilingHash || kxmCeilingHash(stored.authority) === ceilingHash;
}

function normalizeAuthority(authority: KxmCoordinatorAuthority): KxmCoordinatorAuthority {
  const tools = authority.tools;
  return {
    repositoryAccess: authority.repositoryAccess,
    effects: canonicalSet(authority.effects ?? []),
    ...(tools !== undefined
      ? {
          tools: {
            ...(tools.preset !== undefined ? { preset: tools.preset } : {}),
            ...(tools.allow !== undefined ? { allow: canonicalSet(tools.allow) } : {}),
            ...(tools.deny !== undefined ? { deny: canonicalSet(tools.deny) } : {}),
          },
        }
      : {}),
  };
}

function canonicalSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Bind the coordinator for a (project, role, channel) slot. Binding is
 * create-once and idempotent: presenting the same ceiling again returns the
 * existing identity rather than minting a second one.
 *
 * A different ceiling is a **rebind** and needs explicit policy; it may narrow
 * the ceiling but never widen it, because a message or a model swap must not be
 * able to grow authority.
 */
export function bindKxmCoordinator(
  context: KxmRuntimeContext,
  input: {
    role: string;
    channel?: string;
    authority: KxmCoordinatorAuthority;
    actor: { kind: KxmCoordinatorRecord["boundBy"]["kind"]; id: string };
    now?: string;
    rebind?: { approvedBy: { kind: KxmCoordinatorRecord["boundBy"]["kind"]; id: string }; reason: string };
  },
): { coordinator: KxmCoordinatorRecord; created: boolean } {
  const role = requireIdentifier(input.role, "role");
  const channel = requireIdentifier(input.channel ?? "primary", "channel");
  const authority = validateAuthority(input.authority);
  const actor = validateActor(input.actor, "actor");
  const now = requireTimestamp(input.now ?? new Date().toISOString(), "now");
  const ceilingHash = kxmCeilingHash(authority);
  const existing = context.eventStore.coordinatorInSlot(context.projectId, role, channel);

  if (existing) {
    const current = JSON.parse(existing.record) as KxmCoordinatorRecord;
    if (ceilingsMatch(current, ceilingHash)) {
      return { coordinator: current, created: false };
    }
    if (!input.rebind) {
      throw runtimeError(
        "coordinator_rebind_requires_policy",
        existing.coordinatorId,
        `coordinator for role ${role}/${channel} is already bound with a different ceiling; rebinding needs explicit policy`,
      );
    }
    assertCeilingNotWidened(current.authority, authority, existing.coordinatorId);
    const reason = requireText(input.rebind.reason, "rebind.reason", 512);
    const record: KxmCoordinatorRecord = {
      schema: "kxm.coordinator.v1",
      coordinatorId: newId("crd"),
      projectId: context.projectId,
      role,
      channel,
      authority,
      boundAt: now,
      boundBy: validateActor(input.rebind.approvedBy, "rebind.approvedBy"),
      configRevision: current.configRevision,
      ceilingHash,
      rebindOf: existing.coordinatorId,
      rebindReason: reason,
    };
    validateCoordinator(record, record.coordinatorId);
    const replaced = context.eventStore.replaceCoordinatorInSlot(existing.coordinatorId, {
      coordinatorId: record.coordinatorId,
      projectId: record.projectId,
      role: record.role,
      channel: record.channel,
      ceilingHash: record.ceilingHash,
      configRevision: record.configRevision,
      boundAt: record.boundAt,
      record: kxmCanonicalJson(record as unknown as JsonValue),
    });
    if (!replaced) {
      // Another process reached the same ceiling first. Return its identity when it
      // is the ceiling we asked for; anything else is a real conflict.
      const winner = context.eventStore.coordinatorInSlot(context.projectId, role, channel);
      const record2 = winner ? (JSON.parse(winner.record) as KxmCoordinatorRecord) : undefined;
      if (record2 && ceilingsMatch(record2, ceilingHash)) {
        return { coordinator: record2, created: false };
      }
      throw runtimeError("coordinator_write_lost", existing.coordinatorId, "the coordinator slot changed underneath this rebind");
    }
    return { coordinator: record, created: true };
  }

  if (input.rebind) {
    throw runtimeError("coordinator_rebind_without_subject", role, "there is no bound coordinator to rebind");
  }
  const record: KxmCoordinatorRecord = {
    schema: "kxm.coordinator.v1",
    coordinatorId: newId("crd"),
    projectId: context.projectId,
    role,
    channel,
    authority,
    boundAt: now,
    boundBy: actor,
    configRevision: context.configRevision,
    ceilingHash,
  };
  return persistCoordinator(context, record);
}

/** Resolve a coordinator by id; unknown identity fails closed. */
export function resolveKxmCoordinator(context: KxmRuntimeContext, coordinatorId: string): KxmCoordinatorRecord {
  const row = context.eventStore.coordinatorById(requireText(coordinatorId, "coordinatorId", 144));
  if (!row) throw runtimeError("coordinator_unknown", coordinatorId, "no coordinator is bound in this project");
  return JSON.parse(row.record) as KxmCoordinatorRecord;
}

/**
 * Accept one internal message at the intake boundary.
 *
 * Duplicate ingress (same idempotency key, same content) returns the original
 * record and cannot create another task. The same key with **different** content
 * is rejected: a reused key must not smuggle a different payload. Payloads
 * classified `secret` are never persisted — only their hash, so intake cannot
 * become a secret store. While the project is paused the message is durable with
 * a held dispatch intent instead of being dropped.
 */
export function acceptKxmIntakeMessage(
  context: KxmRuntimeContext,
  input: {
    coordinatorId: string;
    idempotencyKey: string;
    content: string;
    classification?: KxmIntakeClassification;
    source: { kind: KxmIntakeSourceKind; id: string };
    now?: string;
  },
): { message: KxmIntakeMessage; duplicate: boolean } {
  const coordinator = resolveKxmCoordinator(context, input.coordinatorId);
  const key = requireText(input.idempotencyKey, "idempotencyKey", 200);
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw runtimeError("intake_content_missing", coordinator.coordinatorId, "intake content must be a non-empty string");
  }
  const classification = input.classification ?? "project";
  if (!["public", "project", "sensitive", "secret"].includes(classification)) {
    throw runtimeError("intake_classification_invalid", coordinator.coordinatorId, `unknown intake classification ${classification}`);
  }
  const sourceKind = input.source?.kind;
  if (!["adapter", "hub", "operator", "peer", "schedule"].includes(String(sourceKind))) {
    throw runtimeError("intake_source_invalid", coordinator.coordinatorId, `unknown intake source kind ${String(sourceKind)}`);
  }
  const sourceId = requireText(input.source.id, "source.id", 200);
  const now = requireTimestamp(input.now ?? new Date().toISOString(), "now");
  const bytes = Buffer.byteLength(input.content, "utf8");
  const contentHash = `sha256:${createHash("sha256").update(input.content, "utf8").digest("hex")}`;

  // One transaction covers the slot probe, the pause read and the write, so a
  // concurrent resume cannot strand this row in an unpaused project and a racing
  // writer with different content cannot be mistaken for a duplicate.
  return context.eventStore.transaction(() => {
    const existingRow = context.eventStore.intakeBySlot(context.projectId, coordinator.coordinatorId, key);
    if (existingRow) {
      return { message: requireSamePayload(existingRow, contentHash, classification, key), duplicate: true };
    }

    if (bytes > MAX_INTAKE_CONTENT_BYTES) {
      throw runtimeError(
        "intake_content_too_large",
        coordinator.coordinatorId,
        `intake content is ${bytes} bytes; the limit is ${MAX_INTAKE_CONTENT_BYTES}`,
      );
    }

    // Only secrets are withheld, and that guarantee is about *this layer's* storage
    // decision: classification is supplied by the caller, so an untrusted adapter
    // can still label a credential "project" and have it persisted here. Widening
    // this to detection is a separate, reviewed slice.
    const persistContent = classification !== "secret";
    const paused = isKxmProjectPaused(context);
    const message: KxmIntakeMessage = {
      schema: "kxm.intake-message.v1",
      messageId: newId("msg"),
      projectId: context.projectId,
      coordinatorId: coordinator.coordinatorId,
      receivedAt: now,
      source: { kind: sourceKind, id: sourceId },
      idempotencyKey: key,
      contentHash,
      ...(persistContent ? { content: input.content } : { contentOmittedReason: "secret-classified" as const }),
      classification,
      dispatch: paused
        ? { state: "held_paused", reason: "project_paused", updatedAt: now }
        : { state: "ready" },
    };
    validateIntakeMessage(message, message.messageId);

    const inserted = context.eventStore.insertIntakeMessageIfAbsent({
      messageId: message.messageId,
      projectId: message.projectId,
      coordinatorId: message.coordinatorId,
      idempotencyKey: message.idempotencyKey,
      contentHash: message.contentHash,
      receivedAt: message.receivedAt,
      dispatchState: message.dispatch.state,
      record: kxmCanonicalJson(message as unknown as JsonValue),
    });
    if (!inserted) {
      // Lost the race for the slot. The winner is only a duplicate if it carried
      // the same content; anything else is the same conflict we refuse serially.
      const winner = context.eventStore.intakeBySlot(context.projectId, coordinator.coordinatorId, key);
      if (!winner) throw runtimeError("intake_write_lost", coordinator.coordinatorId, "intake write lost its slot and left no record");
      return { message: requireSamePayload(winner, contentHash, classification, key), duplicate: true };
    }
    return { message, duplicate: false };
  });
}

function requireSamePayload(
  row: { record: string },
  contentHash: string,
  classification: KxmIntakeClassification,
  key: string,
): KxmIntakeMessage {
  const message = JSON.parse(row.record) as KxmIntakeMessage;
  if (message.contentHash !== contentHash) {
    throw runtimeError(
      "intake_payload_conflict",
      message.messageId,
      `idempotency key ${key} was already used with different content`,
    );
  }
  // Re-labelling the same payload is not a no-op: a retry marked `secret` must not
  // quietly hand back a stored plaintext record, and a retry marked `project` must
  // not launder a row that was withheld.
  if (message.classification !== classification) {
    throw runtimeError(
      "intake_classification_conflict",
      message.messageId,
      `idempotency key ${key} was already recorded as ${message.classification}, not ${classification}`,
    );
  }
  return message;
}

/** Pending intake that may be dispatched, oldest first. Empty while paused. */
export function listKxmDispatchableIntake(context: KxmRuntimeContext, limit = 50): KxmIntakeMessage[] {
  if (isKxmProjectPaused(context)) return [];
  return context.eventStore
    .intakeInStates(context.projectId, ["ready"], limit)
    .map((row) => JSON.parse(row.record) as KxmIntakeMessage);
}

/**
 * Bind a ready message to its run. Admission is idempotent for the same run and
 * refuses a second one, so duplicate ingress cannot create another task. While
 * paused, nothing may be admitted at all.
 */
export function admitKxmIntakeRun(
  context: KxmRuntimeContext,
  messageId: string,
  input: { runId: string; now?: string },
): KxmIntakeMessage {
  const id = requireText(messageId, "messageId", 144);
  const runId = requireText(input.runId, "runId", 144);
  if (!COORDINATOR_ID_RE.test(runId)) throw runtimeError("intake_run_id_invalid", id, "runId is not a well-formed opaque id");
  const now = requireTimestamp(input.now ?? new Date().toISOString(), "now");
  // The pause read, the state read and the guarded transition commit together, so
  // a pause cannot slip in between "not paused" and "admitted".
  return context.eventStore.transaction(() => {
    if (isKxmProjectPaused(context)) {
      throw runtimeError("intake_paused", id, "the project is paused; no fresh dispatch may be admitted");
    }
    const row = context.eventStore.intakeMessage(id);
    if (!row) throw runtimeError("intake_message_unknown", id, "no such intake message in this project");
    const message = JSON.parse(row.record) as KxmIntakeMessage;
    if (message.dispatch.state === "admitted") {
      if (message.dispatch.runId === runId) return message;
      throw runtimeError("intake_second_admission", id, `message already admitted as ${message.dispatch.runId}`);
    }
    if (message.dispatch.state !== "ready") {
      throw runtimeError("intake_not_dispatchable", id, `intake state ${message.dispatch.state} cannot be admitted`);
    }
    const next: KxmIntakeMessage = { ...message, dispatch: { state: "admitted", runId, updatedAt: now } };
    validateIntakeMessage(next, next.messageId);
    const updated = context.eventStore.updateIntakeDispatch(id, "ready", { state: "admitted", record: kxmCanonicalJson(next as unknown as JsonValue) });
    if (!updated) {
      const racer = context.eventStore.intakeMessage(id);
      const current = racer ? (JSON.parse(racer.record) as KxmIntakeMessage) : undefined;
      if (current?.dispatch.state === "admitted" && current.dispatch.runId === runId) return current;
      throw runtimeError("intake_dispatch_race", id, "the intake record changed underneath this admission");
    }
    return next;
  });
}

/**
 * Pause or resume intake dispatch for the project. Pausing does not cancel work
 * that is already admitted; it stops fresh dispatch and holds the intent. A
 * message that arrives *during* the pause is stored as `held_paused`, and a
 * resume releases exactly those, in received order. Messages that were already
 * `ready` stay ready — pause blocks the dispatch decision, not the record — so
 * nothing is lost or duplicated across the pause window either way.
 */
export function setKxmProjectPause(
  context: KxmRuntimeContext,
  input: { paused: boolean; actor: { kind: KxmCoordinatorRecord["boundBy"]["kind"]; id: string }; reason?: string; now?: string },
): { control: KxmProjectControlRow; released: KxmIntakeMessage[] } {
  const actor = validateActor(input.actor, "actor");
  const now = requireTimestamp(input.now ?? new Date().toISOString(), "now");
  const reason = input.reason === undefined ? undefined : requireText(input.reason, "reason", 512);
  const record: KxmProjectControlRecord = {
    schema: "kxm.project-control.v1",
    projectId: context.projectId,
    paused: input.paused,
    ...(reason !== undefined ? { reason } : {}),
    updatedAt: now,
    actor: `${actor.kind}:${actor.id}`,
  };
  const control: KxmProjectControlRow = {
    projectId: context.projectId,
    paused: input.paused,
    ...(reason !== undefined ? { reason } : {}),
    updatedAt: now,
    actor: record.actor,
    record: kxmCanonicalJson(record as unknown as JsonValue),
  };
  // Control write and the held-intent release are one transaction: a crash leaves
  // either a paused project with held rows, or a resumed project with none.
  return context.eventStore.transaction(() => {
    context.eventStore.putProjectControl(control);
    const released = input.paused ? [] : releaseHeldIntake(context, now);
    return { control, released };
  });
}

/** Whether fresh dispatch is currently blocked for this project. */
export function isKxmProjectPaused(context: KxmRuntimeContext): boolean {
  return context.eventStore.projectControl(context.projectId)?.paused === true;
}

/** How many held rows one drain page reads. Bounds a page, not the whole drain. */
const INTAKE_DRAIN_PAGE_ROWS = 500;

function releaseHeldIntake(context: KxmRuntimeContext, now: string): KxmIntakeMessage[] {
  const released: KxmIntakeMessage[] = [];
  // Drain every held row. A paging loop, not a single capped page: stranding the
  // 501st message behind a "resume releases held intent" claim is a lie of omission.
  //
  // What is still true after that fix: the loop holds one write transaction and
  // retains every released message, so total work and memory grow with the held
  // backlog even though each read is bounded. Measured on an in-memory store: 150k
  // held rows with 64-byte payloads took 4.5 s synchronously and ~95 MiB of heap;
  // 500k maximum-size payloads would retain ~7.6 GiB before any database overhead,
  // and an allocation failure will not reliably arrive as `intake_drain_stalled`.
  // Resume is finite because the write lock keeps ingress out of the loop, so this
  // is a throughput and memory limit, not a correctness hole. Bounding it is a
  // pre-condition of M2 sustained traffic, not of this contract — see "Still open".
  for (;;) {
    const held = context.eventStore.intakeInStates(context.projectId, ["held_paused"], INTAKE_DRAIN_PAGE_ROWS);
    if (held.length === 0) return released;
    let progressed = false;
    for (const row of held) {
      const message = JSON.parse(row.record) as KxmIntakeMessage;
      const next: KxmIntakeMessage = { ...message, dispatch: { state: "ready", updatedAt: now } };
      validateIntakeMessage(next, next.messageId);
      if (context.eventStore.updateIntakeDispatch(row.messageId, "held_paused", { state: "ready", record: kxmCanonicalJson(next as unknown as JsonValue) })) {
        released.push(next);
        progressed = true;
      }
    }
    if (!progressed) {
      // Cannot move anything: fail loudly inside the caller's transaction, which
      // rolls the resume back, rather than half-resuming and leaving rows held.
      throw runtimeError("intake_drain_stalled", context.projectId, `held intake did not drain; ${String(held.length)} row(s) still held`);
    }
  }
}

function persistCoordinator(context: KxmRuntimeContext, record: KxmCoordinatorRecord): { coordinator: KxmCoordinatorRecord; created: boolean } {
  validateCoordinator(record, record.coordinatorId);
  const inserted = context.eventStore.insertCoordinatorIfAbsent({
    coordinatorId: record.coordinatorId,
    projectId: record.projectId,
    role: record.role,
    channel: record.channel,
    ceilingHash: record.ceilingHash,
    configRevision: record.configRevision,
    boundAt: record.boundAt,
    record: kxmCanonicalJson(record as unknown as JsonValue),
  });
  if (inserted) return { coordinator: record, created: true };
  // Lost the race for an empty slot: binding is create-once, so the winner is the
  // answer whenever it reached the same ceiling. Only a different ceiling is a
  // conflict worth reporting. The loser must not report that it created anything.
  const winner = context.eventStore.coordinatorInSlot(record.projectId, record.role, record.channel);
  const won = winner ? (JSON.parse(winner.record) as KxmCoordinatorRecord) : undefined;
  if (won && ceilingsMatch(won, record.ceilingHash)) return { coordinator: won, created: false };
  throw runtimeError("coordinator_write_lost", record.coordinatorId, "the coordinator slot was claimed by a different ceiling");
}

function assertCeilingNotWidened(
  previous: KxmCoordinatorAuthority,
  next: KxmCoordinatorAuthority,
  coordinatorId: string,
): void {
  if (ACCESS_ORDER[next.repositoryAccess] > ACCESS_ORDER[previous.repositoryAccess]) {
    throw runtimeError("coordinator_rebind_widens_access", coordinatorId, "a rebind may not widen repository access");
  }
  const had = new Set(previous.effects);
  const added = next.effects.filter((effect) => !had.has(effect));
  if (added.length > 0) {
    throw runtimeError("coordinator_rebind_widens_effects", coordinatorId, `a rebind may not add effects: ${added.join(", ")}`);
  }
  // Tool ceilings are only narrowing-safe if every restriction is checked. An
  // omitted list or a changed preset can select a broader default, so those moves
  // are refused outright until their semantics are defined here.
  if ((previous.tools === undefined) !== (next.tools === undefined)) {
    throw runtimeError("coordinator_rebind_widens_tools", coordinatorId, "a rebind may not add or remove the tool policy");
  }
  if (previous.tools && next.tools) {
    const previousTools = previous.tools;
    const nextTools = next.tools;
    if (previousTools.preset !== nextTools.preset) {
      throw runtimeError("coordinator_rebind_changes_preset", coordinatorId, "a rebind may not change the tool preset; its default is not defined here");
    }
    const allowedBefore = new Set(previousTools.allow ?? []);
    const newlyAllowed = (nextTools.allow ?? []).filter((tool) => !allowedBefore.has(tool));
    if (newlyAllowed.length > 0) {
      throw runtimeError("coordinator_rebind_widens_tools", coordinatorId, `a rebind may not allow new tools: ${newlyAllowed.join(", ")}`);
    }
    // Tool evaluation applies no allowlist restriction when the list is empty or
    // absent (`commands.ts` gates only on a non-empty allow list), so dropping a
    // populated list is a widening even though every entry it named is gone.
    if (allowedBefore.size > 0 && (nextTools.allow ?? []).length === 0) {
      throw runtimeError("coordinator_rebind_clears_allowlist", coordinatorId, "a rebind may not drop or empty a populated allow list; an absent allow list imposes no restriction");
    }
    const deniedBefore = new Set(previousTools.deny ?? []);
    const undenied = [...deniedBefore].filter((tool) => !(nextTools.deny ?? []).includes(tool));
    if (undenied.length > 0) {
      throw runtimeError("coordinator_rebind_removes_denials", coordinatorId, `a rebind may not lift denials: ${undenied.join(", ")}`);
    }
  }
}

function validateAuthority(authority: KxmCoordinatorAuthority): KxmCoordinatorAuthority {
  if (!authority || typeof authority !== "object") {
    throw runtimeError("coordinator_authority_invalid", "authority", "authority must be an object");
  }
  if (!(authority.repositoryAccess in ACCESS_ORDER)) {
    throw runtimeError("coordinator_authority_invalid", "repositoryAccess", "repositoryAccess must be none, read or write");
  }
  if (!Array.isArray(authority.effects)) {
    throw runtimeError("coordinator_authority_invalid", "effects", "effects must be an array of identifiers");
  }
  const effects = authority.effects.map((effect) => requireIdentifier(effect, "effects[]"));
  if (new Set(effects).size !== effects.length) {
    throw runtimeError("coordinator_authority_invalid", "effects", "effects must not repeat");
  }
  if (effects.length > 64) {
    throw runtimeError("coordinator_authority_invalid", "effects", "effects may not exceed 64 entries");
  }
  const tools = authority.tools;
  if (tools !== undefined) {
    const lists = [tools.allow ?? [], tools.deny ?? []];
    for (const list of lists) {
      for (const tool of list) requireIdentifier(tool, "tools");
      if (new Set(list).size !== list.length) {
        throw runtimeError("coordinator_authority_invalid", "tools", "tool lists must not repeat");
      }
    }
    if (tools.preset !== undefined) requireIdentifier(tools.preset, "tools.preset");
  }
  // Sets are stored canonically: order and repeats carry no authority, and leaving
  // them as supplied would let an equivalent ceiling masquerade as a rebind.
  return normalizeAuthority(authority);
}


function validateActor<T extends { kind: KxmCoordinatorRecord["boundBy"]["kind"]; id: string }>(actor: T, field: string): T {
  const kinds: string[] = ["human", "runtime", "hub", "agent", "adapter"];
  if (!actor || typeof actor !== "object" || !kinds.includes(actor.kind)) {
    throw runtimeError("coordinator_actor_invalid", field, "actor kind must be one of " + kinds.join(", "));
  }
  const id = requireText(actor.id, `${field}.id`, 200);
  if (!ACTOR_ID_RE.test(id)) throw runtimeError("coordinator_actor_invalid", `${field}.id`, "actor id is out of bounds");
  return { ...actor, id };
}

function requireIdentifier(value: string, field: string): string {
  const text = requireText(value, field, 64);
  if (!IDENTIFIER_RE.test(text)) {
    throw runtimeError("coordinator_identifier_invalid", field, `${text} is not a kebab/snake identifier`);
  }
  return text;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw runtimeError("intake_field_invalid", field, `${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > max) throw runtimeError("intake_field_invalid", field, `${field} exceeds ${max} characters`);
  return text;
}

function requireTimestamp(value: string, field: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value)) {
    throw runtimeError("intake_field_invalid", field, `${field} must be an ISO8601 UTC timestamp`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw runtimeError("intake_field_invalid", field, `${field} is not a real timestamp`);
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortDeep(child);
    }
    return out;
  }
  return value;
}
