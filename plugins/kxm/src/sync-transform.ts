import { createHash } from "node:crypto";
import { KxmConfigError, kxmCanonicalJson, syncEventSchemaErrors, type JsonValue } from "./project-config.ts";
import { redactSecrets } from "./redact.ts";
import type { KxmRunEvent } from "./runtime-store.ts";

/*
 * Runtime → hub sync transform (`docs/contracts/synchronization.md`).
 *
 * A local run event never reaches the outbox. This module builds a new
 * `kxm.sync-event.v1` object from it: pick allowlisted fields, rebuild every
 * nested record key by key, replace registered secret values and credential
 * shapes, strip absolute paths and control characters, bound text, then
 * validate the result. Anything the allowlist does not name is dropped and
 * recorded by name in `redaction.fieldsOmitted`; its value goes nowhere.
 */

export const KXM_SYNC_EVENT_SCHEMA = "kxm.sync-event.v1";
export const KXM_SYNC_REDACTOR_VERSION = "redactor-v1";

/** The contract's default event policy. Normal projects never materialize it. */
export const KXM_DEFAULT_SYNC_POLICY = Object.freeze({
  prompts: "title-only",
  results: "bounded-summary",
  evidence: "references",
  artifacts: "metadata",
  fileChanges: "paths-only",
  rawLogs: false,
  diffs: false,
  environmentValues: false,
});

/** The policy revision recorded on every outbox transform. */
export const KXM_DEFAULT_SYNC_POLICY_REVISION = `sha256:${createHash("sha256")
  .update(kxmCanonicalJson(KXM_DEFAULT_SYNC_POLICY as unknown as JsonValue), "utf8")
  .digest("hex")}`;

export interface KxmSyncEvent {
  schema: typeof KXM_SYNC_EVENT_SCHEMA;
  sourceEventId: string;
  eventType: string;
  projectId: string;
  runId: string;
  homeRuntimeId: string;
  sequence: number;
  occurredAt: string;
  configRevision: string;
  memoryRevision: string;
  executorPolicyRevision: string;
  toolPolicyRevision: string;
  syncPolicyRevision: string;
  redaction: { version: string; fieldsOmitted: string[]; valuesReplaced: number };
  payload: Record<string, unknown>;
}

/** Shortest value the redactor will register: a two-letter "secret" would
 * shred ordinary words out of every summary. */
const MIN_REGISTERED_SECRET_CHARS = 4;
const REDACTED = "[redacted]";
const PATH_REDACTED = "[path]";

const CREDENTIAL_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bssh-(?:rsa|ed25519|dss|ecdsa-[a-z0-9-]+) AAAA[0-9A-Za-z+/=]+/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+/gi,
];
// URL user-info (`https://user:token@host`) keeps the scheme and host.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const ABSOLUTE_PATHS: RegExp[] = [
  /\\\\[^\s\\"'`]+\\[^\s"'`]*/g, // UNC
  /\b[A-Za-z]:[\\/][^\s"'`]*/g, // Windows drive
  /(?<![\w.~:/-])~[\\/][^\s"'`]*/g, // home
  /(?<![\w.~:/-])\/(?:[\w.@%+-]+\/)*[\w.@%+-]+\/?/g, // POSIX
];
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/**
 * In-memory redactor. The Runtime registers resolved secret values before a
 * transform; they are never persisted to support later redaction, so a
 * process restart forgets them.
 */
export class KxmSyncRedactor {
  private readonly values = new Set<string>();

  register(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length >= MIN_REGISTERED_SECRET_CHARS) this.values.add(trimmed);
  }

  get size(): number {
    return this.values.size;
  }

  /** Scrub one free-text value; `replaced` counts every substitution. */
  scrub(input: string): { text: string; replaced: number } {
    let replaced = 0;
    let text = input;
    // Longest first, so a registered value containing another is removed whole.
    for (const secret of [...this.values].sort((left, right) => right.length - left.length)) {
      const parts = text.split(secret);
      if (parts.length > 1) {
        replaced += parts.length - 1;
        text = parts.join(REDACTED);
      }
    }
    const substitute = (pattern: RegExp, replacement: string | ((match: string, ...groups: string[]) => string)): void => {
      text = text.replace(pattern, (...args: unknown[]) => {
        replaced += 1;
        return typeof replacement === "string" ? replacement : replacement(...(args as [string, ...string[]]));
      });
    };
    for (const pattern of CREDENTIAL_SHAPES) substitute(pattern, REDACTED);
    substitute(URL_USERINFO, (_match, scheme) => `${scheme}${REDACTED}@`);
    const shaped = redactSecrets(text);
    if (shaped !== text) {
      replaced += shaped.split(REDACTED).length - text.split(REDACTED).length;
      text = shaped;
    }
    for (const pattern of ABSOLUTE_PATHS) substitute(pattern, PATH_REDACTED);
    text = text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
    return { text, replaced };
  }
}

type Picked = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Copy only the named keys whose values have the expected JS type. */
function pickScalars(source: unknown, keys: readonly string[], redactor?: KxmSyncRedactor): Picked | undefined {
  if (!isRecord(source)) return undefined;
  const result: Picked = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (typeof value === "string") {
      // Strings are scrubbed even in "scalar" positions: a secret echoed into
      // a lease operation or receipt query must not survive to the hub.
      if (redactor) {
        const scrubbed = redactor.scrub(value);
        if (scrubbed.text.length > 0) result[key] = scrubbed.text.slice(0, 200);
      } else {
        result[key] = value;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

class SyncPayloadBuilder {
  readonly payload: Picked = {};
  readonly omitted = new Set<string>();
  replaced = 0;
  readonly redactor: KxmSyncRedactor;

  constructor(redactor: KxmSyncRedactor) {
    this.redactor = redactor;
  }

  /** Bounded, scrubbed free text; empty after scrubbing means absent. */
  text(value: unknown, max: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const { text, replaced } = this.redactor.scrub(value);
    this.replaced += replaced;
    if (text.length === 0) return undefined;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /** A nested record rebuilt key by key, with the named keys scrubbed as text. */
  record(source: unknown, keys: readonly string[], textKeys: Readonly<Record<string, number>> = {}): Picked | undefined {
    const scalars = pickScalars(source, keys.filter((key) => !(key in textKeys)));
    const result: Picked = { ...(scalars ?? {}) };
    if (isRecord(source)) {
      for (const [key, max] of Object.entries(textKeys)) {
        const value = this.text(source[key], max);
        if (value !== undefined) result[key] = value;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  set(key: string, value: unknown): void {
    if (value !== undefined) this.payload[key] = value;
  }
}

const SCALAR_FIELDS = [
  "workflowId", "promptHash", "status", "previousStatus", "outcome", "stepId", "stepAttempt", "fromStepId", "toStepId",
  "assignmentId", "attemptId", "agentId", "instanceNo", "scopeEpoch", "resolutionAction",
] as const;
const REF_KEYS = ["id", "kind", "hash", "status", "producerId"] as const;
const ARTIFACT_KEYS = ["id", "kind", "hash", "size", "classification", "availability"] as const;
const LEASE_KEYS = ["id", "fencingToken", "acquiredAt", "expiresAt", "operation"] as const;
const MAX_REFS = 64;

/** Every source payload key the transform knows how to carry (possibly renamed). */
const CARRIED_FIELDS = new Set<string>([
  ...SCALAR_FIELDS, "displayTitle", "summary", "reason", "executor", "model", "timing", "usage", "evidenceRefs",
  "artifacts", "receipt", "error", "effect", "lease", "actor", "resolvedBy", "suppliedRefs", "counts",
]);

/** Fields the sync schema makes conditionally required; a degraded object keeps them. */
const CONTROL_FIELDS = ["effect", "lease", "actor", "resolvedBy", "resolutionAction", "reason", "suppliedRefs", "outcome"] as const;

function buildPayload(source: Record<string, unknown>, builder: SyncPayloadBuilder): void {
  for (const key of SCALAR_FIELDS) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") builder.set(key, value);
  }
  builder.set("displayTitle", builder.text(source.displayTitle, 200));
  builder.set("summary", builder.text(source.summary, 1000));
  if (source.reason !== undefined) {
    // `reason` is required on resolutions; a reason scrubbed to nothing still says one was given.
    builder.set("reason", builder.text(source.reason, 1000) ?? REDACTED);
  }
  builder.set("executor", builder.record(source.executor, ["id", "kind", "harness"], {
    executorVersion: 128, harnessVersion: 128, helperGeneration: 256,
  }));
  const model = builder.record(source.model, ["profile", "provider"], { model: 200, thinking: 64 });
  if (model && isRecord(source.model) && Array.isArray(source.model.tags)) {
    model.tags = source.model.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 32);
  }
  builder.set("model", model);
  builder.set("timing", builder.record(source.timing, ["startedAt", "finishedAt", "durationMs", "queueMs", "agentMs"]));
  builder.set("usage", builder.record(source.usage, [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "currency", "costKind",
  ]));
  const refs = (value: unknown, keys: readonly string[]): Picked[] | undefined => Array.isArray(value)
    ? value.slice(0, MAX_REFS).map((entry) => pickScalars(entry, keys)).filter((entry): entry is Picked => entry !== undefined)
    : undefined;
  builder.set("evidenceRefs", refs(source.evidenceRefs, REF_KEYS));
  builder.set("suppliedRefs", refs(source.suppliedRefs, REF_KEYS));
  builder.set("artifacts", refs(source.artifacts, ARTIFACT_KEYS));
  if (isRecord(source.receipt)) {
    // The local receipt may carry a URL (possibly secret-bearing); the safe receipt never does.
    const receipt = builder.record(source.receipt, ["provider", "kind", "hash", "observedAt"], { id: 512 });
    if (receipt) builder.set("receipts", [receipt]);
    if (source.receipt.url !== undefined) builder.omitted.add("receipt.url");
  }
  builder.set("error", builder.record(source.error, ["class", "retryable"], { component: 128 }));
  if (isRecord(source.effect)) {
    const effect = pickScalars(source.effect, ["id", "idempotencyKeyHash"], builder.redactor) ?? {};
    const policy = pickScalars(source.effect.policy, ["class", "sharedMutable", "idempotencyKey", "receiptQuery"], builder.redactor);
    if (policy) effect.policy = policy;
    builder.set("effect", effect);
  }
  builder.set("lease", pickScalars(source.lease, LEASE_KEYS, builder.redactor));
  builder.set("actor", builder.record(source.actor, ["kind"], { id: 200 }));
  builder.set("resolvedBy", builder.record(source.resolvedBy, ["kind"], { id: 200 }));
  if (isRecord(source.counts)) {
    const counts = Object.fromEntries(Object.entries(source.counts)
      .filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && (entry[1] as number) >= 0)
      .slice(0, 32));
    builder.set("counts", counts);
  }
}

export interface KxmSyncTransformOptions {
  redactor?: KxmSyncRedactor;
  policyRevision?: string;
}

function envelope(
  event: KxmRunEvent,
  policyRevision: string,
  payload: Picked,
  fieldsOmitted: Iterable<string>,
  valuesReplaced: number,
): KxmSyncEvent {
  return {
    schema: KXM_SYNC_EVENT_SCHEMA,
    sourceEventId: event.eventId,
    eventType: event.eventType,
    projectId: event.projectId,
    runId: event.runId,
    homeRuntimeId: event.homeRuntimeId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    configRevision: event.configRevision,
    memoryRevision: event.memoryRevision,
    executorPolicyRevision: event.executorPolicyRevision,
    toolPolicyRevision: event.toolPolicyRevision,
    syncPolicyRevision: policyRevision,
    redaction: {
      version: KXM_SYNC_REDACTOR_VERSION,
      fieldsOmitted: [...new Set(fieldsOmitted)].sort().slice(0, 128),
      valuesReplaced: Math.min(valuesReplaced, 100_000),
    },
    payload,
  };
}

/**
 * Derive the sync-safe object for one committed local event.
 *
 * If the full derivation does not validate (a field the transform carries
 * fell outside its sync bounds), a degraded object keeps only identity and
 * the control fields the schema requires and marks `degraded: true`, so the
 * run sequence stays gapless on the hub. If even that fails the event is
 * refused with `sync_event_invalid`: nothing unvalidated enters the outbox.
 */
export function deriveKxmSyncEvent(event: KxmRunEvent, options: KxmSyncTransformOptions = {}): KxmSyncEvent {
  const redactor = options.redactor ?? new KxmSyncRedactor();
  const policyRevision = options.policyRevision ?? KXM_DEFAULT_SYNC_POLICY_REVISION;
  const source = isRecord(event.payload) ? event.payload : {};
  const builder = new SyncPayloadBuilder(redactor);
  buildPayload(source, builder);
  const omitted = new Set(builder.omitted);
  for (const key of Object.keys(source)) if (!CARRIED_FIELDS.has(key)) omitted.add(key);
  if ((event as unknown as Record<string, unknown>).protectedPayload !== undefined) omitted.add("protectedPayload");

  const payload = Object.keys(builder.payload).length > 0 ? builder.payload : { counts: {} };
  const full = envelope(event, policyRevision, payload, omitted, builder.replaced);
  if (syncEventSchemaErrors(full) === undefined) return full;

  const degradedPayload: Picked = { degraded: true };
  for (const key of CONTROL_FIELDS) {
    // A scrubbed-required field that was REMOVED (scrubbing produced an empty
    // string and text() returned undefined) must be restored with a valid
    // placeholder, not left absent — the schema requires it and a missing
    // field aborts the caller's transaction with sync_event_invalid.
    const value = builder.payload[key];
    // A scrubbed-required field that was removed entirely (text() returned
    // undefined) or is empty/whitespace must be restored with a valid
    // placeholder. For nested objects, MERGE the surviving fields from the
    // builder with [redacted] for any field the original had that scrubbing
    // removed — not just the top level.
    const restoreNested = (built: unknown, orig: unknown): unknown => {
      if (!isRecord(orig)) return built !== undefined ? built : "[redacted]";
      const result: Picked = {};
      const builtRecord = isRecord(built) ? built : {};
      for (const [k, v] of Object.entries(orig)) {
        const builtValue = builtRecord[k];
        if (builtValue === undefined || (typeof builtValue === "string" && builtValue.trim().length === 0)) {
          result[k] = isRecord(v) ? restoreNested(undefined, v) : "[redacted]";
        } else {
          result[k] = builtValue;
        }
      }
      return result;
    };
    if (value === undefined) {
      const sourceValue = source[key];
      if (sourceValue !== undefined) {
        degradedPayload[key] = restoreNested(undefined, sourceValue);
      }
    } else if (typeof value === "string" && value.trim().length === 0) {
      degradedPayload[key] = "[redacted]";
    } else if (isRecord(value)) {
      degradedPayload[key] = restoreNested(value, source[key]);
    } else {
      degradedPayload[key] = value;
    }
  }
  const degradedOmitted = new Set(omitted);
  for (const key of Object.keys(builder.payload)) if (!(key in degradedPayload)) degradedOmitted.add(key);
  const degraded = envelope(event, policyRevision, degradedPayload, degradedOmitted, builder.replaced);
  const errors = syncEventSchemaErrors(degraded);
  if (errors === undefined) return degraded;
  throw new KxmConfigError([{
    phase: "schema",
    code: "sync_event_invalid",
    file: `${event.runId}#${event.sequence}`,
    message: `event cannot be derived into kxm.sync-event.v1: ${errors}`,
  }]);
}

/** The exact bytes of a sync object: what the outbox stores and the hub compares. */
export function kxmSyncEventBytes(event: KxmSyncEvent): string {
  return kxmCanonicalJson(event as unknown as JsonValue);
}

export function kxmSyncEventHash(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}
