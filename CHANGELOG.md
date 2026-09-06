# Changelog

All notable user-facing changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Agent-only vNext run loop (`vnext-engine.ts`): pins a D1 compiled plan in an
  immutable hashed envelope, folds schema-valid `kxm.run-event.v1` events with
  a run_state projection, and drives a model-free simulated producer under
  transition/step budgets. Public drive, step, and scheduler share one
  admission bound. Sync and async producer failures settle as
  `producer_rejected` without leaking the attempt capability. A process
  restart of an executing attempt is unreconciled; operator cancel before pin
  still rebuilds. Duration/cost limits and the default/fix driver gate stay
  fail-closed for later slices. Event store is schema v2; version-1 files are
  refused (E6).
- Pure vNext workflow compile (`vnext-engine-compile.ts`) turns a validated
  `kxm.workflow.v1` into a frozen JSON plan. Compile is not execution; D3/D4
  remain open.
- Routing contract doc (`docs/vnext/routing.md`) and synchronization status
  (schema-tested; Phase 8 implementation).
- Tag-triggered `release.yml` packs `kxm-<v>.tgz`, creates or reuses only a
  **draft** GitHub release, and fails unless the REST asset digest equals the
  local sha256. A published release for the tag is never modified; reruns skip
  upload only when the existing digest matches. npm publish stays `if: false`
  until a later published-release + `npm-publish` environment gate.
- Hosted `Plugin validation` CI job runs native `claude plugin validate` with
  `@anthropic-ai/claude-code@2.1.261` (no model calls). After
  `--ignore-scripts` install, the job runs that package's `install.cjs` so
  the native binary is present.
- Session brief `AGENTS.md` / `CLAUDE.md` and Tracking in
  `docs/vnext/implementation-plan.md` (roles, provider-native harness routing,
  cost/insights, plan hygiene).
- Hub-local session chrome: `kxm session brief [--status]`, Pi TUI picker and
  status line on new/fork sessions, `/kxm` (`status`/`hub`/`help`), skill
  `kxm-session`. `kxm hub bind <url>` / `kxm hub unbind` persist a host-level
  hub URL; `kxm init` is project-only.
  Pi widget `ship` line shows git dirty/ahead vs verify/CI (does not run tests).
- `kxm hub bind <url>` writes `kxm.hub-binding.v1` and probes `/health` in
  300 ms (`on` / `off` / `unknown`). Hub listening line reports `auth=token`
  or `auth=none`.
- `kxm update --check` / `--kxm` notices and applies operator package updates.
  GitHub releases are the current install path; npm is for after the public
  package. Git `.kxm/update.yaml` `auto` applies on `kxm update`.

### Fixed

- PR CI no longer skips Validate or Plugin validation for docs-only diffs, so
  the ruleset’s required contexts (four expanded Validate names plus Plugin
  validation) still run.
- Draft GitHub release lookup lists releases (including drafts, every page)
  after a by-tag 404 so a retry reuses one draft instead of creating another.
  Duplicate drafts, a published match, and list/pagination failures fail
  closed with no mutation.
- Headless helper reads `prompt_file` and `output_schema` against the
  invocation cwd before any auth or assignment spawn. Missing or unreadable
  inputs fail closed with zero spawn and no child left waiting on stdin.
  File-consuming argv tokens are absolute so the assignment can run in
  `request.cwd`.
- Headless helper preflight requires `harness`, `role`, `model`, `permission`,
  and `prompt_file` as nonempty strings, so omitted permission no longer
  launches Pi with `-a` and omitted model no longer falls through to a CLI
  default. Pi planner and reviewer roles cannot `edit`; only `experiment` may.
  `max_cost_usd` and `timeout_ms` reject non-numbers, non-finite values, and
  zero instead of dropping the flag. `just` recipes pass user paths as quoted
  positional arguments and `JSON.stringify` them; `just runs` prints
  `billed` / `list` / `unmetered` / `unknown` instead of `$0.0000` for absent
  cost.
- Pi git installs no longer fail to load the extension when production
  `node_modules` omits `yaml`. Update-config YAML parsing stays on the bundled
  CLI path.
- Explicit `kxm update --kxm` refuses non-global installs (`install_kind_*`)
  even when already current or the release check is unavailable. Auto-apply
  still hints only when an update is available.

### Changed

- Operator-authorized platform pause (2026-09-05): PR CI keeps two Linux
  Validate legs (Node 22.19.0 and 24) plus Classify, Docs lint, and Plugin
  validation (five jobs). Windows CI legs, hosted Windows probes, and
  `release.yml` are paused (`release` job `if: false`); Windows is not
  deprecated and no Windows source or tests were removed. Local verification
  remains `npm run verify` on macOS. No new paid macOS runner.
- Headless `scripts/harness-run.mjs` now emits `kxm.harness-result.v2`:
  transport `completed|failed|interrupted` is separate from closed model-claim
  metadata and from product `routing-record.v1` `finalOutcome`. Direct-child
  signal facts keep a null `exitCode` and the exact `signal`. Natural
  successful exit waits for stdio drain; lingering pipes settle bounded
  without signaling an already-exited child. Public result types are closed
  (no object leak in token/cost scalars). Malformed optional text and
  post-spawn stdin/pid writes fail at run stage with retained usage.
  Timeout SIGTERM then SIGKILL can settle without a `close` and does not
  claim descendant death. Public metadata is a closed allowlist; raw
  model/stdio text stays in private sidecars. Grok adds `--no-subagents` and
  `--disable-web-search` plus optional `max_turns`; Codex adds
  `--ignore-user-config`. Obsolete v1 result files are diagnosed, not
  upgraded.
- `kxm harness list` auth is tri-state `yes` / `no` / `unknown`. Codex
  distinguishes ChatGPT vs API-key login status (text keeps `auth=yes` and
  adds an `API key` note); Claude parses JSON `loggedIn`; Grok is an
  observational catalog entry (`mode: either`) with a confirmed login probe.
  Recognized logged-out payloads stay `no` on a normal nonzero CLI; spawn,
  unparsed, and contradictory `ok`/`code` stay `unknown`. Pi without a named
  provider/model is `unknown`. `eligibleHarnesses` selects only detected and
  authenticated inventory entries and fail-closes when empty.
- Headless `scripts/harness-run.mjs` helper now fail-closes on native auth
  preflight, unverified harnesses, native-provider Pi impersonation, and
  unsupported Windows launchers. Read-only Claude uses `--safe-mode` and
  `Read,Glob,Grep` (no `--bare`, no Bash). Usage is cumulative per assignment;
  context occupancy is explicit unknown. Answer and stderr stay in private
  sidecars. There is no `impl-pi` Grok fallback. This is a dev helper, not a
  Phase 11 adapter.
- Pi install instructions pin `@main`; an older checkout tracking `master` must
  `pi remove` then reinstall.
- `kxm mesh` (including `init`/`smoke` and `--json`) fails closed with a stderr
  brake naming `kxm init`, `kxm hub`, and `scripts/smoke-multi-pi.mjs`. The
  command stays absent from help.
- `MeshClient`/`MeshHttpError` are `HubClient`/`HubHttpError`; `MeshDashboard`
  is `KxmDashboard`.
- Operator copy says `hub:off`; a docs brake test fails on leftover Mesh
  operator tokens.
- Session readiness on `startup`/`new`/`fork` (status, widget, picker
  skip/select, online/offline hub, RPC and opt-out, single registration) is a
  deterministic extension test.
- Coverage include inverted to `plugins/kxm/src/**/*.ts`. Excludes are only
  `server.ts` and `mcp-server.ts` (spawned bundles attribute to `dist`; see
  CONTRIBUTING). Measured on Windows Node 22.21.0 locally (one leg; CI legs
  were not read because this unit does not push): lines 93.75, branches 80.87,
  functions 93.53. Thresholds set to 93/80/93 (per-leg minimum truncated to a
  whole percent). **This is not a weakened gate**: the old 95/80/90 measured 13
  hand-listed files, while 93/80/93 measures all 42 non-excluded files, so the
  enforced surface roughly triples and functions actually rises from 90 to 93.
  Lines reads lower only because the denominator changed. From here the values
  may only ratchet up; 95/80/90 is a milestone, not the gate. `npm run verify` now ends with `check:generated`, which diffs
  built `dist` against the staged copy. `kxm-hub` and `kxm-worker` bins are
  removed (`kxm` remains; scripts still ship). Peers
  `@earendil-works/pi-coding-agent` and `typebox` are optional, pinned as
  devDependencies at lockfile versions 0.84.3 and 1.3.19.
  `.kxm/config/workflows/provenance-quorum.json` now ships in `files`.
- CI classifies each push and pull request: documentation-only changes run
  only the docs lint job, while code changes run the full matrix. Every leg
  still runs coverage: dropping instrumentation on Windows would be faster,
  but `--experimental-test-coverage` sets `NODE_V8_COVERAGE`, which child
  processes inherit and which changes their shutdown path, so an
  uninstrumented Windows leg fails the worker pre-ack test on Node 24.
  A newer push cancels an older pull-request run. `check:generated` runs on
  every validate leg; the standalone `generated` job is removed. `node_modules`
  is cached per lockfile. Dependabot groups minor and patch npm updates and all
  Actions updates.
- Product identity is **KXM** (`@kontextmind/kxm`, plugin `kxm`). Hub CLI is
  `kxm hub start|view|stop`; live screens are `kxm dash`. Default database is
  `.kxm/state/kxm.db`. Agent tools use the `kxm_*` prefix; env vars use `KXM_*`.
- `kxm dash` is a tabbed list/detail dashboard (agents, tasks, workflows, plans,
  inbox, procs). `kxm harness list` / `kxm update` observe and update harnesses
  without a second preferences store.
- First-run path is install, `kxm init`, foreground `kxm hub start`, `kxm hub
  bind <url>`, `kxm session brief`, then `pi` and `/kxm hub`. Hub start prints
  a cached update notice before spawn and refreshes in the background; a first
  start with an empty cache may print the notice only after the hub is up.
  Malformed `.kxm/update.yaml` is a stderr warning and does not block start;
  `kxm update` still fails closed.
- **Breaking:** `kxm init --hub` and `--hub-url` are unknown options. Bind
  with `kxm hub bind <url>`; remove the binding with `kxm hub unbind`.
- The `kxm mesh` group is deleted. Commander reports it as an unknown command.
- **Breaking renames (A2, no aliases):** wire headers `x-mesh-agent-id`,
  `x-mesh-agent-key`, `x-mesh-delivery-id`, and `x-mesh-events-mode` are now
  `x-kxm-agent-id`, `x-kxm-agent-key`, `x-kxm-delivery-id`, and
  `x-kxm-events-mode`; hub and workers ship in one package and upgrade
  together, with no header version check. The administrative caller id
  `mesh-admin` is `kxm-admin` in context provenance, journal promotions, and
  degradation approvals. Telemetry and session-manifest `host` is `local` or
  `hub` (was `mesh`). Pi extension custom message types are `kxm-inbound` and
  `kxm-recovery`; the status line reads `hub:<agent>`. Bin script and worker
  messages say KXM. Prometheus `pi_mesh_*` metric names are unchanged until E3.
- CLI honesty: `kxm --version` prints the package version; every JSON payload
  carries `schema: "kxm.cli-result.v1"` (worker envelopes keep
  `kxm.worker-result.v1`); `ok:false` payloads go to stderr in both text and
  JSON modes; `kxm runs status|cancel|list` report themselves as `runs ...`;
  `kxm run` says that runs remain created until Phase 3a lands and its JSON
  carries `phase: "pre-3a"`.
- Future slices do not add backwards-compat shims.

## 0.5.1 - 2026-09-01

### Changed

- `/fix` captures the immutable reproduction oracle only after independent two-critic `repro-review`. A sibling-API or newer-stack draft is invalid even if it fails. `repro-write` retries on `failed` instead of treating a wrong seam or `new DbContext()` as `blocked`.

## 0.5.0 - 2026-08-31

KXM v0.5 extends the durable multi-agent communication/workflow plane into a **context operating system**. Everything is additive: existing v0.4 workflows, gates, telemetry, and CLI behavior are unchanged unless new context/transition features are enabled.

### Added

- **Context schemas** (`kxm.context-item.v1`/`request`/`packet`): fail-closed validation, immutable provenance, explicit authority/confidence dimensions, lifecycle status, project isolation, deterministic token estimation. Storage in SQLite with a v2→v3 schema upgrade.
- **Temporal project state** (`kxm state`): one current value per key (or explicitly set-valued), `asOf` historical queries, supersession graph queries, contradiction detection, evidence-bound admin-only promotion. Agents may propose; only the control plane promotes.
- **Role-aware context arbiter**: deterministic packet assembly per role (repro/planner/critic/implementer/verifier or custom) with fixed token budgets; superseded/rejected records excluded by default; unresolved gaps reported. Surfaces: `kxm context get/recall/state/episode/promote/explain/wiki-compile/wiki-lint`, Pi tools `kxm_context/kxm_recall/kxm_state/kxm_episode/kxm_promote`, and the same five MCP tools.
- **Authority lattice** (issue #36): deterministic grant floor per origin — human/workflow → `policy`, git → `instruction`, peer/tool/external/derived → `evidence`. Reserialization privilege escalation fails closed; derived/summarized content is evidence at best with bounded transitive lineage; control-plane fields cannot be smuggled inside context items.
- **Compiled knowledge wiki** under `.kxm/knowledge/wiki/`: deterministic source-linked generation, current/superseded state preserved, open contradictions rendered explicitly, secrets redacted, and lint gates for broken refs, orphan pages, stale state links, and unsurfaced contradictions.
- **Typed workflow back-edges**: per-stage `on` outcome maps with `$terminal`, global/per-stage/per-edge budgets, durable transition journal, attempt-bound evidence on re-entry, and definition-load validation that rejects unknown targets, forward skips over approval/gate stages, and budgetless cycles.
- **Reference `/fix` workflow** (`.kxm/config/workflows/fix.json`): two-phase reproduction (read-only explore → tests-only write), immutable reproduction oracle (`weakened_reproduction`), approved plan-hash gating, human-approval security gate, bounded rework via back-edges, and a ready-for-human-acceptance final state with no auto-merge.
- **Governed skill lifecycle** under `.kxm/skills/` (`kxm skills create/evaluate/promote/reject/list/verify`): content-addressed candidates, four protected evaluations gating promotion, automatic quarantine on functional/safety failure, hash-pinned immutable promoted skills, explicit cross-model compatibility, and a gated skillopt hook. See `docs/skills.md`.
- **Routing telemetry** (`kxm.routing-record.v1`): behavioral configuration hash over model route + role prompt + skills + tool/context policy + workflow + verifier config; `kxm routing report` computes verified completion/cost/rework comparisons without reading raw prompts.
- **Governed journal promotion** (issue #32): new journal categories (`observation`, `hypothesis`, `experiment`, `state-change`, `skill-candidate`), mandatory evidence for lessons and skill candidates, and an admin-only, append-only promotion lifecycle (`POST /v1/journal/:id/promotion`).
- Journal entries can carry stage/attempt provenance; client supports `stageId`.

### Changed

- Renamed the operator CLI from `pi-mesh` to `kxm` and rebuilt it on Commander.
- `kxm` now has first-class tools: `agent`, `session`, `workflow`, `gate`, `mesh`, and `improve`.
- Examples: `kxm agent worker`, `kxm session status`, `kxm workflow start`, `kxm gate validate`, `kxm mesh hub`.
- Agents (AI-driven) and gates (code-driven) share `kxm.worker.v1` and emit `kxm.worker-result.v1`.
- Source equivalent is `node scripts/kxm.mjs`. Hub startup output is `kxm mesh hub listening`.
- Added a live `@earendil-works/pi-tui` mesh dashboard with responsive toggle panels and authenticated metadata-only operations SSE for real-time agent/message/workflow state; the Node 22 minimum is now 22.19 to match the TUI runtime.
- Long-lived Pi workers now leave waiting work queued in the hub, activate one message at a time, prioritize safe steering, normalize autonomous `nextTurn`, and restart when a delivered message never starts.
- Long-lived Pi workers can isolate model context by durable workflow run: `--session-isolation workflow` keeps ordinary work in a stable default session, gives every hub-authorized run a bounded run-specific session, and uses pre-ack child swapping to preserve one JSONL writer and durable replay. The upgrade-compatible default remains `off` so existing shared Pi histories are not silently abandoned.
- Added the wiki-ready `docs/kxm-handbook.md` covering installation, configuration, the complete CLI, Pi, Claude Code, workflows, gates, observability, security, and recovery.
- Improvement telemetry now classifies any named project/workflow generically instead of hardcoding one consumer; `KXM_IMPROVE_TARGET` remains an explicit `cli`/`project` override.
- `kxm mesh init` now creates empty project-owned workspace directories instead of copying the package repository's provider-specific dogfood configuration.
- The TUI's project-token fallback now negotiates a presence-only SSE stream and refuses unmarked legacy streams, preserving the no-message-bodies observer contract when admin operations access is unavailable.
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

- Operator guidance now distinguishes message TTL from local wait duration, recommends the 24-hour default for model work, and requires `kxm_get` or an exact idempotent retry while a peer remains pending.
- Pending peers explicitly do not count as planning, review, or workflow-checkpoint evidence.

### Upgrade note

- `kxm_fanout` adds the nonterminal `pending` result state and the optional `messageStatus`, `expiresAt`, and `waitStatus` fields. Consumers that exhaustively switch on result status should handle `pending` by inspecting the returned message ID rather than dispatching a replacement request.

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
- The npm artifact now ships self-contained JavaScript runtimes for `pi-mesh` and `kxm-hub`, so installed commands do not depend on Node stripping TypeScript inside `node_modules`.
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
- `kxm_workflow_wait` for Pi and Claude plus an executable signed callback example.
- Canonical `.kxm` workspace directories for tracked configuration and assets, ignored logs and state, and persisted hub/worker log files.
- Retry and nonzero failure handling when a long-lived worker cannot spawn Pi.
- Windows-safe long-lived worker launch through `ComSpec` for Pi command scripts.
- Cross-platform CI at the exact Node 22.13 floor and current Node 24 release.
- Bounded peer replies that return a terminal truncated response instead of leaving the sender blocked when model output exceeds the message limit.

### Changed

- Expanded Pi to twelve tools and Claude MCP to fourteen tools.
- Replaced the native `better-sqlite3` dependency with Node's built-in SQLite runtime so Pi package installation does not require a C++ toolchain; the supported runtime is Node 22.13+ on the 22.x line or Node 24+.
- Scoped `kxm_fanout` idempotency to the caller prefix, correlation ID, and normalized target so retained messages from an earlier workflow cannot block a later run.

### Upgrade note

- Fanout retry keys created before 0.3.1 used a different format. Finish or inspect outstanding fanouts before upgrading; an exact retry that crosses the upgrade can dispatch a new peer request and does not provide cross-version exactly-once behavior.

## 0.3.0 - 2026-08-25

### Added

- Signed Jira, GitHub, and generic webhook ingress with SHA-256 HMAC verification, provider delivery-ID deduplication, event filtering, and payload-path filters.
- Ordered durable workflow stages, evidence requirements, bounded warning/failure retries, and premature-settlement detection.
- `kxm_fanout` for up to three independent peer responses and coordinator synthesis.
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
- Mesh store schema version is now 3 (`context_items` table); v0.4 databases upgrade in place.
- `npm pack` ships the `/fix` workflow definition.
- Package version surfaces aligned at 0.5.0.

### Security

- Authority grant floors are enforced at parse time (`context_authority_violation`, HTTP 403).
- Weak or edited reproductions against a `/fix` run are rejected (`weakened_reproduction`).
- Promotion of temporal state and journal entries requires authorized, evidence-bound control-plane decisions; authors can never self-promote.
- The authority lattice is documented in `docs/provenance-gates.md`; the skill lifecycle in `docs/skills.md`.
