# Refinement decisions, 2026-09-04

Owner decisions from the one-item-at-a-time review of
[part 1](2026-09-04-plan-review.md) and [part 2](2026-09-04-plan-review-part2.md).
Each entry is final unless superseded by a later dated entry. Unit ids refer
to the [work plan](2026-09-04-work-plan.md).

## D1. MVP definition and critical path

**Decided.** MVP is not a phase number. It is the gate: on a fresh machine
with Pi, Claude CLI, and Codex CLI installed and logged in, `npm install`,
`kxm init`, then `kxm run default "prompt"` completes the simple workflow with
the planner and reviewer roles dispatched through at least two authenticated
one-shot harnesses (Claude and Codex) and the implementer through Pi on Grok
or GLM. Every attempt leaves a routing record with harness, provider, model,
tokens, latency, and cost basis. `kxm routing report` ranks routes by quality
then cost. `kxm improve report` shows recurrence, cost, and pass rate per step
and emits at least one candidate. `kxm dash` and the session brief show the
run and its spend. A logged-out harness fails closed at assignment.

Phase 3 splits into 3a (`default.yaml`) and 3b (`fix.yaml`, before Phase 7).
Harness split: Grok, GLM, and Kimi-by-API are Pi providers needing catalog and
price rows only; Claude, Codex, and Kimi CLI are one generic one-shot adapter
driven by catalog data. Kimi CLI and Gemini are MVP if their headless mode and
usage output verify, otherwise the first post-0.6.0 unit. A minimal
hand-maintained dated price catalog is MVP so `costBasis: metered` is
possible.

Not MVP: multi-repository, MOA and the full tier live, hub vNext and sync,
candidate activation and post-merge measurement, Studio, quota failover
across harnesses, supervised sessions for any harness but Pi.

**Units.** Critical path: B0, A and B slices, C1, D1 to D5, E4, E4b (generic
one-shot adapter with Claude and Codex, about 160k), E4c (Kimi and Gemini
verification, about 80k), E3, E8 (improvement report and candidate format,
about 120k), E1, E2, E7.

## D2. Coverage gate

**Decided.** Unit B0 adds tests for the update-notice paths so `main` is green
without touching the threshold or the include list. Unit B1 then inverts the
include to all of `plugins/kxm/src` with an explicit, reasoned exclude list,
sets the threshold at the measured whole-tree value, and adds a ratchet rule:
the threshold never goes down and any PR may raise it. Ninety-five percent
becomes a milestone, not a fiction.

## D3. Old names: break, do not brake

**Decided.** The plan's "brakes" wording meant breaking changes, not
fail-closed aliases with pointers. Old commands, slashes, headers, caller
ids, host-mode values, and metric names are deleted or renamed outright in
the same PR, with a CHANGELOG entry. No pointer messages, no header version
checks, no transition release; hub and workers ship in one package and
upgrade together. Unknown-command exit from commander is sufficient for
`kxm mesh`. Units A1 and A2 shrink to deletions and renames; the C1 plan
patch replaces "brakes" with "breaking changes are fixed in tree".

## D4. Hub binding and update safety

**Decided (5a).** Remove `--hub existing|new` from `kxm init`. Project init
is project init. Hub binding is a separate host-level command,
`kxm hub bind <url>`, which writes Runtime-local state (never Git), probes
`/health` with a short abort, and reports on, off, or unknown. `kxm hub
start` stays foreground until a post-MVP operations unit adds detach. The
first-run doc reads: `kxm init`, `kxm hub start` in another terminal, `kxm
hub bind <url>`, `kxm session brief`. Unit A3 changes accordingly.

**Decided (5b).** `auto` is read only from user state, never from the
project working directory. `kxm update --kxm` verifies the release asset
digest before install and detects the install kind (npm global, Pi git
install, Claude marketplace); any kind other than npm global fails closed
with the correct instruction. Unit A4.

## D5. Standard workflows

**Decided.** `kxm init` materializes four intent-named workflows; tier is a
property, not the name. `quick` (simple: plan, implement, verify, ready; 5
USD cap; `kxm run` default). `feature` (mid: adds an `agent` review step on a
different harness with a `plan_invalidated` back-edge, `delivery`, and a
`ci-watch` wait; 15 USD cap). `bugfix` (mid plus repro: intake from prompt or
`--ticket`, repro-write, repro-check as gate `test` with `expect: fail`,
plan, implement, verify with `expect: pass`, delivery, ready; runs on Phase
3a; `--ticket` fails closed until a tracker is bound). `improve` (simple:
report from `kxm improve report --json`, candidate artifact in the tracked
candidates directory, delivery opens the PR; lands with unit E8).

The full tier is `fix.yaml` with `intake` deleted (folded into
`repro-explore`) and both MOA targets cut from 3 to 2 (maximum 3, minimum
passed 2); it ships as `bugfix --template full` at Phase 7, and the Phase 7
gate uses target 3 as an explicit test fixture, not the default.

Legacy JSON workflows stay as migration fixtures only. The init template and
the fixtures are the same bytes, enforced by test. Gate and `kxm run` docs
reference `quick` instead of `default`; the rename is a breaking change per
D3.

## D6. Agent tool surface

**Decided.** `kxm <verb> --json` is the one agent API. Commands: `kxm peer
send|get|await|cancel|fanout|inbox|reply` and `kxm workflow
checkpoint|record|wait`. One command table module (name, description,
parameter schema, handler over the client) generates the CLI subcommands,
the MCP tool list, and the Pi tool registrations; a drift test fails when
they disagree; the TypeBox block and duplicated option builders are deleted.
KXM enforces the assignment's tool policy itself: the engine issues
`KXM_ATTEMPT_TOKEN` per attempt, `kxm session brief` issues a session token
for interactive use, and a command the policy does not grant fails closed
on every harness. `kxm peer await` is capped at 60 seconds; longer waits are
workflow `wait` steps. MCP stays as the generated wrapper (transport plus
inbox bridge only). Unit D6.

## D7. Tracking

**Decided.** The plan file keeps phases, gates, and one Landed line per
phase. Decisions live beside it in a dated append-only `decisions.md` (this
file is the seed). Landed goes to the CHANGELOG and closed issues. Still open
becomes a link to the open `slice` issue query. Issue #59 is closed with a
pointer to milestones; milestones per gate (3a, 4, 0.6.0, 5, 7, 8). One
issue per work-plan unit, one to three days, closed by one PR with
`Closes #N`, labelled `slice` and `phase:*`; work items are checkboxes in
the issue. PR template gains "Slice issue: #N". A plan edit ships in the
commit that justified it; a plan-only commit needs a gate result or
retrospective as its reason. Fable creates the labels, milestones, and slice
issues at the end of the 2026-09-04 session.

**Multi-repository rule.** A cross-repository change is one parent `slice`
in the control repository's tracker plus one `repo-slice` child per member
repository, each child closed by exactly one PR in that repository; the
parent closes only when every child has. This mirrors the sub-workflow
child-run model and the non-atomic delivery manifest.

## D8. Multi-repository layout

**Decided.** Sibling members with a reviewed commit pin. Members live
anywhere on disk as Runtime-local bindings. The project file records a
`reviewedCommit` per member, updated only by review (the delivery manifest
records the member commit and the merging PR bumps the pin), never by init.
`kxm trust diff` uses the pin as its base. The configuration revision splits
into a control revision (control-tree bytes only) plus per-member content
hashes pinned on the run; an absent member is a recorded state, never a
silent omission. Submodules become a later special case where the pin
equals the gitlink. Follow-ons: a repository-binding index in the Runtime
registry keyed by canonical member path (lease subject; two projects cannot
claim one repo; discovery from inside a member resolves the owner), and an
optional sub-path on a repository entry for monorepos with the worktree root
as identity anchor. Phase 5 gate unchanged.

## D9. Sub-workflows owned by member repositories

**Decided.** Step kind `workflow` is reserved in the schema now with
validation rejecting it as not yet supported; built as Phase 5b after the
reviewed commit pin (D8) lands. Identity stays the filename; the parent step
names `repository` and `workflow`; qualification appears only in run events.
The child definition (`.kxm/repo/workflows/<id>.yaml` in the member) is
pinned per run by the member's reviewed commit and content hash, never in
the control revision. Trust diff uses the pin as base; a member without a
pin fails closed. Member workflows are authored, never templated; no
provenance, no repair; `kxm repo list` shows drift by hash. The child is a
real run whose ceilings only narrow; depth two, no cycles, one active child
per step, child transitions count against the parent's limits. Fan-out over
every member that defines a sub-workflow is Phase 7.

## D10. Telemetry and cost

**Decided.** `kxm.routing-record.v2` per the part 2 schema. `costBasis:
metered | unmetered | unknown` required; `costUsd` required when metered;
reports show metered cost, unmetered attempts, and unknown-cost attempts as
three numbers, never one total; unknown is flagged and never ranked
cheapest. Records are the event `routing.attempt.recorded` in the
per-project event store, written in the attempt-settle transaction; the
engine refuses to settle without a cost basis; the JSONL reader remains for
legacy records only. Subscription routes are `unmetered` with a `priceRef`
to the dated catalog row; an "equivalent list cost" column is off by default
and enabled by a flag. MVP price catalog is a hand-maintained, dated, hashed
`.kxm/prices.yaml` with context tiers, input, output, cache read and write;
no row means `unknown`; the automatic feed is post-MVP. `maxModelCost` is
enforced by the engine before each dispatch on metered cost; unmetered and
unknown attempts count toward a separate attempt cap. Report groups by
harness, model, thinking, role; quality first, then cost per accepted
attempt; rework counts only back-edge re-entries. Prometheus metrics renamed
to `kxm_*` with attempt latency and metered cost added.

## D11. Storage, queue, logging

**Decided.** The legacy `kxm.db` is bounded to peer messaging through MVP,
with retention sweeps and query-on-demand replacing the boot-time in-memory
load; runs, routing records, and memory revisions live only in the
per-project event store; dash and brief read both through one union reader;
`kxm.db` is retired in Phase 8. Messaging gains a per-agent monotonic
sequence, a persisted consumer cursor, at-least-once delivery with dedupe on
event id, ack as cursor advance, and `UNIQUE(from, idempotency_key)` as MVP
because the D6 CLI surface depends on them; the dead-letter table and
operator view are post-MVP; SSE is notification only. One logger module
(level, timestamp, component, correlation fields, JSONL, size-capped
rotation, redaction on write, stdout only when not daemonized) used by hub,
worker, supervisor, and telemetry. `kxm backup` and `kxm restore` via the
SQLite backup API with a manifest, one shared `openDatabase`, and stepwise
migrations replacing the unconditional version stamp; no schema change
lands before them. `node:sqlite` stays.

## D12. Memory

**Decided.** Scopes agent, project, run, operator on the record; agent
scope first. Git holds what is authored and reviewed (`.kxm/memory/`,
promoted skills, project knowledge, policy) and is the activation boundary;
SQLite holds only what a rebuild reproduces (journal, episodes, evidence,
candidates, session cache). One schema-tagged record format (id, scope,
kind, summary, provenance, authority, confidence, lifecycle, evidenceRefs);
journal rows are a projection into it. A run pins its memory revision at
creation as the hash of the Git-authored set plus the promoted-state
snapshot and reads only that revision; it writes back only candidates at
evidence authority. Three rules become failing tests first (unit E5):
promotion requires a configured admin token with no loopback bypass; a
proposed item never reaches a packet; no record carries a control-plane
field. Harness views (unit E5b): `kxm memory brief --json` for any harness,
`kxm memory note` writes candidates only, `kxm memory sync` regenerates
marker-delimited blocks in `CLAUDE.md` and `AGENTS.md` and a `GEMINI.md`,
drift fails the generated-file check; the Claude session-start hook runs the
brief and there is no mirrored copy in the Claude memory directory. The wiki
stays a derived compile target behind the punt, and the live wiki commands
are gated behind it.

## D13. Packaging and portable skills

**Decided.** One npm package through 0.6.0. The five-layer boundary (core,
runtime, hub, cli, surfaces) is held by an import-boundary test; `exports`
subpaths for core, runtime, client, extension, mcp; `peerDependenciesMeta`
marks the Pi peers optional. Split only when a second consumer exists.
Studio ships as `@kontextmind/kxm-studio` from the start (Phase 10) and
`kxm studio` fails closed when absent. One authored skill tree; a generator
driven by `.kxm/harness.yaml` emits `.agents/skills`, the Claude plugin
manifests, a Gemini extension directory, the Codex TOML and `AGENTS.md`
block, and the `pi` fields in `package.json`; drift fails the generated-file
check. Order: `.agents/skills` and the Codex block are MVP (unit E4b); the
MCP registry manifest after public npm; the Gemini extension after that.
Per-harness enablement stays in committed KXM YAML; home-directory harness
configs are MCP install targets only. A logged-out harness may receive
install files but is not a routing target until its auth probe returns
true. Token delivery is closed by D6: the CLI reads the token from the
environment, so no harness config carries it.

## D14. KXM Studio (Phase 10)

**Decided.** Canvas for layout and structure, forms for contents, YAML never
carries layout. Coordinates live in a gitignored per-user sidecar
`.kxm/studio/layout/<workflow>.json` keyed by step id; ELK auto-layout is
the fallback when the sidecar is missing; on load, unknown step ids are
dropped and new steps are auto-placed, so a stale sidecar degrades to
auto-layout rather than lying. Canvas gestures: drag, zoom, group, collapse
(sidecar only); insert, reorder, delete, draw an edge (each maps to a typed
command and opens the inspector for the required fields, so an edge is
never committed on drop). Step contents are inspector only. The stepper is
the full-fidelity keyboard equivalent of every gesture. Stack: Vite, React
19, TanStack Router and Query, Tailwind 4 with shadcn copied in, CodeMirror,
the `yaml` document API, served by the hub on loopback with origin checks
and a session token, separate package. Round-trip: browser never touches
the filesystem; edits are commands applied to the parsed document,
validated, written to gitignored `.kxm/drafts/`; promotion is `kxm trust
diff` rendered as a review then a branch and PR through the delivery gate;
two mutations only; byte-identical no-op round-trip test enforces "no
coordinates in YAML, ever". AI assist returns a schema-valid patch applied
only by explicit accept; voice deferred and later gated on local
processing. Six slices as in part 2 section 12, with slice 3 gaining the
layout sidecar and slice 4 the three structural gestures.

## D15. Parallel runs, worktrees, state resolution, remote executors

**Decided.** The engine loop is run-scoped: N runs advance concurrently up
to the project's `maxConcurrentRuns`, and runs in different projects never
contend. Each run executes in its own Git worktree created from HEAD on
branch `kxm/run-<id>`, located under the user state root, never inside the
repository. Dirty snapshots, multi-repository coordination, and delivery
manifests stay Phase 5; parallel assignments inside one step stay Phase 7.
Durable state (registry, event stores, bindings, hub state, caches) always
resolves through the main worktree, never a run worktree's path; a test in
unit D4 proves `kxm` inside a run worktree sees the same project and runs
as the main checkout. Git-tracked `.kxm` configuration travels with the
branch and a run pins its configuration revision at creation; a run branch
editing a workflow file is a permission diff. SSH and exe.dev executors
remain Phase 6, off the critical path: the Runtime stays local, the remote
is an executor reached by SSH key plus a pushed single-file helper, and
harness auth on the remote is the real setup cost (subscription CLIs must
be logged in there or fail closed; Pi with granted API keys is the
zero-login path). A research pass on exe.dev precedes sizing.

## D16. Remote executors timing

**Decided.** SSH and exe.dev executors do not displace any MVP unit. They
stay Phase 6, off the critical path, and the exe.dev research pass runs
when Phase 6 is scheduled, not before.

## D17. Writer role moves to the Grok CLI (2026-09-04, supersedes part of D1)

**Decided.** The implementer dispatches through the **native `grok` CLI**
(`grok --prompt-file <brief> -m grok-4.6 --always-approve`), not through Pi.
This is the provider-native rule applying to xAI for the first time: `grok`
1.0.13 is installed and OAuth'd to `auth.x.ai`, so Pi's `xai` provider is no
longer the best authenticated route for Grok.

**Tightened 2026-09-05.** Auth evidence is `grok models` (logged in with
grok.com, default grok-4.6). Do not read `~/.grok/auth.json` or dump env.
If `grok` is missing or logged out, **fail closed**. Pi's `xai` provider is
not a writer fallback. Native-provider Pi brakes also cover anthropic,
openai, moonshot, google, and deepseek. OpenRouter remains a Pi provider
authenticated by `pi auth check --provider openrouter`.

Verified before switching: `grok` writes files headlessly in a given `cwd`,
reports `modelUsage` and `total_cost_usd` in a shape near-identical to the
Claude CLI's, and resolves `grok-4.6` to the `grok-4.6-build` effective model.

**Scope limit.** This changes the writer's harness only. `kxm agent worker` /
`pi --mode rpc` stays Pi-only: `grok` is a one-shot headless writer, not a
supervised long-lived worker. D1's MVP gate is otherwise unchanged, except that
the implementer arm now reads "through the Grok CLI" rather than "through Pi on
Grok or GLM". The repo helper is not a Phase 11 adapter.

**Consequence for D10.** `grok`'s native `--output-format json` already carries
per-model tokens, cache reads, and cost, so the routing record for a writer
attempt no longer has to be reconstructed from Pi's envelope. Token aggregates
are cumulative; context occupancy is explicit unknown (do not infer peak
window from totals).
