# Test matrix

The release gate executes every test, measures the core source directly, type-checks strict TypeScript, lints documentation, verifies package versions, validates Claude manifests, rebuilds the generated runtimes, and installs and executes the npm artifact outside the repository.

Run the automated gate with:

```powershell
npm run validate
```

## Product features

| Feature | Automated evidence |
|---|---|
| Health, readiness, metrics, request IDs, security headers | `test/hub-api.test.ts` |
| Shared and per-project authentication, project isolation | `test/hub-api.test.ts` |
| Registration, discovery, presence, stale detection, identity resumption | `test/hub-api.test.ts`, `test/hub.test.ts` |
| SQLite persistence, restart recovery, schema compatibility | `test/hub-api.test.ts`, `test/store.test.ts` |
| All delivery modes, message fields, hop limits, and validation | `test/hub-api.test.ts`, `test/protocol.test.ts` |
| Queue, acknowledgement, visibility, reply, and authorization | `test/hub-api.test.ts`, `test/hub.test.ts` |
| Queued/delivered replay after recipient restart reuses one message record | `test/hub.test.ts`, `test/extension.test.ts`, `test/mcp.test.ts` |
| One-to-three-peer fanout, recoverable local timeouts/aborts, exact retries, and partial-error collection | `test/client.test.ts`, `test/hub-api.test.ts`, `test/extension.test.ts`, `test/mcp.test.ts` |
| TTL expiry, sender cancellation, and terminal retention | `test/hub-api.test.ts` |
| Terminal inbound cleanup and next-request activation | `test/extension.test.ts`, `test/mcp.test.ts` |
| Exact-retry idempotency and conflicting-key rejection | `test/hub-api.test.ts` |
| Rate limiting and retry guidance | `test/hub-api.test.ts` |
| Redacted structured logs | `test/hub-api.test.ts` |
| Client lifecycle, aborts, timeouts, invalid responses, reconnection | `test/client.test.ts` |
| Pi tools, inbound turns, automatic replies, status command | `test/extension.test.ts` |
| Claude MCP catalog, outbound and inbound tools, channel delivery | `test/mcp.test.ts` |
| Responsive metadata-only TUI, authenticated ops mode, presence-only fallback, observer filtering, key controls, and local body-free projection | `test/tui.test.ts`, `test/hub-api.test.ts` |
| Session manifest creation, fail-closed rosters, shared worker/result envelopes, and hub-owned envelope fields | `test/session.test.ts`, `test/cli.test.ts`, `test/envelope.test.ts`, `test/envelope-contract.test.ts` |
| Generic CLI/project telemetry classification, JSONL recovery, and proposed `kxm improve` output | `test/telemetry.test.ts`, `test/cli.test.ts` |
| Signed Jira webhook verification, filtering, dispatch, and retry deduplication | `test/hub-api.test.ts` |
| Ordered workflow checkpoints, normalized keyed evidence gates, unrelated-volume rejection, and warning/failure retry | `test/hub-api.test.ts`, `test/workflow.test.ts` |
| Run-start eligible-producer resolution, immutable workflow context, per-requirement message-reference verification, unique-producer quorum, and replay/cross-context rejection | `test/workflow-provenance.test.ts`, `test/workflow.test.ts`, `test/hub-api.test.ts`, `test/client.test.ts`, `test/store.test.ts` |
| Explicit current-attempt admin degradation, configured lower minimum, audit journal, idempotency, and forbidden or stale approvals | `test/workflow-provenance.test.ts`, `test/cli.test.ts` |
| Durable external waits, local/callback evidence accumulation, safe settlement, checkpoint/expiry race rejection, minimal signed responses, retry/conflict deduplication, separate secrets, and timeout notification | `test/hub-api.test.ts`, `test/workflow.test.ts`, `test/workflow-provenance.test.ts` |
| Plans, decisions, contradictions, errors, lessons, and improvement reports | `test/hub-api.test.ts`, `test/workflow.test.ts` |
| Safe diagnostic classification and redaction | `test/diagnostics.test.ts`, `test/extension.test.ts`, `test/hub-api.test.ts` |
| Operator CLI init/validate/export/watch | `test/cli.test.ts`, `test/github-watch.test.ts` |
| Local and isolated-global packed npm CLI plus hub runtimes | `test/package-install.test.ts` |
| Required generated runtimes are present, tracked, and unchanged after build | `scripts/check-generated.mjs`, `test/generated-artifacts.test.ts` |
| Retrospective export snapshots, metadata-only provenance audit, body allowlisting, degradation records, and v1 compatibility | `test/retrospective.test.ts` |
| Interrupted-worker continue fallback, exact run-bound recovery, unbound telemetry isolation, and one-turn durable replay | `test/worker.test.ts`, `test/recovery.test.ts`, `test/extension.test.ts` |
| Hub-owned workflow affinity; integrated hub→extension→supervisor→replacement replay; pre-ack default/run/cross-run routing; one-child session-dir swapping; stable ordinary context; LRU retention; and corrupt-state/link containment | `test/hub-api.test.ts`, `test/extension.test.ts`, `test/worker.test.ts`, `test/cli.test.ts` |
| Final provider-error retention, built-in retry ordering, metadata-only journaling, bounded fallback exhaustion, oversized-frame classification, and session-preserving restart | `test/extension.test.ts`, `test/worker.test.ts`, `test/diagnostics.test.ts`, `test/cli.test.ts` |
| Tool capability allowlist, watchdog grace, bounded hung-tool recovery, oversized completed-tool cancellation, and race-safe hub/worker ownership claims | `test/worker.test.ts`, `test/cli.test.ts`, `test/server.test.ts` |
| Exact worker extension/skill sets, discovery isolation, path preflight, multi-path ordering, and Windows argument safety | `test/worker.test.ts` |
| Opt-in real-Pi smoke contract and safe skip paths | `test/smoke-real-pi.test.ts`, `test/smoke.test.ts` |
| Durable workflow and journal recovery | `test/store.test.ts` |
| Atomic workflow transition commit and rollback | `test/store.test.ts` |
| Pi and Claude workflow/journal tools, workflow-context sends, and peer-reference checkpoints/waits | `test/extension.test.ts`, `test/mcp.test.ts` |
| Package and marketplace version consistency | `scripts/check-versions.mjs` |
| Planned vNext schemas, restricted YAML fixtures, cross-resource semantics, and sync-safe rejection | `test/contracts-vnext.test.ts` |
| Production vNext restricted loader, deterministic bundle hashing, Git discovery, fail-closed semantics, init classification, provenance-tracked atomic creation, exact three-way repair, authority-change blocking, pinned crash resumption, shadow validation, explicit join, Runtime-local bindings, CLI isolation, and idempotence | `test/vnext-config.test.ts`, `test/cli.test.ts`, `test/package-install.test.ts` |

The CI minimums are 95% lines, 80% branches, and 90% functions across the measured transport/workflow core sources explicitly listed in `package.json`. TUI rendering, session/roster helpers, envelope construction, telemetry, and proposed-report formatting have executable feature tests but are intentionally outside that aggregate percentage; their generated or packed entry points remain exercised by integration tests. The generated MCP runtime is exercised as a child process, while the packed CLI and hub are installed in a clean consumer and exercised from `node_modules`.

## Executable examples and use cases

| Scenario | Location | Verification |
|---|---|---|
| Self-contained planner/reviewer round trip | `examples/roundtrip.ts` | Executed by `test/examples.test.ts` |
| Long-running deterministic reviewer | `examples/reviewer-agent.ts` | Type-checked and documented |
| Command-line requester | `examples/requester.ts` | Type-checked and documented |
| Plan then review | `examples/README.md` | Uses discovery, send, and wait |
| Separate file ownership | `examples/README.md` | Documents non-overlapping writers |
| Non-blocking delegation | `examples/README.md` | Uses send, independent work, and get |
| Obsolete-work cancellation | `examples/README.md` | Uses cancel and states rollback boundary |
| Safe network retry | `examples/README.md` | Uses stable idempotency keys |
| Jira issue-to-merge workflow | `.kxm/config/workflows/jira-development.json` | Parsed, type-checked through workflow tests, and exercised end to end with representative configuration |
| `.kxm` workspace defaults and persisted hub/worker logs | `.kxm/`, `test/server.test.ts`, `test/worker.test.ts` | Executed with isolated temporary workspaces |
| Signed external result callback | `examples/workflow-signal.ts` | Type-checked; equivalent signed callback path is exercised end to end in `test/hub-api.test.ts` |
| Peer provenance and optional explicit degradation | `examples/provenance-workflow.json`, `.kxm/config/workflows/provenance-quorum.json`, `docs/provenance-gates.md` | Both definitions are parser-checked in `test/examples.test.ts`; adversarial evidence and degradation behavior is automated in `test/workflow-provenance.test.ts` |
| Quorum parser boundaries and definition identity | `plugins/kxm-mesh/src/workflow.ts`, `test/workflow-quorum.test.ts`, `test/workflow-definition-hash.test.ts` | Rejects impossible peer pools, verifies degradation bounds, and proves secret-free semantic hash stamping plus credential-rotation invariance |
| Artifact existence and containment gate | `plugins/kxm-mesh/src/artifacts-exist.ts`, `test/artifacts-exist.test.ts` | Non-empty regular files pass; missing, empty, non-file, lexical escape, and real-path escape cases fail closed (host-permitted symlink coverage) |
| Long-lived headless coordinator | `scripts/pi-mesh-worker.mjs` | Restart limits, spawn failure, collision-resistant ownership, exact resource and tool loading, raw-output isolation, bounded RPC framing, bounded drain, hung-tool recovery, provider/model fallback, and `--continue` fallback are automated; the opt-in real-Pi gate verifies two workers, discovery, request/reply, fanout, durable restart/resume, journal, and checkpoint |
| GitHub check signal adapter | `plugins/kxm-mesh/src/github-watch.ts` | Deterministic pagination, conclusion, retry, and per-wait delivery-generation states in `test/github-watch.test.ts` |
| Operator CLI | `scripts/kxm.mjs` | Isolated workspace commands in `test/cli.test.ts`; the packed artifact is installed locally and with the documented global `--omit=peer` path by `test/package-install.test.ts` |
| Native-free package install and Windows `pi.cmd` worker launch | `package.json`, `test/store.test.ts`, `test/worker.test.ts` | CI runs on Ubuntu and Windows at Node 22.19 and Node 24; the Windows test executes a command-script fixture through `ComSpec` |

## Manual release checks

Automation cannot prove that a third-party harness UI renders perfectly. Before a release, connect two current Pi sessions, run `/mesh-status`, complete one inbound round trip, install the marketplace plugin in a clean Claude Code profile, and verify `mesh_list`. Exercise preview channel delivery only when the target Claude Code version supports community channels.

Create the versioned tarball with `npm pack`, attach it to the matching GitHub
release, and verify the authenticated `gh release download` plus
`npm install --global --omit=peer <local-tarball>` path before publishing the
operator installation instructions. For version `<release-version>`, the required asset is
`kontextmind-pi-extensions-<release-version>.tgz`.

When adding a feature, add executable coverage and update this matrix in the same change. If a behavior can only be verified manually, state why and add it to the release checklist instead of implying automated coverage.

## v0.5 context suites

| Suite | Covers |
|---|---|
| `test/context.test.ts` | Context schema round-trips, hostile input, cross-project fail-closed, storage upgrade |
| `test/state.test.ts` | Temporal state lifecycle, asOf queries, supersession, contradictions, restart durability |
| `test/context-authority.test.ts` | Authority grant floor, reserialization escalation, lineage bounds, control-plane smuggling |
| `test/arbiter.test.ts` | Role-aware packet assembly, budgets, contradiction routing, journal conversion, hub surfaces |
| `test/context-surfaces.test.ts` | CLI and Pi tool parity for the context API |
| `test/journal-evolution.test.ts` | New journal categories, evidence requirements, governed promotion |
| `test/wiki.test.ts` | Wiki compilation determinism, lifecycle preservation, contradiction visibility, lint |
| `test/workflow-transitions.test.ts` | Typed back-edges, budgets, bypass protection, restart recovery |
| `test/fix-workflow.test.ts` | /fix end-to-end, independent repro-review oracle, wrong-seam invalidation, failed self-retry, plan-hash gating, exhaustion |
| `test/skills.test.ts` | Skill candidate lifecycle, quarantine, immutability, CLI |
| `test/routing.test.ts` | Behavioral hash, record parsing, comparisons, routing report |
| `test/migration.test.ts` | v0.4 → v0.5 database upgrade fixture |
