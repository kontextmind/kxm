# Changelog

All notable user-facing changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

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
