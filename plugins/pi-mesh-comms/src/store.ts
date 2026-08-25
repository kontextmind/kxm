import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { AgentRecord, MessageRecord } from "./protocol.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "./workflow.ts";

export interface StoredAgent extends AgentRecord {
  key: string;
}

export class MeshStore {
  readonly agents = new Map<string, StoredAgent>();
  readonly messages = new Map<string, MessageRecord>();
  readonly workflowRuns = new Map<string, WorkflowRun>();
  readonly journal = new Map<string, WorkflowJournalEntry>();
  readonly path?: string;
  private readonly database?: Database.Database;

  constructor(path?: string) {
    if (!path) return;
    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.database = new Database(this.path);
    const schemaVersion = this.database.pragma("user_version", { simple: true }) as number;
    if (schemaVersion > 2) {
      this.database.close();
      throw new Error(`mesh database schema ${schemaVersion} is newer than this runtime supports`);
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL
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
      PRAGMA user_version = 2;
    `);
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
    this.messages.set(message.id, message);
    this.database?.prepare(`
      INSERT INTO messages (id, record) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(message.id, JSON.stringify(message));
  }

  deleteMessage(messageId: string): void {
    this.messages.delete(messageId);
    this.database?.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
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
    const messageRows = this.database.prepare("SELECT record FROM messages").all() as Array<{ record: string }>;
    const workflowRows = this.database.prepare("SELECT record FROM workflow_runs").all() as Array<{ record: string }>;
    const journalRows = this.database.prepare("SELECT record FROM workflow_journal").all() as Array<{ record: string }>;
    for (const row of agentRows) {
      const agent = JSON.parse(row.record) as StoredAgent;
      this.agents.set(agent.id, agent);
    }
    for (const row of messageRows) {
      const message = JSON.parse(row.record) as MessageRecord;
      this.messages.set(message.id, message);
    }
    for (const row of workflowRows) {
      const run = JSON.parse(row.record) as WorkflowRun;
      this.workflowRuns.set(run.id, run);
    }
    for (const row of journalRows) {
      const entry = JSON.parse(row.record) as WorkflowJournalEntry;
      this.journal.set(entry.id, entry);
    }
  }
}
