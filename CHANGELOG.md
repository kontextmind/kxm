# Changelog

All notable user-facing changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Changed

- Renamed the operator CLI from `pi-mesh` to `kxm` and rebuilt it on Commander.
- `kxm` now has first-class tools: `agent`, `session`, `workflow`, `gate`, and `mesh`.
- Examples: `kxm agent worker`, `kxm session status`, `kxm workflow start`, `kxm gate validate`, `kxm mesh hub`.
- Agents (AI-driven) and gates (code-driven) share `kxm.worker.v1` and emit `kxm.worker-result.v1`.
- Source equivalent is `node scripts/kxm.mjs`. Hub startup output is `kxm mesh hub listening`.
- Added a live `@earendil-works/pi-tui` mesh dashboard with responsive toggle panels and authenticated metadata-only operations SSE for real-time agent/message/workflow state; the Node 22 minimum is now 22.19 to match the TUI runtime.
- Long-lived Pi workers now leave waiting work queued in the hub, activate one message at a time, prioritize safe steering, normalize autonomous `nextTurn`, and restart when a delivered message never starts.
- Workflow validation mirrors the hub's file/inline XOR source contract; active definitions supply start/callback credentials, with the start secret as callback fallback.
- Added the runnable `artifacts-exist` gate, fail-closed roster/session parsing, secret-free workflow definition hashes, and dry-run telemetry suppression.

## 0.4.3 - 2026-08-26

### Added

- Per-requirement `peer-reply` evidence policies with run-start eligible-producer snapshots, immutable run/stage/requirement/attempt message context, hub-verified message references, and quorum by unique stable producer ID.
- Explicit admin-only, policy-declared, current-attempt quorum degradation through `pi-mesh workflow degrade`, including durable approval and degraded-stage audit records.
- Optional metadata-only peer-evidence audit fields in `pi-mesh.retrospective.v1`, preserving producer/context/timestamp/hash provenance and degradation approvals without prompt or reply bodies.
- Command-first provenance workflow example plus security, operations, protocol, troubleshooting, and trust-boundary guidance.

### Changed

- Pi extension and Claude MCP send/fanout tools accept `workflowContext`; checkpoint and wait tools accept `evidenceRefs` with matching behavior across both harnesses.
- Caller-authored evidence strings, correlation IDs, and idempotency keys cannot satisfy a declared peer policy. Only exact durable replied messages for the active workflow context count.
- Long-lived workers can opt into path-delimited exact extension and skill sets. Each configured category disables discovery, validates resource types before supervision, and leaves default discovery unchanged when unset.
- Final provider failures no longer settle durable inbound work as a successful peer reply. The Pi extension retains the message and records metadata-only diagnostics; supervised workers restart after graceful RPC shutdown and can rotate through bounded fallback models while preserving session context.
- Long-lived workers support an explicit Pi tool allowlist and a bounded tool-execution watchdog. This lets read-only review peers operate without shell/write capabilities and recovers delivered work when an enabled tool never returns. The default watchdog includes one minute of supervisor grace beyond the longest local mesh wait.
- Worker-owned PID, control, recovery, context, and default log paths use a collision-resistant identity derived from the exact project and agent name; legacy name-only recovery files migrate only when their embedded owner matches exactly.

### Fixed

- Workflow-context retries canonicalize field order and requirement-key spelling before hashing and compare hub state field-by-field, so semantically identical objects reuse one durable request while context-free retries retain their pre-0.4.3 hash.
- Typed workflow definitions may omit `acceptedStatuses`, matching the JSON parser and documented default of `["replied"]`.
- Supervised Pi restarts revalidate every exact extension and skill path and stop on static resource drift instead of silently restarting without a required skill.
- The release dogfood launcher separates administrative and worker project credentials, withholds webhook secrets from agents, and proves exact coordinator/reviewer readiness before starting a run.
- `--fresh-start` skips only the initial session resume, while later supervised recovery can use `--continue`; final quota/provider errors wait for Pi's own retries, preserve durable work, and use a configurable provider retry delay when no fallback remains.
- Hub and worker wrappers claim their PID files exclusively, refuse unverifiable stale claims, and clean up only their own recorded generation, so duplicate starts and sanitized-name collisions cannot orphan the process managed by `pi-mesh stop`.
- RPC supervision handles oversized provider and tool frames with bounded streaming metadata extraction. Raw RPC bytes stay only in the protected agent log and are never forwarded to supervisor stdout or structured lifecycle logs.
- Structurally unresumable settled sessions take the fresh-session path before provider rotation, while completed oversized tool results still cancel their watchdog.
- Recovery telemetry is attached only to its exact persisted workflow run. Unbound worker events are consumed without guessing an active workflow, and fresh provider/tool-timeout recovery relies on one durable inbound replay instead of injecting a duplicate turn.
- The release launcher reuses one delivery ID across workflow-start retries and requires a deterministic run/stage/attempt fanout key with a local wait below the supervisor watchdog.

### Upgrade note

- Provenance fields are additive inside existing SQLite schema-v2 JSON records; no destructive database migration is required and existing history remains readable. Legacy evidence continues to work for ordinary requirements but never satisfies a declared peer policy.
- Peer quorum proves durable provenance within the shared project-credential boundary. It does not prove truth, model identity, independent inference, non-collusion, or human approval.

## 0.4.2 - 2026-08-26

### Fixed

- Fan-out local wait deadlines and caller aborts now return recoverable `pending` results with the durable message ID, current hub status, expiry, and wait outcome instead of a terminal-looking error that encouraged duplicate work.
- Fan-out performs a final status read at the wait boundary, preserves request handles after a successful send, and accepts Pi or Claude MCP cancellation signals without cancelling the durable request.
- Pi workers now reconcile expired or cancelled active requests, skip terminal queued work, automatically retry transient settlement failures with capped backoff, and always release terminal settlement state so the next valid request can run.
- Claude MCP inboxes now reconcile missed terminal events, evict expired and cancelled requests, survive reconnect/restart through delivered-message replay, and remove terminal reply races instead of presenting stale work.
- The real multi-Pi smoke harness no longer shortens message TTL to its local phase timeout.

### Changed

- Operator guidance now distinguishes message TTL from local wait duration, recommends the 24-hour default for model work, and requires `mesh_get` or an exact idempotent retry while a peer remains pending.
- Pending peers explicitly do not count as planning, review, or workflow-checkpoint evidence.

### Upgrade note

- `mesh_fanout` adds the nonterminal `pending` result state and the optional `messageStatus`, `expiresAt`, and `waitStatus` fields. Consumers that exhaustively switch on result status should handle `pending` by inspecting the returned message ID rather than dispatching a replacement request.

## 0.4.1 - 2026-08-26

### Fixed

- Signed workflow callbacks now reject any supplied `workflow.run`, `workflow.stage`, or `workflow.signal` evidence that disagrees with the callback route or active wait, without advancing or recording the rejected delivery.
- Operator installation guidance now distinguishes Pi's extension-and-skill Git install from the PATH CLI and uses the authenticated packed release asset for command-first setup.

## 0.4.0 - 2026-08-26

### Added

- Additive `pi-mesh` operator CLI for workspace init, validation, status, dry-run workflow planning, GitHub check watching, and retrospective export.
- Allowlisted diagnostic classification for failed workflow tools and 401/403 identity-scope errors, including bounded `operation`, `nextAction`, and assigned coordinator name.
- Command-first GitHub check watcher that posts the existing signed workflow signal, binds evidence to the exact run/stage/signal key, and posts `github_watch_timeout` as failed before exiting 4.
- Worker drain, `--continue` fallback, and a redacted recovery envelope under `.kxm/state`.
- Atomic Markdown/JSON retrospective export under `.kxm/assets/retrospectives` with `reviewDecision=proposed`.
- Opt-in real multi-Pi release harness that launches two authenticated Pi RPC workers in an isolated `.kxm`, verifies discovery, request/reply, fanout, durable restart/resume, journal, and checkpoint flows, and skips only when Pi or model credentials are unavailable.

### Changed

- Failed-tool journal summaries now include an allowlisted diagnostic class instead of a generic "tool failed" sentence.
- Long-lived workers wait longer for a graceful SIGTERM drain and retry once without `--continue` after a fast failure.
- The npm artifact now ships self-contained JavaScript runtimes for `pi-mesh` and `pi-mesh-hub`, so installed commands do not depend on Node stripping TypeScript inside `node_modules`.
- Workflow gates now accumulate evidence by normalized requirement identity across local waits and passing callbacks; unrelated check or context volume cannot satisfy a missing review, artifact, or retrospective requirement.
- Generated-runtime CI now rejects missing, untracked, or stale CLI, hub, and MCP artifacts after rebuilding them.
- GitHub watching requests complete 100-item check-run pages, treats `startup_failure` as failed, and uses a new delivery generation for each watcher invocation while preserving one ID across its transport retries.
- Default `pi-mesh signal` delivery IDs are unique per command invocation so a corrected callback after re-waiting cannot conflict with the prior failed attempt.

### Upgrade note

- Extra 401/403 JSON fields are additive. 0.3.1 clients ignore them. Coordinator journal writes after a failed run remain allowed; checkpoints and waits still require a running or waiting run.
- Workflow checkpoint, wait, callback, and `pi-mesh signal` evidence changed from string arrays to keyed string objects. Use the canonical `requiredEvidence` value as each key. Pre-0.4 array evidence remains readable for history but does not satisfy a new keyed gate.

## 0.3.1 - 2026-08-26

### Added

- Durable external workflow waits that safely release coordinator turns and resume from signed CI, review, merge, or Jira result callbacks.
- Retry-deduplicated signal receipts, bounded wait deadlines, timeout journaling, and optional least-privilege callback secrets.
- Atomic signal transitions, minimal callback-secret responses, and durable timeout notifications to the coordinator.
- `mesh_workflow_wait` for Pi and Claude plus an executable signed callback example.
- Canonical `.kxm` workspace directories for tracked configuration and assets, ignored logs and state, and persisted hub/worker log files.
- Retry and nonzero failure handling when a long-lived worker cannot spawn Pi.
- Windows-safe long-lived worker launch through `ComSpec` for Pi command scripts.
- Cross-platform CI at the exact Node 22.13 floor and current Node 24 release.
- Bounded peer replies that return a terminal truncated response instead of leaving the sender blocked when model output exceeds the message limit.

### Changed

- Expanded Pi to twelve tools and Claude MCP to fourteen tools.
- Replaced the native `better-sqlite3` dependency with Node's built-in SQLite runtime so Pi package installation does not require a C++ toolchain; the supported runtime is Node 22.13+ on the 22.x line or Node 24+.
- Scoped `mesh_fanout` idempotency to the caller prefix, correlation ID, and normalized target so retained messages from an earlier workflow cannot block a later run.

### Upgrade note

- Fanout retry keys created before 0.3.1 used a different format. Finish or inspect outstanding fanouts before upgrading; an exact retry that crosses the upgrade can dispatch a new peer request and does not provide cross-version exactly-once behavior.

## 0.3.0 - 2026-08-25

### Added

- Signed Jira, GitHub, and generic webhook ingress with SHA-256 HMAC verification, provider delivery-ID deduplication, event filtering, and payload-path filters.
- Ordered durable workflow stages, evidence requirements, bounded warning/failure retries, and premature-settlement detection.
- `mesh_fanout` for up to three independent peer responses and coordinator synthesis.
- Structured capture for plans, decisions, contradictions, errors, and lessons plus project-scoped improvement reports.
- Restarting headless Pi RPC worker for long-lived coordinator agents.
- Complete Jira In Progress-to-reproduction, multi-agent planning, implementation, gates, documentation, push/watch, merge, Jira update, and retrospective example.

### Changed

- Expanded Pi to eleven tools and Claude MCP to thirteen tools, covering fanout, cancellation, workflows, journals, and improvement reports.
- Extended SQLite schema versioning to durable workflow runs and learning journals.
- Added workflow code to the measured CI coverage gate.

## 0.2.0 - 2026-08-25

### Added

- Product, onboarding, configuration, architecture, operations, and troubleshooting guides.
- Strict TypeScript checking, CI configuration, and package-version consistency checks.
- Contributor, security, and community policies.
- Durable SQLite message and identity storage with schema compatibility checks.
- Per-project tokens, request IDs, security headers, rate limiting, and bounded client requests.
- Readiness and Prometheus metrics endpoints plus structured, content-redacted logs.
- Message TTL, cancellation, idempotent sends, terminal-record retention, and restart recovery.
- Executable Pi-to-Pi examples and a feature-to-test coverage matrix.
- Native Pi extension, Agent Skill, and Claude marketplace packaging from one repository.

### Changed

- Reorganized the package as a clean Pi extension and Claude marketplace monorepo.
- Bundled the Claude MCP runtime for dependency-free marketplace installation.
- Made measured coverage part of the CI gate.

## 0.1.0 - 2026-08-25

### Added

- In-memory HTTP/SSE mesh hub with authentication and project-scoped presence.
- Native Pi tools for peer discovery, request sending, polling, and waiting.
- Pushed inbound Pi work with automatic settled-response replies.
- Claude Code MCP tools and optional channel delivery.
- Portable `pi-mesh-comms` Agent Skill.
- Pi package and Claude marketplace manifests.
