import { resolve } from "node:path";
import type { DatabaseSync } from "./sqlite.ts";
import type { AgentRecord, MessageRecord } from "./protocol.ts";
import type { ContextItem } from "./context.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "./workflow.ts";
import {
  openDatabase,
  withDatabaseTransaction,
  type DatabaseSchemaSpec,
} from "./database.ts";

export const HUB_STORE_SCHEMA_VERSION = 3;

export const HUB_STORE_TABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agents: Object.freeze(["id", "record"]),
  messages: Object.freeze(["id", "record"]),
  consumer_cursors: Object.freeze(["agent_id", "cursor"]),
  agent_sequences: Object.freeze(["agent_id", "next_seq"]),
  workflow_runs: Object.freeze(["id", "definition_id", "delivery_id", "record"]),
  workflow_journal: Object.freeze(["id", "run_id", "category", "area", "record"]),
  context_items: Object.freeze(["id", "project", "kind", "record"]),
});

export const HUB_STORE_SCHEMA_V3 = `
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
`;

export const HUB_STORE_SCHEMA_SPEC: DatabaseSchemaSpec = Object.freeze({
  schema: HUB_STORE_SCHEMA_V3,
  version: HUB_STORE_SCHEMA_VERSION,
  tables: HUB_STORE_TABLES,
});

export interface StoredAgent extends AgentRecord {
  key: string;
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
  } {
    const messageCutoffMs = nowMs - messageRetentionMs;
    const messageCutoffIso = new Date(messageCutoffMs).toISOString();
    const runCutoffMs = nowMs - runRetentionMs;
    const purgedMessages: MessageRecord[] = [];
    const purgedRuns: string[] = [];
    const purgedJournal: string[] = [];
    const purgedContextItems: string[] = [];

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

    return { purgedMessages, purgedRuns, purgedJournal, purgedContextItems };
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
  }
}
