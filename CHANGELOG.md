# Changelog

All notable user-facing changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.4.0 - 2026-08-26

### Added

- Additive `pi-mesh` operator CLI for workspace init, validation, status, dry-run workflow planning, GitHub check watching, and retrospective export.
- Allowlisted diagnostic classification for failed workflow tools and 401/403 identity-scope errors, including bounded `operation`, `nextAction`, and assigned coordinator name.
- Command-first GitHub check watcher that posts the existing signed workflow signal and exits 4 without posting on adapter timeout.
- Worker drain, `--continue` fallback, and a redacted recovery envelope under `.kxm/state`.
- Atomic Markdown/JSON retrospective export under `.kxm/assets/retrospectives` with `reviewDecision=proposed`.
- Opt-in real multi-Pi smoke entry point that probes for `pi` and skips cleanly when the binary or model credentials are unavailable.

### Changed

- Failed-tool journal summaries now include an allowlisted diagnostic class instead of a generic "tool failed" sentence.
- Long-lived workers wait longer for a graceful SIGTERM drain and retry once without `--continue` after a fast failure.

### Upgrade note

- Extra 401/403 JSON fields are additive. 0.3.1 clients ignore them. Coordinator journal writes after a failed run remain allowed; checkpoints and waits still require a running or waiting run.

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
