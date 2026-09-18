---
schema: "kxm.doc.v1"
id: "KB-HUB-004"
type: "kb"
title: "Q&A: Storage engine — SQLite vs DuckDB"
project: "kxm"
status: "draft"
owner: "@operator"
created: "2026-09-17"
updated: "2026-09-18"
authority: "instruction"
confidence: "reviewed"
summary: "The hub already uses SQLite; there is no DuckDB in this repository, and DuckDB should not become the hub's primary store."
tags: ["hub", "sqlite", "storage"]
related: ["docs/operations.md", "docs/kb/qa-what-the-hub-stores.md"]
---

# Q&A: Storage engine — SQLite vs DuckDB

> Answered by root from direct repo evidence · 2026-09-17 · task_279246b4dddb

**Q: Would you recommend replacing DuckDB for SQLite?**

**A: The premise is inverted — the hub already uses SQLite. There is no DuckDB anywhere in this repository** (`rg -i duckdb` returns zero matches). The storage engine today is:

- `plugins/kxm/src/sqlite.ts` — "Runtime-portable SQLite constructor. Prefers Node's built-in `node:sqlite` (the supported runtime for the kxm CLI). Pi loads extensions inside its embedded Bun runtime, which does not provide `node:sqlite`, so fall back to Bun's `bun:sqlite` there."
- Every store builds on `DatabaseSync` from that wrapper: `store.ts` (agents, messages, consumer_cursors, agent_sequences, workflow_runs, workflow_journal, context_items), `runtime-store.ts` (supervisor, projects, runs, events, commands, run_plans), `external-effects.ts` (external_effects).

**If the real question is "should we ever move to DuckDB?" — no, not as the hub's primary store:**

1. **Workload shape.** The hub is OLTP: many small durable reads/writes (message send/deliver/reply, consumer cursors, run state transitions), single-process ownership, WAL mode, point queries by id. That is exactly SQLite's design center. DuckDB is an in-process OLAP/columnar engine built for analytical scans over large datasets — the wrong tool for a message bus.
2. **Architecture fit.** The README's production boundary is "one process owns one SQLite database; no clustering, leader election, or shared-state failover." SQLite's single-writer model matches that boundary exactly; DuckDB's concurrency model (single writer, bulk loads) does not improve it.
3. **Runtime fit.** `node:sqlite` is built into Node 22.19+/24 (the documented engines range) and `bun:sqlite` covers Pi's embedded Bun — zero native dependencies, no build step. DuckDB would add a large native dependency to every install for no OLTP benefit.

**Where DuckDB (or any columnar engine) could make sense later:** analytics over exported telemetry — the routing/cost reports (`kxm routing report`, `just observe-cost`) scan append-only event/journal data. If those scans outgrow SQLite queries, the right shape is a periodic export to a DuckDB file used read-only for analysis, never as the hub's system of record.
