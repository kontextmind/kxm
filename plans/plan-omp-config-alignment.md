---
schema: "kxm.doc.v1"
id: "PLAN-OMP-CONFIG-ALIGNMENT"
type: "architecture"
title: "Activate the kxm.role.v2 and kxm.model.v2 policy draft as the single role authority, with omp-style fallback and enforcement"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-25"
updated: "2026-09-26"
authority: "hypothesis"
confidence: "medium"
summary: "Draft plan, decisions taken. KXM already carries a passive kxm.role.v2 and kxm.model.v2 draft (schemas/policy-draft, validatePolicyDraft) whose shape matches what omp does well: roles hold an ordered roster of route ids, routes hold harness, model, vendor, status, permissions, priority and fallbacks. This plan promotes that draft to the live authority, retires kxm.role.v1, routes.yaml roles, roster.yaml and the code defaults, gives agents a role: reference, then adds an opt-in in-flight fallback walk, role tool-policy enforcement, provenance, role aliases, and effort validation. No legacy read paths: old files are deleted and re-created per the single-operator rule. Execution tracking stays in implementation-plan.md."
tags: ["roles", "roster", "routing", "agents", "omp", "governance", "policy-draft"]
related:
  - research-omp-config-schema.md
  - research-omp-config-examples.md
  - evidence/omp-config-settings-18.3.1.md
  - plan-lane-cli.md
  - backlog-shortcuts.md
  - implementation-plan.md
  - plan-usage-cost-quota-tracking.md
  - plan-workflow-modes-selective-loading.md
  - history/plan-role-configuration-governance.md
depends_on:
  - research-omp-config-schema.md
blocked_by: []
details:
  describes: "proposed"
  writer_route: "grok --model grok-4.7 per CLAUDE.md; this file is a planner artifact"
  decisions_taken: "2026-09-25 operator: D1 role files, D2 delete lineup, D3 keep agent names and add role:, D4 fallback opt in per role"
  builds_on: "schemas/policy-draft (kxm.role.v2, kxm.model.v2) from #176, #214, #231, 1beb8ff, bf8150d; task_d3e634858295"
---

# Activate the role and model v2 draft as the single role authority

Read [the execution tracker](implementation-plan.md) first. This file is
proposed work, not scheduled work. Facts about omp are in
[`research-omp-config-schema.md`](research-omp-config-schema.md); worked
examples in [`research-omp-config-examples.md`](research-omp-config-examples.md).
Facts about KXM below were observed on 2026-09-25 against `kxm` 0.7.115.

## 1. What exists, and what is wrong with it

### 1.1 The passive draft already has the right shape

`schemas/policy-draft/role.v2.schema.json` and `model.v2.schema.json`, with
the pure validator `validatePolicyDraft` in `plugins/kxm/src/policy-draft.mjs`,
landed as "passive scaffolding" in #176 and were kept current through the
roster cutover (#231), the antigravity carve-out (#214), the Opus critic
admission (1beb8ff) and the grok-4.7 ceiling fixture (bf8150d). The tracker
says explicitly what they are not yet: not live cutover, not roster removal,
not global-role migration, not mandatory bindings, not runtime admission.

Their shape:

| Document | Fields |
|---|---|
| `kxm.model.v2` (a route) | `schema`, `id`, `harness`, `model`, `vendor`, `status` admitted, candidate, retired; `permissions[]`; `origin {source, sha256}`; `thinking`; `tags[]`; `capabilities[]`; `priority`; `fallbacks[]`; `limits {contextTokens, outputTokens, timeoutMs}` |
| `kxm.role.v2` | `schema`, `id`, `purpose` writer, planner, reviewer-arch, reviewer-cli, experiment; `permission` edit or read-only; `description`; `roster[] {route, effort, mode}`; `skills[]`; `tools {preset, allow, deny}`; `produces[]`; `consumes[]`; `policy {vendorIndependenceRequired, maxTransitions, requiresGateVerification}` |

Effort already spans `off minimal low medium high xhigh max`. The validator
already enforces the three roster rules the developer runner relies on:
critics are read-only, the two critics have different vendors, no admitted
writer shares a vendor with a critic. It takes code-owned ceilings and vendor
brakes as explicit options and reads no files.

This is the omp split, done better: a role is an ordered preference list of
routes; a route is where harness, vendor, admission status and fallbacks live.
omp keeps the same two halves as `modelRoles` plus `retry.fallbackChains`.

### 1.2 Six places still pin a role to a model

1. `.kxm/roles/*.yaml`, `kxm.role.v1`, roster of model strings with `enabled`.
2. `.kxm/routes.yaml` `roles:` map, with the names `implementer`,
   `critic-arch`, `critic-cli`.
3. `.kxm/roster.yaml`, `kxm.developer-roster.v1`, routes plus `lineup`, read
   by `scripts/roster-policy.mjs` only from `refs/remotes/origin/main` and by
   `engine.ts` for live-write steps.
4. `.kxm/agents/*.yaml`, `harness` plus `model`.
5. `DEFAULT_ROLES` and `DEFAULT_ROLE_SEATS` in `plugins/kxm/src/role.ts`.
6. `justfile` recipe literals: `impl` uses grok-4.7 medium edit; `plan` and
   `review-arch` use claude `opus` medium read-only; `review-cli` uses codex
   gpt-5.6-sol low.

Two vocabularies are bridged by one hardcoded alias in `engine.ts` line 1426.

### 1.3 The roster never rotates

The agent's pinned model is the selector. `engine.ts` around line 1427 refuses
a step whose selector is absent from the role roster, and around line 2894
refuses a live write whose route is not in `roster.yaml` `lineup.writer` with
`status: admitted` and `edit`. A 429 or a transport error ends the attempt.
The second roster entry is never tried. `kxm.model.v1` and the v2 draft both
declare `fallbacks[]` and `priority`; nothing reads them.

### 1.4 Three role schemas disagree

`schemas/role.schema.json` (`kxm.role.v1`) wants roster models as
`{provider, model}` objects with `harness` required; the `KxmRosterEntry` type
wants `harness` as a string and has no `enabled`; the on-disk files use
`provider/model` strings, no `harness`, and `enabled: true`. Only the
policy-draft test references the JSON schema. `role modify --add-model`
defaults the harness to `pi` when the argument has no colon.

### 1.5 Role tools, skills, contracts and policy are decorative

Nothing reads them at dispatch (`role.ts` lines 245 and 262 count them for the
list output). Agent `tools.preset` is enforced. Effort on roster entries is
never checked against what a model accepts; `inventory.yaml` records no
accepted levels.

## 2. Goals and non-goals

Goals:

- `kxm.role.v2` and `kxm.model.v2` become the live authority. Every other pin
  point is derived from them or deleted.
- The trusted loader keeps its trust anchor: role and model files are read from
  `refs/remotes/origin/main`, not from the working tree, wherever `roster.yaml`
  was read that way before.
- Agents reference a role. The workflow file does not change.
- A role can opt in to an in-flight walk over its roster on provider errors,
  bounded and logged, reverting on the next run.
- Role tool policy is enforced at dispatch. Provenance is reported. A role can
  extend another. Effort is validated against the catalog.

Non-goals, and why:

- **No legacy read of `kxm.role.v1` or `kxm.developer-roster.v1`.** The
  single-operator rule (tracker, 2026-09-20): old state is deleted and
  re-created, nothing carries a second shape.
- **No fuzzy matching, no provider wildcards, no `:level` suffix.** Admission,
  pricing and telemetry key on exact route ids.
- **No third pin layer.** omp's `task.agentModelOverrides` is not copied.
- **No change to `kxm.workflow.v1`.** omp has no workflow file.
- **No new writer admission.** Every route that exists after the cutover is a
  route that is admitted today, with the same status and permissions.

## 3. Target shape

### 3.1 Routes: `.kxm/models/<route-id>.yaml`

One file per route, `kxm.model.v2`, replacing the `routes:` map of
`roster.yaml` one for one. `.kxm/models/inventory.yaml` stays the fetched
catalog and is not a route.

```yaml
schema: kxm.model.v2
id: grok-native
harness: grok
model: grok-4.7
vendor: xai
status: admitted
permissions: [edit]
origin: { source: .kxm/roster.yaml, sha256: <hash of the roster file this was cut from> }
thinking: medium
priority: 100
fallbacks: [qwen-openrouter-pi]        # route ids, exact, admitted; walked only when the role opts in
limits: { timeoutMs: 3600000 }
```

### 3.2 Roles: `.kxm/roles/<id>.yaml`

`kxm.role.v2` as drafted, plus two additive keys this plan introduces:
`extends` and `policy.fallback`.

```yaml
schema: kxm.role.v2
id: writer
purpose: writer
permission: edit
description: Primary implementation agent.
skills: [kxm, unit-testing]
tools: { preset: workspace-writer }
roster:
  - { route: grok-native, effort: medium, mode: headless }
  - { route: qwen-openrouter-pi, effort: medium }
policy:
  vendorIndependenceRequired: true
  requiresGateVerification: true
  fallback:
    onError: []                    # opt in: [rate_limit, transport, provider_unavailable]
    maxSwitches: 1
    revert: next_run               # next_run | never
```

```yaml
schema: kxm.role.v2
id: reviewer-arch
purpose: reviewer-arch
permission: read-only
description: Independent architecture critic.
extends: planner                   # planner's roster is appended after this role's own entries
tools: { preset: read-only }
roster:
  - { route: fable-claude, effort: high }
policy: { vendorIndependenceRequired: true, requiresGateVerification: true }
```

Schema changes to the draft, all additive: `extends` (identifier, cycle
guarded), `policy.fallback {onError[], maxSwitches, revert}`. `produces` and
`consumes` stay in the schema but are not consumed by this plan.

### 3.3 Agents: `.kxm/agents/<id>.yaml`

`kxm.agent.v1` gains optional `role`, `effort`, `skills`. `harness` and
`model` are removed from the four project agents; `role` supplies them.

```yaml
schema: kxm.agent.v1
purpose: Implement the approved change within the declared repository scope.
role: writer
tools: { preset: workspace-writer }        # may only narrow the role preset
defaultRepositoryAccess: none
repositories: { control: write }
network: provider-only
resultSchema: kxm.assignment-result.v1
```

`implementer` keeps its name (D3). The engine alias goes; the agent's `role`
is the binding.

### 3.4 Derived and deleted

| Today | After |
|---|---|
| `.kxm/routes.yaml` `admitted`, `disabled`, `roles` | `admitted` and `disabled` only; `roles` deleted. `kxm routes` prints membership from role files |
| `.kxm/roster.yaml` | deleted. `scripts/roster-policy.mjs` loads `.kxm/models/*.yaml` and `.kxm/roles/*.yaml` from `refs/remotes/origin/main` and builds the same policy object (`routes`, per-role lineup) the runner consumes, so `assignment-run.mjs` changes only its import |
| `schemas/role.schema.json` v1, `schemas/model.schema.json` v1 | replaced by the promoted v2 schemas; `schemas/policy-draft/` deleted |
| `DEFAULT_ROLES`, `DEFAULT_ROLE_SEATS`, `kxm.role-hosts.v1` in `role.ts` | deleted. `kxm init` writes v2 role and model files from the template instead |
| `justfile` recipe literals | recipes read role, harness, model, effort and permission from the role file's first roster entry through one small resolver script; literals removed |
| `engine.ts` `implementer` to `writer` alias | deleted |

### 3.5 Fallback walk (opt in)

In `prepareDispatch` and the attempt runner:

1. Resolve the role roster in order (own entries, then `extends` chain),
   filtered to routes with `status: admitted` and, for live-write steps, an
   `edit` permission and an audited edit one-shot profile on the harness.
2. Start on the first entry, or on the agent's `model` when an agent still
   pins one and it is in the roster.
3. On an error whose class is in `policy.fallback.onError`, emit a
   `route_switch` run event (from, to, reason, effort), and re-dispatch the
   same attempt on the next entry, at most `maxSwitches` times. Effort is the
   next entry's own `effort`, or the failing attempt's when the entry has none.
   `vendorIndependenceRequired` is checked against the critics before every
   switch; a switch that would collide is skipped.
4. Auth, unhosted model, gate and tool policy errors never walk.
5. `revert: next_run` restarts at the first entry on the next run. `never`
   keeps the last successful entry for the rest of the run.

`route_switch` events feed `kxm routing report` and `kxm improve report`,
which currently receive no routing records at all.

### 3.6 Tool policy enforcement

`role.permission` and `tools.preset` map onto the harness one-shot profiles
already in `harness.ts`: `read-only` and `coordinator` to the read-only
argument set, `workspace-writer` and `tests-writer` to the edit set. An agent
preset may only narrow. A mismatch is refused with `step_unsupported` before
dispatch. `allow` and `deny` apply to the MCP surface through
`enforceToolPolicy`.

### 3.7 Provenance, aliases, effort

`kxm role get` reports, per field and per roster entry, which of `default`,
`global`, `local`, or `extends:<role>` supplied it. `extends` is resolved with
a cycle guard. `inventory.yaml` gains `capabilities.thinking.efforts[]` per
model where a probe or the harness model list reports it; `role add` and
`role modify` reject an effort the route's model does not accept and warn when
the list is unknown.

## 4. Decisions (taken by the operator on 2026-09-25)

- **D1. Authority: role files.** `.kxm/roles/*.yaml` plus `.kxm/models/*.yaml`.
- **D2. `roster.yaml`: delete.** The trusted loader reads role and model files
  from `origin/main`; the engine live-write check reads the same.
- **D3. Vocabulary: keep agent names, add `role:`.**
- **D4. Fallback: opt in per role.** `policy.fallback.onError` ships empty.

## 5. Phases

Each phase is one PR, written by the admitted writer route, reviewed by both
critics, gated by `just verify` locally (CI is paused; the local pipeline is
the gate per the tracker). [`plan-lane-cli.md`](plan-lane-cli.md) lands
first: P1 is the first run dispatched as
`kxm lane run omp-align-p1 --brief .kxm/briefs/omp-align-p1.md --wait`. Test policy per the tracker: one focused named test
per behaviour that can break, in an existing suite; deleting a path deletes
its tests.

| Phase | Scope | Behavior change | Gate |
|---|---|---|---|
| P1 Promote the draft | Move the two v2 schemas to `schemas/`, add `extends` and `policy.fallback` to the role schema and to `validatePolicyDraft`; write `.kxm/models/*.yaml` from `roster.yaml` routes; rewrite the four role files to v2 with route ids; delete `routes.yaml` `roles:`; delete the v1 schemas, `DEFAULT_ROLES`, `DEFAULT_ROLE_SEATS`, role-hosts; `role list/get/add/modify/remove` read and write v2 only; `kxm init` template emits v2; register `role` and `model` as live resource kinds in `project-config.ts` so `kxm config` validation covers them | none at dispatch; `roster.yaml` still read by loader and engine | `just verify`; a test that every `.kxm/roles` and `.kxm/models` file validates against the live schema through `validatePolicyDraft` with the developer ceilings |
| P2 Cut the loader and engine over | `roster-policy.mjs` builds the policy object from v2 files at `origin/main`; `engine.ts` membership and live-write checks read roles and routes; agents gain `role:`, lose `harness` and `model`; alias deleted; `roster.yaml` deleted; `justfile` literals replaced by the resolver; docs (`assignment-runner.md`, config reference) updated | dispatch reads the new files; same admissions | `just verify`; `test/core/roster-policy.test.ts` rewritten for the new source; one engine test per refusal path |
| P3 Tool policy enforcement | 3.6 | steps can be refused that were accepted | a fixture per preset pair |
| P4 Fallback walk | 3.5 plus `route_switch` in `run-event.schema.json` and the two reports | attempts continue on the next admitted route when a role opts in | simulated 429 and transport fixtures; report shows switches |
| P5 Provenance and `extends` | 3.7 first two items | none at dispatch | unit tests |
| P6 Effort catalog | 3.7 last item; probe evidence under `plans/evidence/` | invalid efforts rejected at edit time | evidence file plus validator test |
| P7 Quota-aware walk (optional) | plan quota below reserve as an `onError` class | depends on `plan-usage-cost-quota-tracking.md` | that plan's gate |

Order of value: P2, P4, P3, P6, P5. Order of risk: P2 touches the runner's
trust anchor and must keep the `origin/main` read; P3 and P4 change what runs.

## 6. Risks

- **Breaking the runner's trust anchor.** P2 must read v2 files through the
  same `git show refs/remotes/origin/main:<path>` path the roster loader uses,
  and refuse on a missing ref exactly as today. The existing roster tests cover
  the refusal cases and are carried over, not converted.
- **A silent vendor switch on a critic.** Checked inside the walk; D4 keeps the
  walk opt in.
- **Fallback masking an outage.** Every switch is a run event; the improve
  report groups them.
- **Live write on a fallback route.** The walk filters to routes with `edit`
  and an audited edit profile, the same rule the lineup check enforces today.
- **`justfile` literals drifting from role files** until P2 lands. P1 adds a
  test that the literals match the first roster entry so the drift is visible.

## 7. Open questions

- Should `kxm plugin install --omp` write an omp `modelRoles` and
  `retry.fallbackChains` block from the role files, so the interactive omp
  session and the KXM route agree? Today omp runs grok at `high` and plans on
  Opus 5.5 while KXM runs grok at `medium` and plans on Fable.
- Does the Runtime supervisor classify provider errors well enough to drive
  `onError`, or does P4 need a classifier first?
- `task_d3e634858295` (role hosts, runner guide sweep) is archived with work
  open. P1 deletes role hosts; the tracker entry should say so when P1 lands.

## 8. Out of scope, recorded so it is not re-asked

- omp rules, hooks, commands, prompts, MCP and plugin surfaces.
- omp `workflowz` and `orchestrate` keyword contracts.
- omp `secrets.enabled` redaction: belongs with the safety plan.
- Widening the writer lineup or admitting any new route.
