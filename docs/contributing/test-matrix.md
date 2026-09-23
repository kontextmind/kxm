# Test matrix

This matrix maps each KXM behavior to the automated test that proves it. Use it
to find where a behavior is covered before you change it, and add a row in the
same pull request when you add a behavior. Test files are under `test/core/`
unless a row names another path.

Run the whole commit gate with `npm run verify`. What CI runs on a pull request,
on `main` and nightly is described in [CI and release](ci-and-release.md); how
to run one file is in [Develop KXM](development.md#run-one-file-or-one-test).

## Hub and messaging

| Behavior | Evidence |
|---|---|
| Health, readiness, metrics, request IDs and security headers | `hub-api.test.ts` |
| Shared and per-project authentication, and project isolation | `hub-api.test.ts` |
| Registration, discovery, presence, stale detection and identity resumption | `hub-api.test.ts`, `hub.test.ts` |
| SQLite persistence, restart recovery and schema compatibility | `hub-api.test.ts`, `store.test.ts` |
| Delivery modes, message fields, hop limits and validation | `hub-api.test.ts`, `protocol.test.ts` |
| Queue, acknowledgement, visibility, reply and authorization | `hub-api.test.ts`, `hub.test.ts` |
| An unacknowledged (queued) message replays after a recipient restart as the same record | `hub.test.ts`, `extension.test.ts`, `mcp.test.ts` |
| An acknowledged, unanswered request survives a Claude Code restart under the same agent name and is announced once; one cancelled during the restart is not announced | `mcp.test.ts`, `inbox.test.ts` |
| An `allowOffline` send queues, delivers once on resumption, and expires unread by TTL | `hub-api.test.ts` |
| TTL expiry, sender cancellation and terminal retention | `hub-api.test.ts` |
| Exact-retry idempotency, and rejection of a reused key with different content | `hub-api.test.ts` |
| Fanout to one to three peers: local timeouts, aborts, exact retries, partial errors | `client.test.ts`, `hub-api.test.ts`, `extension.test.ts`, `mcp.test.ts` |
| Fenced leases: compare-and-set acquire, renew and release; a stale token's shared effect is refused | `hub-api.test.ts`, `store.test.ts`, `external-effects.test.ts` |
| Rate limiting and retry guidance | `hub-api.test.ts` |
| Redacted structured logs | `hub-api.test.ts` |
| Client lifecycle: aborts, timeouts, invalid responses and reconnection | `client.test.ts` |
| Safe diagnostic classification and redaction | `diagnostics.test.ts`, `extension.test.ts`, `hub-api.test.ts` |
| Failed MCP inbox notifications stay retryable; delivery deduplicates | `inbox.test.ts` |

## Hub workflows and provenance

| Behavior | Evidence |
|---|---|
| Signed Jira webhook verification, filtering, dispatch and retry deduplication | `hub-api.test.ts` |
| Ordered checkpoints, keyed evidence gates, and warning or failure retry | `hub-api.test.ts`, `workflow.test.ts` |
| Eligible producers fixed at run start; per-requirement message references; unique-producer quorum; replay rejected | `workflow-provenance.test.ts`, `workflow.test.ts`, `hub-api.test.ts`, `client.test.ts`, `store.test.ts` |
| Admin degradation of the current attempt: configured minimum, audit journal, idempotency, stale approvals refused | `workflow-provenance.test.ts`, `cli.test.ts` |
| Durable external waits: evidence accumulation, safe settlement, race rejection, signed callbacks, separate secrets | `hub-api.test.ts`, `workflow.test.ts`, `workflow-provenance.test.ts` |
| Quorum parser boundaries, and a secret-free definition hash that survives credential rotation | `workflow-quorum.test.ts`, `workflow-definition-hash.test.ts` |
| Durable workflow and journal recovery; atomic transition commit and rollback | `store.test.ts` |
| Plans, decisions, contradictions, errors, lessons and improvement reports | `hub-api.test.ts`, `workflow.test.ts` |
| All ten journal categories and `stageId` through `kxm_workflow_record`, with stage provenance end to end | `journal-evolution.test.ts` ("kxm_workflow_record binds stage provenance and the stage's area end to end, and hub-authored entries carry it too") |
| Ranked, redacted cross-run signals; retrospectives refreshed by late entries and promotions | `journal-evolution.test.ts`, `workflow.test.ts`, `retrospective.test.ts` |
| Retrospective export: snapshots, metadata-only provenance audit, body allowlist, degradation records | `retrospective.test.ts` |
| Typed back-edges, transition budgets, bypass protection and restart recovery | `workflow-transitions.test.ts` |
| GitHub check watch: pagination, conclusions, retries and per-wait delivery generations | `github-watch.test.ts` |

## Local Runtime and engine

| Behavior | Evidence |
|---|---|
| Event-sourced Runtime: singleton supervisor, append-only per-project stores, idempotent commands, projection rebuild, crash recovery | `runtime.test.ts`, `cli.test.ts`, `package-install.test.ts` |
| A store the build refuses is reported unreadable, never empty | `runtime.test.ts` ("a project whose store the build refuses is reported as unreadable, never as empty") |
| Supervisor drive: `202` with a poll link, duplicate drives refused, graceful shutdown waits | `runtime-supervisor.test.ts` |
| Settlement from a structured result only; prose outcomes and undeclared outcomes end as `outcome_unknown` | `pi-producer.test.ts`, `engine.test.ts` |
| Routing records carry `workflowId`, `askSha256`, `objectiveSha256` and `stepWrites`, and settle only `blocked` or `failed` | `route-admission.test.ts` |
| Dispatch context: only committed, pinned memory and hash-verified promoted skills reach an agent; the rest is a `dispatch_context_*` gap | `engine.test.ts` ("dispatch context: agents receive only committed, pinned memory and verified skills; anything else is withheld with a gap and the step still completes") |
| Run creation reports no execution and concrete live prerequisites; task refusal leaves task/Runtime unchanged; project harness default is honored | `cli.test.ts`, `engine.test.ts`, `harness.test.ts` |
| `kxm workflow add --template` writes workflows that validate and plan; an impossible gate outcome is refused | `cli-experience.test.ts` ("workflow add templates validate and plan a run, and a gate outcome the step can never produce is refused") |
| Flat workflow IDs and schema/compiler validation precede mutations; imported/picked local/global dry runs write nothing | `role-and-workflow-manager.test.ts`, `cli-experience.test.ts` |
| Claude-only suggestions honor detected/authenticated routes, require audited writer profiles, refuse existing unchecked definitions, and quote shell arguments literally | `suggest.test.ts`, `cli-experience.test.ts` |
| Explicit local YAML validates with runner schema/transitions; webhook environment sources retain JSON/secret checks | `gate-validation.test.ts` |
| `kxm workflow add` writes a local workflow only where the loader reads it and only if the project still loads; outside a project it refuses | `role-and-workflow-manager.test.ts` ("workflow add writes only what the project loader accepts, at the project root, and loadKxmProject still loads") |
| `kxm workflow add --pick <global-id>` copies the global definition into the project, not the scaffold, and the loader check refuses one that does not fit | `role-and-workflow-manager.test.ts` ("workflow add --pick <global-id> copies that global definition into the project, and refuses one the project loader rejects") |
| `kxm role add --pick <global-id>` copies the global role into the project, not an empty role, with `--description`, `--skills` and `--model` applied over it | `role-and-workflow-manager.test.ts` ("role add --pick <global-id> copies that global role into the project, with --description, --skills and --model applied over it") |
| `kxm role add` writes a local role only at the project root and only if the project still loads, so a `writer` roster without the implementer's model is refused; outside a project it refuses | `role-and-workflow-manager.test.ts` ("role add writes a local role only at the project root, and only if the project loader accepts it") |
| `default.yaml` and the 13-step `fix.yaml` compile deterministically; back edges need budgets | `engine-compile.test.ts` |
| Artifact gate: non-empty regular files pass; missing, empty, non-file and escaping paths fail | `artifacts-exist.test.ts` |
| Vision gate: strict verdicts, admitted routes only, unreadable images fail closed | `vision-gate.test.ts` |
| Tenant read labels hub projection versus Runtime authority and survives either side being down | `studio-layout.test.ts` |

## Context, memory and learning

| Behavior | Evidence |
|---|---|
| Packets rank by task relevance, fill the budget first-fit, and deliver every selected item, evidence included | `arbiter.test.ts` ("arbitrate ranks task-relevant candidates first, delivers every selected item in a packet section, orders ties newest first, and reports relevance") |
| Recall ranks by phrase, then relevance; hub logs carry sizes, not task or query text | `context-surfaces.test.ts`, `arbiter.test.ts` |
| An agent's state proposal is peer origin, decided by its credential, and capped at evidence | `context-authority.test.ts` ("a state proposal takes its origin from the verified credential, so an agent is peer and capped at evidence") |
| Promotion needs the configured admin token with no loopback bypass; proposed items never reach a packet | `e5-memory-floor.test.ts` |
| `kxm memory`: candidates, marker-delimited sync blocks, and one brief across CLI, Pi and the Claude hook | `e5b-harness-agnostic-memory.test.ts` |
| `kxm improve report` reads Runtime-settled attempts, drops simulated and duplicate ones, and flags only same-ask repeats | `improve.test.ts` ("kxm improve report resolves Runtime-settled attempts from the event log and flags only same-ask cross-run repeats"), `cli.test.ts`, `cli-experience.test.ts`, `commands-policy.test.ts` |
| Improvement candidates exclude write steps; promotion readiness never authorizes | `improve.test.ts` |
| Telemetry classification and JSONL recovery | `telemetry.test.ts`, `cli.test.ts` |

The context suites in detail:

| Suite | Covers |
|---|---|
| `context.test.ts` | Context schema round trips, hostile input, cross-project refusal, storage upgrade |
| `state.test.ts` | Temporal state lifecycle, `asOf` queries, supersession, contradictions, restart durability |
| `context-authority.test.ts` | Authority floor per origin, reserialization escalation, lineage bounds, control-plane smuggling |
| `arbiter.test.ts` | Role-aware packets, relevance ranking, first-fit budgets, the evidence section, contradiction routing |
| `context-surfaces.test.ts` | CLI and Pi tool parity for the context API |
| `journal-evolution.test.ts` | Journal categories, evidence requirements, governed promotion, stage provenance |
| `wiki.test.ts` | Wiki compilation determinism, lifecycle preservation, contradiction visibility, lint |
| `skills.test.ts` | Skill candidate lifecycle, quarantine, immutability, CLI |
| `routing.test.ts` | Behavioral hash, record parsing, comparisons, `kxm routing report` |
| `improve.test.ts` | Routing-record sources, event-log outcomes, same-ask candidacy, candidate files, promotion readiness |

## Claude Code plugin and MCP

| Behavior | Evidence |
|---|---|
| MCP tool catalog, outbound and inbound tools, and channel delivery | `mcp.test.ts` |
| The MCP server never registers with the persisted admin token | `mcp.test.ts` ("MCP server never registers with the persisted admin token") |
| Expired disk tokens and invalid `KXM_SESSION_TOKEN` values produce errors that name the user's fix | `mcp.test.ts` |
| MCP tools, Pi tools and CLI verbs match `AGENT_COMMANDS` exactly, plus the hook-only tools | `commands-drift.test.ts` |
| The plugin README tool table lists every tool the MCP server publishes | `claude-plugin-docs.test.ts` |
| `SessionStart` hook: silent outside a project, project-scoped, under 1,500 characters, never prints a session token | `claude-plugin-hooks.test.ts` |
| Hooks use exec form under `CLAUDE_PLUGIN_ROOT` with bounded timeouts, and run from a copied plugin directory | `claude-plugin-hooks.test.ts` ("plugin hooks use exec form under CLAUDE_PLUGIN_ROOT with bounded timeouts") |
| Terminal inbound cleanup and next-request activation | `extension.test.ts`, `mcp.test.ts` |

## Pi extension and workers

| Behavior | Evidence |
|---|---|
| Pi tools, inbound turns, automatic replies and the status command | `extension.test.ts` |
| Workflow and journal tools, workflow-context sends, and peer-reference checkpoints and waits | `extension.test.ts`, `mcp.test.ts` |
| Interrupted-worker continue fallback, run-bound recovery and one-turn durable replay | `worker.test.ts`, `recovery.test.ts`, `extension.test.ts` |
| Hub-owned workflow affinity, pre-acknowledgement routing, one-child session-directory swap, LRU retention | `hub-api.test.ts`, `extension.test.ts`, `worker.test.ts`, `cli.test.ts` |
| Provider-error retention, retry ordering, bounded fallback, oversized frames and session-preserving restart | `extension.test.ts`, `worker.test.ts`, `diagnostics.test.ts`, `cli.test.ts` |
| Tool allowlist, watchdog grace, hung-tool recovery and race-safe ownership claims | `worker.test.ts`, `cli.test.ts`, `hub-autostart.test.ts` |
| Exact extension and skill sets, discovery isolation, path preflight and Windows argument safety | `worker.test.ts` |
| Workspace defaults and persisted worker logs under isolated temporary workspaces | `worker.test.ts`, `hub-autostart.test.ts` |
| Opt-in real-Pi smoke contract and its safe skip paths | `smoke-real-pi.test.ts`, `smoke.test.ts` |

## CLI, configuration and trust

| Behavior | Evidence |
|---|---|
| `init`, `validate`, `export` and `watch` in isolated workspaces | `cli.test.ts`, `github-watch.test.ts` |
| Every mutating command under `--dry-run` leaves the workspace, state root and hub untouched | `cli-experience.test.ts` ("every mutating command under --dry-run leaves the workspace, state root, and hub untouched") |
| Hub auto-start reuses a healthy or claimed hub, persists one admin key, and fails closed on bad claims | `hub-autostart.test.ts` |
| Hub-local session brief from SQLite without message bodies; `hub bind` reports on, off or unknown | `session-work.test.ts`, `cli.test.ts` |
| Session manifests, fail-closed rosters, worker and result envelopes, hub-owned envelope fields | `session.test.ts`, `cli.test.ts`, `envelope.test.ts`, `envelope-contract.test.ts` |
| Metadata-only dashboard: ops mode, presence-only fallback, observer filtering, keys, body-free local projection | `tui.test.ts`, `hub-api.test.ts` |
| Restricted loader, deterministic bundle hash, init classification, atomic creation, three-way repair, crash resumption | `project-config.test.ts`, `cli.test.ts`, `package-install.test.ts` |
| Legacy `.kxm/config` JSON is refused with `legacy_state_unsupported`; `kxm migrate` is unknown; older stores are refused | `project-config.test.ts`, `cli.test.ts`, `e6-backup-restore-migrations.test.ts` |
| `kxm backup` and `kxm restore` round-trip the hub store and Runtime stores seeded under `.kxm/runtime/`; a project backup under `KXM_STATE_HOME` holds only its own event store and sidecar, and its restore leaves another project and the registry alone; `--all-projects` holds and restores every project and the registry, and restore refuses it without the flag; restore refuses while the supervisor or a hub is live, `--dry-run` included; tampered, newer or incomplete (`complete: false`) backups are refused | `e6-backup-restore-migrations.test.ts` |
| Permission-diff trust: authority lattice, prose neutrality, Git base shadowing, CLI diff and check | `permission.test.ts`, `cli.test.ts`, `contracts.test.ts`, `package-install.test.ts` |
| KXM schemas, restricted YAML fixtures, cross-resource semantics and sync-safe rejection | `contracts.test.ts`, `restricted-yaml.test.ts` |
| Harness detection, auth and dispatch for the built-in catalog, including Windows launch rules | `harness.test.ts` |
| `kxm update`: `update.yaml` validation, GitHub or npm version checks, install-kind detection, `kxm-<v>.tgz` asset selection | `kxm-update.test.ts`, `kxm-update-cli.test.ts`, `kxm-install-kind.test.ts` |

The round trip seeds its Runtime stores in a project-local `.kxm/runtime/`
layout that the Runtime never writes. Separate tests seed two projects' event
stores, their prompt sidecars and a shared registry under a temporary
`KXM_STATE_HOME`, at the paths the Runtime derives, and check each scope and
that a partial manifest is refused. The supervisor-liveness test fakes a live
supervisor with a fresh registry record naming the test's own PID; no test backs
up or restores stores a running supervisor wrote.

## Packaging, release and repository gates

| Behavior | Evidence |
|---|---|
| The packed CLI and hub run from a clean local install and an isolated global `--omit=peer` install | `package-install.test.ts` |
| Generated bundles and skill mirrors exist, are tracked and match the staged copy; mirror emit refuses symlinks | `generated-artifacts.test.ts`, `scripts/check-generated.mjs` |
| Every version surface matches; the bumper writes each workspace manifest and patches the lockfile by key | `scripts/check-versions.mjs`, `version-surfaces.test.ts` |
| Release packs `kxm-<v>.tgz`, uploads to a draft fail-closed, proves the digest and never clobbers | `kxm-release-github.test.ts`, `ci-contract.test.ts` |
| npm publish requires a published release and a matching asset digest | `kxm-publish-npm.test.ts` |
| CI required jobs are unconditional; runner selector, coverage floors and release triggers are pinned | `ci-contract.test.ts` |
| Skill suite: manifest shape, one owner per command, strict YAML frontmatter, no legacy names, mirror parity | `skill-suite.test.ts` ("every bundled SKILL.md frontmatter parses as strict YAML") |
| The extension and MCP server never import the hub, store or workflow; library bundles stay host-neutral | `import-boundary.test.ts` |
| Workspace packages keep their layers, required files and by-name imports | `package-layers.test.ts` |
| Retired product names stay out of the scanned docs | `docs-copy.test.ts` |
| Headless harness helper: auth probes, refusals before spawn, typed usage and cost, stdio and timeout handling | `harness-run.test.ts` |
| `justfile` gates: documented `just` verbs exist, runner call sites are pinned, no dotenv auto-load | `harness-run.test.ts` |
| Developer roster validation: vendors, read-only critics, pinned model-origin evidence | `roster-policy.test.ts` |

The `justfile` gates are drift protection, not a sandbox: anyone who can edit
the file can already do what it does. They run without the `just` binary and
skip the real-`just` checks, with a visible reason, when it is absent.

## Examples and fixtures

| Scenario | Location | Verification |
|---|---|---|
| Self-contained planner and reviewer round trip | `examples/roundtrip.ts` | Executed by `examples.test.ts` |
| Long-running deterministic reviewer | `examples/reviewer-agent.ts` | Type-checked |
| Command-line requester | `examples/requester.ts` | Type-checked |
| Signed external result callback | `examples/workflow-signal.ts` | Type-checked; the same signed path runs end to end in `hub-api.test.ts` |
| Peer provenance with optional degradation | `examples/provenance-workflow.json`, `docs/guides/provenance-gates.md` | Parsed and matched to the guide by `examples.test.ts` |
| Jira development webhook workflow | `examples/webhook-workflows/jira-development.json` | Not parsed by a test; `hub-api.test.ts` and `workflow.test.ts` exercise an inline definition of the same shape |
| Project fixture with `default.yaml` and `fix.yaml` | `examples/project/` | Compiled by `engine-compile.test.ts`; schema-checked by `contracts.test.ts` |
| Plan-then-review, separate ownership, delegation, cancellation, safe retry prompts | `examples/README.md` | Documented agent prompts; not executed |

## Coverage floors

| Run | Lines | Branches | Functions |
|---|---:|---:|---:|
| `test:coverage:core` (pushes to `main`, releases) | 91% | 80% | 92% |
| `test:coverage:complete` (nightly) | 93% | 80% | 93% |

Coverage measures `plugins/kxm/src/**/*.ts` and `packages/core/*/src/**/*.ts`,
excluding the spawned entry points `server.ts`, `mcp-server.ts` and
`runtime-supervisor.ts`. The generated MCP runtime is exercised as a child
process, and the packed CLI and hub run from a clean consumer install. The
floors only move up.

## Behavior without automated coverage

Some behavior can only be checked by hand, for example how a harness UI renders
a channel event. List it in the manual checks in
[CI and release](ci-and-release.md#manual-checks-before-announcing-a-release)
instead of implying automated coverage here. The developer
[assignment runner](assignment-runner.md#test-coverage-is-thin) has no
end-to-end tests.

## Related

- [Develop KXM](development.md): test conventions and the commit gate
- [CI and release](ci-and-release.md): which suites run where
- [Write KXM documentation](writing-docs.md): doc gates and pinned paths
