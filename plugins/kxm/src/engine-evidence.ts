import { gateDefinitionHash } from "./gate-hash.ts";
import type { KxmRunPlanEnvelope } from "./engine-plan.ts";
import type { KxmRunState } from "./engine-fold.ts";
import { kxmCanonicalJson, type JsonValue } from "./project-config.ts";
import {
  assertClosedGateObservation,
  computeGateEvidenceOutcome,
  gateRowContentHash,
  runtimeError,
  type KxmGateAttemptRow,
  type KxmGateEvidenceRow,
  type KxmGateObservationRow,
  type KxmRunEvent,
  type KxmRunEventStore,
  type KxmRunRecord,
} from "./runtime-store.ts";

export function verifyKxmGateEvidence(
  store: KxmRunEventStore,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  events: readonly KxmRunEvent[],
  state: KxmRunState,
): void {
  const attempts = store.gateAttemptsForRun(run.runId);
  const observations = store.gateObservationsForRun(run.runId);
  const evidence = store.gateEvidenceForRun(run.runId);
  const counts = store.gateRowCounts(run.runId);
  if (counts.attempts !== attempts.length || counts.observations !== observations.length || counts.evidence !== evidence.length) {
    throw runtimeError("gate_evidence_orphan", run.runId, "gate row counts do not match loaded attempt/observation/evidence tuples");
  }
  const attemptById = new Map(attempts.map((row) => [row.attemptId, row]));
  const observationByAttempt = new Map(observations.map((row) => [row.attemptId, row]));
  const evidenceByAttempt = new Map(evidence.map((row) => [row.attemptId, row]));
  const intentEvents = events.filter((event) => event.eventType === "effect.intent_recorded");
  const observedEvents = events.filter((event) => event.eventType === "effect.observed" || event.eventType === "effect.blocked_uncertain");
  const settledEvents = events.filter((event) => event.eventType === "effect.settled");

  for (const event of intentEvents) {
    const attemptId = stringField(event, "attemptId");
    const row = attemptById.get(attemptId);
    if (!row) throw runtimeError("gate_attempt_pin_mismatch", run.runId, `effect.intent_recorded ${event.eventId} has no gate_attempts row`);
    assertAttemptMatchesEvent(run, envelope, state, event, row);
  }

  for (const event of observedEvents) {
    const attemptId = stringField(event, "attemptId");
    const receipt = event.payload.receipt as { id?: unknown; hash?: unknown } | undefined;
    const observationId = typeof receipt?.id === "string" ? receipt.id : undefined;
    const row = observationByAttempt.get(attemptId);
    if (!row || row.observationId !== observationId) {
      throw runtimeError("gate_observation_missing", run.runId, `${event.eventType} has no matching observation row`);
    }
    if (row.recordedEventId !== event.eventId) {
      throw runtimeError("gate_observation_missing", run.runId, "observation recorded_event_id does not match the event");
    }
    if (gateRowContentHash("gate_observations", row) !== row.contentHash) {
      throw runtimeError("gate_evidence_hash_mismatch", run.runId, "observation contentHash does not recompute");
    }
    if (typeof receipt?.hash === "string" && receipt.hash !== row.contentHash) {
      throw runtimeError("gate_evidence_hash_mismatch", run.runId, "observation receipt.hash does not match the row");
    }
    const attempt = attemptById.get(attemptId);
    if (!attempt) throw runtimeError("gate_attempt_pin_mismatch", run.runId, "observation has no gate attempt");
    assertShared(run, row, attempt);
    assertClosedGateObservation(attempt.gateKind, row, row.observationId);
    if (event.eventType === "effect.observed" && row.completeness !== "complete" && row.completeness !== "no-start") {
      throw runtimeError("gate_observation_missing", run.runId, "effect.observed requires complete or no-start completeness");
    }
    if (event.eventType === "effect.blocked_uncertain" && row.completeness !== "incomplete") {
      throw runtimeError("gate_observation_missing", run.runId, "blocked_uncertain requires incomplete completeness");
    }
  }

  for (const event of settledEvents) {
    const attemptId = stringField(event, "attemptId");
    const refs = event.payload.evidenceRefs;
    const evaluated = Array.isArray(refs) && refs.length > 0;
    if (evaluated) {
      const row = evidenceByAttempt.get(attemptId);
      const ref = refs[0] as { id?: unknown; hash?: unknown };
      if (!row || row.evidenceId !== ref.id) {
        throw runtimeError("gate_evidence_missing", run.runId, "effect.settled has no matching evidence row");
      }
      if (row.settledEventId !== event.eventId) {
        throw runtimeError("gate_evidence_missing", run.runId, "evidence settled_event_id does not match the event");
      }
      if (gateRowContentHash("gate_evidence", row) !== row.contentHash || (typeof ref.hash === "string" && ref.hash !== row.contentHash)) {
        throw runtimeError("gate_evidence_hash_mismatch", run.runId, "evidence hash does not recompute");
      }
      if (row.outcome !== event.payload.outcome) {
        throw runtimeError("gate_evidence_hash_mismatch", run.runId, "evidence outcome does not match the settled payload");
      }
      const attempt = attemptById.get(attemptId);
      if (!attempt) throw runtimeError("gate_attempt_pin_mismatch", run.runId, "evidence has no gate attempt");
      assertShared(run, row, attempt);
      if (row.expect !== attempt.expect) {
        throw runtimeError("gate_attempt_pin_mismatch", run.runId, "evidence expect does not match the gate attempt");
      }
      const observation = observationByAttempt.get(attemptId);
      if (!observation || observation.observationId !== row.observationId) {
        throw runtimeError("gate_observation_missing", run.runId, "evidence observation_id does not match the attempt observation");
      }
      const recomputed = computeGateEvidenceOutcome(attempt.gateKind, attempt.expect, observation);
      if (row.outcome !== recomputed || event.payload.outcome !== recomputed) {
        throw runtimeError("gate_evidence_hash_mismatch", run.runId, "evidence outcome does not match the observation and expect");
      }
      const step = envelope.plan.steps[row.stepId];
      const required = step?.requiredEvidence.filter((item) => item.kind === "gate") ?? [];
      const expectedKey = required.length === 1 ? required[0]!.key : null;
      if (row.evidenceKey !== expectedKey) {
        throw runtimeError("gate_evidence_unexpected", run.runId, "evidence_key does not match the declared requiredEvidence key");
      }
    } else {
      if (evidenceByAttempt.has(attemptId)) {
        throw runtimeError("gate_evidence_unexpected", run.runId, "proof-only settlement must not have a gate_evidence row");
      }
      const observation = observationByAttempt.get(attemptId);
      const receipt = event.payload.receipt as { id?: unknown; hash?: unknown } | undefined;
      if (!observation || observation.observationId !== receipt?.id || observation.contentHash !== receipt?.hash) {
        throw runtimeError("gate_observation_missing", run.runId, "proof-only settlement does not bind the observation");
      }
    }
  }

  const namedAttemptIds = new Set(intentEvents.map((event) => stringField(event, "attemptId")));
  for (const row of attempts) {
    if (!namedAttemptIds.has(row.attemptId)) {
      throw runtimeError("gate_evidence_orphan", run.runId, `gate_attempts row ${row.attemptId} is not named by effect.intent_recorded`);
    }
    if (row.runId !== run.runId) throw runtimeError("gate_evidence_orphan", run.runId, "gate attempt belongs to a foreign run");
    if (gateRowContentHash("gate_attempts", row) !== row.contentHash) {
      throw runtimeError("gate_evidence_hash_mismatch", run.runId, "gate attempt contentHash does not recompute");
    }
  }
  for (const row of observations) {
    if (!attemptById.has(row.attemptId)) {
      throw runtimeError("gate_evidence_orphan", run.runId, `observation ${row.observationId} is owned by this run but names a foreign attempt`);
    }
    const event = events.find((item) => item.eventId === row.recordedEventId);
    if (!event || (event.eventType !== "effect.observed" && event.eventType !== "effect.blocked_uncertain")) {
      throw runtimeError("gate_evidence_orphan", run.runId, `observation ${row.observationId} is not named by an observation event`);
    }
    if (stringField(event, "attemptId") !== row.attemptId) {
      throw runtimeError("gate_evidence_orphan", run.runId, `observation ${row.observationId} is not named by this attempt's observation event`);
    }
    const attempt = attemptById.get(row.attemptId)!;
    assertShared(run, row, attempt);
    assertClosedGateObservation(attempt.gateKind, row, row.observationId);
  }
  for (const row of evidence) {
    if (!attemptById.has(row.attemptId)) {
      throw runtimeError("gate_evidence_orphan", run.runId, `evidence ${row.evidenceId} is owned by this run but names a foreign attempt`);
    }
    const event = events.find((item) => item.eventId === row.settledEventId);
    if (!event || event.eventType !== "effect.settled") {
      throw runtimeError("gate_evidence_orphan", run.runId, `evidence ${row.evidenceId} is not named by effect.settled`);
    }
    if (stringField(event, "attemptId") !== row.attemptId) {
      throw runtimeError("gate_evidence_orphan", run.runId, `evidence ${row.evidenceId} is not named by this attempt's settled event`);
    }
    const refs = event.payload.evidenceRefs;
    if (!Array.isArray(refs) || refs.length !== 1 || (refs[0] as { id?: unknown }).id !== row.evidenceId) {
      throw runtimeError("gate_evidence_orphan", run.runId, "evidence row is not the payload evidenceRef");
    }
    const attempt = attemptById.get(row.attemptId)!;
    assertShared(run, row, attempt);
    if (row.expect !== attempt.expect) {
      throw runtimeError("gate_attempt_pin_mismatch", run.runId, "evidence expect does not match the gate attempt");
    }
  }

  if (attempts.length !== intentEvents.length) {
    throw runtimeError("gate_evidence_orphan", run.runId, "gate attempt count does not match intent events");
  }
  if (observations.length !== observedEvents.length) {
    throw runtimeError("gate_observation_missing", run.runId, "observation count does not match observation events");
  }

  const lastEffect = lastEffectByAttempt(events);
  for (const [attemptId, last] of lastEffect) {
    const evidenceRow = evidenceByAttempt.get(attemptId);
    if (last === "effect.settled") {
      const settled = settledEvents.filter((event) => stringField(event, "attemptId") === attemptId).at(-1);
      const evaluated = Array.isArray(settled?.payload.evidenceRefs) && (settled!.payload.evidenceRefs as unknown[]).length > 0;
      if (evaluated && !evidenceRow) throw runtimeError("gate_evidence_missing", run.runId, "evaluated settlement is missing evidence");
      if (!evaluated && evidenceRow) throw runtimeError("gate_evidence_unexpected", run.runId, "proof-only settlement has evidence");
      const capability = store.capabilityByAttempt(attemptId);
      if (evaluated && capability?.state === "issued") {
        throw runtimeError("gate_evidence_unexpected", run.runId, "settled attempt still has issued capability");
      }
    } else if (evidenceRow) {
      throw runtimeError("gate_evidence_unexpected", run.runId, "non-settled attempt has evidence");
    }
  }
  void kxmCanonicalJson;
}

function lastEffectByAttempt(events: readonly KxmRunEvent[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const event of events) {
    if (!event.eventType.startsWith("effect.")) continue;
    const attemptId = event.payload.attemptId;
    if (typeof attemptId === "string") last.set(attemptId, event.eventType);
  }
  return last;
}

function assertAttemptMatchesEvent(
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  state: KxmRunState,
  event: KxmRunEvent,
  row: KxmGateAttemptRow,
): void {
  const effectId = (event.payload.effect as { id?: unknown } | undefined)?.id;
  if (row.effectId !== effectId || row.intentEventId !== event.eventId) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "intent event does not match the gate attempt");
  }
  if (row.runId !== run.runId || row.projectId !== run.projectId || row.homeRuntimeId !== run.homeRuntimeId) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "gate attempt owner does not match the run");
  }
  if (row.stepId !== event.payload.stepId || row.stepAttempt !== event.payload.stepAttempt || row.assignmentId !== event.payload.assignmentId || row.attemptId !== event.payload.attemptId) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "gate attempt identity does not match the intent payload");
  }
  const step = envelope.plan.steps[row.stepId];
  if (!step || step.kind !== "gate") {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "gate attempt step is not a gate");
  }
  if (row.gateId !== step.gate || row.expect !== step.expect) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "gate attempt gate/expect do not match the plan");
  }
  const definition = envelope.gates.definitions[step.gate];
  if (!definition || definition.kind !== row.gateKind) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "gate attempt kind does not match the pinned definition");
  }
  const expectedDefinitionHash = gateDefinitionHash(step.gate, definition as unknown as JsonValue);
  if (row.gateDefinitionHash !== expectedDefinitionHash) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "gate_definition_hash does not match the pinned definition");
  }
  if (!envelope.gates.registry || row.registryHash !== envelope.gates.registry.hash) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "registry_hash does not match the pinned registry");
  }
  const planRowHash = envelope && state.runPlanHash;
  if (row.runPlanHash !== planRowHash) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "run_plan_hash does not match the pinned plan");
  }
  if (row.controlProjectKey !== envelope.gates.controlRoot.projectKey) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "control_project_key does not match the envelope");
  }
}

function assertShared(run: KxmRunRecord, row: KxmGateObservationRow | KxmGateEvidenceRow, attempt: KxmGateAttemptRow): void {
  if (
    row.runId !== attempt.runId
    || row.projectId !== attempt.projectId
    || row.homeRuntimeId !== attempt.homeRuntimeId
    || row.stepId !== attempt.stepId
    || row.stepAttempt !== attempt.stepAttempt
    || row.assignmentId !== attempt.assignmentId
    || row.effectId !== attempt.effectId
  ) {
    throw runtimeError("gate_attempt_pin_mismatch", run.runId, "row identity does not match the gate attempt");
  }
}

function stringField(event: KxmRunEvent, field: string): string {
  const value = event.payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw runtimeError("gate_attempt_pin_mismatch", event.runId, `${event.eventType} is missing ${field}`);
  }
  return value;
}
