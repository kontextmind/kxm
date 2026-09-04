# KXM vNext implementation plan

This plan is ordered by contract dependency. A later phase MUST NOT weaken an
earlier phase's authority, recovery, isolation, or synchronization invariants.

## Tracking (working tree, not a release)

This section records product decisions and slices from operator review of the
slow `/fix` loop, harness/YAML setup, live peek screens, and the KXM rename.
It does not replace the phase gates below.

### Decided

- Product name is **KXM**. Do not present Mesh or pi-extensions as the product.
  Plugin, marketplace, and npm identity are `kxm` / `@kontextmind/kxm`.
- Durable hub SQLite default is `.kxm/state/kxm.db` (`KXM_DATA_PATH`).
- Hub process CLI: `kxm hub start` / `kxm hub view` / `kxm hub stop`.
- Live operator screens: `kxm dash` (not TUI/watch). Tabs: Agents, Tasks,
  Workflows, Plans, Inbox, Procs. Wide terminals use list+detail panes.
- Agent/model config is Git YAML. Omit `harness` (and `defaultHarness`) for
  **Pi**. Other harness ids (`claude`, `kimi`, `codex`, `gemini`, `deepseek`,
  and later others) are declared on the agent. No second enable/disable
  preferences file.
- A harness only runs models it actually hosts (Claude ≠ Grok; Codex ≠ Kimi).
  Only Pi is the long-lived headless worker. Other CLIs may be interactive or
  one-shot (`claude -p`, `codex exec`); listing them does not mean they can be
  supervised like Pi. Invalid harness/model pairs fail closed at assignment
  (Phase 4/11), not by inventing a compatibility matrix in YAML.
- **Provider-native harness preference:** when assigning a model, if that
  provider has a first-party harness and `kxm harness list` shows it
  detected **and authenticated**, dispatch through that harness. Do not use
  Pi’s bundled provider credentials to impersonate a logged-in subscription
  CLI. If the native harness is absent or logged out, fail closed (or prompt
  login) rather than silently switching to Pi. Pi remains the default
  long-lived worker only for providers it hosts that have no authenticated
  native harness (e.g. xAI/Grok today).
- Anthropic subscription models are the motivating case (Claude CLI vs Pi
  Anthropic API keys). The same rule applies to Codex, Kimi, Gemini, DeepSeek,
  and later harnesses.
- **Cost efficiency and tracking are required**, not optional telemetry.
  Every dispatched assignment records harness, provider, model, thinking,
  **context tokens (in/out/cache when known)**, latency, cost (or explicit
  `unmetered`/`unknown` — never a silent omit), and outcome (verify passed,
  rework, fail). Some models/providers **price by context** (long-context
  tiers, thinking tokens, cache miss vs hit). Routing must compare cost at
  the actual context, not list price alone. Prefer an authenticated
  provider-native harness over Pi API keys for the same lab.
- **Insights loop:** `kxm routing report` (and `kxm dash` spend/quality
  views) exist to keep models **fast, efficient, high-quality, and cheap**.
  Use them to pick harness/model/thinking for the *next* run, not as a
  museum. If two routes match quality, take the cheaper/faster one. Extra
  critics and xhigh thinking need evidence they reduce rework. Plan hygiene
  may drop or split slices when the report shows a route is waste. Fail
  closed rather than overflowing onto an untracked or wrong-credential path.
  Run `limits.maxModelCost` remains the hard stop.
- **Side-by-side analysis:** optional, explicit comparison runs (same task,
  two or three harness/model arms). Results feed routing telemetry. Not the
  default operator loop; not a Phase 7 quorum.
- **Subscription / quota failover:** ordered eligible set from authenticated,
  model-capable harnesses (quality then cost). On quota, rate-limit, or auth
  loss, skip to the next eligible arm. Do not fail over onto Pi’s other-provider
  API for a vendor whose native harness just exhausted. Record exhaustion. An
  empty set fails closed with the limits that fired. Fallback is not an
  independent critic.
- `kxm harness list` is observational (installed/authenticated), not a
  headless-capability claim. `kxm update` delegates to each harness's own
  updater. Governed `kxm skills` are not auto-updated.
- Daily operator loop is a slim `default` path (plan → implement → verify →
  ready), not the 13-stage `/fix`. Dual-critic `/fix` and three-provider review
  are Phase 7. Independent repro-before-oracle stays for `/fix`.
- CLI Fable/Codex/Kimi critiques are artifacts plus human signoff, never
  hub `peer-reply` evidence.
- Workflow fixture ids: `kxm-provenance`, `kxm-v04` (not `pi-extensions-*`).

### Landed in this tree (unreleased)

- Plugin/package/skill/MCP rename toward `kxm`; tools `kxm_list` / `kxm_send` / …;
  env prefix `KXM_*`.
- `kxm dash` tabbed dashboard; hub ops snapshot carries run progress and plan
  summaries (no message bodies).
- `defaultHarness` / agent `harness` schema fields; unknown harness fail-closed;
  omitted harness equals `pi` in permission projection.
- Harness catalog + `kxm harness list` + `kxm update`.
- Phase 2 Runtime create/recover (PR #75) is in tree: supervisor, event store,
  projections, crash recovery. Runs stay `created` until Phase 3.

### Still open

- Rebuild generated `plugins/kxm/dist` and run full `npm test` after the latest
  CLI rename.
- Docs sweep: operator pages updated to `kxm hub start|view|stop` and `kxm dash`;
  CHANGELOG history may still mention old names.
- Remaining `kxm mesh` group (`init`, `smoke`) — fold or drop; do not keep Mesh
  as a product name.
- Internal type names (`MeshClient`, `MeshDashboard`).
- Slim live `default` workflow for this repo (no bulk migrate of jira/provenance/v04).
- YAML-editing enable/disable UI (Phase 4 `/kxm` settings or `kxm dash` config
  tab). Do not add a preferences overlay.
- Phase 3 engine (model-free driver on `default.yaml` **and** `fix.yaml` with
  simulated producers; caller-authored replies rejected).
- Non-Pi dispatch adapters (Phase 11). Listing a harness does not execute it.
- Confirm GitHub repository identity (`kontextmind/kxm` vs current remote).
- **SCM and issue trackers:** detect from repo conventions (git remote, CI
  layout, issue-key patterns) and **confirm at workflow/project creation**.
  Do not hard-code GitHub. Implemented today: GitHub webhooks + `github watch`,
  Jira inbound webhooks, `generic` HMAC. GitLab CI/issues and other trackers
  are later adapters; an unimplemented choice fails closed. Git remotes stay
  forge-agnostic. Not a Phase 3 gate.
- **Model catalog and pricing feed (post-MVP to land, design now):** refresh
  available models via native harness updaters (`kxm update --models` and
  peers). A dated, hashed catalog (vendor or aggregator JSON — not LLM
  guesswork) should carry model ids, context-tier list prices, and cache
  rates. “Top providers” = catalog ∩ authenticated harnesses, ranked by our
  routing report (quality, latency, **actual** spend), not marketing. Stale or
  missing prices are `unknown`; never underquote. Not a Phase 3 gate.
- **Post-MVP (do not implement now):** API budgets and **rollover** — spend
  leftover subscription/API allowance before buying the next increment when
  the insights loop says it’s worth it; cap and failover already apply. Keep
  this in later-phase planning (routing/dash/web cost views). Must not enter
  Phase 3–5 gates or the daily loop.
- **Improvement → coded steps:** the insights loop should propose turning
  repeatable LLM asks into deterministic workflow gates, scripts, or tests
  so models keep judgment only. Goal: less provider load, same quality,
  stronger consistency. Activation is Git-reviewed (skills/gates/workflow
  YAML) — telemetry cannot grant tools or skip a gate. Fits Phase 9
  (candidates) and plan hygiene; do not auto-rewrite workflows in MVP.
- **Gates/tests enforce loops.** Operator loops (slim default, harness
  routing, quota failover, cost caps, coded-repeat promotions) are held by
  failing tests and workflow `gate` steps, not by asking the model to
  remember AGENTS.md. A loop without a gate will drift. Phase 3+ engines
  must fail closed when a required gate is skipped.

### Plan hygiene (periodic, not every turn)

Update this file when it **changes later work**, not as a diary.

Do it when:

- a phase gate passes or a slice lands that later phases depend on;
- a decision contradicts Tracking or a later gate;
- a retrospective shows a slice is too slow, too wide, or in the wrong phase;
- operator CLI/product names change.

Then, in the same change:

1. Move items between **Still open**, **Landed**, and **Decided**.
2. Adjust the affected phase's implemented-slice note and **Gate** sentence.
3. Drop or split a future slice if it is overlay, duplicate, or too early.
4. Do **not** pull Phase 7+ MOA or Phase 11 adapters into earlier gates.
5. Do **not** rewrite the whole plan; patch the few paragraphs that aged.

Claude (Fable) proposes plan/slice edits. Grok applies them with the code or
docs change that justified the update. Tests stay the verifier.


## Phase 0: contract package

Deliver this directory, machine-readable schemas, a complete YAML fixture,
contract validation tests, lifecycle tables, effect rules, sync allowlists, and
the migration matrix.

**Gate:** schemas and examples validate; current behavior is clearly separated
from planned behavior.

## Phase 1: project configuration and initialization

Implement restricted YAML loading, project/repository discovery, resource
resolution, templates, three-way reconciliation, and idempotent `kxm init`.
Support create, join, repair, resume, and legacy JSON migration.

**Implemented slices:** restricted parsing, exact-schema and semantic bundle
validation, path-derived discovery, deterministic configuration hashing, init
state classification, provenance-tracked atomic creation, rewrite-free
revalidation, explicit join, bounded Runtime-local member-repository binding
persistence, process-death-released mutation locking, resumable pinned create
and repair operations, and exact whole-file three-way template reconciliation.
Automatic repair is limited to conflict-free changes whose conservative
authority projection is unchanged; provenance-free files, overlapping edits,
template deletions, and authority changes remain non-mutating plans. Bounded
legacy JSON conversion is implemented: `kxm migrate plan|apply|verify`
converts `agents.json`, `gates.json`, and workflow-definition JSON into
validated vNext resources with explicit operator decisions for terminal
status, transition budgets, evidence-policy strengthening, secret-reference
drops, narrowed permission ceilings, and identity mapping, then installs
atomically with a hash-linked `kxm.migration-receipt.v1` that keeps legacy
inputs read-only. The permission-diff trust workflow is implemented:
structured field-addressed authority projections per resource kind, a
deterministic `kxm.permission-diff.v1` report classifying every change as
expansion, narrowing, or neutral across conservative lattices (repository
access, network, budgets, quorums, snapshots, secrets) with everything else
fail-closed to expansion, `kxm trust diff|check` against a base Git revision,
and template repair blocking issues enriched with the exact field-level diff.
Database/WAL migration and active-run cutover remain later-phase work; the
Phase 1 gate passes for configuration and initialization.

**Gate:** a project can be reproduced from Git on a second machine without a
hub and without overwriting edited files.

## Phase 2: event-sourced local Runtime

Implement the per-user Runtime supervisor, authenticated local API, Runtime
registry, per-project SQLite event stores, projections, command idempotency,
outbox, auto-start, and crash recovery.

**Implemented slices:** supervisor, local API, registry, per-project event
store, command-idempotent run acceptance (prompt hashed, not stored), projection
rebuild, cancel-to-terminal, crash recovery, `kxm runtime start|status|stop`,
and `kxm run` create/recover with the hub absent. Runs remain `created`.
Compiled step execution is Phase 3.

**Gate:** `kxm run` creates and recovers a local owned run with the hub absent.

## Phase 3: ordered workflow engine

Implement compiled sequential steps, typed bounded transitions, step attempts,
assignments, physical attempts, join rules, budgets, deterministic gates,
waits, approvals, steering, cancellation, and uncertain-effect handling.

**Gate:** a model-free test driver completes and recovers
`examples/vnext/.kxm/workflows/default.yaml` (plan → implement → verify → ready)
and `fix.yaml` (approval, two-producer join, rework) without illegal transitions
or evidence reuse. Joins use driver-simulated identities. Caller-authored
replies are rejected. Out of gate: live models, provider-distinctness,
all-settled degradation. Pi/CLI executions do not satisfy this gate.

## Phase 4: Pi adapter and Pi-native UX

Implement Pi model/auth discovery, supervised RPC sessions, per-run
coordinators, scope epochs, tool presets, model profile/tag resolution, the Pi
status line, `/kxm` menu, settings, and validated agent/workflow/model editors.

**Config slice (landed, unreleased):** harness catalog with Pi as default
headless; `kxm harness list` / `kxm update`; `kxm dash` as the operator peek;
`kxm hub start|view|stop`. YAML remains the only enablement surface.

**Still this phase:** Pi RPC adapter, per-run sessions, `/kxm` menu,
validated YAML editors (enable/disable harnesses and models by editing Git
files, not a parallel store), assignment dispatch that binds harness from
auth inventory, and routing records that always include harness+cost.

**Gate:** `kxm init` followed by `kxm run default "prompt"` resolves the
materialized `default.yaml` and completes a single-repository Pi workflow with
visible local status (`kxm dash`). `fix.yaml` is not required to run live.

## Phase 5: multi-repository local release

Ship the local Runtime track publicly beside, not on top of, the legacy hub
engine. Explicit `kxm init`/migration receipts activate vNext resources per
project; existing hub runs and mesh commands remain on their current contracts.

Implement worktrees, dirty snapshots, one-writer leases, multi-repository
bindings, default-derived environments, host secret grants, local logs,
repository-aware timing, patches/local commits, and non-atomic delivery
manifests.

**Gate:** the public local release runs a dirty two-repository workflow through
a Runtime crash without a hub or secret leakage.

## Phase 6: SSH and exe.dev

Implement a generic SSH executor, built-in exe.dev profile, versioned remote
helper, verified workspace transfer, event cursors, process reattachment,
secret grants, cleanup/retention, and uncertain remote-effect recovery.

**Gate:** one workflow produces equivalent contracts locally and through
exe.dev, including connection-loss recovery.

## Phase 7: MOA and local orchestration breadth

Implement provider-distinct model panels, all-settled joins, explicit diversity
degradation, bounded parallel assignments, disagreement-preserving synthesis,
and time/cost/transition budgets.

**Gate:** a three-provider review tolerates one failed member without inventing
quorum or hiding dissent. This is the first live multi-critic `/fix`. Until then,
two-producer joins are exercised only by the Phase 3 driver. Earlier phases fail
closed on missing producers rather than degrade them.

## Phase 8: multi-project hub vNext

Begin the hub compatibility release and cutover described in
[Migration](migration.md). Implement project/runtime enrollment, immutable
configuration snapshots, run
requests, sync-safe event ingestion, project stores, capability scheduling,
shared-action leases, offline reconciliation, and aggregate TUI read models.
Migrate current schema-v3 hub data behind a compatibility release.

**Gate:** two Runtimes execute and synchronize independent offline runs but
cannot perform conflicting shared mutable actions without fencing.

## Phase 9: context and reviewed improvement

Implement memory revisions, local bounded replicas, role-aware context,
evidence-linked candidates, protected evaluation, Git patch promotion, and
revision-aware effectiveness statistics.

**Gate:** a candidate is evaluated, reviewed through Git, activated only for a
future run, and measured against its declared outcome. Routing/cost/latency
insights may propose harness or model changes **or** replacing a repeated
agent step with a deterministic gate/script. They cannot raise permissions
and cannot activate without the same Git review path.

## Phase 10: web dashboard

Build project, Runtime, run, configuration, repository, model, timing, cost,
artifact, memory, and improvement views from the same read models and command
APIs as the TUI. Add TLS and RBAC before non-loopback deployment.

**Gate:** every web mutation is audited and reproducible through the command
API; no web-only workflow logic exists.

## Phase 11: harnesses and strong isolation

Add Claude Code, Codex, Gemini, Kimi, DeepSeek, and generic process adapters;
container/OS isolation; persistent outbound remote Runtimes; multi-user RBAC;
and explicit high-availability/takeover fencing.

`kxm harness list` may already show these CLIs. Dispatch is this phase. An
enabled-in-YAML harness without an adapter fails closed at assignment time.
Earlier Claude CLI use is allowed; CLI output is not hub peer evidence.

**Gate:** unsupported capabilities fail explicitly and no adapter weakens the
common result, effect, secret, or recovery contracts.

## Cross-cutting test gates

Every phase adds:

- unit and schema tests;
- property/model tests for state machines;
- forced-crash and duplicate-command tests;
- Windows and Linux path/process tests;
- cross-project security tests;
- redaction and no-secret-output tests;
- opt-in real harness/external integration tests where deterministic fakes are
  insufficient;
- documentation and migration updates in the same change.

Generated package artifacts remain reproducible and the existing `npm run
validate` gate remains green throughout migration.
