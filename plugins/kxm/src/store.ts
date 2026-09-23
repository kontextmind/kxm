import { resolve } from "node:path";
import type { DatabaseSync } from "./sqlite.ts";
import type { AgentIdentity, LeaseRecord, MessageRecord, RuntimePresenceRecord, StoredSyncEvent } from "./protocol.ts";
import type { ContextItem } from "./context.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "./workflow.ts";
import {
  openDatabase,
  withDatabaseTransaction,
  type DatabaseSchemaSpec,
} from "./database.ts";

export const HUB_STORE_SCHEMA_VERSION = 5;

export const HUB_STORE_TABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agents: Object.freeze(["id", "record"]),
  messages: Object.freeze(["id", "record"]),
  consumer_cursors: Object.freeze(["agent_id", "cursor"]),
  agent_sequences: Object.freeze(["agent_id", "next_seq"]),
  workflow_runs: Object.freeze(["id", "definition_id", "delivery_id", "record"]),
  workflow_journal: Object.freeze(["id", "run_id", "category", "area", "record"]),
  context_items: Object.freeze(["id", "project", "kind", "record"]),
  leases: Object.freeze(["resource", "holder_agent_id", "fencing_token", "expires_at", "record"]),
  sync_events: Object.freeze([
    "project_id", "run_id", "sequence", "hub_project", "home_runtime_id", "event_type", "content_hash", "received_at", "record",
  ]),
  runtime_presence: Object.freeze(["runtime_id", "hub_project", "host", "heartbeat", "record"]),
});

export const HUB_STORE_SCHEMA_V5 = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS messages_from_idempotency
  ON messages(
    json_extract(record, '$.from'),
    json_extract(record, '$.idempotencyKey')
  ) WHERE json_extract(record, '$.idempotencyKey') IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_to_seq
  ON messages(
    json_extract(record, '$.to'),
    COALESCE(json_extract(record, '$.seq'), 0)
  );
  CREATE TABLE IF NOT EXISTS consumer_cursors (
    agent_id TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_sequences (
    agent_id TEXT PRIMARY KEY,
    next_seq INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    record TEXT NOT NULL,
    UNIQUE(definition_id, delivery_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS workflow_journal (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    category TEXT NOT NULL,
    area TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workflow_journal_run_id ON workflow_journal(run_id);
  CREATE TABLE IF NOT EXISTS context_items (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS context_items_project ON context_items(project);
  CREATE TABLE IF NOT EXISTS leases (
    resource TEXT PRIMARY KEY,
    holder_agent_id TEXT NOT NULL,
    fencing_token INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sync_events (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    hub_project TEXT NOT NULL,
    home_runtime_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    received_at TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (project_id, run_id, sequence)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sync_events_hub_project ON sync_events(hub_project, run_id, sequence);
  CREATE TABLE IF NOT EXISTS runtime_presence (
    runtime_id TEXT NOT NULL,
    hub_project TEXT NOT NULL,
    host TEXT,
    heartbeat TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (hub_project, runtime_id)
  ) STRICT;
`;

export const HUB_STORE_SCHEMA_SPEC: DatabaseSchemaSpec = Object.freeze({
  schema: HUB_STORE_SCHEMA_V5,
  version: HUB_STORE_SCHEMA_VERSION,
  tables: HUB_STORE_TABLES,
});

/** The stored shape stays the durable identity plus the agent key: presence
 * and the lease are derived on read, so the agents record JSON grows only by
 * the additive `host` label. */
export interface StoredAgent extends AgentIdentity {
  key: string;
}

/** Why a lease call did not get the resource. `held` is live contention,
 * `superseded` is a token the hub has already moved past, `expired` is a lease
 * whose hub-clocked deadline has passed, and `missing` is no lease at all. */
export type LeaseRefusal = "held" | "superseded" | "expired" | "missing";

export type LeaseOutcome =
  | { ok: true; lease: LeaseRecord; renewed: boolean }
  | { ok: false; reason: LeaseRefusal; lease?: LeaseRecord };

export interface LeaseAcquireInput {
  resource: string;
  project: string;
  name: string;
  holderAgentId: string;
  holderAgentName: string;
  ttlMs: number;
  nowMs: number;
}

/** How one pushed sync event landed. `conflict` is a security alert: the
 * same `{projectId, runId, sequence}` already holds different bytes, or the
 * run already belongs to another project or home Runtime. */
export type SyncIngestOutcome =
  | { outcome: "accepted" | "duplicate" }
  | { outcome: "conflict"; reason: "sequence_reused" | "project_mismatch" | "home_runtime_mismatch"; existingHash?: string };

function syncKey(projectId: string, runId: string, sequence: number): string {
  return `${projectId}\u0000${runId}\u0000${sequence}`;
}

function parseLeaseRecord(record: string): LeaseRecord | undefined {
  try {
    return JSON.parse(record) as LeaseRecord;
  } catch {
    return undefined;
  }
}

/** A deadline the hub cannot read is an expired deadline. The alternative — a
 * lease nobody can ever take over — is the worse failure. */
function leaseHasLapsed(lease: LeaseRecord, nowMs: number): boolean {
  const expiresAtMs = Date.parse(lease.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

type SyncEventSqlRow = {
  project_id: string;
  run_id: string;
  sequence: number;
  hub_project: string;
  home_runtime_id: string;
  event_type: string;
  content_hash: string;
  received_at: string;
  record: string;
};

function syncEventFromRow(row: SyncEventSqlRow): StoredSyncEvent {
  return {
    projectId: row.project_id,
    runId: row.run_id,
    sequence: row.sequence,
    hubProject: row.hub_project,
    homeRuntimeId: row.home_runtime_id,
    eventType: row.event_type,
    contentHash: row.content_hash,
    receivedAt: row.received_at,
    bytes: row.record,
  };
}

class MessageMap extends Map<string, MessageRecord> {
  private readonly store: MeshStore;

  constructor(store: MeshStore) {
    super();
    this.store = store;
  }

  override get(id: string): MessageRecord | undefined {
    const cached = super.get(id);
    if (cached) return cached;
    return this.store.loadMessageFromDb(id);
  }

  override has(id: string): boolean {
    if (super.has(id)) return true;
    return this.store.hasMessage(id);
  }

  override delete(id: string): boolean {
    this.store.deleteMessage(id);
    return super.delete(id);
  }

  override get size(): number {
    return this.store.countMessages();
  }

  get cachedSize(): number {
    return super.size;
  }
}

export class MeshStore {
  readonly agents = new Map<string, StoredAgent>();
  readonly messages: MessageMap;
  readonly workflowRuns = new Map<string, WorkflowRun>();
  readonly journal = new Map<string, WorkflowJournalEntry>();
  readonly contextItems = new Map<string, ContextItem>();
  readonly leases = new Map<string, LeaseRecord>();
  /** Memory-only stores keep sync state here; a database store reads SQLite. */
  private readonly syncEvents = new Map<string, StoredSyncEvent>();
  private readonly runtimePresence = new Map<string, RuntimePresenceRecord>();
  readonly path?: string;
  private readonly database?: DatabaseSync;
  private readonly agentSequences = new Map<string, number>();
  private readonly consumerCursors = new Map<string, number>();

  constructor(path?: string) {
    this.messages = new MessageMap(this);
    if (!path) return;
    this.path = path === ":memory:" ? path : resolve(path);
    this.database = openDatabase(this.path, "hub database", HUB_STORE_SCHEMA_SPEC);
    this.load();
  }

  get persistent(): boolean {
    return Boolean(this.database && this.path !== ":memory:");
  }

  saveAgent(agent: StoredAgent): void {
    this.agents.set(agent.id, agent);
    this.database?.prepare(`
      INSERT INTO agents (id, record) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(agent.id, JSON.stringify(agent));
  }

  saveMessage(message: MessageRecord): void {
    Map.prototype.set.call(this.messages, message.id, message);
    this.database?.prepare(`
      INSERT INTO messages (id, record) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(message.id, JSON.stringify(message));
  }

  deleteMessage(messageId: string): void {
    Map.prototype.delete.call(this.messages, messageId);
    this.database?.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  }

  loadMessageFromDb(id: string): MessageRecord | undefined {
    if (!this.database) return undefined;
    const row = this.database.prepare("SELECT record FROM messages WHERE id = ?").get(id) as { record: string } | undefined;
    if (!row) return undefined;
    try {
      const msg = JSON.parse(row.record) as MessageRecord;
      Map.prototype.set.call(this.messages, msg.id, msg);
      return msg;
    } catch {
      return undefined;
    }
  }

  hasMessage(id: string): boolean {
    if (Map.prototype.has.call(this.messages, id)) return true;
    if (!this.database) return false;
    const row = this.database.prepare("SELECT 1 AS ok FROM messages WHERE id = ?").get(id) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  }

  countMessages(): number {
    if (!this.database) return [...Map.prototype.keys.call(this.messages)].length;
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM messages").get() as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  nextAgentSequence(agentId: string): number {
    if (!this.database) {
      const current = this.agentSequences.get(agentId) ?? 0;
      const next = current + 1;
      this.agentSequences.set(agentId, next);
      return next;
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT next_seq FROM agent_sequences WHERE agent_id = ?").get(agentId) as { next_seq: number } | undefined;
      let next = row?.next_seq;
      if (next === undefined) {
        const maxRow = this.database.prepare(`
          SELECT COALESCE(MAX(json_extract(record, '$.seq')), 0) AS max_seq
          FROM messages WHERE json_extract(record, '$.to') = ?
        `).get(agentId) as { max_seq: number } | undefined;
        next = Number(maxRow?.max_seq ?? 0) + 1;
      }
      this.database.prepare(`
        INSERT INTO agent_sequences (agent_id, next_seq) VALUES (?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET next_seq = excluded.next_seq
      `).run(agentId, next + 1);
      this.database.exec("COMMIT");
      this.agentSequences.set(agentId, next + 1);
      return next;
    } catch (err) {
      try { this.database.exec("ROLLBACK"); } catch { /* rollback */ }
      throw err;
    }
  }

  getConsumerCursor(agentId: string): number {
    if (!this.database) {
      return this.consumerCursors.get(agentId) ?? 0;
    }
    const row = this.database.prepare("SELECT cursor FROM consumer_cursors WHERE agent_id = ?").get(agentId) as { cursor: number } | undefined;
    const cursor = Number(row?.cursor ?? 0);
    this.consumerCursors.set(agentId, cursor);
    return cursor;
  }

  advanceCursor(agentId: string, seq: number): number {
    if (!this.database) {
      const current = this.consumerCursors.get(agentId) ?? 0;
      const next = Math.max(current, seq);
      this.consumerCursors.set(agentId, next);
      return next;
    }
    this.database.prepare(`
      INSERT INTO consumer_cursors (agent_id, cursor) VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET cursor = MAX(consumer_cursors.cursor, excluded.cursor)
    `).run(agentId, seq);
    return this.getConsumerCursor(agentId);
  }

  getPendingMessages(agentId: string, cursor = 0): MessageRecord[] {
    if (!this.database) {
      return [...Map.prototype.values.call(this.messages)]
        .filter((m) => m.to === agentId && (m.status === "queued" || m.status === "delivered") && (m.seq ?? 0) > cursor)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    }
    const rows = this.database.prepare(`
      SELECT record FROM messages
      WHERE json_extract(record, '$.to') = ?
        AND json_extract(record, '$.status') IN ('queued', 'delivered')
        AND COALESCE(json_extract(record, '$.seq'), 0) > ?
      ORDER BY COALESCE(json_extract(record, '$.seq'), 0) ASC
    `).all(agentId, cursor) as Array<{ record: string }>;
    const result: MessageRecord[] = [];
    for (const row of rows) {
      try {
        const msg = JSON.parse(row.record) as MessageRecord;
        Map.prototype.set.call(this.messages, msg.id, msg);
        result.push(msg);
      } catch { /* skip */ }
    }
    return result;
  }

  findMessageByIdempotency(fromId: string, idempotencyKey: string): MessageRecord | undefined {
    for (const m of Map.prototype.values.call(this.messages)) {
      if (m.from === fromId && m.idempotencyKey === idempotencyKey) return m;
    }
    if (!this.database) return undefined;
    const row = this.database.prepare(`
      SELECT record FROM messages
      WHERE json_extract(record, '$.from') = ? AND json_extract(record, '$.idempotencyKey') = ?
    `).get(fromId, idempotencyKey) as { record: string } | undefined;
    if (!row) return undefined;
    try {
      const msg = JSON.parse(row.record) as MessageRecord;
      Map.prototype.set.call(this.messages, msg.id, msg);
      return msg;
    } catch {
      return undefined;
    }
  }

  getOpenMessages(project: string): MessageRecord[] {
    if (!this.database) {
      return [...Map.prototype.values.call(this.messages)]
        .filter((m) => m.project === project && (m.status === "queued" || m.status === "delivered"))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }
    const rows = this.database.prepare(`
      SELECT record FROM messages
      WHERE json_extract(record, '$.project') = ?
        AND json_extract(record, '$.status') IN ('queued', 'delivered')
      ORDER BY json_extract(record, '$.createdAt') DESC
    `).all(project) as Array<{ record: string }>;
    const result: MessageRecord[] = [];
    for (const row of rows) {
      try {
        const msg = JSON.parse(row.record) as MessageRecord;
        Map.prototype.set.call(this.messages, msg.id, msg);
        result.push(msg);
      } catch { /* skip */ }
    }
    return result;
  }

  getExpiringMessages(nowMs = Date.now()): MessageRecord[] {
    const nowIso = new Date(nowMs).toISOString();
    if (!this.database) {
      return [...Map.prototype.values.call(this.messages)]
        .filter((m) => (m.status === "queued" || m.status === "delivered") && Date.parse(m.expiresAt) <= nowMs);
    }
    const rows = this.database.prepare(`
      SELECT record FROM messages
      WHERE json_extract(record, '$.status') IN ('queued', 'delivered')
        AND json_extract(record, '$.expiresAt') <= ?
    `).all(nowIso) as Array<{ record: string }>;
    const result: MessageRecord[] = [];
    for (const row of rows) {
      try {
        const msg = JSON.parse(row.record) as MessageRecord;
        Map.prototype.set.call(this.messages, msg.id, msg);
        result.push(msg);
      } catch { /* skip */ }
    }
    return result;
  }

  /** Read the lease over one already project-scoped resource. */
  getLease(resource: string): LeaseRecord | undefined {
    if (!this.database) return this.leases.get(resource);
    const row = this.database.prepare("SELECT record FROM leases WHERE resource = ?").get(resource) as { record: string } | undefined;
    if (!row) {
      this.leases.delete(resource);
      return undefined;
    }
    const lease = parseLeaseRecord(row.record);
    if (lease) this.leases.set(resource, lease);
    return lease;
  }

  /**
   * Take or extend the lease over `resource`, deciding the whole outcome inside
   * one transaction so two writers cannot both read "free" and both insert.
   *
   * The token is the fence: a first acquisition starts at 1, the holder's own
   * re-acquisition keeps its token, and only a takeover of an expired lease
   * increments it. That is what lets a holder that wakes up after its deadline
   * be refused at commit rather than silently writing behind the new holder.
   */
  acquireLease(input: LeaseAcquireInput): LeaseOutcome {
    return this.inLeaseTransaction(() => {
      const current = this.readLeaseForUpdate(input.resource);
      const expired = current !== undefined && leaseHasLapsed(current, input.nowMs);
      if (current && !expired && current.holderAgentId !== input.holderAgentId) {
        return { ok: false, reason: "held", lease: current };
      }
      const fencingToken = current === undefined
        ? 1
        : expired
          ? current.fencingToken + 1
          : current.fencingToken;
      const renewed = current !== undefined && !expired;
      const lease: LeaseRecord = {
        resource: input.resource,
        project: input.project,
        name: input.name,
        holderAgentId: input.holderAgentId,
        holderAgentName: input.holderAgentName,
        fencingToken,
        acquiredAt: renewed && current ? current.acquiredAt : new Date(input.nowMs).toISOString(),
        expiresAt: new Date(input.nowMs + input.ttlMs).toISOString(),
      };
      this.writeLease(lease);
      return { ok: true, lease, renewed };
    });
  }

  /** Extend a lease the caller still holds under the token it was given. The
   * token never changes on renewal — a renewal that would need a new token is
   * a takeover, and takeovers go through `acquireLease`. */
  renewLease(input: {
    resource: string;
    holderAgentId: string;
    fencingToken: number;
    ttlMs: number;
    nowMs: number;
  }): LeaseOutcome {
    return this.inLeaseTransaction(() => {
      const current = this.readLeaseForUpdate(input.resource);
      if (!current) return { ok: false, reason: "missing" };
      if (current.holderAgentId !== input.holderAgentId || current.fencingToken !== input.fencingToken) {
        return { ok: false, reason: "superseded", lease: current };
      }
      if (leaseHasLapsed(current, input.nowMs)) {
        // The deadline passed, so the resource is takeable by anyone. Resurrecting it
        // under the old token would let a second holder appear behind the first.
        return { ok: false, reason: "expired", lease: current };
      }
      const lease: LeaseRecord = { ...current, expiresAt: new Date(input.nowMs + input.ttlMs).toISOString() };
      this.writeLease(lease);
      return { ok: true, lease, renewed: true };
    });
  }

  /** Drop a lease the caller holds. A clean release ends the fence: there is no
   * stale writer left to keep a token for, so the next acquisition starts over. */
  releaseLease(input: { resource: string; holderAgentId: string; fencingToken: number }): LeaseOutcome {
    return this.inLeaseTransaction(() => {
      const current = this.readLeaseForUpdate(input.resource);
      if (!current) return { ok: false, reason: "missing" };
      if (current.holderAgentId !== input.holderAgentId || current.fencingToken !== input.fencingToken) {
        return { ok: false, reason: "superseded", lease: current };
      }
      this.deleteLease(input.resource);
      return { ok: true, lease: current, renewed: false };
    });
  }

  /** Every lease of one project, newest deadline last. Reader surface only. */
  listLeases(project: string): LeaseRecord[] {
    if (this.database) {
      const rows = this.database.prepare("SELECT record FROM leases").all() as Array<{ record: string }>;
      this.leases.clear();
      for (const row of rows) {
        const lease = parseLeaseRecord(row.record);
        if (lease) this.leases.set(lease.resource, lease);
      }
    }
    return [...this.leases.values()]
      .filter((lease) => lease.project === project)
      .sort((left, right) => left.resource.localeCompare(right.resource));
  }

  private inLeaseTransaction(work: () => LeaseOutcome): LeaseOutcome {
    if (!this.database) return work();
    return withDatabaseTransaction(this.database, work);
  }

  private readLeaseForUpdate(resource: string): LeaseRecord | undefined {
    if (!this.database) return this.leases.get(resource);
    const row = this.database.prepare("SELECT record FROM leases WHERE resource = ?").get(resource) as { record: string } | undefined;
    return row ? parseLeaseRecord(row.record) : undefined;
  }

  private writeLease(lease: LeaseRecord): void {
    this.leases.set(lease.resource, lease);
    this.database?.prepare(`
      INSERT INTO leases (resource, holder_agent_id, fencing_token, expires_at, record) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resource) DO UPDATE SET
        holder_agent_id = excluded.holder_agent_id,
        fencing_token = excluded.fencing_token,
        expires_at = excluded.expires_at,
        record = excluded.record
    `).run(lease.resource, lease.holderAgentId, lease.fencingToken, lease.expiresAt, JSON.stringify(lease));
  }

  private deleteLease(resource: string): void {
    this.leases.delete(resource);
    this.database?.prepare("DELETE FROM leases WHERE resource = ?").run(resource);
  }

  // ----- Runtime → hub sync (P5) -----

  /**
   * Accept one sync event exactly once by `{projectId, runId, sequence}`,
   * deciding inside one transaction. Identical bytes are an idempotent
   * duplicate; different bytes under a used sequence are refused, and so is a
   * run that already belongs to another hub project or home Runtime.
   */
  ingestSyncEvent(event: StoredSyncEvent): SyncIngestOutcome {
    const decide = (): SyncIngestOutcome => {
      const existing = this.readSyncEvent(event.projectId, event.runId, event.sequence);
      if (existing) {
        if (existing.contentHash === event.contentHash && existing.hubProject === event.hubProject) return { outcome: "duplicate" };
        return { outcome: "conflict", reason: "sequence_reused", existingHash: existing.contentHash };
      }
      const owner = this.syncProjectOwner(event.projectId);
      if (owner !== undefined && owner !== event.hubProject) return { outcome: "conflict", reason: "project_mismatch" };
      const home = this.syncRunHome(event.projectId, event.runId);
      if (home !== undefined && home !== event.homeRuntimeId) return { outcome: "conflict", reason: "home_runtime_mismatch" };
      this.writeSyncEvent(event);
      return { outcome: "accepted" };
    };
    return this.database ? withDatabaseTransaction(this.database, decide) : decide();
  }

  /** Every sync event one hub project holds, by run then sequence. */
  listSyncEvents(hubProject: string): StoredSyncEvent[] {
    if (!this.database) {
      return [...this.syncEvents.values()]
        .filter((event) => event.hubProject === hubProject)
        .sort((left, right) => left.runId.localeCompare(right.runId) || left.sequence - right.sequence);
    }
    const rows = this.database.prepare(`
      SELECT project_id, run_id, sequence, hub_project, home_runtime_id, event_type, content_hash, received_at, record
      FROM sync_events WHERE hub_project = ? ORDER BY run_id ASC, sequence ASC
    `).all(hubProject) as SyncEventSqlRow[];
    return rows.map(syncEventFromRow);
  }

  /** Highest sequence of one run with no gap below it; 0 when sequence 1 is missing. */
  syncCursor(projectId: string, runId: string): number {
    const sequences = this.database
      ? (this.database.prepare("SELECT sequence FROM sync_events WHERE project_id = ? AND run_id = ? ORDER BY sequence ASC")
        .all(projectId, runId) as Array<{ sequence: number }>).map((row) => row.sequence)
      : [...this.syncEvents.values()]
        .filter((event) => event.projectId === projectId && event.runId === runId)
        .map((event) => event.sequence)
        .sort((left, right) => left - right);
    let cursor = 0;
    for (const sequence of sequences) {
      if (sequence !== cursor + 1) break;
      cursor = sequence;
    }
    return cursor;
  }

  saveRuntimePresence(record: RuntimePresenceRecord): void {
    this.runtimePresence.set(`${record.project}\u0000${record.runtimeId}`, record);
    this.database?.prepare(`
      INSERT INTO runtime_presence (runtime_id, hub_project, host, heartbeat, record) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(hub_project, runtime_id) DO UPDATE SET
        host = excluded.host,
        heartbeat = excluded.heartbeat,
        record = excluded.record
    `).run(record.runtimeId, record.project, record.host ?? null, record.heartbeatAt, JSON.stringify(record));
  }

  getRuntimePresence(project: string, runtimeId: string): RuntimePresenceRecord | undefined {
    if (!this.database) return this.runtimePresence.get(`${project}\u0000${runtimeId}`);
    const row = this.database.prepare("SELECT record FROM runtime_presence WHERE hub_project = ? AND runtime_id = ?")
      .get(project, runtimeId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as RuntimePresenceRecord : undefined;
  }

  listRuntimePresence(project: string): RuntimePresenceRecord[] {
    if (!this.database) {
      return [...this.runtimePresence.values()]
        .filter((record) => record.project === project)
        .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
    }
    const rows = this.database.prepare("SELECT record FROM runtime_presence WHERE hub_project = ? ORDER BY runtime_id ASC")
      .all(project) as Array<{ record: string }>;
    return rows.map((row) => JSON.parse(row.record) as RuntimePresenceRecord);
  }

  private readSyncEvent(projectId: string, runId: string, sequence: number): StoredSyncEvent | undefined {
    if (!this.database) return this.syncEvents.get(syncKey(projectId, runId, sequence));
    const row = this.database.prepare(`
      SELECT project_id, run_id, sequence, hub_project, home_runtime_id, event_type, content_hash, received_at, record
      FROM sync_events WHERE project_id = ? AND run_id = ? AND sequence = ?
    `).get(projectId, runId, sequence) as SyncEventSqlRow | undefined;
    return row ? syncEventFromRow(row) : undefined;
  }

  private syncProjectOwner(projectId: string): string | undefined {
    if (!this.database) {
      for (const event of this.syncEvents.values()) if (event.projectId === projectId) return event.hubProject;
      return undefined;
    }
    const row = this.database.prepare("SELECT hub_project FROM sync_events WHERE project_id = ? LIMIT 1").get(projectId) as
      | { hub_project: string }
      | undefined;
    return row?.hub_project;
  }

  private syncRunHome(projectId: string, runId: string): string | undefined {
    if (!this.database) {
      for (const event of this.syncEvents.values()) {
        if (event.projectId === projectId && event.runId === runId) return event.homeRuntimeId;
      }
      return undefined;
    }
    const row = this.database.prepare("SELECT home_runtime_id FROM sync_events WHERE project_id = ? AND run_id = ? LIMIT 1")
      .get(projectId, runId) as { home_runtime_id: string } | undefined;
    return row?.home_runtime_id;
  }

  private writeSyncEvent(event: StoredSyncEvent): void {
    if (!this.database) {
      this.syncEvents.set(syncKey(event.projectId, event.runId, event.sequence), event);
      return;
    }
    this.database.prepare(`
      INSERT INTO sync_events (project_id, run_id, sequence, hub_project, home_runtime_id, event_type, content_hash, received_at, record)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.projectId,
      event.runId,
      event.sequence,
      event.hubProject,
      event.homeRuntimeId,
      event.eventType,
      event.contentHash,
      event.receivedAt,
      event.bytes,
    );
  }

  deleteWorkflowRun(runId: string): void {
    this.workflowRuns.delete(runId);
    this.database?.prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
  }

  deleteJournalEntry(id: string): void {
    this.journal.delete(id);
    this.database?.prepare("DELETE FROM workflow_journal WHERE id = ?").run(id);
  }

  deleteContextItem(id: string): void {
    this.contextItems.delete(id);
    this.database?.prepare("DELETE FROM context_items WHERE id = ?").run(id);
  }

  sweepRetention(
    messageRetentionMs: number,
    runRetentionMs = 7 * 86_400_000,
    nowMs = Date.now(),
  ): {
    purgedMessages: MessageRecord[];
    purgedRuns: string[];
    purgedJournal: string[];
    purgedContextItems: string[];
    purgedLeases: LeaseRecord[];
  } {
    const messageCutoffMs = nowMs - messageRetentionMs;
    const messageCutoffIso = new Date(messageCutoffMs).toISOString();
    const runCutoffMs = nowMs - runRetentionMs;
    const purgedMessages: MessageRecord[] = [];
    const purgedRuns: string[] = [];
    const purgedJournal: string[] = [];
    const purgedContextItems: string[] = [];
    const purgedLeases: LeaseRecord[] = [];

    // 1. Messages
    if (!this.database) {
      for (const m of [...Map.prototype.values.call(this.messages)]) {
        const terminal = m.status === "replied" || m.status === "cancelled" || m.status === "expired" || m.status === "error";
        if (!terminal) continue;
        const terminalAt = m.repliedAt ?? m.cancelledAt ?? m.expiresAt ?? m.createdAt;
        if (Date.parse(terminalAt) <= messageCutoffMs) {
          Map.prototype.delete.call(this.messages, m.id);
          purgedMessages.push(m);
        }
      }
    } else {
      const rows = this.database.prepare(`
        SELECT record FROM messages
        WHERE json_extract(record, '$.status') IN ('replied', 'cancelled', 'expired', 'error')
          AND COALESCE(json_extract(record, '$.repliedAt'), json_extract(record, '$.cancelledAt'), json_extract(record, '$.expiresAt'), json_extract(record, '$.createdAt')) <= ?
      `).all(messageCutoffIso) as Array<{ record: string }>;
      for (const row of rows) {
        try {
          const msg = JSON.parse(row.record) as MessageRecord;
          Map.prototype.delete.call(this.messages, msg.id);
          this.database.prepare("DELETE FROM messages WHERE id = ?").run(msg.id);
          purgedMessages.push(msg);
        } catch { /* skip */ }
      }
    }

    // 2. Runs & their journal entries
    const terminalRunsToPurge: string[] = [];
    for (const run of this.workflowRuns.values()) {
      const terminal = run.status === "completed" || run.status === "failed";
      if (!terminal) continue;
      const terminalAt = run.updatedAt ?? run.createdAt;
      if (Date.parse(terminalAt) <= runCutoffMs) {
        terminalRunsToPurge.push(run.id);
      }
    }
    for (const runId of terminalRunsToPurge) {
      this.deleteWorkflowRun(runId);
      purgedRuns.push(runId);
      const toDeleteJournal: string[] = [];
      for (const entry of this.journal.values()) {
        if (entry.runId === runId) toDeleteJournal.push(entry.id);
      }
      for (const jid of toDeleteJournal) {
        this.deleteJournalEntry(jid);
        purgedJournal.push(jid);
      }
    }

    // 3. Orphan journal entries
    const orphanJournal: string[] = [];
    for (const entry of this.journal.values()) {
      if (Date.parse(entry.createdAt) <= runCutoffMs && !this.workflowRuns.has(entry.runId)) {
        orphanJournal.push(entry.id);
      }
    }
    for (const jid of orphanJournal) {
      this.deleteJournalEntry(jid);
      purgedJournal.push(jid);
    }

    // 4. Context items
    const contextItemsToPurge: string[] = [];
    for (const item of this.contextItems.values()) {
      const terminal = item.status === "superseded" || item.status === "rejected" || (item.validUntil !== undefined && Date.parse(item.validUntil) <= runCutoffMs);
      if (!terminal) continue;
      const terminalAt = item.validUntil ?? item.observedAt;
      if (terminalAt && Date.parse(terminalAt) <= runCutoffMs) {
        contextItemsToPurge.push(item.id);
      }
    }
    for (const id of contextItemsToPurge) {
      this.deleteContextItem(id);
      purgedContextItems.push(id);
    }

    // 5. Leases. An expired lease row is kept on purpose — its token is what a
    // takeover increments, so reaping it the moment it lapses would let the
    // fence restart at 1 while a stale holder was still alive. Only rows whose
    // deadline is older than the retention window, far beyond any live holder's
    // TTL, are dropped.
    const leaseCutoffMs = nowMs - runRetentionMs;
    for (const lease of this.listAllLeases()) {
      if (leaseHasLapsed(lease, leaseCutoffMs)) {
        this.deleteLease(lease.resource);
        purgedLeases.push(lease);
      }
    }

    return { purgedMessages, purgedRuns, purgedJournal, purgedContextItems, purgedLeases };
  }

  private listAllLeases(): LeaseRecord[] {
    if (!this.database) return [...this.leases.values()];
    const rows = this.database.prepare("SELECT record FROM leases").all() as Array<{ record: string }>;
    const result: LeaseRecord[] = [];
    for (const row of rows) {
      const lease = parseLeaseRecord(row.record);
      if (lease) result.push(lease);
    }
    return result;
  }

  saveWorkflowRun(run: WorkflowRun): void {
    this.workflowRuns.set(run.id, run);
    this.database?.prepare(`
      INSERT INTO workflow_runs (id, definition_id, delivery_id, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(run.id, run.definitionId, run.deliveryId, JSON.stringify(run));
  }

  saveJournalEntry(entry: WorkflowJournalEntry): void {
    this.journal.set(entry.id, entry);
    this.database?.prepare(`
      INSERT INTO workflow_journal (id, run_id, category, area, record) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(entry.id, entry.runId, entry.category, entry.area, JSON.stringify(entry));
  }

  saveContextItem(item: ContextItem): void {
    this.contextItems.set(item.id, item);
    this.database?.prepare(`
      INSERT INTO context_items (id, project, kind, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(item.id, item.project, item.kind, JSON.stringify(item));
  }

  getContextItem(id: string, project?: string): ContextItem | undefined {
    const item = this.contextItems.get(id);
    if (!item) return undefined;
    if (project !== undefined && item.project !== project) return undefined;
    return item;
  }

  listContextItems(project: string, kinds?: ContextItem["kind"][]): ContextItem[] {
    const wanted = kinds ? new Set(kinds) : undefined;
    return [...this.contextItems.values()]
      .filter((item) => item.project === project)
      .filter((item) => wanted === undefined || wanted.has(item.kind))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  saveWorkflowTransition(
    run: WorkflowRun,
    message?: MessageRecord,
    entry?: WorkflowJournalEntry,
  ): void {
    if (this.database) {
      withDatabaseTransaction(this.database, () => {
        if (message) {
          this.database!.prepare(`
            INSERT INTO messages (id, record) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET record = excluded.record
          `).run(message.id, JSON.stringify(message));
        }
        if (entry) {
          this.database!.prepare(`
            INSERT INTO workflow_journal (id, run_id, category, area, record) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET record = excluded.record
          `).run(entry.id, entry.runId, entry.category, entry.area, JSON.stringify(entry));
        }
        this.database!.prepare(`
          INSERT INTO workflow_runs (id, definition_id, delivery_id, record) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET record = excluded.record
        `).run(run.id, run.definitionId, run.deliveryId, JSON.stringify(run));
      });
    }
    if (message) Map.prototype.set.call(this.messages, message.id, message);
    if (entry) this.journal.set(entry.id, entry);
    this.workflowRuns.set(run.id, run);
  }

  healthy(): boolean {
    if (!this.database) return true;
    return this.database.prepare("SELECT 1 AS ok").get() !== undefined;
  }

  close(): void {
    this.database?.close();
  }

  private load(): void {
    if (!this.database) return;
    const agentRows = this.database.prepare("SELECT record FROM agents").all() as Array<{ record: string }>;
    const workflowRows = this.database.prepare("SELECT record FROM workflow_runs").all() as Array<{ record: string }>;
    const journalRows = this.database.prepare("SELECT record FROM workflow_journal").all() as Array<{ record: string }>;
    const contextRows = this.database.prepare("SELECT record FROM context_items").all() as Array<{ record: string }>;
    const leaseRows = this.database.prepare("SELECT record FROM leases").all() as Array<{ record: string }>;
    for (const row of agentRows) {
      const agent = JSON.parse(row.record) as StoredAgent;
      this.agents.set(agent.id, agent);
    }
    for (const row of workflowRows) {
      const run = JSON.parse(row.record) as WorkflowRun;
      this.workflowRuns.set(run.id, run);
    }
    for (const row of journalRows) {
      const entry = JSON.parse(row.record) as WorkflowJournalEntry;
      this.journal.set(entry.id, entry);
    }
    for (const row of contextRows) {
      const item = JSON.parse(row.record) as ContextItem;
      this.contextItems.set(item.id, item);
    }
    for (const row of leaseRows) {
      const lease = parseLeaseRecord(row.record);
      if (lease) this.leases.set(lease.resource, lease);
    }
  }
}
