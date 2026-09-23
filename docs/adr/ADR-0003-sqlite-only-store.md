---
schema: "kxm.doc.v1"
id: "ADR-0003"
type: "adr"
title: "SQLite as the only store"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-17"
updated: "2026-09-23"
authority: "decision"
confidence: "verified"
summary: "Every KXM store is a local SQLite database owned by one process; DuckDB and database servers are rejected as the system of record."
tags: ["architecture", "decision", "storage", "sqlite"]
related: ["docs/concepts/data-and-storage.md", "docs/concepts/architecture.md", "docs/contracts/architecture.md"]
details:
  decision_drivers:
    - "Many small durable reads and writes owned by one process"
    - "No native dependencies in any install"
    - "Must run in Node.js and in Pi's embedded Bun runtime"
    - "Single-node deployment with no clustering or failover"
  supersedes: null
  superseded_by: null
---

# ADR-0003: SQLite as the only store

## Status

Accepted. This record replaces the research note "Storage engine: SQLite vs DuckDB".

## Context

KXM persists state in three places: the hub store (agents, messages, workflow runs, the journal, context, leases, and sync events), the Runtime registry, and one Runtime event store per project. All three are written by a single owning process and read by a few local readers.

The question came up whether KXM should use DuckDB. The premise was inverted: KXM already used SQLite everywhere, and no DuckDB code existed. The real question was whether DuckDB, or any other engine, should become the system of record.

The workload has a clear shape:

- **Transactional, not analytical.** Sending, delivering, and replying to messages, advancing cursors, appending run events, and moving run state are small point reads and writes by ID.
- **One owner per database.** The hub owns its file, and the Runtime owns the registry and each event store. KXM's production boundary is one process per database, with no clustering, leader election, or shared-state failover.
- **Two JavaScript runtimes.** The CLI, hub, and Runtime run on Node.js. The Pi extension runs inside Pi's embedded Bun runtime, which has no `node:sqlite`.

## Decision drivers

1. Match the storage engine to a small-write, single-writer workload.
2. Add no native dependency to any install and no build step.
3. Run unchanged in Node.js and in Bun.
4. Keep the single-node boundary simple to operate, back up, and restore.

## Considered options

- **Option A: SQLite.** Node's built-in `node:sqlite`, with `bun:sqlite` as the fallback inside Pi.
- **Option B: DuckDB** as the primary store.
- **Option C: a separate database server**, such as PostgreSQL.

### Option A: SQLite (chosen)

- Good, because its design center is embedded, transactional, single-writer storage with point queries, which is KXM's workload.
- Good, because the supported Node.js versions and Bun ship it built in: no native dependency and no build step.
- Good, because WAL mode gives concurrent local readers while one process writes.
- Bad, because one database cannot be shared by several hub processes. KXM accepts that; it is the single-node boundary.

### Option B: DuckDB

- Good, because it is fast at analytical scans over large, columnar datasets.
- Bad, because that is the wrong workload for a message bus and an event log, and its concurrency model does not improve on SQLite's single writer.
- Bad, because it adds a large native dependency to every install for no transactional benefit.

### Option C: a separate database server

- Good, because it could serve several hub processes.
- Bad, because it adds a service to install, secure, and back up, which contradicts a local-first tool that runs on one machine.
- Bad, because KXM does not cluster hubs, so the extra capability would go unused.

## Decision

Every KXM store is a SQLite database owned by exactly one process:

- The hub store, the Runtime registry, and each Runtime event store use `STRICT` tables and record their schema version in `user_version`.
- Every store opens in WAL mode with a busy timeout, `synchronous=NORMAL`, and foreign keys on, and refuses a database or sidecar that is a symbolic link.
- A store whose version is older or newer than the running build is refused, not migrated. The owner recreates it after the operator deletes it.

## Consequences

- KXM installs anywhere a supported Node.js runs, with no database service to operate.
- A backup is a consistent file copy made with SQLite's `VACUUM INTO`, with no dump format to maintain.
- Scaling out means running more independent hubs, one per trust domain, not more processes per hub.
- Upgrading across a store version discards that store's history unless the operator backs it up first. [Data and storage](../concepts/data-and-storage.md#schema-versions-refuse-do-not-migrate) describes the procedure.

### Where a columnar engine could fit later

Analytics over exported, append-only data, such as routing and cost reports, could outgrow SQLite queries. The right shape then is a periodic export to a separate DuckDB file used read-only for analysis. It would never become the hub's or the Runtime's system of record.

## Related

- [Data and storage](../concepts/data-and-storage.md)
- [Architecture](../concepts/architecture.md)
- [ADR-001: Local Runtime, project authority, and aggregate hub](../contracts/architecture.md)
- [Architecture decision records](README.md)
