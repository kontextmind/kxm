# WeKnora → KXM: document knowledge components

**Category:** enterprise document/RAG application and optional extraction components. **Priority:** high for M5/M7 design evidence; conditional for a managed extraction runtime. **Disposition:** adapt selected contracts and algorithms; do not make its complete service stack a prerequisite for KXM.

Static review pins `kontextmind/WeKnora` at **1ef38fdb8b19347b82d3a99f6f17d75ac09ad606** and KXM at **5ff9f642e82d7a1e52aeab9245282d89560bb535**. GitHub API and completed local checkout matched. No software, services, models, or tests were executed. Scope follows the unified M0–M9 plan and runtime-language research: one KXM installation, shared TypeScript services, thin harness adapters, and explicitly managed optional components.

## Actual overlap and useful differences

KXM already has project-scoped recall, provenance, reviewed state proposals, and a deterministic wiki. Its current recall route filters summary/state-key substrings and sorts by ID; the provider request carries project/kinds/limit but no query. That is a concrete retrieval extension point, not an absent context system. Its wiki prints record/source/lineage references and explicitly remains a compiled view. [KXM recall](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/hub.ts#L1599-L1617), [provider contracts](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/context/providers.ts#L16-L63), [wiki](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/wiki.ts#L64-L104).

WeKnora contributes a real parser protocol with Markdown, images, metadata, and parser availability; its search pipeline explicitly distinguishes embedding failure from empty recall and degrades only eligible targets to keywords. These are more useful than copying its autonomous agent or model orchestration into KXM. [Parser protocol](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/docreader/proto/docreader.proto#L7-L82), [search degradation](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/application/service/chat_pipeline/search.go#L413-L440).

## Recommended adaptations

### 1. A managed extraction capability — M1/M5/M7/M9, medium–large

Add `plugins/kxm/src/documents.ts` and an internal `context/document-ingest.ts`, reached through existing CLI/MCP/native adapters. Return source hash, parser/version, sections, table/image references, source locations, and explicit omissions. Keep generated text as evidence; document contents cannot install skills or grant policy authority.

Evaluate the locked Python reader and a narrow Rust executable against the same PDF, scanned-PDF, DOCX, spreadsheet, and malformed-file corpus. WeKnora uses both: Python packages under `uv.lock`, and AnyDoc 0.1.9 through a patched Rust static library linked into Go. Its Go reader records parser/version and handles OCR fallback and partial image failure. This demonstrates specialized components, not a reason to rewrite KXM in Go or add a Node native binding. [Rust binding](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/third_party/anydoc-go/Cargo.toml#L1-L31), [reader](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/infrastructure/docparser/anydoc_reader.go#L41-L108).

**Acceptance:** reproducible fixture outputs and provenance; unsupported/OCR-required results stay explicit; network-disabled operation never downloads a parser/model; Windows and Linux installations need no compiler; helper absence produces actionable readiness. Measure accuracy, latency, memory, and package size before choosing Python versus Rust. Remote OCR requires configured authorization and cannot silently incur charges.

### 2. Ranked retrieval with complete citation receipts — M0/M5/M8, medium

Extend `context/providers.ts` with query and typed availability/partial-result fields; implement indexed retrieval behind the existing `hub.ts` route. Start with local keyword ranking; embeddings/reranking remain optional capabilities. Bind every result to project, document hash, chunk identity, and source offsets. Preserve the current arbiter and authorization checks.

WeKnora's citation materializer silently drops unresolved chunks after upstream logging. KXM should retain unresolved citation IDs in the response so a fluent answer cannot conceal incomplete evidence. [Citation resolution](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/application/service/wiki_ingest_cite.go#L397-L423).

**Acceptance:** multi-term queries rank relevant fixtures above unrelated ID order; no cross-project hits; changed documents invalidate stale offsets; repeated local queries are deterministic; embedding outages differ from zero matches; missing cited chunks appear as explicit gaps. No provider exception may broaden scope or choose an unconfigured paid provider.

### 3. Reviewable knowledge updates with atomic history — M5/M6/M7/M8, medium

Extend `wiki.ts` and the existing review/proposal path in `hub.ts` and `store.ts` only where source revision, affected claims, or a human-readable diff are missing; do not create a parallel approval store. WeKnora atomically snapshots the previous page with its replacement and bounds history. Transfer that transaction pattern to KXM's reviewed records, then regenerate the wiki; direct wiki edits must not become authoritative state. [Atomic revisions](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/application/service/wiki_page.go#L169-L185).

**Acceptance:** source refresh produces a proposal without changing approved state; reject preserves the current wiki; approve records actor and evidence atomically; rollback creates a new revision; failed writes leave neither orphan snapshots nor partial promotion; conflicting or missing sources remain visible. This also supports later connector refreshes without treating imported documents as instructions.

### 4. Bounded extraction progress and exact cancellation — M0/M2/M3/M7, medium–large

Extend `runtime-store.ts` for sequenced extraction events and `oneshot-process.ts` for bounded live frames while preserving its existing output limits, abort handling, and observed-exit evidence. KXM already has process settlement machinery; its current collector buffers output until completion. [Existing runner](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/oneshot-process.ts#L49-L145).

Do not mistake WeKnora's `ReadStream` for incremental parsing: it completes `_parse_request` before yielding all Markdown metadata, then image frames. Its Redis replay fetches all remaining events, and the owner-checked stop endpoint marks a stop request `Done` before settlement. Useful patterns require tighter KXM semantics. [Parse-before-stream](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/docreader/main.py#L226-L267), [unbounded replay batch](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/stream/redis_manager.go#L106-L121), [owner-scoped stop](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/handler/session/stream.go#L261-L310).

**Acceptance:** bounded frame/replay sizes, reconnect without duplicated durable events, cancellation during parsing, correct session ownership, and separate stop-requested/settled outcomes. Viewer disconnection must not implicitly cancel work. Verify child cleanup on Windows separately; the existing process-group path is POSIX-specific.

## Integration, deployment, and licensing

Use an optional HTTP/gRPC adapter only for users already operating WeKnora; a Go SDK is not a TypeScript drop-in. Its composed application includes frontend, Go app, document reader, PostgreSQL/ParadeDB, and Redis, with further optional services. The reader's internal gRPC port is unexposed by default and authentication/TLS are configurable. Preserve that boundary rather than exposing a parser casually. [Reader deployment](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/docker-compose.yml#L398-L435), [database/cache](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/docker-compose.yml#L521-L548).

`uv` does not erase runtime costs: the container installs Java, LibreOffice, and other native libraries; its `uv` installer itself is unpinned despite locked Python dependencies. Any selected helper needs KXM-managed versioning, health, removal, and platform artifacts. [Build/runtime requirements](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/docker/Dockerfile.docreader#L66-L112). Own code is MIT; bundled components retain distinct obligations, including MPL notices/source. Audit the selected dependency closure before redistribution. [License](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/LICENSE#L1-L19), [third-party notices](https://github.com/kontextmind/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/THIRD_PARTY_NOTICES.md#L1-L37).

M4 remains KXM's existing browser boundary for URL acquisition; no second browser or scheduler is justified. M9 must verify identical capability and evidence contracts from one installed package across harnesses. These are proposed acceptance gates, not claims that milestones passed.
