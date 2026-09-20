---
schema: "kxm.doc.v1"
id: "PLAN-IMPLEMENTATION"
type: "architecture"
title: "KXM implementation plan"
project: "kxm"
status: "approved"
owner: "kxm"
created: "2026-09-02"
updated: "2026-09-20"
authority: "instruction"
confidence: "verified"
summary: "Sole active execution tracker for KXM phase gates, Tracking, and Still open work."
tags: ["runtime", "tracking"]
related:
  - research-memory-studio-forks.md
  - research-kxm-harness-strategy.md
  - plan-unified-kxm-milestones.md
  - research-harness-streaming-capabilities.md
  - research-runtime-language-choices.md
  - research-additional-forks.md
  - research-agent-producer-architecture.md
  - plan-additional-providers-agy-kimi.md
  - plan-agent-communication-steering.md
  - plan-ssh-remote-execution.md
  - research-a2a-cross-host.md
  - plan-token-reduction-rtk-ai.md
  - plan-usage-cost-quota-tracking.md
  - plan-workflow-modes-selective-loading.md
  - history/control-plane-memory-questionnaire.md
  - history/v05-context-os.md
  - history/plan-safety-security-process-integrity.md
  - history/plan-role-configuration-governance.md
depends_on: []
blocked_by: []
details:
  describes: "current"
  baseline_commit: "6157933"
---

# KXM implementation plan

This plan is ordered by contract dependency. A later phase MUST NOT weaken an
earlier phase's authority, recovery, isolation, or synchronization invariants.

## Tracking (working tree, not a release)

This section records product decisions and slices from operator review of the
slow `/fix` loop, harness/YAML setup, live peek screens, and the KXM rename.
It does not replace the phase gates below.

### Related plans

This file remains the only execution tracker and the authority for accepted
decisions, owners, start triggers and phase gates. Drafts cannot change a gate.

- **Consolidated scope:** [M0–M9](plan-unified-kxm-milestones.md) is the single
  proposed delivery catalog for all 36 fork reviews, including memory, Studio,
  coordinator inboxes, engine comparisons and optional runtime experiments.
  Its supporting-reference map links the six research reports and six thematic
  designs. Read it for **scope and contract dependency only** — delivery order is
  Still open → The one queue here, not the catalogue's numbering; record selected slices and
  actual status here.
- **Hosting (outside the fork catalog):**
  [plan-per-tenant-hosting.md](plan-per-tenant-hosting.md) is proposed scope for hosting
  KXM beside `kxmd-portal` — one tenant per box, Authentik at the edge, token auth
  unchanged, no PostgreSQL write path, and the S0–S5 queue lives in Still open — design
  record at
  [reviews/authentik-hosting-design-astra.md](reviews/authentik-hosting-design-astra.md).
  It is not a second backlog: accepted slices and status belong here, and it touches
  Phase 8 and Phase 10 without changing either gate.
- **Cross-host / A2A research:** [research-a2a-cross-host.md](research-a2a-cross-host.md)
  is a 2026-09-17 web-source record, recovered from the uncommitted
  `claude/a2a-host-communication-7efe50` worktree and reconciled against this tracker on
  2026-09-20. Its **Status against Tracking** section and the status column of its
  recommendations table mirror this tracker and create no backlog. Its M0–M9 sequencing
  is recorded there as a rejected proposal; A2A remains a projection of the journal, never
  its transport; coordinator inboxes and steering stay post-MVP behind their triggers;
  remote MCP on the hub and wiki compile are unselected with no trigger. Its hosted-hub
  topology (one `kxm-hubs` VM, per-account processes, hub as OAuth resource server) is
  superseded by the four per-tenant hosting rulings below and
  [plan-per-tenant-hosting.md](plan-per-tenant-hosting.md).
- **Research and thematic designs:** source findings, candidate contracts and
  experiment matrices remain supporting evidence. Their old milestone/stage
  tables do not create another backlog. The provider draft's AGY/Kimi-to-Pi
  migration objective is superseded by the native-auth decisions below.
- **Final consolidation review:** [review record](reviews/plan-consolidation.md)
  records reconciled overlaps and remaining decision gates. It is document-review
  evidence, not feature acceptance or a Phase 11 witness.
- Archived / superseded (stubs remain at the old `plans/` paths):
  [`control-plane-memory-questionnaire.md`](history/control-plane-memory-questionnaire.md)
  (closed design record),
  [`v05-context-os.md`](history/v05-context-os.md)
  (superseded design record),
  [`plan-safety-security-process-integrity.md`](history/plan-safety-security-process-integrity.md)
  (complete, Stages 1–6 via #188/#189),
  [`plan-role-configuration-governance.md`](history/plan-role-configuration-governance.md)
  (#192; Eddie archived despite `task_d3e634858295` still `in_progress` and no
  committed `.kxm/role-hosts.yaml`)

### Decided

- **Single operator: no migrations, no legacy support, minimal tests (2026-09-20).**
  Nobody else runs this. Old state is deleted and re-created, not upgraded, and nothing
  carries a second shape of anything for the sake of a file that no longer exists. Applied
  immediately: the stepwise schema-migration lanes are gone (`DatabaseMigrationStep`,
  `migrations` on the store spec, `HUB_STORE_MIGRATIONS`, `EVENT_STORE_MIGRATIONS`) — an
  older stamped database now fails closed with `runtime_schema_outdated` telling the
  operator to delete the file or re-init, and refuses without relabelling it, because a
  version bump without the schema underneath shows up later as a query against columns
  that are not there. Gone too: the pre-canonicalisation coordinator fingerprint
  tolerance, which existed only to forgive rows written by a released 0.7.46 — a stale
  coordinator is re-bound, and `ceilingsMatch` compares the stored fingerprint.
  **Test policy that follows from it:** one focused named test per behaviour that can
  actually break, in an existing suite, chosen for what it would catch — not one test per
  review comment. Deleting a compatibility path deletes its tests rather than converting
  them, and the remaining race tests lost their legacy fixtures with it.
  What this does **not** license: weakening fail-closed brakes, dropping the fixed witness
  or the two-critic acceptance, or shipping a claim a mutation run has not checked.

- **Future coordinator inboxes and Studio (operator, 2026-09-14):** investigate
  persistent primary/coordinator identities with internal inboxes, then optional
  email and SMS bindings independent of model or native session. Messages enter
  the existing Runtime's durable command/policy flow; inbox delivery, wake,
  execution and outbound delivery are separate states. Build shared read models
  and revision-safe editing for Studio; keep memory provenance and reviewed
  activation. Transport setup, send authorization and external deployment are
  future delivery work, not performed or accepted by the research.
- **Runtime/setup investigation (operator, 2026-09-14):** assess uv-managed
  Python and Rust where they improve the unified KXM setup or capabilities.
  No migration is selected. Compare against the existing TS implementation,
  preserving one KXM entry point, shared contracts and native authentication.
  Optional runtime adoption needs component-specific evidence and distribution
  tests; advertised language speed is not acceptance evidence.
- **One KXM installation (operator, 2026-09-14):** integrate the useful fork
  capabilities into `@kontextmind/kxm` shared services and thin host adapters,
  without requiring separate Pi extension installations. Target equivalent
  feature contracts through CLI/MCP/native integrations, with explicit host
  limitations and KXM-managed optional runtime prerequisites. Preserve native
  authentication, current permission/evidence contracts and phase boundaries.
  Investigate structured streaming, workspace/session controls and inbound
  channels; observed flags do not admit a harness. Deliver live progress before
  live steering. M0–M9 scope and gates remain proposed in the linked packet.
- **Plan source of truth (2026-09-10; archive 2026-09-11):**
  `plans/implementation-plan.md` is the only active execution tracker. The
  closed design record
  [`control-plane-memory-questionnaire.md`](history/control-plane-memory-questionnaire.md)
  and the superseded design record
  [`v05-context-os.md`](history/v05-context-os.md) live under `plans/history/`;
  thin stubs remain at the old paths. Neither document may create work, alter
  a phase gate, or keep a slice in an ambiguous in-review state. Deferred work
  must be listed here under **Still open** with an owner/trigger or remain
  historical.
- **Per-tenant hosting: tenancy is the machine, hosting is optional, and the hub owns
  no browser (2026-09-20; rewritten in place after review found the first version still
  directed work it had cancelled, and the second version of this rewrite deleted
  unrelated Decided entries by anchoring on the wrong end marker — restored from
  `d8ed4b2` and re-applied). Boundary in
  [plan-per-tenant-hosting.md](plan-per-tenant-hosting.md); design record in
  [reviews/plan-set-reprioritization-astra.md](reviews/plan-set-reprioritization-astra.md)
  and [reviews/authentik-hosting-design-astra.md](reviews/authentik-hosting-design-astra.md).**
  Four rulings, each chosen because a smaller one was available.
  **(1) One tenant = one box = one hub.** The hub carries a tenant *label*, not a tenant
  table, and binds loopback. Capacity is **incremental disk, bandwidth and one additional
  supervised process** on a box already provisioned for `kxmd-portal`: the hub *is* an extra
  service and is counted in RAM and restart behaviour; only the machine is not new. Separate
  boxes sharply reduce blast radius, and do **not** prove the portal cannot select the wrong
  tenant's credential — that is a live failure mode, which is why bindings are server-held and
  project-fixed rather than browser-supplied.
  **(2) Hosting is additive, and a browser outage may not degrade the machine path.**
  `KXM_AUTH_TOKEN`, `KXM_PROJECT_TOKENS`, the generated-and-persisted hub record,
  `kxm hub bind`, the loopback convenience and client credential precedence are unchanged;
  `kxm hub start` on a laptop behaves exactly as before. Hosting is enabled by explicit,
  inspectable configuration, never inferred from which environment variables happen to be set.
  **A hosted deployment whose proxy or Authentik is broken denies browser access and keeps
  serving authorized machine clients** — the hub must not stop accepting valid bearer traffic
  because a browser path is down, and must not start trusting identity headers on a machine
  that never opted in.
  **(3) Authentik and the portal own the browser; the hub interprets no browser identity.**
  The portal's server-side backend calls the loopback hub and supervisor with existing machine
  credentials; browsers talk only to the portal. Deleted from this plan, not deferred: a
  hub-side `/kxm/` browser surface, hub-side tenant/subject/capability validation,
  viewer-versus-admin credential kinds, a `kxm hub auth` verb family, and `kxm hub footprint`
  as a product command. Rejected rather than staged: hub-side OIDC callback, JWT
  verification, token broker, refresh, session store, cookie framework or crypto, SCIM, user
  accounts and per-user RBAC — see the KB page that used to recommend two of them.
  Reconsidering any of them needs a **new written decision**, not a trigger arriving.
  Machine-credential rotation stays with existing token resolution and deployment config.
  **(4) No PostgreSQL write path.** SQLite stays authoritative per tenant box. Measured,
  because the operator asked for a recommendation rather than a hedge: **105**
  prepared-statement call sites plus **41** `exec` calls across the five coupled files
  (**120** lexical prepares in `plugins/kxm/src`, including the shim's forwarding call);
  **23** distinct literal `CREATE TABLE` targets (7 hub, 2 registry, 13 event store, 1
  external effects); hub store **v3**, event store **v5** with v6 pending; `VACUUM INTO`
  backup/restore with integrity check, hashed manifest and version ceiling; plus the
  transaction and contention semantics hardened over the intake review passes. The tenant box
  owns the **complete state set** — hub database, Runtime registry, per-project event stores,
  bindings, prompt sidecars and configuration — and that set, not one file, is the backup,
  restore and migration unit. Smallest cross-hub visibility is a portal-owned list of tenant
  endpoints, each read by its own portal backend over read models that already exist
  (`/v1/ops/snapshot`, `/v1/events`, `/v1/agents`, `/v1/messages`, `/v1/workflows`,
  `/v1/improvements`); do not centralize raw events, prompts or credentials, and never expose
  hub or supervisor ports. A **disposable, rebuildable per-hub reporting projection** on
  `kxm-dev-svr` is allowed only when a concrete report needs retained cross-hub history that
  bounded summaries cannot answer, or measured polling misses an agreed refresh target after
  bounding and caching — hub count alone is not a trigger; planning allowance 2–5 days for
  one bounded report. A shared multi-tenant hub schema is ruled out, not deferred: it turns
  one-box isolation into a per-query invariant where one missing `tenant_id` predicate is a
  cross-tenant incident, and makes hub migrations coordinated releases. If Postgres becomes
  primary storage anyway, this stops being the fast hosting MVP: synchronous APIs,
  transaction semantics, SQLite dialect, direct readers, migrations and backup need their own
  plan measured in weeks, and the pending v6 identity work must be reconciled with it rather
  than ported twice.
  **Delivery is the S0–S5 queue in Still open** — zero schema change in S1–S5, at most one
  named test per slice, no new npm script or CI job. Two facts ride in the queue because they
  make an operator believe something false rather than merely incomplete: a drive is
  **asynchronous**, so a refresh, timeout or vague answer may not present `202` as completion
  or re-issue an uncertain effect; and two success paths in the current tree execute nothing —
  the standalone Studio mutation fallback answers `ok: true, mappedToCli: true` with no
  handler wired (`studio-layout.ts:423`, `cli/tasks.ts:302`), and the selected Pi route's
  `determineOutcome` can take an outcome *word* out of prose and otherwise return `passed`
  (`pi-producer.ts:85`). Hosted surfaces may not inherit either, which is why the Pi fix is
  S3 rather than post-MVP: a lying success path is not a deferred hardening item, because
  every later improvement cycle reasons over its data.

- **Role configuration governance archive (2026-09-12):** Eddie archived
  [`plan-role-configuration-governance.md`](history/plan-role-configuration-governance.md)
  after #192 (role hosts, TerminalReceipt, autoResumeLimit / audit
  escalation, `kxm role resume` / `kxm role hosts`). A thin stub remains at
  the old path. Archive stands even though `task_d3e634858295` is still
  `in_progress` and `.kxm/role-hosts.yaml` is not committed on main. Do not
  schedule work from the archived plan.
- Product name is **KXM**. Do not present Mesh or pi-extensions as the product.
- **Antigravity routes through the pi-antigravity Pi-provider pattern *(the current
  Google route; the `agy`-CLI admission quoted below is its own superseded history —
  read the 2026-09-15 entry as the decision and any older "AGY is the sole Google
  harness" line as the state before it)*
  (2026-09-15, supersedes the 2026-09-11 review rejection):** Google
  integration is the `antigravity` Pi provider (Google OAuth, direct Cloud
  Code Assist API, dynamic catalog) via the pi-antigravity plugin — now being
  vendored into plugins/kxm — never a shell-out to the agy CLI. The agy CLI
  stays a harness catalog/helper entry, not the admission path; where an older entry below
  still says "AGY is the sole Google harness" or calls a native Google CLI an admitted
  writer, that entry predates this decision and is historical. Pi's bundled
  google/* key stays braked. Code admission (harness-run allowlist +
  native-vendor carve-out + roster-policy segment rules) accepted at
  d998b7c7 (task_antigravity-pi-provider); the roster.json route and writer
  promotion wait on the operator's `/login antigravity` and a live witness.
  The same subscription-provider pattern is the template for Claude
  (pi-claude-bridge, Agent SDK) and, pending a ToS determination, Codex.
  Vendored into plugins/kxm at 0a1a1563
  (task_vendor-antigravity-v2): providers-only subset with login continuity,
  fail-loud double-registration warning, Google OAuth redaction patterns,
  and fixture coverage without exclusions; operator removes the standalone
  pi-antigravity extension after merge.
  claude-bridge vendored into plugins/kxm
  at 1e3031ab (task_vendor-claude-bridge): Claude subscription via the Agent
  SDK with login-credential reuse, truthful double-registration warnings,
  sanitized fixtures; roster admission stays experiment-only because a
  claude-bridge writer would collide with the fable-claude arch critic
  under vendor independence. Operator removes the standalone
  pi-claude-bridge extension after merge.

  Plugin, marketplace, and npm identity are `kxm` / `@kontextmind/kxm`.
- **Future slices are not backwards-compatible.** Do not add upgrade shims or
  dual names. **Fix leftovers with brakes:** fail closed on old product names
  and commands (`kxm mesh`, `/mesh-status`, Mesh in operator copy) instead of
  keeping an alias lane. Prefer agents and workflows. Landed shims (e.g.
  session-isolation default `off`) get a named rip that fails closed, not a
  permanent compatibility mode.
- Durable hub SQLite default is `.kxm/state/kxm.db` (`KXM_DATA_PATH`).
- Hub process CLI: `kxm hub start` / `kxm hub view` / `kxm hub stop`.
- Live operator screens: `kxm dash` (not TUI/watch). Tabs: Agents, Tasks,
  Workflows, Plans, Inbox, Procs. Wide terminals use list+detail panes.
- Agent/model config is Git YAML. Omit `harness` (and `defaultHarness`) for
  **Pi**. Other harness ids (`claude`, `kimi`, `codex`, `deepseek`,
  `grok`, `agy`, and later others) are declared on the agent. No second enable/disable
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
  native harness. **Superseded 2026-09-04 / tightened 2026-09-05:** xAI is no
  longer such a provider — the `grok` CLI is installed and OAuth'd to
  `auth.x.ai` (`grok models` reports logged in), so the writer role dispatches
  through it. If `grok` is missing or logged out, fail closed; Pi's `xai`
  provider is not a writer fallback. This changes the writer's harness only;
  `kxm agent worker` / `pi --mode rpc` remains Pi-only, because `grok` is a
  one-shot headless writer, not a supervised long-lived worker. The repo
  `scripts/harness-run.mjs` helper is a bounded dev dispatcher (auth preflight,
  verified pairs, private sidecars), not a Phase 11 product adapter.
  **agy (Antigravity CLI, 2026-09-08) — historical, superseded by the 2026-09-15
  pi-antigravity decision above:** admitted native Google subscription
  writer/experiment edit route for Gemini kebab ids only. One-shot headless
  CLI, not a worker. Starting rotation unchanged (Grok remains first).
  The deprecated Gemini CLI is removed; AGY is the sole Google harness. *(Superseded:
  the current decision routes Google through the `antigravity` Pi provider, keeps `agy` as
  a catalog helper, and retains the deprecated `gemini` catalog entry — the sentence above
  is kept because the decision history in this file is the audit trail.)*
- **Developer assignment runner (issue 127, unreleased):** normal entry is
  `just assign` with a closed `kxm.assignment.v1` manifest and
  `task_dir/plan-current.json`. Fixed `just witness` verifies the exact
  candidate; `just accept` binds an actual commit plus independent Fable
  architecture and Sol CLI PASS records. `just attribute` and
  `just observe-cost` keep private history without editing completions.
  `just change-report` separates provider-reported, list estimates,
  unmetered, unknown, partial, all attempts, and explicit exclusions.
  Root bootstrap cost stays unknown and is imported as cost-only. Public
  PR/CI ids are observations, not success proof. `just
  impl|plan|review-arch|review-cli` are low-level harness transport; they
  do not mint assignment, witness, or acceptance proof. Evidence-informed
  effort defaults: medium for implementation, planning, and architecture
  review; low for CLI review. Not a ranking or a product catalog. The
  runner is not the Phase 4 assignment layer and not a Phase 11 adapter.
  Phase 3 `default.yaml`/`fix.yaml` remain model-free. Phase 9 may use the
  cost report to propose changes; it is not learned policy. Phase 7 quorum
  and npm/wiki deferrals are unchanged. PR #129 merged as `50c8482` with
  all five required CI jobs green, closing #127. D3 follows in bounded slices.
- **Role rotation (operator, 2026-09-06):** choose agents per role from
  authenticated, supported helper routes using verified quality, total
  time/cost, and rework. Root may change agents without asking again.
  Starting rotation: writer `grok`/`grok-4.6`, planner and architecture
  critic `claude`/`fable`, CLI critic `codex`/`gpt-5.6-sol`. Grok remains
  the currently admitted native writer route; Codex session work is an
  authorized bootstrap route with unknown root usage/cost, never a forged
  native completion. Do not declare Codex and Grok interchangeable in
  harness-run role mapping. Operator update (2026-09-07): after failed or
  exhausted attempts, immediately try the next suggested eligible authenticated
  model. OpenRouter Qwen `qwen/qwen3-coder-plus` is narrowly admitted as a Pi
  writer with exact model auth and edit permission; it has no supported native
  route here. Nous Research Portal is a second Pi helper provider
  (`nous-portal/*` after `@jayteelabs/pi-nous-portal-provider` and
  `pi auth check --provider nous-portal`); `nous-portal/tencent/hy4-preview`
  is the reviewed experiment example, not a second writer. Other model
  writer routes require reviewed admission. Native
  subscriptions remain preferred for the same model. Preserve every attempt,
  cost, witness, independent review, and acceptance requirement. New-model trials are bounded comparable tasks, not daily
  fanout. This is orchestration policy; `just assign` does not
  automatically schedule failover.
- **Private handoff notes:** when needed, each role leaves concise private
  notes (missing input, friction, what worked, suggested next change,
  artifact/check refs, approaches tried) in private model summaries and
  `attribute` history. Notes never grant tools, waive verification, or
  become human/hub approval. No extra schema fields.
- **Operator bootstrap acceptance exception (2026-09-06, single repair):**
  the operator explicitly authorized acceptance of PR #130's Runtime
  initialization repair (`ad8ff33`, tree `0b33c23`) after two native Grok
  attempts produced no work and no alternative writer was admitted. Before
  ready/auto-merge, the final candidate, including this documentation change,
  requires bootstrap verification, a separate exact fixed-command witness
  bound to its tree, fresh independent Fable architecture and Sol CLI PASS
  reviews, and all five required CI jobs green on its final head. Record this
  as a separate auditable operator-acceptance artifact: the runner has no
  labeled bootstrap exception. It is not native assignment acceptance, a
  `just accept` record, or hub approval. The original `d3/accepted.json` for
  `2754af7` stays immutable and does not cover this repair; no native completion
  or native witness is fabricated. Root usage/cost remains unknown, and all
  failed/native attempts are retained. This one-repair operator decision does
  not grant automatic fallback, routing changes, model authority, or changes
  to product phase gates.
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
  headless-capability claim. `kxm harness list` auth is `yes|no|unknown`.
  `unknown` and `no` are never eligible. Eligibility is a pure function over
  the inventory, with no spawn or network. Pi has no global auth status:
  `pi auth check` requires `--provider` or `--model`, so the inventory without
  a named provider/model reports Pi as `unknown` with issue
  `auth_context_required`, pure eligibility excludes Pi, and the Phase 4
  assignment probe supplies the exact requested provider/model before any Pi
  readiness claim. `kxm update` delegates to each harness's own updater.
  Governed `kxm skills` are not auto-updated.
- Daily operator loop is a slim `default` path (plan → implement → verify →
  ready), not the 13-stage `/fix`. Dual-critic `/fix` and three-provider review
  are Phase 7. Independent repro-before-oracle stays for `/fix`.
- CLI Fable/Codex/Kimi critiques are artifacts plus human signoff, never
  hub `peer-reply` evidence.
- Workflow fixture ids: `kxm-provenance`, `kxm-v04` (not `pi-extensions-*`).
- **Safety, process integrity, and critic sandboxing (2026-09-11):** The
  completed plan is
  [`plan-safety-security-process-integrity.md`](history/plan-safety-security-process-integrity.md)
  (`task_90e568b3fd18`, #188/#189; stub at the old path). PR #188
  closes critic read-only sandboxing holes by pinning `--mode plan --sandbox --disable-slash-commands`
  for `agy` and `--plan` for `kimi` in `READ_ONLY_ONESHOT_ARGS` and catalog entries;
  enforces literal destructive command seatbelts (`assertCommandSeatbelt`) blocking
  `rm -rf`, `git reset --hard`, `git clean -f`, and destructive checkout/restore;
  exports `killProcessTree` for negative PGID tree termination on POSIX to prune
  orphaned test and subshell daemons; implements authority validation brake
  (`role_roster_conflicts_with_agent`) between `.kxm/roles/writer.yaml` and agent
  definitions; mandates raw uncompressed byte fidelity (RTK bypass) for verification
  gates and critics; and enforces strict pinned SSH host key policy rejecting TOFU.
- **Hub local is the default; a hosted tenant box is now a selected MVP path
  (2026-09-20, replaces "SSH/HTTPS hub install are after MVP").** `kxm init` is
  project-only. `kxm hub bind <url>` binds this host to a running hub. Session brief,
  Pi status line, and `/kxm` read the local hub snapshot. **Local token-authenticated
  operation stays the default and unmodified.** The selected hosted MVP runs the hub and
  a local Runtime on a tenant's existing box behind that tenant's portal, with Authentik
  authenticating browsers at the edge. Remote workflow execution (Phase 6) and
  distributed synchronization (Phase 8) remain post-MVP: reaching a tenant box does not
  pass either gate.
- **Platform pause (operator, 2026-09-05):** Windows CI legs, hosted Windows
  probes, and release automation are paused, not deprecated. Active verification
  runs on the ARC runner scale set kontextmind-doks (DOKS, 0..4 ephemeral
  pods): two Linux Node 22.19.0 and 24 Validate legs plus Docs lint and
  Plugin validation; Classify changes is the fifth job. Local verification
  is `npm run verify` on macOS. No new paid macOS runner. Windows source and
  tests stay in tree. Windows resumption and release resumption are separate
  choices; each updates Tracking, tests, and settings together. The release latch
  was subsequently removed and v0.7.0 published (see Still open); Windows
  qualification remains paused. The September 5 release-pause text is historical.
- **Public npm prerequisite satisfied (checked 2026-09-15 UTC):** npm `latest`
  is `@kontextmind/kxm@0.7.0`; GitHub v0.7.0 is published. The prior wait for a
  first public package is historical. Current 02aaed31 code supports npm update
  checks/install, while host configuration still defaults to `github` with
  `auto: false`; publication alone does not change that choice or qualify the
  next release. Wiki remains compiled-from-hub (`kxm context wiki-compile`);
  no ingest CLI. Follow-up owners/triggers remain in Still open.
- **Routing and cost contract** lives in [`docs/contracts/routing.md`](../docs/contracts/routing.md).
  v1 is shipped parse-only; helper telemetry is a dev tool; v2, event-settle
  write, ranked report, and price catalog are planned. The 2026-09-04
  [work plan](history/2026-09-04-work-plan.md) and
  [decisions](history/2026-09-04-decisions.md) are historical
  inputs and yield to AGENTS.md and this Tracking section where they differ.
  **C1 (2026-09-05) supersession:** docs remainder for #86 is that routing
  contract, synchronization status, and these phase notes. Historical quick
  rename of `default.yaml`, Phase 3a/3b split, adapter-as-MVP, Tracking
  delete/250-line cap, and “no brakes” instructions are **not** pending tasks.
  #86 stays open for later D8/D9/D14 plan text when those phases are
  scheduled, the v1 report underquote fix, and remaining report
  implementation — not for those superseded instructions.
- **Workflow taxonomy (operator, 2026-09-07; path 2026-09-08):** [`docs/workflow-guide.md`](../docs/workflow-guide.md) is organized Area -> Workflow -> Stage -> Assigned role across seven areas (`software-engineering`, `design-experience`, `media-production`, `data-analytics`, `research-strategy`, `business-operations`, `security-reliability`) and 22 workflows with declared kebab-case documentation slugs. The taxonomy is route-agnostic for native harness subscriptions and API-key Pi providers. Slugs are documentation identity only: no runtime config, role admission, schema field, CLI behavior, or alias lane. Inherited candidate lists are dated research requiring live verification before dispatch, not certified prices or an eligibility grant. Model/harness, platform, modality, tools, and personal/work context are routing attributes, not area trees; area grouping never pools unrelated role quality into one global model ranking. Fable and Sol critics remain required for the developer runner. No phase gate changes.
- **Developer roster U1a foundation & U1b live binding (2026-09-07, 2026-09-08):** An unwired synchronous helper loader reads a committed, clean policy only from a control checkout at or behind the fixed trusted main ref. It pins commit/blob/raw SHA256, validates source-bound model origins and code-owned role/permission/vendor ceilings, and replays historical policy from Git objects. Pi provider validation follows the accepted helper’s shared provider ceiling, without adding a production Nous route. U1b completes live dispatch validation, dynamic critic resolution, and acceptance binding in `scripts/assignment-run.mjs`, enforcing lineup admission and permissions for all roles, as well as strict vendor independence between writer and critics and pairwise among critics. Stored manifest binding validation fails closed on unadmitted routes. Config validity is not live harness/model capability or auth evidence: dispatch brakes remain in force. This is developer orchestration policy for the issue 127 runner and does not pass a product Phase 4 gate.
- **Planning home and workflow guide (operator, 2026-09-08):** `.kxm/` is the KXM tool's own workspace (state, logs, workflow outputs). Project planning documents live in `plans/` at the repo root. `docs/workflow-guide.md` is the route-agnostic Area → Workflow → Stage → Role taxonomy for native harness subscriptions and API-key Pi providers.
- **Package layout convention (operator, 2026-09-17):** KXM packages follow the reviewed `doompi`
  package shape — `src/{types,tui,services,adapters,exports}` (plus `commands`, `web`, `styles`
  where a package has them) with `tests/{unit,contract,integration,helpers}` and per-package
  `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json`, `tsconfig.json`, and a build config.
  Layer rules are binding: `types/` imports nothing outside itself; `tui/` may import only
  `@earendil-works/pi-tui`; `services/` owns I/O and policy and never renders; `adapters/` is the
  only host binding; `exports/` is the public surface and anything unexported may be reshaped.
  The first package built this way is the terminal kit (`packages/core/tui`,
  `@kontextmind/tui`, also published on the product as `@kontextmind/kxm/tui`); the existing
  flat `plugins/kxm/src/*.ts` tree migrates toward it slice by slice, not in one sweep. The
  convention is a gate, not prose: `test/core/package-layers.test.ts` refuses wrong-direction
  layer imports, a missing per-package manifest/config/docs/license, and a consumer that reaches
  into a package by path. No phase gate changes. **Bun** runs tasks here (`bun run`, `bun x nx`)
  and `bun install` links the workspace; the installer and CI legs stay `npm ci` on Node
  22.19.0/24 until a separate change carries its own CI evidence, because Pi loads this
  extension under Node and `npm pack` is the release path.
- **No project-file migration either (operator, 2026-09-20).** With the schema lanes gone,
  `kxm migrate` had nothing left to convert into, so the command, `migrate.ts`, its suite, the
  three `kxm.migration-*.v1` schemas and their registry validators, and the receipt helpers are
  deleted. Legacy `.kxm/config` JSON now fails closed at load with `legacy_state_unsupported`;
  `kxm init` reports `mode: "legacy"` and writes nothing; `kxm migrate` is an unknown command
  and a test keeps it that way. `docs/contracts/migration.md` becomes a supported/refused
  matrix. The packed-install trust and run-lifecycle fixture is now authored by `kxm init`
  directly rather than produced by a migration, so that coverage was moved, not dropped.
  Restoring conversion needs a written decision first (see the doc's closing section).

### Landed in this tree (unreleased)

- **S0: plan authority reconciled, and the queue replaced the two competing
  “first product” sequences (2026-09-20; design record
  [reviews/plan-set-reprioritization-astra.md](reviews/plan-set-reprioritization-astra.md)):**
  all 19 plan summaries were read, twelve named contradictions were resolved with the
  exact edit each required, and every document got an operation — keep, merge, split,
  demote to reference, or archive with a stub. The rulings that change what anyone can
  schedule: **Tracking owns execution order**; the unified catalog is proposed scope
  only and its “first product slice” and “Next” language now point at the single queue;
  the per-tenant hosting draft keeps the boundary and the storage rationale and **loses
  its own slice sequence**.
  What got cut, including from work in flight: the hub-side browser-authentication
  subsystem, five `kxm hub auth` verbs, viewer/admin credential kinds and
  `kxm hub footprint` are deleted from the plan, because the portal and Authentik already
  own that boundary — a hub-side copy would have added a credential lifecycle to the
  critical path for no new capability. The KB’s staged hub-side JWT verification and
  token broker are **rejected, not deferred**, with the technical reasons kept (unsigned
  session tokens, static project tokens read at startup, a fixed-string client token) so
  the rejection stays auditable; only the timing-safe Studio compare survives as a
  hardening note. Coordinator inbox and replay/streaming moved post-MVP behind their
  triggers; polling is the MVP visibility model.
  Stale status was the other class of contradiction and it was not benign: **Phase 11
  listed B2 durable receipts and B3 run-duration budgets as remaining after both were
  accepted** (2026-09-16 `task_9076be56b581`, and #246); Phase 4 still listed an
  implemented Pi RPC adapter and Phase 3 said both “still refuses gates” and “fulfils the
  gate” in one section; and the Studio entry claimed mutations on the authenticated
  command API while the standalone CLI wires no handler and the server fallback answers
  `ok: true, mappedToCli: true` without executing. Each is corrected to what the code
  does, with Phase 10 rather than Phase 6 named for Studio, and the Studio claim becomes
  the reason S2/S4 may not inherit an unwired success path.
  `AGENTS.md` stopped carrying a second copy of the rotation and provider policy: its
  stale Google line named a CLI route the current decision had already superseded, which
  is what duplication does. It now states the invariants (native harness when installed
  **and** logged in; fail closed rather than silently billing another vendor;
  `kxm harness list` and Tracking are the authorities) and points for the mutable list,
  keeping the reviewed exceptions visible without granting eligibility. Deliberate
  deviation from the design record, recorded rather than hidden: the pass also proposed
  making the emitter own the whole session-brief prefix. The drift was the **copy**, so
  deleting the copy fixes it; generating operator prose from a tracker would add a
  build-time coupling and a template to maintain for no additional authority. Trigger to
  revisit: the second time a hand-maintained section contradicts Tracking.
  Gates: this is documentation and generated-instruction work, so it ships on the
  existing `npm run verify` and the existing CI legs — no new script, job or test file,
  consistent with the cross-cutting-gate replacement above.

- **S1 hosting slice: the tenant-box recipe, a state-set-wide backup, and two `hub bind`
  tightenings (2026-09-20; queue in Still open, boundary in
  [plan-per-tenant-hosting.md](plan-per-tenant-hosting.md)):** one tenant is one box — one
  hub, one Runtime, one state set, no tenant table and no hub user accounts — and the
  documented topology keeps hub and supervisor loopback-only with the tenant's proxy owning
  TLS and browser sessions. KXM ships the proxy **contract** (strip client identity,
  agent, caller and `Authorization` before injecting validated values; never inject the hub
  admin token per user; publish no hub port; keep machine credentials server-side in the
  portal) and explicitly no generated proxy config, because a generated config reads as
  authoritative while one missing directive silently re-opens header forgery.
  The backup section previously described stopping the hub and copying `kxm.db`. That is a
  **hub-only** backup, and my own rewrites of it were wrong twice before they were right:
  first "two roots", then "four", then a single `$X` that conflated the **fixed** checkout
  tree with the **relocatable** workspace directories. A tenant has **six** roots, and two of
  them are easy to mistake for one. `$R/.kxm` is fixed to the checkout and holds the project
  definition — project/config/agents/workflows/gates/roles/role-hosts/producers/roster/
  routes/prices/repo/template-provenance — plus goals, tasks, memory, candidates and skills;
  `$D` is the workspace directories root (`--workspace` or `KXM_WORKSPACE_DIR`, else
  `$R/.kxm`) yielding `config/`, `logs/`, `assets/`, `state/`; `--workspace` derives all four
  while **ignoring** the per-directory variables, and relocating `$D` is not the same as
  relocating one target — `KXM_STATE_DIR` alone leaves `$D` at its default and moves only
  `$W`; `$S` is `KXM_STATE_DIR` when set, else `$D/state`
  (and `--workspace` derives it, ignoring that variable); `$S` is host-local
  `KXM_STATE_HOME`, which must be **absolute** — a relative value is rejected outright,
  while a relative `XDG_STATE_HOME`/`LOCALAPPDATA` **base** falls back silently, so an
  env-derived path can quietly name the default location instead`$S` carries `runtime/registry.db` (whose **registry rows** hold the supervisor
  identity and claim — there is no `supervisor.json`), per-project `run-events.db` with a
  sidecar named by appending `.run-prompts.json` to the **whole** database filename,
  `projects/<hash>/repository-bindings.json`, `update.yaml`, and the hub binding/env records;
  `$C` is user configuration; and `$T` is **federated telemetry**, resolved from an explicit
  directory joined with `telemetry/`, else `XDG_CONFIG_HOME`/`HOME` — **not**
  `KXM_USER_CONFIG_DIR`, so it can sit outside `$C` — and with **no production caller
  today**, so its absence is the normal state rather than evidence of an opt-out; local
  accounting is a different file, in `$D/logs`. The trap worth naming for an operator:
  relocating the workspace does **not** relocate `$R`, so a backup of `$D` alone silently
  omits the entire project definition. The table now separates recovery-critical routing
  manifests from Pi model histories whose backup remains an existing policy **choice**,
  marks what is disposable (PID/claim files, `session-brief.json`, the re-generable
  supervisor token), applies WAL-consistent copying to every SQLite store rather than the
  hub's alone, records every override with the backup, and keeps restore verification
  concrete: read back a run, its drive receipt, and confirm prompt text survives. Routine
  unattended recovery remains **not** claimed — automated store discovery is a tracked
  post-MVP item.
  `kxm hub bind` gained the client-side mirror of the rule the hub already enforced on its own
  listener: a **remote** URL with no resolvable credential is refused
  (`hub_bind_unauthenticated`) instead of being stored and failing later like a network fault;
  the refusal carries `nextAction` and the same hint string in both the JSON payload and the
  prose line, because a machine-readable refusal that explains itself only in prose is
  debugged by reading source. `kxm hub view` and the session brief now label the binding
  `loopback` or `remote` — a trust distinction that was previously invisible — with
  `localhost`/`127.0.0.1`/`::1`/`*.localhost` loopback and `0.0.0.0`, LAN and hostnames
  remote.
  Review round one on this slice also found the guard itself too weak in three ways, now
  fixed and asserted: a persisted record holding **another** project's token counted as a
  credential and let a doomed binding be stored, so the check resolves against the active
  project and an override URL alone no longer unlocks it; a malformed `hub-env.json` threw
  `HubEnvError` past the command and printed neither payload nor prose, and is now a
  readable `hub_credential_unreadable` refusal that confirms nothing was written; and
  `hub view` labelled the *stored binding* while `KXM_SERVER_URL` sent the request somewhere
  else, so it now labels the effective URL with `source: "env"` — and the session brief's
  text and widget surfaces carry `/remote`, because a distinction that exists only in JSON
  is a distinction nobody reads. The second round then caught a **regression my own fix
  had introduced**: the guard resolved credentials *before* it checked scope, so a damaged
  host record began refusing **loopback** binds that had always worked; resolution is now
  remote-only, with its own case. The claim was then narrowed rather than repeated: that is
  a property of the **bind** guard, not of loopback — other client paths call
  `resolveClientHubAuthToken` whatever the scope, so loopback commands can still fail on a
  malformed record, and a comment implying otherwise would be the same class of overstatement
  one line away. That round also found my rewritten test had dropped the
  `localhost` and `[::1]` scope assertions while still claiming to cover them — restoring
  the literals is the difference between a test that names its cases and one that merely
  passes.

  Gate: existing `npm run verify`, no new npm script or CI job, and **one** named test
  (`hub bind refuses a remote hub with no credential and labels the binding scope`, in the
  existing CLI suite) — which also had to update the neighbouring bind test to carry a token,
  since that test was exercising probe timing against a LAN address the new rule now refuses.
  Mutation-checked: dropping the guard, hard-coding the reported scope, and mislabelling
  `localhost`/`::1` each turn the new test red; zero schema change, zero new dependency.
  Rounds three and four then attacked the documentation rather than the code, and it did not
  survive: the copy step said "both roots" while the table above it defined four; the
  rewrite had dropped `roster.yaml`, `routes.yaml` and `prices.yaml`, which are the route
  and price authorities — a tenant restored without them comes back with different
  admission and cost behaviour and reports itself healthy; and the federated telemetry row
  invented path resolution (`KXM_USER_TELEMETRY_DIR`, a fallback to local
  `logs/telemetry.jsonl`) that the exporter does not implement. Telemetry therefore got its
  **own root** (`$T`), resolved from an explicit global directory else
  `XDG_CONFIG_HOME`/`HOME` — **not** from `KXM_USER_CONFIG_DIR`, so it can sit outside
  `$C` — with its no-production-caller status stated, and `KXM_WORKSPACE_DIR` was added as
  the override that relocates the workspace directories **but not the fixed checkout tree**.
  Final count: **six** roots (`$R`, `$D`, `$W`, `$S`, `$C`, `$T`), and the wording is
  "snapshots replace the database copies, not the file copy", which is exactly what
  `VACUUM INTO` can and cannot do. The
  same round narrowed my claim that "loopback never consults a credential": true of the
  bind guard, false of `kxm peer list` and every other path that calls
  `resolveClientHubAuthToken` — a scoped claim is checkable, an unscoped one is the same
  overstatement from a different sentence.

- **The documented `just` entry points existed only in the docs (2026-09-19):**
  `just assign|witness|accept|attribute|observe-cost|change-report|plan-current`
  are named as the normal developer entry by `AGENTS.md`, the Decided entry above,
  `docs/assignment-runner.md`, `docs/contracts/routing.md`, `.claude/harness-cli.md`
  and the CHANGELOG. None of them was in `justfile`: PR #179 deleted the recipes and
  inverted the covering test into `doesNotMatch(just, /assignment-run\.mjs/)` with
  no doc sweep and no Tracking decision recorded, so for eight days the documented
  entry point was a broken command and the brake enforced the wrong shape. Restored:
  **headers and bodies verbatim** from `bce478a^`, same argument order as
  `assignment-run.mjs`'s own `CLI_USAGE` (the comments and section order are new), plus
  `just docker-install-smoke`, which `scripts/docker-install-smoke.mjs` had been
  advertising in its header since it landed. #179's own plan text shows an unfinished
  retirement discussion, so the honest description is that this **resolves
  contradictory retirement and workflow records** rather than proving no retirement
  was ever contemplated — no still-applicable decision requires these entry points to
  stay absent, and the Decided entry above names them.
  **What is gated now:**
  - *Per recipe, not per file; and the load-bearing gate parses nothing.* The #179
    file-wide brake was the wrong shape: the rule is that transport recipes must not mint
    assignment, witness or acceptance proof. Seven review rounds then produced fourteen
    demonstrated escapes from one text gate after another — `just  assign`; `just -- assign`;
    a `\` continuation; repointing `run :=`; `set allow-duplicate-variables` with a second
    binding; a duplicate header with a trailing comment; `EXTRA:`/`extra_recipe:` names a
    lowercase-hyphen parser never saw; `alias`; a continued `mod`; a verb hidden between
    `just` and its options; a path split by concatenation; `@extra:` quiet recipes; bare,
    multiple and `&&` dependency forms; `extra X=":=":` where the filter that excludes
    bindings also discards a legitimate default; a triple-quoted default that puts the name
    and the colon on different lines; and `@verify:`, a quiet redefinition whose body the
    reader could not find. Every one reached `assignment-run.mjs` under real `just` 1.58.0
    while the static gates stayed green.
    The answer is not a better parser. **Every line in the file that mentions
    `assignment-run.mjs` must be one of the seven pinned proof bodies, and there must be
    exactly seven** — a multiset over raw text that asks nothing about what a line *means*,
    so the escapes above cannot hide from it by being unreadable to a parser. Proof recipes
    may not be renamed or given new call sites without editing this assertion; verified that
    **and it does not do it alone**: moving `witness`'s body into `check-generated` leaves
    the seven-line multiset identical, so the pin passes and the non-proof-body token check
    plus the per-recipe body pins are what reject it. The layers are stated separately rather
    than sold as one airtight gate. Column-0 comments are
    documentation and excluded, because a gate that rejects the sentence explaining it gets
    worked around rather than obeyed.
    Around that pin: the file is normalized (continuations folded, comments stripped) and
    re-checked against **`just --dump`**, the interpreter's own rendering, skipped with a
    visible reason where the binary is absent; the recipe name set must equal a pinned list;
    duplicate headers and duplicate `run :=` bindings are refused; `set allow-duplicate*`,
    `import`/`mod` in any spelling and `alias` are refused; `run :=` and `dispatch` are
    asserted exactly; non-proof bodies are token-checked against **raw** text, because
    comment-stripping first is what let an escaped quote hide an executable suffix that
    `--dump` reproduced verbatim.
    **The stated limit, which is the point of stopping here:** this is drift protection, not
    a sandbox. A body can build a command at runtime from variables, a decoder or `sh -c`, and
    anyone who can edit this file can already do anything it can do. What the pin guarantees is precise: the
    multiset of non-comment lines containing the literal runner filename (after trimming
    whitespace and one leading `@`) is exactly the seven proof bodies. A call assembled at
    runtime, or a filename built from pieces, is outside any text gate including this one.
    Further parser hardening was declined after round 7 rather than accepted as finished.

  - *Docs-to-justfile parity.* `just <verb>` in **command form** — inline code, or a
    fenced line with an optional `#` — must exist as a recipe. The scan is token-level:
    leading interpreter options and their path-like values are skipped
    (`just --quiet witness …` and `just --dotenv-path /abs/.env witness …` both name
    `witness`), alternations are read per token so `just impl|plan brief.md` keeps
    `plan`, a glob alternative (`review-*`) is skipped rather than demanding a recipe
    called `review-`, and a pipeline further along the line is not an alternation. Prose,
    headings and captured `just --list` output are not parsed: a document that names a
    recipe only in prose is not gated, and a backticked adverbial phrase — "just in
    case" inside code spans — would ask for a recipe called `in`. Both edges are
    deliberate and both are fixture-tested, as are the accepted shapes above.
  - *No auto-loaded `.env`.* `set dotenv-load` is **removed**, after review found it let
    a gitignored `.env` in whatever directory `just` ran in set `NODE_OPTIONS`, whose
    value the interpreter executes *before any script body* — ahead of the runner's
    identity, tree, roster and critic validation, and ahead of the `shell: false` on the
    spawns that follow (auth probes synchronously, harness execution asynchronously).
    Gated twice. The textual brake rejects **any** `set dotenv*` spelling — bare,
    `:= true`, with a trailing comment, and the filename/required/override variants —
    while still allowing a comment that merely mentions the removed setting. The
    real-`just` probe no longer reads an environment string: the preload module **writes
    a marker file itself**, so the assertion is that injected code ran, and every
    negative is paired with a control on the same entry point — explicit
    `--dotenv-path` applies and executes; a justfile with the setting re-added executes;
    and the real `witness` recipe is run **both ways**, refusing a missing record
    directory without a marker and *with* a marker once dotenv is re-enabled. That last
    control is what the first version of this probe lacked: only the probe script wrote
    the marker, so the witness arm could not have detected a preload at all.
    Opt-in is `just --dotenv-path /abs/.env assign …`; `--dotenv` is not a separate flag
    in the installed 1.58, and the earlier note here published a command that exits 2. An
    explicit opt-in **executes what it points at** — including `--dotenv-path
    /dev/stdin`, which a reviewer used to run a preload through the real `witness` recipe.
    That is the point of "explicit": the gate is about a file nobody chose.
    Explicitly **out of scope**, because it is an operator trust decision rather than a
    gate: an inherited `NODE_OPTIONS`, `PATH`, `KXM_*` or `JUST_DOTENV_COMMAND` in the
    parent environment, and whatever a reviewed helper script chooses to do.
  - The smoke recipe is pinned to the command it advertises, not merely to its name.
  **Not done here:** `observe --record-dir` is a real `assignment-run.mjs` subcommand
  with no documented recipe, so none was invented; `accept` writes JSON by default but
  has no `--json` **flag**, and its optional `--observed-pr`/`--observed-ci` still
  require the direct script call, as `docs/contracts/routing.md` already says; nothing
  pins *argument order* between the justfile and that document, only verbs, flags and
  arity; and inherited-environment hardening past dotenv (what a witness hands to a
  harness) is its own trust decision.

- **Runtime intake contract: coordinator identity, idempotent ingress and the
  pause rule (unified plan M1 + M6, the durable half of M2; 2026-09-18):** the
  first slice of the proposed M0/M1/M6 product path, at the contract layer only.
  `plugins/kxm/src/intake.ts` owns the policy; the Runtime store remains the only
  writer. New schemas `kxm.coordinator.v1` and `kxm.intake-message.v1`
  (`schemas/`, both wired into `KxmSchemaRegistry` and revalidated on read);
  event-store schema **4 → 5** adds `coordinators`, `intake_messages` and
  `project_controls` with a stepwise migration, and the backup/restore ceiling in
  `database.ts` moved with it. Rules now enforced by code and tests:
  a (project, role, channel) slot binds **create-once** and re-binding the same
  ceiling returns the same identity instead of minting a second one; a different
  ceiling requires explicit policy and may **never widen** repository access,
  effects or tools; duplicate ingress (same idempotency key, same content) cannot
  create another message or another task, while the same key with altered content
  is refused (`intake_payload_conflict`); admission is idempotent per run and a
  second run for one message fails (`intake_second_admission`); a paused project
  blocks fresh dispatch and *holds* intent that arrives during the pause instead
  of dropping it, releasing it in received order on resume; and a
  `secret`-classified payload is never persisted — only its hash, so intake cannot
  become a secret store. `test/core/intake.test.ts` (7 tests) covers each of
  those, including durability across a close/reopen of the store.
  **What this is not:** no CLI, MCP, HTTP or Studio surface exists for any of it,
  which is deliberate — an unintegrated control is unavailable, never a
  success-shaped stub, and no CHANGELOG entry is warranted until something can
  be called. No dispatch through the authorized Pi route yet (that is the M2 step
  that consumes a `ready` row), no external account, no live model call. No
  acceptance is minted: this is contract code with deterministic fixtures, not a
  witnessed product outcome.

- **Intake contract hardened after an independent Codex/astra review (#248 →
  follow-up; 2026-09-18):** [the review record](reviews/intake-contract-astra.md)
  returned **BLOCK** with five blocking findings, and every one was real. The
  claims made above for #248 were partly false as shipped in **v0.7.46** and are
  corrected here rather than quietly rewritten.
  Fixed in this change: (a) a lost insert race returned the winner as a
  `duplicate` **without comparing content hashes**, so altered content was
  accepted under a used key — both paths now share `requireSamePayload`; (b)
  ingress, admission and control-write-plus-release are each a single
  `eventStore.transaction`, closing the pause/resume/ingress interleavings that
  could strand held intent; (c) resume drained only one 500-row page — the 501st
  held message stayed `held_paused` forever, now a paged drain pinned by a
  601-message test; (d) the tool ceiling **could** widen under a valid rebind (lift
  a `deny` entry, change `preset`, drop `tools`) — preset must now be identical,
  `tools` may not appear or vanish, no denial may be lifted, and four refusals are
  pinned; (e) a create-race loser now returns the winner instead of throwing, and
  `effects`/`allow`/`deny` are stored as sorted deduplicated sets so an equivalent
  ceiling no longer masquerades as a rebind; (f) relabelling a stored row's
  classification on a duplicate is refused (`intake_classification_conflict`);
  (g) `KxmRuntimeContext` carries the **real** loaded `configRevision`, replacing
  the invented hash of project root and runtime id; (h) read-time drift checks now
  compare every duplicated column plus the `schema` column; (i) dispatch order is
  Runtime arrival order (`rowid`), so a backdated `now` cannot jump the queue;
  (j) the intake schema now couples `contentOmittedReason` to `secret`
  bidirectionally and restricts `runId` to admitted records.
  Wording corrected: withheld `secret` content is a **storage decision under a
  caller-supplied classifier**, not secret detection, so "intake cannot become a
  secret store" is replaced by what the code actually guarantees; "in received
  order" became "in arrival order", and "may never widen tools" is now true.
  Test count 7 → 11; the payload-only-tampering limit is asserted as a known gap
  instead of being described away.
  **Second pass, same critic, same command:** verdict **STILL BLOCKED**, and again
  correct on every point. Closed in the same follow-up: the drain loop was capped at
  1,000 pages (now uncapped, throwing `intake_drain_stalled` inside the resume
  transaction so a stuck drain rolls back rather than half-resuming); emptying or
  omitting a populated `allow` list widened the ceiling because
  `commands.ts` applies no allowlist restriction to an empty list (now refused,
  after verifying that claim in the code rather than trusting the review); the
  create-race loser reported `created: true`; and records written by 0.7.46 hashed
  their authority as supplied, so an unsorted `effects` list would have demanded a
  policy rebind from every one of them after upgrade (fingerprints are now
  computed over the normalised authority, and the legacy row still matches).
  It also surfaced a **HIGH pre-existing defect in `database.ts`** that the new
  transactions exposed: `activeTransactions` was claimed before `BEGIN` and `BEGIN`
  sat outside the `try/finally`, so a `BEGIN` that failed on a busy database left
  the connection permanently marked as in-transaction and every later call failed
  with a misleading `runtime_transaction_nested`. Fixed (claim only after a
  successful `BEGIN`; surface `runtime_transaction_busy`) with a regression test
  that holds the write lock from a second connection and then proves the same
  connection still works.
  Claim narrowed, not defended: `rowid` gives arrival order **within a store
  instance** only. It is not a durable sequence — this repository takes backups
  with `VACUUM INTO`, and a vacuum may renumber implicit rowids — so an explicit
  immutable arrival sequence joins the schema-v6 follow-ups. Tests 11 → 13.
  Un-poisoning the transaction helper first cost more than it fixed: with the naive
  version, main's 818 s core suite became a run where one engine recovery test alone
  took 1024 s and nothing finished inside 40 minutes — SQLite's 5 s busy timeout is
  per connection and those recovery paths open several transactions in a row.
  `TRANSACTION_BUSY_BACKOFF_MS` refuses retries for 1 s after a blocked `BEGIN` and
  clears on success, so the defect stays fixed while the suite came back to
  **442 s**; the intake test asserts the blocked call, the fast refusal and the
  recovery. The old speed had come from the bug, not from design.
  **Third pass, same critic, same command: STILL BLOCKED again**, five findings,
  every one reproduced against the tree, and two of them were defects in the
  round-2 *fix* rather than in the original contract:
  (a) the backoff deadline was `Date.now() + 1000`, so a clock step backwards kept
  a long-gone write lock refusing transactions for hours and a step forward ended
  the throttle early — the deadline is now monotonic (`process.hrtime`), injectable
  for tests so the window is **stepped rather than slept through** (a test that waits
  out its own deadline proves nothing about how the deadline is measured, which is
  how round 2's busy test passed with the clear-on-success removed). The new test
  steps `Date.now` by −1 h and +1 h against the **default** clock and requires the
  refusal to stay inside the window both ways; verified to fail when the default
  clock is changed back to `Date.now()`;
  (b) *every* `BEGIN` failure was wrapped as `runtime_transaction_busy`, which
  turned `cannot start a transaction within a transaction`, a closed connection and
  any other hard error into something a caller would retry forever, and installed
  the throttle for a failure that had nothing to do with contention —
  `isTransactionContention()` now gates the wrap and everything else rethrows
  unchanged; the throttle also stopped ignoring `mode`, because a `DEFERRED` BEGIN
  takes no write lock, and a `DEFERRED` success no longer clears a throttle that
  write contention armed;
  (c) legacy ceiling equivalence was answered two different ways in the same file:
  the slot lookup recomputed the fingerprint over the stored authority, the two
  lost-write read-backs compared persisted hashes only, so the same 0.7.46 row was
  idempotent on one path and `coordinator_write_lost` on the other — one
  `ceilingsMatch()` now answers it, with a forced losing insert against a
  legacy-hash winner in the tests;
  (d) resume drains are complete and atomic but **not bounded**: one write
  transaction parses, validates, rewrites and retains every held row, measured here
  at 150k rows / 4.54 s / ~95 MiB, and ~7.6 GiB retained at 500k maximum-size
  payloads. The write lock makes it finite, so this is a throughput and memory
  limit rather than a correctness hole, and bounding it is recorded as an M2
  pre-condition (Still open item 9) instead of being quietly truncated — that is
  the exact truncation round 2 rejected;
  (e) this record again claimed more than its tests proved. Four of the round-2
  tests were load-bearing for the wrong claim: the 601-row drain passed with the
  1,000-page cap put back, the sequential `created: false` assertions never lost an
  insert, the reordered-ceiling test passed with normalisation removed from
  `kxmCeilingHash` because binding normalises its inputs first, and the busy test
  waited out its own deadline so it passed whether or not success cleared the
  backoff. Each is replaced by one that fails when its fix is reverted (verified by
  reverting each of the five and watching the matching test go red), plus named
  claims that were prose before: "one admitted task" is one admission record, no
  task exists at this layer, and "reordering or repeating" now tests repeats.
  Tests 13 → **20**. Each of the five closures was checked by reverting it and
  watching the matching test go red: page cap restored, default clock switched to
  `Date.now()`, contention classification removed, clear-on-write-success made
  unconditional, and `ceilingsMatch` reverted on each read-back separately.
  **Fourth pass: STILL BLOCKED once more, on one point — and the point was that my
  round-3 fix reintroduced round-3's defect one layer up.** The throttle kept **one
  absolute deadline per connection** and subtracted whichever clock the next call
  supplied, so a valid injected clock sitting an hour ahead throttled a
  default-clock caller for an hour, and `() => Number.NaN` reached `BEGIN` with no
  deadline at all. Throttle state is now keyed by connection **and** clock — a
  deadline can only be read, expired or replaced by the clock that armed it — and a
  non-finite reading throws `runtime_transaction_clock_invalid` instead of silently
  meaning "no throttle" — at the points where throttle state is read or armed, which
  is the honest scope, stated as counted rather than as a slogan: the clock is read at
  **two call sites** (checking a pending deadline; arming after a contended failure), with
  per-path counts. Zero reads: a clean write-mode `BEGIN` with no pending deadline, a
  `DEFERRED` success with or without one, a permanent `BEGIN` failure with nothing pending, a
  nested rejection. One read: arming, refusing, and — measured by the critic but **not yet by
  a committed assertion** — a clean success or a permanent failure that follows an expired
  deadline. Two reads in one call: an expired deadline followed by renewed contention. Rounds
  10 and 11 each had to correct a claim of mine that "the *only* transaction that never reads
  it" was some single clean case, and round 12 caught the enumeration absorbing the two
  measured-not-asserted rows; the sentence now says which rows the suite counts. That is the shape the
  injectable seam needed before it could stay. The classification question was settled properly and then found
  to be **Node-only**, which the fifth pass caught: contention is decided by SQLite's
  result code (`code & 0xff` over 5 / 6 / 15) read from Node's `errcode` **and**
  `bun:sqlite`'s `errno` (`SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT` and
  `SQLITE_LOCKED_SHAREDCACHE` land on their primaries), then from a symbolic
  `SQLITE_BUSY*` / `SQLITE_LOCKED*` / `SQLITE_PROTOCOL*` name, with anchored message
  text used **only** when neither exists — and the number wins over the text in both
  directions, so a permanent `SQLITE_FULL` quoting "database is locked" is not
  contention. `bun:sqlite` is not hypothetical here: `sqlite.ts` exists precisely
  because extensions run inside Pi's Bun, and a Node-only reading silently lost the
  extended codes on that runtime.
  `SQLITE_PROTOCOL` counts as contention **by decision** — SQLite raises it after
  exhausting WAL transaction-start retries — and `SQLITE_FULL`, `SQLITE_CANTOPEN` and
  read-only writes do not; the reviewer's own same-connection probe confirmed the
  boundary holds where a *statement* (not `BEGIN`) fails with code 6. Accepting the raw rethrow changes an error *shape*, not an
  outcome: a non-contention `BEGIN` failure reaches the supervisor as a plain `Error`
  (500 / `runtime_internal` rather than 400 with a code) and the CLI's existing
  `run_io_failed` fallback, which is the point — a permanent failure must not wear a
  retryable label. Two claims from my own round-3 text were also wrong and are
  corrected here: the forced-write coverage is one lost **insert** and one lost
  **rebind** (not "the current-format winner and the legacy-hash winner"), and
  `replaceCoordinatorInSlot` installs the winner through the real method first so the
  end state is the raced one rather than a fabricated boolean. Tests 20 → **23**, seven of them
  transaction- and throttle-focused (busy contention, monotonic bound, clock domains, mode scoping,
  non-contention errors, result-code classification, failed `COMMIT`), each mutation-checked: ignoring clock identity, dropping
  the finite-clock guard, dropping code-based classification, dropping `errno` while a
  symbolic name is still read, putting the symbolic name **ahead** of the number, and
  letting message text override a code, and a permanent name vetoing a contention
  number, each turn exactly one test red. Precedence is pinned in **both** directions by
  disagreeing fixtures — `errno: 5` with `code: "SQLITE_FULL"` must be contention,
  `errno: 13` with `code: "SQLITE_BUSY"` must not be, and `errcode: 13` with `errno: 5`
  settles which number wins — because examples that merely agree prove nothing about
  order. What is **not**
  gated: throttle-state retention. The inner map is weak in the clock, so it keeps no
  otherwise-unreachable clock alive and a fresh closure per attempt leaves nothing behind
  once collected — a *retained* clock still holds its entry, collection is neither
  immediate nor size-bounded, and nothing measures garbage collection here. What is
  asserted instead is the behaviour that matters: distinct closures with identical
  readings reach `BEGIN` independently and refuse independently.
  What the fourth and fifth passes probed, which the sixth pass then **committed**
  rather than left as reviewer evidence: a divergent row — index column flipped to
  `held_paused` while its record says `ready` — raises `intake_record_divergent` during
  resume with the project still paused afterwards, and both forced-write fixtures now
  obtain their `false` from the real guarded SQL rather than from an authored return.

- **Run-duration budgets are testable without racing the machine (2026-09-17):
  the still-open note filed in #245 is fixed. `test/core/engine.test.ts`'s
  "completes inside budget" case asserts the *minimum* of project 40 and workflow
  5000, i.e. a **40 ms** budget, so its simulated producer had to settle inside a
  40 ms wall-clock window; on a loaded `npm test` it settled `cancelled` and went
  red for no product reason (observed 2026-09-17; passes in isolation in 4.0 s).
  The correction is the seam the B3 design implied: budgets still measure from the
  log-derived `runningSince`, and only the other side of that subtraction — "what
  time is it now" — became injectable through `openKxmRuntimeContext({ budgetClock })`. It is honoured **only** with `KXM_DETERMINISTIC_TEST_CLOCK=1`, is never
  consulted for event timestamps, and the supervisor passes no clock, so no
  production path can postpone a cancellation by feeding the engine a stale time.
  Three assertions now pin the behaviour with no sleeps racing each other:
  (1) the completes-inside case deliberately stalls 250 ms past its 40 ms budget
  and still settles `completed` with `overrun: false` — the original flake's exact
  failure mode, now reproducible on demand and red against the pre-fix engine;
  (2) a log-anchored counter clock advancing 25 ms per read trips the boundary on
  the second read: `cancelled`, `terminalReason: budget_run_duration`, a
  `run.cancel_requested` payload carrying `budget { budgetMs: 40, source: "both",
  elapsedMs >= 40 }`, and a receipt with `overrun: true`;
  (3) a brake case: with the seam unarmed, an injected frozen clock cannot save a
  run from a real 25 ms budget. Witness: `npm run verify` green — 1217 tests,
  1211 pass, 0 fail, 6 skipped — with `plugins/kxm/dist` rebuilt so
  `check:generated` is current. No budget bound, default or production behaviour
  changed; the plan's own instruction held — determinism, not a bigger number.

- **Release version surfaces include workspace packages (2026-09-17):** landing
  `packages/core/tui` in #242 made the release pipeline fail on every merged PR.
  `scripts/check-versions.mjs` (the gate) already scanned `packages/**` and so
  demanded a surface that `scripts/kxm-bump-version.mjs` (the writer) never
  touched: the Release job bumped the tag version into the root/plugin surfaces,
  then its own `validate:ci` step tripped over
  `packages/core/tui must share the repository version — '0.7.1' !== '0.7.41'`.
  Both scripts now take their package list from one module,
  `scripts/package-surfaces.mjs`, so a checker and a writer cannot disagree about
  what a package is. The lockfile is patched **by key** (root, `packages[""]`,
  each workspace entry) instead of by searching for the old version string: a
  third-party dependency that happens to carry the same version as the product
  used to be rewritten into a phantom artifact, poisoning `npm ci`.
  A workspace package with no lock entry now fails loudly instead of releasing
  half-bumped. Evidence: `test/core/version-surfaces.test.ts` (5 tests — 3 of them
  fail on the pre-fix bumper, verified by running the new file against main's
  script); a bump of a full copy of this tree to 0.7.43 reports "all package
  surfaces use version 0.7.43 (9 checked)", passes the exact `package-layers`
  assertion CI failed on, changes only the root and workspace lock `version`
  fields with an unchanged key set, and `npm ci --dry-run` still resolves.
  `npm run verify` green. Releases v0.7.41/v0.7.42 are not re-cut here — no tag
  or registry operation was performed.

- **A refused `kxm hub start` no longer mints credentials (2026-09-17):**
  `resolveCredentials()` ran at module load, so on a machine whose
  `hub-env.json` held no `authToken` the wrapper generated and persisted a fresh
  admin token and *only then* refused with "KXM hub is already managed by PID
  <n>" — leaving a token no running hub trusts. Observed against the operator's
  hub, up since 2026-09-10; `hub view` and `peer list` kept working, so no live
  breakage resulted, but the ordering was wrong. The wrapper now reads the claim
  first (`liveHubClaimPid()`, read-only) and refuses before any credential is
  generated or persisted. The atomic `claimPidFile()` loop keeps sole authority
  over malformed, stale and dead claims — this is a pre-flight, not a second
  liveness policy. `test/core/hub-env.test.ts` pins it: a well-formed claim on a
  live pid must exit nonzero, print "already managed by PID", leave the claim
  file alone, write no `hub-env.json`, and never log "newly generated
  KXM_AUTH_TOKEN". That test fails against the pre-fix script, verified by
  running it with the fix reverted.

- **Stash reconciliation: the read-only GET projection survives the naming
  sweep (2026-09-17):** the restructure above sat in an index partially
  populated by a `git stash pop` of pre-rename WIP, and five paths conflicted:
  `package.json`, `plugins/kxm/src/runtime-service.ts`,
  `plugins/kxm/src/runtime-supervisor.ts`, and their generated `dist`. Each was
  resolved toward KXM naming while keeping main's newer behaviour. The
  read-only projection becomes `projectKxmRunReadOnly` in `runtime-service.ts`,
  and `GET /v1/runs/:id` in the supervisor calls it instead of
  `rebuildKxmRunProjection`, so the B4-class write-on-GET pattern stays closed in
  the renamed tree; `rebuildKxmRunProjection` remains the explicit rebuild used
  off the GET path. `package.json` keeps both the lean `validate:pr` gate and the
  workspace scripts (`test:packages`, `check:packages`, `build:packages`, which
  `build` now invokes through nx). The last rename straggler —
  `test/core/runtime-supervisor.test.ts`, whose read-only-GET test still called
  the pre-rename supervisor helpers — now uses the KXM names. Witness: `npm run
  verify` green on the merged tree (1209 tests, 1203 pass, 0 fail, 6 skipped),
  plus `npm run check` (tsc, docs lint, version parity) and `check:generated`;
  `dist` was regenerated by `npm run build`, never hand-merged. This closes the
  B4 follow-up noted under Phase 11. CI then caught a real lockout: the stash's
  `package-lock.json` carried a `packages/core/tui` workspace entry demanding
  `@types/node@26.4.1` with no matching resolution, so every `npm ci` leg failed
  with EUSAGE before a single test ran. Aligned that devDependency to the root
  `26.5.1` (hoists, no nested typings copy) and regenerated the lock; `npm ci
  --dry-run` is now in sync. CI also caught a hard dependency the local Mac
  could not see: `packages/core/tui/project.json` ran its targets through
  `bun run`, and the DOKS runners have no Bun — both Validate legs died in
  `build:packages` with `/bin/sh: 1: bun: not found` before a single test
  executed. The four targets now call `npm run` (Bun stays an optional local
  entry point, documented in `bunfig.toml`), which keeps the decided rule
  intact: CI installs with `npm ci` and builds on Node alone. `npm run
  test:packages` passes offline-equivalent (31 tui tests, typecheck+build gate),
  and `packages/core/tui/dist/index.js` rebuilds byte-identical after `rm -rf`.
  No assignment, witness record, or
  acceptance is minted here: this is a merge resolution in the working tree.
  Live smoke on the renamed tree against the operator's already-running hub (the
  pre-rename `.kxm/state/kxm.db` + `registry.db`, hub up since 2026-09-10):
  `kxm --version` → 0.7.1, `kxm hub view --json` → `ok:true` health and
  `ready.storage: "sqlite"`, `kxm peer list --json` → an online agent. No stored
  record was reinterpreted and no migration was needed.

- **Naming sweep: no `kxm-` package prefix, no `vnext` anywhere (2026-09-17):** Dropped the
  `kxm-` prefix from package names and folders (`@kontextmind/kxm-tui` → `@kontextmind/tui`,
  `packages/core/tui` → `packages/core/tui`, private plugin `kxm-claude-plugin` →
  `claude-plugin`) and removed `vnext` from file names, folder names, symbols, constants, and
  serialized values. Files lost the prefix (`project-config.ts` → `project-config.ts`,
  `runtime-service.ts` → `runtime-service.ts`, `runtime-supervisor.ts` →
  `runtime-supervisor.ts`, `vnext-engine-*.ts` → `engine-*.ts`, `cli/vnext.ts` →
  `cli/project.ts`, `schemas/` flattened into `schemas/`, `examples/vnext` →
  `examples/project`, `test/fixtures/vnext-*` and `test/core/vnext-*` likewise); `docs/contracts/` is
  now `docs/contracts/`. Symbols followed: `Vnext*` → `Kxm*`, `VNEXT_*` → `KXM_*`, `vnextFoo` →
  `kxmFoo`, schema `$id` lost its `/vnext` segment, the session-work snapshot discriminant is
  `"legacy" | "runtime" | "both"`, and the `vnext_*` error codes are now
  `initialization_failed`, `initialization_io_failed`, and `wait_failed`. Values that were already
  schema identities or hashes are unchanged (`kxm.run-plan.v1`, receipt and provenance paths), so
  no stored record is reinterpreted. Dated records keep their original wording:
  `plans/history/`, `plans/reviews/`, `plans/research-*`, and `plans/evidence/` are not rewritten,
  and neither is `.kxm/logs/` evidence. `npm run check` (tsc, docs lint, version parity across 9
  surfaces) and `test/core/package-layers.test.ts` pass; the full suite is 1189/1199 with four
  failures that are environmental or load-dependent, not this change: the docs brake scans the
  stale nested checkout `.claude/worktrees/a2a-host-communication-7efe50` (22 other stale
  worktrees were pruned), the packed-consumer smoke needs `npm_execpath` (passes under
  `npm test`), and two `concurrent first-open` database races pass in isolation. No phase gate
  changed and no behaviour was added; this is naming, packaging, and documentation.

- **Reusable terminal component kit and workspace (2026-09-17):** Added the
  `packages/core/tui` workspace package in the layer shape above
  (`@kontextmind/tui`, also exposed as `@kontextmind/kxm/tui`, Pi's renderer
  kept external so the repository does not ship two copies of the same TUI) and
  wired the root as an Nx workspace (`nx.json`, root `workspaces`,
  `bunfig.toml`, per-package `project.json`, `scripts/build-package.mjs`), so a
  package builds, tests, and caches on its own while `npm run verify` stays the
  single commit gate. It carries a
  declarative surface contract (`kxm.tui-contract.v1`: sections, fields,
  selectable choices with `ready|available|blocked` status, owner actions, steps,
  progress, output tail, `updatedAt`), bounded validation that refuses an
  oversized or malformed published surface instead of drawing part of it, a pure
  input decoder, a pure panel reducer that emits effects and never writes, a
  contribution registry that routes every write to the owning module and
  re-reads it, a pure string renderer, a Pi `Component` adapter, a standalone
  terminal adapter, and a `ctx.ui.custom` adapter. There is no local echo: a
  rejected value returns as the old value plus the owner's reason, and a blocked
  choice (for example a model whose provider is not logged in) is never sent.
  `kxm dash` now takes its palette from the kit instead of owning a private one,
  so a colour cannot mean two things across surfaces. Documented in
  [`docs/tui-components.md`](../docs/tui-components.md); verified in
  `packages/core/tui/tests/unit/{surface,panel,services,components}.test.ts`
  with `tests/helpers/tui-surface.ts`, the layout gate in
  `test/core/package-layers.test.ts` (mutation-checked), version parity for the
  new package and its lock entry in `scripts/check-versions.mjs`, and the new
  export seam in `test/core/import-boundary.test.ts`. Documented in
  [`docs/packages.md`](../docs/packages.md). This is a component library, not a
  configuration editor: no `kxm` verb writes roster, routes, gates, roles, or
  workflow YAML through it yet, writer admission is unchanged, and the
  `kxm.config.v1` surface plus its editor command are the next slice.

- **Hub background auto-start and package.json project naming (2026-09-15):**
  Added `plugins/kxm/src/hub-autostart.ts`: on Pi extension load, `hub.autoStart`
  in `kxm.config.v1` (default `background`; `off` disables; unknown values fail
  closed to the default) reuses a healthy bound hub, a live local `hub.pid`
  claim, or a hub already answering on the configured `KXM_SERVER_URL`, and
  only then spawns the detached `kxm-hub.mjs` wrapper with
  output appended to `.kxm/logs/hub-autostart.log`. Credentials resolve before
  launch through the existing `hub-env.ts` flow, so a first start generates the
  admin token and persists it `0600` under the user state root; a losing
  double-start race reports `claim-alive` instead of an error. The extension
  client now authenticates with the environment token, the auto-start token,
  then the persisted credential. Added `plugins/kxm/src/project-name.ts`:
  default project identity is `KXM_PROJECT`, then the workspace `package.json`
  `name`, then the directory name (no upward walk), applied uniformly in the Pi
  extension, CLI client, `kxm dash`, and the MCP server. Verified in
  `test/core/hub-autostart.test.ts` and `test/core/project-name.test.ts`
  (13 new tests); docs updated in `docs/configuration.md`,
  `docs/kxm-handbook.md`, and `docs/getting-started.md`.
- **Modular Role Configuration and Workflow CRUD Management (2026-09-08):**
  - Designed and implemented `kxm.role.v1` schema (`schemas/role.schema.json`) supporting modular per-role YAML files with descriptions, skills, tools permissions (allow/deny lists and presets), produced/consumed asset template contracts, harness/model rosters with fallback priority, and policy rules (`vendorIndependenceRequired`).
  - Added `plugins/kxm/src/role.ts` and `plugins/kxm/src/workflow-manager.ts` implementing global (`~/.config/kxm/roles/`, `~/.config/kxm/workflows/`) and local (`.kxm/roles/`, `.kxm/workflows/`) inheritance with local repo overrides and default role seeding (`writer`, `planner`, `critic-arch`, `critic-cli`, `verifier`) and workflow templates (`implement-and-verify`, `dual-critic-review`, `spec-and-plan`).
  - Added CLI commands `kxm role list`, `kxm role get <roleId>`, `kxm role add [roleId]`, `kxm role remove [roleId]`, `kxm role modify [roleId]`, `kxm workflow definitions`, `kxm workflow add [workflowId]`, `kxm workflow remove [workflowId]`, `kxm workflow modify [workflowId]`.
  - Added interactive and flag-driven pick lists (`--pick`) for adding, removing, and modifying global and local configurations.
  - Verified with 100% line coverage in `test/core/role-and-workflow-manager.test.ts` and updated CLI help assertions in `test/core/cli.test.ts`. All 1,049 tests pass; coverage floors met (Lines 92.07%, Branches 80.28%, Functions 93.12%).
- **Public npm publishing unlatched & configured (2026-09-08):** Configured the `npm-publish` deployment environment in GitHub with `NPM_TOKEN` secret. Added `scripts/kxm-publish-npm.mjs` to enforce fail-closed verification (requires GitHub release with `draft: false`, validates asset presence and SHA-256 digest, and runs `npm publish --access public`). Unlatched `publish-npm` job in `.github/workflows/release.yml`, added `test/core/kxm-publish-npm.test.ts`, updated `test/core/ci-contract.test.ts`, and set `publishConfig.access: "public"` in `package.json`.
- **0.6.0 release cut and release automation unlatched (2026-09-08):** Version bumped to `0.6.0` across all seven package surfaces (root package, package lock, plugin package, Claude manifest, marketplace entry, MCP server, and dist bundle). Removed the `if: false` job latch on the draft release job in `.github/workflows/release.yml` and updated `test/core/ci-contract.test.ts`; `publish-npm` stays `if: false` until a published release and `npm-publish` environment exist. CHANGELOG promoted.
- **Workflow progress TUI and Web Studio dashboard (2026-09-10):** Added active
  workflow progress loading from legacy SQLite records, JSON-safe status
  extraction, stage stepper/token telemetry rendering, `/kxm progress` and
  `/workflow` extension surfaces, and dashboard refresh integration. Web
  Studio now exposes the active workflow layout/state dashboard while keeping
  mutations on the authenticated command API. Verified by
  `test/core/workflow-tui.test.ts`, `test/core/tui.test.ts`,
  `test/core/studio-layout.test.ts`, and CLI experience tests (72 targeted
  tests passed). This closes the recent progress-visibility slice; it does not
  claim the Phase 4 live Pi adapter gate.
  **Corrected 2026-09-20 against what the code does:** layout generation and an
  embedded Studio shell exist, but the standalone CLI supplies neither a state handler
  nor an `onMutation` callback, so the server's fallback answers `ok: true,
  mappedToCli: true` having executed nothing (`studio-layout.ts:410`,
  `cli/tasks.ts:302`). The mutation-parity claim above therefore holds for the hub
  command API, **not** for standalone Studio, and the Phase 6 attribution in the entry
  below is wrong — Studio is Phase 10. Hosted admin uses the portal integration
  (Tracking queue S2/S4), and no unavailable action may report success. Fixing
  standalone Studio is post-MVP unless we actually select it for use.
- **Control plane, 5-layer memory, and external idempotency (2026-09-08):**
  - **Memory Arbiter & `_shared` scope:** Updated `plugins/kxm/src/context.ts` to allow `_shared` defaults alongside project identifiers without tripping `context_isolation_violation`; updated `plugins/kxm/src/arbiter.ts` to rank project-specific knowledge ahead of shared defaults; added `memoryRecordToContextItem()` and connected `.kxm/memory/` into `plugins/kxm/src/hub.ts:projectContextPool()`. Verified in `test/core/arbiter.test.ts`.
  - **Formal Context Packet & Structured Handoffs:** Added schemas `schemas/context-packet.schema.json` (`kxm.context-packet.v2`) and `schemas/handoff-manifest.schema.json` (`kxm.handoff-manifest.v1`). Added builder and clean markdown prompt formatting in `plugins/kxm/src/context-packet.ts`. Integrated formal packets and antecedent handoffs directly into `plugins/kxm/src/engine.ts:birthMember`. Verified in `test/core/context-packet.test.ts`.
  - **External Side-Effect Idempotency & Branch Determinism:** Implemented `plugins/kxm/src/external-effects.ts` with deterministic branch generation (`kxm/run-<id>`), preflight Check-And-Set (CAS) leasing (`claimEffect`), commit/abort lifecycle, and SQLite `external_effects` receipts store via Node 22 native `DatabaseSync` (`node:sqlite`). Verified in `test/core/external-effects.test.ts`.
  - **Interactive TUI Access Control (`kxm dash`):** Extended `plugins/kxm/src/tui.ts` with interactive Blessed/Blessings control actions (`a` approve, `r` reject, `d` degrade, `s` signal, `c` cancel) dispatching authenticated callbacks to hub endpoints `/v1/runs/:id/signal` and `/cancel`. Verified in `test/core/tui.test.ts`.
  - **Web Studio Layout Engine & Embedded Server (Decision D14 & Q8; Phase 10, not Phase 6):** Created `plugins/kxm/src/studio-layout.ts` providing form/stepper stage derivation, ELK/React Flow DAG node/edge positioning, and Temporal activity Gantt swimlanes without manual YAML coordinates; exposed via `kxm studio layout <workflowPath>` and embedded HTTP server `kxm studio serve` on `http://localhost:4242`. **The "strict audit parity / 1:1 CLI command mapping on `/api/mutate`" claim in this entry was never true of the standalone server:** the CLI supplies no `onMutation` handler and the fallback answers `ok: true, mappedToCli: true` without executing (`studio-layout.ts:423`, `cli/tasks.ts:302`). Layout generation and an embedded shell exist; live state and command execution do not. Corrected in place on 2026-09-20 rather than left for an adjacent rebuttal to contradict. Verified in `test/core/studio-layout.test.ts`, which covers layout and rendering, not execution parity.
  - **Developer Workflow Tooling & Alignment Config:** Created `plugins/kxm/src/config.ts` (`kxm.config.v1` loader/writer), `plugins/kxm/src/autocomplete.ts` (bash/zsh/fish shell completion scripts), `plugins/kxm/src/suggest.ts` (keyword & skill workflow matching mapped to `docs/workflow-guide.md` and authenticated harnesses), and `plugins/kxm/src/task-manager.ts` (`kxm goal` / `kxm task` with GitHub and Jira tracker synchronization). Settled all 15 architectural questions with operator in [`plans/history/control-plane-memory-questionnaire.md`](history/control-plane-memory-questionnaire.md), including configurable promotion policies (`manual_pr` default), shadow execution sampling (`routing.shadowExecution`), soft demotion penalty weighting (`routing.circuitBreaker`), 14-day telemetry exponential decay (`improvement.telemetryHalfLifeDays`), and anonymized federated metrics (`telemetry.federated`). Verified in `test/core/cli-experience.test.ts`.
  - **Self-Improving & Recommendation Telemetry:** Clustered 152 historical attempts from `.kxm/logs/telemetry.jsonl` ($26.58 spend, 24.11M tokens), validating native Grok 4.6 low-thinking ($0.17/attempt, 84% pass rate) vs medium-thinking ($0.60/attempt, 86.7% pass rate) with 72% cost savings and 4.5x speedup; Pi wrapper suffered 100% rework. Implemented `plugins/kxm/src/improve.ts` clustering by `(workflowId, stepId, role, intent)` for automated gate promotion and dynamic effort stepping. Verified in `test/core/improve.test.ts`.
  - **Optimized Execution Roadmap:** Re-ordered implementation into 6 dependency-stratified phases in [`plans/history/control-plane-memory-questionnaire.md`](history/control-plane-memory-questionnaire.md): Phase 1 Security & Config Foundation $\rightarrow$ Phase 2 Context Substrate & 5-Layer Memory $\rightarrow$ Phase 3 Execution Determinism & Side-Effects $\rightarrow$ Phase 4 Operator Control & CLI Tools $\rightarrow$ Phase 5 Spend Protection & Self-Improvement $\rightarrow$ Phase 6 Web Studio & DAG Visualization.
- **B3 three failing rule tests and auth probes (issue #84):** Three failing-first
  loop rule tests in `test/core/loop-rules.test.ts` (unhosted harness/model
  pair rejected with `harness_unhosted_model`; pure inventory eligibility fails
  closed on empty/unknown; `verify_must_precede_ready` enforced in workflow
  validation). Official CLI auth probe for Kimi (`kimi provider list` non-mutating
  stdout parser without `--json`); `gemini` and `deepseek` remain `unknown`
  (`null`) without secret leakage; `kxm harness list` reports status for pi,
  claude, codex, kimi. All 990 unit/simulation tests passed; coverage floors met
  (Lines 92.09%, Branches 80.87%, Functions 93.23%).
- **E6 backup, restore, migrations (issue #102):** Implemented database rules and
  lifecycle commands per Decision D11. Created `plugins/kxm/src/database.ts` providing
  a shared `openDatabase` helper enforcing WAL journal mode with retry, `busy_timeout`
  (5000ms), `synchronous = NORMAL`, `foreign_keys = ON`, `BEGIN IMMEDIATE` serialization,
  and fail-closed `user_version` inspection across all SQLite stores (`MeshStore`,
  `KxmRuntimeRegistry`, `KxmRunEventStore`). Implemented `withDatabaseTransaction`
  featuring an active-transaction nesting guard. Implemented stepwise legacy migrations
  (v1 -> v2, v2 -> v3) replacing the unconditional version stamp, ensuring a v2 fixture
  migrates to v3 or is refused without ever being silently relabelled. Implemented
  `kxm backup [--out <dir>]` and `kxm restore <manifest>` using SQLite's backup API
  (`VACUUM INTO`) with WAL checkpoint (`TRUNCATE`), PRAGMA integrity checks before and
  after backup/restore, schema version stamping, and hashed manifest generation
  (`kxm.backup-manifest.v1` schema). Verified with `test/core/e6-backup-restore-migrations.test.ts`.
- **E5b harness-agnostic memory (issue #101):** KXM owns project memory in Git
  (`.kxm/memory/`) with schema `kxm.memory.v1` and YAML frontmatter (`id`, `scope`,
  `kind`, `summary`, `provenance`, `authority`, `confidence`, `lifecycle`,
  `evidenceRefs`). Unreviewed memory candidates live under `.kxm/memory/candidates/`
  with `authority: "evidence"` and are promoted only via merged PR/commit. Commands:
  `kxm memory brief [--json]`, `kxm memory note "<fact>" [--scope <scope>] [--kind <kind>]`,
  and `kxm memory sync`. `syncHarnessMemory` regenerates marker-delimited blocks in
  `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`, and drift is fail-closed in
  `scripts/check-generated.mjs`. Claude session-start hook in
  `plugins/kxm/.claude-plugin/plugin.json` and Pi extension `/kxm memory` slash command
  call the brief; no mirrored copy exists in Claude's memory directory. Verified with
  `test/core/e5b-harness-agnostic-memory.test.ts` proving: no fact in any harness view is
  absent from the authored set; identical facts returned across CLI, Pi, and Claude hook;
  check-generated fails on harness block drift; candidates are excluded from authored set
  and memoryRevision until promoted; control plane fields are rejected; secrets in summary
  and provenance are redacted.
- **E5 memory floor fixes (issue #100):** Turned three prose memory rules into
  enforceable code per Decision D12. Rule 1: state promotion requires a configured
  admin token with no loopback bypass and records the real caller, rejecting
  self-promotion where author equals promoter (`state_promotion_invalid`). Rule 2:
  proposed items never reach a packet's skills or current state; the arbiter reads
  promoted skills from the governed store by content SHA-256 hash. Rule 3: context
  items reject control-plane fields (`permissions`, `tools`, `allow`, `deny`,
  `grants`, `approval`, `policy`, `scopes`, `credentials`, `secrets`, `token`,
  `apiKey`, `password`), secrets in summary and provenance sourceRef are redacted
  at parse, `scope` field (`agent | project | run | operator`) is validated on the
  record, and dead shallow `lineageOf` is deleted. Memory revision is computed at
  run creation (`computeKxmMemoryRevision`) from the SHA-256 hash of the
  Git-authored set (`.kxm/memory` excluding `candidates`; `.kxm/skills/promoted`)
  plus the promoted-state snapshot and written to `run.memoryRevision` and
  `event.memoryRevision` with canonical prefix `ctxrev_`. Optimized test coverage
  and execution speed: reorganized test suites into `test/core/` (essential PR unit/contract
  suites) and `test/simulations/` (heavy subprocess/signal/timeout suites); added
  `--test-concurrency=4` for parallel test coverage; established tiered gates with
  `test:core` (essential PR gate) and `test:coverage:core` (92/80/93 floors) alongside
  `test:complete` and `test:coverage:complete` (93/80/93 floors). Verified with
  `test/core/e5-memory-floor.test.ts` and updated `test/core/ci-contract.test.ts`.
- **E4c Kimi CLI and agy verification (issue #95):** Verified Kimi CLI and
  Antigravity CLI (`agy`) as one-shot adapter members. Added `HarnessDispatchStatus`
  (`status: "yes" | "no"`, `supported: boolean`, `reason?: string`) across
  `HarnessStatus` and formatted table output in `kxm harness list` (and `--json`),
  transparently reporting dispatchability and reason per harness. Implemented
  `parseKimiOneShotUsage` handling stream-json NDJSON assistant/meta chunks with
  null tokens and `costBasis: "unknown"`. Implemented `parseAgyOneShotUsage`
  handling Antigravity JSON payloads (`status`, `response`, `error`, `usage: {
  input_tokens, output_tokens, cache_read_tokens, total_tokens }`), mapping
  unmetered runs to `subscription:agy`. AGY is the sole Google harness and
  owns the Google model route.
  Exported harness definitions in `plugins/kxm/src/runtime.ts` and verified with
  mock spawn tests, fake dispatch, auth refusal, and comprehensive inventory
  dispatch reporting (`test/harness.test.ts`, `test/oneshot-producer.test.ts`).
- **E4b one-shot adapter: Claude and Codex (issue #94):** Implemented generic
  one-shot CLI producer in `plugins/kxm/src/oneshot-producer.ts` driving
  planner, reviewer, and other roles through Claude, Codex, and catalog-configured
  CLIs. Extended `HarnessCatalogEntry` with `oneShot` config and added usage parsers
  (`parseClaudeOneShotUsage`, `parseCodexOneShotUsage`, `parseGenericOneShotUsage`)
  in `plugins/kxm/src/harness.ts`. Enforces fail-closed auth preflight
  (`<harness>_not_authenticated`), prompt delivery via stdin or arguments, process
  cancellation via AbortSignal and usage parsing. The initial implementation's
  catalog-as-bill and absent-catalog-as-subscription classifications were wrong:
  billing is now `unmetered` only with observed subscription auth, otherwise
  `unknown`, with null billed cost. Provider-reported amounts and eligible list
  estimates are separate metadata; cumulative input is not context occupancy.
  Lifecycle/permission acceptance remains blocked below. Emits `.agents/skills` and marker-delimited
  `AGENTS.md` block (`scripts/emit-codex-artifacts.mjs`) so Codex discovers KXM
  commands, protected by `scripts/check-generated.mjs`. Exported in
  `plugins/kxm/src/runtime.ts` and verified with mock spawn tests, auth failure,
  and end-to-end KXM engine drive (`test/oneshot-producer.test.ts`).
- **Codex launch-flag repair (2026-09-10, Phase 11 partial slice):** Audited
  official CLI, noninteractive, approval/security, and config references against
  installed Codex 0.153.4. Product/catalog/helper launches explicitly request
  `--sandbox read-only --ignore-user-config -c 'approval_policy="never"'`,
  retain exec-policy rules, and use JSONL plus stdin `-`. Native-critic now
  shares the helper builder, including its requested model/effort. Regression
  tests cover each path. Native Sol transport completed in 18.962 seconds;
  Fable's narrow flag review completed in 35.824 seconds. Both critiques said
  PASS for flags only; Fable's additional catalog/native-critic argv coverage
  is now present. These are private bootstrap artifacts, not exact-commit
  acceptance, effective Codex model identity, or proof of MCP/plugin isolation.
- **E4 Pi dispatch (issue #93):** Implemented Pi RPC producer in
  `plugins/kxm/src/pi-producer.ts` running implementer (and other agent
  roles) through the KXM engine driver over Pi RPC protocol (`--mode rpc`).
  Maintains per-run coordinator sessions (`coordinator:${runId}`) and keys
  agent sessions by `{runId, agentId, instance, scopeEpoch}`
  (`${agentId}@${shortRun}#${instance}.${scopeEpoch}`). Enforces fail-closed
  auth preflight (`checkPiAuth` requiring `detected: true` and
  `authenticated: true`, failing closed with `pi_not_authenticated`). Binds
  harness `pi`, extracts token and context stats (`tokensIn`, `tokensOut`,
  `cacheReadTokens`, `cacheWriteTokens`, `contextTokens`, `latencyMs`), and
  calculates metered costs via `.kxm/prices.yaml` price catalog (with Grok and
  GLM catalog rows, setting `costBasis: metered` or `unknown`). Propagates
  abort signals to Pi RPC abort commands and cancellation outcomes. Exported in
  `plugins/kxm/src/runtime.ts` and verified with comprehensive mock RPC tests,
  fail-closed auth, and end-to-end KXM engine drive
  (`test/pi-producer.test.ts`).
- **D6 agent CLI surface (issue #92):** Centralized 19 agent commands in
  `plugins/kxm/src/commands.ts` as the single source of truth for parameter
  schemas, command metadata, and execution over `HubClient`; eliminated
  duplicated TypeBox definitions in `plugins/kxm/src/extension.ts` and tool tables
  in `plugins/kxm/src/mcp-server.ts`; generated `kxm peer` subcommands (`list`,
  `send`, `get`, `await`, `cancel`, `fanout`, `inbox`, `reply`) and `kxm workflow`
  subcommands (`checkpoint`, `record`, `wait`, `signal`) with `--json` outputs;
  enforced tool policy via engine-issued `KXM_ATTEMPT_TOKEN` and session-issued
  `KXM_SESSION_TOKEN`, failing closed on denied commands with
  `tool_policy_denied`; strictly capped `peer await` at 60s in both parameter
  schema and execution; bound `workflow wait` and `signal` to KXM runs and
  supervisor; added drift assertions across CLI, MCP, and Pi surfaces
  (`test/commands-drift.test.ts`), policy tests (`test/commands-policy.test.ts`),
  and rewrote `plugins/kxm/skills/kxm/SKILL.md` to teach CLI commands with zero
  `mesh_` and zero MCP-only instructions.
- **D5 routing records v2 and price catalog (issue #91):** defined
  `kxm.routing-record.v2` contract in `plugins/kxm/src/routing.ts` and updated
  schemas `schemas/common.schema.json` and
  `schemas/run-event.schema.json`; created price catalog schema
  `schemas/prices.schema.json` (`kxm.prices.v1`) and price catalog loader/calculator
  `plugins/kxm/src/prices.ts`; added dated, hashed price catalog
  `.kxm/prices.yaml` (Claude, Codex, Grok, GLM, Kimi, Qwen); engine settlement
  requires `costBasis` and records `routing.attempt.recorded` event on every member
  settlement; run plan enforces metered `limits.maxModelCost` cap before dispatch
  (`budget_model_cost`); fold handles routing records and terminal failure reasons.
- **Workflow guide loop & maintain-documentation (issue #145):** documented developer runner loop (`plan` → `implement` → fixed witness gate `npm run verify` → dual critics Fable + Sol → `accept` → PR with auto-merge) and repair back-edge (`rework_of`, fresh dual review, attempts-and-relief failover); reclassified `semantic-equivalence-verifier` as critic-with-gate (deterministic checks are the witness; model role reviews contracts and does not replace tests); added `maintain-documentation` workflow to Slug Registry and Software Engineering; noted `agy` native subscription harness for Gemini candidates; rebound `.kxm/roster.json` sha256 hash.
- **agy (Antigravity CLI) helper admission:** `scripts/harness-run.mjs`
  `ROUTES.agy` is a writer/experiment **edit** route (provider `google`,
  Gemini kebab ids only) with argv `-p` prompt transport (no `--prompt-file`,
  no stdin), JSON `status` parsing (never the exit code), unmetered
  subscription cost, and non-empty `denied_actions` as `turn_failed`. Catalog
  `id: agy` is observational (`mode: either`, `authArgs: ["models"]`,
  `update.self: ["update"]`). Auth success is a non-empty models list from
  `agy models` (method `antigravity-oauth`). Not a Pi-style RPC worker;
  starting writer rotation is unchanged. AGY is the sole Google harness;
  read-only agy roles and agy-hosted non-Google models remain deferred.
- **Docs audit slice (issue #144):** planning docs moved to `plans/` (implementation plan, v05 design record, v04/provenance history and 2026-09-04 reviews); `docs/workflow-guide.md` renamed and retitled; docs brake widened (`docs/**`, plugin READMEs, skills, AGENTS.md, CLAUDE.md, `.claude/**/*.md`; `plans/` exempt); stale copy, env-var classification, context OS coverage including `kxm context explain`, README workflow-slug index, and phase-neutral `kxm run` help. No product behavior change beyond CLI help wording.
- **Assignment runner maintainer guide:** [`docs/assignment-runner.md`](../docs/assignment-runner.md) documents the developer assignment runner lifecycle (`just assign`, `witness`, `accept`, `attribute`, `observe-cost`, `change-report`), roster lineup admission, dual-critic quorum, vendor independence invariants, failure codes, and task directory layout. Dispatch and accept load trusted roster policy from control Git; the witness verifies the bound candidate and does not itself call the policy loader today. Raw-disk and null-policy acceptance are refused. Linked in `docs/README.md`. **Unified YAML roster cutover landed (2026-09-16):** trusted developer roster policy moved `.kxm/roster.json` → `.kxm/roster.yaml` (schema `kxm.developer-roster.v1`, routes/lineup/origins content-identical); the loader parses YAML and **brakes fail-closed** on the retired `.kxm/roster.json` name; docs, skills, and policy-draft tests updated to the live format. Remaining role-configuration consolidation (role-hosts seat mapping, runner guide sweep) stays open under task_d3e634858295.
- **Lean PR gate (2026-09-16):** CI `Validate` legs run `validate:pr` (core suite, type-check, docs/versions lint, generated-dist currency — no coverage instrumentation, no simulations, no pack) on pull requests; pushes to main run full `validate:ci` (coverage + pack dry-run) and `nightly.yml` keeps the complete-suite 93/80/93 coverage floors. Job names and two-Node matrix unchanged (protect-main ruleset pins them). AGENTS.md gate table updated in the same change.

- **ARC scale-set CI selectors:** all `ci.yml` / `release.yml` / `smoke.yml`
  `runs-on` values are the scalar scale-set name `kontextmind-doks`. The
  previous `[self-hosted, Linux, X64, doks]` label tuple selected singleton
  `km-gh-rn01` and queued. Manual smoke is equality-gated on
  `KXM_SMOKE_RUNNER == 'kontextmind-doks'` and stays disabled until Pi
  credentials are provisioned into ephemeral pods and pass `pi auth check`.
  Release/npm remain `if: false` and the Windows pause is unchanged.
  Ruleset `22251971` required contexts are unchanged. This is not a
  capacity or speed promise.

  The first live ARC run exposed a fixture that relied on ambient Git identity for a conflicting merge; the fixture now sets a per-command identity and asserts the unmerged index exists before testing the refusal.

- **Pi helper Nous Portal prefix (dev helper, not Phase 11):**
  `scripts/harness-run.mjs` allowlists `openrouter/*` and `nous-portal/*`.
  Auth is `pi auth check --provider openrouter|nous-portal`. Native-provider
  Pi brake is unchanged. Writer remains exact
  `openrouter/qwen/qwen3-coder-plus` with edit and JSON readiness proof.
  `nous-portal/tencent/hy4-preview` is experiment/read-only (experiment may
  edit); it is not a second writer. Install
  `npm:@jayteelabs/pi-nous-portal-provider`; there is no Nous harness CLI.
- **D3 S1 registry foundation:** `.kxm/gates.yaml` uses the closed
  `kxm.gate-registry.v1` schema. Gate ids resolve only through that file;
  obsolete caller allowlists and old schema/outcome names fail closed.
  Command `argv[0]` must be a bare executable or absolute POSIX path;
  relative paths with separators and directory names `.` and `..` refuse.
  Gate-only `expect: pass|fail` compiles, defaulting to `pass`. Registry
  changes affect configuration and tool-policy hashes; timeout-only
  decreases narrow permission budgets. The current `v4-registry` template
  declares `npm test`; historical template bytes and provenance are retained.
  Execution and attempt-bound evidence were still open at that slice, and #89 was open —
  *(historical: the driver entry under Landed fulfils the Phase 3 gate sentence and issue #89
  is closed as of 2026-09-20)*.
- **D3 S2 pins/store/replay:** run plans pin `kxm.run-plan.v2` with the exact
  registry hash, referenced gate definitions and control-root key. Event store
  schema 3 adds immutable `gate_attempts`, `gate_observations` and
  `gate_evidence` rows bound to the full run/owner/step/assignment/attempt/effect
  identity; events are appended before the rows they reference under immediate
  foreign keys, and every production fold (status, cancel, dispatch, settlement,
  rebuild) verifies events against rows and rows against events. Closed
  complete/no-start observation facts are shared on insert and replay;
  evaluated settlement keeps the observation and fails the run when a
  transition budget is exhausted. Proven no-start settles truthfully without
  an executing event; uncertain observations freeze without evidence. The
  engine then refused gate dispatch and #89 was open *(historical; see the two lines
  above)*.
- **D3 S3 artifacts-exist dispatch and orphan-visible preflight:** drive, step,
  and scheduler admit once and evaluate `artifacts-exist` under control
  `.kxm/assets` with lexical+realpath containment. Every pinned path is
  checked; missing root is a complete failed observation. Command gates still
  refuse before intent/spawn. Recovery enumerates project `gate_attempts`
  without a row limit and unions orphan-visible issued/revoked capabilities,
  then fold/replays exact identity before excluding evaluated settled and
  proof-only no-start/cancelled terminals. Simulated producers are skipped
  only when no gate row exists; an unfinished gate requires an issued or
  revoked `kxm-gate` capability. Settlement revalidates the prepared attempt;
  a revoked capability keeps the complete observation as proof-only cancel.
  Evaluation errors after checks begin keep T1 unresolved. S4 command
  execution is implemented in this tree (unreleased). *(Historical at that slice:
  a later entry in this phase states the Gate sentence is fulfilled, and issue #89,
  "D3: engine: gate registry and evidence", is **closed** as of 2026-09-20.)*
  D4 recovery and #89 were then open *(historical; #89 is closed)*.
- **D3 S4 command execution (implemented, unreleased):** POSIX command gates
  spawn with `shell: false` and detached process groups, arm exact admission
  holds through evaluated settlement, and record immutable hashed
  stdout/stderr observations plus real pid/exit/signal/stop facts. Requested
  primary causes (timeout, cancel, recording-error, and other stop classes)
  stay ahead of a later observed exit signal; `signal-termination` is only
  for an externally signalled exit with no earlier requested cause. Context
  close is local to that runtime handle. Recovery preflight treats unsettled
  holds and a controller without a matching hold as blocking; capacity-1
  admission still fails closed while an unsettled, mismatched, unverifiable,
  or closed-context hold occupies the slot. After a committed complete or
  proof-only terminal settlement, the same in-process active hold and
  admission token may finish internally so the original post-commit error
  can return without leaking the slot; that is not D4 resolution.
  Donor tree `048fa056c3e07a6bcc8079775377508e15baeaa7` (native Grok plus
  GLM OpenRouter experiment) is retained as provenance, not acceptance.
  D4 `blocked_uncertain` recovery, remaining joins, approval, waits,
  duration/cost budgets, and the full Phase 3 driver were then open, and issue #89 was
  open *(historical at that slice; the driver record under Landed fulfils the Phase 3 gate
  sentence and #89 closed on 2026-09-08)*.
- **D4 U2a-2 model-free join-all panel dispatch (implemented, unreleased):**
  agent/moa `join: all` steps birth exactly `assignments.target` members
  through a `maxParallel` window, settle each owner separately, and join
  once. Membership and attempt start freeze after a recorded outcome,
  terminal step, or durable `cancelRequested`. Exact capability lookup
  binds the executing owner at starting, executing, pre-invoke, and
  settlement to the minted hash plus run/step/stepAttempt/assignment/attempt/
  driver producer/state; a tampered hash is rejected before invoke.
  Pending cleanup locates `owned.get(item.attemptId)`, never a positional
  `owned` index. `executing_unrecorded` stays the singleton exception only.
  Uninvoked starting agents and failed durable settlement
  stay unresolved with `attempt_unreconciled` rather than a fabricated
  terminal run. *(Status at that slice; the driver entry under Landed supersedes it.)*
  Full D4, default/fix driver gate, evidence, retries,
  approvals, waits, budgets, and recovery remain open. Operator-prioritized
  roster/routing planning is next after this slice is accepted; it is not
  implemented here and does not pass a product Phase 4 gate.
- **Phase 3 engine & model-free driver complete (implemented, unreleased):**
  D4 `blocked_uncertain` recovery after S4 command execution (`recoverKxmRun`
  supporting `retry`, `fail`, `cancel`, `unblock`), gate hold resolution, and
  incomplete attempt exclusion in `gateRecoveryPreflight`. Step admission
  expanded for declared workflow kinds (`agent`, `moa`, `approval`, `wait`, `gate`),
  `all-settled` join evaluation with `minimumPassed`, `distinctBy: [provider]`,
  `maxAttemptsPerAssignment <= 2`, repository write declarations, and evidence
  types. The model-free driver in `test/core/driver.test.ts` completes and
  recovers `examples/project/.kxm/workflows/default.yaml` (plan → implement → verify → ready → completed;
  rework loop; gate uncertainty recovery via retry, fail, cancel) and `fix.yaml`
  (all 13 stages; approval pass/rejection rework; two-producer MOA `all-settled` joins;
  critics rework back-edge to plan; approval rework back-edge to plan; command gates;
  wait signal step) without illegal transitions or evidence reuse. Caller-authored
  replies fail closed. Fulfills the Phase 3 Gate sentence.
- **Phase 4 harness/model assignment validation & Pi auth probe (implemented, unreleased):**
  `validateHarnessModelPair` enforces unhosted harness/model pair rejection at
  assignment, rejecting models not hosted by the selected harness (Claude ≠ Grok,
  Codex ≠ Gemini, etc.) and enforcing native Pi brake rules (blocking direct
  native-provider impersonation through Pi without allowlisted aggregator prefixes
  `openrouter/*`, `nous-portal/*`, `nous/*`, `nous-proxy/*`). `probeHarnessAssignment`
  and `probeHarnessesForModel` supply exact requested provider/model context to
  Pi (`pi auth check [--provider <p>] [--model <m>] --json`) before claiming Pi
  readiness, enabling `eligibleHarnesses` to dynamically filter authenticated
  harnesses for a specific assignment candidate without static YAML matrices.
- **Issue 127 complete (PR #129, `50c8482`):** native writer, fixed witness,
  independent Fable/Sol reviews, acceptance, and all five PR CI jobs passed.
  The parent-alias regression owns its temporary symlink on Mac/Linux;
  the earlier CI failure remains in private history. This developer runner
  prerequisite does not complete any product phase gate.
- **Runtime initialization CI repair (PR #130, operator bootstrap exception):**
  concurrent first-open callers inspect
  schema versions and tables under the same write transaction that initializes
  the registry or event store. Deterministic two-process regressions cover both;
  newer, outdated, and malformed schemas still fail closed. Acceptance follows
  the single-repair operator exception above; the two unsuccessful native
  attempts remain in private history. Phase gates are unchanged.
- **Platform pause (2026-09-05):** the active PR gate is two Linux
  `validate:ci` + `check:generated` legs (Node 22.19.0 and 24) plus Docs lint
  and Plugin validation. Classify changes plus those four jobs is five CI
  jobs; all five run on docs-only diffs. Local verification is `npm run
  verify` on macOS. Windows CI legs, hosted Windows probes, and `release.yml`
  are paused: the two Windows contexts left ruleset `22251971`, the Release
  and probe workflows are disabled in settings, and the `release` job carries
  a source `if: false` latch so re-enabling the workflow cannot publish.
  Release safety logic and its tests are unchanged. Windows is paused, not
  unsupported; no Windows code was removed. No new paid macOS runner.
- PR CI no longer skips Validate or Plugin validation for docs-only diffs,
  restoring the ruleset’s required contexts (four expanded Validate names plus
  Plugin validation). That seven-job PR surface (four Validate legs plus
  classify/docs/plugin) is historical as of the 2026-09-05 platform pause.
- Plugin/package/skill/MCP rename toward `kxm`; tools `kxm_list` / `kxm_send` / …;
  env prefix `KXM_*`.
- `kxm dash` tabbed dashboard; hub ops snapshot carries run progress and plan
  summaries (no message bodies).
- `defaultHarness` / agent `harness` schema fields; unknown harness fail-closed;
  omitted harness equals `pi` in permission projection.
- Harness catalog + `kxm harness list` + `kxm update`.
- Phase 2 Runtime create/recover (PR #75) is in tree: supervisor, event store,
  projections, crash recovery. Runs stay `created` until Phase 3.
- `kxm update --check` / `--kxm`: GitHub release tarball and npm source are
  implemented; the public-package prerequisite is now satisfied. Default source
  remains GitHub. `auto` only from per-user host-state
  `update.yaml`. Install-kind detection: only npm-global applies; source
  checkouts neither fetch nor nag; other kinds refuse and explain, including
  explicit `--kxm` when already current or the release check fails. GitHub
  installs verify the `kxm-<v>.tgz` sha256 digest (absent is fatal).
  Notice on hub start (skipped for source) and session widget (cached). Does
  not block session start on the network.
- Hub-local session brief: `kxm session brief`, Pi TUI picker + status/widget
  on `startup`/`new`/`fork`, `/kxm` (`status`/`hub`/`help` completions),
  skill `kxm-session`, `kxm hub bind <url>` / `kxm hub unbind`.
  `/kxm hub` wraps hub view + online agents. `/mesh-status` is removed (brakes).
  Slash inspects via the same brief snapshot as the CLI. No message bodies.
- `kxm hub bind <url>` / `unbind` persist a host-level `hub-binding.json`.
  `kxm init --hub` / `--hub-url` are unknown options. Hub start prints a cached
  update notice, refreshes in the background, and warns (does not exit 2) on a
  malformed per-user `update.yaml`. Source
  checkouts skip the notice. A project `.kxm/update.yaml` is ignored with a
  warning. Startup reports `auth=token|none`.
- Tri-state auth probes: Codex distinguishes ChatGPT subscription, API key,
  and unparsed. Pi inventory without a named provider/model is `unknown` with
  `auth_context_required` (no global auth; missing-context, not a provider
  stand-in). Claude parses JSON `loggedIn`. Grok catalog entry observational
  (`mode: either`), probe parses the confirmed login line. Kimi, Gemini, and
  DeepSeek report `unknown`. `eligibleHarnesses` fail-closed pure selection.
  Rule tests: no static harness/model matrix; eligibility excludes unknown and
  false; `default.yaml` declared graph routes `ready` only through `verify`.
  This is inventory filtering only (issue 84 auth/eligibility sub-slice), not
  a supervised-worker claim or live assignment.
- Headless `scripts/harness-run.mjs` helper (2026-09-05, M1 transport
  2026-09-06 merged in PR #129, unreleased): native auth preflight, verified
  grok/claude/codex/OpenRouter-Pi pairs, no native-provider Pi fallback,
  private answer/stderr/dispatch/model-claim/error sidecars, shell:false
  launchers. Result schema is `kxm.harness-result.v2` only; obsolete v1
  files are diagnosed and not parsed or upgraded. Helper `finalOutcome`
  and arbitrary `agent` envelopes are gone. Transport
  `completed|failed|interrupted` is not a model claim and not product
  `routing-record.v1` `finalOutcome`. Direct-child `exit`/`close` keep a
  null `exitCode` and the exact `signal`; an external signal with no
  helper timeout is `interrupted`. Natural successful exit waits for
  stdio close/drain; `completed` needs exit code 0 and observed close or
  both streams drained. Lingering inherited pipes settle on a bound as
  `stdio_incomplete` (known usage stays partial) without signaling an
  already-exited child or adopting descendants. Close with a null code
  and no signal is `unknown_exit`, not `completed`. Timeout
  requests SIGTERM, then SIGKILL after a bounded grace, and can settle
  with `observedChildExit` false when stdio never closes, without
  descendant-death claims. Public metadata is a closed allowlist
  (`errorCode`/`stopReason` known enums) with type checks on the whole
  public result and nested usage/cost/providerMetadata (finite
  nonnegative cost, nonnegative integer counters, bounded
  enums/booleans/strings). Invalid scalar objects and malformed strings
  are dropped, not leaked or coerced to zero; known valid fields and
  aggregate >1M metadata stay. Raw invalid details stay private. The
  first-80-character stderr substring scan is gone. Post-spawn
  write/normalization/spawn failures, including malformed optional text
  and stdin/pid-record write errors, keep their known run/spawn stage
  and any observed partial spend; they are not relabeled as no-spend
  preflight and do not throw as `ERR_INVALID_ARG_TYPE`. Grok argv adds
  `--no-subagents --disable-web-search` and optional `--max-turns`;
  Codex adds `--ignore-user-config` (parser probe exit 0; top-level help
  omits it).
  Routing fields `harness`/`role`/`model`/`permission`/`prompt_file` are
  required nonempty strings (no CLI-default model or permission). Pi
  planner/reviewer cannot `edit`; only `experiment` may. `max_cost_usd` and
  `timeout_ms` must be positive finite numbers when set (zero is not
  dropped silently). `just` recipes JSON.stringify user paths via
  positional args. Recipe quoting tests use the justfile body and do not
  require a just binary; live just integration is optional. `just runs`
  accepts v2 only and labels billed / list / unmetered / unknown /
  provider-reported (never absent as `$0`). `prompt_file` and
  `output_schema` resolve against the invocation cwd and are read before
  any auth or assignment spawn; missing or unreadable inputs fail closed
  with zero spawn. File-consuming argv tokens are absolute so the child
  can run in `request.cwd`. Windows helper dispatch is unverified. Not
  Phase 11. The issue 127 runner is merged and adopted for developer
  assignments (PR #129); its transport, manifest validation, canonical
  records, fixed witnesses, exact-commit acceptance, private attribution,
  cost observations, reporting, and plan history are implemented/unreleased.
  Per-candidate acceptance binds an actual native writer, the fixed witness,
  and both designated native reviewers. Historical same-tree BLOCK records
  remain binding after plan advance or worktree removal. Cost-only bootstrap
  observations cannot authorize acceptance or fabricate native completions.
  Low-level `just impl|plan|review-*` remain transport recipes.
  `scripts/assignment-run.mjs` validates closed `kxm.assignment.v1`
  (kind/route, explicit effort/permission, cwd plus required `task_dir`
  whose final segment equals `task_id`, clean or staged base, current or
  restricted bootstrap `plan_ref` bound to `task_dir/plan-current.json`,
  hashed inputs, contract, fresh identity/output and rework under
  `task_dir`). Git comparisons for validation are read-only
  (`--no-optional-locks`, porcelain `-z` status, `cat-file -t`,
  `diff-index --cached --quiet`); validation never mints a tree or writes
  `.git`. `run --manifest <absolute-path>` consumes identity at
  `task_dir/<assignment_id>` (exclusive non-recursive mkdir plus immutable
  manifest copy, no `--task-dir` override). Safe custom output may be a
  sibling or external path, including missing parents and nested paths
  under the record directory; the final output directory is reserved
  non-recursively and never adopted. Runner records stay canonical;
  native sidecars use `output_dir`. Identifiable invalid inputs write
  `refusal.json` with `provider_calls` 0; duplicate/unsafe identity writes
  nothing. Completions bind invocation (`thrown`/`returned`), observed
  candidate (`recorded` or `unknown`/`snapshot_failed`), and recording
  status for candidate/sidecar/routing/telemetry steps. Returned v2
  transport/usage/claims are preserved across later snapshot or write
  failures; pre-invocation failures stay refusals; helper throws with an
  explicit preflight/auth stage record that stage, and unclassified throws
  are failed run/`unrecognized` with unknown usage. `observe` recovers
  resolvable routing/telemetry via a completion-hash-bound
  `recording-resolved.json` without rewriting completion or rerunning the
  model. Routing normalization is bookkeeping: a returned v2 result still
  writes completion with known transport/usage even when the routing schema
  rejects an over-long effectiveModel. Existing telemetry, routing, and
  resolution files are accepted only when they match this assignment's
  stable identity and facts (timestamps ignored); malformed, foreign, or
  conflicting bytes fail closed without overwrite. Observation keeps original
  unknown/failed candidate and sidecar facts and does not advertise
  unrecovered recording failures as ok, including omitted failed sidecar
  refs that never entered `completion.sidecars`. Surviving recorded files
  are not sidecar recovery. `observe --record-dir <absolute-path>`
  is the recovery CLI; parent-alias invocation compares real path identity
  so `/tmp` vs `/private/tmp` still runs `main`. This remains local
  unreleased M3b work, not acceptance. Critic review requires completed native transport, an unchanged
  recorded candidate, and a validated top-level PASS/BLOCK; otherwise
  `critic.kind` is `none` with a bounded reason. Only provider-reported
  cost populates routing `costUsd`; unmetered/list estimates and over-cap
  tokens stay named providerMetadata. Native output schemas are closed
  (`additionalProperties` false, every property required, no
  minimum/maximum keywords). Private pre-dispatch carries
  manifest/prompt/plan hashes, dispatch is the v2 helper, and one pending
  routing record is appended before the immutable completion.
  Importing or calling validation still does not create an output
  directory, reserve an ID, write dispatch, mutate the worktree, spawn a
  provider, or fake live auth. No new npm gate. Snapshot/mint of an
  output candidate is only in the effectful recording path. Witness
  snapshots may `git write-tree` the current index; a dirty unstaged
  baseline refuses with zero gate execution. Passed receipts require
  every fixed-gate exit 0, identical HEAD/index_tree, and a clean
  unstaged/unignored worktree before and after. Staged `dist` is a valid
  candidate. Model claims cannot set verification.
- Coverage include inverted to `plugins/kxm/src/**/*.ts`; excludes are only
  `server.ts` and `mcp-server.ts` (spawned bundles attribute to `dist`).
  Thresholds are measured whole-tree values and may only ratchet up.
  `npm run verify` includes `check:generated`, which diffs built `dist` against
  the staged copy. `check:generated` also runs on every CI validate leg.
- **B4 issue 85 (unreleased):** five-layer import boundary held by
  `test/import-boundary.test.ts`. Direct imports from `extension.ts` and
  `mcp-server.ts` to hub, store, or workflow are banned including type-only;
  the six shared workflow data shapes live in `protocol.ts`, with an internal
  type re-export from `workflow.ts` (not a product alias). Package `exports`
  are exactly `./core`, `./runtime`, `./client`, `./extension`, `./mcp`, and
  `./package.json`, all compiled `plugins/kxm/dist` JS except `./package.json`.
  No bare `"."` entry. `./mcp` is the executable path. `pi.extensions` stays
  on source. Four library bundles are in `check:generated`. The durable pack
  guard asserts those four library bundles plus the two barrel sources are
  present in `npm pack`, and that `package.json` `files` still includes
  `plugins/kxm/dist` and `plugins/kxm/src`. One-time six-file delta versus
  this slice's base (zero removals) is saved in `b4/pack-proof.json` plus
  base/candidate manifests; tests do not freeze that delta against HEAD.
  Boundary tests witness value imports, type-only exports, inline
  `import type`, transitive external edges, and fail closed on a missing
  local AST. Family seeds include `kxm-runtime*` plus harness, routing,
  envelope, and redact. The packed install still runs the CLI, hub, and the
  three library subpaths.
- `release.yml` on `v*` tags asserts the tag equals `package.json` version
  before install, runs `validate:ci` + `check:generated`, and packs
  `kxm-<v>.tgz` (`kxmReleaseAssetName`). Release lookup: GET-by-tag is the
  published-release guard. Only HTTP 404 on that call continues; auth,
  network, and 5xx fail with no mutation. On 404, list
  `/releases?per_page=100` including drafts and exhaust pages (or fail closed
  if pagination cannot be finished or is capped). Filter `tag_name === tag`:
  one draft reuses its id and assets; any published match is
  `published_release`; duplicate drafts fail closed; none may create. List
  401/403/network/5xx/unparseable/pagination failure is not missing. A
  published release for the tag is never modified. Rerunning a tag never
  replaces an asset. It succeeds only when the existing asset digest equals
  the local sha256, and it fails without mutation otherwise. After upload,
  the REST asset `digest` must equal the local sha256 (Actions artifact
  digests are not proof). `test/kxm-release-github.test.ts` holds those
  boundaries; `test/ci-contract.test.ts` imports `kxmReleaseAssetName`
  against `release.yml`. The standalone `generated` job is gone. `Plugin
  validation` runs native `claude plugin validate` on the kontextmind-doks
  ARC scale set (previously GitHub-hosted) with
  `@anthropic-ai/claude-code@2.1.261` (no model auth or model calls). After
  `--ignore-scripts` install of that pin, CI runs the vendor `install.cjs`
  so the native binary is present. The npm
  publish job exists but is `if: false`. Activating it requires a later phase
  that adds a published-release prerequisite (release lookup returns
  `draft: false` for the tag) and the `npm-publish` environment. Not
  activated by B2.
- **B2 live draft proof (temporary, cleaned; not a published asset):**
  mismatch tag `v0.0.0-b2mismatch.20260905.1` run `33995663476` failed closed
  before install (no draft). Correct tag `v0.5.20260905` at proof commit
  `9960e6f`; Release run `33995686608` attempt 1 uploaded draft `383391727`
  asset `546379172` `kxm-0.5.20260905.tgz` digest
  `sha256:96eb9aa99cd7025b3f313f7a8caa660a48f8efe08bf649d88fe82353aa74851f`
  (independently downloaded bytes match). Attempt 2 `success` with
  `skipped: true`, same release/asset/digest, no duplicate drafts. Root
  deleted the temporary draft plus remote/local tags and the proof
  branch/worktree; absence verified via release list and `ls-remote`.
  Published `v0.5.1` unchanged; tree version remains `0.5.1`.
- **protect-main applied:** ruleset `22251971` keeps all live rules and the
  four Validate contexts; `Plugin validation` is now required.
  `delete_branch_on_merge` is true. Evidence: B2 artifacts
  `ruleset-applied.json` and `repository-applied.json`.
  Amended 2026-09-05: Windows contexts removed; Linux contexts and Plugin
  validation remain required.
- `kxm mesh` fails closed with a stderr brake naming `kxm init`, `kxm hub`, and
  `scripts/smoke-multi-pi.mjs`. `MeshClient`/`MeshHttpError` are `HubClient`/
  `HubHttpError`; `MeshDashboard` is `KxmDashboard`. Operator copy says `hub:off`;
  a docs brake test under `npm test` fails on `mesh:offline`, `kxm mesh`,
  `/mesh-status`, `MeshClient`. Session readiness on `startup`/`new`/`fork`
  (status line, widget, online and offline hub, TUI picker skip/select, RPC and
  opt-out, single registration) is a deterministic extension test. Pi install is
  pinned `@main`.
- Queue test (#119) and worker PID readiness (#120) **landed** (test-only;
  production worker unchanged): on failure the queue test stops the
  extension in `try/finally` with bounded `shutdownExtension` before hub
  teardown. Fixture `requestTimeoutMs` defaults to 1000; this peer uses
  5000. TTL untouched. An abort-aware injected first-send failure must
  exit the child itself within a deadline. The worker generation test waits
  for a complete matching PID record (identity JSON, not file existence)
  and stops the owned child in `finally` with a bounded SIGKILL before
  removing the temp dir. Deadline-as-success is rejected; bounded exit
  protocol is asserted. Partial JSON identity-readiness is covered by a
  deterministic helper test.
- **#112 fixture repair landed** (test-only, not a claimed Windows crash
  mechanism): the integrated pre-ack child awaits real `session_shutdown`,
  clears its keepalive, sets `process.exitCode`, and does not call
  `process.exit`. Failed cleanup does not force 7. Controlled hosted
  regression proof (not the underlying crash mechanism): GitHub Actions
  run `33998022233`, `windows-latest-l`, Node `24.19.0`, `npm test` with
  coverage absent. Baseline exact `79b5862` 3/3 known pre-ack failures
  (`actual: 3221226505` vs `expected: 7`), no unrelated failures. Fixed
  exact `c499cb2` 3/3 full suite pass, pre-ack ran, exit 0. Both commits
  immutable. Temporary probe workflow/branch/worktree deleted and never
  merged. All four normal `validate:ci` coverage legs remain required.
  Not a general Windows cure; no extra permanent npm gate.
  Windows legs are paused as of 2026-09-05; the four-leg statement above is
  historical. The pre-ack shutdown fixture fix remains landed.
- **D1 engine compile (pure):** `engine-compile.ts` compiles a validated
  `kxm.workflow.v1` into a deep-frozen, JSON-serializable plan keyed by step id
  with typed transitions, per-edge and global transition budgets, step
  `maxAttempts`, resolved assignment bounds and join on every step kind (never
  wider than the loader validated; assignment bounds use the loader's formula),
  evidence declarations, oracles, and plan-hash requirements. Both
  `default.yaml` and `fix.yaml` compile. `kind: workflow` is reserved and
  rejected at compile. No execution, no I/O, no events.
- **D2 engine run loop (agent-only, model-free; unreleased):** `engine.ts`
  pins the D1 compiled plan in an immutable content-addressed `run_plans`
  envelope and advances `created → preparing → running →
  completed|failed|cancelled` with a driver-simulated producer only. The fold
  requires `run.created` first, binds assignment/result/terminal events, and
  rejects `waiting` / `blocked_uncertain` in this slice. Operator `cancelled`
  from `created`/`preparing` requires recorded `run.cancel_requested`; a
  compiled selected `terminalStatus=cancelled` remains valid without that
  operator event. Pin rehydration validates the full envelope from `unknown`
  (row and pin-event hash). D2 event payloads are closed. Public
  `drive`/`step`/scheduler share one per-store admission map: same-run
  exclusion for the whole drive, duplicate queue ids rejected as `run_busy`
  before admission, bound oversubscription as `run_admission_exceeded`, stale
  handles as `scheduler_policy_conflict`, and cross-project bundles as
  `run_owner_mismatch`. Direct
  drive uses the same bound and cannot widen it. Executing commit precedes
  in-process invoke with no await gap; sync throw and async rejection both
  settle `producer_rejected` with no capability leak. A real child-process
  restart of an executing attempt is `attempt_unreconciled` (cancel then
  `cancel_pending_foreign`); there is no live-owner reset and no D4
  adoption/remint. Proven on a synthetic agent-only fixture; `default.yaml`
  pins and stops fail-closed at start because it declares run duration
  limits. D3/D4 and the rest of Phase 3 were then open *(historical at that slice — the
  later driver record fulfils the gate; #89 closed 2026-09-08)*. The developer runner
  prerequisite merged in PR #129; it does not satisfy this engine gate.
  Issue #88 / D2 closed on all seven PR CI jobs (four Validate legs plus
  classify/docs/plugin) before the pause; the post-merge main Windows Node 24
  package-cleanup failure in run `34006194862` is unresolved and deferred.

- **KXM Agent Skills Suite plus trusted-policy brakes (candidate, not YAML cutover):** One authored suite under `plugins/kxm/skills/` with generated `.agents/skills` mirror and `plugins/kxm/skill-suite.json`. Skills document current CLI verbs only; they do not claim runtime YAML authority or new writer admission. `emit-codex-artifacts` / `check-generated` require a valid manifest, refuse path/symlink escape, copy owned skills recursively, and preserve unrelated `.agents/skills` entries. **Prerequisite repair:** `getRosterPolicy` no longer reads raw working-tree `.kxm/roster.json` after a trusted-loader error; missing, empty, or malformed policy is `route_invalid`. Acceptance no longer catch-to-nulls policy; required critic specs come from loaded policy, not a null-policy default. Unified YAML role/project/workflow authority remains open.

- **Unified YAML foundation (parser + passive draft validation only):** Shared restricted parser `plugins/kxm/src/restricted-yaml.mjs` (with `.d.mts`) preserves public `parseRestrictedYaml` behavior through a `kxm-config` `KxmConfigError` wrapper. Passive `schemas/policy-draft` (`kxm.model.v2` / `kxm.role.v2`) and pure `validatePolicyDraft` accept explicit draft documents, evidence bytes, and code-owned ceilings. This is not live YAML policy cutover, not `.kxm/roster.json` removal, not global-role migration, not mandatory bindings, not runtime admission, and not new writer admission. Draft routes labeled admitted in tests are not activated. Phase 4/11 product gates are not claimed.

- **Nous opt-in Pi providers:** opt-in `nous/*` (direct API) and `nous-proxy/*` (Hermes subscription proxy) via `KXM_NOUS_PROVIDERS`, with fail-closed catalog/price boundary, bounded factory-time discovery, and env-only direct auth (`NOUS_API_KEY`). No router, no writer admission. Public `/v1/models` catalog fields are observed (`context_length`, `top_provider.max_completion_tokens`, `architecture.input_modalities`, `supported_parameters`, per-token `pricing` plus `overrides`); convert once to USD/M and never apply `original` or a blanket discount. Matching dated pins supply rates/capacity when live pricing is incomplete. Context tiers emit a labeled componentwise upper bound without a Pi `cost.tiers` schedule. **Verified 2026-09-07:** tests verified one streamed tool call plus usage on `qwen/qwen3-coder-plus` for the direct API and an OAuth-backed Hermes proxy, with exact model auth. Other models, automatic auth refresh, exact quota, and extra charges remain unverified. Routing v2 and persisted catalog deferrals remain.

- **E3: routing report, logger, metrics (issue #96):** `kxm routing report` groups attempts by `(harness, model, thinking, role)`, reporting attempts, verifyPassRate, reworkRate (back-edge re-entries only: transitions > 0), p50 and p95 latency (linear interpolation), medianContextTokens, meteredCostUsd, costPerAcceptedUsd, and separate counts for unmetered, unknown, and quotaExhausted. Quality-first sorting (verifyPassRate desc, reworkRate asc) then cost per accepted attempt; routes with unknown cost are flagged (`*`) and never ranked cheapest. Equivalent list cost column supported via `--equivalent-list-cost` / `--list-prices`. Unified `logger.ts` with structured JSONL formatting, level priority filtering, child loggers, size-capped file rotation, redaction on write (secrets and sensitive keys), and daemonized stdout suppression. Prometheus metrics renamed to `kxm_*`, exported orphaned `kxm_context_requests_total`, added `kxm_attempt_latency_seconds_total` and `kxm_metered_cost_usd_total`. Zero `pi_mesh_*` or `pi_kxm_*` metric names remain.

- **SQLite sidecar symlink TOCTOU race (issue #115):** Replaced two-call `existsSync` + `lstatSync` checks on SQLite database files and `-wal`/`-shm` sidecars in `plugins/kxm/src/runtime-store.ts` and supervisor token/error files in `plugins/kxm/src/runtime-supervisor.ts` with atomic `lstatSync(..., { throwIfNoEntry: false })`. Closes TOCTOU race where SQLite deletes ephemeral sidecars on connection close, crashing with `ENOENT` during concurrent status reads. Verified symlink rejections on main database, sidecars, and token files.

- **E1: session brief contract (issue #98):** Schema `kxm.session-brief.v1` (`schemas/session-brief.schema.json`) with `schema`, `generatedAt`, `staleSeconds`, `source`, `hub` (state + evidence kind), `stats`, `tasks`, `plans`, `statusLine`, `widgetLines`, optional `cost`, and optional `sessionToken`. One renderer `renderStatusLine` capped at 80 columns with `…` truncation; three callers (`kxm session brief --status`, Pi status slot, and `/kxm status`) produce identical status lines. Hub probe with 300 ms abort to `unknown` returns in under 1 s on blackholed URLs. Cached at `.kxm/state/session-brief.json` with 5 s TTL. Git ship counts against merge base (`origin/HEAD`, `main`, `master`) when no upstream is configured (renders `2 local` on fresh branch). Second status key retired; repaints on `turn_end`. Claude plugin `statusLine` command and `SessionStart` command hook. `kxm session brief --token` issues interactive session token with `operator` preset.

- **E2: dash and brief read KXM runs, messaging cursor (issue #99):** Union reader in `local-snapshot.ts` over legacy SQLite (`kxm.db`) and KXM registry (`registry.db`) + per-project event stores (`run-events.db`) with `PRAGMA busy_timeout = 5000` on read handles. Determines `source: "both" | "runtime" | "legacy"` and merges deduplicated runs and counts. Spend tab in TUI (`MESH_TUI_PANELS` key 7 and `kxm dash --screen spend`) populated from `telemetry.jsonl` routing records via `readRoutingRecords`. In legacy store: `consumer_cursors` and `agent_sequences` tables, `UNIQUE(from, idempotency_key)` partial index, monotonic per-agent `seq`, ack advances cursor (`POST /v1/messages/:id/ack`), reconnect resumes from cursor (`seq > cursor`), query-on-demand replaces boot-time full table scan, and separate run vs message retention sweeps. Gates verified: KXM runs appear in snapshot and brief counts; reconnect after 5 messages redelivers only unacked ones; hub boots without loading message table.

- **E6: backup, restore, migrations (issue #102):** Unified SQLite lifecycle via `openDatabase` with fail-closed schema checks, WAL journal mode with retry loop, busy timeout, and transaction helper with nesting guard. Stepwise legacy migrations for `MeshStore` (v1 -> v2, v2 -> v3) replace unconditional version stamping. Added `kxm backup [--out <dir>]` and `kxm restore <manifest>` utilizing SQLite's backup API (`VACUUM INTO`), WAL checkpoint, PRAGMA integrity checks, and hashed manifest generation (`kxm.backup-manifest.v1`).

- **E8: improvement report and candidates (issue #97):** `kxm improve report` reads routing records and emits candidates grouped by `(workflowHash, step, agentRole, promptHash)`. Rows carry recurrence, mean cost, mean latency, verify-pass rate, and rework; high recurrence with high pass rate emits coded-repeat candidates. Single candidate format `kxm.candidate.v1` in tracked `.kxm/candidates/`: `kind` (`gate`, `skill`, `workflow-step`), `evidenceRefs`, `baselineMetrics`, `declaredOutcome`, `measure`, `proposedDiffPath`. Skill candidates carry standard YAML frontmatter (`name`, `description`). `skills promote` emits a unified diff patch (`.patch`) instead of moving a directory. Workflow `examples/project/.kxm/workflows/improve.yaml` runs and completes on the KXM driver. Retrospective exports are un-gitignored.

- **B3: three failing rule tests and auth probes (issue #84):** Three failing-first loop rule tests in `test/core/loop-rules.test.ts` (unhosted harness/model pair rejected with `harness_unhosted_model`; pure inventory eligibility fails closed on empty/unknown; `verify_must_precede_ready` enforced in workflow validation). Official CLI auth probe for Kimi (`kimi provider list` non-mutating stdout parser without `--json`); `gemini` and `deepseek` remain `unknown` (`null`) without secret leakage; `kxm harness list` reports status for pi, claude, codex, kimi.

### Still open

- **The one queue (replanned 2026-09-20; design record
  [reviews/plan-set-reprioritization-astra.md](reviews/plan-set-reprioritization-astra.md)).**
  S0–S5 are selected MVP work in order; everything after them starts only on its stated
  trigger, and no step adds an npm script, CI job or platform leg (see Cross-cutting test
  gates). S1 uses a provisioned tenant box; S2/S4 need the portal checkout. **Zero
  event-store or hub-store schema change in S0–S5.**

  | # | Deliver | Unblocked by | Proof | One named test |
  |---|---|---|---|---|
  | S0 | Reconcile plan authority: this queue, the gate/decision contradictions above, catalog demotion, AGENTS prose and regeneration | this replan | coherent tracker, catalog and generated artifacts through existing `verify` | none — prose and generated output, existing gate covers it |
  | S1 **(delivered: PR #253)** | Hub + local Runtime on the tenant box: service account, persisted state paths, loopback listeners, existing restart path, one project and the slim `default` workflow; **the hosting recipe and the stopped-state backup/restore procedure for the whole tenant state set** in `docs/operations.md` (the recipe S1 replaced stopped the hub and copied `.kxm/state/kxm.db`, which is hub-only; `docs/operations.md` now enumerates all six roots); **the reverse-proxy contract** as invariants plus one labelled example and no generated config; and the two `kxm hub bind` tightenings settled in [plan-per-tenant-hosting.md](plan-per-tenant-hosting.md) — refuse a non-loopback bind with no resolvable credential, naming the fix, and label the binding loopback or remote in `kxm hub view` and `kxm session brief` | a provisioned box and a selected authenticated route | restart the services; readiness, persisted credentials, retained run identity | none — deployment witness; existing behavioural gate |
  | S2 **(KXM-side read delivered; portal pieces open)** | Portal reads authoritative state: tenant label, connectivity, agents, runs, current status, latest receipt — hub metadata distinguished from Runtime run state, stale/unavailable explicit, polling. `kxm tenant status` (PR pending) composes both labelled authorities, attaches to (never starts) the supervisor, and reuses admin-token precedence; remaining: the `ws-api.py` route on the tenant box (shell out + cache) and the `kxmd-portal` card — **canonical front end is `kxmd-portal`; `dev-vm-platform/ops/pilot/web` is a legacy snapshot** (their docs/16) | S1, portal router access | the read plus a browser comparison against the same run's CLI/API state | `portal reads distinguish hub metadata from Runtime run state and unavailable upstreams` in `test/core/studio-layout.test.ts` (landed) |
  | S3 **(delivered: PR #256)** | Strict outcome on the selected Pi route — prose word-matching and default-pass removed, plus the quoted-example and cancel-path variants the first review found | existing Pi producer fixture | negative outcome test plus selected-route live execution in S5 | `Pi final prose or malformed outcome cannot pass an assignment` in `test/core/pi-producer.test.ts` |
  | S4 | Portal drives one workflow: create, drive, cancel only, reusing existing command/run/drive IDs and receipts; 202 is started, never completed | S2, S3, exact project binding | command-parity test plus existing duplicate-drive, shutdown and receipt coverage | `portal create-drive-cancel preserves command identity and reports authoritative settlement` in `test/core/studio-layout.test.ts` |
  | S5 | Edge authentication and first real use: HTTPS + Authentik on the tenant's existing proxy, tenant-admin only, hub and supervisor stay private, and **the deployed restore witness** — one restore performed with S1's procedure before first use (procedure authoring is S1's; S5 proves it on the box) | S4, tenant DNS/TLS/Authentik config | deployed witness: unauthenticated access denied, wrong tenant denied, logout/revocation, refresh mid-run, one real `default` run, one usable restore | none — named deployment witness, no new suite |

- **Recorded gap, not scheduled (2026-09-20, found while fixing S3):**
  `producerPolicy.acceptedStatuses` compiles to `["passed"]` in
  `engine-compile.ts` / `engine-plan.ts` and is **never consulted at settlement**. The
  hub's peer-evidence path (`workflow.ts`) accepts any message that is `replied` with
  non-empty content from an eligible producer, so a peer whose own work failed can still
  satisfy a checkpoint that reads as passing. S3 closed the equivalent hole on the Pi
  producer path; this one is different in kind — enforcing it needs a decision about what
  "the producer passed" means for a peer that is not running a step of this run (whose
  assignment, which epoch, and what replaces it when a peer answers from outside any run).
  That is an evidence-semantics decision, not a producer fix, so it is recorded rather
  than half-implemented: a settlement change here would silently invalidate existing
  peer-reply evidence in flight. **Trigger:** the first workflow that gates acceptance on
  peer review rather than on the coordinator reading the replies.

  **Explicitly not MVP, with its trigger:** post-MVP closes observed first-use failures
  (one focused regression per repair; scheduler/supervisor timing moves here unless it
  fails a current gate, and gets a barrier or injectable clock, never a wider timeout);
  automated backup discovery (trigger: routine unattended recovery — today's discovery
  looks at project-local `runtime/events/*.db` while Runtime opens
  `runtime/projects/<key>/run-events.db`, so the existing "all stores" fixture must not be
  read as deployed coverage); the v6 identity/history slice (trigger: selecting coordinator
  intake dispatch or rebinding — one test, `v5 coordinator rebind preserves historical
  identity after migration`, **v5→v6 approved here**); durable arrival order and bounded
  intake release (same consumer, before sustained traffic); the internal intake consumer
  (trigger: queued intake actually needed, after the two above); one progress improvement
  then one supported control (trigger: polling proved insufficient); a reporting projection
  on `kxm-dev-svr` (trigger below); intake digests, rare-contention reproductions and
  rollback-handle hardening as **separate named items**, not one bundled v6; and the older
  Phase 6/7/8/9, M7 breadth, M8 integrations and platform-qualification backlog, which keeps
  its homes and is **not** a hidden chain in front of hosting.

  **Postgres, answered rather than deferred:** SQLite stays authoritative on the tenant box.
  Neither a shared multi-tenant hub database nor a PostgreSQL database per hub becomes the
  hub's store. Smallest cross-hub visibility is a portal-owned list of tenant endpoints read
  by each tenant's own portal backend; do not centralize raw events, prompts or credentials,
  and never expose hub or supervisor ports. A disposable per-hub reporting projection on
  `kxm-dev-svr` is allowed **only** when a concrete report needs retained cross-hub history
  that bounded summaries cannot answer, or measured polling misses an agreed refresh target
  after bounding and caching — hub count alone is not a trigger. Planning allowance 2–5 days
  for one bounded report, discardable and rebuildable, no hub downtime on its failure. If the
  operator insists on Postgres as primary storage now, this stops being the fast hosting MVP:
  synchronous APIs, transaction semantics, SQLite dialect, direct readers, migrations and
  `VACUUM INTO` backup need their own storage-migration plan measured in weeks, and the v6
  identity work must then be reconciled with it rather than ported twice.

- **Package restructure and Bun toolchain (owner: build/runtime maintainer):**
  the layout questions this bullet used to hold are now answered by the tree,
  not by preference: Bun is installer and task runner only (`bunfig.toml` states
  tests stay on Node because "`bun test` would silently test a runtime that
  ships nowhere"), `node --test` + `--experimental-strip-types` and its coverage
  floors remain the suite, esbuild still produces the bundles that
  `scripts/check-generated.mjs` and CI re-verify, nx drives per-package
  `build`/`test`/`typecheck` through `packages/*/project.json`, and the published
  artifact stays one `@kontextmind/kxm` tarball (`npm pack`, Pi loads
  `plugins/kxm/src/extension.ts`) with `packages/core/*` as internal workspaces.
  Remaining work, slice by slice, not in one sweep: move the flat
  `plugins/kxm/src/*.ts` tree into `packages/<tier>/<name>` in the decided layer
  shape as each slice is picked up (`packages/core/tui` is the only package
  migrated so far). CI legs stay npm + Node 22.19.0/24 and must not require Bun
  (the runners have none); installing Bun on the runners is a separate change
  that carries its own CI evidence. Windows automation stays paused, not deprecated. No
  phase gate changes until a slice carries its own witness.

- **Remaining timing-dependent assertions in the core suite (owner: engine
  maintainer; trigger: next touch of scheduler or supervisor transport tests):**
  with the budget seam landed, the same flake class still exists elsewhere. Two
  cases went red in one heavily loaded local run (three suites overlapped) and
  passed in isolation: `admission bound 2 rejects duplicates, direct bypass, and a
  fourth run until a slot opens` (19.6 s under load, 4.6 s alone) and
  `supervisor API misuse: relative roots, oversized and non-object bodies, unknown
  paths`. A third, `packed npm artifact runs the operator CLI and hub outside the
  repository`, is not a race: it needs `npm_execpath`, so it only passes when
  launched through `npm test` — which is how CI runs it. Fix direction is the one
  proven for budgets: drive the boundary from an injectable clock or a real
  barrier (queue depth, slot accounting), never from an elapsed-time guess, and
  never by widening a bound. Until then a lone red in these names is a load
  artifact to re-run through `npm test`, not a product failure — but say so in the
  PR instead of silently re-rolling.

- **Intake contract follow-ups from the astra review (owner: workflow/runtime
  maintainer; trigger: the M2 dispatch consumer, or any touch of event-store
  schema):** the review's deeper structural findings are real but need their own
  reviewed slices because v0.7.46 already shipped event-store schema 5.
  (1) **Coordinator history:** a rebind replaces the active row, so `rebindOf`
  cannot resolve, in-flight messages can reference a vanished identity, and
  intermediate ceilings/reasons are erased — keep immutable versions plus an
  active-slot pointer (schema v6). (2) **Record digest:** records carry no digest
  column, so payload-only offline tampering is undetected; the intake test asserts
  this gap today. (3) **Shared (cycle-free) constant** so the `database.ts` restore
  ceiling cannot drift from the store version. The populated v4 → v5 migration fixture this
  item also asked for is **withdrawd by the single-operator decision** (2026-09-20): there
  are no migration lanes left to test. (4) A
  **two-process barrier test** for concurrent ingress, binding and admission: the
  current proofs are transactional-by-construction plus sequential races. (5) The
  **byte bound must also hold on read**, which needs
  `MAX_INTAKE_CONTENT_BYTES` shared with the store rather than duplicated. (6)
  **Classification is caller-asserted**; enforcing it for untrusted adapters is a
  separate design, not a keyword change. (7) `transaction(...)` is **not
  reentrant** (`runtime_transaction_nested`): the M2 consumer must call these
  entry points at the top level or fold them into its own transaction on purpose.
  (8) **Durable arrival sequence:** dispatch order currently uses SQLite
  `rowid`, which a `VACUUM` (and therefore a restore taken with `VACUUM INTO`) may
  renumber. Persist an immutable per-project sequence and preserve it through
  restore, or state arrival ordering as an same-store property only. The third pass
  also measured the read itself: `EXPLAIN QUERY PLAN` shows the dispatch index
  serving the state filter and then `USE TEMP B-TREE FOR ORDER BY`, so the sort is
  per query as well as per store — the same index scan that a durable sequence
  should remove.
  (9) **Bounded resume:** a resume releases every held row inside one write
  transaction and retains all of them, so work and memory grow with the backlog
  (150k rows of 64-byte payloads: 4.54 s synchronous, ~95 MiB heap; 500k
  maximum-size payloads would retain ~7.6 GiB). It is finite and atomic — the write
  lock keeps ingress out of the loop — so this is an M2 sustained-traffic
  pre-condition, not a correctness hole. Bounding it must not move batches outside
  the transaction, which would reopen the pause race; design the bound together with
  the durable sequence in item 8.
  (10) **Contention mapping, the part still unobserved:** `isTransactionContention`
  now reads Node's `errcode`, `bun:sqlite`'s `errno`, and a symbolic `SQLITE_*` name
  before falling back to anchored text, and a SQLite **result name** decides in both
  directions now: `SQLITE_FULL` carrying a "database is locked" message is not
  contention, which the sixth pass found was still true when only *contention* names
  were recognised and permanent ones fell through to the text. The shared-cache case has
  been reproduced **live on both runtimes** (Node `errcode: 262` / Bun `errno: 262`,
  `code: "SQLITE_LOCKED_SHAREDCACHE"`) by two connections sharing one attached
  database, with a schema change in between. What has *not* been observed on this stack is
  a real `SQLITE_PROTOCOL` or `SQLITE_BUSY_RECOVERY`: this repository opens one writer
  per database, so those paths do not arise in normal operation. Trigger: the first
  multi-process hub writer, or a Node/Bun/SQLite version bump that changes those error
  fields. Two related limits, named rather than assumed away: a failed `ROLLBACK` is
  swallowed and clearing the in-transaction marker does not prove SQLite left the
  transaction, so a handle whose rollback failed is not invalidated anywhere; and a
  `MonotonicClock` argument on a public helper is a seam a future test could use to sit
  outside the throttle — it cannot win a contested write lock, and per-domain keying
  keeps it from contaminating another caller, but it is not a capability boundary.

- **Unified capability delivery (M0–M9; proposed, consolidated 2026-09-14):**
  [The unified plan](plan-unified-kxm-milestones.md) owns proposed scope,
  contract-level dependencies and exit-evidence design. This is the sole active
  owner/trigger record. All ten packets remain proposed; selected slices must
  acquire their own evidence here. No existing gate changes to PASS.

  | Packet | Owner role | Start trigger / remaining outcome |
  |---|---|---|
  | M0 | Runtime maintainer | Current-source reproductions; repair Pi outcome, Studio/control truth, memory redaction and Steel contracts; preserve A1 and remaining lifecycle blockers |
  | M1 | Package/adapter maintainer | Applicable result/permission boundary; coordinator/capability identity, L1 executable identity, actual mode activation and single-package setup. Coordinator identity + intake contract layer is in the tree (see Landed); no adapter surface yet |
  | M2 | Harness/Runtime maintainer | No-model fixtures now; M0 truth/redaction, M1 bindings and M6 minimal inbox policy; durable progress/replay; own Phase 11 HTTP lifetime design before dependent live drive paths; retain native admission blockers |
  | M3 | Harness/control maintainer | M1 exact bindings and M2 durable observations; engine-dependent controls after comparison decision, existing RPC/native probes independent; receipts, resume/steer/interrupt, channels and Phase 6 recovery |
  | M4 | Browser maintainer | M0 browser lease/compatibility and M1 backend readiness; common actions, observations and preview |
  | M5 | Context maintainer | Redaction and authorized scope; tiered recall, candidate impact, extraction/tombstone recovery; L3 search and L4 parser experiments |
  | M6 | Workflow maintainer | Existing Runtime policy plus identity; minimal wake/pause first (the pause/hold/release rule is in the tree — see Landed), then bundle/review/activation integrity, grouped wakes, graph/concurrency/budget and send-authorization contracts |
  | M7 | Operator experience maintainer | M0 UI boundary and M2 snapshot/replay for thin Studio; other service contracts only for their panels; later revision-safe editing, exports and questions |
  | M8 | Auth/integration maintainer | Capability readiness, secret handling and applicable authorization; native/provider setup, quota, Confluence, then external coordinator email/SMS transports |
  | M9 | Release maintainer | Declare release capabilities/platforms; require their dependencies and all applicable canonical blockers/gates, actual tarball and exact-candidate acceptance |

  First proposed product slice: **superseded 2026-09-20 — the ordered queue at
  "Still open" is the only delivery sequence.** Coordinator inbox work moved
  post-MVP behind its consumer trigger; the portal read/drive path (S2/S4) is what
  ships first. Begin with deterministic fixtures; live dispatch retains its
  existing authorization/admission requirements. Duplicate input cannot create
  another task; pause blocks fresh dispatch and bridge resume. No external account
  is needed. Read-only Studio does not wait for full editing or every service.

  Runtime/adapter maintainers then compare current Pi RPC, supervised Pi SDK and
  released OpenCode 2.0.3 on the bounded engine fixture before any dependent
  continuation choice; M9 repeats the selected paths. DSH supplies candidate
  contracts, not another scheduler. TS remains the default; L3/L4 research may
  run independently of Node throughput, L5 requires a reproduced OS requirement,
  and L6 qualifies a component before shipping. No new engine or language is
  admitted. Optional email/SMS, channel previews, parsers and comparison engines
  do not universally block release; scope selection cannot waive the blockers
  below or silently change platform promises. Design decisions and experiment
  details are linked once from the unified plan.

- **One-shot lifecycle and settlement (Phase 11, release blocker):** Strict
  final JSON outcomes now reject nonzero/signaled/error/empty/prose results;
  pre-abort, bounded output/drain/reap, SIGTERM escalation, stdin errors, and
  partial cancellation usage have regressions. Oversized cumulative counters
  now become null bounded fields with raw values in metadata: the failed-first
  1,000,001 cache-read reproduction now settles without relaxing routing bounds.
  Unobserved direct-child exit stops new births without forging sibling settlement.
  Focused engine/harness/routing/process run: 117 passed, 3 explicit live skips;
  typecheck passed. Native isolated arithmetic witnesses completed and settled:
  Fable 14.575 seconds, Grok 37.433 seconds. These do not prove write restrictions,
  a repository task, recovery, or release acceptance. Grok's observed modelUsage
  decoding was subsequently repaired with a sanitized native fixture; old routing
  evidence remains unchanged. Two fixture-preflight failures are preserved as
  unbilled orchestration errors, not model failures; root bootstrap cost is unknown.
  Both designated native critics returned scoped FAIL: remove event-loop-blocking
  auth probes, keep escalation alive after direct-child close, conservatively
  handle unverified descendant effects, witness Claude write refusal, reject
  unaudited permission profiles, retain private bounded/redacted process evidence,
  and verify price-catalog integrity before estimates. Also decouple HTTP drive
  response lifetime from workflow/gate budgets without another scheduler. A prior
  Fable failure at about 219 seconds remains unexplained by elapsed time alone.
  Slice A1 is accepted (2026-09-15): commit-bound acceptance at 915f5e53 on
  095c1ad (task_p11-oneshot-hardening), forward-ported onto post-#206/#207/#208
  main (5ff9f64) and re-accepted at 96e8e0ac (task_p11-a1-forward-port, tree
  0391de95). Landed: async bounded auth/capability probes on all product
  dispatch paths in the new cli/ module layout (sync runner remains only for
  injected tests and `kxm update`); SIGTERM→SIGKILL escalation survives
  direct-child close; unverified descendants settle conservatively (failed +
  effectUncertain, descendantEffects=unverified); private process evidence is
  bounded, redacted, owner-only, and versioned `kxm.oneshot-evidence.v2` with
  fail-closed brakes on retired v1/unknown ids; unaudited permission profiles
  refuse before spawn; the one-shot path verifies price-catalog hash and
  staleness before list estimates; the supervisor's post-202 detached drive
  chain can no longer orphan a rejection on either the async or sync branch
  (unhandledRejection regressions pin both). Writers grok/grok-4.6; witnesses
  `npm run verify` passed on both accepted trees; critics Fable (arch) and Sol
  (cli) PASS both accepted trees after three resolved BLOCKs (evidence schema
  versioning, async drive rejection, sync-throw orphan). The live Claude write-refusal witness is
  also accepted (2026-09-15, task_p11-claude-write-refusal, commit e3d8a64b,
  tree eebef0e8): a KXM_SMOKE-gated live witness proves a Claude read-only
  one-shot reaches the model (processStatus completed, exit 0, tokensOut > 0 —
  the first draft passed vacuously on pre-model CLI errors and was BLOCKed by
  the arch critic) and still refuses a write in a temp sandbox; deterministic
  pins cover the read-only argv profile (--permission-mode plan +
  --permission-prompts none, per captured claude-help.txt), both weakening
  modes, and forged-pass refusal. Root ran the live witness with real Claude
  auth: 4/4 pass, live leg 7.6s. Price-catalog integrity beyond the
  one-shot path is also accepted (2026-09-15, task_p11-price-integrity,
  commit 17efb783, tree bb9ff78d): the Pi producer and `kxm explain` now
  hash-verify and staleness-gate catalogs, record listPriceSha256 with list
  estimates, keep costUsd null for list-only, preserve observed usage when a
  catalog fails after spend (priceCatalogUnavailable), and explain surfaces
  distinct bounded catalog-status reasons (stale-with-date / corrupt /
  missing / verified) in text and JSON. Note: this repo's own
  `.kxm/prices.yaml` (2026-09-08) is stale under the gate, so explain against
  this checkout reports unknown until a fresh snapshot exists. Drive
  decoupling B2 is accepted (2026-09-16, task_9076be56b581 slice B2, commits
  3ba990c+43d374b on feat/p11-b2-drive-receipts): `run.drive_opened` binds
  the driveId inside the log (fold-legal only while running/
  blocked_uncertain; run-state stays kxm.run-state.v2 additive);
  `kxm.drive-receipt.v1` records settlement (terminal/handoff/unsettled,
  folded status only, logHash over eventId:sequence, 8 KiB bound, no
  prompts/producer output/evidence bodies) insert-once by driveId with
  shutdown grace-expiry writing `unsettled`; the poll path reports corrupt
  receipts as `verified:false` divergence instead of throwing; pre-B2 stores
  replay without projection divergence (schema 3→4 creates drive_receipts
  with user_version stamped). Witness `npm run verify` green on 43d374b;
  critics Fable (arch) and Sol (cli) APPROVE after one resolved round
  (poll-path throw on corrupt row; runs status help text). Drive
  decoupling B3 is accepted (2026-09-16, task_9076be56b581 slice B3, commits
  5c972ea+b20a470+5602e5f on feat/p11-b3-run-duration-budget): the declared
  `maxRunDurationMs` budget (min of workflow/project limits, no invented
  default) is enforced via a log-derived clock (state.runningSince from the
  first running status-change; restart/resume-safe deadline), cancelling
  through the existing fold-legal path with reason `budget_run_duration`
  (terminalReason preserved through gate settlement — no operator_cancel
  overwrite; never `failed`, never fabricated); per-attempt unref'd timers
  are bounded, re-arm on early fire, and clear with their controllers;
  fold validates budgetMs/source/elapsedMs as run_events_illegal; receipts
  carry `budget { budgetMs, source, elapsedMs, overrun }`. The drive route
  now passes allowLimits:false (separate revertible commit b20a470) so
  still-unsupported limits surface as a 409 handoff instead of being
  silently ignored. Witness `npm run verify` green on 5602e5f; critics Fable
  (arch) and Sol (cli) APPROVE after one resolved round (gate settlement
  reason hardcode; CLI cancelled-reason rendering and wire-level budget
  assertions). Drive decoupling B4 is accepted (2026-09-16,
  task_9076be56b581 slice B4, commits ef690af+fea8760 on
  feat/p11-b4-drive-surfaces): read-only surfaces over B2/B3 records —
  GET /v1/runs/:id/drive (session summary without token/controller, receipts
  newest-first capped at 20), GET /v1/drives/:driveId (receipt + verified +
  divergence, 404 drive_receipt_missing, corrupt rows reported not 500, fold
  of the stored run with no persistProjection write), `kxm runs receipt
  [--all]`, and `kxm runs drive --wait` (client-side poll, exit 0 only for
  verified completed settlement, timeout bounded to 600000 ms). Writer
  grok/grok-4.6 (one agy gemini-3.1-pro-high attempt abandoned as partial
  cost-only, findings transferred); witness `npm run verify` green on
  fea8760; critics Fable (arch) and Sol (cli) APPROVE after one resolved
  round (write-on-GET via rebuildKxmRunProjection; CLI help/skill/runCli-
  boundary gaps). B2/B3/B4 each carry their own evidence;
  task_9076be56b581 slices are all accepted. Follow-up: GET /v1/runs/:id
  retains the pre-existing B2 write-on-GET pattern (rebuildKxmRunProjection
  → persistProjection) — same class as the B4 finding, ticketed separately;
  closed 2026-09-17 by the read-only projection (see Landed: stash
  reconciliation).
  The Phase 11 gate itself does not PASS here: Issue-127
  retirement/acceptance contradictions, npm readiness, and the unexplained
  Fable ~219s failure remain separate blockers (B1 accepted
  2026-09-15, task_p11-drive-decoupling, commit d590d27f, tree a107f3e2:
  engine-owned drive sessions, driveId on 202, session-owned producer,
  admission-atomic pin+start, bounded truthful shutdown via
  cancelKxmRun(runtime_shutdown) + bounded KXM_RUNTIME_STOP_GRACE_MS,
  fail-closed CLI drive output; three resolved critic rounds: orphaned
  settled rejection, inert bare-running brake, CLI fabricated success,
  unbounded grace knob) and the Fable ~219s failure. Issue-127
  retirement/acceptance contradictions are separate blockers; npm is not
  ready.
- **Model inventory refresh command:** `kxm models refresh` writes the live
  `.kxm/models/inventory.yaml` union from detected Pi/Grok/AGY catalogs and
  OpenRouter/Nous `/v1/models` feeds. OpenRouter rates are recorded as
  standard and Nous rates as discount, each with source and fetch status;
  missing or dynamic rates remain null. Native catalogs do not establish
  authentication or dispatch eligibility.
- **Interactive workflow-guide setup at init (working tree, not a release):**
  after the completion offer, an interactive `kxm init` (created/joined only)
  offers to install software-engineering workflows and roles transcribed from
  `docs/workflow-guide.md`. Harnesses are probed at offer time; each role is
  bound to its first guide candidate whose harness is installed AND
  authenticated (fail closed — no candidate is admitted on detection alone).
  Native-vendor candidates never fall back to OpenRouter when their native
  harness is unavailable (no silent cross-billing). Non-native vendors route
  via the Pi OpenRouter provider. The setup writes only current KXM project
  resources: `.kxm/agents/<role>.yaml` (`kxm.agent.v1`) and
  `.kxm/workflows/<slug>.yaml` (`kxm.workflow.v1`). It never writes retired
  legacy authority (`.kxm/config`, `.kxm/roster.json`) and does not use the
  `kxm.role.v1` subsystem. Uncovered stages are reported as skipped; existing
  files are never overwritten. Suppress with `KXM_SKIP_GUIDE_SETUP_PROMPT=1`.
  Coverage: the five software-engineering guide workflows; extending the
  catalog to other areas is a data-only addition to
  `plugins/kxm/src/init-guide-setup.ts`.
- **Legacy configuration retirement and harness discovery (2026-09-10):** Retired
  tracked legacy `.kxm/config` agent/workflow authority and `.kxm/roster.json`
  in favor of the initialized KXM project resources. `kxm init --dry-run`
  reports `ready` with no legacy inputs, and `workflow definitions` resolves
  the local `default.yaml`. Native discovery verified AGY (14 models), Claude
  (authenticated), Grok (2 models), Codex (authenticated), and Pi exact
  provider/model auth (`pi auth check --provider xai --model grok-4.6`). Grok
  currently exposes only two native models and Claude exposes no model-list
  command; Pi global inventory remains intentionally unknown without exact
  provider/model context. These are explicit coverage limits, not fabricated
  three-model claims. Harness parser tests pass 22/22.
- **Local KXM dispatch (implemented, not accepted):** Authenticated Runtime
  `POST /v1/runs/:runId/drive` and `kxm runs drive` now exist; created runs pin
  their compiled plan before starting. Explicit simulation is not live evidence.
  Current writer must prove authoritative pinned agent/role/policy resolution
  on every dispatch path; a rejected route must not fall through to a default
  model. Required acceptance coverage remains endpoint auth and owner binding,
  created/preparing/running transitions, duplicate drive exclusion, cancellation,
  producer rejection, restart recovery, and no-progress refusal. Historical
  unreconciled/cancelling runs are not successful recovery witnesses. Do not
  replay them blindly, bypass exact attempt identity, or relax sibling settlement
  invariants to force progress.
- **Windows resumption (deferred):** restore the two Windows Validate legs and
  their ruleset contexts, and diagnose the Node 24 package cleanup failure, in
  a reviewed change that updates Tracking, tests, and settings together. D3
  Windows-specific success remains unverified and deferred. Active work
  continues on Linux and local Mac.
- **Platform-gate interpretation for consolidated planning:** the cross-cutting
  test requirements remain unchanged. Paused Windows checks are deferred evidence,
  never PASS; this review does not authorize local or hosted Windows test runs.
  Selecting M9 scope cannot waive a required platform witness. Before claiming an
  affected phase/release complete, the release maintainer must resolve resumption
  or obtain an explicitly accepted change to the governing requirement. Unrelated
  documentation review can proceed without claiming phase completion. Local Mac
  describes a development host, not proof of advertised macOS support.
- **Release resumption and next candidate:** the earlier 0.6.0 latch removal,
  publishing environment and fail-closed publish script are historical completed
  setup. Read-only checks on 2026-09-17 UTC find GitHub latest release **v0.7.40**
  and **npm latest 0.7.40**, with repository version 0.7.1 unreleased. Tags
  **v0.7.41 and v0.7.42 exist with no GitHub release**: the Release job's
  "Sync version surfaces from tag" step did not know about the new workspace
  package, so its own gate failed (see Landed: release version surfaces). The
  release maintainer owns whether to re-dispatch Release for those tags or let
  the next merged PR cut the following one; deleting a tag is an operator call.
  None of this accepts current source 0.7.1 or clears the one-shot/retirement
  blockers. Release maintainer owns M9 scope and exact-candidate evidence;
  Windows resumption remains separate.
- **Public-package follow-ups:** context maintainer may select a bounded
  compiled-from-hub wiki slice now that publication exists; package maintainer
  owns any explicitly selected default-updater change and installed-source
  qualification under M1/M9. Current npm update support is implemented, default
  remains GitHub, and no wiki operation or configuration change was performed by
  this review. The old “not before public npm” trigger is satisfied.
- Coverage only lists modules some test loaded; a future source file with zero
  imports from tests will not drag the number down. A test that imports every
  non-excluded module belongs before the next ratchet raise, not as a B1 add.
- Docs sweep: operator pages updated to `kxm hub start|view|stop` and `kxm dash`;
  CHANGELOG history may still mention old names.
- Remaining Mesh-named internals (`MeshHub`, `createMeshHub`, `MeshStore`,
  `MeshTui*`, `LocalMeshSnapshot`, `piMeshExtension`, `pi-mesh.*` schema ids,
  `X-Mesh-Delivery-ID`) rename together at the wire/schema bump, not piecemeal.
- Slim live `default` workflow for this repo (no bulk migrate of jira/provenance/v04).
- YAML-editing enable/disable UI (Phase 4 `/kxm` settings or `kxm dash` config
  tab). Do not add a preferences overlay.
- Version 1 and 2 run event stores and `kxm.run-plan.v1` envelopes are refused
  with `runtime_schema_outdated` / `run_plan_corrupt`; there is no migration
  lane, and backup/restore remain E6. Coordinated rewriting of an envelope, its
  pin event and all gate rows is outside self-hash integrity; revision drift
  does not detect it.
- Non-Pi dispatch adapters: the one-shot native producers exist and are admitted per route;
  what remains is **qualification of the selected routes** (live witnesses, auth behaviour),
  not an unimplemented adapter. Listing a harness does not execute it.
  The `scripts/harness-run.mjs` dev helper is not that adapter.
- No `types` export condition until declaration emit exists.
- MCP factory API waits for a second consumer (D13); `./mcp` stays an
  executable path.
- Helper allowlists in `scripts/harness-run.mjs` are script constants, not a
  preferences overlay or catalog feed. Pi prefixes today: `openrouter` and
  `nous-portal`. Grok is in the observational catalog
  (`mode: either`) and is not a supervised long-lived worker.
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
- v1 `kxm routing report` sums missing cost as zero and sorts by run count;
  not a ranking source until the v2 record and separated cost populations
  land (see [routing.md](../docs/contracts/routing.md)).
- Kind-level MOA defaults (target 3, minimum 2, maximum 3, all-settled with
  minimumPassed 2, provider-distinct) are declared as a Phase 7 target in
  lifecycles.md; today loader and compiler resolve omitted bounds to one
  assignment and join `all`. Change schema, loader, compiler, and docs together.

- Other Nous models, automatic auth refresh, exact quota, and extra charges remain unverified after the 2026-09-07 `qwen/qwen3-coder-plus` smokes. Public catalog field names and per-token pricing are observed from an unauthenticated GET.
- Routing v2 unmetered labelling for Nous subscription-proxy usage: included subscription quota consumed and extra billed amount remain unknown unless actually reported.
- Persisted Nous catalog via Pi `publish` is deferred.
- **Claude experiment outcome (2026-09-07):** installed CLI 2.1.261 local mocked Messages streaming and model passthrough, dummy API-key and bearer auth, and unknown-tool rejection passed; no real tools executed. Official Nous implementation provides native Messages only for `anthropic/*`; Qwen is chat/completions, so direct Claude→Nous→Qwen is unsupported by the documented route ([hermes_cli/providers.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/providers.py), observed 2026-09-07). Anthropic via Nous was not live-tested because the authenticated native subscription is preferred. No adapter/translation layer or role admission was built. Mocked env bearer support does not prove OAuth credential interchangeability.

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

Claude (Fable) proposes plan/slice edits. The current writer applies them
(starting rotation: Grok) with the code or docs change that justified the
update. Tests stay the verifier.

## Phase 0: contract package

Deliver this directory, machine-readable schemas, a complete YAML fixture,
contract validation tests, lifecycle tables, effect rules, sync allowlists, and
the migration matrix.

**Gate:** schemas and examples validate; current behavior is clearly separated
from planned behavior.

## Phase 1: project configuration and initialization

Implement restricted YAML loading, project/repository discovery, resource
resolution, templates, three-way reconciliation, and idempotent `kxm init`.
Support create, join, repair, and resume. Legacy JSON conversion was **removed**
by the single-operator decision (see **Decided** below): nothing migrates, older
state is refused.

**Implemented slices:** restricted parsing, exact-schema and semantic bundle
validation, path-derived discovery, deterministic configuration hashing, init
state classification, provenance-tracked atomic creation, rewrite-free
revalidation, explicit join, bounded Runtime-local member-repository binding
persistence, process-death-released mutation locking, resumable pinned create
and repair operations, and exact whole-file three-way template reconciliation.
Automatic repair is limited to conflict-free changes whose conservative
authority projection is unchanged; provenance-free files, overlapping edits,
template deletions, and authority changes remain non-mutating plans. Bounded
legacy JSON conversion was implemented earlier (`kxm migrate plan|apply|verify`
plus `kxm.migration-plan.v1` / `-decision.v1` / `-receipt.v1`) and has since been
**deleted**: this build carries no conversion path, a tree with legacy
`.kxm/config` JSON fails closed with `legacy_state_unsupported`, `kxm init`
reports such a tree as `mode: "legacy"` without writing, and an older stamped
SQLite store is refused with `runtime_schema_outdated` instead of being upgraded.
The permission-diff trust workflow is implemented:
structured field-addressed authority projections per resource kind, a
deterministic `kxm.permission-diff.v1` report classifying every change as
expansion, narrowing, or neutral across conservative lattices (repository
access, network, budgets, quorums, snapshots, secrets) with everything else
fail-closed to expansion, `kxm trust diff|check` against a base Git revision,
and template repair blocking issues enriched with the exact field-level diff.
Database/WAL migration and active-run cutover are **out of scope by decision**,
not deferred work; the Phase 1 gate passes for configuration and initialization.

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
Concurrent first-open schema inspection and initialization are serialized for
the registry and event store; schema compatibility brakes and the gate are unchanged.
Operator bootstrap acceptance of that repair is a developer-process decision;
it does not advance, weaken, or re-satisfy this gate.
Compiled step execution is Phase 3. The outbox is listed in this phase but
not landed; it lands with its only consumer in Phase 8. The gate stays as
written.

**Gate:** `kxm run` creates and recovers a local owned run with the hub absent.

## Phase 3: ordered workflow engine

Implement compiled sequential steps, typed bounded transitions, step attempts,
assignments, physical attempts, join rules, budgets, deterministic gates,
waits, approvals, steering, cancellation, and uncertain-effect handling.

**Compile slice (landed, unreleased):** compiled plan and step model only.

**Run-loop slice (landed, unreleased):** agent-only execution with a simulated
in-process producer, shared project admission, and fail-closed unreconciled
attempts after process restart. No gates, evidence, joins, duration or cost
budget enforcement, or D4 recovery/adoption. The Gate sentence is unchanged *(historical at
this slice; a later entry in this phase fulfils it — see "Fulfills the Phase 3 Gate
sentence")*.
Windows verification of the run loop is deferred with the platform pause.

**D3 S1 (implemented, unreleased):** closed registry loading and gate-only
`expect` compilation, permission projection, and a registry-bearing current
initializer template. Missing registries, unknown gate ids, obsolete options,
old gate outcome spellings, relative executables, and directory-name `argv[0]`
values `.` and `..` refuse. Historical template bytes are unchanged.
*(Historical at this slice; superseded below — the driver runs gates and issue #89 is
**closed** as of 2026-09-20.)* The engine still refuses gates. Issue #89 is open. No execution or evidence
gate is claimed passed.

**D3 S2 (implemented, unreleased):** envelope v2 pins, store v3 gate rows,
gate-only fold rules for intent, spawn, observation, settlement, no-start and
uncertainty, and bidirectional replay on every production read, cancel,
settlement and recovery path. Evaluated settlement applies the same
transition-budget failure as agent settlement and does not drop a committed
complete observation. Closed observation facts and evidence identity/expect
are checked on insert and replay.

**D3 S3 (implemented, unreleased):** artifacts-exist gates run through drive,
step, and scheduler on the admitted token. Paths are pinned portable relatives
under control `.kxm/assets`; every path is checked, and a missing assets root
is a complete failed result. Unsupported declarations and command gates refuse
before intent. Recovery preflight enumerates durable project gate-attempt
history without a row limit, unions orphan-visible issued/revoked
capabilities, fails closed on missing rows, producer/state contradictions, or
identity/pin/replay mismatch, and blocks new command gates when an unowned or
uncertain attempt remains. Owned non-uncertain controllers are ordinary
concurrency. Cross-process revoke keeps a complete observation as proof-only
cancel. S4 command spawn is implemented in this tree (unreleased). D4
recovery was then deferred and the Phase 3 execution/evidence gate was not claimed
passed *(historical at that slice; a later record in this phase fulfils it)*.

**D3 S4 (implemented, unreleased):** command gates spawn POSIX children with
`shell: false` and detached groups, keep the admission hold through
settlement or as `unsettled`, hash complete stdout/stderr streams, and record
actual pid/exit/signal/stop facts. Requested timeout, cancel, recording-error,
and other stop classes remain the uncertainty reason when a later signal is
observed; signal-termination is only an unsolicited external signal. Context
close suppresses late writes for that handle only. Recovery preflight blocks
new command gates on unsettled holds and on a controller without a matching
hold; a full admission slot occupied by an unsettled, mismatched,
unverifiable, or closed-context hold still fails closed as
`run_admission_exceeded`. After committed complete or proof-only terminal
proof, an exact in-process active hold may finish internally so admission
can release; unresolved holds do not. D4 U1 (partial foundation, unreleased)
keeps one assignment and one physical attempt, stores that pair in an
authoritative bound-1 panel (`kxm.run-state.v2`), and looks up owners by
exact attempt id. D4 U2a-1 (unreleased, fold only) defines and tests
panel join-all fold semantics. D4 U2a-2 (implemented, unreleased) dispatches
model-free agent/moa join-all panels with target-bounded births, a
maxParallel window, per-member settlement, one join commit, freeze after
outcome/terminal/cancel intent, fail-closed capability/settlement, exact
pending-owner drain, and minted capability-hash bind through invoke.
No new events or run-state fields. *(Historical slice status; superseded where the driver
  entry under Landed states the Phase 3 gate fulfilled.)* Full D4, remaining joins, approval,
waits, duration/cost budgets, recovery, and the model-free driver remain
open. Roster/routing is not implemented in this slice and does not pass
Phase 4. *(Historical: issue #89 is since **closed**, and a later entry in this phase states
the Gate sentence is fulfilled.)*

**Developer prerequisite (PR #129 merged, #127 closed):** the assignment runner
has native assignment records, fixed witnesses, exact-commit acceptance and
independent Fable/Sol reviews. All five required PR CI jobs passed. Its
parent-alias regression owns the temporary link, preserving argv identity.
Low-level harness recipes remain transport. Authorized Codex relief records
local bootstrap verification and unknown cost; it does not fabricate a native
writer completion. This prerequisite does not satisfy the Phase 3 gate.

**Operator bootstrap acceptance (PR #130):** the single-repair exception requires
bootstrap verification, a candidate-bound fixed-command witness, fresh Fable/Sol
reviews, and final-head CI. It is not native assignment acceptance or hub
approval. The repair changes Phase 2 storage only; this exception does not
satisfy, advance, or weaken the Phase 3 gate, D3 S2–S4, or issue #89.

**Phase 3 engine recovery and model-free driver (implemented, unreleased):** D4
`blocked_uncertain` recovery after S4 command execution (`recoverKxmRun`
supporting `retry`, `fail`, `cancel`, `unblock`), gate hold resolution, and
incomplete attempt exclusion in `gateRecoveryPreflight`. Step admission
expanded for declared workflow kinds (`agent`, `moa`, `approval`, `wait`, `gate`),
`all-settled` join evaluation with `minimumPassed`, `distinctBy: [provider]`,
`maxAttemptsPerAssignment <= 2`, repository write declarations, and evidence
types. The model-free driver in `test/core/driver.test.ts` completes and
recovers `examples/project/.kxm/workflows/default.yaml` (plan → implement → verify → ready → completed;
rework loop; gate uncertainty recovery via retry, fail, cancel) and `fix.yaml`
(all 13 stages; approval pass/rejection rework; two-producer MOA `all-settled` joins;
critics rework back-edge to plan; approval rework back-edge to plan; command gates;
wait signal step) without illegal transitions or evidence reuse. Caller-authored
replies fail closed. Fulfills the Phase 3 Gate sentence. Live Pi execution remains Phase 4.

**Gate:** a model-free test driver completes and recovers
`examples/project/.kxm/workflows/default.yaml` (plan → implement → verify → ready)
and `fix.yaml` (approval, two-producer join, rework) without illegal transitions
or evidence reuse. Joins use driver-simulated identities. Caller-authored
replies are rejected. Out of gate: live models, provider-distinctness,
all-settled degradation. Pi/CLI executions do not satisfy this gate.

## Phase 4: Pi adapter and Pi-native UX

Developer roster U1a/U1b add trusted policy loading, Git replay, live assignment lineup dispatch, and critic acceptance binding. This is developer orchestration policy for the issue 127 runner and does not satisfy the product adapter gate below.

Implement Pi model/auth discovery, supervised RPC sessions, per-run
coordinators, scope epochs, tool presets, model profile/tag resolution, the Pi
status line, `/kxm` menu, settings, and validated agent/workflow/model editors.

**Config slice (landed, unreleased):** harness catalog with Pi as default
headless; `kxm harness list` / `kxm update`; `kxm dash` as the operator peek;
`kxm hub start|view|stop`. YAML remains the only enablement surface.
Extension-registered opt-in Nous providers exist, with live public catalog
normalization into labeled USD/M upper bounds (no Pi `cost.tiers` schedule)
plus provenance on the discovery report; assignment-time provider/model
admission remains Phase 4 work.

**Harness/model assignment validation & Pi probe (implemented, unreleased):**
Unhosted harness/model pair rejection at assignment and exact-context Pi auth probing (`validateHarnessModelPair`, `probeHarnessAssignment`, `probeHarnessesForModel` in `harness.ts`) enforce provider hosting boundaries, reject native-provider Pi impersonation, and probe exact requested provider/model credentials via `pi auth check`.

**Routing records v2 and price catalog (implemented via D5 / issue #91, unreleased):**
`routing.attempt.recorded` events carry `kxm.routing-record.v2` (harness, provider, model, tokens, latency, cost basis, cost USD); missing `costBasis` fails closed at attempt settlement; run plan enforces metered `limits.maxModelCost` cap before dispatch (`budget_model_cost`); dated and hashed price catalog `.kxm/prices.yaml` (`kxm.prices.v1`).

**Still this phase (relabelled 2026-09-20: the Pi RPC adapter and the one-shot
non-Pi adapters below already exist in tree — see Landed; what remains is exact-route
live acceptance and specified UX gaps, not rebuilding them):** per-run sessions, the rest of the `/kxm`
menu (hub/workflows/agents completions wrapping CLI), validated YAML editors
(enable/disable harnesses and models by editing Git files, not a parallel
store), and live assignment dispatch that binds harness from auth inventory
(`eligibleHarnesses` filters detected and authenticated ids only; it does
not take a provider/model pair; `scripts/assignment-run.mjs` is not that
layer). Hub-local session brief and Pi status
line are in tree with a deterministic `startup`/`new`/`fork` readiness test.
The Phase 4 assignment probe supplies the exact requested provider/model
before any Pi readiness claim.

**Gate:** `kxm init` followed by `kxm run default "prompt"` resolves the
materialized `default.yaml` and completes a single-repository Pi workflow with
visible local status (`kxm dash`). `fix.yaml` is not required to run live.

## Phase 5: multi-repository local release

Ship the local Runtime track publicly beside, not on top of, the legacy hub
engine. Explicit `kxm init` receipts activate KXM resources per
project; existing hub runs, `kxm hub …`, and the `kxm_*` tools remain on their current contracts.

Implement worktrees, dirty snapshots, one-writer leases, multi-repository
bindings, default-derived environments, host secret grants, local logs,
repository-aware timing, patches/local commits, and non-atomic delivery
manifests. Per-run worktree isolation from the 2026-09-04 review (D15) lands
here, not in Phase 3.

**B2 note (not the Phase 5 gate):** `release.yml` created a
temporary draft on tag `v0.5.20260905` and the same-digest rerun skipped
without a second asset; mismatch tag failed before install. Cleanup left
published `v0.5.1` and tree `0.5.1` unchanged. `protect-main` `22251971`
now requires `Plugin validation`; `delete_branch_on_merge` is true. First
published `kxm-<v>.tgz` and public npm remain later. Release automation is
paused as of 2026-09-05 (job latch); the Phase 5 gate sentence is unchanged.

**B4 note (not the Phase 5 gate):** package seams and the strict
extension/mcp import boundary landed in tree. The old pack-unchanged
expectation cannot hold: intended library bundles plus source barrels change
the tarball by exactly those six paths versus this slice's base. The Phase 5
gate is unchanged.

**Gate:** the public local release runs a dirty two-repository workflow through
a Runtime crash without a hub or secret leakage. Release assets come from
`release.yml` on a tag, never hand uploaded.

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

## Phase 8: multi-project hub KXM

Begin the hub compatibility release and cutover described in
[Migration](../docs/contracts/migration.md). Implement project/runtime enrollment, immutable
configuration snapshots, run
requests, sync-safe event ingestion, project stores, capability scheduling,
shared-action leases, offline reconciliation, and aggregate TUI read models.
Migrate current schema-v3 hub data behind a compatibility release. The
synchronization contract is schema-tested only today; implementation starts
here.

**Gate:** two Runtimes execute and synchronize independent offline runs but
cannot perform conflicting shared mutable actions without fencing.

## Phase 9: context and reviewed improvement

Implement memory revisions, local bounded replicas, role-aware context,
evidence-linked candidates, protected evaluation, Git patch promotion, and
revision-aware effectiveness statistics.

Design note (2026-09-07): future evidence-linked candidates and effectiveness statistics will be keyed by the workflow and role slugs declared in [`docs/workflow-guide.md`](../docs/workflow-guide.md), not by model alone. Area grouping is navigation; measured quality stays per role, so no global cross-area model ranking is derived. Those slugs are documentation identity, not runtime identifiers, and this note does not assert a working product router.

**Gate:** a candidate is evaluated, reviewed through Git, activated only for a
future run, and measured against its declared outcome. Routing/cost/latency
insights may propose harness or model changes **or** replacing a repeated
agent step with a deterministic gate/script. They cannot raise permissions
and cannot activate without the same Git review path.

## Phase 10: web dashboard

Build project, Runtime, run, configuration, repository, model, timing, cost,
artifact, memory, and improvement views from the same read models and command
APIs as the TUI. Add TLS and RBAC before non-loopback deployment. Per-tenant
hosting ([plan-per-tenant-hosting.md](plan-per-tenant-hosting.md)) is the near-term
route here: tenancy is the machine, Authentik gates the browser at the reverse proxy,
and the hub holds no user accounts or RBAC table. Its **gate already forbids what the
current Studio mutation fallback does** — answering `ok: true, mappedToCli: true`
without executing (`studio-layout.ts:410`) — so hosted Studio may not inherit that path.

**Gate:** every web mutation is audited and reproducible through the command
API; no web-only workflow logic exists.

## Phase 11: harnesses and strong isolation

Add Claude Code, Codex, Grok, AGY (Google), Kimi, DeepSeek, and generic process adapters;
container/OS isolation; persistent outbound remote Runtimes; multi-user RBAC;
and explicit high-availability/takeover fencing.

`kxm harness list` may already show these CLIs. Dispatch is this phase. An
enabled-in-YAML harness without an adapter fails closed at assignment time.
Earlier Claude CLI use is allowed; CLI output is not hub peer evidence.
`scripts/harness-run.mjs` and `scripts/assignment-run.mjs` are not these
adapters.

**Implemented partial slice:** Codex headless argv now explicitly requests
read-only, never-approve execution with user config ignored and exec-policy
rules retained. Product/catalog/helper/native-critic paths have regression
coverage; a native Sol invocation exercised the helper flags successfully.
This does not establish full customization isolation or exact-commit acceptance.
One-shot outcome, usage, cancellation-accounting, and bounded process regressions
now pass alongside isolated native Fable/Grok settlement witnesses.
Slice A1 (async probes, escalation-after-close, conservative descendant
settlement, v2 bounded/redacted evidence, supervisor drive rejection handling)
holds commit-bound acceptance with dual-critic PASS at 915f5e53 and its
forward-port at 96e8e0ac; the live Claude write-refusal witness (model-reached
proof plus refusal) holds acceptance at e3d8a64b; price-catalog integrity
beyond the one-shot path holds acceptance at 17efb783; drive decoupling B1
(engine-owned sessions, bounded truthful shutdown) holds acceptance at
d590d27f. **B2 durable receipts is accepted (2026-09-16, task_9076be56b581 slice B2)
and B3, B4 are accepted (2026-09-16, task_9076be56b581 slices B2/B3/B4; PR #246, landed
2026-09-18, was the later deterministic run-duration-budget test **repair**, not an
acceptance)** — my first correction of this sentence got B3's date and B4's status wrong.
Listing any of them as remaining was the contradiction, not the work. What is genuinely open
in this phase is the isolation/takeover proposals below. **No Phase 11 gate PASS.**

**Proposed M2/M3 delivery packets (2026-09-14):** add incremental native event
decoding, durable stream cursors, exact workspace/session binding, and separately
admitted resume/steer/channel controls through the existing Runtime. Installed
help and Codex schema export establish candidate interfaces only. Pi remains the
only admitted long-lived worker. See the linked unified plan and harness research;
all current lifecycle, permission, evidence and release blockers remain open.
Proposed streaming acceptance covers bounded decoding, redaction before
persistence, reconnect/deduplication, truthful terminal and usage settlement,
and workspace-bound recovery. Live controls would additionally require native
delivery and stale-turn/permission witnesses; queued input cannot be labeled
active steer. These proposed criteria do not mark the existing gate passed.

**Gate:** unsupported capabilities fail explicitly and no adapter weakens the
common result, effect, secret, or recovery contracts. One-shot adapters must
prove bounded termination and truthful failure/usage settlement with deterministic
regressions and isolated authenticated live witnesses; a flag audit alone does
not pass this gate.

## Cross-cutting test gates

**Replaced 2026-09-20 under the operator's "keep pipelines slim" brief.** The list
below used to require that every phase add unit, schema, property/model, forced-crash,
Windows-and-Linux, cross-project security, redaction and coverage-matrix tests, and run
`npm run validate`. This text replaces it, explicitly, rather than satisfying it by
renaming tests.

Run the existing `npm run verify` commit gate and the existing CI jobs (`validate:pr` on
Node 22.19.0 and 24, Docs lint, Classify changes, Plugin validation; `validate:ci` on
main pushes; nightly keeps the coverage floors). Each slice adds at most **one** focused
named test, inside an existing suite, reusing existing coverage and fixtures. No new npm
script, CI job, platform leg, broad test file or coverage ratchet for the hosted MVP.
New live evidence is limited to the selected route and the deployment boundary.
Unselected-platform and broad hardening evidence remains post-MVP and is never implied
PASS. Documentation and migration updates still land in the same change, and generated
artifacts stay reproducible with every existing gate green.
