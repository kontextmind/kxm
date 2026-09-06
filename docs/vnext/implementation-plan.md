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
  **Pi**. Other harness ids (`claude`, `kimi`, `codex`, `gemini`, `deepseek`,
  `grok`, and later others) are declared on the agent. No second enable/disable
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
  and npm/wiki deferrals are unchanged. D3 needs a bounded contract
  resolution after this prerequisite.
- **Role rotation (operator, 2026-09-06):** choose agents per role from
  authenticated, supported helper routes using verified quality, total
  time/cost, and rework. Root may change agents without asking again.
  Starting rotation: writer `grok`/`grok-4.6`, planner and architecture
  critic `claude`/`fable`, CLI critic `codex`/`gpt-5.6-sol`. Grok remains
  the currently admitted native writer route; Codex session work is an
  authorized bootstrap route with unknown root usage/cost, never a forged
  native completion. Do not declare Codex and Grok interchangeable in
  harness-run role mapping. Two attempts by default; a third only with
  concrete new evidence or a changed approach, then relief. Preserve every
  attempt. New-model trials are bounded comparable tasks, not daily
  fanout. This is orchestration policy; `just assign` does not
  automatically schedule failover.
- **Private handoff notes:** when needed, each role leaves concise private
  notes (missing input, friction, what worked, suggested next change,
  artifact/check refs, approaches tried) in private model summaries and
  `attribute` history. Notes never grant tools, waive verification, or
  become human/hub approval. No extra schema fields.
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
- **Hub local is MVP.** `kxm init` is project-only. `kxm hub bind <url>` binds
  this host to a running hub. Session brief, Pi status line, and `/kxm` read
  the local hub snapshot. Local Runtime in-harness insights and SSH/HTTPS hub
  install are after MVP.
- **Platform pause (operator, 2026-09-05):** Windows CI legs, hosted Windows
  probes, and release automation are paused, not deprecated. Active hosted
  verification is two Linux Node 22.19.0 and 24 Validate legs plus Docs lint
  and Plugin validation; Classify changes is the fifth job. Local verification
  is `npm run verify` on macOS. No new paid macOS runner. Windows source and
  tests stay in tree. Windows resumption and release resumption are separate
  deferred choices; each updates Tracking, tests, and settings together.
- **Public npm first.** Do not run wiki compile/lint/ingest for this repo, and
  do not treat `source: npm` as the default updater, until `@kontextmind/kxm`
  is a public npm release. Until then: GitHub release tarballs + docs/Tracking.
  Wiki stays compiled-from-hub (`kxm context wiki-compile`); no ingest CLI.
- **Routing and cost contract** lives in [`docs/vnext/routing.md`](routing.md).
  v1 is shipped parse-only; helper telemetry is a dev tool; v2, event-settle
  write, ranked report, and price catalog are planned. The 2026-09-04
  [work plan](../../.kxm/assets/reviews/2026-09-04-work-plan.md) and
  [decisions](../../.kxm/assets/reviews/2026-09-04-decisions.md) are historical
  inputs and yield to AGENTS.md and this Tracking section where they differ.
  **C1 (2026-09-05) supersession:** docs remainder for #86 is that routing
  contract, synchronization status, and these phase notes. Historical quick
  rename of `default.yaml`, Phase 3a/3b split, adapter-as-MVP, Tracking
  delete/250-line cap, and “no brakes” instructions are **not** pending tasks.
  #86 stays open for later D8/D9/D14 plan text when those phases are
  scheduled, the v1 report underquote fix, and remaining report
  implementation — not for those superseded instructions.

### Landed in this tree (unreleased)

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
- `kxm update --check` / `--kxm`: GitHub release tarball install (current), npm
  source after the public package exists. `auto` only from per-user host-state
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
  2026-09-06 unreleased, not accepted): native auth preflight, verified
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
  Phase 11. Issue 127 M1 transport, M2 reusable test helpers
  (engine/runtime git project setup and harness fake-child/auth/dispatch),
  and corrected M3a exported assignment-manifest validation plus M3b
  exclusive ownership, canonical records, identifiable refusals, bounded
  diagnostics, role verify instruction, observed invocation facts, immutable
  completion/bookkeeping recovery, critic eligibility, separated cost
  populations, and provider-compatible closed native schemas are
  implemented/unreleased, not accepted. R1 remains the ownership/canonical
  checkpoint (public kind, explicit runner codes, path-component ancestry,
  fail-closed lstat/realpath, implementer witness sentence, canonical
  output identity through deepest-existing-ancestor realpath from
  validation through reservation/harness/success binding, including known
  dangling final entries as `output_dir_exists`). R2 is the local
  unreleased repair of B1–B4/C1–C2 observed facts/cost/native schemas,
  including bound observe recovery/idempotency and parent-alias CLI identity.
  This is not M3b acceptance or runner adoption. M4a fixed
  `verify`/`validate-ci` witness execution, before/after candidate
  snapshots, and private receipt history/latest under
  `task_dir/<assignment_id>/witness` are implemented/unreleased, not
  accepted. `witness --record-dir <absolute-path>` requires an existing
  completion, binds stored-manifest identity/cwd/kind/route, the
  canonical `task_dir/<assignment_id>` record path, current or originally
  admitted bootstrap plan, and recovered routing/telemetry bookkeeping
  before any gate execution, and does not rewrite `completion.json` or
  re-run writer admission. Unknown completion candidates stay unknown
  while the witness takes its own snapshots. M4b W1 is implemented locally:
  exact-commit developer acceptance (`accept --task-dir --commit
  --record-dir --critic --critic`) binds the latest passed verify
  receipt, designated Fable/Sol critic PASS records, and the actual
  commit tree, including stored-manifest critic snapshots, writer-bound
  gate cwd, manifest-bound rework, cross-worktree reviews, and
  task-owned BLOCK scans. Structurally bound BLOCK reviews still block
  acceptance when telemetry recording fails; bookkeeping recovery preserves
  their immutable verdict. W2 is implemented locally: `attribute` retains
  private explanations in immutable history with a hash-bound latest pointer;
  `observe-cost` imports source-hashed, explicitly cost-only observations.
  Imports cannot authorize witness or acceptance, duplicate native usage,
  erase failed attempts, or turn estimates/unknowns into spend. Exclusions
  retain their reasons and provenance. Historical attribution does not depend
  on the current plan or a retained worktree. Legacy bootstrap manifests are
  source history, not canonical native assignments that can block imports.
  Attribution history is read by
  directory, so interrupted writes remain visible even without a latest link.
  If a writer dies holding `.observation-lock`, confirm no observation writer
  is active before removing that empty task-local lock directory and retrying.
  W3 is implemented locally: `change-report --task-dir` reports native and
  imported attempts, explicit exclusions, all gate and attribution history,
  separate cost bases, elapsed time and summed durations. Unknowns remain
  unknown; cumulative tokens are not context occupancy; the effort table is
  descriptive, not a ranking. `plan-current` uses expected generation and
  proposed hash checks, preserves prior plan/pointer bytes, and atomically
  advances the pointer. Safe positional just recipes expose the runner.
  M4b is implemented/unreleased; final review and adoption are pending.
  M5 docs/defaults (AGENTS, harness-cli, routing, Tracking, evidence-informed
  recipe effort) are implemented/unreleased in this candidate. Runner
  adoption, scratch-recipe retirement, and native Fable/Sol review smoke
  remain pending; the assignment runner is not adopted. The operator
  authorized agent changes on 2026-09-06; Codex applied the bounded W1
  repair after repeated Grok no-work outcomes. Its local verification is
  recorded as bootstrap evidence, not a native completion or acceptance.
  D3 still waits on bounded contract resolution after this
  prerequisite.
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
  local AST. Family seeds include `vnext-runtime*` plus harness, routing,
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
  validation` runs native `claude plugin validate` on a hosted runner with
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
- **D1 engine compile (pure):** `vnext-engine-compile.ts` compiles a validated
  `kxm.workflow.v1` into a deep-frozen, JSON-serializable plan keyed by step id
  with typed transitions, per-edge and global transition budgets, step
  `maxAttempts`, resolved assignment bounds and join on every step kind (never
  wider than the loader validated; assignment bounds use the loader's formula),
  evidence declarations, oracles, and plan-hash requirements. Both
  `default.yaml` and `fix.yaml` compile. `kind: workflow` is reserved and
  rejected at compile. No execution, no I/O, no events.
- **D2 engine run loop (agent-only, model-free; unreleased):** `vnext-engine.ts`
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
  limits. D3/D4 and the rest of Phase 3 remain open. Issue 127 M1 helper
  transport, M2 reusable test extraction, and corrected M3a
  assignment-manifest validation (`task_dir` authority, read-only Git)
  and corrected M3b exclusive ownership/canonical records/refusals/diagnostics
  (including parent-alias output identity via deepest-existing-ancestor
  realpath) plus R2 observed facts/cost/native schemas, bound observe
  recovery/idempotency, and parent-alias CLI identity are unreleased setup
  prerequisites for later assignment work; they do not complete Phase 3,
  adopt the runner, or retire scratch runners. Corrected M3b is a local
  unreleased implementation, not accepted. M4a fixed-witness execution
  and stored-manifest/plan/recording binding are implemented/unreleased,
  not accepted. M4b W1 accept is implemented locally (critic snapshot, gate
  cwd, stored rework, cross-worktree, and task-bound BLOCK checks);
  W2/W3 observations, reporting, plan history and recipes are implemented
  locally; M5 docs/defaults are implemented/unreleased; adoption and D3
  contract resolution remain pending.
  Issue #88 / D2 closed on all seven PR CI jobs (four Validate legs plus
  classify/docs/plugin) before the pause; the post-merge main Windows Node 24
  package-cleanup failure in run `34006194862` is unresolved and deferred.

### Still open

- **Windows resumption (deferred):** restore the two Windows Validate legs and
  their ruleset contexts, and diagnose the Node 24 package cleanup failure, in
  a reviewed change that updates Tracking, tests, and settings together. D3
  platform-specific success remains unverified and deferred. Issue #127 setup
  stays active on Linux and local Mac.
- **Release resumption (deferred):** remove the `release` job latch and
  re-enable the Release workflow in a reviewed change that updates Tracking,
  tests, and settings together. Independent of Windows resumption.
- First real draft-to-published release after B2 (later release phase).
  `kxm update --kxm` end to end from a published asset. Temporary draft proof
  does not replace this. No sidecar `.sha256`.
- **After public npm:** wiki-compile this project from hub context; npm as
  `kxm update` source. Not before.
- Coverage only lists modules some test loaded; a future source file with zero
  imports from tests will not drag the number down. A test that imports every
  non-excluded module belongs before the next ratchet raise, not as a B1 add.
- **Issue #115 (open):** unrelated SQLite race. No speculative fix in this
  slice.
- Docs sweep: operator pages updated to `kxm hub start|view|stop` and `kxm dash`;
  CHANGELOG history may still mention old names.
- Remaining Mesh-named internals (`MeshHub`, `createMeshHub`, `MeshStore`,
  `MeshTui*`, `LocalMeshSnapshot`, `piMeshExtension`, `pi-mesh.*` schema ids,
  `pi_mesh_*` metrics, `X-Mesh-Delivery-ID`) rename together at the E3
  wire/schema bump, not piecemeal.
- Slim live `default` workflow for this repo (no bulk migrate of jira/provenance/v04).
- YAML-editing enable/disable UI (Phase 4 `/kxm` settings or `kxm dash` config
  tab). Do not add a preferences overlay.
- **Issue 127 remainder:** M1 helper transport, M2 reusable test
  extraction, corrected M3a exported assignment-manifest validation
  (`task_dir` authority, read-only Git comparisons), and corrected M3b
  (R1 exclusive ownership/canonical records/identifiable refusals/bounded
  diagnostics plus R2 observed facts/cost/native schemas, bound observe
  recovery/idempotency, and parent-alias CLI identity) are
  implemented/unreleased (platform pause already in tree); they are not
  accepted completion. R1 remains the ownership checkpoint, including
  canonical output identity from validation through reservation and
  dangling final entries as `output_dir_exists`. R2 is the local
  unreleased facts/cost/schema/recovery repair. Full M3b acceptance remains
  pending. M4a fixed `verify`/`validate-ci` gates, candidate-bound
  receipts, stored-manifest identity/plan/recording binding before
  execution, and `witness --record-dir` are implemented/unreleased, not
  accepted; root writes this assignment's receipt after native exit.
  M4b W1 accept is implemented locally with bindings for critic snapshot,
  gate cwd, rework, worktree and BLOCK ownership; final acceptance is pending.
  W2/W3 attribution, observations, reporting, plan history and recipes are
  implemented/unreleased. M5 docs/defaults are implemented/unreleased;
  runner adoption and scratch-recipe retirement still need native writer
  plus Fable/Sol review smoke. D3 still needs bounded
  contract resolution after this prerequisite. Not a product assignment
  layer (Phase 4) and not Phase 11 adapters. The assignment runner is
  not adopted.
- Phase 3 engine remainder (D3 gate execution, `expect`, attempt-bound
  evidence; D4 joins, approval, waits, duration and cost budgets,
  `blocked_uncertain` recovery, producer drain, and the full driver gate on
  `default.yaml` and `fix.yaml`). Compile and the agent-only run loop do not
  close Phase 3. D3 and D4 must honor a declared `assignments` or `join` on
  gate, approval, and wait steps or fail closed; D1 only preserves the
  declaration. Issue 127 M1 transport, M2 reusable tests, corrected M3a
  validation, and corrected M3b remain unreleased and not accepted;
  M4a is implemented/unreleased and not accepted; M4b W1 accept is
  implemented locally with stored-manifest critic/receipt/BLOCK bindings;
  W2/W3 are implemented/unreleased; M5 docs/defaults are
  implemented/unreleased; runner adoption and D3 contract resolution remain
  open. This is not full AGENTS workflow
  adoption and not a scratch-retirement claim.
- Version-1 run event stores are refused with `runtime_schema_outdated`;
  backup, restore, and migration remain E6.
- Non-Pi dispatch adapters (Phase 11). Listing a harness does not execute it.
  The `scripts/harness-run.mjs` dev helper is not that adapter.
- **Issue 84 remainder:** Kimi read-only auth-status probe: no non-mutating
  CLI status command found. Managed provider status requires the server API,
  which this slice does not start. Deferred, named probe. Verify-before-ready
  execution enforcement is a Phase 3 engine gate, not this auth/inventory
  slice. Unhosted harness/model pair rejection lands in the Phase 4 assignment
  layer (and Phase 11 adapters). Do not treat B3 as blanket-complete.
- No `types` export condition until declaration emit exists.
- MCP factory API waits for a second consumer (D13); `./mcp` stays an
  executable path.
- Helper allowlists in `scripts/harness-run.mjs` are script constants, not a
  preferences overlay or catalog feed. Grok is in the observational catalog
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
  land (see [routing.md](routing.md)).
- Kind-level MOA defaults (target 3, minimum 2, maximum 3, all-settled with
  minimumPassed 2, provider-distinct) are declared as a Phase 7 target in
  lifecycles.md; today loader and compiler resolve omitted bounds to one
  assignment and join `all`. Change schema, loader, compiler, and docs together.

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
budget enforcement, or D4 recovery/adoption. The Gate sentence is unchanged.
Windows verification of the run loop is deferred with the platform pause.

**Issue 127 M1+M2+M3+M4a (unreleased, not this gate, not accepted):** helper
transport result v2, supported launch flags, honest termination facts,
stdio drain vs bounded linger (`stdio_incomplete` / `unknown_exit` are
not `completed`), type-closed public usage/cost, malformed
text and post-spawn write failures with retained spend, bounded timeout
settle, and closed public metadata; plus extracted test helpers for
committed vNext git projects and harness fake-child/auth/dispatch; plus
corrected exported closed `kxm.assignment.v1` validation bound to
manifest `task_dir`, with read-only Git comparisons and no spawn,
output-dir creation, ID reservation, dispatch record, `.git` write, or
worktree mutation on the validation export; plus corrected M3b role
templates, canonical `task_dir/<assignment_id>` records, exclusive
non-recursive identity and final-output mkdir, identifiable refusals,
bounded `runner-errors.jsonl`, implementer verify instruction, observed
invocation/candidate/recording facts, telemetry observe recovery, critic
eligibility, separated cost populations, and closed native output
schemas, bound observe recovery/idempotency, and argv path identity so a
`/tmp` parent alias still runs `main`. Corrected M3b is local/unreleased,
not accepted; parent-alias output identity uses the existing
deepest-existing-ancestor comparison rather than a second resolver, and a
known dangling final output entry is `output_dir_exists`. M4a adds
fixed `verify`→`[npm,run,verify]` and `validate-ci`→`[npm,run,validate:ci]`
execution (`shell:false`), before/after `write-tree` snapshots, and
immutable private receipts plus a latest pointer under the assignment
record directory. Witness-time binding compares stored-manifest
identity, cwd, kind/route, canonical record path, and plan against the
completion and current pointer, and requires routing/telemetry to be
recorded or hash-bound recovered, before any npm execution. It does
not re-run pre-dispatch writer admission; completion candidate
`unknown` stays unknown. M3b acceptance and M4b (W1 accept implemented locally
with critic/receipt/rework/worktree/BLOCK binding repair; W2/W3 implemented
locally) remain unaccepted. M5 docs/defaults are implemented/unreleased;
adoption and D3 remain pending. Not a Phase 3 completion or
scratch-runner retirement.
The assignment runner is not adopted. Native writer witnesses follow native
exit. Operator-authorized Codex work uses recorded local bootstrap verification
until final adoption; it does not fabricate a native completion.

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

**Still this phase:** Pi RPC adapter, per-run sessions, the rest of the `/kxm`
menu (hub/workflows/agents completions wrapping CLI), validated YAML editors
(enable/disable harnesses and models by editing Git files, not a parallel
store), live assignment dispatch that binds harness from auth inventory
(`eligibleHarnesses` filters detected and authenticated ids only; it does
not take a provider/model pair; `scripts/assignment-run.mjs` is not that
layer), unhosted harness/model pair rejection at
assignment (separate from that auth filter), and routing
records that always include harness+cost. Hub-local session brief and Pi status
line are in tree with a deterministic `startup`/`new`/`fork` readiness test.
The Phase 4 assignment probe supplies the exact requested provider/model
before any Pi readiness claim.

**Gate:** `kxm init` followed by `kxm run default "prompt"` resolves the
materialized `default.yaml` and completes a single-repository Pi workflow with
visible local status (`kxm dash`). `fix.yaml` is not required to run live.

## Phase 5: multi-repository local release

Ship the local Runtime track publicly beside, not on top of, the legacy hub
engine. Explicit `kxm init`/migration receipts activate vNext resources per
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

## Phase 8: multi-project hub vNext

Begin the hub compatibility release and cutover described in
[Migration](migration.md). Implement project/runtime enrollment, immutable
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
`scripts/harness-run.mjs` and `scripts/assignment-run.mjs` are not these
adapters.

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
- every source file is inside the coverage include unless excluded with a
  reason (B1). Coverage still only measures modules some test loaded.

Generated package artifacts remain reproducible and the existing `npm run
validate` gate remains green throughout migration.
