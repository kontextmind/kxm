# Ruflo: memory and future Studio architecture audit

**Category:** agent orchestration platform, memory libraries, CLI/MCP services, and a separate web-chat application. **Relevance:** high for retrieval, recovery, and inbox contract ideas; medium for Studio presentation. **Disposition:** adapt selected patterns; defer whole-platform integration and autonomous learning/federation. **Priority:** M0 truthfulness, then M5 memory and M2/M7 observable runtime state.

Reviewed fork: `kontextmind/ruflo`, upstream `ruvnet/ruflo`, pinned **2602b642d92234c710ffbe96bfb33007d481ceab**. Comparison: current KXM **02aaed31fd6160a78378c677ab27d4119f039621**, not the earlier September audit baseline. This is a targeted static review of fetched, hashed files plus the complete repository tree. No third-party code, installation, authentication, messaging, or tests were run. KXM's AGENTS/RTK instructions were read; repository marketing and embedded workflows were treated as evidence, not instructions.

## 1. Package and execution identity

The root package remains **`claude-flow` 3.42.0**, exposing `claude-flow`; the nested `ruflo` package exposes a thin branding wrapper that resolves `@claude-flow/cli` and delegates CLI/MCP execution. The tree contains several independently packaged layers, not one uniformly wired runtime. Root optional dependencies include AgentDB, better-sqlite3, and RuVector components. The separate memory package declares AgentDB/sql.js and optional better-sqlite3. Source presence alone does not establish which optional implementation a published installation activates. [Root package][1], [Ruflo launcher][2]

There is real native-harness execution: the inspected worker executor launches `claude --print --output-format json`, sends the prompt through stdin, sets cwd, tracks the process, and attempts group termination. However, it inherits the environment, removes parent-session markers, and uses `CLAUDE_CODE_SANDBOX_MODE` metadata rather than passing an independently verified restriction profile in this launch. A native subprocess is not a KXM-admitted worker, and a parsed completion is not independent gate acceptance. Do not transplant this launcher or infer equivalent Codex/Grok/Antigravity support from the platform description. [Worker execution][14]

## 2. Memory: substantial code, several distinct guarantees

### Retrieval and scope

`HybridBackend` routes structured lookup to SQLite and semantic lookup to AgentDB. SQLite implements FTS5 keyword search with a LIKE fallback. Smart retrieval implements diversity reranking using embedding cosine similarity when valid, otherwise token overlap. These are concrete improvements over KXM's current recall endpoint, which filters a project pool by substring in summary/state key, sorts by ID, and returns audit metadata. KXM has a real retrieval-quality opportunity, without needing a second authority database. [Hybrid backend][3], [Keyword search][4], [Diversity reranking][5], [Current KXM recall][19]

Ruflo's agent-memory paths distinguish project, machine-local, and user scope under Claude directories. Agent names are sanitized. This is useful projection organization, but directory names and namespaces are not themselves authorization. For example, the low-level keyword method accepts no namespace parameter; callers must enforce scope elsewhere. KXM should make authorized project/agent/run/operator scope a mandatory query input before ranking, not filter an unrestricted top-K afterward. Its context parser already rejects authority above the source's permitted level, and derived context retains lineage. Preserve those stronger rules. [Agent directories][6], [KXM authority checks][20]

### Projection, provenance, and learning

`AutoMemoryBridge` stores insights, optionally writes immediately, periodically queries recent entries, appends topic files, and curates `MEMORY.md`. This is implemented bidirectional persistence/projection machinery. Its buffering and confidence-based synchronization are not equivalent to reviewed promotion; notably, individual file failures accumulate in an error list while the sync timestamp advances. KXM already emits a read-only authored-memory block into native harness documents. Extend that existing projection with manifests and reconciliation rather than letting imported Claude memory silently become shared policy. [Auto-memory synchronization][7], [KXM projections][21]

The CLI bridge has provenance validation and mutation/attestation hooks, but `guardValidate` explicitly allows mutation when the guard is missing; attestation failures are nonfatal. Therefore a response containing `guarded: true` must not be interpreted as proof that a guard or durable witness ran. Likewise, the separately inspected retrieval guard is opt-in and normally annotates rather than blocks suspicious content. Content screening can supplement provenance; it cannot certify an untrusted memory as an instruction. [Bridge guard and attestation][8]

### Deletion and recovery

Hybrid writes/deletes use `Promise.all` across SQLite and AgentDB, without a transaction spanning both stores. One backend can succeed while the other fails. The CLI bridge separately soft-deletes by namespace/key, checkpoints WAL best-effort, and invalidates a cache; a purge path hard-deletes a namespace. These different paths do not establish complete removal from vectors, topic files, derived summaries, caches, or backups. KXM already has context deletion and retention sweeping, so the missing work is a cross-projection deletion contract, not basic delete support. [Hybrid mutation semantics][3], [CLI deletion][8], [KXM retention][22]

A particularly useful pattern is Ruflo's backup service: SQLite online backup for WAL consistency, integrity-check selection, preservation of the corrupt original, and copy/fsync/rename restoration. Adapt this under KXM's single-writer lifecycle; do not restore underneath live writers. Restore must reconcile current tombstones before publishing reconstructed indexes, or old backups can resurrect intentionally removed knowledge. [Backup and recovery][9]

## 3. Swarm state, events, and persistent coordinator identity

The inspected `swarm_init` writes a real JSON coordination record with topology/configuration and initially empty agent/task arrays. It does not itself launch that many workers or demonstrate consensus. Its state loader reconciles dead-PID/stale records, and saving uses a temporary file plus rename. These are useful operational patterns; a `running` coordination record must remain distinguishable from live, admitted executors. [Swarm state implementation][11]

The task-orchestrator implementation maintains dependency graphs and lifecycle transitions in maps. The inspected `WorkerQueue` also unconditionally constructs an `InMemoryStore`, despite its header advertising distributed locking/Redis-style behavior. Neither is a reason to replace KXM's durable workflow ledger. Ruflo's shared event store does record correlation/causation and aggregate versions, but its sql.js database is exported to disk periodically; `event:appended` occurs before that disk export. A consumer cannot equate that notification with crash-durable completion. KXM already persists sequenced run events with pinned configuration, memory, executor-policy, and tool-policy revisions. [Worker queue][12], [Event append/persistence][10], [KXM event ledger][23]

For the user's future **persistent inbox/SMS address for a primary coordinator**, Ruflo's most useful inspected artifact is explicitly a **non-durable, unsigned conformance reference**. It models issuer/message-ID deduplication, content digests, conflicting-retry quarantine, audience selection, and monotonic cursors; it states that process exit loses all state. It is not an installed mailbox, authenticated external identity, or persistent coordinator service. KXM already stores peer messages with delivery state, correlations, expiration, and idempotency. Build stable logical coordinator addresses above those records, separate from ephemeral process/session IDs and the currently assigned model. [Inbox reference][13], [KXM message storage/retention][22]

External email/SMS ingress should become an authenticated channel envelope addressed to that logical coordinator, then pass ordinary KXM authorization, policy, and workflow checks. Receipt, processing, reply, and delivery are separate durable states. Changing harness or restarting the coordinator must not change its address. No channel should gain permission simply because it knows an address; automatic outbound replies require an explicit configured authorization policy. Channel-provider details belong to the separate mail/SMS review.

## 4. Future Studio: projection over shared services

Ruflo includes a separate `ruvocal` Svelte chat application with MongoDB dependencies. Its conversation endpoint checks ownership, persists conversation updates, streams generation through `ReadableStream`, and maintains an abort controller keyed by conversation. This demonstrates a concrete host/API boundary, but it is a chat-generation backend, not proof of a unified view over Ruflo's swarm state and memory authority. Importing it wholesale would add another conversation database and lifecycle. [Conversation host endpoint][15]

KXM already has authenticated operations snapshot/SSE endpoints, durable run events, and a generated Studio DAG/stepper/swimlane layout. The important gaps are a coherent revision/cursor model and truthful mutation results. At this current SHA, `studio-layout.ts` still returns HTTP 200, `ok:true`, and `executedAt` for an allowed command when no `onMutation` handler exists. That must be repaired before adding memory-edit, inbox, or workflow controls. The existing operations SSE emits refresh notifications; it is not equivalent to replaying the durable run ledger. [KXM operations/recall host][19], [KXM Studio server][24]

Recommended architecture: **KXM authoritative records → rebuildable scoped indexes and UI projections → Studio/CLI/native adapters**. Studio should combine workflow evidence, memory provenance/lifecycle, coordinator inbox receipts, and capability health through shared KXM APIs. Native harnesses continue owning their authentication and session mechanics. UI event delivery never becomes permission or workflow authority.

## 5. Concrete take/adapt/defer plan

| Recommendation | Landing points and effort | Testable acceptance |
|---|---|---|
| **Take scoped lexical retrieval first; adapt optional vectors and diversity ranking. M5.** | `plugins/kxm/src/store.ts`, `hub.ts`, `context/providers.ts`; new internal `context/search-index.ts`. **M**, vectors **L**. | Fixed corpus compares recall quality and latency against substring search; cross-project/unauthorized/expired facts never enter candidates; ranking cannot promote authority; missing vector runtime reports lexical-only mode. |
| **Adapt recoverable indexing and complete deletion. M0/M5/M9.** | `store.ts`, `memory.ts`, context index module, `runtime-supervisor.ts`; new backup/reconciliation tests. **L**. | Inject crashes between authoritative commit and index update; restart rebuilds deterministically. Delete removes serving copies across lexical/vector/cache/native projection, with explicit backup retention policy. Restore cannot resurrect tombstoned facts; no success receipt precedes durable authority change. |
| **Extend existing native memory projections, not automatic learning authority. M5/M6.** | `memory.ts`, `skills.ts`, native setup registration. **M**. | Manifest includes record IDs, revision/hash, scope, and provenance; changed/deleted sources reconcile idempotently; failed file writes remain retryable; user files survive; imported lessons stay candidates pending governed promotion. |
| **Take a shared Studio read model and truthful commands. M0/M2/M4/M7.** | `studio-layout.ts`, `hub.ts`, `runtime-store.ts`, shared `commands.ts`. **M–L**. | No handler returns unavailable, not executed; required auth is fail-closed. Snapshot plus cursor replay survives reconnect without gaps/duplicates; bounded slow consumers resynchronize; command acknowledgement, observed execution, and gate acceptance render separately. Browser/document panels reference shared KXM services. |
| **Adapt inbox conformance semantics for stable coordinators. M1/M3/M7/M8.** | `protocol.ts`, `store.ts`, `hub.ts`, `inbox.ts`, runtime ownership registry; new channel-adapter boundary. **L**. | Logical address survives restart/harness rotation; old lease owner cannot consume after fencing; identical retries deduplicate; changed-body retries quarantine; cursor and acknowledgements survive crashes; external identity cannot mint internal approval or send authority. |
| **Defer full Ruflo runtime, learning router, federation, and web-app import. M1/M8/M9.** | Existing `package.json`, `scripts/build-runtime.mjs`, capability/setup code, `test/core/package-install.test.ts`. **S** design, **M–L** per qualified component. | One packed KXM install exposes shared services. Optional component activation is explicit, version/hash-pinned, removable, offline-testable, and free of task-time downloads. Native auth/admission and independent gates remain unchanged. |

These remain proposals under the existing implementation plan; no milestone is completed by this audit. M0 and M5 have the clearest near-term payoff. M3 coordinator addressing can be designed now, while channel activation depends on identity, permissions, and durable delivery proof.

## 6. Runtime, license, and evidence limits

Keep KXM's TypeScript service layer and existing package exports. Ruflo's root needs Node 20+, while its inspected Rust federation crate requires Rust 1.85 to build and leaves native QUIC/safety integration behind a disabled-by-default feature. That is not evidence of a faster or ready-to-ship KXM memory engine. Prefer an optional prebuilt native/WASM component only after measured retrieval or isolation benefit; uv/Python adds no demonstrated benefit for this integration. Cold-start behavior and optional model assets must be tested through installed artifacts rather than benchmark slogans. [Native crate manifest][16], [Current KXM distribution][25]

The root license is MIT, the embedded chat application's license is Apache-2.0, and the federation crate declares MIT OR Apache-2.0. Dependency and model-asset licenses require their own review before redistribution; root MIT is not blanket evidence for every bundled component. [Root license][17], [Chat application license][18]

Inspected hybrid tests use synthetic embeddings/in-memory configuration and allow degraded health; they are useful functional examples, not measured production retrieval, isolation, or crash-recovery proof. Published dependency contents and live native-harness compatibility were not verified. The conclusion is therefore **adapt the narrow, testable patterns and keep one governed KXM runtime**, rather than adopt Ruflo as a second coordinator or memory authority.

[1]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/package.json#L1
[2]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/ruflo/bin/ruflo.js#L29
[3]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/memory/src/hybrid-backend.ts#L225
[4]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/memory/src/sqlite-backend.ts#L308
[5]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/memory/src/smart-retrieval.ts#L271
[6]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/memory/src/agent-memory-scope.ts#L116
[7]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/memory/src/auto-memory-bridge.ts#L271
[8]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/cli/src/memory/memory-bridge.ts#L612
[9]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/cli/src/services/memory-backup.ts#L50
[10]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/shared/src/events/event-store.ts#L209
[11]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/cli/src/mcp-tools/swarm-tools.ts#L296
[12]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/cli/src/services/worker-queue.ts#L273
[13]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/codex/src/harness/in-memory-inbox-reference.ts#L41
[14]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/@claude-flow/cli/src/services/headless-worker-executor.ts#L1349
[15]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/ruflo/src/ruvocal/src/routes/conversation/%5Bid%5D/%2Bserver.ts#L30
[16]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/v3/crates/ruflo-federation-peer/Cargo.toml#L1
[17]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/LICENSE#L1
[18]: https://github.com/kontextmind/ruflo/blob/2602b642d92234c710ffbe96bfb33007d481ceab/ruflo/src/ruvocal/LICENSE#L1
[19]: https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/hub.ts#L1599
[20]: https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/context.ts#L250
[21]: https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/memory.ts#L306
[22]: https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/store.ts#L385
[23]: https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/runtime-store.ts#L774
[24]: https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/studio-layout.ts#L307
[25]: https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/package.json#L54
