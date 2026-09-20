# Test matrix

The release gate executes every test, measures the core source directly, type-checks strict TypeScript, lints documentation, verifies package versions, validates Claude manifests, rebuilds the generated runtimes, and installs and executes the npm artifact outside the repository.

Run the commit gate with `npm run verify`. CI PR legs run `validate:ci` plus
`check:generated`. Plugin validation is a hosted CI job.

```powershell
npm run verify
```

## Product features

| Feature | Automated evidence |
|---|---|
| Health, readiness, metrics, request IDs, security headers | `test/core/hub-api.test.ts` |
| Shared and per-project authentication, project isolation | `test/core/hub-api.test.ts` |
| Registration, discovery, presence, stale detection, identity resumption | `test/core/hub-api.test.ts`, `test/core/hub.test.ts` |
| SQLite persistence, restart recovery, schema compatibility | `test/core/hub-api.test.ts`, `test/core/store.test.ts` |
| All delivery modes, message fields, hop limits, and validation | `test/core/hub-api.test.ts`, `test/core/protocol.test.ts` |
| Queue, acknowledgement, visibility, reply, and authorization | `test/core/hub-api.test.ts`, `test/core/hub.test.ts` |
| Queued/delivered replay after recipient restart reuses one message record | `test/core/hub.test.ts`, `test/core/extension.test.ts`, `test/core/mcp.test.ts` |
| One-to-three-peer fanout, recoverable local timeouts/aborts, exact retries, and partial-error collection | `test/core/client.test.ts`, `test/core/hub-api.test.ts`, `test/core/extension.test.ts`, `test/core/mcp.test.ts` |
| TTL expiry, sender cancellation, and terminal retention | `test/core/hub-api.test.ts` |
| Terminal inbound cleanup and next-request activation | `test/core/extension.test.ts`, `test/core/mcp.test.ts` |
| Exact-retry idempotency and conflicting-key rejection | `test/core/hub-api.test.ts` |
| Rate limiting and retry guidance | `test/core/hub-api.test.ts` |
| Redacted structured logs | `test/core/hub-api.test.ts` |
| Client lifecycle, aborts, timeouts, invalid responses, reconnection | `test/core/client.test.ts` |
| Pi tools, inbound turns, automatic replies, status command | `test/core/extension.test.ts` |
| Claude MCP catalog, outbound and inbound tools, channel delivery | `test/core/mcp.test.ts` |
| Responsive metadata-only TUI, authenticated ops mode, presence-only fallback, observer filtering, key controls, and local body-free projection | `test/core/tui.test.ts`, `test/core/hub-api.test.ts` |
| Session manifest creation, fail-closed rosters, shared worker/result envelopes, and hub-owned envelope fields | `test/core/session.test.ts`, `test/core/cli.test.ts`, `test/core/envelope.test.ts`, `test/core/envelope-contract.test.ts` |
| Generic CLI/project telemetry classification, JSONL recovery, and proposed `kxm improve` output | `test/core/telemetry.test.ts`, `test/core/cli.test.ts` |
| Signed Jira webhook verification, filtering, dispatch, and retry deduplication | `test/core/hub-api.test.ts` |
| Ordered workflow checkpoints, normalized keyed evidence gates, unrelated-volume rejection, and warning/failure retry | `test/core/hub-api.test.ts`, `test/core/workflow.test.ts` |
| Run-start eligible-producer resolution, immutable workflow context, per-requirement message-reference verification, unique-producer quorum, and replay/cross-context rejection | `test/core/workflow-provenance.test.ts`, `test/core/workflow.test.ts`, `test/core/hub-api.test.ts`, `test/core/client.test.ts`, `test/core/store.test.ts` |
| Explicit current-attempt admin degradation, configured lower minimum, audit journal, idempotency, and forbidden or stale approvals | `test/core/workflow-provenance.test.ts`, `test/core/cli.test.ts` |
| Durable external waits, local/callback evidence accumulation, safe settlement, checkpoint/expiry race rejection, minimal signed responses, retry/conflict deduplication, separate secrets, and timeout notification | `test/core/hub-api.test.ts`, `test/core/workflow.test.ts`, `test/core/workflow-provenance.test.ts` |
| Plans, decisions, contradictions, errors, lessons, and improvement reports | `test/core/hub-api.test.ts`, `test/core/workflow.test.ts` |
| Safe diagnostic classification and redaction | `test/core/diagnostics.test.ts`, `test/core/extension.test.ts`, `test/core/hub-api.test.ts` |
| Operator CLI init/validate/export/watch | `test/core/cli.test.ts`, `test/core/github-watch.test.ts` |
| Local and isolated-global packed npm CLI plus hub runtimes | `test/core/package-install.test.ts` |
| Required generated runtimes are present, tracked, and match the staged copy after build | `scripts/check-generated.mjs`, `test/core/generated-artifacts.test.ts` |
| Tag release packs `kxm-<v>.tgz`, fail-closed draft GitHub upload, 404-then-list draft discovery, digest proof, no clobber | `scripts/kxm-release-github.mjs`, `test/core/kxm-release-github.test.ts`, `test/core/ci-contract.test.ts` |
| Retrospective export snapshots, metadata-only provenance audit, body allowlisting, degradation records, and v1 compatibility | `test/core/retrospective.test.ts` |
| Interrupted-worker continue fallback, exact run-bound recovery, unbound telemetry isolation, and one-turn durable replay | `test/core/worker.test.ts`, `test/core/recovery.test.ts`, `test/core/extension.test.ts` |
| Hub-owned workflow affinity; integrated hub→extension→supervisor→replacement replay; pre-ack default/run/cross-run routing; one-child session-dir swapping; stable ordinary context; LRU retention; and corrupt-state/link containment | `test/core/hub-api.test.ts`, `test/core/extension.test.ts`, `test/core/worker.test.ts`, `test/core/cli.test.ts` |
| Final provider-error retention, built-in retry ordering, metadata-only journaling, bounded fallback exhaustion, oversized-frame classification, and session-preserving restart | `test/core/extension.test.ts`, `test/core/worker.test.ts`, `test/core/diagnostics.test.ts`, `test/core/cli.test.ts` |
| Tool capability allowlist, watchdog grace, bounded hung-tool recovery, oversized completed-tool cancellation, and race-safe hub/worker ownership claims | `test/core/worker.test.ts`, `test/core/cli.test.ts`, `test/core/server.test.ts` |
| Exact worker extension/skill sets, discovery isolation, path preflight, multi-path ordering, and Windows argument safety | `test/core/worker.test.ts` |
| Opt-in real-Pi smoke contract and safe skip paths | `test/core/smoke-real-pi.test.ts`, `test/core/smoke.test.ts` |
| Durable workflow and journal recovery | `test/core/store.test.ts` |
| Atomic workflow transition commit and rollback | `test/core/store.test.ts` |
| Pi and Claude workflow/journal tools, workflow-context sends, and peer-reference checkpoints/waits | `test/core/extension.test.ts`, `test/core/mcp.test.ts` |
| Package and marketplace version consistency | `scripts/check-versions.mjs` |
| Planned KXM schemas, restricted YAML fixtures, cross-resource semantics, and sync-safe rejection | `test/core/contracts.test.ts` |
| Production KXM restricted loader, deterministic bundle hashing, Git discovery, fail-closed semantics, init classification, provenance-tracked atomic creation, exact three-way repair, authority-change blocking, pinned crash resumption, shadow validation, explicit join, Runtime-local bindings, CLI isolation, and idempotence | `test/core/project-config.test.ts`, `test/core/cli.test.ts`, `test/core/package-install.test.ts` |
| Legacy state is refused, never converted: a tree with `.kxm/config` JSON fails project load with `legacy_state_unsupported`, `kxm init` classifies it `mode: "legacy"` without writing, `kxm migrate` is an unknown command, and an older stamped store is refused without advancing `user_version` | `test/core/project-config.test.ts`, `test/core/cli.test.ts`, `test/core/e6-backup-restore-migrations.test.ts` |
| Permission-diff trust workflow: structured authority projections, conservative lattice classification (access, network, budgets, quorums, snapshots, secrets, transitions, shapes), prose neutrality, Git base shadowing, CLI diff/check gating, and packed-consumer round trips | `test/core/permission.test.ts`, `test/core/cli.test.ts`, `test/core/contracts.test.ts`, `test/core/package-install.test.ts` |
| Event-sourced local Runtime: supervisor singleton with stable logical identity, immutable home bindings, append-only per-project event stores, idempotent acceptance/cancel, projection rebuild equivalence, token-authenticated local API, auto-start, SIGKILL crash recovery, offline CLI, packed consumer | `test/core/runtime.test.ts`, `test/core/cli.test.ts`, `test/core/package-install.test.ts` |

The CI minimums are 93% lines, 80% branches, and 93% functions across
`plugins/kxm/src/**/*.ts` (excludes `server.ts` and `mcp-server.ts`). Those
floors may only ratchet up. The generated MCP runtime is exercised as a child
process, while the packed CLI and hub are installed in a clean consumer and
exercised from `node_modules`.

## Executable examples and use cases

| Scenario | Location | Verification |
|---|---|---|
| Self-contained planner/reviewer round trip | `examples/roundtrip.ts` | Executed by `test/core/examples.test.ts` |
| Long-running deterministic reviewer | `examples/reviewer-agent.ts` | Type-checked and documented |
| Command-line requester | `examples/requester.ts` | Type-checked and documented |
| Plan then review | `examples/README.md` | Uses discovery, send, and wait |
| Separate file ownership | `examples/README.md` | Documents non-overlapping writers |
| Non-blocking delegation | `examples/README.md` | Uses send, independent work, and get |
| Obsolete-work cancellation | `examples/README.md` | Uses cancel and states rollback boundary |
| Safe network retry | `examples/README.md` | Uses stable idempotency keys |
| Jira issue-to-merge workflow | `.kxm/workflows/default.yaml` | Parsed, type-checked through workflow tests, and exercised end to end with representative configuration |
| `.kxm` workspace defaults and persisted hub/worker logs | `.kxm/`, `test/core/server.test.ts`, `test/core/worker.test.ts` | Executed with isolated temporary workspaces |
| Signed external result callback | `examples/workflow-signal.ts` | Type-checked; equivalent signed callback path is exercised end to end in `test/core/hub-api.test.ts` |
| Peer provenance and optional explicit degradation | `examples/provenance-workflow.json`, `.kxm/workflows/default.yaml`, `docs/provenance-gates.md` | Both definitions are parser-checked in `test/core/examples.test.ts`; adversarial evidence and degradation behavior is automated in `test/core/workflow-provenance.test.ts` |
| Quorum parser boundaries and definition identity | `plugins/kxm/src/workflow.ts`, `test/core/workflow-quorum.test.ts`, `test/core/workflow-definition-hash.test.ts` | Rejects impossible peer pools, verifies degradation bounds, and proves secret-free semantic hash stamping plus credential-rotation invariance |
| Artifact existence and containment gate | `plugins/kxm/src/artifacts-exist.ts`, `test/core/artifacts-exist.test.ts` | Non-empty regular files pass; missing, empty, non-file, lexical escape, and real-path escape cases fail closed (host-permitted symlink coverage) |
| Harness inventory probe | `plugins/kxm/src/harness.ts`, `test/core/harness.test.ts` | Detect/auth/dispatch for the builtin catalog; win32 `.exe` / inner npm-package `.exe` / `.cmd` candidate order for npm shims (issue #168); `windows_shim` issue only when the shim answered; allowlisted `name.cmd` shell spawn only; rejected metacharacter commands; Linux still `not_detected` when the bare command is missing. |
| Headless harness helper | `scripts/harness-run.mjs`, `justfile`, `test/core/harness-run.test.ts` | Offline auth success/logout/garbage, role/mode/pair/provider refusals before spawn, missing brief/schema fail closed with zero spawn, invocation-cwd relative `prompt_file`/`output_schema` vs `request.cwd` (absolute argv tokens; Claude/Codex stdin matches the brief), Pi JSONL multi-`message_end` sums, Claude auxiliary usage, native error-on-exit-0, timeout/empty payload, sidecar-only stderr/answer/error, shell:false argv metacharacters, win32 `.cmd` rejection, and win32 npm inner `claude.exe` / Pi `node.exe`+`cli.js` unwrap. Result v2 transport vs closed model claims, dispatch-before-spawn, grok/codex isolation flags, `max_turns` validation, obsolete v1 diagnosis without rewrite or unknown-schema echo, partial usage on fail/interrupt, signaled null `exitCode` plus exact `signal`, exit-before-stdio-close drain vs bounded linger, type-closed usage/cost (no object leak or zero-coercion), malformed optional text as run-stage failure with retained spend, stdin/pid-record write failures not completed, bounded timeout settle without descendant-death claims, spawn/write-failure stage and spend, and capability-fixture parser evidence (Codex `--ignore-user-config` is not invented in top-level help; captured help bytes are not rescrubbed). Recipe quoting is covered from the justfile body without a just binary (POSIX `sh` + positional argv; Windows uses the recipe's `node -e` / argv shape). The developer entry points are gated three ways: docs-to-recipe parity (a documented `just` verb in command form, across inline code or a fenced line with an optional `#`, tolerant of stray whitespace, pipe-separated alternations, leading interpreter options and `~~~` fences, reading a shell pipe as one command rather than an alternation, skipping a glob family like `review-*` instead of demanding a recipe, and *not* parsing prose, headings or captured listing output); per-recipe boundaries (**the load-bearing gate parses nothing**: every line that mentions `assignment-run.mjs` must be one of the seven pinned proof bodies and there must be exactly seven, so a header form no parser recognises still cannot hide a call site; column-0 comments are documentation and excluded), plus a normalized-text pass (`\`-continuations folded, comments stripped) and a second pass over `just --dump`, the interpreter's own rendering, skipped with a visible reason without the binary; the recipe name set must equal a pinned list, duplicate headers and duplicate `run :=` bindings are refused, `set allow-duplicate*`, `import`/`mod` in any spelling and `alias` are refused, `run :=` and `dispatch` are asserted exactly, and non-proof bodies are token-checked against raw text because comment-stripping first hid an executable suffix that `--dump` reproduced verbatim. Stated limit: drift protection, not a sandbox — a body can assemble its command at runtime, and anyone who can edit the file can already do what it does. Auto-loading a working-directory dotenv file is refused by a brake on any `set dotenv*` spelling, plus a real-`just` probe whose preload module writes a marker file itself — so the assertion is that injected code executed — paired with controls on the same entry point: explicit `--dotenv-path`, a justfile with the setting re-added, and a real `witness` recipe run both ways. Real just integration is optional and skipped when the binary is absent. No live paid smoke. |
| Long-lived headless coordinator | `scripts/kxm-worker.mjs` | Restart limits, spawn failure, collision-resistant ownership, exact resource and tool loading, raw-output isolation, bounded RPC framing, bounded drain, hung-tool recovery, provider/model fallback, and `--continue` fallback are automated; the opt-in real-Pi gate verifies two workers, discovery, request/reply, fanout, durable restart/resume, journal, and checkpoint |
| GitHub check signal adapter | `plugins/kxm/src/github-watch.ts` | Deterministic pagination, conclusion, retry, and per-wait delivery-generation states in `test/core/github-watch.test.ts` |
| Operator CLI | `scripts/kxm.mjs` | Isolated workspace commands in `test/core/cli.test.ts`; the packed artifact is installed locally and with the documented global `--omit=peer` path by `test/core/package-install.test.ts` |
| Hub-local session brief | `plugins/kxm/src/session-work.ts`, `test/core/session-work.test.ts`, `test/core/cli.test.ts` | Status line and task/plan lists from hub SQLite without message bodies; `init --hub` is an unknown option; `hub bind` reports on/off/unknown |
| Native-free package install and Windows `pi.cmd` worker launch | `package.json`, `test/core/store.test.ts`, `test/core/worker.test.ts` | CI runs on Linux at Node 22.19 and Node 24; the Windows `pi.cmd` fixture stays in `test/core/worker.test.ts` and runs locally on Windows or when the paused Windows legs resume. |

## Manual release checks

Automation cannot prove that a third-party harness UI renders perfectly. Before a release, connect two current Pi sessions, run `/kxm hub`, complete one inbound round trip, install the marketplace plugin in a clean Claude Code profile, and verify `kxm_list`. Exercise preview channel delivery only when the target Claude Code version supports community channels.

Create the versioned tarball with `npm pack`, attach it to the matching GitHub
release, and verify the authenticated `gh release download` plus
`npm install --global --omit=peer <local-tarball>` path before publishing the
operator installation instructions. For version `<release-version>`, the required asset is
`kxm-<release-version>.tgz`.

When adding a feature, add executable coverage and update this matrix in the same change. If a behavior can only be verified manually, state why and add it to the release checklist instead of implying automated coverage.

## v0.5 context suites

| Suite | Covers |
|---|---|
| `test/core/context.test.ts` | Context schema round-trips, hostile input, cross-project fail-closed, storage upgrade |
| `test/core/state.test.ts` | Temporal state lifecycle, asOf queries, supersession, contradictions, restart durability |
| `test/core/context-authority.test.ts` | Authority grant floor, reserialization escalation, lineage bounds, control-plane smuggling |
| `test/core/arbiter.test.ts` | Role-aware packet assembly, budgets, contradiction routing, journal conversion, hub surfaces |
| `test/core/context-surfaces.test.ts` | CLI and Pi tool parity for the context API |
| `test/core/journal-evolution.test.ts` | New journal categories, evidence requirements, governed promotion |
| `test/core/wiki.test.ts` | Wiki compilation determinism, lifecycle preservation, contradiction visibility, lint |
| `test/core/workflow-transitions.test.ts` | Typed back-edges, budgets, bypass protection, restart recovery |
| `test/core/fix-workflow.test.ts` | /fix end-to-end, independent repro-review oracle, wrong-seam invalidation, failed self-retry, plan-hash gating, exhaustion |
| `test/core/skills.test.ts` | Skill candidate lifecycle, quarantine, immutability, CLI |
| `test/core/routing.test.ts` | Behavioral hash, record parsing, comparisons, routing report |
| `test/core/migration.test.ts` | v0.4 → v0.5 database upgrade fixture |
