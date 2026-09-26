# Changelog

All notable user-facing changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **`kxm land` verifies, regenerates docs, and squash-merges the current branch.**
  The stages are `verify`, `docs`, `push`, `pr`, `rebase`, `unblock`, `merge`,
  `release`, and `milestone`. `npm run verify` is the first stage and is not
  replaced. Rebase resolves only the dist rebuild, the CHANGELOG Unreleased
  union, and the tracker "Landed in this tree" union, for at most five rounds.
  A required review is reported. The `land` workflow in `.kxm/workflows/land.yaml`
  runs the same gates and may be refused until gate-only workflows are supported.
  See the [CLI reference](docs/reference/cli-reference.md#kxm-land).
- **`kxm assign` is the entry to the developer assignment runner.**
  `run`, `witness`, `plan-current`, `attribute`, `observe-cost`, `accept` and
  `change-report` spawn `scripts/assignment-run.mjs` with the same flags as the
  just recipes. The runner still performs every check and writes every file.
  The just recipes stay until one real unit has been accepted through
  `kxm assign`. See the
  [CLI reference](docs/reference/cli-reference.md#kxm-assign).

- **`kxm lane` keeps one git worktree per unit beside the control checkout.**
  `create`, `list`, `status`, `drop` and `run` store a 0600 record in
  `.kxm/state/lanes.json` keyed by the resolved base sha, and `drop` never
  deletes the branch. `kxm run --brief <file>` and `--lane <unit>` start that
  work, and `--lane` is also accepted by `kxm runs status`, `drive`, `receipt`
  and `cancel`. The `just worktree` and `just worktree-drop` recipes now call
  those verbs. The refusals a user can see are `lane_exists`, `lane_missing`,
  `lane_base_unresolved`, `lane_dirty`, `lane_run_open`, `brief_unreadable` and
  `brief_and_prompt`. A live writer step through `kxm lane run` is still
  bounded by the Runtime's 120 second one-shot timeout until the configurable
  limit lands. See the
  [CLI reference](docs/reference/cli-reference.md#kxm-lane).

- **The tailnet docs site is built and served with `kxm docs build` and `kxm docs serve`.**
  `kxm docs build` runs `node plans/kxm-roadmap/update-dashboard.mjs` from the
  project root and returns its exit code. `kxm docs serve` runs
  `python3 ops/docs-site/serve.py`, streams its output, and passes `--port`
  through when it is set. Both refuse `project_required` outside a KXM project,
  and `docs_generator_missing` or `docs_server_missing` when the file is absent.
  `--dry-run` prints the command and starts nothing. The header wordmark is the
  portal mark, and the slate palette uses `#0e0d0b`, `#3068da`, and `#f2eee7`.
  `kxm docs build` validates the roadmap state file and refuses when it does not match the schema.
  See the [CLI reference](docs/reference/cli-reference.md#kxm-docs).

- **Claude-only workflow recommendations now fail honestly when execution is unavailable.**
  `suggest` honors explicit harness constraints, uses flat installable IDs and verified
  capability-appropriate routes, refuses unchecked existing definitions, and never substitutes a
  different writer. `workflow add` validates IDs and runner-compatible YAML before
  writing; picked/imported dry runs leave configuration untouched. `gate validate
  --file` accepts local YAML without changing webhook environment-source validation.
  Run output distinguishes creation from execution and names live prerequisites and
  `runs drive/status/receipt`; incompatible `task run` requests leave tasks unchanged.
  Harness inventory reflects the project default, and initialization explains the
  generic Pi/npm starter settings. Claude's one-shot profile remains read-only; Pi/Grok
  writer recommendations require audited writer admission. See the [CLI reference](docs/reference/cli-reference.md#kxm-suggest).

- **`kxm workflow add --template <name>` writes a valid first workflow.**
  `implement-and-verify` (the `implementer` agent, then the project's `test` gate; a
  failing gate sends the work back to `implement` at most twice), `dual-critic-review` (two
  review steps run as the `coordinator` agent between them) and `spec-and-plan` (plan, then
  review the plan, both as `coordinator`, read-only) are written under the workflow id you
  give. Each uses only what `kxm init` creates, the `coordinator` and `implementer` agents,
  the `control` repository and the `test` gate, so it loads and plans as generated.
  `--template` needs a workflow id (`workflow_id_required`), cannot be combined with
  `--file` or `--pick` (`workflow_add_conflict`), and names the three templates when the
  name is unknown (`workflow_template_unknown`); the three refusals exit 2 and honour
  `--json`.

- **Fenced hub leases, and shared external effects that will not run without one.**
  `POST /v1/leases/:resource/acquire|renew|release` are agent-authenticated and
  project-scoped (the hub prefixes the caller's project onto the resource name). Each call
  is a compare-and-set inside one store transaction on the **hub clock**, with TTLs bounded
  to 5 s–10 min. The fencing token starts at 1, survives renewal unchanged, and increments
  only when a new holder takes over an expired lease, so a holder that returns after its
  deadline is told its token was superseded instead of writing behind its replacement.
  Shared external effects (`git-push` to a ref the run does not own, `pr-create`,
  `tracker-issue`, `webhook`) acquire a lease keyed by `targetRef` before executing, record
  `{leaseResource, fencingToken}` in the receipt, renew on the existing Q6 heartbeat, and
  re-present the token at commit; a superseded token leaves the effect `in-flight` and the
  attempt `blocked_uncertain` with nothing retrying. An unreachable hub refuses the effect
  (`effect_lease_unavailable`) rather than executing it unfenced. Unique-namespace kinds
  (`git-branch`, `git-commit`, and a push to the run's own branch) stay lease-free.

- **`kxm peer send --allow-offline` queues to a registered offline peer.**
  `POST /v1/messages` accepts `allowOffline: true` (also `kxm_send.allowOffline`): a
  registered agent in the same project is stored `queued` instead of `target_not_found`,
  real-time `publish` is skipped, and the existing reconnect cursor delivers the message
  once on resumption. Unknown names still fail closed. TTL expiry is unchanged; queued
  messages are not evidence unless `workflowContext` was hub-authorized at send.

- **Per-tenant hosting operations, and a backup that covers the whole state set.**
  `docs/operations.md` gained a *Per-tenant hosted deployment* section (one tenant = one box
  = one hub; loopback-only hub and supervisor; the tenant's proxy owns TLS and the browser
  session; a reverse-proxy contract states what must hold without shipping generated proxy
  config) and a rewritten *Backup and restore* that enumerates tenant state **by root**,
  because the roots are not interchangeable and two of them are easy to mistake for one:
  `$R` the fixed checkout `.kxm` tree (project, model, role, route, price and provenance
  definition, environment, goals, tasks, memory, improvement candidates, skills — none of
  which follow any workspace override); `$D` the workspace directories (config, logs,
  assets, state — moved by `--workspace`/`KXM_WORKSPACE_DIR`, each individually
  overridable, and `--workspace` ignores those overrides); `$W` the workspace state
  directory (hub database, worker routing and recovery manifests, Pi sessions); `$S`
  host-local machine state (`KXM_STATE_HOME`, absolute or rejected: Runtime `registry.db`
  holding the supervisor claim as a registry row, per-project `run-events.db` **and its
  full-filename `.run-prompts.json` sidecar**, repository bindings, `update.yaml`, hub
  binding and credential records); `$C` user configuration; and `$T` federated telemetry,
  resolved independently of `$C` and written by an exporter that currently has no
  production caller. It separates recovery-critical manifests from Pi model histories whose
  backup is an existing policy **choice**, marks what is disposable (PID and claim files,
  `session-brief.json`, the re-generable supervisor token), applies WAL consistency to
  every SQLite store, records each override as part of the backup, and notes that a bound
  member repository's own `.kxm/repo/` files live on that member's filesystem — so copying
  the binding JSON alone is not a restore path for an external member. The previous recipe
  stopped the hub and copied `kxm.db`, which is a hub-only backup: a restore can pass every
  hub check and still lose run history, the prompts that explain it, the project definition,
  and the bindings that make the box reproducible.

### Changed

- **Usage errors under `--json` print a `usage_error` envelope and exit 2.**
  A missing required option, unknown command, or other Commander usage error
  writes `kxm.cli-result.v1` to stdout with `command`, `error`, and `detail`.
  Text mode still prints the Commander line on stderr.

- **Windows Validate legs run again on GitHub-hosted `windows-latest`.** The PR gate
  still requires only `Validate (linux, Node 22.19.0)` and `Validate (linux, Node 24)`
  on ARC `kontextmind-doks`. Windows Node 22.19.0 and 24 report `validate:pr` but are
  not protect-main required checks. Nightly complete coverage and release stay on
  Linux. See [CI and release](docs/contributing/ci-and-release.md).

- **The rotation surface drive uses is the one setup writes.** Guide setup appends only
  reviewed selectors to `.kxm/routes.yaml`. It skips Google guide candidates: Google's
  route is the Pi `antigravity` provider, which a Runtime drive cannot reach yet, so a
  Google role falls to its next reviewed candidate or is not written.

- **CLI and Studio stop reporting work they did not do.** Drive help no longer
  describes the default as a model-free simulation. A Studio mutation with no handler returns 501 and `mappedToCli: false`.

- **Missing cost stays unknown.** `kxm prices acknowledge` restamps the local catalog
  as today without fetching vendor rates, which is what an estimate will accept.
  Routing totals are null when any attempt has no cost, and those rows sort after
  complete-cost rows. `kxm improve` stays proposal-only. Wiki compile writes a file
  only with `--out` and does not ingest.

- **The workflow loader refuses a gate step that can never settle
  (`gate_outcome_impossible`).** A gate step settles only on `passed` or
  `implementation-failure` when `expect` is `pass`, and only on `passed` or `repro-missing`
  when `expect` is `fail`. A step that declares an outcome it never produces (typically
  `failed`) and leaves one it does produce undeclared is now a load error naming the
  outcomes to declare, so `kxm init`, `kxm run` and `kxm run --dry-run` report it before a
  run exists. Such a workflow used to load, and a failing gate attempt could not settle:
  the run was handed off with `attempt_unsettled` and later gate steps in the project were
  held with `gate_recovery_pending`. An extra outcome next to every produced one still
  loads, as in the `verify` step `kxm init` writes. This repository's `default` workflow,
  the example project and the unsupported-gate fixture now route gate failures on
  `implementation-failure`. **Check your workflows:** a gate step that routes failures only
  on `failed` no longer loads.
- **`kxm run` prints how to drive the run it created, and drive refusals say why.** The
  text output's second line is
  `drive it model-free: kxm runs drive <runId> --simulated --wait (or cancel: kxm runs cancel <runId>)`,
  and the command's help now reads "Create a KXM run (offline-first;
  `kxm runs drive <runId> --simulated` executes it model-free)" instead of saying no steps
  execute until the run engine lands. The JSON result and its
  `phase` are unchanged. A `run_handoff_required` refusal from `kxm runs drive` now ends
  with `(handoff reason …; field …; detail …)`, each part capped at 200 characters; a run of
  a workflow that declares `limits.maxAgentTimeMs`, for example, reports `limit_unsupported`
  on that field. Top-level help names the product KXM instead of KontextMind,
  and `kxm init` text output lists each validation issue as `file: code: message`.
- **`kxm suggest` recommends only KXM command skills.** Suggested skills come from the
  command skills shipped in `plugins/kxm/skills` (such as `kxm-workflow`, `kxm-runs`,
  `kxm-peer` and `kxm-context-memory`), never from skills that do not ship
  (`troubleshooting`, `modern-web-guidance`) or from the KontextMind knowledge-plane
  skills.
- **The Claude plugin's MCP errors name the user's next step, and a session appears to
  peers before its first tool call.** An unreachable hub names the URL and `kxm hub start`
  or `/plugin configure kxm@kxm`; `invalid_auth` names the project token; a
  `session_token_invalid` denial says to unset or replace `KXM_SESSION_TOKEN` when the token
  came from the environment, or to run `kxm session token --clear` when it came from the
  token file. Denials still fail closed. A second concurrent session whose agent name is
  already active registers once as `<name>-<pid>` and says so on stderr. In a KXM project
  with a project token and a session policy that allows `kxm_inbox` and `kxm_reply`, the
  server registers right after the MCP handshake instead of at the first tool call, and it
  leaves the hub when stdin closes. The server instructions point Claude at `kxm_context`
  and at telling the user the next step, in under 800 characters.
- **The Claude plugin README is rewritten, and its tool table is pinned to the MCP
  server.** It covers requirements (`node` on `PATH`, a hub, and the `kxm` CLI for the
  operator only), installing from Claude Code or the shell, each `userConfig` option and
  which token to use (this project's token, never the hub admin token), what the MCP server
  and the SessionStart hook do, every published MCP tool, pushed channel mode versus pull
  mode, the 0.7.1 version pin with the uninstall-and-reinstall refresh (plugin options must
  be entered again), and troubleshooting for each user-directed error. A test fails when
  the README's `## MCP tools` rows and the server's `tools/list` disagree in either
  direction. The configuration docs now say that `kxm_await` waits at most 60 seconds.
- **The skill suite is rescoped: every command has one owning skill, and `kxm-setup` is
  renamed `kxm-mind-setup` with no alias.** `skill-suite.json` declares all 29 bundled
  skills (13 KXM command skills, 7 browser skills, 9 KontextMind knowledge-plane skills),
  and each of the 34 registered top-level `kxm` commands is owned by exactly one of them
  (`models`, `routes` and `ssh` by `kxm-harness-auth`, `tenant` by `kxm-hub-ops`, `explain`
  by `kxm-context-memory`). The nine knowledge-plane skills are kept; their descriptions now
  start by saying they cover only the separate `kontext` CLI and `km_` tools, so they
  trigger only when the user names KontextMind. The command skills were rewritten against
  the current CLI help and drop stale claims (the run engine "not landed", port 8787,
  `gate validate` on YAML, `fanout --idempotency-key`). `kxm-project-setup` now walks from
  `kxm init` through a trust-reviewed first workflow to a simulated, receipt-verified run,
  stopping where the user reviews and commits `.kxm` changes, and `kxm session brief`
  (which saves a 24-hour operator token) appears only under its operator steps. **Rename:**
  anything that names the `kxm-setup` skill must name `kxm-mind-setup`.
- **Context packets rank by deterministic task relevance.** `kxm context get`,
  `kxm_context` and Runtime dispatch order eligible items by nine keys: open
  contradictions first, project before `_shared` defaults, items that share a word with
  the task before items that do not, role kind priority, a lexical BM25 score over the
  item's summary and state key, confidence, authority, recency (newest first), then id.
  Scoring uses a fixed English stopword list and no model, clock or randomness, so the
  same records and request give the same packet. Contradiction and project-first order
  are unchanged. The token budget is filled first-fit, so one oversized item no longer
  stops smaller ones from fitting, and non-current state and proposed skills no longer
  consume budget. `audit.relevance` reports numbers only (`taskTokens`,
  `matchedCandidates`, and a rounded score per selected item).
- **`kxm_improvement_report` returns ranked, redacted cross-run signals.** Alongside the
  per-area reports, `GET /v1/improvements` returns `signals`: journal entries from the
  project's runs merged by evidence class, then an error's stage, then a normalized
  summary that is redacted before it becomes a key. Only errors, open contradictions,
  lessons and still-proposed skill candidates count. Priority is distinct runs × severity
  (3/2/1) × mean run attempts × evidence confidence; an unknown run cost counts as 1 and
  is labelled `unknown`, never 0; security signals rank first. The journal and
  retrospective loop covers hub webhook runs only; `kxm run` (Runtime) runs have no
  journal yet.
- **Recall ranks exact phrases, then token relevance, then id, and returns a relevance
  per item.** `kxm context recall` and `kxm_recall` previously returned substring matches
  in id order. Items that neither contain the query nor share a word with it are still
  left out, and results still carry metadata only, never summaries.
- **The hub logs task and query sizes, not their text.** `context_packet_assembled` now
  records `taskChars`, `taskTokens` and `matchedCandidates`, and `context_recall` records
  `queryChars` and `queryTokens`. The caller still receives its own request in the
  response.
- **Engine routing records carry an ask identity and only gate-negative outcomes.** Every
  `routing.attempt.recorded` record carries four engine-reserved `providerMetadata` keys,
  written after the producer's so a producer cannot spoof them: `workflowId`, `askSha256`
  (the same for one step and agent across runs, whatever the run was asked to do),
  `objectiveSha256` (the run prompt's digest) and `stepWrites`. A producer keeps up to 28
  keys of its own. `agentRole` defaults to the dispatched agent. `finalOutcome` is written
  only as `blocked` (a back edge) or `failed` (a producer error, an undeclared outcome or a
  failing terminal); acceptance is resolved later from the event log. Records written
  before this change are not backfilled.
- **`improvement.promotionPolicy` reports review readiness and never authorizes.**
  `kxm improve` now reads `improvement.*` and reports, per candidate, `readyForReview` and a
  reason under the configured policy: `manual_pr` is always ready for an operator PR,
  `critic_quorum` waits for two critic receipts (the CLI supplies none, so it reports not
  ready), and `auto_threshold` needs `minRuns` distinct runs, `minPassRate`, and a mean
  recorded cost of at least `minCostSavings` over at least one cost sample. Every policy
  ends at an operator PR; the old `authorized` result is gone. Values fail closed field by
  field: an unknown policy is `manual_pr`, a half-life outside (0, 3650] days is 14, and
  out-of-range thresholds fall back to 10, 0.95 and 0.5.
  `improvement.telemetryHalfLifeDays` orders report rows through `weightedRecurrence` and
  never decides candidacy.
- **`kxm routing report` reads Runtime records by default and counts only event-log
  acceptance as a Runtime pass.** Without `--file` it reads the current project's Runtime
  event store and then `.kxm/logs/telemetry.jsonl` (the same sources as `kxm improve`),
  and `--json` output gains `sources`. A Runtime attempt counts as a pass only when its run
  completed and the step was not re-entered. The ranking code is unchanged, and the rework
  column still reads `transitions`, which Runtime records do not set.
- **`kxm improve --target` is removed.** It was accepted and never applied. Passing it
  is now an unknown-option error. `KXM_IMPROVE_TARGET` still labels telemetry when it is
  written; no report reads that label.

- **Hub store schema v3 → v4, external-effects ledger v1 → v2.** The hub store gains a
  `leases` table and the ledger gains `lease_resource`/`fencing_token` columns. Neither has
  a migration lane: an older file is refused at open with `runtime_schema_outdated`, and the
  hub backup/restore ceiling in `database.ts` moves to 4 with the bump, so a v3 backup must
  be restored with the release that produced it. Delete the state file to start fresh and
  let `kxm hub start` recreate it.

- **`kxm tenant status`: one composed read for the portal, with the authorities labelled.**
  The portal needs hub metadata (roster, message queue, the hub's run projection) *and* the
  Runtime's authoritative run state, and the failure mode S2 exists to prevent is rendering
  one as the other. The new command reads both and labels every value with its source
  (`hub-projection` vs `runtime-authoritative`); an unreadable upstream becomes
  `unavailable` with a stable reason instead of being filled from the surviving source;
  projection/authoritative disagreements are listed as `discrepancies` rather than averaged;
  and `degraded` marks a partial read so `ok: true` never means "everything was seen". The
  hub read resolves the **admin** credential only — a project token would 401 on the snapshot route —
  and a malformed persisted record degrades that one source as `hub_credential_unreadable` rather than
  aborting the Runtime read with it. Reads run concurrently with a 5 s hub deadline, a 200 with an
  unusable body is `hub_response_invalid` rather than a healthy empty snapshot, and Runtime rows are
  event-log folded (the listing endpoint now folds, so a cached row can no longer be presented as
  state). A run whose fold refuses is labelled `runtime-cached` — the cache, not state — and is
  excluded from the cross-check, which reports `unverifiedFoldRuns` (or `runtime_fold_failed`)
  instead of letting a corrupt event log print "agree"; `kxm runs list` names the same failure on
  the row instead of hiding it. The cross-check is honest about id spaces: hub runs and Runtime
  runs mint ids independently, so zero shared ids reports `unverified` (`run_identity_link_absent`)
  — never agreement — and only cleanly folded shared ids are compared. The Runtime read **attaches** to a live supervisor
  (`attachKxmSupervisor`, new) and never starts one — a portal poller must not conjure a daemon, and
  "nothing is running" is an answer to render, not a condition to repair. Exits non-zero only when
  neither source could be read.

- **A Pi producer reply can no longer mint its own success.** `determineOutcome` scanned the
  reply for any declared outcome *word* and, failing that, returned `passed`. So
  `"the gate did not pass, so I would not call this passed"` settled the step as passed — the
  word was all it took — and an empty or prose-only reply was passed by default. Only a declared
  result counts now: a reply that is one JSON object, or prose carrying an explicit
  `{"outcome": "…"}` block, and only when the step declares that outcome. Anything else is
  `failed`; an undeclared value still lands in `outcome_unknown` and terminates as `failed`, so a
  step without a `failed` transition cannot pass on a bad reply either. This matches the rule the
  one-shot producer already enforced, and `docs/contracts/lifecycles.md` now states it where
  `result_recorded` is defined. Three usage-capture fixtures that had been replying in prose now
  declare their result, which is what they were always supposed to do; the new test in
  `test/core/pi-producer.test.ts` covers prose, empty, out-of-vocabulary, and both accepted
  structured shapes. Review of that first cut found two more ways to mint success, both now
  closed: a result block was matched **anywhere** in the reply, so
  `Example: {"outcome": "passed"}. Actual result: {"outcome": "failed"}` returned `passed`;
  a declaration is now a standalone JSON object — the whole reply, or one object on its own
  line, with the **last** such object winning so an illustration cannot outrank the answer, and
  the whole reply settling `failed` when anything after that line still looks like an outcome
  key, because at that point the producer cannot tell which declaration was meant.
  And cancellation fell through to `allowedOutcomes[0]` when a step declared neither
  `cancelled` nor `failed`, so aborting a `passed`-only step reported `passed`; a cancel now
  reports `cancelled` unconditionally and the engine terminates it `failed` when the step
  does not declare that outcome.

- **`kxm migrate` is gone, and so is the state that only it could unlock.** Deleting the
  migration lanes left a converter with nothing to convert into: `plugins/kxm/src/migrate.ts`
  (1,848 lines), its 1,598-line suite, the `migrate plan|apply|verify` commands, the
  `kxm.migration-plan.v1` / `-decision.v1` / `-receipt.v1` schemas and their registry
  validators, the receipt reader / self-hash / byte-record helpers, and the
  `.kxm/migration-receipt.yaml` path are all removed. A tree that still holds legacy
  `.kxm/config` JSON now fails closed at load with `legacy_state_unsupported`, one issue per
  legacy file, and no receipt, plan, or option unlocks it — previously a verified receipt made
  a mixed tree loadable, which is exactly the dual-read surface this decision retires.
  `kxm init` classifies such a tree as `mode: "legacy"` (was `"migrate"`), reports
  `legacyInputs`, and writes nothing. `docs/contracts/migration.md` is rewritten as a
  supported/refused matrix instead of a conversion spec, and the packed-install suite now
  builds its trust and run-lifecycle fixture by initialising a project directly, so that
  coverage survived rather than being deleted with the command. A new test asserts
  `kxm migrate` is rejected as an unknown command: a retired verb must fail loudly, not
  resolve to nothing.

- **No schema migration lanes, no legacy stamp tolerance (single-operator tool).** Stepwise
  schema migration lanes are removed from the hub store and the per-project event store, and
  the external-effects store no longer runs an in-place `ALTER TABLE ... ADD COLUMN` whose
  failure it swallowed (that column is declared in the fresh schema, so the lane could only
  ever fire on an older store; the store has no production caller yet, so this closes the
  lane rather than fixing a live upgrade).
  A database stamped behind this build now fails closed with `runtime_schema_outdated` and
  a message naming the process that recreates the store (`kxm hub start` for hub state, the Runtime for registry/event stores; `kxm init` is project-only) — and the refusal never
  advances `user_version`, so the store stays identifiably old (WAL sidecars may still be
  checkpointed by opening the file, so the whole state set remains the backup unit — see
  [`docs/operations.md`](docs/operations/deploy.md)). Relabelling a store it refused to open would
  only hide the problem until a query hit a missing column. The coordinator fingerprint no
  longer recomputes over stored authority to forgive rows written before set canonicalisation:
  a stale coordinator is re-bound. Intake tests go from 23 to 22; the two forced-race tests
  now win against ordinary current-format rows, and one refusal test asserts the untouched
  stamp.

- **`kxm hub bind` no longer stores a remote URL it cannot authenticate to.** A remote
  binding is a deliberate network decision, so it is now refused when no credential resolves
  (explicit `KXM_AUTH_TOKEN`, or the persisted hub record's admin or project tokens) —
  mirroring the rule the hub already applies to its own listener, which refuses to bind
  beyond loopback without a token. The refusal carries `nextAction` and the same hint string
  in both the JSON payload and the prose line, so `--json` consumers are not left with a bare
  code and no way forward; a stored-but-unusable binding otherwise reads later like a
  network fault and gets debugged as one.
- **`kxm hub view` and the session brief label the binding `loopback` or `remote`.**
  "Attached across a network" and "attached on this box" looked identical before, and only
  one of them puts a bearer on a wire. `localhost`, `127.0.0.1`, `::1` and `*.localhost` are
  loopback; `0.0.0.0`, LAN addresses and host names are remote. The **bind** guard is
  scoped to remote URLs — a damaged host record must not cost a local operator their start,
  and the first cut of the guard did exactly that. That is a statement about `hub bind`
  only: other client paths resolve credentials whatever the scope, so loopback commands can
  still fail on a malformed record.

- **Naming sweep:** the retired `vnext` naming is gone from file and folder names,
  symbols, constants, schema `$id` segments, and error codes (`vnext_*` is now
  `initialization_failed`, `initialization_io_failed`, `wait_failed`); package and
  folder names dropped the `kxm-` prefix. `docs/vnext/` is `docs/contracts/`,
  `examples/vnext/` is `examples/project/`. Dated evidence under `plans/` and
  `.kxm/logs/` keeps its original wording.
- **Read-only run projection:** `GET /v1/runs/:id` folds the event log without
  persisting a projection write, so a read cannot mutate run state or surface a
  false `run_projection_divergent`.

### Removed

- **`.kxm/template-provenance.yaml` was removed from this project, a repository
  change rather than a product change,** because the installed kxm no longer
  recognizes its recorded revision and a project without the file validates as
  ready.

### Fixed

- **`kxm land` names the pull request from the first commit subject and matches the Release run by time.**
  `--title` sets the title; otherwise the subject of the first commit on the
  branch is used, and a missing subject refuses `land_pr_title_missing`. The
  title is never the branch name. The squash commit title stays `<title> (#n)`.
  After Auto-Release succeeds, the Release run is the first `release.yml` run
  created after that Auto-Release run, with no title filter. Both run ids are
  recorded and printed, and each wait logs one JSON line every two minutes.

- **A local `kxm workflow add` writes only what the project loader accepts, where it reads
  it.** Local scope needs a KXM project (`project_not_found` outside one, creating nothing)
  and writes to the project root's `.kxm/workflows/` from any subdirectory. Before writing,
  also under `--dry-run`, the project loader checks the project with the new document; if
  it would not load, the command exits 2 with `workflow_invalid`, lists the issues and
  writes nothing. A `--file` in the shape written through 0.7.92 is refused, and
  `--overwrite` repairs a file left in that shape. See
  `docs/reference/cli-reference.md#kxm-workflow-add`.
- **`kxm workflow add --pick <global-id>` copies the global definition.** In local scope,
  picking a global definition wrote the one-step scaffold under its id and reported
  success. It now writes the global definition's content, with `--description` replacing
  its description, and the loader check refuses one the project cannot load.
- **`kxm role add --pick <global-id>` copies the global role.** In local scope, picking a
  global role wrote an empty `Role <id>` with no skills or roster under its ID. It now
  writes the global role's content, with `--description`, `--skills` and `--model`
  replacing those fields the way they do for a built-in template.
- **`kxm role add` no longer leaves a project that refuses to load.** A local add now needs
  a KXM project (`project_not_found` otherwise, and no stray `.kxm/` that would make
  `kxm init` refuse), writes under the project root from any subdirectory, and is checked
  by the project loader first with the new role in place of any file of that ID. A
  `writer` role whose roster leaves out the `implementer` agent's model, including the
  built-in `writer` template for such a project, is refused with `role_invalid`, exit 2,
  and nothing is written, also under `--dry-run`.
- **Live `kxm runs drive` can author on an audited writer profile.** A write-repository
  step on pi (`-a`, with extensions, skills, and the session off) or grok
  (`--always-approve`, with subagents and web search off) runs against the checkout.
  A live write that leaves the tree unchanged settles `failed` with `authored: false`.
  A read-only step that changes the tree cannot settle `passed`. Harnesses without a
  writer profile still hand off. Simulated drive does not require a diff. The witness
  fingerprints the one checkout, so a live write step must be a single assignment
  (`assignments.maximum: 1`) in a project whose `limits.maxConcurrentRuns` is 1; a
  panel of writers or a project that admits concurrent runs hands off with
  `step_unsupported` instead of crediting one writer's change to another.

- **Fresh `kxm init` can be driven.** The current template drops `limits.maxAgentTimeMs`,
  names coordinator `claude` / `anthropic/fable` and implementer `grok` / `xai/grok-4.6`,
  and admits those two routes. One-shot production no longer falls through to an
  unadmitted `claude-3-7-sonnet`.

- **`kxm backup` includes this project's Runtime event store, and never another
  project's unless asked.** Discovery copies the checkout's own
  `$S/runtime/projects/<projectKey>/run-events.db`, with the key derived from the
  canonical checkout path as the Runtime derives it, plus its
  `run-events.db.run-prompts.json` sidecar. `kxm backup` and `kxm restore` act for the
  checkout the Runtime would use (the Git root holding `.kxm/project.yaml`), so running
  them from a subdirectory finds the same stores. The shared `$S/runtime/registry.db` and
  every other project's event store are copied only with `kxm backup --all-projects`, and
  a restore of a backup that holds them is refused with `restore_requires_all_projects`
  unless `kxm restore --all-projects` is given; a project restore therefore never rolls
  back another project's runs, receipts or sync outbox, or the registry. A project
  restore writes the event store where the Runtime looks for the checkout being
  restored, under the current `KXM_STATE_HOME`; `--all-projects` rebases the shared
  stores onto the current user state root. The manifest records `scope`, `stateRoot`
  and `runtimeProjectKey`. A copy that misses a discovered store is `complete: false`:
  `kxm backup` exits 1 with `ok: false`, and restore refuses that manifest.
  `kxm backup --help` no longer says Runtime stores are left out.

- **`kxm restore` refuses while the Runtime supervisor or a hub is running.** Before any
  write, and under `--dry-run` too, it fails with `restore_runtime_running` when the
  supervisor is live by the same test `kxm runtime status` uses (running state, fresh
  heartbeat, live PID), read through a read-only open of the registry, and with
  `restore_hub_running` when a live `hub.pid` claim sits beside a hub store it would
  overwrite. A registry too broken to read fails closed with
  `restore_runtime_unverified`, which says to stop the Runtime and move the registry
  aside. Replacing a SQLite file under an open writer could lose commits or corrupt the
  store.

- **Signed webhooks cannot be replayed.** KXM's own webhook senders now sign the
  timestamp, delivery ID, definition, run and signal key along with the body
  (`x-kxm-signature`, `x-kxm-timestamp`, `x-kxm-delivery-id`; see
  `docs/guides/webhook-workflows.md#kxm-sender-contract`), and the hub refuses a signature
  more than 300 seconds old. Every `generic` workflow start and every signal callback
  must use this contract; a body-only `X-Hub-Signature-256` there is refused. Jira and
  GitHub deliveries keep their provider signature, and a signed body starts at most one
  run (`webhook_payload_replayed`). A reused delivery ID with a different body is
  refused with 409 `webhook_delivery_conflict`, and a duplicate start returns only
  `duplicate`, `runId` and `status`. Update any custom sender to the new contract.
- **Agents never borrow the hub admin token.** With `KXM_AUTH_TOKEN` unset, the Pi
  extension and the `kxm peer` / `kxm workflow` agent commands used the persisted admin
  token. They now use only this project's saved project token, as the Claude MCP server
  does, and otherwise stop with a message naming the fix (`project_token_missing`, exit 2,
  on the CLI).
- **The hop limit bounds agent forwarding chains.** `kxm_send` and `kxm_fanout` from Pi
  or the Claude MCP server send one hop past the inbound request being handled, so a
  chain of agents forwarding to each other stops at `hop_limit_reached`.
- **Workflow prompts no longer point agents at `.kxm/config`**, a path KXM refuses.
- **`kxm gate signal`, `kxm workflow wait` and `kxm role resume` inside a KXM project reach
  the hub for hub runs.** They go to the local Runtime only for a run its store holds, and
  the lookup leaves no files behind, so `--dry-run` changes nothing.
- **`kxm peer inbox` lists the requests waiting for a named CLI agent.** It returned
  `{"messages":[]}` every time. The hub now serves `GET /v1/agents/:id/inbox`
  (agent-authenticated, project-scoped): the caller's queued and delivered requests,
  oldest first, acknowledging nothing. Run with a stable `KXM_AGENT_NAME` (for example
  `codex`) to list requests peers queued for it while it was offline, then answer them
  with `kxm peer reply`. The Pi extension's `kxm_inbox` tool now refuses instead of
  returning an empty list, because Pi activates each inbound request as a turn itself.
- **A restarted Claude Code session keeps the requests it acknowledged but never answered.**
  The MCP server acknowledges a request on arrival, and the hub pushes only unacknowledged
  requests again on reconnect, so a session that restarted under the same agent name (the
  plugin's `agent_name`) resumed its agent id but lost those requests from `kxm_inbox` and
  the channel until they expired. After it registers, the server now reads them back from
  the hub into `kxm_inbox` and announces each once as a channel event; one cancelled or
  expired meanwhile is dropped, not announced. A tool call waits for that read, and a failed
  read fails the call instead of listing a partial inbox.

- **The Claude plugin's SessionStart hook is one bundled, read-only, project-scoped
  script.** The two shell hooks it replaces (`kxm session brief --status` and
  `kxm memory brief`) exited 127 without `kxm` on `PATH`, ran whichever `kxm` was on
  `PATH`, minted a 24-hour operator token and wrote `.kxm/state/session-brief.json` at
  every session start, ignored the `server_url` option, and had no timeout. The new hook is
  `node ${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.js session-start` with a 5-second timeout.
  It reads only the project Claude Code opened (no walk-up), prints nothing outside a KXM
  project, writes no files, mints no token, spawns nothing and always exits 0. Its context
  is at most 1,500 characters of status (hub state probed at the plugin's `server_url`, up
  to three of this project's active runs, the count of open requests for this agent, and
  user-directed fixes) followed by the unchanged memory brief. The plugin version stays
  0.7.1, so an existing install gets the hook only after the reinstall described in the
  plugin README.
- **The Claude plugin's MCP server never authenticates with the hub admin token.** With a
  blank `auth_token` it fell back to the admin token saved in `hub-env.json` and registered
  the agent in a project nobody had issued it a token for. It now uses `KXM_AUTH_TOKEN` or
  this project's saved project token, and with neither it refuses before contacting the
  hub. The operator CLI and the Runtime supervisor resolve credentials as before.
- **`kxm workflow add` writes workflows that load.** The one-step scaffold and the three
  built-in templates used `role:` where an agent step needs `agent:`, the scaffold added a
  top-level `id`, and the templates' gate steps named a `verify-gate` no project defines
  and routed failures on `failed`. One such file in `.kxm/workflows/` made `kxm run` fail
  with `run_failed` for every workflow in the project. The scaffold is now one
  `implementer` step, and the templates are the ones described under Added.

- **`kxm improve` sees the Runtime's settled attempts and flags only same-ask repeats
  across runs.** It read only `.kxm/logs/telemetry.jsonl`, which no Runtime step writes, so
  it never saw an agent step; and on engine records it grouped per run and scored every pass
  rate 0. It now reads the current checkout's Runtime event store read-only (one query over
  the events table; it never creates, writes or migrates a store) plus telemetry, dropping
  a telemetry copy of an attempt the store already supplied; `--file` still reads only the
  named file. Each attempt's outcome is resolved from the event log: `accepted` when the run
  completed and the step was not re-entered, `reworked` when the step was entered again,
  `failed` when the run failed, and undecided otherwise. Simulated attempts are excluded
  and counted. Groups key on workflow, step, agent role and ask; a coded-repeat candidate
  needs the same ask decided in at least 2 runs, an accepted share of at least 0.75, and a
  step that writes no repository, and a passing group that misses says why
  (`writes-repository` or `ask-not-repeated`). The output names every source it read, with
  counts; an unreadable store exits 1 with `improve_source_unreadable` and its path.
  Workflow-step candidates now propose a `kind: gate` step and a `gates.yaml` entry with a
  placeholder command, and skill candidates are labelled consolidation. Candidates remain
  proposals; nothing is applied.
- **Runtime-dispatched agents receive committed, pinned project memory and hash-verified
  promoted skills.** The engine built each agent's context packet with no project items, so
  `.kxm/memory` and promoted skills never reached a `kxm run` agent. Now, when either
  exists, the Runtime delivers active memory in project or operator scope and promoted
  skills whose hash verifies, selected for the agent's role and step within 4,000 tokens,
  and only when those files are tracked and clean at HEAD and still match the run's pinned
  memory revision. Otherwise the context is withheld with a `dispatch_context_*` gap in the
  packet (never in the prompt) and the step still runs. Promoted skills render under a new
  `### Active Skills` heading. No hub call is made at dispatch.
- **Journal entries accept all ten categories and stage provenance.** The shared
  `kxm_workflow_record` tool (MCP, Pi and `kxm workflow record`) offered 5 of the 10
  categories, required an area and dropped `stageId`. It now takes every category and an
  optional `stageId`; area defaults to the stage's declared area; and the hub, not the
  caller, derives the attempt: the current attempt for an active or waiting stage, the last
  one consumed for a finished stage (previously always one past it). Entries the hub writes
  itself (checkpoint results, signal results, wait timeout, prompt expiry, degraded-quorum
  approval and premature settlement) carry the stage and attempt; the checkpoint and
  premature-settlement cases are the ones under test. `kxm workflow record` gained
  `--stage-id` and accepts `record <runId> <category> <summary>` when area is omitted.
- **Late journal entries and promotions refresh the exported retrospective.** A terminal
  run's retrospective is re-exported when an entry is recorded or a promotion decided
  afterwards. Retrospectives also count only error entries as recurring error classes and
  propose up to 12 ranked error and lesson signals. A promotion now publishes its update to
  the run's project rather than to the run id.
- **Context packets deliver the evidence they select.** Evidence items could be selected
  and budgeted but no packet section carried them; packets now have an `evidence` section,
  and the repro and implementer roles receive evidence, so the error, observation and
  state-change entries they recall reach them.

- **`kxm memory sync` no longer writes this repository's agent policy into other
  projects.** A missing `CLAUDE.md` or `GEMINI.md` used to be created from a header
  copied from KXM's own instruction files — the planner/architecture-critic role, the
  Grok writer rotation, and Tracking admission rules — so every project that ran sync
  inherited another project's development policy. Sync now touches only the
  `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` a project already has, replaces or appends
  just the `<!-- kxm:memory:start -->`…`<!-- kxm:memory:end -->` block, reports
  `updated`, `unchanged` and `missing` files, and exits non-zero without writing when
  none exist. The block is placed at the end of a file that has no markers yet, rather
  than before a `## Do not` heading that only this repository uses.

- **`kxm memory sync` refuses malformed memory markers instead of eating text.** Sync
  used to replace from the first `<!-- kxm:memory:start -->` to the first
  `<!-- kxm:memory:end -->` wherever they appeared, so an orphan start marker got a new
  block appended and the following sync deleted everything between the orphan and that
  block; an end before its start duplicated text; a second block went stale. A file
  must now hold exactly one start marker followed by one end marker, or neither.
  Otherwise sync exits non-zero naming the file and the problem, and writes no file.

- **Release version surfaces cover workspace packages:** a merged PR no longer
  breaks the release pipeline. `scripts/kxm-bump-version.mjs` now writes the
  version into every package manifest under `packages/`, using the same package
  scan that `scripts/check-versions.mjs` enforces (both import
  `scripts/package-surfaces.mjs`), and patches `package-lock.json` by key rather
  than by searching for the old version string — a third-party dependency that
  happens to share the product's version is left alone, and a workspace package
  with no lock entry fails loudly instead of releasing half-bumped.

- **`kxm hub start` no longer generates and persists an admin token when it is
  about to refuse** because another hub already owns the claim. A refused start
  used to leave behind credentials the running hub never issued.
- **Runtime intake contract fixes (released in 0.7.46, found in review):**
  a lost intake insert race accepted different content under an already-used
  idempotency key; resume drained only one page, so held intent beyond 500
  messages was stranded; pause, ingress and admission were not atomic, which could
  strand a message as `held_paused` in an unpaused project; a coordinator rebind
  could widen a tool ceiling by lifting a denial, changing the preset, or dropping
  the tool policy; relabelling a stored message's classification on a duplicate is
  now refused; coordinators now record the real loaded configuration revision
  instead of a hash of project path and runtime id; dispatch order is Runtime
  arrival order, so a backdated timestamp cannot jump the queue; persisted records
  are cross-checked against every duplicated column on read; and the intake schema
  no longer admits contradictory states.
- **A coordinator rebind could widen a tool ceiling by clearing its allow list.**
  An absent or empty allow list imposes no restriction, so dropping a populated one
  is now refused (`coordinator_rebind_clears_allowlist`). Resume drains held intent
  to exhaustion instead of stopping at a page cap, and fails loudly rather than
  half-resuming. Coordinator fingerprints are computed over the normalised
  authority, so identities bound by 0.7.46 with unordered effect lists no longer
  require a policy rebind after upgrade — and the equivalence test is shared, so a
  row written by 0.7.46 is not a `coordinator_write_lost` conflict just because it
  was found by losing an insert race instead of reading the slot.
- **A failed `BEGIN` poisoned the database connection.** The transaction marker was
  claimed before `BEGIN` and the statement sat outside the `try/finally`, so a
  `BEGIN` that gave up on a busy writer left every later transaction failing with a
  misleading "nested transactions are not allowed". The marker is now claimed only
  after a successful `BEGIN`, genuine lock contention surfaces as
  `runtime_transaction_busy` — decided by SQLite's **result code**, on both runtimes
  this ships on: Node's `errcode` and `bun:sqlite`'s `errno` (extended codes land on
  their primaries, so `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT` and
  `SQLITE_LOCKED_SHAREDCACHE` all count), then a symbolic `SQLITE_BUSY*` /
  `SQLITE_LOCKED*` / `SQLITE_PROTOCOL*` name, with anchored message text used only
  when an error carries neither. A code **or** a SQLite result name wins over the text
  in both directions, so a permanent error — `SQLITE_FULL`, `SQLITE_CANTOPEN` — quoting
  "database is locked" is not mistaken for contention, and `bun:sqlite`'s symbolic
  `code` is read as the result name it is while Node's own `ERR_SQLITE_ERROR` is not.
  Any other `BEGIN` failure keeps its own error instead of looking retryable. A contended connection then refuses further write-mode `BEGIN`s for one
  second (`TRANSACTION_BUSY_BACKOFF_MS`), so retries **inside that window** fail fast
  rather than paying the 5-second busy timeout once per attempt; a retry after the
  window can pay it again. The window is measured with `process.hrtime` and belongs to
  the clock that armed it, so neither a system clock change nor an injected test clock
  can extend, shorten or clear another caller's throttle, and a clock that returns a
  non-finite number is refused rather than trusted (`runtime_transaction_clock_invalid`)
  wherever a reading is taken — checking a pending deadline, and arming a fresh one. The
  clock is read at two call sites, not on every `BEGIN`. Zero reads are limited to
  successful write-mode transactions with no pending deadline, successful `DEFERRED`
  transactions with or without one, permanent `BEGIN` failures with no pending deadline, and
  a nested-transaction rejection; a `DEFERRED` transaction skips the deadline check, but a
  contended `BEGIN DEFERRED` failure still reads the clock and arms a deadline. Two further
  cases are measured rather than asserted by the committed suite — a clean success, and a
  permanent failure, each following an expired deadline, read it once. So this guards the
  seam rather than every transaction, and the counts we assert are named separately from the
  counts we observed. The throttle is per connection
  object in this process — it is not cross-process, and it does not leak to another
  connection to the same database.

## 0.7.0 - 2026-09-11

### Added

- **KXM Architecture Engine and Multi-Phase Isolation (Phases 0–4):**
  - **Dead Route Brake (Phase 0):** Fails closed and asserts 404 on obsolete `/dispatch`
    endpoint in supervisor API to eliminate legacy unmonitored dispatch routes.
  - **Objective Propagation (Phase 1):** Propagates accepted run objectives into the producer
    context packet with cryptographic SHA-256 hash validation against execution drift.
  - **Dynamic Permission Ceilings (Phase 2):** Dynamically derives sandbox permissions from step
    repository access declarations (`birthMember`), failing closed immediately on unauthorized
    live write access outside declared repository scopes.
  - **Pinned Route Admission & Roster Verification (Phase 3):** Strictly validates producer model
    resolution (`step.model -> agent.model -> refuse`), enforcing model admission policies and role
    roster alignment before birth.
  - **Asynchronous Scheduler & Graceful Lifecycle (Phase 4):** Asynchronous `/drive` execution via
    `KxmRunScheduler` returning `202 Accepted` with `/v1/runs/:id` poll endpoints, duplicate run
    rejection (`409 Conflict`), and supervisor graceful shutdown that awaits active drives.
- **Oneshot Harness Isolation, Pricing Safety & Async Probes:**
  - Standardized one-shot harness execution across Anthropic Claude, OpenAI Codex, Kimi, and Google AGY
    with unmetered subscription vs metered cost separation, process stdin piping, and timeout protection.
- **Universal KontextMind Knowledge-Plane Skill Suite:**
  - Portable, harness-agnostic skill suite under `.agents/skills/` including repository delivery skills,
    context memory recall, and lifecycle governance.
- **Pi Workflow Progress TUI & Studio Dashboard:**
  - Interactive Pi extension workflow progress terminal user interface with live status bars and web studio layout.
- **Public npm Release Automation Unlatched (E7):**
  - Unlatched `publish-npm` job in `.github/workflows/release.yml` with `environment: npm-publish`.
  - Added `scripts/kxm-publish-npm.mjs` verifying published GitHub release assets, digests, and
    publishing to npm registry.

## 0.6.0 - 2026-09-08

### Added

- **Improvement report and candidates (E8, issue #97):** Replaced gate-count
  bucketing in `improve.ts` with routing record grouping by
  `(workflowHash, step, agentRole, promptHash)`. Rows compute recurrence, mean cost,
  mean latency, verify-pass rate, and rework; high recurrence with high pass rate
  emits coded-repeat candidates. Single candidate format `kxm.candidate.v1` in
  tracked `.kxm/candidates/` with kind (`gate`, `skill`, `workflow-step`), evidence refs,
  baseline metrics, declared outcome, measure, and proposed diff patch. Skills carry
  standard YAML frontmatter (`name`, `description`). `skills promote` emits a unified diff
  patch (`.patch`) instead of moving a directory. Added `improve.yaml` workflow in
  `examples/project/.kxm/workflows/` completing on the driver. Un-gitignored retrospective exports.
- **Database backup, restore, and migrations (E6, issue #102):** Unified SQLite
  lifecycle via `openDatabase` with fail-closed schema checks, WAL journal mode with
  retry loop, busy timeout, and transaction helper with a nesting guard. Stepwise
  legacy migrations for `MeshStore` (v1 -> v2, v2 -> v3) replace unconditional version
  stamping. Added `kxm backup [--out <dir>]` and `kxm restore <manifest>` utilizing
  SQLite's backup API (`VACUUM INTO`), WAL checkpoint, PRAGMA integrity checks, and
  hashed manifest generation (`kxm.backup-manifest.v1`).
- **Harness-agnostic Git memory (E5b, issue #101):** Project memory authored in
  `.kxm/memory/` using schema `kxm.memory.v1` with YAML frontmatter. Memory notes
  recorded to `.kxm/memory/candidates/` with evidence authority, promoted exclusively
  via PR/commit. Projections regenerated across `AGENTS.md`, `CLAUDE.md`, and
  `GEMINI.md` via `kxm memory sync` with drift checks enforced in CI. Unified memory
  brief available via `kxm memory brief [--json]`, Claude Code `SessionStart` hook,
  and Pi `/kxm memory` slash command.
- **E5 memory floor and test tiering (issue #100):** Enforced memory security rules
  (Rule 1 admin-authenticated state promotion without loopback bypass; Rule 2
  exclusion of proposed candidates from currentState and content-hashed promoted
  skill verification; Rule 3 control-plane field rejection, secret redaction, and
  `scope` validation). Pins canonical `memoryRevision` (`ctxrev_<sha256>`) at run
  creation. Reorganized tests into `test/core/` (PR gate) and `test/simulations/`
  (heavy simulations) with parallel `--test-concurrency=4` and scheduled nightly
  coverage.
- Agent-only KXM run loop (`engine.ts`): pins a D1 compiled plan in an
  immutable hashed envelope, folds schema-valid `kxm.run-event.v1` events with
  a run_state projection, and drives a model-free simulated producer under
  transition/step budgets. Public drive, step, and scheduler share one
  admission bound. Sync and async producer failures settle as
  `producer_rejected` without leaking the attempt capability. A process
  restart of an executing attempt is unreconciled; operator cancel before pin
  still rebuilds. Duration/cost limits and the default/fix driver gate stay
  fail-closed for later slices. Event store is schema v3 with immutable gate
  rows; version-1 and version-2 files and `kxm.run-plan.v1` envelopes are
  refused (E6). Gate dispatch stays S3/S4. Evaluated gate settlement applies
  transition-budget failure, and complete/no-start observation facts are
  closed on both insert and replay.
- Pure KXM workflow compile (`engine-compile.ts`) turns a validated
  `kxm.workflow.v1` into a frozen JSON plan. Compile is not execution; D3/D4
  remain open.
- Routing contract doc (`docs/contracts/routing.md`) and synchronization status
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
  `docs/contracts/implementation-plan.md` (roles, provider-native harness routing,
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
- Opt-in Nous Pi providers `nous/*` (direct API, `NOUS_API_KEY` only) and
  `nous-proxy/*` (local Hermes subscription proxy). Unset `KXM_NOUS_PROVIDERS`
  leaves startup offline: no fetch and no `registerProvider`. Bounded live
  `/v1/models` catalog discovery (or a matching dated pin) fail-closes on
  unknown tokens, non-loopback proxy URLs, and incomplete or malformed rates
  rather than guessing zero. Context-tier estimates are labeled upper bounds
  in both direct and proxy display names (proxy keeps
  `subscription proxy, market ref`) and are not registered as a Pi
  `cost.tiers` schedule. Mac/Linux setup order is in `docs/configuration.md`.
  On 2026-09-07, tests verified one streamed tool call plus usage on
  `qwen/qwen3-coder-plus` for the direct API and an OAuth-backed Hermes
  proxy. Other models and automatic auth refresh remain unverified.
  Official Nous native Messages is for `anthropic/*`; Qwen uses
  chat/completions, so direct Claude→Nous→Qwen is unsupported by that
  documented route.

### Fixed

- **Windows Claude Code / npm shim detection (issue #168):** `kxm harness list`
  treated Claude Code as `not_detected` when the CLI was only an npm
  `claude.cmd` shim (no `claude.exe` on `PATH`). The probe now tries `.exe`,
  then the allowlisted inner package `claude.exe` next to `claude.cmd`, then
  `.cmd` on win32. Allowlisted `name.cmd` probes still use `shell: true` and
  record `windows_shim` when that is what answered. Auth still requires
  parseable `claude auth status`. Headless assignment (`just assign` /
  `harness-run`) scans every PATH directory for `name.exe` before any `.cmd`
  (so a user-bin `codex.cmd` cannot hide `codex.exe`), then unwraps the inner
  npm `claude.exe` and Pi's `node.exe` plus `cli.js`, without running
  unverified `.cmd` launchers through a shell.
- Concurrent Runtime registry and event-store initialization now checks and
  creates the schema under one write transaction, preventing duplicate-table
  failures when a supervisor and status reader first open the same database.
- Historical (before the 2026-09-05 platform pause): PR CI no longer skipped
  Validate or Plugin validation for docs-only diffs, so the then-required
  contexts (four expanded Validate names plus Plugin validation) still ran.
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

- CI, release, and smoke workflows select the ARC scale set
  `kontextmind-doks` (scalar `runs-on`, not a label tuple). Plugin
  validation moved off GitHub-hosted runners. Manual smoke is
  equality-gated on `KXM_SMOKE_RUNNER` and stays disabled until Pi
  credentials exist in ephemeral pods. Release/npm `if: false` and the
  Windows pause are unchanged.
- Operator-authorized platform pause (2026-09-05): PR CI keeps two Linux
  Validate legs (Node 22.19.0 and 24) plus Classify changes, Docs lint, and
  Plugin validation (five jobs). Windows CI legs, hosted Windows probes, and
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
