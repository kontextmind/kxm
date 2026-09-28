---
schema: "kxm.doc.v1"
id: "PLAN-KXM-HARNESS-FIRST-RUN"
type: "architecture"
title: "Bare kxm first run: onboard in the existing TUI, then keep workflows as validated files"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-27"
updated: "2026-09-28"
authority: "hypothesis"
confidence: "medium"
summary: "Draft plan. Bare kxm on a TTY opens the existing dashboard and, on a first run, a guided onboarding panel that probes harnesses, hands auth to each harness or to an op:// reference, and writes user defaults. It does not write secrets into .kxm. Static kxm.workflow.v1 files stay the trust anchor. A later hybrid may compose a workflow from a typed catalog, validate it, and persist it as a normal workflow file. Hub bind --cloud (#348), the naming validator, omp P3 (#378), and P4 are on main. Implementation still waits on omp-alignment P5 through P7. Execution tracking stays in implementation-plan.md."
tags: ["onboarding", "tui", "harness", "auth", "omp", "pi", "deepseek", "workflows"]
related:
  - evidence/harness-first-run-2026-09-27.md
  - plan-omp-config-alignment.md
  - research-omp-config-schema.md
  - research-omp-config-examples.md
  - evidence/omp-config-settings-18.3.1.md
  - plan-studio-cloud-host.md
  - plan-1password-vaults.md
  - implementation-plan.md
depends_on:
  - plan-omp-config-alignment.md
  - evidence/harness-first-run-2026-09-27.md
blocked_by: []
details:
  describes: "proposed"
  observed_at: "7a956e0 on 2026-09-27, package @kontextmind/kxm 0.7.1"
  decisions: "proposed, not taken"
---

# Bare kxm first run

Read [the execution tracker](implementation-plan.md) first. This file is
proposed work, not scheduled work. Research citations live in
[`evidence/harness-first-run-2026-09-27.md`](evidence/harness-first-run-2026-09-27.md).
omp's config surfaces stay in
[`research-omp-config-schema.md`](research-omp-config-schema.md). This plan
does not restate them.

Operator request, 2026-09-27: running `kxm` with no subcommand should onboard
config, set defaults and auth, use the existing TUI, and use current omp, Pi,
and DeepSeek. Also decide whether static workflow files should be replaced by
workflows built per request from agents, roles, routes, and gates.

## 1. Acceptance

This draft is accepted as a plan when:

- A reviewer can point at a phase and see its files, exit test, and dependency.
- Bare-`kxm` behavior is specified for a TTY, a non-TTY, `--json`, and `--yes`.
- Auth text says where a secret is allowed to live.
- The dynamic-workflow section picks one option and shows three persisted
  examples.
- No product code changes in the PR that adds this file.

Implementation of a phase is a later change. It starts only after section 6
says the blockers have landed, and only after the operator selects the phase
in the tracker.

## 2. What bare `kxm` does today

Observed at `7a956e0`.

`scripts/kxm.mjs` starts `plugins/kxm/dist/cli.js`. `runCli` in
`plugins/kxm/src/cli.ts` parses with Commander. The root command has no
`.action()`. No arguments on a TTY or a pipe print help and exit 2. With
`--json` the envelope is `kxm.cli-result.v1`, `error: usage_error`,
`detail: (outputHelp)`.

`kxm init` (`cli.ts` init action, `plugins/kxm/src/init.ts`) creates, joins,
validates, repairs, or resumes a project inside a Git worktree. Templates are
code in `plugins/kxm/src/template.ts` (`CURRENT_KXM_TEMPLATE_VARIANT` is
`v4-registry`), hashed into `.kxm/template-provenance.yaml`. There is no
`templates/` directory and no `--yes`. After a create or join, a TTY may offer
shell completion and guide setup (`plugins/kxm/src/init-guide-setup.ts`).
Guide setup skips itself when stdout is not a TTY, when `--json` or
`--dry-run` is set, or when `KXM_SKIP_GUIDE_SETUP_PROMPT` is set. It writes
agents, workflows, `kxm.role.v2`, and `kxm.model.v2`, and appends admitted
selectors. It does not write a secret.

The product TUI is `kxm dash` (`plugins/kxm/src/tui.ts`, `runMeshTui`). Panels
are `agents`, `tasks`, `workflows`, `plans`, `inbox`, `procs`, and `spend`.
A non-TTY dash prints a snapshot. `packages/core/tui` is the shared library.
Its omp adapter (`packages/core/tui/src/adapters/omp.ts`) is an overlay for an
oh-my-pi session. Dash uses the library theme. Bare `kxm` does not open either
surface.

Harness probes live in `plugins/kxm/src/harness.ts`.

| id | Command | Auth probe | One-shot |
|---|---|---|---|
| pi | `pi` | inventory leaves auth null and adds `auth_context_required`; a route uses `pi auth check` | `-p --mode json` |
| omp | `omp` | `models --json` | `-p` plus the read-only args, `--mode json` |
| claude | `claude` | `auth status` | `-p`, JSON on stdout |
| codex | `codex` | `login status` | `exec`, JSON |
| grok | `grok` | `models` | JSON `--single` |
| agy | `agy` | `models` | JSON `-p` |
| deepseek | `deepseek` | none. `UNKNOWN_AUTH_HARNESSES` adds `auth_unknown` | `--json` on stdin |
| kimi | `kimi` | `provider list` | stream-json |

Pi is the only long-lived worker (`kxm agent worker`). The others are one-shot.
`deepseek` has no audited writer-arg profile in `WRITER_ONESHOT_ARGS`.

Hub auto-start defaults to `background` (`plugins/kxm/src/hub-autostart.ts`,
`plugins/kxm/src/config.ts`). `kxm hub bind <url>` writes
`hub-binding.json` under the user state root and refuses a remote URL with no
credential (`plugins/kxm/src/cli/hub.ts`). `kxm hub bind --cloud` is on main
(#348, with #375 config identity and #376 probe fixes). User hub credentials are `kxm.hub-env.v1` in `hub-env.json`
(`plugins/kxm/src/hub-env.ts`).

Config layers:

| Layer | Path | Holds |
|---|---|---|
| Project | `.kxm/` | `project.yaml`, agents, workflows, `kxm.role.v2`, `kxm.model.v2`, `kxm.routes.v2`, `gates.yaml`, `template-provenance.yaml` |
| User config | `~/.config/kxm/config.yaml`, or `KXM_USER_CONFIG_DIR` | Personal settings merged over defaults (`plugins/kxm/src/config.ts`) |
| User state | `KXM_STATE_HOME` or the platform state dir | Hub binding, hub env, repository bindings |

`kxm config set` takes `--scope user|project`. Dispatch policy is the project
role and model files. P1 (`#337`), the dispatch cutover (`#343`), P3 tool
policy (`#378`, v0.7.169), and P4 fallback are on main. P5 through P7 have not.

Roles on disk are `writer`, `planner`, `reviewer-arch`, and `reviewer-cli`
(`kxm.role.v2`). Agents keep the names `implementer`, `critic-arch`,
`critic-cli`, and `coordinator`, and point at a role. Admitted routes are
`.kxm/routes.yaml` (`kxm.routes.v2`). One admitted selector is
`qwen-token-plan/deepseek-v4.1-flash`. There is no admitted `deepseek/` route.
`roster.yaml` is refused if present.

Workflows are `kxm.workflow.v1` (`schemas/workflow.schema.json`). Step kinds
are `agent`, `moa`, `gate`, `approval`, and `wait`. The checked-in set is
`default`, `implement-only`, `review-arch-only`, `review-cli-only`, and
`land`. `default` is implement, then both critics, then the `test` gate.
`land.yaml` is gate-only and its header says `kxm run` may refuse it until
gate-only workflows are supported. Live prerequisites in
`plugins/kxm/src/engine.ts` resolve a producer route for `agent` and `moa`
only. `approval` and `wait` pass the kind check in `unsupportedStep` and then
skip route resolution. Join strategies other than `all` and `all-settled` are
refused. A live write requires one assignment and an audited writer profile.

`gates.yaml` is `kxm.gate-registry.v1`. This repo registers `test` and the
`land-*` command gates.

Intake (`plugins/kxm/src/intake.ts`) stores a coordinator slot and deduplicates
messages. It does not choose a workflow. There is no `kxm doctor` command.
`op://` appears in `plans/plan-1password-vaults.md` and not under `plugins/`.

## 3. Research conclusions

Details and marks are in the evidence file. The decisions below use only the
verified rows plus the prior omp research this repo already trusts.

omp 18.3.5 (released 2026-09-27) keeps a TTY setup wizard, `/login` per
provider, and credentials in `~/.omp/agent/agent.db`. Project `.omp/config.yml`
is not a secret store. `modelRoles` plus `retry.fallbackChains` remain the
role and fallback split that `plan-omp-config-alignment.md` already maps onto
`kxm.role.v2`. `workflowz` and `orchestrate` still produce no file. That is
the prior 18.3.1 reading. The 18.3.5 changelog does not mention those
keywords, and this pass did not re-read their source.

Pi v0.87.1 (released 2026-09-22, package `@earendil-works/pi-coding-agent`)
stores OAuth and API keys in `auth.json` via `/login`. CI uses env vars. A
`!` command in `auth.json` can fill a key without KXM persisting the stdout.
`DEEPSEEK_API_KEY` is a documented Pi variable. New xAI sessions default to
Grok 4.7.

DeepSeek's official agent harness is `dsh` (`@deepseek-ai/dsh` 0.1.7-rc.2),
a developer-preview plugin kernel whose documented interactive UI is the
web app. It is not a `deepseek` binary, and it is not a Pi-style RPC worker.
The path this repo can name today is an API key or token-plan model id on a
harness KXM already audits. The catalog entry that probes `deepseek` and
parses `--json` does not match `dsh`.

Claude Code, Codex CLI, and Gemini CLI agree on one first-run shape: the bare
TTY command logs in, the vendor stores the credential, an env key skips or
shortens the prompt, and CI does not put the secret in the project. KXM
should follow that shape inside its own TUI, and keep calling each binary for
the actual login.

## 4. Target experience

### 4.1 When `kxm` has no subcommand

| Invocation | Result |
|---|---|
| TTY, no subcommand | Open `runMeshTui`. First run shows the onboarding panel. A completed setup shows the dash home panel. |
| No TTY, no subcommand, no `--yes` | Keep today's usage error, exit 2. `--json` keeps the `usage_error` envelope. Scripts that probe `kxm` stay non-interactive. |
| `--yes`, or `KXM_YES=1` | Non-interactive onboard. Probe, init when the directory is a Git worktree with no project, skip login when the probe is already authenticated, exit non-zero when a requested harness is logged out. No prompts. |
| `--help`, `-h`, `kxm help` | Help, including after this change. |
| Any real subcommand | Unchanged, including `kxm dash`, `kxm init`, `kxm hub bind`, and `kxm run`. |

The onboarding panel is a scene in `plugins/kxm/src/tui.ts` built from
`packages/core/tui` components. It is not a second UI, and it is not the omp
overlay. omp's overlay stays the in-session HUD for an omp process.

### 4.2 First run and returning

A user-state file `onboarding.json` (`kxm.onboarding.v1`) records
`setupVersion`, `completedAt`, and the probe fingerprint. Absence means the
wizard has not finished. It is a marker, not a secret.

| State | What the TUI does |
|---|---|
| No marker | Wizard. |
| Marker present, probes match | Dash. |
| Marker present, a harness disappeared or auth flipped | Dash, with a doctor line and a way to reopen the wizard. |
| `.kxm/project.yaml` already valid | Do not recreate the project. Offer `kxm init` repair only from the doctor. |
| Not a Git worktree | User-level setup only. Say that `kxm init` needs the Git root. |

`setupVersion` follows omp's integer: a later KXM release can reopen one new
scene without replaying the rest. Re-running the wizard is safe. It writes
the same user defaults again and leaves an existing project file alone when
the provenance hash still matches.

### 4.3 Wizard scenes

1. Git root and project. If `.kxm/` is missing inside a worktree, the last
   scene calls the existing `initializeKxmProject` path. `--yes` does that
   without a prompt.
2. Harness probe, reusing `probeHarnesses`. Show installed, version, and auth
   for omp, pi, deepseek's catalog id, and the other builtins. Versions below
   the evidence pins are warnings, not hard failures, until the operator
   admits a floor.
3. Auth handoff. For each installed harness whose probe is logged out, the
   panel starts that harness's own login and waits. omp: `omp setup` or
   `/login` inside omp. Pi: `/login`. Claude, Codex, Grok, and Antigravity:
   their own login commands. KXM does not read the resulting token. DeepSeek:
   scene 4.
4. DeepSeek. Explain the official `dsh` web app and the Pi `DEEPSEEK_API_KEY`
   path. Offer an `op://` reference or an env var name. Do not spawn a
   fictional `deepseek --json` login. Do not admit a route.
5. Defaults. From harnesses that probed authenticated, write user-level
   preferred effort and the interactive harness list into user config. Map
   onto the existing role ids (`writer`, `planner`, `reviewer-arch`,
   `reviewer-cli`). Effort defaults stay the ones the runner already uses:
   medium for implementation, planning, and architecture review, and low for
   CLI review. The wizard must not add an admitted route, must not edit
   `origin/main` policy, and must not put a model pin back on an agent.
6. Hub. Read `hub-binding.json`. Leave it unchanged. Offer the existing
   loopback bind and `kxm hub bind --cloud`, which is on main (#348).
   Clients of the kxmd hub use the SSH forward at `127.0.0.1:17331` because
   `hub.kxmd.dev` sits behind Authentik.
7. Doctor summary. Write the onboarding marker. Print the same report
   `kxm doctor` prints.

### 4.4 Auth and 1Password

Secrets live in the harness store (`auth.json`, `agent.db`, Claude and Codex
stores, `dsh` credentials) or in 1Password. User config may store an `op://`
reference or a `!` command string. `.kxm/` stays free of both secrets and
`op://` URIs, because those files are committed. Resolution order for a
provider KXM itself has to name:

1. Process env already set (`DEEPSEEK_API_KEY`, and the same pattern for
   other providers).
2. A user-config `op://` reference, read by `op` at use time. The stdout is
   process memory. The vault walk follows
   [`plan-1password-vaults.md`](plan-1password-vaults.md) once that plan is
   selected. This plan does not create vaults.
3. The harness's own store, which KXM does not copy.

A failed `op` read leaves the provider logged out. The wizard does not fall
through to a prompt that asks the operator to paste a key into KXM.

### 4.5 Project and user

| Written by the wizard | Layer |
|---|---|
| Onboarding marker, hub binding only when the operator runs bind | User state |
| Preferred effort, harness list, `op://` references | User config |
| New project files, only when `.kxm/` is absent | Project, via `kxm init` |
| Role, route, workflow, and gate edits on an existing project | Not this wizard |

Dispatch keeps reading project role and model files from the trust anchor
`plan-omp-config-alignment.md` already requires. User effort is a preference
the resolver may apply when the role entry does not set one. It does not
override an entry that set one.

### 4.6 Doctor

`kxm doctor` prints, and `--json` emits, harness inventory, auth, version
warnings, project presence, template provenance, hub binding scope, and the
onboarding marker. It writes nothing.

`kxm doctor --repair` re-runs probes, runs the existing init repair when
provenance says the project is drifted, and rewrites the onboarding marker.
It does not delete hub state, does not drop a database, and does not print a
secret. Repair of an unknown onboarding schema fails closed and tells the
operator to delete that one marker. That matches the single-operator rule:
this new file has no second shape to migrate.

### 4.7 Upgrade

An existing checkout with a valid `.kxm/` and no marker is a returning
project on a new wizard. The TUI opens the wizard once, skips project
creation, and writes the marker. Agents, roles, and workflows stay as they
are. `kxm init` remains the project repair tool.

## 5. Dynamic workflows

### 5.1 The question

omp's `workflowz` and `orchestrate` let the model invent a DAG at run time
and leave no file. KXM's runner reads `kxm.workflow.v1` from the project,
and the trusted loader pattern for policy is `origin/main`. Dropping the
files would drop the review, the plan hash, and the critic vendor check.

### 5.2 Options

| Option | What runs | Review | Reproducibility | Cost |
|---|---|---|---|---|
| A. Keep static files | The files already in `.kxm/workflows/` | Diff on the PR that edits them | The same file hashes the same way | The file can be wasteful for a docs ask, because `default` always runs both critics and `npm test` |
| B. Hybrid | A planner picks steps from a typed catalog. The result is validated and written as a normal `kxm.workflow.v1` file. The runner reads that file from `origin/main` after it is committed, or from the worktree only for a local `kxm run` that is not assignment acceptance | The YAML diff is the review. The catalog is the allowlist | The persisted file plus its hash is the run input. `planHash` stays an oracle on that file | The catalog can omit `npm test` for a docs ask and can keep both critics for a code ask |
| C. Fully dynamic | The model builds the DAG at run time, omp-style, and the runner executes it | Nothing to diff before the run | A second run can take a different path | The model can also skip a gate |

### 5.3 Recommendation

Option B. Option A stays valid for `default`, the one-step workflows, and
`land`. Option C fights the trust anchor, the two-critic rule, and
`planHash`. Gates stay invariants in the catalog, not suggestions in a
prompt.

Rules for the composer:

- Intent is classified before any model call when the signals are
  deterministic: path set, or an operator flag such as `--intent docs`.
  A read-only planner may classify only when those signals are absent, and
  its output is data the validator accepts or refuses.
- The catalog's step ids are the existing agents and the registered gates.
  The composer uses the names the route and role validator allows. It does
  not invent a third vocabulary.
- A code-changing intent includes `implementer`, `critic-arch`,
  `critic-cli`, and the `test` gate. The two critics stay on different
  vendors because the role files already require that. The composer does
  not get to drop one.
- A docs-only intent may skip `npm test` and use a `docs` gate. That gate
  has to be added to `gates.yaml` in the same change. Both critics stay
  when the run is an assignment acceptance. A local `kxm run` may use the
  shorter file.
- A release intent selects the existing `land` workflow. It does not
  synthesize a second land path. The header on `land.yaml` still applies:
  gate-only drive has to be supported before that file is the default
  release click.
- `approval` and `wait` stay out of the catalog until a drive test shows
  they settle. Join stays `all` or `all-settled`.
- The validator runs `compileKxmWorkflow` and the live prerequisite checks.
  A file that would hand off as `step_unsupported` is refused at compose
  time.
- Assignment acceptance reads the committed file from `origin/main` and
  checks the hash. A local run may use a worktree file and must say so in
  the receipt.
- In-run model fallback stays `plan-omp-config-alignment.md` P4. The
  composer does not encode a fallback chain in the workflow.

### 5.4 Examples

These are the files the composer would persist. Agent ids are the ones on
main at `7a956e0`. After the naming validator lands, the same shapes use
whatever ids that validator accepts.

Bug fix, assignment acceptance. This is today's `default` shape, selected
from the catalog rather than invented:

```yaml
schema: kxm.workflow.v1
description: Bug fix with both critics and the test gate.
coordinator: coordinator
limits:
  maxTransitions: 8
planHash:
  stageId: implement
  evidenceKey: plan-hash
requirePlanHash: [implement]
steps:
  - id: implement
    kind: agent
    agent: implementer
    repositories:
      control: write
    maxAttempts: 3
    on:
      passed: review-arch
      failed:
        target: $terminal
        terminalStatus: failed
  - id: review-arch
    kind: agent
    agent: critic-arch
    repositories:
      control: read
    maxAttempts: 2
    on:
      passed: review-cli
      failed:
        target: implement
        maxTransitions: 2
  - id: review-cli
    kind: agent
    agent: critic-cli
    repositories:
      control: read
    maxAttempts: 2
    on:
      passed: verify
      failed:
        target: implement
        maxTransitions: 2
  - id: verify
    kind: gate
    gate: test
    expect: pass
    repositories:
      control: write
    maxAttempts: 2
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      implementation-failure:
        target: implement
        maxTransitions: 2
```

Docs-only, local run. The `docs` gate is new and has to land in
`gates.yaml` as `npm run lint:docs` before this file validates. Assignment
acceptance inserts `review-arch` between implement and review-cli.

```yaml
schema: kxm.workflow.v1
description: Docs-only local run. Lint gate, one CLI critic.
coordinator: coordinator
limits:
  maxTransitions: 6
steps:
  - id: implement
    kind: agent
    agent: implementer
    repositories:
      control: write
    maxAttempts: 2
    on:
      passed: review-cli
      failed:
        target: $terminal
        terminalStatus: failed
  - id: review-cli
    kind: agent
    agent: critic-cli
    repositories:
      control: read
    maxAttempts: 1
    on:
      passed: verify-docs
      failed:
        target: implement
        maxTransitions: 1
  - id: verify-docs
    kind: gate
    gate: docs
    expect: pass
    repositories:
      control: none
    maxAttempts: 1
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: implement
        maxTransitions: 1
```

Release. The composer selects `.kxm/workflows/land.yaml` unchanged. It does
not emit a new file. A generated copy of those six gates would be a second
land implementation.

## 6. Sequence

Implementation of this plan waits until the remaining items are on main:

1. `kxm hub bind --cloud` and the unified project id are on main (#348,
   #375, #376). Clients reach the kxmd hub over the SSH forward at
   `127.0.0.1:17331` because `hub.kxmd.dev` sits behind Authentik.
2. Agent, role, and route naming plus the route and role validator are on
   main (`scripts/workforce-lint.mjs`, wired into check and `validate:pr`).
   The wizard and the composer must call that validator rather than grow a
   third name table.
3. omp-alignment P5 through P7. P3 tool policy (#378, v0.7.169) and P4
   fallback are on main. Onboarding must not promise a fallback the runner
   does not walk. P6 effort checks should be in place before the wizard
   writes effort defaults. P5 and P7 can follow. P1 and P2 are on main as
   `#337` and `#343`.

P0 below is the gate that checks this list. It is not a product change.
[`plan-studio-cloud-host.md`](plan-studio-cloud-host.md) shares this gate.
Studio work does not start ahead of it.

## 7. Phases

Each implementation phase is one PR by the admitted writer, reviewed by
both critics, gated by `npm run verify` locally and by `CI / required` on
the pull request. Windows Validate legs run on main (#358 to #364).
`Nightly` and `Real Pi smoke` stay disabled. One focused test per new
behavior, in an existing suite.
Rough effort is the size of the change, not a schedule.

| Phase | Scope | Files | Exit | Effort |
|---|---|---|---|---|
| P0 | Confirm section 6 on main. Update this plan's status note. No product code | this file, the tracker when the operator selects it | The three dependencies are named by commit or PR on main | a status edit |
| P1 | `kxm doctor` read-only report | `plugins/kxm/src/cli.ts`, a doctor module next to harness probe, `test/core/cli.test.ts` or `test/core/harness.test.ts` | JSON report covers installed, auth, version warning, project, provenance, hub scope, marker. Exit 0 when the report is complete, including when a harness is logged out | small |
| P2 | Bare TTY `kxm` opens dash | `cli.ts` empty-argv branch, `tui.ts` | TTY with no args opens the dash. Non-TTY still exits 2. `--help` unchanged. A test drives the argv branch with a fake TTY flag | medium |
| P3 | Wizard scenes 1 through 7, user config, `op://` references, `--yes` | TUI scene, user-config writer, init call | A fixture with no project creates one via init. A second run does not rewrite project files. A test asserts `.kxm/` contains no `op://` and no secret-shaped value. `--yes` with a logged-out required harness exits non-zero and writes no marker | medium, touches auth boundaries |
| P4 | Version warnings and the DeepSeek catalog mismatch | `harness.ts`, doctor copy, evidence note if the `dsh` CLI is re-read | Doctor warns below omp 18.3.5, Pi 0.87.1, and `@deepseek-ai/dsh` 0.1.7-rc.2. The `deepseek` command id is either documented as unmatched or pointed at a verified CLI. No new admitted route | medium |
| P5 | `kxm doctor --repair` and the upgrade path | doctor, init repair call | An existing project with no marker completes the wizard without a new template generation. Repair refuses an unknown onboarding schema | small |
| P6 | Typed catalog and validator, no model | catalog module, `compileKxmWorkflow` wrapper, tests | The three examples in section 5.4 either select an existing file or validate. A catalog entry that drops a critic on a code intent fails. `docs` gate added only with the docs example | medium |
| P7 | Planner output is data, then the validator persists a file | planner prompt is out of repo or a skill, persist path | A refused plan writes nothing. An accepted local run writes `.kxm/workflows/<id>.yaml` and prints the hash. Assignment mode refuses a file that is not on `origin/main` | larger, trust-anchor tests |
| P8 | Receipt and hash | run receipt, plan hash oracle | The receipt names the workflow hash, the catalog version, and whether the file came from `origin/main` or the worktree | medium |

P6 through P8 start only if the operator accepts option B. P0 through P5
stand without them.

Suggested commits, when a phase is selected:

- P1 `feat(cli): add a read-only kxm doctor report`
- P2 `feat(cli): open the dashboard from bare kxm on a tty`
- P3 `feat(tui): guide first-run harness setup`
- P4 `fix(harness): report deepseek and version warnings honestly`
- P5 `feat(cli): repair onboarding from kxm doctor`
- P6 `feat(workflow): validate a composed workflow against the catalog`
- P7 `feat(workflow): persist a composed workflow as kxm.workflow.v1`
- P8 `feat(runs): record the workflow hash on the receipt`

## 8. Roles

| Role | Who | Work |
|---|---|---|
| Plan | This draft | Scope and the option B recommendation |
| Implement | Admitted writer from Tracking, starting rotation Grok | One phase per PR, after P0 |
| Review | Fable and Codex gpt-5.6-sol | Both required before acceptance |
| Verify | Implementer | `npm run verify` |

The writer of a phase is not a critic of that phase.

## 9. Tests

| Behavior | Where |
|---|---|
| No-args TTY vs non-TTY vs `--json` vs `--help` | `test/core/cli.test.ts` |
| Doctor JSON fields and secret redaction | `test/core/harness.test.ts` and the CLI suite |
| `--yes` fails closed when auth is false | CLI suite, fake probe |
| Wizard does not write `op://` or a key into `.kxm/` | temp project fixture |
| Second wizard run is idempotent | same fixture |
| Existing project is not recreated | init suite pattern in `test/core/init-guide-setup.test.ts` |
| Catalog refuses a code workflow with one critic | new cases beside workflow compile tests |
| Catalog selects `land.yaml` for a release intent | catalog unit test |
| Assignment refuses a workflow missing from `origin/main` | the roster-policy style of git-show test |

`npm run verify` is the phase gate. `npm run lint:docs` covers this plan.

## 10. Risks

- Bare `kxm` today exits 2. P2 changes that on a TTY only. A caller that
  depends on exit 2 with a TTY has to pass `--help` or a subcommand.
- A wizard that admits a route would bypass the runner. P3's test is the
  brake.
- Storing `op://` in `.kxm/` would publish vault layout. The test forbids
  the prefix in project files.
- Treating `dsh` as a drop-in `deepseek` one-shot would dispatch a web
  kernel with the wrong argv. P4 keeps the probe honest.
- A composed workflow that skips a gate looks like a cost win and is a
  trust failure. The catalog refuses it.
- `land.yaml` is already the release workflow, and its own comment says
  drive may refuse it. P7 must not paper over that with a generated twin.
- Cloud bind and the naming validator were not visible from this run. P0
  exists so the wizard does not invent either API.

## 11. Open questions

- Should user-level effort ever override a role entry, or only fill a gap?
  This draft fills a gap.
- Is `@deepseek-ai/dsh` something KXM should probe as a second command id,
  or should DeepSeek stay a model on Pi, omp, and the token-plan route?
  This draft keeps it as a model path until a headless `dsh` profile is
  verified.
- Does guide setup (`init-guide-setup.ts`) fold into the wizard, or stay
  the post-init prompt? P3 tool policy is on main (#378). This draft still
  leaves guide setup in place until the wizard is the only prompt.
- Who may persist a composed workflow onto `origin/main`? This draft says
  a normal PR, the same as editing `default.yaml` by hand.

## 12. Out of scope

- Implementing omp-alignment P5 through P7. P3 (#378) and P4 are on main.
- Implementing `kxm hub bind --cloud`. It is on main (#348, #375, #376).
- Renaming agents, roles, or routes.
- A new TUI toolkit, or moving the product shell onto omp's wizard.
- Copying `workflowz` as the runner.
- New writer admissions, including a DeepSeek writer route.
- Creating 1Password vaults. Names stay in the vault plan.
- Editing `kxm.workflow.v1` so a model can add a step kind.
- Turning this draft into a tracker row. The operator does that.
- Studio screens for the shared hub. Those are the companion plan.

## 13. Change log

| Date | Note |
|---|---|
| 2026-09-27 | Draft opened from the operator request and the evidence file. |
| 2026-09-27 | Cross-linked the Studio cloud-host companion. The sequence gate is shared. |
| 2026-09-28 | `--cloud` (#348, #375, #376), the naming validator, P3 (#378), and P4 are on main. The sequence gate that remains is P5 through P7. CI is on. |
