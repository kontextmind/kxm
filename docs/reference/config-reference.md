# KXM configuration file reference

This page describes every file a KXM project or operator configures: where it
lives, which parser reads it, every field that parser accepts, the error codes
it reports, and which commands read or write it. It was written against the
parsers in `plugins/kxm/src` and `scripts/` for KXM 0.7.1, and every example on
this page was validated with the commands named next to it. Where a field is
accepted but nothing acts on it yet, the tables say so.

Related pages:

- [Configuration](configuration.md) lists the environment variables for the hub,
  workers, and agents.
- [Harness routing](harness-routing.md) explains when to run a model through its
  native harness and when to reach the same model through OpenRouter on Pi. This
  page documents the fields; that guide covers the decision.
- [Operations](../operations/deploy.md) covers backup and restore of every path below.

## At a glance

| File | Schema id | Purpose | Who writes it | Tracked in Git? |
|---|---|---|---|---|
| `.kxm/project.yaml` | `kxm.project.v1` | Project identity, repositories, defaults, run limits | You; `kxm init` creates it | Yes |
| `.kxm/repo/repo.yaml` (in each repository) | `kxm.repository.v1` | Per-repository definition | You; `kxm init` creates the control one | Yes, in the repository it describes |
| `.kxm/project/env.yaml`, `.kxm/repo/env.yaml` | `kxm.environment.v1` | Portable, non-secret environment | You | Yes |
| `.kxm/agents/<id>.yaml` | `kxm.agent.v1` | Agent harness, model, and permission ceilings | You; `kxm init` creates two | Yes |
| `.kxm/models/<id>.yaml` | `kxm.model.v1` | Named model profiles for selectors | You | Yes |
| `.kxm/workflows/<id>.yaml` | `kxm.workflow.v1` | Ordered steps and typed transitions | You; `kxm init` creates `default` | Yes |
| `.kxm/gates.yaml` | `kxm.gate-registry.v1` | The executable gate registry | You; `kxm init` creates it | Yes |
| `.kxm/roles/<role>.yaml` | `kxm.role.v1` | Model rosters per role | You, `kxm role`, `kxm models` | Yes |
| `.kxm/role-hosts.yaml` | `kxm.role-hosts.v1` | Role seat to host bindings (display only) | `kxm role set-host` | Yes, unless you ignore it |
| `.kxm/routes.yaml` | `kxm.routes.v2` | Admitted and disabled model routes | You, `kxm routes`, `kxm models` | Yes |
| `.kxm/roster.yaml` | `kxm.developer-roster.v1` | Developer assignment roster for the KXM source repository | Maintainers | Yes, and it must be committed |
| `.kxm/prices.yaml` | `kxm.prices.v1` | Dated, hash-pinned list prices | You | Yes |
| `.kxm/models/inventory.yaml` | `kxm.model-inventory.v1` | Discovered model catalog | `kxm models inventory-refresh` only | Your choice (generated) |
| `.kxm/config.yaml`, `~/.config/kxm/config.yaml` | `kxm.config.v1` | Personalization and hub auto-start | `kxm config set` | Project file: yes, unless ignored |
| `.kxm/modes.yaml` | `kxm.modes.v1` | Modes for `kxm explain` | You | Yes |
| `.kxm/template-provenance.yaml` | `kxm.template-provenance.v1` | Hashes of the built-in template | `kxm init` only | Yes |
| `.kxm/tasks/<id>.yaml`, `.kxm/goals/<id>.yaml` | `kxm.task.v1`, `kxm.goal.v1` | Work records | `kxm task`, `kxm goal` | Your choice |
| `.kxm/memory/*.md`, `.kxm/memory/candidates/*.md` | `kxm.memory.v1` | Project memory facts | You; `kxm memory note` writes candidates | Yes |
| `.kxm/skills/`, `.kxm/candidates/` | `kxm.skill-candidate.v1`, `kxm.candidate.v1` | Governed skills and improvement candidates | `kxm skills`, `kxm improve` | Yes |
| Webhook definitions (JSON file or variable) | none (JSON array) | Signed webhook workflows for the hub | You | Yes if stored in the repository, never with secrets |
| Claude Code plugin `userConfig` | Claude plugin manifest | Hub URL, token, agent identity for Claude Code | Claude Code, per user | No |
| `<state root>/update.yaml` | `kxm.update.v1` | Updater settings | You | No (host-local) |

`kxm init` does not write a `.gitignore`. See
[Workspace layout](#workspace-layout-tracked-ignored-and-state) for the entries
to add.

## How the files fit together

```text
.kxm/project.yaml ── repositories[] ──> .kxm/repo/repo.yaml (+ env.yaml) in each repository
   │ defaultWorkflow, defaultHarness, limits
   ▼
.kxm/workflows/<id>.yaml ── coordinator ──> .kxm/agents/coordinator.yaml
   │ steps[]
   ├─ kind agent | moa | approval | wait ──> .kxm/agents/<id>.yaml
   │                                           ├─ harness ──> pi | claude | codex | grok | agy | kimi | deepseek
   │                                           ├─ model ────> {provider, model} | {profile} | {tag}
   │                                           │                                    └─> .kxm/models/<id>.yaml
   │                                           └─ tools, repositories, network: permission ceilings
   └─ kind gate ──> .kxm/gates.yaml: command | artifacts-exist | reserved

Live dispatch admission (checked by the Runtime for every attempt):
   agent model "provider/model" ──> .kxm/routes.yaml: admitted and not disabled
                                └─> .kxm/roles/<role>.yaml roster, if that file exists
                                    (role = agent id; "writer" for agent "implementer")
   developer assignments (scripts/assignment-run.mjs) ──> .kxm/roster.yaml routes + lineup

Cost accounting:
   producer token usage ──> .kxm/prices.yaml (dated today, hash verified) ──> list estimate
   workflow limits.maxModelCost ──> sums only attempts recorded with costBasis "metered"
```

### What validates what

| Check | Files it covers | Where it runs |
|---|---|---|
| Project bundle load: restricted YAML, JSON Schema, cross-file semantics | `project.yaml`, every `repo.yaml` and `env.yaml`, `agents/`, `models/`, `workflows/`, `gates.yaml`, `template-provenance.yaml`, plus the `roles/writer.yaml` cross-check | `kxm init` (validate mode), `kxm run` and `kxm run --dry-run`, `kxm trust`, every Runtime request |
| Workflow compile | `workflows/` | `kxm run` when it creates a run |
| Runtime acceptance | Workflow steps, gate definitions, agent models, `routes.yaml`, `roles/` | `kxm runs drive` and live drives, per step |
| Permission diff | The bundle only | `kxm trust diff`, `kxm trust check` |
| Revisions pinned on every run | `configRevision` (the bundle), memory revision (`.kxm/memory` without `candidates/`, plus `.kxm/skills/promoted`), executor policy, tool policy (agent and step `tools` plus the gate registry) | `kxm run` |

Nothing validates `routes.yaml`, `roles/` (other than `writer.yaml`),
`role-hosts.yaml`, `roster.yaml`, `prices.yaml`, `inventory.yaml`,
`config.yaml`, `modes.yaml`, memory, tasks, goals, or webhook JSON during
`kxm init`. Their own readers report problems when they run. None of them are
part of `configRevision`, and `kxm trust check` does not see them: a change to
route admission or a role roster is not flagged as a permission expansion.

### Rules shared by the project bundle

These rules apply to the bundle files listed above.

- **Restricted YAML.** UTF-8, at most 256 KiB per file, nesting depth 32,
  64 KiB per scalar, 4,096 items per collection, 16,384 nodes, and 8,192
  mapping keys. Anchors (`anchor_forbidden`), aliases (`alias_forbidden`),
  custom tags (`tag_forbidden`), non-string keys (`non_string_key`), and
  duplicate keys (`invalid_yaml`) are rejected; YAML warnings are errors
  (`yaml_warning`); the root must be a mapping (`root_not_object`). Other
  files on this page use the general YAML parser, which accepts anchors.
- **Identity comes from the filename.** `.kxm/agents/reviewer.yaml` defines
  agent `reviewer`. Identifiers match `^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$`, are
  at most 64 characters, and cannot be a Windows device name such as `con` or
  `nul` (`resource_id_invalid`). The extension must be exactly `.yaml`; a
  `.yml` file is rejected (`resource_filename_invalid`). Subdirectories are
  rejected (`nested_resource_directory`), names that differ only by case
  collide (`resource_id_collision`), and symbolic links are rejected
  (`resource_symlink`, `resource_parent_symlink`).
- **Unknown fields fail closed** with `schema_additionalProperties`.
- **Schema errors** use the code `schema_<keyword>`, for example
  `schema_required`, `schema_enum`, `schema_const`, `schema_pattern`,
  `schema_type`, `schema_if`, `schema_not`, and `schema_oneOf`. A mistake inside
  a `oneOf` (gate definitions, transitions, model selectors) produces several
  errors at once; read them together.
- **Issues** are reported as `file: code: message` with a phase of
  `discovery`, `parse`, `schema`, `path`, `reference`, or `semantic`.
  `kxm init --json` returns them in `issues[]`.
- **Legacy JSON is refused.** `.kxm/config/agents.json`,
  `.kxm/config/gates.json`, or any `.kxm/config/workflows/*.json` makes the
  project unloadable (`legacy_state_unsupported`). If the bundle fails to load
  for any reason while a hub database exists at `.kxm/state/kxm.db`, `kxm init`
  reports mode `legacy` and adds `legacy_state_unsupported` to the real issues.
- **Where commands look.** `kxm init`, `kxm run`, and `kxm trust` find the
  project at the nearest Git root. `kxm routes`, `kxm role`, `kxm config`,
  `kxm memory`, `kxm task`, `kxm goal`, and `kxm explain` use the current
  directory (or `KXM_WORKDIR`). Run those from the project root; from a
  subdirectory they read or create a stray `.kxm/` there.
- **Commands rewrite whole files.** `kxm config set`, `kxm routes admit`, and
  the `kxm role` commands write the file back through a YAML serializer, so
  comments are dropped.

## `.kxm/project.yaml` (`kxm.project.v1`)

The authoritative project definition. Its presence at the Git root is what
makes a directory a KXM project. Parser: `loadKxmProject` in
`plugins/kxm/src/project-config.ts`; schema: `schemas/project.schema.json`.

| Field | Type and allowed values | Required, default | What reads it |
|---|---|---|---|
| `schema` | `kxm.project.v1` | Required | Loader |
| `id` | Opaque ID matching `^[a-z][a-z0-9]{1,15}_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$` | Required | Loader, Runtime. `kxm init` generates `prj_` plus 32 hex characters; `--project-id` must start with `prj_`. The Runtime binds one ID to one control root per state root, so a second checkout with the same ID is refused with `project_home_conflict`. |
| `name` | String, 1 to 120 characters | Required | Display only |
| `description` | String, at most 2,000 characters | Optional | Display only |
| `defaultWorkflow` | Identifier | Optional, `default` | Loader only: the named workflow must exist (`default_workflow_unknown`). `kxm run` always takes an explicit workflow. |
| `defaultExecutor` | `local`, `ssh`, or `exe-dev` | Optional | Loader (`executor_unknown`); recorded in the run's executor-policy revision |
| `defaultHarness` | `pi`, `claude`, `codex`, `grok`, `agy`, `kimi`, or `deepseek` | Optional, `pi` | Loader (`harness_unknown`); harness for agents without `harness`; fallback harness for live dispatch |
| `repositories` | Array of 1 to 64 entries | Required | Loader, Runtime |
| `repositories[].id` | Identifier | Required | Must be unique after case folding (`repository_id_collision`) |
| `repositories[].role` | `control` or `member` | Required | Exactly one `control` (`control_repository_count`) |
| `repositories[].required` | Boolean | Optional, `true` | A missing optional member is skipped |
| `repositories[].remoteIdentity` | String, at most 2,048 characters | Optional | Not read by any code path yet; diffed by `kxm trust` |
| `repositories[].defaultBranch` | String, at most 255 characters | Optional | Not read by any code path yet; diffed by `kxm trust` |
| `repositories[].pathHint` | Portable forward-slash relative path | Optional | The control repository must use `.`; a member path must stay inside the project root |
| `workspace.dirtySnapshot.untracked` | `bounded`, `tracked-only`, or `ask` | Optional | Not read by any code path yet; diffed as snapshot policy |
| `workspace.dirtySnapshot.maxUntrackedFileBytes` | Integer, 1 to 1,073,741,824 | Required when `untracked: bounded` | Not read by any code path yet |
| `workspace.dirtySnapshot.maxUntrackedTotalBytes` | Integer, 1 to 10,737,418,240 | Required when `untracked: bounded` | Not read by any code path yet |
| `workspace.dirtySnapshot.dirtySubmodules` | `fail` | Optional | Not read by any code path yet |
| `sync.prompts`, `sync.results`, `sync.evidence`, `sync.artifacts`, `sync.fileChanges` | Exactly `title-only`, `bounded-summary`, `references`, `metadata`, `paths-only` | Optional | Not read by any code path yet; diffed as sync policy |
| `sync.rawLogs`, `sync.diffs`, `sync.environmentValues` | Exactly `false` | Optional | Not read by any code path yet |
| `limits.maxConcurrentRuns` | Integer, 1 to 128 | Optional, `1` | Runtime admission. A changed bound is refused (`scheduler_policy_conflict`) while admitted or queued runs still use the previous one. |
| `limits.maxRunDurationMs` | Integer, 0 to 31,536,000,000 | Optional | Runtime. Combined with the workflow's own value; the smaller one wins. |
| `limits.maxAgentTimeMs` | Integer, 0 to 31,536,000,000 | Optional | Runtime refuses to drive any run while it is set (`limit_unsupported`); leave it out |

Example (validated with `kxm init --json`, including a nested member checkout
at `repositories/api`):

```yaml
# .kxm/project.yaml — one per control repository.
schema: kxm.project.v1
id: prj_01JEXAMPLE0000000000000000   # opaque, stable; never reuse across projects
name: Payments Platform
description: Control project with one optional member repository.
defaultWorkflow: review               # must name a file in .kxm/workflows/
defaultExecutor: local                # local | ssh | exe-dev
defaultHarness: pi                    # pi | claude | codex | grok | agy | kimi | deepseek
repositories:
  - id: control                       # exactly one control repository
    role: control
    required: true
    pathHint: .                       # control must use "."
  - id: api
    role: member
    required: false                   # optional: a missing checkout is skipped
    remoteIdentity: ssh://git.example.test/payments/api.git
    defaultBranch: main
    pathHint: repositories/api        # portable forward-slash path under the project root
workspace:
  dirtySnapshot:
    untracked: bounded                # bounded | tracked-only | ask
    maxUntrackedFileBytes: 26214400   # required when untracked is bounded
    maxUntrackedTotalBytes: 262144000
    dirtySubmodules: fail             # the only accepted value
sync:
  prompts: title-only
  results: bounded-summary
  evidence: references
  artifacts: metadata
  fileChanges: paths-only
  rawLogs: false
  diffs: false
  environmentValues: false
limits:
  maxConcurrentRuns: 2
  maxRunDurationMs: 14400000
```

### Repository binding rules and error codes

The loader resolves each repository to a directory: the project root for the
control repository, a host-local binding from `kxm init --repository
<id>=<absolute path>` when one exists, or `pathHint` otherwise.

| Code | Meaning |
|---|---|
| `control_repository_count` | Not exactly one repository has `role: control` |
| `control_repository_path_invalid` | The control repository's `pathHint` is not `.` |
| `control_repository_binding_invalid` | A host-local binding for the control repository points somewhere other than the project root |
| `repository_id_collision` | Two repository IDs differ only by case |
| `portable_path_invalid` | `pathHint` is absolute, uses `\`, contains `.` or `..` segments, or names a Windows device |
| `repository_binding_path_link` | `pathHint` traverses a symbolic link or junction |
| `repository_binding_outside_project` | `pathHint` resolves outside the project root |
| `repository_binding_missing` | A required member has neither `pathHint` nor a host-local binding |
| `repository_binding_unavailable` | A required or explicitly bound repository directory does not exist |
| `repository_binding_invalid` | The binding is a link or not a directory |
| `repository_git_root_invalid` | A member binding is not the root of its own Git worktree |
| `repository_binding_collision` | Two repository IDs resolve to the same directory |
| `repository_binding_id_invalid`, `repository_binding_unknown`, `repository_binding_not_absolute` | A `--repository` binding names an invalid or undeclared ID, or a relative path |
| `default_workflow_unknown`, `executor_unknown`, `harness_unknown` | A default names something that does not exist or is not registered |

`kxm trust` can only diff a member that is a Git submodule (gitlink) at
`pathHint` or a host-local binding. A nested, ignored member checkout makes
`kxm trust` fail with `trust_scope_unsupported`.

Commands: `kxm init` creates, validates, repairs, and binds; `kxm run`,
`kxm trust diff|check`, `kxm tenant status`, and every Runtime request load it.

## `.kxm/repo/repo.yaml` (`kxm.repository.v1`)

One file per bound repository, stored in that repository: the control
repository's is `<project root>/.kxm/repo/repo.yaml`, and a member's is
`<member checkout>/.kxm/repo/repo.yaml`. Issues for it are reported under the
logical path `.kxm/repositories/<id>/repo.yaml`. It is required for every
required or explicitly bound repository (`repository_definition_missing`).

| Field | Type and allowed values | Required, default | What reads it |
|---|---|---|---|
| `schema` | `kxm.repository.v1` | Required | Loader |
| `projectId` | Opaque ID | Required | Must equal `project.yaml` `id` (`repository_project_mismatch`) |
| `repositoryId` | Identifier | Required | Must be declared in `project.yaml` (`repository_definition_unknown`) and match the binding it was found under (`repository_binding_identity_mismatch`) |
| `description` | String, at most 2,000 characters | Optional | Display only |
| `ecosystems` | Unique identifiers, at most 16 | Optional | Not read by any code path yet; diffed by `kxm trust` |
| `classification` | `public`, `internal`, or `sensitive` | Optional | Not read by any code path yet; diffed by `kxm trust` |
| `defaultAccess` | `none`, `read`, or `write` | Optional | Not read by any code path yet; diffed by `kxm trust`. Agent access ceilings come from agent files. |

```yaml
# .kxm/repo/repo.yaml — lives in the repository it describes.
schema: kxm.repository.v1
projectId: prj_01JEXAMPLE0000000000000000   # must equal project.yaml id
repositoryId: control                      # must match the project.yaml repositories[].id
description: Authoritative project configuration and application code.
ecosystems:
  - node
classification: internal                   # public | internal | sensitive
defaultAccess: write                       # none | read | write
```

Commands: the same as `project.yaml`.

## Environment files (`kxm.environment.v1`)

Portable, non-secret environment declarations. The project file is
`.kxm/project/env.yaml`. Any bound repository, the control repository
included, may also carry `.kxm/repo/env.yaml`, which requires a valid
`repo.yaml` in the same repository
(`repository_environment_without_definition`).

| Field | Type and allowed values | Required, default | Notes |
|---|---|---|---|
| `schema` | `kxm.environment.v1` | Required | |
| `values` | Map of name to string (at most 4,096 characters), number, or boolean; at most 256 entries | Optional | Names match `^[A-Z_][A-Z0-9_]*$` and may not contain `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`, `API_KEY`, `CREDENTIAL`, `DATABASE_URL`, or `CONNECTION_STRING` (`schema_not`) |
| `secrets[].name` | Environment name | Required per entry | Unique (`secret_name_duplicate`); may not also appear in `values` (`environment_name_conflict`) |
| `secrets[].ref` | Identifier | Required per entry | A secret reference resolved outside Git |
| `secrets[].required` | Boolean | Optional, `true` | |
| `path.prepend`, `path.append` | Unique portable relative paths, at most 32 each | Optional | `portable_path_invalid` otherwise |

A value that looks like a credential (a private-key header, a `ghp_` or
`github_pat_` token, an `sk-` key, a Slack `xox` token, an AWS `AKIA` key, or a
JWT) is rejected with `probable_secret_value`.

No Runtime path applies these values to a process yet. They are validated,
pinned in `configRevision`, and diffed by `kxm trust` (values redacted).

```yaml
# .kxm/project/env.yaml — portable, non-secret environment for the project.
schema: kxm.environment.v1
values:
  CI: false
  NODE_OPTIONS: --max-old-space-size=4096
secrets:
  - name: TEST_DATABASE_URL     # variable name the process sees
    ref: test-database-url      # secret reference, resolved outside Git
    required: false
path:
  prepend:
    - tools/bin
```

## `.kxm/agents/<id>.yaml` (`kxm.agent.v1`)

One file per agent; the filename is the agent ID that workflow steps
reference. Schema: `schemas/agent.schema.json`; semantic checks in
`validateBundle` in `plugins/kxm/src/project-config.ts`.

| Field | Type and allowed values | Required, default | What reads it |
|---|---|---|---|
| `schema` | `kxm.agent.v1` | Required | Loader |
| `purpose` | String, 1 to 2,000 characters | Required | Display; neutral in `kxm trust` |
| `instructions` | String, at most 16,000 characters | Optional | Not read by any code path yet. Step `instructions` are what reach the prompt. |
| `harness` | `pi`, `claude`, `codex`, `grok`, `agy`, `kimi`, or `deepseek` | Optional, the project's `defaultHarness` | Loader (`harness_unknown`, harness and model pairing); live dispatch launches this harness |
| `model` | One selector: `{provider, model}`, `{profile}`, or `{tag, capabilities}` | Optional | See [Model selectors](#model-selectors) |
| `executor` | `local`, `ssh`, or `exe-dev` | Optional | Loader (`executor_unknown`); recorded in the executor-policy revision; no dispatch path selects an executor from it yet |
| `tools.preset` | `coordinator`, `read-only`, `workspace-writer`, or `tests-writer` | Optional | Loader (`tool_preset_unknown`); pinned in the tool-policy revision |
| `tools.allow`, `tools.deny` | Unique identifiers, at most 128 each | Optional | A tool in both lists is `tool_policy_contradiction`; steps may only narrow the ceiling |
| `defaultRepositoryAccess` | `none`, `read`, or `write` | Optional; the ceiling is `none` when absent | Loader: access ceiling for repositories not listed in `repositories` |
| `repositories` | Map of repository ID to `none`, `read`, or `write`; at most 64 | Optional | Loader: per-repository access ceiling; IDs must be declared (`repository_unknown`) |
| `secrets[].ref` | Identifier | Required per entry | Loader: steps may only request refs granted here |
| `secrets[].as` | Environment name, `^[A-Z_][A-Z0-9_]*$` | Optional | Not read by any code path yet |
| `secrets[].required` | Boolean | Optional, `true` | Not read by any code path yet |
| `network` | `none`, `provider-only`, `restricted`, or `host` (ranked in that order) | Optional | Not enforced yet; `kxm trust` reports a move up the ranking as an expansion |
| `resultSchema` | String, at most 512 characters | Optional | Not read by any code path yet; diffed by `kxm trust` |
| `session.reuse` | `compatible-run-scope` | Optional | Not read by any code path yet |
| `session.maxIdleMs` | Integer, 0 to 31,536,000,000 | Optional | Not read by any code path yet |

Tool presets are names checked against a registered list. The live one-shot
producer launches every harness with a fixed read-only argument set
(`READ_ONLY_ONESHOT_ARGS` in `plugins/kxm/src/harness.ts`); it does not
translate `tools` into harness flags. The Runtime refuses live steps that
request `write` access until the writer sandbox is in place, so a step that
writes a repository runs today only under the simulated producer.

### Model selectors

A selector has exactly one of three shapes (`common.schema.json#/$defs/modelSelector`):

| Shape | Fields | Resolves to |
|---|---|---|
| Direct | `provider` (identifier), `model` (1 to 200 characters) | That provider and model. The route string is `provider/model`, for example `openrouter/qwen/qwen3-coder-plus`. |
| Profile | `profile` (identifier) | `.kxm/models/<profile>.yaml` (`model_profile_unknown` if missing) |
| Tag | `tag` (identifier), optional `capabilities` (identifiers) | Every profile carrying the tag and all listed capabilities (`model_tag_unresolved` if none) |

For live dispatch, only the direct shape works. The Runtime reads the agent's
`model.provider` and `model.model` and joins them into the route string; a
profile or tag selector validates at load time but live dispatch refuses the
step with `producer_route_unsupported: invalid model declaration`. An agent
with no model is refused too, except that an agent named `implementer`
without a model falls back to `xai/grok-4.6`.

### Harness and model pairing

The loader checks that the agent's harness can host its model, using
`validateHarnessModelPair` in `plugins/kxm/src/harness.ts`. It applies this
check only to models reached through a profile or tag selector. A direct
`{provider, model}` selector is not checked at load time; the live producer
checks it when it probes the harness before dispatch.

| Harness | Accepts |
|---|---|
| `claude` | Provider `anthropic`; rejects model IDs starting with `gpt-`, `o1-`, `o3-`, `grok-`, `gemini-`, `kimi-`, `moonshot-`, `deepseek-`, or `qwen-` |
| `codex` | Provider `openai`; rejects `claude-`, `fable-`, `grok-`, `gemini-`, `kimi-`, `moonshot-`, `deepseek-`, and `qwen-` models |
| `grok` | Provider `xai` and `grok-` models |
| `agy` | Provider `google` and `gemini-` models |
| `kimi` | Provider `moonshot` and `kimi`, `moonshot`, or `kimi-for-coding` models |
| `deepseek` | Provider `deepseek` and `deepseek-` models |
| `pi` | Any provider except `anthropic`, `openai`, `xai`, `moonshot`, `google`, and `deepseek` (`pi_native_impersonation_blocked`); use the native harness for those |

A mismatch is reported as `harness_unhosted_model`. Which route to choose for a
model that more than one harness can reach is covered in
[Harness routing](harness-routing.md).

### Live dispatch requirements

Before a live attempt, the Runtime (`resolveProducerRoute` in
`plugins/kxm/src/engine.ts`) requires all of the following. A failure hands the
run off with `step_unsupported` and a `producer_route_unsupported` detail.

1. The agent declares a direct `{provider, model}` selector (see above).
2. `provider/model` is listed in `.kxm/routes.yaml` `admitted` and not in
   `disabled`.
3. If `.kxm/roles/<role>.yaml` exists, its roster contains exactly
   `provider/model`. The role is the agent ID, except that agent
   `implementer` maps to role `writer`.

Example (validated with `kxm init --json`):

```yaml
# .kxm/agents/implementer.yaml — the filename is the agent id.
schema: kxm.agent.v1
purpose: Implement the approved change within the declared repository scope.
instructions: Keep changes inside the files named by the approved plan.
harness: grok                     # pi | claude | codex | grok | agy | kimi | deepseek
model:                            # direct selector: provider + model
  provider: xai
  model: grok-4.6
executor: local                   # local | ssh | exe-dev
tools:
  preset: workspace-writer        # coordinator | read-only | workspace-writer | tests-writer
  allow: [read, edit, write, bash]
  deny: [web_fetch]
defaultRepositoryAccess: none     # ceiling for repositories not listed below
repositories:
  control: write
  api: write
secrets:
  - ref: npm-token                # secret reference name
    as: NPM_TOKEN                 # environment variable name inside the attempt
    required: false
network: provider-only            # none | provider-only | restricted | host
resultSchema: kxm.assignment-result.v1
session:
  reuse: compatible-run-scope
  maxIdleMs: 1800000
```

A critic that uses a profile selector:

```yaml
schema: kxm.agent.v1
purpose: Architecture critic for the approved change.
harness: claude
model:
  profile: critic-claude          # profile selector: .kxm/models/critic-claude.yaml
tools:
  preset: read-only
defaultRepositoryAccess: read
network: provider-only
resultSchema: kxm.assignment-result.v1
```

Error codes: `executor_unknown`, `harness_unknown`, `tool_preset_unknown`,
`tool_policy_contradiction`, `repository_unknown`, `model_profile_unknown`,
`model_tag_unresolved`, `harness_unhosted_model`,
`pi_native_impersonation_blocked`, the path codes under
[Rules shared by the project bundle](#rules-shared-by-the-project-bundle), and
`role_roster_conflicts_with_agent` (see [Roles](#kxmrolesroleyaml-kxmrolev1)).

Commands: `kxm init` creates `coordinator` and `implementer`; an interactive
`kxm init` can add workflow-guide agents for authenticated harnesses; `kxm run`
and the Runtime read them; `kxm trust` diffs them.

## `.kxm/models/<id>.yaml` (`kxm.model.v1`)

Named model profiles that agent and step selectors can reference by `profile`
or `tag`. The filename is the profile ID; `inventory.yaml` in the same
directory is reserved for the generated inventory and is skipped by this
loader.

| Field | Type and allowed values | Required, default | What reads it |
|---|---|---|---|
| `schema` | `kxm.model.v1` | Required | Loader |
| `provider` | Identifier | Required | Loader: selector resolution, harness pairing, provider diversity |
| `model` | String, 1 to 200 characters | Required | Loader: same |
| `thinking` | String, 1 to 64 characters | Optional | Not read by any code path yet |
| `tags` | Unique identifiers, at most 32 | Optional | Loader: `tag` selectors |
| `capabilities` | Unique identifiers, at most 32 | Optional | Loader: `tag` selectors with `capabilities` |
| `priority` | Integer, -10,000 to 10,000 | Optional | Not read by any code path yet |
| `fallbacks` | Up to 8 selectors | Optional | Loader checks references (`model_profile_unknown`, `model_tag_unresolved`) and cycles (`model_fallback_cycle`); nothing fails over yet |
| `limits.contextTokens`, `limits.outputTokens` | Integer, at least 1 | Optional | Not read by any code path yet |
| `limits.timeoutMs` | Integer, 0 to 31,536,000,000 | Optional | Not read by any code path yet |

Profiles are load-time data only. The Runtime's live route resolution reads
the agent file directly and does not consult profiles.

```yaml
# .kxm/models/critic-claude.yaml — the filename is the profile id.
schema: kxm.model.v1
provider: anthropic
model: fable
thinking: high
tags: [critic]
capabilities: [tools, structured-output]
priority: 100
fallbacks:
  - profile: critic-sol
limits:
  contextTokens: 200000
  outputTokens: 32000
  timeoutMs: 1800000
```

Commands: the loader in `kxm init`, `kxm run`, and `kxm trust`.

## `.kxm/workflows/<id>.yaml` (`kxm.workflow.v1`)

An ordered list of steps with typed transitions. The filename is the workflow
ID used by `kxm run <workflow>`. Three layers check it:

1. The loader (`schemas/workflow.schema.json` plus `validateWorkflow` in
   `plugins/kxm/src/project-config.ts`) on every project load.
2. The compiler (`compileKxmWorkflow` in `plugins/kxm/src/engine-compile.ts`)
   when `kxm run` creates a run. It pins the compiled plan on the run.
3. Runtime acceptance (`plugins/kxm/src/engine.ts`) before each step executes.
   A step the current Runtime cannot execute hands the run off instead of
   running it.

### Top-level fields

| Field | Type and allowed values | Required, default | Notes |
|---|---|---|---|
| `schema` | `kxm.workflow.v1` | Required | |
| `description` | String, at most 4,000 characters | Optional | Prose; neutral in `kxm trust` |
| `coordinator` | Agent ID | Optional, `coordinator` | Must exist (`coordinator_unknown`); pinned on the compiled plan. Approval and wait steps without `assignments.allowedAgents` are dispatched to the agent whose ID is literally `coordinator`, not to this field's value. |
| `limits.maxTransitions` | Integer, 1 to 1,000 | Required once any back-edge exists (`workflow_cycle_unbounded`) | Run-wide transition budget; defaults to the number of steps. Exceeding it fails the run with `budget_transitions`. |
| `limits.maxRunDurationMs` | Integer, 0 to 31,536,000,000 | Optional | The Runtime cancels the run with `budget_run_duration`; the smaller of this and the project limit applies |
| `limits.maxAgentTimeMs` | Integer, 0 to 31,536,000,000 | Optional | The Runtime refuses to drive a run that declares it (`limit_unsupported`; the CLI reports `run_handoff_required`). The built-in template sets it, so the template's `default` workflow cannot be driven as generated. |
| `limits.maxModelCost` | Number greater than 0 | Optional | Fails the run with `budget_model_cost` once attempts recorded with cost basis `metered` reach it. See [Cost basis](#cost-basis-and-staleness). |
| `limits.currency` | Three uppercase letters | Optional | Pinned on the plan; not otherwise read |
| `planHash` | `{stageId, evidenceKey}` | Optional | When `stageId` passes, the hash of that evidence is captured. The step must declare that evidence key (`oracle_evidence_unknown`, `oracle_stage_unknown`). |
| `reproOracle` | `{stageId, evidenceKey}` | Optional | Same shape as `planHash`, for an immutable reproduction |
| `requirePlanHash` | Unique step IDs, at most 128 | Optional | Requires `planHash` (`plan_hash_missing`); every step that writes a repository after the `planHash` stage must be listed (`mutation_missing_plan_hash`) |
| `steps` | 1 to 128 steps | Required | The first step is the entry point |

### Step fields

| Field | Type and allowed values | Required, default | Notes |
|---|---|---|---|
| `id` | Identifier | Required | Unique (`step_id_duplicate`) |
| `kind` | `agent`, `moa`, `gate`, `approval`, or `wait` | Required | `workflow` is reserved and rejected |
| `description` | String, at most 2,000 characters | Optional | Prose |
| `instructions` | String, at most 16,000 characters | Optional | Prepended to the generated prompt for the step |
| `agent` | Agent ID | Required for `agent` and `moa` | `agent_unknown`. When `assignments.allowedAgents` is set, it must include this agent (`primary_agent_ineligible`). |
| `gate` | Gate ID from `.kxm/gates.yaml` | Required for `gate` | `gate_unknown`; `gate_registry_missing` when there is no `gates.yaml` |
| `expect` | `pass` or `fail` | Optional, `pass`; gate steps only | `gate_expect_invalid` on other kinds |
| `signal` | Identifier | Required for `wait` | Compiled and diffed; the Runtime does not match signals to wait steps yet |
| `model` | Model selector | Optional | Intersected with each allowed agent's own model ceiling; an empty intersection is `model_selector_incompatible`. Live route resolution ignores it. The Runtime refuses it on gate steps. |
| `maxAttempts` | Integer, 1 to 20 | Optional, `1` | Entering the step again after this many attempts fails the run (`budget_step_attempts`) |
| `timeoutMs` | Integer, 0 to 31,536,000,000 | Optional | Gate steps: refused on `artifacts-exist` gates and when shorter than the command gate's own `timeoutMs`. Other kinds: pinned but not passed to the producer yet (the live one-shot producer uses its own 120-second process timeout). `0` is refused. |
| `repositories` | Map of repository ID to `none`, `read`, or `write` | Optional | IDs must be declared (`repository_unknown`); may not exceed the agent's ceiling (`repository_scope_expansion`) |
| `tools` | `{preset, allow, deny}` | Optional | Must keep the agent's preset and denials and allow only tools the agent allows (`tool_scope_expansion`). The Runtime refuses steps that declare `tools`. |
| `secrets` | `[{ref, as, required}]` | Optional | Only refs the agent grants (`secret_scope_expansion`). The Runtime refuses steps that declare `secrets`. |
| `assignments` | See the next table | Optional | |
| `join` | See the next table | Optional, `{strategy: all}` | |
| `requiredEvidence` | Up to 64 requirements | Optional | See [Evidence](#evidence-requirements) |
| `safeSpeculation` | Boolean | Optional, `false` | Required `true` with `join.strategy: first-success`. The Runtime refuses it. |
| `on` | Map of outcome to transition, 1 to 32 entries | Required (`step_transitions_missing` when absent) | See [Transitions](#transitions-and-outcomes) |

Fields such as `role`, `area`, or `outcomes` are not part of this schema and
fail with `schema_additionalProperties`. `area` belongs to
[webhook workflow stages](#webhook-workflow-definitions); the compiled plan
derives its outcome list from the keys of `on`.

### Assignments and join

| Field | Type and allowed values | Default | Notes |
|---|---|---|---|
| `assignments.allowedAgents` | 1 to 32 unique agent IDs | `[agent]`, or none on steps without `agent` | `assignment_agent_unknown`; every listed agent's ceilings are checked |
| `assignments.minimum` | Integer, 1 to 64 | `1` | `minimum <= target <= maximum` (`assignment_bounds_invalid`) |
| `assignments.target` | Integer, 1 to 64 | `minimum` | |
| `assignments.maximum` | Integer, 1 to 64 | `target` | For `moa`, at most the number of allowed agents (`assignment_pool_too_small`) |
| `assignments.maxParallel` | Integer, 1 to 64 | `maximum` | At most `maximum` (`assignment_parallelism_invalid`) |
| `assignments.maxAttemptsPerAssignment` | Integer, 1 to 20 | `1` | The Runtime executes at most 2 |
| `assignments.maxWriteRepositories` | Integer, 1 to 64 | none | At most the number of `write` repositories on the step (`write_repository_bound_invalid`); the Runtime executes at most 1 |
| `assignments.distinctBy` | Any of `provider`, `model`, `profile` | `[]` | The resolved candidates must offer `target` distinct values (`model_diversity_impossible`); the Runtime executes only `provider` |
| `join.strategy` | `all`, `all-settled`, `quorum`, or `first-success` | `all` | The Runtime executes `all` and `all-settled` |
| `join.minimumPassed` | Integer, 1 to 64 | none | Required for `quorum`; at most `maximum` (`join_impossible`); the Runtime accepts it only with `all-settled` |
| `join.cancelRemaining` | Boolean | none | The Runtime refuses it |

### Evidence requirements

| Field | Type and allowed values | Default | Notes |
|---|---|---|---|
| `key` | Identifier | Required | Unique per step (`evidence_key_duplicate`) |
| `kind` | `assignment-result`, `gate`, `receipt`, `approval`, or `artifact` | Required | |
| `minimum` | Integer, 1 to 16 | `1` | |
| `reusableAcrossAttempts` | Boolean | `false` | |
| `producerPolicy.minimumProducers` | Integer, 1 to 16 | Required in a policy | At most the step's `target` and the eligible count (`producer_minimum_impossible`) |
| `producerPolicy.eligibleAgents` | 1 to 32 agent IDs | Required in a policy | Must exist (`producer_agent_unknown`) and be in `allowedAgents` (`producer_agent_ineligible`) |
| `producerPolicy.acceptedStatuses` | Exactly `[passed]` | Required in a policy | |
| `producerPolicy.degradation.minimumProducers` | Integer, 1 to 15 | Optional | Must be lower than `minimumProducers` (`producer_degradation_invalid`) |

A `producerPolicy` is allowed only on `kind: assignment-result`.

### Transitions and outcomes

Each key of `on` is an outcome identifier. Each value is either a step ID
(shorthand) or an object:

| Field | Type and allowed values | Notes |
|---|---|---|
| `target` | Step ID or `$terminal` | `transition_target_unknown` if the step does not exist |
| `maxTransitions` | Integer, 1 to 100 | Required on a back-edge, meaning a target at or before the current step (`back_edge_unbounded`). Exceeding it fails the run with `budget_edge`. |
| `terminalStatus` | `completed`, `failed`, or `cancelled` | Required when `target` is `$terminal` and forbidden otherwise |

Graph rules checked by the loader:

- Every step must be reachable from the first step (`step_unreachable`).
- Every reachable step must have a path to a terminal transition
  (`step_cannot_terminate`).
- No path that ends in `terminalStatus: completed` may skip a `gate` or
  `approval` step (`required_step_bypass`).
- If steps named `verify` and `ready` both exist, `verify` must transition to
  `ready` and no other step may (`verify_must_precede_ready`).
- On gate steps, `implementation_failure` and `repro_missing` are misspellings
  of `implementation-failure` and `repro-missing` (`gate_outcome_renamed`).
- A gate step settles only on `passed` or `implementation-failure` when
  `expect` is `pass`, and only on `passed` or `repro-missing` when `expect` is
  `fail`. A gate step is refused when it declares an outcome it never
  produces (such as `failed`) and also leaves an outcome it does produce
  undeclared (`gate_outcome_impossible`); the message names the outcomes to
  declare. An extra outcome next to every produced one is accepted, which is
  why the `verify` step `kxm init` writes, with `failed` beside
  `implementation-failure`, still loads.

Outcomes the Runtime produces:

| Step | Outcome |
|---|---|
| Command gate, `expect: pass` | Exit code 0 gives `passed`; any other exit gives `implementation-failure` |
| Command gate, `expect: fail` | Exit code 0 gives `repro-missing`; any other exit gives `passed` |
| `artifacts-exist` gate | All paths present gives `passed`; otherwise `implementation-failure` (`expect: fail` is refused) |
| Agent step | The producer asks the model for a JSON object whose `outcome` is one of the step's declared outcomes; anything else becomes `failed` |

Declare `passed` and `implementation-failure` on every `expect: pass` gate
step, and `passed` and `repro-missing` on every `expect: fail` gate step. A
gate step that routes a failure on `failed` instead of `implementation-failure`
is refused when the project loads (`gate_outcome_impossible`), so `kxm init`,
`kxm run`, and `kxm run --dry-run` report it before a run exists. Without that
check, a failing gate attempt could not settle: the Runtime records the
produced outcome, finds no transition for it, hands the run off with
`attempt_unsettled`, leaves it `running`, and holds later gate steps in the
same project with `gate_recovery_pending`.

The Runtime's drive-time pre-flight check is separate. It hands off
(`gate_outcome_undeclared`) an `expect: pass` gate step without `passed`, an
`expect: fail` gate step without `repro-missing`, and any gate step that
declares no failure outcome, accepting either `implementation-failure` or
`failed` as that outcome. An `expect: fail` gate step therefore also needs
`implementation-failure` or `failed` declared to be driven, although it never
produces either. Declare `failed` on every agent step, because the producer
falls back to it.

### Steps the Runtime does not execute yet

Validation accepts more than the Runtime executes. When a drive reaches one of
these, the run is handed off (`step_unsupported`, `gate_unsupported`, or
`limit_unsupported`) instead of executing:

- `limits.maxAgentTimeMs` in the workflow or project.
- `tools`, `secrets`, or `safeSpeculation: true` on any step.
- `join.strategy` other than `all` or `all-settled`, `join.minimumPassed` with
  `all`, and `join.cancelRemaining`.
- `assignments.maxAttemptsPerAssignment` above 2,
  `assignments.maxWriteRepositories` above 1, and `distinctBy` other than
  `provider`.
- A live (non-simulated) step with `write` access to any repository.
- Gate steps with `assignments.allowedAgents`, any assignment count or
  `maxAttemptsPerAssignment` other than 1, `distinctBy`,
  `maxWriteRepositories`, a join other than plain `all`, a `model`, no
  `repositories`, or the role of `planHash` or `reproOracle` stage; a command
  gate with no `write` repository; an `artifacts-exist` gate without `read` or
  `write` access to `control` or with access to any other repository; a
  `reserved` gate.

The Runtime also caps each run at 100 attempts whose cost basis is `unmetered`
or `unknown` (`budget_unmetered_attempts`).

Example (validated with `kxm init --json` and compiled with
`compileKxmWorkflow`). Besides the `implementer` and `critic-arch` agents and
the `critic-claude` profile shown above, it needs a `coordinator` agent, a
`planner` agent (harness `claude`, model `anthropic/fable`, read access), a
`critic-cli` agent (harness `codex`, model `openai/gpt-5.6-sol`, read access),
and a second profile tagged `critic`, `critic-sol` (`openai/gpt-5.6-sol`).
The two providers among the `critic` candidates satisfy
`distinctBy: [provider]` with `target: 2`.

```yaml
# .kxm/workflows/review.yaml — the filename is the workflow id.
schema: kxm.workflow.v1
description: Plan, implement, review with two critics, verify, approve, and wait for CI.
coordinator: coordinator            # agent id; defaults to "coordinator"
limits:
  maxTransitions: 12                # required once any back-edge exists
  maxRunDurationMs: 14400000
  maxModelCost: 25
  currency: USD
planHash:                           # capture the approved plan when "plan" passes
  stageId: plan
  evidenceKey: plan
requirePlanHash:                    # writing steps after "plan" must be listed here
  - implement
  - verify
steps:
  - id: plan
    kind: agent
    agent: planner
    description: Produce an implementation plan.
    instructions: Write the plan as a numbered list of file-level changes.
    maxAttempts: 2
    timeoutMs: 1200000
    repositories:
      control: read
    requiredEvidence:
      - key: plan
        kind: artifact
    on:
      passed: implement             # shorthand transition: a step id
      blocked:
        target: $terminal
        terminalStatus: failed

  - id: implement
    kind: agent
    agent: implementer
    maxAttempts: 3
    repositories:
      control: write
    assignments:
      allowedAgents: [implementer]
      minimum: 1
      target: 1
      maximum: 1
      maxParallel: 1
      maxAttemptsPerAssignment: 2
      maxWriteRepositories: 1
    requiredEvidence:
      - key: diff
        kind: artifact
    on:
      passed: review
      failed:
        target: $terminal
        terminalStatus: failed

  - id: review
    kind: moa                       # panel of agents
    agent: critic-arch              # primary agent; must be in allowedAgents
    model:
      tag: critic                   # intersected with each agent's own model ceiling
    repositories:
      control: read
    assignments:
      allowedAgents: [critic-arch, critic-cli]
      minimum: 2
      target: 2
      maximum: 2
      maxParallel: 2
      distinctBy: [provider]
    join:
      strategy: all-settled
      minimumPassed: 2
    requiredEvidence:
      - key: review
        kind: assignment-result
        producerPolicy:
          minimumProducers: 2
          eligibleAgents: [critic-arch, critic-cli]
          acceptedStatuses: [passed]
          degradation:
            minimumProducers: 1
    on:
      passed: verify
      changes-requested:            # back-edge: needs maxTransitions
        target: implement
        maxTransitions: 2

  - id: verify
    kind: gate
    gate: test                      # key in .kxm/gates.yaml
    expect: pass                    # pass | fail (gate steps only)
    maxAttempts: 2
    repositories:
      control: write
    requiredEvidence:
      - key: tests
        kind: gate
    on:
      passed: approve
      implementation-failure:
        target: implement
        maxTransitions: 2

  - id: approve
    kind: approval
    requiredEvidence:
      - key: signoff
        kind: approval
    on:
      passed: ci
      rejected:
        target: $terminal
        terminalStatus: cancelled

  - id: ci
    kind: wait
    signal: ci-checks
    timeoutMs: 86400000
    requiredEvidence:
      - key: ci
        kind: receipt
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: $terminal
        terminalStatus: failed
```

This example validates, but a live drive would be handed off at `implement`
(write access), at `review` (`critic-arch` uses a profile selector), and at
`approve` and `ci` (dispatched to `coordinator`, which declares no model). Use
it as a field reference; the
[worked example](#worked-example-a-minimal-two-step-project) is one that runs.

Commands: `kxm init` validates; `kxm run <id> [prompt]` compiles and creates a
run (`--dry-run` only loads the bundle); `kxm runs drive <runId> --simulated`
drives without models; `kxm runs status|list|cancel`; `kxm trust` diffs.
`kxm workflow add <id> --template <name>` writes a built-in template
(`implement-and-verify`, `dual-critic-review`, or `spec-and-plan`), and
`kxm workflow add <id>` a one-step scaffold, under `.kxm/workflows/` (or
`~/.config/kxm/workflows/` with `--scope global`, which the loader never
reads). Both are valid `kxm.workflow.v1` definitions that use only what
`kxm init` creates: the `coordinator` and `implementer` agents, the `control`
repository, and the `test` gate. The templates route gate failures on
`implementation-failure`. Review the new file with `kxm trust check` before
committing it.

## `.kxm/gates.yaml` (`kxm.gate-registry.v1`)

The only place a gate ID becomes executable. A workflow gate step names a key
of `gates`. Schema: `schemas/gate-registry.schema.json`; the executable check is
in `validateBundle`; execution is in `plugins/kxm/src/engine-command.ts` and
`plugins/kxm/src/engine-artifacts.ts`.

| Field | Type and allowed values | Required, default | Notes |
|---|---|---|---|
| `schema` | `kxm.gate-registry.v1` | Required | |
| `gates` | Map of gate ID (identifier) to a definition, 1 to 64 entries | Required | |
| `gates.<id>.kind` | `command`, `artifacts-exist`, or `reserved` | Required | Each kind accepts only its own fields |
| `argv` (`command`) | 1 to 64 strings, each 1 to 4,096 characters, no NUL | Required | `argv[0]` must be a bare executable name or an absolute POSIX path (`gate_executable_invalid`). No shell is involved. |
| `timeoutMs` (`command`) | Integer, 1 to 2,147,483,647 | Required | The process is stopped when it expires |
| `cwd` (`command`) | `control` | Optional | The command always runs in the control repository root |
| `paths` (`artifacts-exist`) | 1 to 64 unique portable relative paths, not `.` | Required | Relative to `<control root>/.kxm/assets`; each must be a non-empty regular file that does not escape that directory |
| (`reserved`) | no other fields | | Declared but never executed; a step that reaches it is handed off with `gate_unsupported` |

A command gate runs `argv` with the Runtime supervisor's environment. Its exit
code decides the outcome (see
[Transitions and outcomes](#transitions-and-outcomes)); the Runtime records
hashes and byte counts of stdout and stderr, not their text.

```yaml
# .kxm/gates.yaml — the only place a gate id becomes executable.
schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: [npm, test]        # argv[0]: bare executable or absolute POSIX path; no shell
    timeoutMs: 1800000       # 1..2147483647
    cwd: control             # optional; the only accepted value
  release-notes:
    kind: artifacts-exist
    paths:                   # relative to <control root>/.kxm/assets
      - release/NOTES.md
  scm-delivery:
    kind: reserved           # declared but never executed
```

Error codes: `gate_executable_invalid`; `schema_oneOf` with the per-branch
`schema_*` errors for a malformed definition; in workflows, `gate_unknown` and
`gate_registry_missing`.

Commands: `kxm init` creates a `test` gate (`npm test`, one hour); the loader
validates it; the Runtime executes it; `kxm trust` diffs it, reporting a
`timeoutMs` change as a budget change. The gate registry is part of the tool
policy revision pinned on each run. `kxm gate artifacts-exist --path <file>` is a
separate CLI check against the workspace assets directory (`KXM_ASSETS_DIR`),
not this registry.

## `.kxm/roles/<role>.yaml` (`kxm.role.v1`)

Role files hold model rosters. Three different readers use them, and they
read different fields:

| Reader | File | Fields it reads | Effect |
|---|---|---|---|
| Project loader (`validateBundle`) | `.kxm/roles/writer.yaml` only | `roster[].model`, `roster[].enabled` | If the agent `implementer` (or else `writer`) declares a model and the roster has at least one enabled entry, one enabled entry must equal `provider/model`, equal the bare model, or end with `/<model>`; otherwise `role_roster_conflicts_with_agent`. Parsed as restricted YAML. |
| Runtime route check (`listRoleBindings` in `plugins/kxm/src/routes.ts`) | `.kxm/roles/<role>.yaml`, role = agent ID, `writer` for `implementer` | `roster[].model` | The agent's `provider/model` must appear exactly. `enabled` is ignored, so a disabled entry still admits. The role name comes from the filename. |
| `kxm role` commands (`plugins/kxm/src/role.ts`) | `.kxm/roles/*.yaml` and `~/.config/kxm/roles/*.yaml` | Everything below | Listing and editing only. A file without `schema: kxm.role.v1` is silently skipped. A local file overrides a global one with the same ID. |

Write roster models as the full `provider/model` string. `kxm role add --model
grok-4.6` writes a bare model ID, which satisfies the loader check but not the
Runtime route check. `kxm role modify <role> --add-model grok:xai/grok-4.6`
writes the full form.

| Field | Type | Required, default | What reads it |
|---|---|---|---|
| `schema` | `kxm.role.v1` | Required by `kxm role` | `kxm role` commands |
| `id` | String | Optional, the filename | `kxm role` commands; the loader and Runtime use the filename |
| `description` | String | Optional | `kxm role` commands |
| `roster[].model` | String, `provider/model` | Required per entry | Loader (writer only), Runtime route check |
| `roster[].enabled` | Boolean | Optional, `true` | Loader writer check only |
| `roster[].harness` | String | Optional | `kxm role list` and `kxm role hosts` display |
| `roster[].provider` | String | Optional | `kxm role hosts` display |
| `roster[].effort` | `low`, `medium`, `high`, or `xhigh` | Optional | `kxm role hosts` display; not passed to any producer |
| `roster[].mode` | `headless`, `interactive`, or `either` | Optional | Not read by any code path yet |
| `skills`, `tools`, `produces`, `consumes`, `policy` | See `schemas/role.schema.json` | Optional | Stored and shown by `kxm role`; not read by any code path yet |

Roster order is priority by convention, and `kxm role list` shows the first
entry as the primary. No code path fails over along the roster yet: the
Runtime only checks membership, and the model comes from the agent file.

`schemas/role.schema.json` describes a stricter shape (required
`description`, required `harness` per entry, `model` as a selector object, no
`enabled`). No loader enforces it, and the role files the Runtime reads do not
follow it.

```yaml
# .kxm/roles/writer.yaml — the filename is the role id the Runtime looks up.
schema: kxm.role.v1
id: writer
description: Primary implementation role.
roster:                       # order is priority
  - model: xai/grok-4.6       # full provider/model string
    effort: medium
    enabled: true
  - model: openrouter/qwen/qwen3-coder-plus
    effort: medium
    enabled: true
```

Validated with `kxm init --json` (writer cross-check), `kxm role list --json`,
and the Runtime's `listRoleBindings`.

Commands: `kxm role list|get|add|remove|modify` (`--scope global|local`);
`kxm models` (interactive) adds or removes `{model, enabled: true}` entries
while admitting a route; the Runtime reads rosters on every live attempt.

## `.kxm/role-hosts.yaml` (`kxm.role-hosts.v1`)

Seat-to-host bindings for display. Read and written only by `kxm role hosts`
and `kxm role set-host`; no dispatch path reads it. Location:
`.kxm/role-hosts.yaml` (or `.yml`, or `role-hosts.json`) locally and
`~/.config/kxm/role-hosts.yaml` globally; local seats override global ones.

| Field | Type | Notes |
|---|---|---|
| `schema` | `kxm.role-hosts.v1` | A file with a different `schema` is ignored |
| `seats.<seat>.host` | String | Harness shown for the seat |
| `seats.<seat>.model` | String | Model shown for the seat |
| `seats.<seat>.effort` | `low`, `medium`, `high`, or `xhigh` | |
| `hostProviders.<host>` | String | Provider shown for a host |

Seats without a binding fall back to built-in defaults (`planner`, `writer`,
`critic-arch`, `critic-cli`, `verifier`), then to the role roster's first entry.

```yaml
schema: kxm.role-hosts.v1
seats:
  writer:
    host: grok
    model: xai/grok-4.6
    effort: medium
```

Written by `kxm role set-host writer grok --model xai/grok-4.6 --effort medium`.

## `.kxm/routes.yaml` (`kxm.routes.v2`)

The route admission list the Runtime checks before every live attempt.
Parser: `loadRoutePolicy` in `plugins/kxm/src/routes.ts` (general YAML parser;
unknown keys are ignored).

| Field | Type | Required, default | What reads it |
|---|---|---|---|
| `schema` | `kxm.routes.v2` | Required | Anything else fails with `invalid .kxm/routes.yaml` |
| `admitted` | Array of route strings | Required | Runtime route check; `kxm routes list`, `kxm routes count`; `kxm models` |
| `disabled` | Array of route strings | Optional, `[]` | Runtime: a disabled route is refused even if admitted |
| `roles` | Map of name to route strings | Optional, `{}` | Not read by any code path yet; shown by `kxm routes list` and preserved on rewrite. Role rosters live in `.kxm/roles/`. |
| `updatedAt` | ISO timestamp string | Optional | Rewritten by every CLI change |

A route string is exactly the agent's `model.provider`, a slash, and
`model.model`: `xai/grok-4.6`, `anthropic/fable`,
`openrouter/qwen/qwen3-coder-plus`. When the file is missing, nothing is
admitted and every live attempt is refused (`producer_route_unsupported`, or
`producer_route_not_admitted` from the live producer). A leftover
`.kxm/producers.yaml` makes every reader fail with `retired
.kxm/producers.yaml present; use .kxm/routes.yaml (kxm.routes.v2)`.

`kxm routes admit|disable --model <id>` only accepts an ID that appears in
`.kxm/models/inventory.yaml`; otherwise it exits 2 with
`model_selection_required`. Inventory IDs come in several shapes (bare
`grok-4.6` from `grok models`, `vendor/model` from OpenRouter,
`provider/model` from `pi --list-models`), so a route such as
`openrouter/qwen/qwen3-coder-plus` or `anthropic/fable` usually has to be
added by editing the file.

```yaml
schema: kxm.routes.v2
updatedAt: '2026-09-23T00:00:00.000Z'
admitted:
  - anthropic/fable
  - openai/gpt-5.6-sol
  - xai/grok-4.6
  - openrouter/qwen/qwen3-coder-plus
disabled: []
roles:
  implementer:
    - xai/grok-4.6
```

Validated with `kxm routes list --json` and `kxm routes count --json`.

Commands: `kxm routes list|count|admit|disable` (`--dry-run` supported for
changes), `kxm models` (interactive), the Runtime, and the live producer.
Route changes are not part of `configRevision` and `kxm trust check` does not
report them; review them in the pull request diff.

## `.kxm/roster.yaml` (`kxm.developer-roster.v1`)

The developer roster for `scripts/assignment-run.mjs` (the `just` assignment
recipes; see [Assignment runner](../contributing/assignment-runner.md)). It applies to the KXM
source repository itself: the loader in `scripts/roster-policy.mjs` reads the
copy committed at `HEAD` of the repository that contains the script, and
refuses unless the worktree is clean, `HEAD` is an ancestor of
`origin/main`, and the working file is byte-identical to the committed one.
It has no dispatch authority in the project Runtime.

| Field | Type and allowed values | Notes |
|---|---|---|
| `schema` | `kxm.developer-roster.v1` | The five top-level keys are all required and no others are allowed |
| `routes.<id>` | Route ID matching `^[a-z0-9]+(?:-[a-z0-9]+)*$` | At least one route |
| `routes.<id>.harness` | `grok`, `agy`, `claude`, `codex`, or `pi` | Other harnesses are refused (`unsupported harness`) |
| `routes.<id>.model` | Token without whitespace | Native harnesses: a bare model ID. Pi: `openrouter/<vendor>/<model>`, `nous-portal/<vendor>/<model>`, or `antigravity/gemini-<id>` |
| `routes.<id>.vendor` | Token | The model vendor, not the billing provider. Aliases: `x-ai` is `xai`, `moonshotai` is `moonshot`, `google-ai` is `google`, `qwen` is `alibaba`. |
| `routes.<id>.roles` | Unique subset of the harness's roles | grok: `writer`; agy: `writer`, `experiment`; claude: `planner`, `reviewer-arch`; codex: `reviewer-cli`; pi: all five |
| `routes.<id>.permissions` | Unique subset of the harness's permissions | grok and agy: `edit`; claude and codex: `read-only`; pi: `read-only`, `edit` |
| `routes.<id>.status` | `admitted` or `retired` | |
| `lineup.<role>` | Unique route IDs | Roles: `writer`, `planner`, `reviewer-arch`, `reviewer-cli`, `experiment`. The first four are required. Every listed route must be admitted for that role. |
| `required_critics.review-arch`, `required_critics.review-cli` | Route IDs | Exactly these two keys; each must be in the matching reviewer lineup, `read-only`, and the two vendors must differ |
| `model_origins.<model>` | `{vendor, evidence}` | Required for every Pi route model |
| `model_origins.<model>.evidence` | `{source, sha256}` or `{source, commit, sha256}` | `source` is a repository-relative file; its bytes at `commit` (or at `HEAD`) must hash to `sha256`, and `commit` must be in trusted history |

Other refusals, all prefixed `Roster policy refused:`: `native vendor cannot
use Pi` (a Pi route to anthropic, openai, xai, moonshot, google, or deepseek),
`native route vendor/model mismatch`, `Pi writer requires edit permission
only`, `Pi critic/planner cannot edit`, `writer and critics must have
independent vendors`, and `retired .kxm/roster.json present`.

```yaml
# .kxm/roster.yaml — developer roster policy for scripts/assignment-run.mjs.
schema: kxm.developer-roster.v1
routes:
  grok-native:                  # route id: lowercase words joined by "-"
    harness: grok
    model: grok-4.6             # native harnesses take a bare model id
    vendor: xai
    roles: [writer]
    permissions: [edit]
    status: admitted            # admitted | retired
  qwen-openrouter-pi:
    harness: pi
    model: openrouter/qwen/qwen3-coder-plus   # Pi: allowed provider prefix + vendor/model
    vendor: alibaba
    roles: [writer]
    permissions: [edit]
    status: admitted
  fable-claude:
    harness: claude
    model: fable
    vendor: anthropic
    roles: [planner, reviewer-arch]
    permissions: [read-only]
    status: admitted
  sol-codex:
    harness: codex
    model: gpt-5.6-sol
    vendor: openai
    roles: [reviewer-cli]
    permissions: [read-only]
    status: admitted
lineup:                         # routes admitted for each role
  writer: [grok-native, qwen-openrouter-pi]
  planner: [fable-claude]
  reviewer-arch: [fable-claude]
  reviewer-cli: [sol-codex]
required_critics:
  review-arch: fable-claude
  review-cli: sol-codex
model_origins:                  # required for every Pi route model
  openrouter/qwen/qwen3-coder-plus:
    vendor: alibaba
    evidence:
      source: docs/workflow-guide.md
      commit: 69341ca200c31b98b5ba2371437398f0ce501089
      sha256: 358d436dbf1b6f3904252afba167e643d33d597d16148ac1286b1c21b81448a4
```

Validated with `validateRosterDocument` from `scripts/roster-policy.mjs`,
reading evidence from this repository's history. The lineup order is not a
selection order: the assignment manifest names the harness and model, and the
runner checks that the pair is admitted in the lineup.

## `.kxm/prices.yaml` (`kxm.prices.v1`)

A dated, hash-pinned snapshot of list prices in USD per million tokens.
Parser: `parsePriceCatalog` in `plugins/kxm/src/prices.ts`; cost math in
`plugins/kxm/src/price-calc.ts`. The loader looks for `<root>/.kxm/prices.yaml`,
then `<root>/prices.yaml`.

| Field | Type and allowed values | Required, default | Notes |
|---|---|---|---|
| `schema` | `kxm.prices.v1` | Required | |
| `date` | `YYYY-MM-DD`, a real calendar date | Required | Compared with today's UTC date; see below |
| `sha256` | 64 lowercase hex characters, optionally prefixed `sha256:` | Required | Must equal the canonical digest (`price catalog hash mismatch`) |
| `currency` | `USD` | Optional, `USD` | Any other value is refused |
| `models` | Non-empty array | Required | |
| `models[].id` | Non-empty string | Required | Unique (`duplicate price catalog model id`); usually `provider/model` |
| `models[].provider` | Non-empty string | Required | A lookup that names a provider only matches rows with that provider |
| `models[].model` | Non-empty string | Required | |
| `models[].aliases` | Array of strings | Optional | Also matched, case-insensitively, against the requested model |
| `models[].tiers` | Non-empty array | Required | |
| `tiers[].upToContextTokens` | Positive integer, or `null`/absent for unbounded | Optional | Bounds must strictly increase; the unbounded tier must be last |
| `tiers[].inputPerMillion` | Finite number, at least 0 | Required | The parser also accepts the short name `input` |
| `tiers[].outputPerMillion` | Finite number, at least 0 | Required | Short name `output` |
| `tiers[].cacheReadPerMillion` | Finite number, at least 0, or `null` | Optional | Short name `cacheRead` |
| `tiers[].cacheWritePerMillion` | Finite number, at least 0, or `null` | Optional | Short name `cacheWrite` |

The parser ignores unknown fields; `schemas/prices.schema.json` forbids them
but is not enforced. Use the long field names: the short names parse, but the
hash recipe below only works on the long ones.

### How `sha256` is computed

The digest is SHA-256, in hex, over `JSON.stringify` of this object (key order
as shown):

1. `schema`, `date`, and `currency` (`USD` when absent).
2. `models`, sorted by `id` (locale compare). Each model is `id`, `provider`,
   `model`, `aliases` (sorted; `[]` when absent), and `tiers`.
3. Each tier is `upToContextTokens`, `inputPerMillion`, `outputPerMillion`,
   `cacheReadPerMillion`, and `cacheWritePerMillion`, with `null` for any
   absent optional value.

Comments, YAML formatting, and the order of fields in the file do not change
the digest. To compute it from a source checkout, run this from the repository
root and paste the output into `sha256`:

```bash
node --disable-warning=ExperimentalWarning --experimental-strip-types --input-type=module -e '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { hashPriceCatalog } from "./plugins/kxm/src/prices.ts";
const { sha256, ...body } = parse(readFileSync(process.argv[1], "utf8"));
console.log(hashPriceCatalog(body));
' /path/to/project/.kxm/prices.yaml
```

### Cost basis and staleness

- The producers only use a catalog whose `date` is today's UTC date. An older
  snapshot is treated as stale (`priceCatalogStale: true` in the attempt's
  provider metadata) and contributes nothing. A catalog that fails to parse or
  verify is marked `priceCatalogUnavailable: true`. A missing file contributes
  nothing and sets no flag.
- A current catalog adds a list-price estimate to the attempt's metadata
  (`listCostUsd`, `listPriceRef` of the form `<date>#<id>`, `listPriceSha256`).
  It needs all four token counts, and one-shot harnesses produce one only for
  `claude` with a single unbounded tier. Without a context measurement only a
  single unbounded tier can be priced; with one, the first tier whose bound is at
  least the context size applies. Cache tokens against a `null` rate, or a
  missing tier, yield no estimate rather than zero.
- The built-in producers always record `costBasis: unknown` (Pi, and one-shot
  harnesses on API credentials) or `unmetered` (one-shot harnesses signed in
  with a subscription, and the simulated producer), with `costUsd: null`. A list
  estimate never becomes a metered cost.
- `limits.maxModelCost` sums only `metered` attempts, so with the built-in
  producers it does not trip. The Runtime caps `unmetered` and `unknown`
  attempts at 100 per run instead.

Example (validated by `parsePriceCatalog`; the rates are illustrative):

```yaml
# .kxm/prices.yaml — dated list-price snapshot, USD per million tokens.
schema: kxm.prices.v1
date: "2026-09-23"                 # UTC calendar date of the snapshot
sha256: 628004d20c0487e0196fcdea53235d085282929260ba479258a8a6999a4dff6e
currency: USD                      # only USD is accepted
models:
  - id: anthropic/fable            # unique; matched against the requested model
    provider: anthropic
    model: fable
    aliases:
      - claude-fable-5
    tiers:
      - inputPerMillion: 10          # a single unbounded tier (no upToContextTokens)
        outputPerMillion: 50
        cacheReadPerMillion: 0.25
        cacheWritePerMillion: 12.5
  - id: example/tiered-model
    provider: example
    model: tiered-model
    tiers:
      - upToContextTokens: 200000    # applies while context <= 200000 tokens
        inputPerMillion: 1.25
        outputPerMillion: 10
        cacheReadPerMillion: 0.125
        cacheWritePerMillion: null   # null = no published rate
      - inputPerMillion: 2.5         # unbounded tier must be last
        outputPerMillion: 15
        cacheReadPerMillion: 0.25
```

Commands: the Pi and one-shot producers read it on every attempt;
`kxm explain` reports `catalogStatus` (`verified`, `stale`, `corrupt`, or
`missing`); `kxm routing report --list-prices [--prices <file>]` reads it
(default `<workspace>/prices.yaml`, normally `.kxm/prices.yaml`) and ignores a
bad file.

## `.kxm/models/inventory.yaml` (`kxm.model-inventory.v1`)

A generated catalog of models the machine can see, with public list prices.
Never hand-edit it: `kxm models inventory-refresh` (alias `refresh`) rewrites
the whole file. No parser validates it; `kxm routes admit|disable` and the
interactive `kxm models` screen read only `models[].id`.

The refresh runs `pi --list-models`, `grok models`, and `agy models`, and
fetches `https://openrouter.ai/api/v1/models` (override with
`KXM_OPENROUTER_MODELS_URL`, authenticated with `OPENROUTER_API_KEY` when set)
and `https://inference-api.nousresearch.com/v1/models` (override with
`KXM_NOUS_MODELS_URL`, `NOUS_API_KEY`). It makes network requests, writes the
file even when a source fails, and exits 1 if any source failed.
`--dry-run` writes nothing.

| Field | Contents |
|---|---|
| `schema` | `kxm.model-inventory.v1` |
| `fetchedAt` | ISO timestamp of the refresh |
| `currency` | `USD` |
| `sources.<name>` | `url` (a command line or URL), `ok`, and `error` on failure, for `pi`, `grok`, `agy`, `openrouter`, and `nous` |
| `models[].id` | Model ID as the source reported it, sorted |
| `models[].name`, `models[].contextLength` | From the first source that reported them |
| `models[].capabilities.thinking` | `supported` (true or null), optional `levels` and `default`, and `source` |
| `models[].capabilities.speed` | `fast` (true or null), optional `tiers`, and `source` |
| `models[].sources` | Which sources listed the model |
| `models[].standard` | OpenRouter per-million rates: `inputPerMillion`, `outputPerMillion`, `cacheReadPerMillion`, `cacheWritePerMillion` |
| `models[].discount` | Nous per-million rates, same fields |

The inventory is discovery data, not admission. Admitting a route is a
separate, reviewed change to `.kxm/routes.yaml`.

## Personalization settings (`kxm.config.v1`)

Personal and workflow preferences, merged in three layers: built-in defaults
in `plugins/kxm/src/config.ts`, then the user file
`$KXM_USER_CONFIG_DIR/config.yaml` (default `~/.config/kxm/config.yaml`), then
the project file `.kxm/config.yaml` in the current directory. Later layers win
key by key; arrays are replaced, not merged. The files need no `schema` key.
Nothing validates keys or values except `hub.autoStart` and the `improvement.*`
keys, which fall back to their defaults field by field (see the table), but a file
that is not valid YAML makes every `kxm config` command fail. `kxm improve` loads
the project file from its project root (the current directory's Git root when it
holds `.kxm/project.yaml`) rather than from the current directory.

Two groups of keys change behavior today: `hub.autoStart`, and the `improvement.*`
keys that shape the report `kxm improve` prints. The **Read by** column lists every
reader found in `plugins/kxm/src`, `scripts/`, and `packages/`; the `kxm config`
commands themselves are not counted.

| Key | Type and allowed values | Default | Read by |
|---|---|---|---|
| `hub.autoStart` | `background` or `off`; any other value falls back to `background` | `background` | The Pi extension on load (`plugins/kxm/src/extension.ts`, `hub-autostart.ts`) |
| `user.name`, `user.email` | String | none | Not read by any code path yet |
| `user.preferredHarness`, `user.preferredModel` | String | none | Not read by any code path yet |
| `user.preferredCritics` | Array of strings | `[reviewer-arch, reviewer-cli]` | Not read by any code path yet |
| `user.theme` | `dark`, `light`, or `minimal` | `dark` | Not read by any code path yet |
| `user.tokenBudget` | Number | `16000` | Not read by any code path yet (`kxm context get --budget` takes its own value) |
| `defaults.project`, `defaults.model` | String | none | Not read by any code path yet |
| `defaults.workflow` | String | `software-engineering/feature-implementation` | Not read by any code path yet |
| `defaults.harness` | String | `pi` | Not read by any code path yet; the harness default that takes effect is `defaultHarness` in `.kxm/project.yaml` |
| `dash.defaultScreen` | `agents`, `tasks`, `workflows`, `plans`, `inbox`, `procs`, or `spend` | `agents` | Not read by any code path yet |
| `dash.refreshIntervalMs` | Number | `1000` | Not read by any code path yet |
| `dash.autoOpen` | Boolean | `false` | Not read by any code path yet |
| `sync.defaultTracker` | `github`, `jira`, or `none` | `none` | Not read by any code path yet |
| `sync.github.owner`, `.repo`, `.syncLabels`, `.autoComment` | String or boolean | none | Not read by any code path yet |
| `sync.jira.host`, `.projectKey`, `.issueType`, `.autoTransition` | String or boolean | none | Not read by any code path yet |
| `improvement.promotionPolicy` | `manual_pr`, `critic_quorum`, or `auto_threshold`; any other value falls back to `manual_pr` | `manual_pr` | `kxm improve` (`cmdImprove` in `plugins/kxm/src/cli/system.ts`, then `evaluatePromotionPolicy` in `improve.ts`): selects the review-readiness rule reported per candidate. No value authorizes or activates anything |
| `improvement.telemetryHalfLifeDays` | Number greater than 0 and at most 3650; otherwise `14` | `14` | `kxm improve`: the half-life of each record's weight in `weightedRecurrence`, which orders report rows and never decides candidacy |
| `improvement.autoThreshold.minRuns`, `.minPassRate`, `.minCostSavings` | `minRuns` an integer from 1 to 1,000,000, `minPassRate` from 0 to 1, `minCostSavings` at least 0; otherwise the default | `10`, `0.95`, `0.5` | `kxm improve`, only under `auto_threshold`: distinct runs, accepted share, and mean recorded cost per attempt a candidate needs to report ready for review. A group with no recorded cost is never ready |
| `routing.shadowExecution.enabled` | Boolean | `false` | Not read by any code path yet |
| `routing.shadowExecution.sampleRate` | Number | `0.05` | Not read by any code path yet |
| `routing.shadowExecution.candidateModels` | Array of strings | `[]` | Not read by any code path yet |
| `routing.circuitBreaker.mode` | `soft_demotion` or `quarantine` | `soft_demotion` | Not read by any code path yet (`evaluateCircuitBreaker` in `routing.ts` has no production caller) |
| `routing.circuitBreaker.failureThreshold`, `.windowSeconds`, `.cooldownSeconds`, `.penaltyMultiplier` | Number | `3`, `3600`, `1800`, `5` | Not read by any code path yet |
| `telemetry.federated` | Boolean | `true` | Not read by any code path yet (`exportFederatedTelemetry` has no production caller) |
| `telemetry.anonymize` | Boolean | `true` | Not read by any code path yet |
| `telemetry.userTelemetryDir` | Path | none | Not read by any code path yet |

```yaml
# .kxm/config.yaml (project scope) or ~/.config/kxm/config.yaml (user scope).
# Only hub.autoStart and improvement.* change behavior today.
hub:
  autoStart: background        # background | off
improvement:
  promotionPolicy: manual_pr   # manual_pr | critic_quorum | auto_threshold (readiness only)
  telemetryHalfLifeDays: 14
user:
  preferredHarness: grok
  theme: dark                  # dark | light | minimal
defaults:
  workflow: review
  harness: pi
routing:
  circuitBreaker:
    mode: soft_demotion        # soft_demotion | quarantine
    failureThreshold: 3
telemetry:
  federated: true
  anonymize: true
```

Validated with `kxm config list --json` and `kxm config get`.

Commands:

- `kxm config get <key>` prints one merged value. Top-level sections other
  than the ones in the table are dropped, so `kxm config get no.such.key`
  prints `(undefined)` even after `kxm config set` wrote it.
- `kxm config set <key> <value> [--scope user|project]` writes one file
  (project by default). The value is parsed as JSON when it can be (`true`,
  `5`, `["a"]`), otherwise stored as a string. Keys are not validated.
- `kxm config list` prints `user`, `defaults`, `dash`, `sync`, and
  `loadedFrom`; `--json` prints every section. An empty `loadedFrom` means no
  file was found.

There is no `kxm config unset`. Delete the key from the file to fall back to
the next layer; setting `null` stores `null`.

## `.kxm/modes.yaml` (`kxm.modes.v1`)

Modes for `kxm explain`, which estimates the prompt footprint and token cost of
a mode before you run it. Parsed with the general YAML parser; a file that fails
to parse, lacks `schema: kxm.modes.v1`, or lacks `majorModes` is silently
replaced by the built-in modes (`coder`, `planner`, `auditor`, `browser` and
domains `git`, `k8s`, `database`, `browser`). Your modes and domains are merged
over the built-in ones by name.

| Field | Type | Notes |
|---|---|---|
| `schema` | `kxm.modes.v1` | Required |
| `majorModes.<name>.baseTools` | Array of strings | Required per mode |
| `majorModes.<name>.description` | String | |
| `majorModes.<name>.contextFiles` | Array of repository-relative paths | Counted into the footprint |
| `majorModes.<name>.thinkingLevel` | `low`, `medium`, `high`, or `xhigh` | |
| `majorModes.<name>.model` | String | Default model for the estimate; `kxm explain --model` overrides it |
| `domains.<name>.tools` | Array of strings | Required per domain |
| `domains.<name>.description`, `.contextFiles`, `.promptSnippet` | String, array, string | |

```yaml
schema: kxm.modes.v1
majorModes:
  reviewer:
    description: Read-only review of a diff
    baseTools: [read, grep]
    contextFiles: [AGENTS.md]
    thinkingLevel: high
    model: claude/fable
domains:
  payments:
    description: Payments domain rules
    tools: [sqlite_query]
    contextFiles: [docs/payments.md]
    promptSnippet: Amounts are integer cents; never use floats.
```

Validated with `kxm explain --mode reviewer --domains payments,git --json`.

## `.kxm/template-provenance.yaml` (`kxm.template-provenance.v1`)

Written only by `kxm init`. It records exact-byte hashes and authority hashes
of the files the built-in template created, so later `kxm init` runs can apply
conflict-free template updates. Never edit it. Deleting it keeps the project
valid but makes template repair planning-only.

| Field | Type | Notes |
|---|---|---|
| `schema` | `kxm.template-provenance.v1` | |
| `templateId` | `builtin-minimal` | |
| `templateRevision` | `sha256:<hex>` | Hash of the canonical `files` list |
| `inputs.projectId` | Opaque ID | Must equal `project.yaml` `id` (`template_provenance_project_mismatch`) |
| `inputs.projectName` | String, 1 to 120 characters, one line | The name used when the template was rendered |
| `files[].path` | `.kxm/...` portable path | Strict code-unit order (`template_provenance_order_invalid`), unique after case folding (`template_provenance_path_collision`), never the provenance file itself (`template_provenance_path_invalid`) |
| `files[].sha256` | `sha256:<hex>` | Exact bytes as written |
| `files[].authoritySha256` | `sha256:<hex>` | Canonical JSON with prose fields removed: project `name`, repository `description`, agent `purpose`, workflow `description` |
| `files[].bytes` | Integer, 1 to 262,144 | Total at most 8 MiB (`template_provenance_bounds_exceeded`) |

The whole file must equal what one of the built-in template variants (`v1`,
`v2`, `v3-policy`, `v4-registry`) would produce for its `inputs`; otherwise
`template_provenance_revision_invalid`. It must be a regular file under
regular directories (`resource_not_file`, `resource_parent_symlink`).

Commands: `kxm init` creates it last in a create transaction and reads it in
validate and repair modes. The transaction directory `.kxm-init-transaction/`
at the Git root holds interrupted create or repair state; do not commit it.

## Tasks and goals (`kxm.task.v1`, `kxm.goal.v1`)

Work records under `.kxm/tasks/<id>.yaml` and `.kxm/goals/<id>.yaml`, parsed
with the general YAML parser by `plugins/kxm/src/task-manager.ts`. A file that
does not parse or lacks the right `schema` is skipped silently. The commands
create them; editing by hand is supported.

| Task field | Type and allowed values | Notes |
|---|---|---|
| `schema` | `kxm.task.v1` | |
| `id` | `task_` plus 12 hex characters | Also the filename |
| `goalId` | Goal ID | Optional; not checked |
| `title`, `objective` | String | `kxm task run` passes `objective` as the run prompt |
| `acceptanceCriteria` | `[{id, description, required}]` | No command writes it; edit by hand |
| `status` | `todo`, `in_progress`, `blocked`, `in_review`, or `done` | |
| `assignedWorkflow` | Workflow ID | Not checked at creation; `kxm task run` uses it, or `default` |
| `workflowRunId` | Run ID | Optional |
| `trackerSync` | `{tracker, issueKey, syncStatus, lastSyncedAt}` | `tracker` is `github`, `jira`, `gitlab`, or `none`; `syncStatus` is `synced`, `pending`, or `failed` |
| `createdAt`, `updatedAt` | ISO timestamps | |

| Goal field | Type and allowed values | Notes |
|---|---|---|
| `schema` | `kxm.goal.v1` | |
| `id` | `goal_` plus 12 hex characters | Also the filename |
| `title` | String | |
| `area` | String | Default `software-engineering` |
| `status` | `active`, `achieved`, or `abandoned` | |
| `successMetrics` | Array of strings | |
| `targetDate` | String | Optional |
| `createdAt`, `updatedAt` | ISO timestamps | |

```yaml
schema: kxm.task.v1
id: task_5644e7e51277
title: Add refund endpoint
objective: Expose POST /refunds with idempotency keys
acceptanceCriteria: []
status: todo
assignedWorkflow: review
trackerSync:
  tracker: github
  issueKey: "42"
  syncStatus: pending
createdAt: 2026-09-23T14:02:04.574Z
updatedAt: 2026-09-23T14:02:04.574Z
```

Written by `kxm task create "Add refund endpoint" --objective "…" --workflow
review --tracker github --issue 42`.

Commands: `kxm goal create|list`; `kxm task create|list|get|run|sync`.
`kxm task run` calls `kxm run <assignedWorkflow or default> <objective>` and
sets `status: in_progress` on success. `kxm task sync` marks the record
`synced` locally; it makes no tracker API call.

## Memory records (`kxm.memory.v1`)

Harness-agnostic project memory as Markdown files with YAML front matter.
Parser: `parseMemoryRecord` in `plugins/kxm/src/memory.ts`.

- `.kxm/memory/*.md` (top level only) are authored facts. Only
  `lifecycle: active` facts appear in `kxm memory brief` and in the projection
  that `kxm memory sync` writes into `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.
- `.kxm/memory/candidates/*.md` are candidates written by `kxm memory note`.
  Promote one by moving it into `.kxm/memory/` in a reviewed change.
- Every file under `.kxm/memory/` except `candidates/` is hashed into the
  memory revision pinned on each run.

| Field | Type and allowed values | Required |
|---|---|---|
| `schema` | `kxm.memory.v1` | Yes |
| `id` | Identifier starting with a letter, with single `-` or `_` between letter and digit runs; case-insensitive | Yes |
| `scope` | `agent`, `project`, `run`, or `operator` | Yes |
| `kind` | Non-empty string, for example `decision`, `architecture`, `convention`, `policy`, `learning` | Yes |
| `summary` | Non-empty string; secrets are redacted | Yes |
| `provenance.sourceType` | Non-empty string | Yes |
| `provenance.sourceRef`, `provenance.runId`, `provenance.timestamp` | String | No |
| `authority` | `instruction`, `evidence`, or `promoted` | Yes |
| `confidence` | `verified`, `probable`, or `uncertain` | Yes |
| `lifecycle` | `active`, `deprecated`, or `superseded` | Yes |
| `evidenceRefs` | Array (values are converted to strings) | No |

Front matter may not contain control-plane fields: `permissions`, `tools`,
`allow`, `deny`, `grants`, `approval`, `policy`, `scopes`, `credentials`,
`secrets`, `token`, `apiKey`, or `password`. The text after the front matter is
the body. One malformed authored file makes `kxm memory brief` and
`kxm memory sync` fail. The Claude Code plugin's session-start hook still
runs; it leaves out the memory brief and keeps the status sections.

```markdown
---
schema: kxm.memory.v1
id: gate-before-review
scope: project              # agent | project | run | operator
kind: convention
summary: Run the test gate before asking critics to review a diff.
provenance:
  sourceType: review
  sourceRef: docs/workflow-guide.md
  timestamp: 2026-09-20T12:00:00Z
authority: promoted         # instruction | evidence | promoted
confidence: verified        # verified | probable | uncertain
lifecycle: active           # active | deprecated | superseded
evidenceRefs:
  - run_01JEXAMPLE000000
---

Critics reviewed several diffs that later failed `npm test`. Gating first saves a review round.
```

Validated with `kxm memory brief --json`.

## Skills and improvement candidates

Both directories are written by commands, not configured by hand.

- `.kxm/skills/` holds the governed skill lifecycle:
  `candidates/<id>/`, `promoted/<id>/`, `quarantined/<id>/`, and
  `rejected/<id>/`, each with `SKILL.md` and `metadata.json`
  (`kxm.skill-candidate.v1`), plus `history/<id>.jsonl`. Written by
  `kxm skills create|evaluate|promote|reject`; `kxm skills verify` detects
  out-of-band edits to promoted skills. Promoted skills are hashed into the
  memory revision pinned on each run. See [Skills](../guides/governed-skills.md).
- `.kxm/candidates/` holds improvement candidates (`<id>.json`,
  `kxm.candidate.v1`, with a proposed diff file) written by `kxm improve`
  (`--out-dir` relocates them; `--dry-run` writes none). The report itself goes to
  `<workspace>/assets/improvements/`. A candidate is a proposal: its diff has
  placeholder hunks, nothing applies it, and its promotion readiness never
  authorizes. See [Continuous improvement](../guides/continuous-improvement.md#coded-repeats-kxm-improve).

## Webhook workflow definitions

The hub's signed-webhook workflows are a JSON array, not YAML and not a
`kxm.workflow.v1` file. Supply it through exactly one of
`KXM_WEBHOOK_WORKFLOWS` (inline JSON) or `KXM_WEBHOOK_WORKFLOWS_FILE` (a path).
Parser: `parseWorkflowDefinitions` in `plugins/kxm/src/workflow.ts`; the hub
reads it at startup (`plugins/kxm/src/server.ts`).

Do not store the file under `.kxm/config/workflows/`: any `*.json` there is
treated as legacy configuration and makes the whole project unloadable
(`legacy_state_unsupported`). Do not point it at `.kxm/workflows/*.yaml`
either; those are `kxm.workflow.v1` files and fail to parse as JSON. A path
such as `.kxm/assets/webhooks/workflows.json` works.

| Field | Type and allowed values | Required, default |
|---|---|---|
| `id` | String, at most 64 characters, unique | Required; appears in `/v1/webhooks/<id>` |
| `source` | `jira`, `github`, or `generic` | `generic` |
| `project` | Hub project name, at most 128 characters | Required |
| `target` | Coordinator name or durable agent ID, at most 80 characters | Required |
| `secretEnv` or `secret` | Variable name, or the literal secret (at least 16 characters); exactly one | Required; prefer `secretEnv` |
| `signalSecretEnv` or `signalSecret` | Same rules, for result callbacks | Optional; callbacks fall back to the start secret |
| `event` | String, at most 128 characters | Optional provider event filter |
| `filter.path`, `filter.equals` | Dotted JSON path and exact string | Optional |
| `delivery` | `followUp` or `steer` | `followUp` |
| `ttlMs` | Integer, 1,000 to 604,800,000 | Optional |
| `promptTemplate` | String, at most 20,000 characters, with `{{payload.path}}` substitutions | Required |
| `maxTransitions` | Integer, 1 to 200 | Required when any stage has a back-edge |
| `planHash`, `reproOracle` | `{stageId, evidenceKey}` | Optional |
| `requirePlanHash` | Stage IDs | Optional |
| `stages` | 1 to 32 stages | Required |
| `stages[].id` | String, at most 64 characters, unique | Required |
| `stages[].label` | String, at most 128 characters | The stage ID |
| `stages[].instructions` | String, at most 4,000 characters | Required |
| `stages[].requiredEvidence` | Up to 32 strings, unique after trimming, collapsing whitespace, and lowercasing | `[]` |
| `stages[].maxAttempts` | Integer, 1 to 20 | `3` |
| `stages[].autoResumeLimit` | Integer, 1 to 20 | Optional |
| `stages[].area` | `harness`, `gates`, `implementation`, `workflow`, `documentation`, `security`, or `other` | Optional |
| `stages[].on` | Map of outcome to a stage ID, `$terminal`, or `{target, maxTransitions}` | Optional |
| `stages[].maxTransitions` | Integer, 1 to 100 | Optional |
| `stages[].evidencePolicies.<requirement>` | `{kind: peer-reply, minProducers (1 to 8), eligibleAgents (1 to 16), acceptedStatuses: [replied], degradation: {minProducers}}` | Optional; see [Peer provenance and quorum gates](../guides/provenance-gates.md) |

Rules that differ from `kxm.workflow.v1`: a forward transition may only target
the next stage; `$terminal` takes no `terminalStatus`; an evidence policy key
must match a `requiredEvidence` entry, may not list the workflow `target` among
its eligible agents, and its degradation minimum must be lower than
`minProducers` (a degraded minimum below 2 is a warning). Unknown fields are
ignored rather than rejected, and errors are plain messages, not codes. The
secret variables must be set when the file is parsed.

```json
[
  {
    "id": "jira-development",
    "source": "jira",
    "project": "payments",
    "target": "coordinator",
    "secretEnv": "JIRA_WEBHOOK_SECRET",
    "signalSecretEnv": "WORKFLOW_SIGNAL_SECRET",
    "event": "jira:issue_updated",
    "filter": { "path": "issue.fields.status.name", "equals": "In Progress" },
    "delivery": "followUp",
    "ttlMs": 86400000,
    "maxTransitions": 6,
    "planHash": { "stageId": "plan", "evidenceKey": "approved plan" },
    "requirePlanHash": ["implement"],
    "promptTemplate": "Deliver {{issue.key}}: {{issue.fields.summary}}",
    "stages": [
      {
        "id": "plan",
        "label": "Plan and review",
        "instructions": "Produce a plan and collect two independent peer reviews.",
        "requiredEvidence": ["approved plan", "peer reviews"],
        "evidencePolicies": {
          "peer reviews": {
            "kind": "peer-reply",
            "minProducers": 2,
            "eligibleAgents": ["reviewer-claude", "reviewer-grok"],
            "acceptedStatuses": ["replied"],
            "degradation": { "minProducers": 1 }
          }
        },
        "maxAttempts": 3,
        "area": "workflow",
        "on": { "passed": "implement" }
      },
      {
        "id": "implement",
        "label": "Implement",
        "instructions": "Implement the approved plan.",
        "requiredEvidence": ["diff"],
        "maxAttempts": 3,
        "autoResumeLimit": 2,
        "area": "implementation",
        "on": { "passed": "ci" }
      },
      {
        "id": "ci",
        "label": "Wait for CI",
        "instructions": "Start kxm_workflow_wait and let kxm gate github watch report the checks.",
        "requiredEvidence": ["github.check:ci"],
        "maxAttempts": 3,
        "area": "gates",
        "on": {
          "passed": "$terminal",
          "failed": { "target": "implement", "maxTransitions": 2 }
        },
        "maxTransitions": 2
      }
    ]
  }
]
```

Validated with `kxm gate validate --file .kxm/assets/webhooks/workflows.json`
with both secret variables set (one warning, for the degraded minimum of 1).

Commands: `kxm gate validate [--file <path>]` parses the active source without
printing secrets (exit 2 when no source or both variables are set); the hub
loads it on `kxm hub start`; `kxm workflow start`, `kxm gate signal`, and
`kxm gate github watch` resolve each definition's secret variables. See
[Webhook workflows](../guides/webhook-workflows.md).

## Claude Code plugin settings

The Claude Code plugin manifest `plugins/kxm/.claude-plugin/plugin.json`
declares `userConfig` fields that Claude Code asks each user for. The plugin's
`.mcp.json` passes them to the KXM MCP server as environment variables.

| `userConfig` field | Environment variable | Required, default | Notes |
|---|---|---|---|
| `server_url` | `KXM_SERVER_URL` | Required, `http://127.0.0.1:7331` | The MCP server also falls back to that URL when empty |
| `auth_token` | `KXM_AUTH_TOKEN` | Optional; marked sensitive | Use the project token, never the admin token. When empty, the MCP server uses only this project's saved project token from the hub credential file (`hub-env.json`) and never falls back to the admin token; with neither, tool calls fail with a message naming the fix |
| `agent_name` | `KXM_AGENT_NAME` | Required, `claude` | When empty, `claude-<pid>`. If another live session already holds the name, the server registers once more as `<name>-<pid>` |
| `agent_purpose` | `KXM_AGENT_PURPOSE` | Required, `Claude Code implementation and review agent` | |
| `project` | `KXM_PROJECT` | Optional | When empty, the `name` in `package.json` at the project directory, else the directory name |
| (not a user field) | `KXM_PROJECT_DIR` | Set from `${CLAUDE_PROJECT_DIR}` | Used to derive the default project |

The manifest also registers one `SessionStart` hook,
`node ${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.js session-start`, with a 5-second
timeout. It runs only inside a KXM project, reads this project's state only,
never mints a token or writes a file, and always exits 0. See the
[plugin README](../../plugins/kxm/README.md) for what it adds to the session.

## Updater settings (`kxm.update.v1`)

`update.yaml` under the user state root (see the next section) controls
`kxm update`. A project `.kxm/update.yaml` is ignored with a warning. Parser:
`loadKxmUpdateConfig` in `plugins/kxm/src/kxm-update-config.ts`.

| Field | Type and allowed values | Required, default |
|---|---|---|
| `schema` | `kxm.update.v1` | Required |
| `auto` | Boolean | Required |
| `source` | `github` or `npm` | Optional, `github` |

Unknown fields are refused (`update.yaml unknown field <name>`).

```yaml
schema: kxm.update.v1
auto: false        # required boolean
source: github     # github (default) | npm
```

## Workspace layout: tracked, ignored, and state

Everything under `.kxm/` at the project root falls into one of three groups.
`kxm init` writes none of the ignore rules, so add them yourself.

| Path | Group | Written by |
|---|---|---|
| `project.yaml`, `repo/`, `project/env.yaml`, `agents/`, `models/*.yaml` (except `inventory.yaml`), `workflows/`, `gates.yaml`, `template-provenance.yaml` | Tracked configuration (the bundle) | You and `kxm init` |
| `roles/`, `routes.yaml`, `prices.yaml`, `modes.yaml`, `role-hosts.yaml`, `roster.yaml` | Tracked configuration outside the bundle | You and their commands |
| `config.yaml` | Tracked if the project wants shared preferences; otherwise ignore it | `kxm config set` |
| `memory/`, `skills/`, `candidates/`, `goals/` | Tracked durable records | Their commands |
| `models/inventory.yaml` | Generated; track it if you want a reviewed snapshot | `kxm models inventory-refresh` |
| `assets/` | Tracked intentionally; `assets/generated/` is ignored | Workflows, `kxm improve`, `kxm session start` |
| `tasks/` | Ignored in the KXM repository; your choice | `kxm task` |
| `logs/` | Ignored runtime logs | The hub and workers |
| `state/` | Ignored restart state: the hub database `kxm.db`, Pi sessions, worker manifests | The hub and workers |
| `run/` | Ignored sockets (`run/ssh-sockets/`) | `kxm ssh` |
| `config/` | Legacy: its JSON files make the project unloadable | Nothing current |
| `.kxm-init-transaction/` (sibling of `.kxm/` at the Git root) | Ignored; interrupted `kxm init` state | `kxm init` |

The ignore rules the KXM repository itself uses, adapted for a project:

```text
.kxm/logs/*
.kxm/state/*
.kxm/tasks/
.kxm/run/
.kxm/assets/generated/
.kxm-init-transaction/
*.db
*.db-shm
*.db-wal
```

`KXM_WORKSPACE_DIR`, `KXM_LOGS_DIR`, `KXM_ASSETS_DIR`, `KXM_STATE_DIR`, and
related variables move `logs/`, `assets/`, and `state/`. They do not move the
configuration files, which always live under `<project root>/.kxm/`. See
[Configuration](configuration.md) and [Operations](../operations/deploy.md).

### State outside the project

The **user state root** is `KXM_STATE_HOME` when set (it must be absolute;
a relative value fails with `local_state_root_not_absolute`). Otherwise it is
`~/Library/Application Support/KXM` on macOS, `%LOCALAPPDATA%\KXM` on Windows,
and `$XDG_STATE_HOME/kxm` (default `~/.local/state/kxm`) on Linux.

| Path under the state root | Contents |
|---|---|
| `runtime/registry.db` | Runtime registry: projects, their control roots, and the supervisor claim |
| `runtime/projects/<key>/run-events.db` | Event-sourced runs for one project; `<key>` is the first 24 hex characters of the SHA-256 of the canonical project root path |
| `runtime/supervisor.token`, `runtime/logs/kxm-runtime.jsonl` | Supervisor credential and log |
| `projects/<hash>/repository-bindings.json` | Host-local member bindings from `kxm init --repository` (`kxm.local-repository-bindings.v1`) |
| `hub-env.json`, `hub-binding.json` | Persisted hub credentials and the machine's hub binding |
| `update.yaml` | Updater settings |

The **user configuration directory** is `KXM_USER_CONFIG_DIR`, default
`~/.config/kxm`. It holds `config.yaml`, global `roles/` and `workflows/`,
`role-hosts.yaml`, `session.token`, and shell completion scripts. Global
workflows are listed by `kxm workflow definitions` but never loaded by
`kxm run`.

## Worked example: a minimal two-step project

A project with one agent step and one command gate. Every file below passed
`kxm init --json`, `kxm run --dry-run`, `kxm trust check`, and a simulated
drive that finished `completed`.

Directory layout (inside a Git repository):

```text
.
├── package.json
└── .kxm/
    ├── project.yaml
    ├── repo/repo.yaml
    ├── agents/coordinator.yaml
    ├── agents/implementer.yaml
    ├── gates.yaml
    ├── routes.yaml
    └── workflows/default.yaml
```

`.kxm/project.yaml`:

```yaml
schema: kxm.project.v1
id: prj_01JMINIMAL000000000000000
name: Minimal Example
defaultWorkflow: default
defaultExecutor: local
defaultHarness: pi
repositories:
  - id: control
    role: control
    required: true
    pathHint: .
```

`.kxm/repo/repo.yaml`:

```yaml
schema: kxm.repository.v1
projectId: prj_01JMINIMAL000000000000000
repositoryId: control
defaultAccess: write
```

`.kxm/agents/coordinator.yaml` (every workflow needs its coordinator agent):

```yaml
schema: kxm.agent.v1
purpose: Coordinate the pinned workflow.
tools:
  preset: coordinator
defaultRepositoryAccess: read
repositories:
  control: read
network: provider-only
resultSchema: kxm.assignment-result.v1
```

`.kxm/agents/implementer.yaml`:

```yaml
schema: kxm.agent.v1
purpose: Implement the requested change in the control repository.
harness: grok
model:
  provider: xai
  model: grok-4.6
tools:
  preset: workspace-writer
defaultRepositoryAccess: none
repositories:
  control: write
network: provider-only
resultSchema: kxm.assignment-result.v1
```

`.kxm/gates.yaml`:

```yaml
schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: [npm, test]
    timeoutMs: 600000
```

`.kxm/workflows/default.yaml`:

```yaml
schema: kxm.workflow.v1
description: Implement a change, then run the test suite.
coordinator: coordinator
limits:
  maxTransitions: 4
steps:
  - id: implement
    kind: agent
    agent: implementer
    maxAttempts: 2
    repositories:
      control: write
    requiredEvidence:
      - key: diff
        kind: artifact
    on:
      passed: verify
      failed:
        target: $terminal
        terminalStatus: failed

  - id: verify
    kind: gate
    gate: test
    maxAttempts: 2
    repositories:
      control: write
    requiredEvidence:
      - key: tests
        kind: gate
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      implementation-failure:
        target: implement
        maxTransitions: 2
```

`.kxm/routes.yaml` (needed only for live drives):

```yaml
schema: kxm.routes.v2
updatedAt: '2026-09-23T00:00:00.000Z'
admitted:
  - xai/grok-4.6
disabled: []
roles: {}
```

Why each piece is there:

- `implement` routes a failure straight to a terminal `failed` status and
  declares `failed`, the outcome the producer falls back to.
- `verify` declares `implementation-failure`, the outcome a failing command
  produces. Routing that edge on `failed` instead is refused when the project
  loads (`gate_outcome_impossible`). The edge back to `implement` makes it a
  back-edge, so it carries `maxTransitions: 2` and the workflow carries
  `limits.maxTransitions`.
- The gate step lists `control: write`; the Runtime refuses command gate steps
  without a writable repository.
- The workflow omits `limits.maxAgentTimeMs`; with it, the Runtime refuses to
  drive the run.
- There is no `.kxm/roles/writer.yaml`. If you add one, it must list
  `xai/grok-4.6`, or the loader reports `role_roster_conflicts_with_agent`.

Validate and run it:

```bash
kxm init --json                              # "action": "validated", "issues": []
kxm run default "Add a health endpoint" --dry-run --json
git add .kxm package.json && git commit -m "Add KXM project"
kxm trust check                              # exit 0: no permission expansion
kxm run default "Add a health endpoint"      # starts the Runtime and prints a run ID
kxm runs drive <runId> --simulated --wait    # model-free drive; runs npm test for real
```

The simulated drive records `passed` for the agent step, runs `npm test` in the
project root, and settles `completed` when it exits 0. When `npm test` fails,
the run returns to `implement` and fails with `budget_step_attempts` once
`implement` has used its two attempts. A live drive of this workflow is refused
today, because the `implement` step has write access (see
[Steps the Runtime does not execute yet](#steps-the-runtime-does-not-execute-yet)).
Stop the Runtime afterwards with `kxm runtime stop`.

In a project that `kxm init` created,
`kxm workflow add <id> --template implement-and-verify` writes a workflow of the
same shape (without the `requiredEvidence` entries), and `kxm run` prints the
matching `kxm runs drive <runId> --simulated --wait` command for each run it
creates.
