# KXM CLI reference

This page documents every command and subcommand the `kxm` operator CLI registers (`@kontextmind/kxm`). For each command it states what the command does, which files and services it reads and writes, whether it needs a running hub or the KXM Runtime supervisor, what `--json` returns, and the exit codes and refusal codes you are likely to see. Environment variables are described in [Environment variables and limits](configuration.md); this page names them only where a command reads them directly.

Output shown under examples was captured from a source checkout, inside a throwaway Git repository, with `HOME`, `KXM_STATE_HOME`, `KXM_USER_CONFIG_DIR`, and the XDG directories pointed at a temporary directory, no harness CLIs on `PATH`, and (where a hub was needed) a disposable hub on a random loopback port. Paths are shortened to `/work/proj` (the project), `/work/kxm` (the KXM checkout), `/state` (the user state root), and `~/.config/kxm` (the user config directory); session tokens are replaced with `<token>`, the machine's host name with `host.local`, and long JSON is trimmed with `...`. Every command either plans under `--dry-run` without changing anything or refuses the flag (see [Dry runs](#dry-runs)); the dry-run examples were captured from the current source tree, with a digest of the throwaway tree taken before and after to confirm that nothing was written. An example captioned "Not run" was not executed for this reference because it starts a long-lived process, writes durable state, stores credentials, or calls an external service; its output is not shown.

## Contents

- [Invoking the CLI](#invoking-the-cli)
- [Global options](#global-options)
- [Output conventions](#output-conventions)
- [Where commands read and write](#where-commands-read-and-write)
- [Task to command](#task-to-command)
- Setup: [`init`](#kxm-init), [`config`](#kxm-config), [`completion`](#kxm-completion), [`trust`](#kxm-trust)
- Hub and sessions: [`hub`](#kxm-hub-view), [`session`](#kxm-session), [`dash`](#kxm-dash), [`studio`](#kxm-studio)
- Harnesses, models, and roles: [`harness`](#kxm-harness), [`auth`](#kxm-auth), [`update`](#kxm-update), [`models`](#kxm-models), [`routes`](#kxm-routes), [`role`](#kxm-role)
- Running work: [`lane`](#kxm-lane), [`land`](#kxm-land), [`assign`](#kxm-assign), [`run`](#kxm-run), [`runs`](#kxm-runs), [`docs`](#kxm-docs), [`runtime`](#kxm-runtime), [`agent`](#kxm-agent), [`workflow`](#kxm-workflow), [`gate`](#kxm-gate), [`peer`](#kxm-peer), [`task`](#kxm-task), [`goal`](#kxm-goal), [`suggest`](#kxm-suggest), [`explain`](#kxm-explain)
- Context and learning: [`context`](#kxm-context), [`memory`](#kxm-memory), [`skills`](#kxm-skills), [`improve`](#kxm-improve), [`routing`](#kxm-routing), [`prices`](#kxm-prices)
- Operations: [`backup`](#kxm-backup), [`restore`](#kxm-restore), [`tenant`](#kxm-tenant), [`ssh`](#kxm-ssh), [`help`](#kxm-help)
- [Known behavior gaps](#known-behavior-gaps)

## Invoking the CLI

An installed CLI is on `PATH` as `kxm`. Install it as described in [Install KXM](../start/install.md).

```bash
kxm --help
```

```text
Usage: kxm [options] [command]

KXM local-first orchestration CLI
...
```

From a source checkout, run the wrapper script instead. It executes the committed `plugins/kxm/dist/cli.js`, so run `npm run build` after changing CLI source.

```bash
node scripts/kxm.mjs --help
```

Everywhere this page shows `kxm`, a source checkout can substitute `node scripts/kxm.mjs`.

Help is available at every level and exits 0:

```bash
kxm workflow --help
```

```bash
kxm help workflow
```

```bash
kxm workflow help start
```

Running a command group without a subcommand prints that group's help and exits 2. Five groups have a default subcommand instead: `kxm config` runs `config list`, `kxm role` runs `role list`, `kxm goal` runs `goal list`, `kxm task` runs `task list`, and `kxm improve` runs `improve report`. `kxm models` opens an interactive screen.

## Global options

| Option | Argument | Default | Description |
|---|---|---|---|
| `--json` | none | off | Print machine-readable JSON |
| `--dry-run` | none | off | Plan without making changes |
| `--workspace` | `<dir>` | `.kxm` (or `KXM_WORKSPACE_DIR`) | Workspace directory |
| `-V`, `--version` | none | none | Print the installed kxm version |
| `-h`, `--help` | none | none | display help for command |

- `--json`, `--dry-run`, and `--workspace` are registered on the root, on every group, and on every subcommand, so `kxm --json config list`, `kxm config --json list`, and `kxm config list --json` are equivalent.
- `kxm init` registers only `--json` and `--dry-run`. It, `kxm trust diff`, `kxm trust check`, `kxm run`, and `kxm task run` refuse `--workspace` (including a root-level `--workspace`) with exit 2 and error `workspace_option_unsupported`, because they discover the project from the current directory.
- `--workspace <dir>` resolves against `KXM_WORKDIR` (or the current directory) and derives `config/`, `logs/`, `assets/`, and `state/` under it, overriding `KXM_CONFIG_DIR`, `KXM_LOGS_DIR`, `KXM_ASSETS_DIR`, and `KXM_STATE_DIR`. Only commands that use workspace directories are affected; see [Where commands read and write](#where-commands-read-and-write).
- `--version` ignores `--json` and prints the bare version.

```bash
kxm -V
```

```text
0.7.1
```

## Output conventions

### JSON results

- Every JSON result carries a `schema` field. Most commands print `kxm.cli-result.v1` with `ok` and `command` fields plus command-specific keys.
- A usage error under `--json` (unknown command or option, missing argument, or missing required option) prints one `kxm.cli-result.v1` object on stdout and exits 2. `ok` is false, `error` is `usage_error`, `command` is the command path, and `detail` is the Commander message. Text mode still prints that message on stderr.
- Gate-style commands print a `kxm.worker-result.v1` envelope, which adds `worker`, `createdAt`, `outcome` (`passed`, `warning`, or `failed`), and `summary`: `gate validate`, `gate artifacts-exist`, `gate degrade`, `gate signal`, `workflow signal`, `gate github watch`, and `agent worker --dry-run`. Outside `--dry-run`, the `gate` subcommands and `workflow signal` also append the envelope to `.kxm/logs/telemetry.jsonl`.
- `session brief` prints `kxm.session-brief.v1` and `tenant status` prints `kxm.tenant-status.v1`.
- The `command` field is not always the words you typed: `hub stop` and `session stop` report `stop`, `session token` reports `auth token`, `routes admit` and `routes disable` report `routes admitted` and `routes disabled`, `models inventory-refresh` reports `models inventory refresh`, `workflow export` reports `retrospective export`, `gate degrade` reports `workflow degrade`, `gate signal` and `workflow signal` report `signal`, `gate github watch` reports `github watch`, `agent worker` reports `worker`, and `improve report` reports `improve`.
- A result with `ok: false` is written to stderr in both text and JSON mode; everything else goes to stdout. `runtime status` is the exception: when the supervisor is down it prints `ok: true, running: false` on stdout and exits 1.
- `peer` subcommands and `workflow checkpoint|record|wait` print the hub's result object as returned, tagged with `schema` but without `ok` or `command`. Their failures print `{"ok":false,"error":"command_failed","detail":"..."}`. Text mode prints the same JSON.
- Several error paths ignore `--json` and print one plain line on stderr: argument checks in `agent worker`, `session start`, `workflow start`, `gate degrade`, `gate signal`, and `gate github watch`; errors from `config`, `role`, `workflow definitions|remove|modify`, `goal`, `task` outside run admission, `memory`, `skills` (other than `skills create --dry-run`), `studio`, and `completion`. `suggest` and `workflow add` failures honor `--json`. Check the exit code before parsing stdout.
- Every `context` subcommand exits 1 with a Node.js stack trace and no JSON when the hub cannot be reached.
- Output is redacted. Values of environment variables whose names contain `TOKEN`, `SECRET`, `KEY`, or `PASSWORD` are replaced with `[redacted]`, and 64-character hex strings are replaced unless they appear in a known digest field such as `configRevision` or `sha256`. `session brief` and `auth token` print the session token itself; treat their output as a credential.

### Dry runs

`--dry-run` changes nothing: no file is written, deleted, or moved, no request that changes hub or Runtime state is sent, no process is started, and no remote command runs. A command that cannot say what it would do without doing some of it refuses the flag instead of acting.

- Plan with `planned`: `backup`, `restore`, `config set`, `role add|remove|modify|resume`, `workflow add|remove|modify`, `goal create`, `task create|run|sync`, `memory note|sync`, `skills evaluate|promote|reject`, `context promote`, `context wiki-compile --out`, `auth token`, `session token`, `session brief`, and `ssh run|file|close`. Each prints its normal result plus `dryRun: true` and `planned`, a list of `{action, target}` entries whose `action` is `write`, `delete`, `move`, `request`, or `ssh`. Text mode prints `dry run: <summary>` and one indented `would <action> <target>` line per entry (`session brief` appends `dry run: would write <file>` lines to the brief instead).
- Plan in their own shape (described in each section): `init`, `run`, `runs drive|cancel`, `docs build|serve`, `runtime start|stop|sync-retry`, `hub start|stop|bind|unbind`, `session start|stop`, `agent worker`, `dash`, `studio serve`, `models inventory-refresh`, `routes admit|disable`, `update`, `completion install`, `workflow start|signal|export|checkpoint|record|wait`, every `peer` subcommand, `gate degrade|signal`, `skills create`, and `improve report`. `gate github watch --dry-run` still polls GitHub but does not post the signal.
- Read-only commands run as usual, without leaving a trace: a local SQLite store is opened without creating `-wal` or `-shm` files, and `runs status|list|receipt` only attach to a running Runtime supervisor. With no supervisor running they exit 2 with `dry_run_unsupported` instead of starting one. `context wiki-compile --dry-run` still asks the hub to compile, which is a read.
- Refused: `kxm models` (the interactive screen) and `kxm prices acknowledge` exit 2 with `dry_run_unsupported`. The CLI keeps one list of the commands that answer `--dry-run` and refuses every other command the same way before it runs, so a command added without dry-run support fails closed.

```bash
kxm config set user.theme light --dry-run
```

```text
dry run: set user.theme = light in project config
  would write /work/proj/.kxm/config.yaml
```

```bash
kxm models --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"models","dryRun":true,"error":"dry_run_unsupported","detail":"this command cannot plan without making changes; rerun without --dry-run"}
```

For this page, 63 `--dry-run` invocations (every command in the first list, the refusals, and a sample of the others) ran in a throwaway project seeded with a role, a global workflow, a task, a goal, a skill candidate with passing evaluations, a WAL-mode hub store, and a backup, with no harness CLIs on `PATH`. A digest of every file under the temporary root before and after showed nothing created, changed, or removed; no Runtime supervisor was started; and the hub saw only the wiki compile. Harness probes (`update`, `suggest`, `harness list`) run the installed harness CLIs to read their versions and login state, and those CLIs can write their own files: Codex creates `~/.codex/tmp/` whenever it runs.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including `--help`, `--version`, and dry-run plans. |
| 1 | The command ran and failed or found a problem (see below). |
| 2 | Usage error: the command refused before acting (see below). |
| 4 | `gate github watch` timed out and posted (or, under `--dry-run`, would have posted) a signed `failed` signal. |
| other | `hub start` and `agent worker` return the exit code of the foreground process; `ssh run` returns the remote command's exit code. |

Exit 1 covers an `ok: false` result, an unreachable hub for `hub view`, permission expansions for `trust check`, a stopped supervisor for `runtime status`, missing local state, and a planning-only `init`.

Exit 2 covers an unknown command or option, a missing argument or required option, a value KXM rejects before acting, `--workspace` where unsupported, conflicting flags, a group run without a subcommand, a removed command (`removed_command`), and `--dry-run` on a command that cannot plan (`dry_run_unsupported`). With `--json`, Commander usage errors are `usage_error` envelopes on stdout and exit 2.

## Where commands read and write

| Location | Contents | Used by |
|---|---|---|
| Project files under `<project>/.kxm/` (reviewed in Git) | `project.yaml`, `agents/`, `workflows/`, `gates.yaml`, `repo/`, `template-provenance.yaml`, `routes.yaml`, `models/inventory.yaml`, `roles/`, `roles`, `modes.yaml`, `prices.yaml` | `init`, `trust`, `run`, `models`, `routes`, `role`, `workflow definitions\|add\|remove\|modify`, `explain`, `studio` |
| Local project records under `<project>/.kxm/` | `config.yaml` (project scope), `goals/`, `tasks/`, `memory/`, `skills/`, `candidates/`, `backups/`, `run/ssh-sockets/` | `config`, `goal`, `task`, `memory`, `skills`, `improve`, `backup`, `ssh` |
| Workspace directories (`.kxm/state`, `.kxm/logs`, `.kxm/assets`, `.kxm/config`; moved by `--workspace` or `KXM_*_DIR`) | hub SQLite store `state/kxm.db` (or `KXM_DATA_PATH`), `state/hub.pid`, `state/session-brief.json`, `state/lanes.json` (mode 0600 lane records), `logs/telemetry.jsonl`, `logs/kxm-hub.jsonl`, `assets/sessions/`, `assets/workflows/`, `assets/improvements/`, `assets/retrospectives/`, legacy `config/agents.json` and `config/gates.json` | `hub`, `session`, `dash`, `lane`, `agent worker`, `workflow list\|get\|export`, `gate`, `improve`, `routing report` |
| User config directory (`KXM_USER_CONFIG_DIR`, default `~/.config/kxm`) | `config.yaml` (user scope), `session.token`, global `roles/` and `workflows/`, `roles`, `completions/` | `config --scope user`, `auth token`, `session brief\|token`, `role`/`workflow` with `--scope global`, `studio serve`, `completion install` |
| User state root (`KXM_STATE_HOME`; macOS `~/Library/Application Support/KXM`; Linux `$XDG_STATE_HOME/kxm` or `~/.local/state/kxm`; Windows `%LOCALAPPDATA%\KXM`) | `hub-env.json` (persisted hub credentials), `hub-binding.json`, `runtime/` (Runtime supervisor registry and per-project run stores), `update.yaml`, repository bindings | `hub start\|bind\|unbind`, every hub client, `run`, `runs`, `runtime`, `tenant status`, `update`, `init --repository`, and (read-only, the project's run store) `improve` and `routing report` |

`init`, `trust`, `run`, `runs`, `docs build`, `docs serve`, `runtime sync-retry`, `tenant status`, and `studio layout` find the project root by walking up from the current directory. `improve` and `routing report` use the current directory's Git root when it holds `.kxm/project.yaml`, to find the project's Runtime run store (and, for `improve`, its configuration and default candidate directory). `config`, `role`, `workflow definitions|add|remove|modify`, `goal`, `task`, `memory`, `skills`, `backup`, `restore`, `studio serve`, and `ssh` (socket directory) use `.kxm` in the current directory. Run those from the project root.

## Task to command

| Task | Commands |
|---|---|
| Set up a project | [`kxm init`](#kxm-init), [`kxm trust check`](#kxm-trust-check), [`kxm config set`](#kxm-config-set) |
| Start or bind a hub | [`kxm hub start`](#kxm-hub-start), [`kxm hub bind`](#kxm-hub-bind), [`kxm hub view`](#kxm-hub-view) |
| Check harness installs and authentication | [`kxm harness list`](#kxm-harness-list), [`kxm update --dry-run`](#kxm-update) |
| Create and drive a run | [`kxm run`](#kxm-run), [`kxm runs drive`](#kxm-runs-drive), [`kxm runtime status`](#kxm-runtime-status) |
| Work in an isolated checkout | [`kxm lane`](#kxm-lane), [`kxm run --lane`](#kxm-run) |
| Land the current branch | [`kxm land`](#kxm-land) |
| Delegate and accept a developer assignment | [`kxm assign`](#kxm-assign) |
| Inspect runs | [`kxm runs list`](#kxm-runs-list), [`kxm runs status`](#kxm-runs-status), [`kxm runs receipt`](#kxm-runs-receipt), [`kxm tenant status`](#kxm-tenant-status), [`kxm workflow list`](#kxm-workflow-list) |
| Message peers | [`kxm peer list`](#kxm-peer-list), [`kxm peer send`](#kxm-peer-send), [`kxm peer await`](#kxm-peer-await), [`kxm peer fanout`](#kxm-peer-fanout) |
| Operate gates and evidence | [`kxm gate validate`](#kxm-gate-validate), [`kxm gate artifacts-exist`](#kxm-gate-artifacts-exist), [`kxm gate signal`](#kxm-gate-signal), [`kxm workflow checkpoint`](#kxm-workflow-checkpoint) |
| Query context and memory | [`kxm context get`](#kxm-context-get), [`kxm context recall`](#kxm-context-recall), [`kxm memory brief`](#kxm-memory-brief), [`kxm memory note`](#kxm-memory-note) |
| Read improvement and routing reports | [`kxm improve report`](#kxm-improve-report), [`kxm routing report`](#kxm-routing-report), [`kxm prices acknowledge`](#kxm-prices-acknowledge) |
| Back up and restore | [`kxm backup`](#kxm-backup), [`kxm restore`](#kxm-restore) |
| Update KXM and harnesses | [`kxm update --check`](#kxm-update), [`kxm update --kxm`](#kxm-update) |

## `kxm init`

```text
kxm init [--name <name>] [--project-id <id>] [--repository <id=absolute-path>]...
```

Creates, validates, repairs, resumes, or joins a KXM project at the Git root that contains the current directory. A new project gets a minimal configuration: one coordinator agent, one implementer agent, a `test` command gate, and a `default` plan-implement-verify workflow. An existing project is validated without rewriting. Conflict-free template updates to non-authority fields are applied; authority changes, overlapping edits, and provenance-free or legacy state stay planning-only. `init` does not start a hub or the Runtime.

The starter `defaultHarness: pi` and `npm test` gate are generic settings, not repository detection. Creation and create-planning output include `guidance`: for Claude, set `defaultHarness: claude` in `.kxm/project.yaml`, update any explicit `harness` overrides in `.kxm/agents/*.yaml`, and configure compatible agent models; for .NET or other non-npm repositories, set `.kxm/gates.yaml` → `gates.test.argv` to the repository's actual test command. Preflight reports an actionable prerequisite for `npm test` without a readable `package.json` test script; `task run` refuses it before creating a run.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--name` | `<name>` | Git root directory name | Project display name for a new project |
| `--project-id` | `<id>` | generated | Stable project ID for controlled provisioning |
| `--repository` | `<id=absolute-path>` | `[]` | Bind a member repository outside Git configuration |

- Global options: `--json` and `--dry-run` only; `--workspace` exits 2 with `workspace_option_unsupported`.
- `--project-id` must match `prj_` followed by 6 to 128 letters, digits, `_`, or `-`. `--repository` is repeatable; each value must be `<id>=<absolute path>`, and a repeated ID fails with `repository_binding_argument_duplicate`.
- Needs a Git repository. Does not need a hub or the Runtime.
- Writes `.kxm/project.yaml`, `.kxm/agents/coordinator.yaml`, `.kxm/agents/implementer.yaml`, `.kxm/gates.yaml`, `.kxm/repo/repo.yaml`, `.kxm/workflows/default.yaml`, and `.kxm/template-provenance.yaml`, using a `.kxm-init-transaction` directory at the Git root while a create or repair is in flight. Repository bindings are written under the user state root, never into Git. `--dry-run` writes nothing.
- On an interactive terminal without `--json` or `--dry-run`, a successful create or join offers to install shell completion (suppress with `KXM_SKIP_COMPLETION_PROMPT=1`) and to write workflow-guide agents (suppress with `KXM_SKIP_GUIDE_SETUP_PROMPT=1`). Guided setup keeps a role only when one of its guide candidates is on a fixed map of reviewed harness/model pairs and that harness is authenticated; it writes the agent and workflow files, appends those selectors to `.kxm/routes.yaml`, and skips every other candidate. Google candidates are not on the map and are always skipped, because the Runtime's Pi one-shot cannot reach Google's `antigravity` Pi provider yet (see [Harness routing](harness-routing.md#google-through-the-antigravity-pi-provider)).
- JSON keys: `action` (`planned`, `created`, `joined`, `repaired`, `resumed`, or `validated`), `mode`, `inspectedFrom`, `projectRoot`, `changesRequired`, `legacyInputs`, `issues`, `configRevision`, `files`, `plannedOnly`, and, when relevant, `guidance`, `localBindingFile`, `bindingsChanged`, `repairPlan`, `resumePending`, `transactionKind`.
- Exit 0 for every completed action and every dry-run plan. Exit 1 when the result is planning-only (legacy state, blocked repair, partial state without provenance) or for `initialization_failed` (with `issues`) and `initialization_io_failed`. A planning-only text result prints the reason and then one `<file>: <code>: <message>` line per validation issue, for example `.kxm/workflows/first.yaml: gate_outcome_impossible: ...`.

Preview what a new project would contain:

```bash
kxm init --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"init","action":"planned","mode":"create","inspectedFrom":"/work/proj","projectRoot":"/work/proj","changesRequired":true,"legacyInputs":[],"issues":[],"files":[".kxm/agents/coordinator.yaml",".kxm/agents/implementer.yaml",".kxm/gates.yaml",".kxm/project.yaml",".kxm/repo/repo.yaml",".kxm/template-provenance.yaml",".kxm/workflows/default.yaml"],"plannedOnly":true}
```

Create the project:

```bash
kxm init --name "Demo"
```

```text
initialized KXM project at /work/proj
```

Validate it again later:

```bash
kxm init --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"init","action":"validated","mode":"ready",...,"configRevision":"sha256:80457232cbfc...","files":[],"plannedOnly":false}
```

Join a cloned multi-repository project (Not run):

```bash
kxm init --repository api=/absolute/path/to/api
```

## `kxm config`

Reads and writes personalization settings (`kxm.config.v1`). The merged view layers built-in defaults, the user file `<KXM_USER_CONFIG_DIR>/config.yaml`, and the project file `.kxm/config.yaml` in the current directory. `kxm config` with no subcommand runs `config list`. None of the subcommands needs a hub.

### `kxm config list`

```text
kxm config list
```

Prints the resolved configuration. Text output shows `schema`, `user`, `defaults`, `dash`, `sync`, and `loadedFrom`; the JSON `config` object also contains `hub`, `improvement`, `routing`, and `telemetry`. An empty `loadedFrom` means no file supplies values yet.

No command-specific options.

- Reads only. JSON keys: `config`.
- Exit 0; exit 1 with a plain `config list failed:` line when a file cannot be parsed.

```bash
kxm config list
```

```text
schema: kxm.config.v1
user:
  theme: dark
  preferredCritics:
    - reviewer-arch
    - reviewer-cli
  tokenBudget: 16000
defaults:
  workflow: software-engineering/feature-implementation
  harness: pi
dash:
  defaultScreen: agents
  refreshIntervalMs: 1000
  autoOpen: false
sync:
  defaultTracker: none
loadedFrom: {}
```

```bash
kxm config list --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"config list","config":{"schema":"kxm.config.v1",...,"hub":{"autoStart":"background"},...,"loadedFrom":{}}}
```

### `kxm config get`

```text
kxm config get <key>
```

Prints one value by dotted key from the merged view.

- Arguments: `<key>`, a dotted path such as `hub.autoStart`.
- No command-specific options. Reads only.
- An unknown key prints `(undefined)` (JSON: no `value` key) and exits 0.
- JSON keys: `key`, `value`.

```bash
kxm config get hub.autoStart
```

```text
background
```

```bash
kxm config get defaults.harness --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"config get","key":"defaults.harness","value":"pi"}
```

### `kxm config set`

```text
kxm config set <key> <value> [--scope user|project]
```

Writes one value into exactly one scope file.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--scope` | `<scope>` | `project` | Configuration scope: user or project (default: project) |

- Arguments: `<key>` (dotted path) and `<value>`. The value is parsed as JSON when it parses (`true`, `5`, `"text"`, `{"a":1}`); otherwise it is stored as a string. Keys are not validated.
- `--scope user` writes `<KXM_USER_CONFIG_DIR>/config.yaml`; any other value writes `.kxm/config.yaml` in the current directory.
- Mutates. `--dry-run` names the file it would write and writes nothing.
- JSON keys: `key`, `value`, `scope` (plus `dryRun` and `planned` under `--dry-run`). Exit 1 with a plain `config set failed:` line on error.

```bash
kxm config set user.theme light --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"config set","key":"user.theme","value":"light","scope":"project","dryRun":true,"planned":[{"action":"write","target":"/work/proj/.kxm/config.yaml"}]}
```

Stop harness extensions from starting a hub (Not run):

```bash
kxm config set hub.autoStart off --scope user
```

## `kxm completion`

```text
kxm completion <bash|zsh|fish>
```

Prints a shell completion script to stdout. With no shell, prints `usage: kxm completion <bash|zsh|fish> | kxm completion install [--shell <shell>] [--no-path]` on stderr and exits 2; an unsupported shell exits 1. The script is printed as text even with `--json`. The generated command list lags the CLI (see [Known behavior gaps](#known-behavior-gaps)).

- Arguments: `[shell]`, one of `bash`, `zsh`, `fish` (or the `install` subcommand).
- Reads only.

Print the bash script:

```bash
kxm completion bash
```

```text
#!/usr/bin/env bash
# Bash completion for kxm
...
```

Save the zsh script into a directory on your `fpath` (Not run):

```bash
kxm completion zsh > ~/.zfunc/_kxm
```

### `kxm completion install`

```text
kxm completion install [--shell <shell>] [--no-path]
```

Installs tab completion for the detected or given shell and, unless `--no-path` is set, adds the directory containing `kxm` to `PATH` in the shell's rc file.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--shell` | `<shell>` | detected from `$SHELL` | Shell to install for (bash, zsh, fish; default: detect from $SHELL) |
| `--no-path` | none | off | Only install completion; do not add a PATH entry |

- Writes `<KXM_USER_CONFIG_DIR>/completions/kxm.<shell>` and a source stanza in `~/.bashrc` (or `~/.bash_profile`) or `$ZDOTDIR/.zshrc` (or `~/.zshrc`); fish writes `~/.config/fish/completions/kxm.fish` (or under `XDG_CONFIG_HOME`) and needs no rc edit. Idempotent. Honors `--dry-run`.
- JSON keys: `shell`, `scriptPath`, `rcFile`, `rcModified`, `alreadyInstalled`, `path`, `dryRun`. Exit 1 with `shell_not_detected` when the shell cannot be determined.

Preview the change (Not run):

```bash
kxm completion install --shell zsh --dry-run
```

## `kxm trust`

Compares the authority-bearing fields of the project configuration against a base Git revision. The base is materialized into a temporary shadow with a sanitized environment; nothing in the project is written. Both subcommands refuse `--workspace` (exit 2) and need no hub.

The comparison covers the loaded bundle only: `project.yaml`, `agents/`, `models/`, `workflows/`, `gates.yaml`, `project/env.yaml`, and each member repository's `repo.yaml` and `env.yaml`. It does not read `routes.yaml`, `roles/`, `the role files`, or `prices.yaml`, so a new route admission, roster entry, developer policy route, or price change never counts as an expansion. Review those files by hand.

### `kxm trust diff`

```text
kxm trust diff [--base <revision>]
```

Prints the structured `kxm.permission-diff.v1` report: every authority-bearing change classified as an expansion, narrowing, or neutral change, with per-field value hashes.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--base` | `<revision>` | `HEAD` | Base Git revision (default: HEAD) |

- Reads only. Exit 0 even when expansions exist.
- JSON keys: `baseRevision`, `candidateRevision`, `requiresReview`, `expansions`, `narrowings`, `neutralChanges` (counts), `changes` (each with `resource`, `path`, `field`, `direction`, `summary`, `baseValueSha256`, `candidateValueSha256`).
- Errors: `trust_diff_failed` with `issues` (for example `resource_missing` when the base revision has no `.kxm/project.yaml`), `trust_diff_io_failed`. Both exit 1.

After widening the coordinator's repository access from `read` to `write`:

```bash
kxm trust diff
```

```text
permission diff: sha256:80457232cbfc… -> sha256:7428fde55ca4…
EXPANSION  .kxm/agents/coordinator.yaml /repositories/control repository-access changed (expansion)
1 expansion(s) require explicit reviewed trust action
```

Compare against an older commit:

```bash
kxm trust diff --base main --json
```

Not run against `main`; a base without `.kxm/project.yaml` fails with `resource_missing`.

### `kxm trust check`

```text
kxm trust check [--base <revision>]
```

Same comparison as `trust diff`, but exits 1 when any expansion exists so an authority-widening change cannot merge without review. Formatting and description-only changes never fail the check.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--base` | `<revision>` | `HEAD` | Base Git revision (default: HEAD) |

- Reads only. JSON keys are the same as `trust diff`; `ok` is `false` when review is required.
- Exit 0 with no expansions, 1 with expansions or on failure.

```bash
kxm trust check
```

```text
permission diff: sha256:80457232cbfc… -> sha256:7428fde55ca4…
EXPANSION  .kxm/agents/coordinator.yaml /repositories/control repository-access changed (expansion)
1 expansion(s) require explicit reviewed trust action
trust check failed: review every expansion above before merging
```

```bash
kxm trust check --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"trust check",...,"requiresReview":true,"expansions":1,"narrowings":0,"neutralChanges":0,"changes":[{"resource":".kxm/agents/coordinator.yaml","path":"/repositories/control","field":"repository-access","direction":"expansion",...}]}
```

<a id="hub-commands"></a>

## `kxm hub`

Starts, inspects, and stops the local KXM hub, and binds this machine to a hub. Hub clients pick their target in this order: `KXM_SERVER_URL`, the binding written by `kxm hub bind`, then `http://127.0.0.1:7331`.

### `kxm hub view`

```text
kxm hub view
```

Calls `GET /health` and `GET /ready` on the target hub and reports whether the URL is loopback or remote.

No command-specific options.

- Needs a hub to succeed. Reads only.
- JSON keys: `target` (`url`, `scope`, and `source: "env"` when `KXM_SERVER_URL` overrides a binding), `health`, `ready`. An unreachable hub reports `{"error":"hub_unreachable"}` for both probes.
- Exit 0 when both probes succeed, 1 otherwise.

```bash
kxm hub view
```

```text
hub health=true ready=true · loopback hub
```

```bash
kxm hub view --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"hub view","target":{"url":"http://127.0.0.1:46315","scope":"loopback"},"health":{"ok":true,"agents":0},"ready":{"ok":true,"storage":"sqlite"}}
```

### `kxm hub start`

```text
kxm hub start
```

Runs the hub in the foreground through `scripts/kxm-hub.mjs`, passing the workspace directories and `KXM_SERVER_URL` to it. The hub listens on `KXM_HOST` (default `127.0.0.1`) and `KXM_PORT` (default `7331`) and refuses a non-loopback bind without `KXM_AUTH_TOKEN`. When `KXM_AUTH_TOKEN` is unset, the admin token is read from, or generated once into, `hub-env.json` under the user state root.

No command-specific options.

- Writes `.kxm/state/hub.pid`, the SQLite store `.kxm/state/kxm.db` (or `KXM_DATA_PATH`), and `.kxm/logs/kxm-hub.jsonl`.
- On installs other than a source checkout, prints a cached update notice and refreshes it from the release source.
- `--dry-run` prints the plan (JSON key `workspace`) and starts nothing. Otherwise there is no JSON result; the exit code is the hub process's exit code.

Start a hub on a chosen port:

```bash
KXM_PORT=46315 KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm hub start
```

```text
kxm hub listening at http://127.0.0.1:46315; storage=/work/proj/.kxm/state/kxm.db; auth=token
```

```bash
kxm hub start --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"hub start","dryRun":true,"workspace":"/work/proj/.kxm"}
```

### `kxm hub stop`

```text
kxm hub stop [--wait-ms <ms>]
```

Requests a generation-matched shutdown of every managed hub and worker in the workspace by writing `hub.stop` and `worker-*.stop` control files next to the live `*.pid` claims, then waits for the claims to clear. An orphaned hub server whose wrapper died is sent `SIGTERM`, then `SIGKILL` if it lingers.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--wait-ms` | `<ms>` | `5000` | How long to wait for PID files to clear |

- `--wait-ms` is clamped to 100 through 30000.
- Mutates process state. `--dry-run` lists the PID files (JSON key `pidFiles`) and signals nothing.
- JSON keys: `requested`, `stopped`, `timedOut`, `orphans` (when any), `ignored`.
- Exit 1 when the state directory has no claims (`no_pid_files`), when no claim belongs to a live process, or when the wait times out.

```bash
kxm hub stop --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"stop","dryRun":true,"pidFiles":["hub.pid"]}
```

```bash
kxm hub stop --wait-ms 8000 --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"stop","requested":["hub.pid"],"stopped":["hub.pid"],"timedOut":[],"ignored":[]}
```

### `kxm hub bind`

```text
kxm hub bind <url>
```

Binds this machine to a running hub by writing `hub-binding.json` under the user state root, then probes the hub's health for up to 300 ms. Every hub client uses the binding when `KXM_SERVER_URL` is unset.

- Arguments: `<url>`, Hub base URL (http or https).
- A URL with credentials, a query, a fragment, or a scheme other than http or https fails with `hub_url_invalid` (exit 2).
- A remote (non-loopback) URL is refused with `hub_bind_unauthenticated` (exit 2, `nextAction: "export_kxm_auth_token"`) unless a credential for the current project resolves from `KXM_AUTH_TOKEN` or the persisted `hub-env.json`. A malformed record fails with `hub_credential_unreadable` (exit 2).
- Mutates the binding file. `--dry-run` validates and prints the plan without writing.
- JSON keys: `url`, `scope`, `file`, `health` (`on`, `off`, or `unknown`), `probeMs`.

```bash
kxm hub bind http://127.0.0.1:7331 --dry-run
```

```text
would bind hub http://127.0.0.1:7331 (loopback)
```

```bash
kxm hub bind https://hub.example.com --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"hub bind","error":"hub_bind_unauthenticated","url":"https://hub.example.com","scope":"remote","project":"proj","nextAction":"export_kxm_auth_token","hint":"export KXM_AUTH_TOKEN (or point KXM_STATE_HOME at the hub-env record that already holds one), then re-run; the hub itself requires a token beyond loopback (needs a token for project proj)"}
```

### `kxm hub unbind`

```text
kxm hub unbind
```

Removes this machine's hub binding, including a malformed binding record.

No command-specific options.

- Mutates the binding file. `--dry-run` prints the file it would remove.
- JSON keys: `url`, `file`. Exit 1 with `hub_not_bound` when there is no binding.

```bash
kxm hub unbind --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"hub unbind","dryRun":true,"file":"/state/hub-binding.json"}
```

## `kxm session`

Session manifests, process claims, the session-start briefing, and local session tokens. None of these commands launches an agent.

### `kxm session status`

```text
kxm session status
```

Lists the `*.pid` claim files and `worker-recovery-*.json` envelopes in the workspace state directory and whether each claimed process is alive. It does not read session manifests.

No command-specific options.

- Reads only. No hub needed.
- JSON keys: `claims` (`file`, `role`, `pid`, `startedAt`, `live`), `recoveries` (`file`, `reason`, `agentName`, `project`, `createdAt`, `runId`, `stageId`, `freshSession`).

```bash
kxm session status
```

```text
0 session claim(s), 0 recovery envelope(s)
```

With a hub running:

```bash
kxm session status --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"session status","claims":[{"file":"hub.pid","role":"hub","pid":81619,"startedAt":"2026-09-23T13:53:08.896Z","live":true}],"recoveries":[]}
```

### `kxm session brief`

```text
kxm session brief [--status] [--token]
```

Prints recent tasks (workflow runs) and plans (journal entries) from the local hub store, with a status line for harness chrome. It probes the hub at `KXM_SERVER_URL` or the bound URL for up to 300 ms; with neither set it reports the hub as off (`evidence: "unconfigured"`). It never starts a hub and never prints message bodies.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--status` | none | off | Print only the status line |
| `--token` | none | off | Issue interactive session token with operator policy |

- Side effects: on first use it mints a 24-hour operator session token and writes it to `<KXM_USER_CONFIG_DIR>/session.token` (mode 0600), and it caches the brief in `.kxm/state/session-brief.json`. Under `--dry-run` it still probes the hub and prints the brief, but it mints no token, writes neither file, and appends a `dry run: would write <file>` line for each (JSON: `dryRun` and `planned`); with no saved token the output carries no token. `--token --dry-run` plans only the token file.
- The default text output ends with the session token, and `--token` prints only the token. Treat the output as a credential.
- JSON (`kxm.session-brief.v1`) keys: `generatedAt`, `staleSeconds`, `source`, `hub` (`state`, `evidence`, `online`, `url`, `scope`), `stats`, `tasks`, `plans`, `statusLine`, `widgetLines`, `sessionToken`.

```bash
kxm session brief
```

```text
kxm hub:on · idle · dirty

No recent tasks or plans.

Session token: <token>
```

```bash
kxm session brief --status
```

```text
kxm hub:on · idle
```

```bash
kxm session brief --json
```

```text
{"schema":"kxm.session-brief.v1","generatedAt":"2026-09-23T13:49:55.253Z","staleSeconds":5,"source":"legacy","hub":{"state":"off","evidence":"probed","online":false,"url":"http://127.0.0.1:59998","scope":"loopback"},"stats":{"activeTasks":0,"waitingTasks":0,"planCount":0,"inbox":0,"runTotal":0},"tasks":[],"plans":[],"statusLine":"kxm hub:off · idle",...,"sessionToken":"<token>"}
```

Before the first token exists:

```bash
kxm session brief --status --dry-run
```

```text
kxm hub:on · idle · dirty
dry run: would write ~/.config/kxm/session.token
dry run: would write /work/proj/.kxm/state/session-brief.json
```

### `kxm session token`

```text
kxm session token [--status] [--clear] [--issue]
```

Identical to [`kxm auth token`](#kxm-auth-token), including its JSON (`command` is `auth token`).

| Option | Argument | Default | Description |
|---|---|---|---|
| `--status` | none | off | Check status of the active session token |
| `--clear` | none | off | Clear persisted disk session token |
| `--issue` | none | off | Force issuing a fresh session token |

```bash
kxm session token --status --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"auth token","source":"disk","valid":true,"sessionId":"session-280238cf-867f-4852-a09a-0ae88fe5d01c","issuedAt":"2026-09-23T13:49:55.195Z","expiresAt":"2026-09-24T13:49:55.195Z","path":"~/.config/kxm/session.token"}
```

### `kxm session start`

```text
kxm session start (--workflow <id> | --mix <names>) [--id <id>]
```

Writes a `kxm.session.v1` manifest and creates asset directories. It does not start any process or dispatch a workflow.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--id` | `<id>` | `session_<12 hex>` | Session id |
| `--workflow` | `<id>` | none | Workflow definition id |
| `--mix` | `<names>` | none | Comma-separated agent and gate names |

- Exactly one of `--workflow` or `--mix` is required (exit 2 otherwise).
- Names are resolved against the legacy workspace files `.kxm/config/agents.json` and `.kxm/config/gates.json`. A project created by `kxm init` has neither, so `--mix` fails there with `unknown worker name in session roster` (exit 2) and `--workflow` records an empty roster.
- Writes `.kxm/assets/sessions/<id>/session.json` with `inputs/` and `outputs/`; `--workflow` also creates `.kxm/assets/workflows/<id>/{inputs,outputs,generated}`. `--dry-run` writes nothing.
- JSON keys: `session` (`schema`, `id`, `host`, `mode`, `workers`, `createdAt`, `assetDir`, `workflowId`), `created`, `dryRun`.

```bash
kxm session start --id demo --workflow default --dry-run
```

```text
session demo (workflow)
```

```bash
kxm session start --id review-pass --mix reviewer,test-gate
```

Not run: needs `.kxm/config/agents.json` and `gates.json` entries with those names.

### `kxm session stop`

```text
kxm session stop [--wait-ms <ms>]
```

The same operation as [`kxm hub stop`](#kxm-hub-stop): it stops every managed hub and worker in the workspace and is not scoped to one session.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--wait-ms` | `<ms>` | `5000` | How long to wait for PID files to clear |

```bash
kxm session stop --dry-run
```

```text
would signal pid files
```

## `kxm dash`

```text
kxm dash [--screen <name>]
```

Opens the live dashboard over the hub's server-sent events and a read-only snapshot of the local hub store. On a terminal it is interactive (`1`–`7` switch tabs, `h` help, `q` quit). Without a terminal it prints one plain snapshot and exits.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--screen` | `<name>` | `agents` | agents, tasks, workflows, plans, inbox, procs, or spend |

- Needs a hub for live data. Treat it as an observer: its action keys `a`, `r`, `s` and `c` post to hub routes that do not exist, so they change nothing even though the status line reports success, and `d` creates a git branch and worktree (see [Monitor KXM](../operations/monitoring.md#watch-live-work-with-kxm-dash)).
- `--json` is refused (exit 2); use `kxm hub view`. An unknown screen exits 2 with `unknown_screen`. `--dry-run` prints `serverUrl`, `transport`, and `screen`.

```bash
kxm dash --screen workflows
```

```text
 kxm dash       ● hub ok  ● ready  live ops  0/5 online  updated 13:53:46 UTC · http://127.0.0.1:46315
  1 Agents 0/5   2 Tasks 0  [3 Workflows 0]  4 Plans 0   5 Inbox 0   6 Procs 1/1   7 Spend 0
 list                          detail
 Nothing here yet              No run selected
 tab Workflows · list · 1–7 tabs · h help · a/r/d/s/c · q quit · live
```

```bash
kxm dash --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"dash","dryRun":true,"serverUrl":"http://127.0.0.1:59998","transport":"sse"}
```

## `kxm studio`

Web Studio layout utilities. Neither subcommand needs a hub.

### `kxm studio layout`

```text
kxm studio layout [workflowPath]
```

Compiles a workflow definition and prints the Studio layout JSON (`kxm.studio-layout.v1`): a stepper, a DAG of nodes and edges, and role swimlanes. Without a path it reads `.kxm/workflows/default.yaml` under the discovered project root, or a built-in sample workflow when that file does not exist. Swimlane timings are placeholders, and `workflowId` is always reported as `default`.

- Arguments: `[workflowPath]`, a workflow YAML file.
- No command-specific options. Reads only. Text mode prints the same layout as indented JSON.
- JSON keys: `layout` (`schema`, `workflowId`, `generatedAt`, `stepper`, `dag`, `temporalSwimlanes`).

```bash
kxm studio layout --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"studio layout","layout":{"schema":"kxm.studio-layout.v1","workflowId":"default",...,"stepper":[{"id":"plan","label":"plan","kind":"agent","status":"pending"},{"id":"implement",...},{"id":"verify","label":"verify","kind":"gate","status":"pending"}],...}}
```

### `kxm studio serve`

```text
kxm studio serve [-p <port>] [--host <host>] [--token <token>]
```

Serves the Web Studio on `http://127.0.0.1:4242` until interrupted. It serves `/`, `/health`, `GET /api/layout`, and `POST /api/mutate`. The plan comes from `.kxm/workflows/default.yaml` in the current directory, or the first YAML file in `.kxm/workflows/`.

> [!WARNING]
> Every response carries `Access-Control-Allow-Origin: *`, so any web page open in a browser on this machine can read `/api/layout` (your workflow plan). `POST /api/mutate` requires `Authorization: Bearer <session token>` only when a session token resolves (`--token`, `KXM_SESSION_TOKEN`, or the on-disk token); with none, it accepts any caller. An allowlisted command name gets HTTP 501 with `ok: false`, `executed: false`, `mappedToCli: false` and `error: "mutation_handler_missing"`, because `kxm studio serve` wires no mutation handler; it executes nothing. Keep the default loopback `--host`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `-p`, `--port` | `<port>` | `4242` | Port to bind (default: 4242) |
| `--host` | `<host>` | `127.0.0.1` | Host address to bind |
| `--token` | `<token>` | `KXM_SESSION_TOKEN`, then the on-disk session token | Session token for mutation authentication |

- Honors `--dry-run` (JSON keys `port`, `host`). A live server prints `port`, `host`, `url` and runs until `SIGINT` or `SIGTERM`.

```bash
kxm studio serve --dry-run
```

```text
would start studio server on http://127.0.0.1:4242
```

```bash
kxm studio serve --port 5000
```

Not run: starts a long-lived server.

## `kxm harness`

### `kxm harness list`

```text
kxm harness list
```

Probes the built-in harness catalog (`pi`, `claude`, `kimi`, `codex`, `deepseek`, `grok`, `agy`) and reports which are installed, which are authenticated, whether KXM can dispatch to them, and which native updaters exist. Detection runs `<harness> --version`; authentication runs the harness's own status command (`claude auth status`, `kimi provider list`, `codex login status`, `grok models`, `agy models`), which may contact that harness's service.

No command-specific options.

- Reads only. No hub needed. In a KXM project, `defaultHarness` and the inventory's default marker reflect `.kxm/project.yaml`; outside a project they default to Pi. Invalid project configuration must be repaired before the project default can be resolved.
- JSON keys: `defaultHarness`, `harnesses` (each with `id`, `label`, `default`, `mode`, `detected`, `authenticated`, `dispatch` (`status`, `supported`, `reason`), `canUpdate` (`self`, `extensions`, `models`), `issues`).
- Errors: `harness_list_failed` with configuration `issues`, or `harness_list_io_failed` (exit 1); both honor `--json` and write to stderr without claiming a fallback project default.
- `dispatch` is `yes` only when the harness is detected, has an audited read-only one-shot profile, and is authenticated. Otherwise the first failing check gives the reason: `not_detected`, `no_headless_mode`, `permission_profile_unaudited` (a detected `deepseek`), `not_authenticated`, or the auth issue when login state is unknown (`auth_context_required` for Pi, `auth_unknown`, `auth_unparsed`, or another `auth_*` code).

Captured with no harness CLIs on `PATH`:

```bash
kxm harness list
```

```text
default harness: pi (used when an agent omits harness:)
enable/disable = Git YAML (.kxm/agents, .kxm/models) or the harness's own plugin CLI
governed kxm skills are not auto-updated
id        default  detected  auth     dispatch                   updates
pi        yes      no        no       no (not_detected)          self,extensions,models
claude    no       no        no       no (not_detected)          self,extensions
kimi      no       no        no       no (not_detected)          self
codex     no       no        no       no (not_detected)          self
deepseek  no       no        no       no (not_detected)          self
grok      no       no        no       no (not_detected)          self
agy       no       no        no       no (not_detected)          self
```

```bash
kxm harness list --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"harness list","defaultHarness":"pi","harnesses":[{"id":"pi","label":"Pi","default":true,"mode":"headless","detected":false,"authenticated":false,"dispatch":{"status":"no","supported":false,"reason":"not_detected"},"canUpdate":{"self":true,"extensions":true,"models":true},"issues":[]},...]}
```

## `kxm auth`

### `kxm auth token`

```text
kxm auth token [--status] [--clear] [--issue]
```

Inspects, issues, or clears the local session token that scopes CLI agent-tool commands (`peer`, `workflow checkpoint|record|wait`). A token is a `kxm.session-token.v1` record with an operator tool policy and a 24-hour expiry, stored in `<KXM_USER_CONFIG_DIR>/session.token`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--status` | none | off | Check status of the active session token |
| `--clear` | none | off | Clear persisted disk session token |
| `--issue` | none | off | Force issuing a fresh session token |

- With no flag, prints the valid on-disk token, minting and saving one if none exists. `--issue` always mints and saves a new one. `--clear` deletes the file. `--status` checks `KXM_SESSION_TOKEN` first, then the file.
- Mutates (except `--status`). Under `--dry-run`, `--issue` (or no flag with no saved token) plans the token file write and prints no token, `--clear` plans the deletion (`cleared` reports whether the file exists), and no flag with a saved token prints that token as usual. No hub needed.
- JSON keys: `token`; `cleared`; or for `--status`: `source` (`env` or `disk`), `valid`, `sessionId`, `issuedAt`, `expiresAt`, `path`. Dry runs add `dryRun` and `planned`.
- `--status` exits 1 with `no_token` when neither source has a token, and 1 when the environment token is invalid or expired.
- A malformed or expired `KXM_SESSION_TOKEN` or token file makes agent-tool commands fail with `session_token_invalid`; a policy that excludes a tool fails with `tool_policy_denied`.

```bash
kxm auth token --status
```

```text
No active session token found in env or disk
```

```bash
kxm auth token --issue --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"auth token","dryRun":true,"planned":[{"action":"write","target":"~/.config/kxm/session.token"}]}
```

```bash
kxm auth token --issue --json
```

Not run: stores a credential.

## `kxm update`

```text
kxm update [harness] [--check | --kxm] [--self | --extensions | --models]
```

Checks for or applies a KXM operator package update, and runs the native updaters of detected harnesses.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--check` | none | off | Check for a kxm package update without applying |
| `--kxm` | none | off | Apply the kxm operator package update (GitHub release tarball or npm) |
| `--self` | none | off | Update only the harness CLI |
| `--extensions` | none | off | Update only extensions/plugins (Pi packages, Claude kxm) |
| `--models` | none | off | Refresh model catalogs where the harness supports it |

- Arguments: `[harness]`, Harness id (default: every detected harness).
- `--check` cannot be combined with any other update flag or a harness (exit 2, `scope_conflict`), and at most one of `--self`, `--extensions`, `--models` is allowed (exit 2).
- From a source checkout, `--check` reports the running version without network access, and `--kxm` is refused (exit 2, `install_kind_source`) with an instruction to `git pull`. Only npm-global installs can apply `--kxm`; other install kinds exit 2 with `install_kind_<kind>`. A GitHub release must publish a sha256 digest for `kxm-<version>.tgz` or the install fails closed (`release_digest_missing`, `release_digest_mismatch`).
- Settings come only from `update.yaml` under the user state root (`auto: true` enables auto-apply); a project `.kxm/update.yaml` is ignored with a warning.
- Without `--check` or a lone `--kxm`, KXM probes harnesses (as `harness list` does) and runs each updater for the selected scope. An unknown harness id exits 2 (`unknown_harness` step); a failed step exits 1.
- Honors `--dry-run`: steps are planned, not run, and the cached update notice is not refreshed.
- JSON keys: `--check` gives `current`, `available`, `auto`, `source`, `latest`, `message`, `installKind`, `root`; otherwise `dryRun`, `scope`, `notice`, `kxm` (when applying), `steps` (`harness`, `scope`, `command`, `args`, `outcome`, `detail`), `installKind`, `root`.

```bash
kxm update --check --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"update check","current":"0.7.1","available":false,"auto":false,"source":"github","installKind":"source","root":"/work/kxm","message":"kxm 0.7.1 (running from source at /work/kxm)"}
```

```bash
kxm update --dry-run
```

```text
nothing to update
```

```bash
kxm update --kxm --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"update","error":"install_kind_source","installKind":"source","root":"/work/kxm","instruction":"kxm is running from source at /work/kxm; update it with git pull there, not kxm update --kxm"}
```

## `kxm models`

```text
kxm models
```

Opens an interactive screen over `.kxm/models/inventory.yaml` that shows each model's route state and role bindings. Keys: `a` admit, `d` disable, `r` add a role binding, `x` remove a role binding, `q` quit. Changes are written to `.kxm/routes.yaml` and `.kxm/roles/<role>.yaml` in `KXM_WORKDIR` or the current directory.

- Needs an interactive terminal. With `--json` or without a TTY it exits 2 with `interactive_tty_required`.
- `r` and `x` also mark the model `admitted` in `.kxm/routes.yaml`. So `x` re-admits a disabled route while it removes the role binding, and `r` admits the route as well as binding it.
- `r` binds the role only when a `kxm.model.v2` file matches the inventory id (`model`, or `vendor/model`). It appends `{route: <route-id>}` and creates a v2 role file when the role is new. A selector with no matching model file is refused with `unknown route` before either file is written. `kxm models` does not write a v1 roster entry.

```bash
kxm models --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"models","error":"interactive_tty_required"}
```

### `kxm models inventory-refresh`

```text
kxm models inventory-refresh
kxm models refresh
```

Refreshes the YAML model inventory from the OpenRouter (`https://openrouter.ai/api/v1/models`) and Nous (`https://inference-api.nousresearch.com/v1/models`) catalogs, recording standard and discount prices. `OPENROUTER_API_KEY` and `NOUS_API_KEY` are sent when set; `KXM_OPENROUTER_MODELS_URL` and `KXM_NOUS_MODELS_URL` override the endpoints. `refresh` is an alias.

No command-specific options.

- Writes `.kxm/models/inventory.yaml`. Calls external services. Honors `--dry-run`.
- JSON keys: `output`, `models`, `sources` (per source: `url`, `ok`, `error`). Exit 1 when any source failed.

```bash
kxm models refresh --dry-run
```

```text
would refresh .kxm/models/inventory.yaml
```

## `kxm routes`

Admits or disables model routes recorded in `.kxm/routes.yaml` (`kxm.routes.v2`) in `KXM_WORKDIR` or the current directory. A retired `.kxm/producers.yaml` makes these commands fail. None needs a hub.

### `kxm routes list`

```text
kxm routes list
```

Lists admitted and disabled routes.

No command-specific options.

- Reads only. JSON keys: `policy` (`schema`, `updatedAt`, `admitted`, `disabled`) and `membership` (strings `<role> <route-id>` from `.kxm/roles/*.yaml`). `policy` has no `roles` field. A model file named by no roster, such as `opus-claude`, is absent from `membership`.

```bash
kxm routes list
```

```text
admitted anthropic/fable
admitted google/gemini-3.8-flash-high
admitted google/gemini-3.8-flash-medium
admitted openai/gpt-5.6-sol
admitted openrouter/qwen/qwen3-coder-plus
admitted openrouter/qwen/qwen3.8-flash
admitted openrouter/z-ai/glm-5.3-flash
admitted qwen-token-plan/deepseek-v4.1-flash
admitted qwen-token-plan/qwen3.8-flash
admitted qwen-token-plan/qwen3.8-max
admitted xai/grok-4.7
admitted zai-coding-cn/glm-5.3
admitted zai-coding-cn/glm-5.3-flash
planner fable-claude
reviewer-arch fable-claude
reviewer-cli sol-codex
writer grok-native
writer qwen-openrouter-pi
writer gemini-agy
```

```bash
kxm routes list --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"routes list","policy":{"schema":"kxm.routes.v2","updatedAt":"2026-09-24T00:00:00.000Z","admitted":["anthropic/fable","google/gemini-3.8-flash-high","google/gemini-3.8-flash-medium","openai/gpt-5.6-sol","openrouter/qwen/qwen3-coder-plus","openrouter/qwen/qwen3.8-flash","openrouter/z-ai/glm-5.3-flash","qwen-token-plan/deepseek-v4.1-flash","qwen-token-plan/qwen3.8-flash","qwen-token-plan/qwen3.8-max","xai/grok-4.7","zai-coding-cn/glm-5.3","zai-coding-cn/glm-5.3-flash"],"disabled":[]},"membership":["planner fable-claude","reviewer-arch fable-claude","reviewer-cli sol-codex","writer grok-native","writer qwen-openrouter-pi","writer gemini-agy"]}
```

### `kxm routes count`

```text
kxm routes count
```

Counts admitted and disabled routes.

No command-specific options.

- Reads only. JSON keys: `admitted`, `disabled`, `summary`.

```bash
kxm routes count
```

```text
0 admitted / 0 disabled
```

### `kxm routes admit`

```text
kxm routes admit [--model <id>]
```

Admits a model route from the inventory.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--model` | `<id>` | interactive picker | Exact model id; omit to choose interactively |

- The model must exist in `.kxm/models/inventory.yaml` (case-insensitive match). Without `--model`, a terminal shows a numbered picker of up to 100 models. With no inventory, no TTY, or `--json`, it exits 2 with `model_selection_required`.
- Writes `.kxm/routes.yaml`. Honors `--dry-run`.
- JSON keys: `model`, `policy` (or `dryRun`).

```bash
kxm routes admit --model x-ai/grok-4.6 --dry-run
```

Not run with an inventory; without one it exits 2 with `model_selection_required`.

### `kxm routes disable`

```text
kxm routes disable [--model <id>]
```

Disables a model route from the inventory. Same selection rules, output, and errors as `routes admit`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--model` | `<id>` | interactive picker | Exact model id; omit to choose interactively |

```bash
kxm routes disable --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"routes disabled","error":"model_selection_required"}
```

## `kxm role`

Manages role definitions (`kxm.role.v2`). A role file is `.kxm/roles/<role>.yaml` in the project, or `<KXM_USER_CONFIG_DIR>/roles/<role>.yaml` for global scope. A local role with the same ID overrides a global one. `kxm role` with no subcommand runs `role list`. For `--pick` without a value on a non-interactive shell, set `KXM_PICK_SELECT` to an index or ID. Errors from this group are plain text on stderr, even with `--json`.

A roster entry is `{route, effort, mode}`. `route` names `.kxm/models/<route-id>.yaml`. The first entry is the primary route. `kxm role add --route` writes that roster. `kxm role modify --add-route` and `--remove-route` change it.

### `kxm role list`

```text
kxm role list [--scope all|global|local]
```

Lists configured roles across scopes.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--scope` | `<scope>` | `all` | Filter by scope: all, global, or local |

- Reads only. JSON keys: `roles`.

```bash
kxm role list
```

```text
No roles configured.
```

### `kxm role get`

```text
kxm role get <roleId> [--scope all|global|local]
```

Prints a role definition as YAML.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--scope` | `<scope>` | `all` | Filter by scope: all, global, or local |

- Reads only. JSON keys: `roleId`, `scope`, `filePath`, `role`. A missing role prints `kxm: role '<id>' not found` and exits 1.

```bash
kxm role get writer --scope local
```

In a fresh project this exits 1 with `kxm: role 'writer' not found`. This checkout's writer is the `kxm role get writer --json` example under [`kxm role modify`](#kxm-role-modify).

### `kxm role add`

```text
kxm role add [roleId] [--file <path>] [--description <text>] [--skills <skills>] [--route <route-id>] [--scope global|local] [--overwrite] [--pick [selection]]
```

Adds a role definition. Without a role ID, or with `--pick`, local scope offers existing global roles. The choice is written under its own ID: a copy of the global role file, with `--description`, `--skills`, and `--route` replacing its description, skills, and roster. Repeat `--route`. The first id is the primary roster entry. With `--file`, the YAML file is used and its `id` is replaced by the role ID. `--route` does not replace the file's roster. Otherwise a role with only the given options is written.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--file` | `<path>` | none | Path to YAML role definition file |
| `--description` | `<text>` | `Role <id>` | Role description |
| `--skills` | `<skills>` | none | Comma-separated skills list |
| `--route` | `<route-id>` | none | Route id under `.kxm/models/`. Repeatable. The first id is primary |
| `--scope` | `<scope>` | `local` | Configuration scope: global or local (default: local) |
| `--overwrite` | none | off | Overwrite existing role definition if present |
| `--pick` | `[selection]` | none | Pick a global role to copy (index or id) |

- Writes `.kxm/roles/<id>.yaml` in local scope, or `<KXM_USER_CONFIG_DIR>/roles/<id>.yaml` in global scope. `--dry-run` plans the write and writes nothing.
- Each `--route` is checked the same way as `kxm role modify --add-route`. If `.kxm/models/<route-id>.yaml` is missing, the command exits 1 and writes `kxm: route '<route-id>' is not a file under .kxm/models/` to stderr. It does not write the role file, including under `--dry-run`. `--file` checks every `roster[].route` the same way before writing, in local scope and in global scope.
- Local scope belongs to a KXM project: the file lands in the project root's `.kxm/roles/` from any subdirectory, and outside a project the command refuses with `project_not_found` and creates nothing. Before writing, the project loader checks the project with the new role in place of any file of that ID. The loader reads only `writer.yaml`, whose roster must name a route whose model is the `implementer` agent's model (see [Roles](config-reference.md#kxmrolesroleyaml-kxmrolev2)). If the project would not load, the command refuses with `role_invalid`, lists each issue and writes nothing, also under `--dry-run`, and `--overwrite` replaces a `writer.yaml` the loader refuses. Global scope is not checked, because no loader reads it.
- Refusals exit 2 and honor `--json`: `project_not_found` and `role_invalid` (with `issues`, each `{phase, code, file, message}`). A missing `--route` file, and an existing role without `--overwrite`, exit 1 with a plain stderr line, also under `--dry-run` (`kxm: route '<route-id>' is not a file under .kxm/models/`, or `role add failed: role_already_exists: ...`).
- JSON keys: `roleId`, `id`, `filePath`, `scope`.

```bash
kxm role add demo-role --description "Demo role" --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"role add","roleId":"demo-role","id":"demo-role","filePath":"/work/proj/.kxm/roles/demo-role.yaml","scope":"local","dryRun":true,"planned":[{"action":"write","target":"/work/proj/.kxm/roles/demo-role.yaml"}]}
```

Add a reviewer whose primary route is `fable-claude`, with `grok-native` second (Not run):

```bash
kxm role add reviewer --description "Independent reviewer" --route fable-claude --route grok-native --skills kxm
```

```bash
kxm role add --pick reviewer --scope local
```

### `kxm role remove`

```text
kxm role remove [roleId] [--scope global|local] [--pick [selection]]
```

Removes a role definition file.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--scope` | `<scope>` | `local` | Configuration scope: global or local (default: local) |
| `--pick` | `[selection]` | none | Pick a role to remove (index or id) |

- Deletes a file. `--dry-run` plans the deletion, deletes nothing, and reports `removed: false`.
- JSON keys: `roleId`, `id`, `removed`, `filePath`, `scope`.

```bash
kxm role remove demo-role --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"role remove","roleId":"demo-role","id":"demo-role","removed":false,"filePath":"/work/proj/.kxm/roles/demo-role.yaml","scope":"local","dryRun":true,"planned":[{"action":"delete","target":"/work/proj/.kxm/roles/demo-role.yaml"}]}
```

### `kxm role modify`

```text
kxm role modify [roleId] [--description <text>] [--add-skill <skill>] [--remove-skill <skill>] [--add-route <route-id>] [--remove-route <route-id>] [--scope global|local] [--pick [selection]]
```

Updates an existing role's description, skills, or route roster and rewrites its file.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--description` | `<text>` | unchanged | Updated description |
| `--add-skill` | `<skill>` | none | Skill to add |
| `--remove-skill` | `<skill>` | none | Skill to remove |
| `--add-route` | `<route-id>` | none | Route id to add. Must be `.kxm/models/<route-id>.yaml` |
| `--remove-route` | `<route-id>` | none | Route id to remove from the roster |
| `--scope` | `<scope>` | first match | Configuration scope: global or local |
| `--pick` | `[selection]` | none | Pick a role to modify (index or id) |

- `--add-route` checks that `.kxm/models/<route-id>.yaml` exists in the project. If it does not, the command exits 1 and writes `kxm: route '<route-id>' is not a file under .kxm/models/` to stderr. It does not write the role file. `--remove-route` drops a roster entry by id and does not require the model file. `--dry-run` returns the modified role and plans the write without making it, after the same existence check.
- JSON keys: `roleId`, `id`, `role`, `filePath`, `scope`.

```bash
kxm role get writer --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"role get","roleId":"writer","scope":"local","filePath":"/work/kxm/.kxm/roles/writer.yaml","role":{"schema":"kxm.role.v2","id":"writer","purpose":"writer","permission":"edit","description":"Primary implementation agent.","skills":[],"roster":[{"route":"grok-native","effort":"medium"},{"route":"qwen-openrouter-pi","effort":"medium"},{"route":"gemini-agy"}]}}
```

Captured from this checkout with `node scripts/kxm.mjs role get writer --json`. The path is shortened to `/work/kxm`.

```bash
kxm role modify writer --add-skill kxm --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"role modify","roleId":"writer","id":"writer","role":{"schema":"kxm.role.v2","id":"writer","purpose":"writer","permission":"edit","description":"Primary implementation agent.","skills":["kxm"],"roster":[{"route":"grok-native","effort":"medium"},{"route":"qwen-openrouter-pi","effort":"medium"},{"route":"gemini-agy"}]},"filePath":"/work/kxm/.kxm/roles/writer.yaml","scope":"local","dryRun":true,"planned":[{"action":"write","target":"/work/kxm/.kxm/roles/writer.yaml"}]}
```

Add an existing route to a role's roster (Not run):

```bash
kxm role modify reviewer --add-route fable-claude --add-skill kxm-peer
```

### `kxm role resume`

```text
kxm role resume <runId> [ruling]
```

Resumes an audit-escalated run with an operator directive. The default ruling is `operator_ruling: waived and resumed`.

- Arguments: `<runId>`; `[ruling]`, free text recorded with the decision.
- Inside a project, a run that this project's Runtime store holds gets an `audit_escalation` signal with action `unblock` in the Runtime, starting the supervisor if needed. Hub workflow runs share the `run_` + 32-hex shape, so the store, not the ID, decides. `--dry-run` plans the request without starting the supervisor. JSON keys: `runId`, `ruling`, `unblocked`.
- Any other run ID, including a hub workflow run of the same shape, updates the hub store at `.kxm/state/kxm.db` in the current directory directly (ignoring `--workspace` and `KXM_DATA_PATH`) and adds a `decision` journal entry. `--dry-run` reads the store read-only, reports the stage it would resume and the resulting `status`, and plans the write. JSON keys: `runId`, `stageId`, `ruling`, `status`.
- The hub-run path bypasses the hub even while one is running: it writes SQLite directly, without authentication, in two statements outside one transaction. A running hub keeps runs in memory, so it does not see the change until it restarts, and its next write to that run overwrites it; it also pushes no event and sends the coordinator no resume message. Stop the hub first, or resume a live hub's run with a signed `audit_escalation` signal (see [Waits, signals and escalation](workflow-definitions.md#waits-signals-and-escalation)).
- Errors: `resume_failed` (exit 1), or a plain `not found` line (exit 1).

A run the project's Runtime holds:

```bash
kxm role resume run_0123456789abcdef0123456789abcdef "waive the audit" --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"role resume","runId":"run_0123456789abcdef0123456789abcdef","ruling":"waive the audit","dryRun":true,"planned":[{"action":"request","target":"POST kxm-runtime /v1/runs/run_0123456789abcdef0123456789abcdef/signal (audit_escalation unblock)"}]}
```

A hub workflow run waiting on an audit escalation:

```bash
kxm role resume wf_dry_run "carry on" --dry-run
```

```text
dry run: resume workflow run wf_dry_run (stage: review)
  would write /work/proj/.kxm/state/kxm.db (workflow_runs wf_dry_run, one workflow_journal decision)
```

## `kxm lane`

One lane is one git worktree, one branch named the unit, and one recorded base sha. The record lives in the control checkout's state directory, `.kxm/state/lanes.json` (`kxm.lanes.v1`, mode 0600). The worktree path is `../<control-dir-basename>-<unit>`, next to the control checkout. Creating a lane resolves the base ref to a sha and does not fetch. There is no push, merge, pull request, or branch delete. Selecting a lane sets the discovery cwd to that lane's path and rebuilds workspace directories from it; `KXM_WORKDIR` still selects the workspace root when it is set, so the lane path is the workspace root only when `KXM_WORKDIR` is unset. A lane worktree of an already registered repository registers in the Runtime registry under that project: the same project id, its own control root and event store, and the same home runtime. A foreign clone with the same id is refused with `project_home_conflict`.

```text
kxm lane create <unit> [--base <ref>]
kxm lane list
kxm lane status <unit>
kxm lane drop <unit> [--force]
kxm lane run <unit> --brief <file> [--workflow <id>] [--base <ref>] [--wait] [--timeout-ms <n>]
```

```bash
kxm lane run omp-align-p1 --brief .kxm/briefs/omp-align-p1.md --wait
```

### `kxm lane create`

Resolves `<ref>` (default `origin/main`) with `git rev-parse --verify <ref>^{commit}` in the control checkout, then `git worktree add -b <unit> <path> <sha>`. The new worktree must contain `.kxm/project.yaml`. Writes the record and prints it.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--base` | `<ref>` | `origin/main` | Ref to resolve before adding the worktree |

Refusals (exit 1): `lane_unit_invalid`, `lane_exists` (record, path, or branch already present), `lane_base_unresolved` (the text names `git fetch origin`), `lane_not_project` (worktree removed again), `lane_git_failed`, `lanes_unreadable`.

### `kxm lane list`

Prints one line per lane: unit, branch, base sha, `dirty` (porcelain line count), `ahead` and `behind` against the recorded base sha, and `exists`. JSON key: `lanes`.

### `kxm lane status`

The list row for one unit, plus `status` of `lastRunId` when the Runtime supervisor is already running and answers. Otherwise `status=unknown`. The text ends with `root=<path>`, the lane root that status read. JSON includes the same path as `root`. `kxm lane status` never starts the Runtime supervisor.

Refusals (exit 1): `lane_missing`, `lane_unit_invalid`, `lanes_unreadable`.

### `kxm lane drop`

Removes the worktree and the record, and unregisters that lane root from the Runtime registry. When the supervisor is running, drop calls `POST /v1/projects/unregister`. A stopped supervisor is not an error: drop takes the registry write lock, deletes the row when that transaction still sees no live supervisor, and continues when the registry is absent. If the lock finds a live supervisor, drop uses the unregister route instead of editing the file. The route answers 409 `runtime_project_busy` when that root has an unsettled run, and 409 `runtime_project_has_lanes` when the root is the home row and other lanes are still registered, unless the body sets `force` to true. Refuses `lane_dirty` when porcelain is nonempty. Refuses `lane_run_open` when any run in the lane event store is not `completed`, `failed`, or `cancelled`. The text names each unsettled run id, and JSON includes `runIds`. That list is the same read as `kxm runs list` when the supervisor is running, and a direct read of the lane event store when the supervisor is stopped. A lane with no event store keeps the earlier check: `lane_run_open` when `lastRunId` is set and that run is not settled. `--force` overrides both refusals and sends `force: true` on the unregister request. `git worktree remove --force` is used only with `--force`. The branch is not deleted; the text says so (`branchDeleted: false`). Unless `--force` is set, the `lastRunId` check may start the Runtime supervisor. The event-store list only attaches to a supervisor that is already running. `--dry-run` only attaches and does not unregister. `kxm lane status` never starts the supervisor.

`lane_run_open` also uses the detail `lane <unit> runs could not be read: <detail>` when the lane's project or store could not be read, so the drop fails closed and does not remove the worktree. `<detail>` is the error message, cut to 200 characters, or `run list failed` when the thrown value is not an `Error`. The unsettled-run details stay `lane <unit> run <ids> is unsettled` (with `runIds`) and `lane <unit> run <lastRunId> is <status>`.

`lane_unregister_failed` uses the detail `lane <unit> could not be unregistered: <detail>`. `<detail>` is cut to 300 characters. It appears when a live supervisor refused the unregister or the request failed: the error message, `lane root could not be unregistered` when the failure is not an `Error`, or `runtime supervisor is live but could not be reached` when the registry lock finds a live supervisor that drop cannot attach to.

Refusals (exit 1): `lane_missing`, `lane_dirty`, `lane_run_open`, `lane_git_failed`, `lane_unregister_failed`.

### `kxm lane run`

Creates the lane when the record is absent (same rules as `create`), refuses `lane_run_open` when the last run is not settled, then runs the same path as `kxm run --lane <unit> --brief <file>` and `kxm runs drive <runId> --lane <unit>`. `--wait` and `--timeout-ms` are passed through. The run id is stored on the record. Prints the run envelope and the drive result. That open-run check may start the Runtime supervisor; `--dry-run` only attaches to a supervisor that is already running. `kxm lane status` never starts the supervisor.

`--brief` is required. `--workflow` defaults to the lane project's `defaultWorkflow`. `--base` applies only when the lane is created. A live agent step uses the step `timeoutMs` when it is set, otherwise the project `limits.agentStepTimeoutMs` (default 3,600,000). This repository's `implement-only`, `review-arch-only`, and `review-cli-only` workflows are the lane forms of the retired transport recipes.

Refusals (exit 1): `brief_unreadable`, `lane_unit_invalid`, `lane_exists`, `lane_base_unresolved`, `lane_run_open`, `lane_git_failed`, `lane_not_project`, `lanes_unreadable`.

## `kxm land`

Land the current branch. `npm run verify` is the first stage and is not replaced. The command spawns `scripts/pr-land.mjs` from the project root and streams one JSON line per stage. With no `--stage`, the stages run in order and stop at the first refusal. `--dry-run` prints each stage's plan and does not mutate. Squash is the only merge. A required review is reported and not bypassed.

```text
kxm land [--pr <n>] [--stage <name>] [--title <text>] [--body-file <path>]
```

```bash
kxm land --stage verify --dry-run
```

| Option | Argument | Default | Description |
|---|---|---|---|
| `--pr` | `<n>` | the open pull request for this branch | Pull request number to reuse |
| `--stage` | `<name>` | all stages | One of `verify`, `docs`, `push`, `pr`, `rebase`, `unblock`, `merge`, `release`, `milestone` |
| `--title` | `<text>` | subject of the first commit on the branch | Pull request title passed to `gh pr create`. Never the branch name |
| `--body-file` | `<path>` | none | Body file for `gh pr create`. Required when creating a pull request |

Outside a KXM project the command refuses `project_required` (exit 1). Unknown arguments and an unknown stage exit 2.

### Stages

| Stage | What it does |
|---|---|
| `verify` | Refuses `land_dirty_tree` unless `git status --porcelain` is empty. Skips when `.kxm/logs/land-verify-<tree>.json` for `HEAD^{tree}` is younger than 30 minutes. Otherwise runs `npm run verify` and writes that receipt. |
| `docs` | Runs `plans/kxm-roadmap/update-dashboard.mjs` when that file exists. Commits changes under `docs/roadmap/`, `plans/kxm-roadmap/`, or `docs/architecture/` as `docs(roadmap): regenerate after verify`. Any other path, including `state.json`, is `land_docs_failed`. When the generator is absent the stage passes with `docs: skipped (generator absent)`. |
| `push` | `git push -u origin <branch>`. After a rebase in this run, the push uses `--force-with-lease`. |
| `pr` | Reuses the branch's open pull request, or creates one with `gh pr create --body-file`. The title is `--title` when that option is set; otherwise it is the subject of the first commit (`git log --reverse --format=%s origin/main..HEAD`). `--dry-run` prints that title. |
| `rebase` | When `mergeStateStatus` is `BEHIND` or `DIRTY`: fetch, rebase onto `origin/main`, and resolve only three conflicts (take `plugins/kxm/dist` from main and rebuild; union CHANGELOG Unreleased bullets, ours first; union the tracker "Landed in this tree" list, newest first). Runs `docs` again when the tree changed, re-verifies unless `git merge-tree --write-tree origin/main HEAD` was clean, and pushes with the lease. Five rounds, then `land_conflict_manual`. |
| `unblock` | Reads `statusCheckRollup` and `reviewDecision`. Reruns one failed check with `gh run rerun --failed`. A second failure or `REVIEW_REQUIRED` is `land_blocked`. |
| `merge` | Enables auto-merge with `enablePullRequestAutoMerge` and `mergeMethod: SQUASH`. When the response contains "clean status", squash-merges with `PUT /repos/{owner}/{repo}/pulls/{n}/merge` and commit title `<title> (#n)`. Polls `gh pr view --json state` every 30 seconds for up to 20 minutes. |
| `release` | Records the newest `v*` tag before the merge, waits for the Auto-Release run whose title contains the pull request title, requires a newer tag from `git ls-remote --tags origin`, then waits for the first `release.yml` run whose `createdAt` is after that Auto-Release run, with no title filter. Both run ids are written to `.kxm/logs/land-release-context.json` and printed in the stage detail (`PUBLISHED <version> auto-release <id> release <id>`). Each wait prints one JSON line every 2 minutes (`waiting auto-release.yml 4m`). The npm poll is `npm view @kontextmind/kxm@<version> version` every 30 seconds for 10 minutes. |
| `milestone` | Compares `plans/kxm-roadmap/state.json` from before and after `docs`. When a phase goes from an open task to all tasks `done`, or the pull request body contains a `Milestone:` line, prints `deep_review_required: true` and exits 0. The review is the `/reanalyze-roadmap` skill, not this command. An absent state file passes with skipped. |

Refusals (exit 1): `project_required`, `land_dirty_tree`, `land_verify_failed`, `land_docs_failed`, `land_push_rejected`, `land_pr_body_missing`, `land_pr_title_missing`, `land_conflict_manual`, `land_blocked`, `land_merge_failed`, `land_release_failed`, `land_publish_timeout`, `land_milestone_failed`.

`land_pr_title_missing`: the `pr` stage was not given `--title`, and the first commit subject on `origin/main..HEAD` is empty.

## `kxm assign`

`kxm assign` is the entry to this repository's developer assignment runner. Each verb spawns `node scripts/assignment-run.mjs <verb> ...` from the project root with that argument list, `stdio: "inherit"`, and the process environment unchanged. The command returns the child's exit code. It does not load a `.env` file, resolve paths, or repeat any runner check. Every validation rule, refusal code, and file the runner writes stays in [`scripts/assignment-run.mjs`](../../scripts/assignment-run.mjs). The loop, the records, and those codes are documented in [Assignment runner](../contributing/assignment-runner.md).

The command does not start the hub or the Runtime supervisor. It writes nothing itself. `--dry-run` prints the argv that would run and exits 0 without spawning. `--json` formats this command's own refusals and that dry-run plan. The runner's usage text documents no `--json` flag, and `accept` already prints JSON, so `--json` is not forwarded.

Outside a KXM project the command exits 1 with `project_required`. A project that has no `scripts/assignment-run.mjs` exits 1 with `assign_runner_missing`. A missing required flag is a usage error and exits 2. If `node` cannot be started, the command exits 1 with `assign_spawn_failed`.

```text
kxm assign run --manifest <path>
kxm assign witness --record-dir <path>
kxm assign plan-current --task-dir <path> --plan <path> --sha256 <hex> --base-commit <sha> --expected-generation <n>
kxm assign attribute --task-dir <path> --record-dir <path> --class <class> --explanation-file <path>
kxm assign observe-cost --task-dir <path> --input <path>
kxm assign accept --task-dir <path> --commit <sha> --record-dir <path> --critic <path> --critic <path> [--observed-pr <id>] [--observed-ci <id>]
kxm assign change-report --task-dir <path>
```

```bash
kxm assign run --manifest /abs/tasks/fix-improve-sources/asg-writer-1.json
```

### `kxm assign run`

Dispatches one closed manifest. The runner validates the route, the base, and the plan pointer, then writes the assignment record.

| Option | Argument | Description |
|---|---|---|
| `--manifest` | `<path>` | Absolute path to the `kxm.assignment.v1` manifest. Passed through as given |

### `kxm assign witness`

Runs the fixed witness named in the manifest against the staged tree.

| Option | Argument | Description |
|---|---|---|
| `--record-dir` | `<path>` | Absolute path to the assignment record directory |

### `kxm assign plan-current`

Stamps or advances `plan-current.json` in the task directory.

| Option | Argument | Description |
|---|---|---|
| `--task-dir` | `<path>` | Absolute path to the task directory |
| `--plan` | `<path>` | Absolute path to the plan file |
| `--sha256` | `<hex>` | SHA-256 the runner expects for that file |
| `--base-commit` | `<sha>` | Commit the pointer records |
| `--expected-generation` | `<n>` | Generation the pointer must currently have |

### `kxm assign attribute`

Attaches one private note under the record's `attribution/` directory. The note is not proof.

| Option | Argument | Description |
|---|---|---|
| `--task-dir` | `<path>` | Absolute path to the task directory |
| `--record-dir` | `<path>` | Absolute path to the assignment record directory |
| `--class` | `<class>` | `orchestration`, `model`, `environment`, or `unclassified` |
| `--explanation-file` | `<path>` | Absolute path to the note file |

### `kxm assign observe-cost`

Imports one cost observation. The record is cost-only and cannot authorize acceptance.

| Option | Argument | Description |
|---|---|---|
| `--task-dir` | `<path>` | Absolute path to the task directory |
| `--input` | `<path>` | Absolute path to the observation file |

### `kxm assign accept`

Binds the witnessed commit and two critic records. Optional observation ids are forwarded when present. `accept` prints JSON and takes no `--json` flag.

| Option | Argument | Description |
|---|---|---|
| `--task-dir` | `<path>` | Absolute path to the task directory |
| `--commit` | `<sha>` | Commit whose tree must equal the witnessed tree |
| `--record-dir` | `<path>` | Absolute path to the writer record directory |
| `--critic` | `<path>` | Absolute path to a critic record directory. Pass it twice |
| `--observed-pr` | `<id>` | Observed pull request id. Omitted unless set |
| `--observed-ci` | `<id>` | Observed CI run id. Omitted unless set |

### `kxm assign change-report`

Prints the task's attempts, rework, and spend. The runner keeps provider-reported, list, unmetered, and unknown cost apart.

| Option | Argument | Description |
|---|---|---|
| `--task-dir` | `<path>` | Absolute path to the task directory |

## `kxm docs`

Build and serve the tailnet docs site from this checkout. Both subcommands need a KXM project: the Git root that contains `.kxm/project.yaml`. They run from that root. No hub and no Runtime supervisor.

```text
kxm docs build
kxm docs serve [--port <port>]
```

```bash
kxm docs build --dry-run
kxm docs serve --dry-run --port 8765
```

### `kxm docs build`

Runs `node plans/kxm-roadmap/update-dashboard.mjs` and returns that process's exit code. The generator refreshes the roadmap pages and the MkDocs inputs from `plans/kxm-roadmap/state.json`. `kxm docs build` validates the state file and refuses on schema failure.

The build needs either `mkdocs` on `PATH` or `uv`. The command that works on this machine is `uv tool run --from mkdocs-material mkdocs build`. `uv tool install mkdocs-material` does not, because the package exposes no executable. When neither executable exists, the generator refuses with that same pair of options.

- No command-specific options.
- Honors `--dry-run`: prints `node plans/kxm-roadmap/update-dashboard.mjs` and does not start the process. JSON key: `detail` (that command line), plus `dryRun: true`.
- Errors (exit 1): `project_required`, `docs_generator_missing` when `plans/kxm-roadmap/update-dashboard.mjs` is absent.

### `kxm docs serve`

Runs `python3 ops/docs-site/serve.py` with output streamed to the terminal, and returns that process's exit code. `--port` is appended as `--port <port>` when it is set. The server binds a tailnet address. With `--port`, it binds only that port and exits if the port is taken. Without `--port`, it tries 80 and then 8765 through 8780. See `ops/docs-site/serve.py`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--port` | `<port>` | the server's own port list | Port passed through to `serve.py` |

- Honors `--dry-run`: prints `python3 ops/docs-site/serve.py` (and `--port <port>` when given) and does not start the process. JSON key: `detail`.
- Errors (exit 1): `project_required`, `docs_server_missing` when `ops/docs-site/serve.py` is absent.

```bash
kxm docs build --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"docs build","dryRun":true,"detail":"node plans/kxm-roadmap/update-dashboard.mjs"}
```

```bash
kxm docs serve --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"docs serve","dryRun":true,"detail":"python3 ops/docs-site/serve.py"}
```

A live `kxm docs serve` runs until the server exits. Not run for this page.

## `kxm run`

```text
kxm run <workflow> [--brief <file>] [--lane <unit>] [prompt...]
```

Create a KXM run without executing steps. The run pins the project's `homeRuntimeId`, config revision, and executor and tool policy revisions. Events store the prompt's SHA-256; its full text is kept in a local mode-0600 sidecar, `run-events.db.run-prompts.json`, and dispatch refuses a hash mismatch (`run_prompt_mismatch`). The Runtime supervisor starts if needed. Output explicitly reports no execution, live prerequisites, and separate drive/status/receipt commands. Use `kxm runs drive <runId> --wait` for supported live one-shot calls; no hub or Pi worker is required. `--simulated` is a model-free experiment, not evidence that implementation ran. Local runs are inspected with `kxm runs`, not the webhook-only `kxm workflow get`.

- Arguments: `<workflow>`, Workflow id to run (a file under `.kxm/workflows/`); `[prompt...]`, Run prompt (events keep its hash; the full text is kept in a local 0600 sidecar file).
- `--brief <file>` reads that file from the invocation directory, trims it, and uses the text as the prompt. The JSON envelope includes `brief` set to the path as given. `--brief` together with a positional prompt is `brief_and_prompt`. A file that cannot be read is `brief_unreadable`.
- `--lane <unit>` selects the recorded worktree before project discovery. A missing lane is `lane_missing`. A last run that is not settled is `lane_run_open`.
- Refuses `--workspace` (exit 2, `workspace_option_unsupported`).
- Needs a KXM project. Starts and uses the Runtime; no hub needed. Honors `--dry-run`, which validates the project and prints the plan without starting the supervisor.
- JSON keys: `idempotent`, `run` (`runId`, `homeRuntimeId`, `status`, `configRevision`), `supervisor` (`runtimeId`, `port`, `started`), and `execution` (`status: not_started`, `mode: live`, `defaultHarness`, `authentication: not_checked`, `prerequisites`, `nextSteps`). Dry run: `projectRoot`, `workflowId`, `configRevision`, `defaultHarness`, `prerequisites`. The obsolete `phase: pre-3a` field is no longer returned.
- Errors: `workflow_required` (exit 2), `project_required`, `run_workflow_unknown`, `brief_and_prompt`, `brief_unreadable`, `lane_missing`, `lane_run_open`, `run_failed` with `issues` (any invalid file in the project fails the load, for example `gate_outcome_impossible`), `run_io_failed` (exit 1).
- The `default` workflow that `kxm init` writes does not set `limits.maxAgentTimeMs`, so it can be driven. A workflow that sets that limit is created, but `kxm runs drive` refuses it with `run_handoff_required` (`limit_unsupported`); projects from older `kxm init` templates carry it on `default`.

```bash
kxm run default "Fix the flaky login test" --dry-run
```

```text
run plan: workflow default at sha256:80457232cbfc… (no run created)
```

```bash
kxm run default "Fix the flaky login test" --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"run","dryRun":true,"projectRoot":"/work/proj","workflowId":"default","configRevision":"sha256:80457232cbfc0d1a88c53a2b693061083c83df6e95409e3ae7f75ccfc9f93cf4"}
```

Create a run (this starts the Runtime supervisor; stop it afterwards with `kxm runtime stop`):

```bash
kxm run default "Fix the flaky login test"
```

```text
run created: run_a80e84c98f514299b82f0157f4537ea3 (home rtm_1a42e069…, config sha256:b45f8f51a506…)
No steps executed. Project default harness: pi; per-agent harness settings take precedence.
Live prerequisite (...): ...
Live execution uses one-shot harness calls; no hub or Pi worker is required. Check installation/authentication with kxm harness list.
Resolve the prerequisites above, then execute: kxm runs drive run_a80e84c98f514299b82f0157f4537ea3 --wait
Inspect: kxm runs status run_a80e84c98f514299b82f0157f4537ea3 --json; receipt: kxm runs receipt run_a80e84c98f514299b82f0157f4537ea3 --json; cancel: kxm runs cancel run_a80e84c98f514299b82f0157f4537ea3
These are local Runtime runs, not webhook workflows; use kxm runs, not kxm workflow get.
```

## `kxm runs`

Reads and drives runs through the Runtime supervisor. Every subcommand needs a KXM project, and every subcommand except a dry run starts the supervisor if it is not running. Under `--dry-run`, `status`, `list`, and `receipt` read from a supervisor that is already running and otherwise exit 2 with `dry_run_unsupported`; `drive` and `cancel` print a plan without contacting it. The run ID is the `runId` printed by `kxm run`. Errors carry `issues` from the Runtime, for example `run_unknown`.

### `kxm runs status`

```text
kxm runs status <runId> [--lane <unit>]
```

Show the projected status of a run, including durable drive receipt state (open / receipt verified / unsettled / orphaned).

- Arguments: `<runId>`, Run id. `--lane <unit>` discovers the project from that lane's worktree (`lane_missing` when the record or path is absent, `lane_unit_invalid` when the unit is not a KXM identifier, `lanes_unreadable` when the record cannot be read). Reads run state, but starts the supervisor if needed (not under `--dry-run`).
- Text: `run <id>: <status> (workflow <id>, updated <time>)`, then `root <path>` (the checkout the status read, which is the lane worktree when `--lane` is set), plus a drive line such as `drive <id>: open`, `completed (receipt verified)`, `unsettled <reason>`, `handoff`, `cancelled (<reason>)`, or `no receipt (orphaned)`.
- JSON keys: `projectRoot` (that same checkout), `run` (`runId`, `status`, `workflowId`, `configRevision`, `updatedAt`, ...), `drive` (`driveId`, `mode`, `openedAt`, `receipt`, `verified`, `divergence`).
- Errors: `project_required`, `run_status_failed`, `run_status_io_failed` (exit 1).

```bash
kxm runs status run_a80e84c98f514299b82f0157f4537ea3
```

```text
run run_a80e84c98f514299b82f0157f4537ea3: preparing (workflow default, updated 2026-09-23T17:47:29.682Z)
root /work/proj
```

With no supervisor running:

```bash
kxm runs status run_0123456789abcdef0123456789abcdef --dry-run
```

```text
kxm runs status --dry-run refused: the Runtime supervisor is not running and --dry-run will not start it
```

### `kxm runs drive`

```text
kxm runs drive <runId> [--simulated] [--wait] [--timeout-ms <n>] [--lane <unit>]
```

Opens a drive of the run. With `--simulated`, a model-free producer reports every agent step as passed. Without `--simulated` the drive runs in live mode: each agent step invokes its harness through a one-shot producer, and the agent's model must be an admitted route (otherwise `producer_route_not_admitted`; there is no fallback model). A read-only step runs with the harness's read-only flags. A step with `write` access runs with an audited writer profile, which only `pi` and `grok` have; it must be a single assignment in a project whose `limits.maxConcurrentRuns` is 1, and its route must be on the writer roster in `.kxm/roles/writer.yaml`. Otherwise the drive hands the run off with `step_unsupported`. Around each live attempt the Runtime fingerprints the checkout with `git status` and `git diff`: a write step settles `passed` only when the checkout changed (routing metadata `authored: true`), and a read-only step that changed it settles `failed` (`authoringWitness: readonly_mutated`).

| Option | Argument | Default | Description |
|---|---|---|---|
| `--simulated` | none | off | Use the model-free simulation producer |
| `--wait` | none | off | Wait until a drive receipt is recorded; exits 0 only for a VERIFIED COMPLETED settlement |
| `--timeout-ms` | `<n>` | `60000` | Wait timeout in milliseconds (default 60000, max 600000) |
| `--lane` | `<unit>` | none | Discover the project from this lane's worktree |

- Arguments: `<runId>`, Run id. `--lane` refuses `lane_missing` when the record or path is absent, and also `lane_unit_invalid` and `lanes_unreadable`.
- `--timeout-ms` applies only with `--wait` and must be an integer from 1 to 600000 (`run_drive_timeout_invalid`, exit 1).
- Mutates run state. Honors `--dry-run`.
- JSON keys without `--wait`: `runId`, `driveId`, `poll`, `mode`, `status` (`accepted`). With `--wait`: `receipt`, `verified`; a timeout prints `error: "timeout"`.
- Exit 0 when accepted, or with `--wait` only for a verified completed settlement; otherwise 1. Runtime refusals include `run_handoff_required` and `run_busy`, printed as `run drive failed: <request path>: <code>: <message>` (JSON: `error: "run_drive_failed"` with the code in `issues`). A `run_handoff_required` message ends with `(handoff reason <reason>; field <field>; detail <detail>)`, each part capped at 200 characters, so the refusal names what to change.

```bash
kxm runs drive run_0123456789abcdef0123456789abcdef --simulated --dry-run
```

```text
drive plan: run run_0123456789abcdef0123456789abcdef in simulated mode (no events written)
```

A workflow that declares `limits.maxAgentTimeMs`, such as `default` in a project from an older `kxm init` template, is handed off (see [`kxm run`](#kxm-run)):

```bash
kxm runs drive run_a80e84c98f514299b82f0157f4537ea3 --simulated
```

```text
run drive failed: /v1/runs/run_a80e84c98f514299b82f0157f4537ea3/drive?projectRoot=%2Fwork%2Fproj: run_handoff_required: runtime request failed with HTTP 409 (handoff reason limit_unsupported; field limits.maxAgentTimeMs; detail agent-time budget enforcement is not available in this slice)
```

```bash
kxm runs drive run_0123456789abcdef0123456789abcdef --simulated --wait --timeout-ms 120000
```

Not run: starts the Runtime and writes run events.

### `kxm runs receipt`

```text
kxm runs receipt <runId> [--all] [--lane <unit>]
```

Print the newest drive receipt for a run.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--all` | none | off | Print the capped receipt list for the run |
| `--lane` | `<unit>` | none | Discover the project from this lane's worktree |

- Arguments: `<runId>`, Run id. Text mode prints the newest receipt's settlement as JSON; `--all` prints the list. Starts the supervisor if needed (not under `--dry-run`). `--lane` refuses `lane_missing` when the record or path is absent, and also `lane_unit_invalid` and `lanes_unreadable`.
- JSON keys: `receipt`, or `receipts` with `--all`. Exit 1 with `no_receipts` when the run was never driven.

```bash
kxm runs receipt run_0123456789abcdef0123456789abcdef --all --json
```

Not run: starts the Runtime supervisor.

### `kxm runs cancel`

```text
kxm runs cancel <runId> [--lane <unit>]
```

Durably request cancellation of a run: records `run.cancel_requested` then `run.status_changed`. Cancelling a terminal run is an idempotent no-op.

- Arguments: `<runId>`, Run id. `--lane <unit>` discovers the project from that lane's worktree (`lane_missing` when the record or path is absent, `lane_unit_invalid` when the unit is not a KXM identifier, `lanes_unreadable` when the record cannot be read).
- Mutates run state. Honors `--dry-run`.
- JSON keys: `idempotent`, `run` (`runId`, `status`).

```bash
kxm runs cancel run_0123456789abcdef0123456789abcdef --dry-run
```

```text
cancel plan: run run_0123456789abcdef0123456789abcdef (no events written)
```

### `kxm runs list`

```text
kxm runs list
```

List recent runs for the current project. A run whose event log could not be folded is marked `[state unverified: <reason>]`.

No command-specific options.

- JSON keys: `runs` (`runId`, `status`, `workflowId`, `createdAt`, `projectionError`). Text prints `no runs` when empty. Starts the supervisor if needed (not under `--dry-run`).

```bash
kxm runs list
```

Not run: starts the Runtime supervisor.

## `kxm runtime`

Manages the detached KXM Runtime supervisor: a token-authenticated API on a random `127.0.0.1` port with a stable logical runtime identity, state under `<state root>/runtime/`, and an outbox that syncs run state to the hub.

### `kxm runtime start`

```text
kxm runtime start
```

Start the Runtime supervisor if not running.

No command-specific options.

- Starts a detached process. Honors `--dry-run`.
- JSON keys: `runtimeId`, `port`, `started`.

```bash
kxm runtime start --dry-run
```

```text
runtime supervisor would auto-start
```

### `kxm runtime status`

```text
kxm runtime status
```

Show Runtime supervisor liveness, judged by its heartbeat as well as its PID. When it is running, also shows each project's outbox sync state (`pending`, `acked`, `refused` counts and the refusal codes).

No command-specific options.

- Reads only. Never starts the supervisor.
- JSON keys: `running`, `runtimeId`, `pid`, `port`, `state`, `heartbeatAt`, `startedAt`, `sync`.
- Exit 0 when running, 1 when not (the JSON still says `ok: true`).

```bash
kxm runtime status
```

```text
runtime supervisor is not running
```

```bash
kxm runtime status --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"runtime status","running":false}
```

### `kxm runtime sync-retry`

```text
kxm runtime sync-retry
```

Re-queue outbox rows the hub durably refused, after the hub-side state is corrected.

No command-specific options.

- Needs a running supervisor (it never starts one) and a KXM project. Honors `--dry-run`, but still checks the supervisor first.
- JSON keys: `retried`, `projectId`, and the Runtime's result fields.
- Errors: `runtime_not_running`, `project_required` (exit 1).

```bash
kxm runtime sync-retry --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"runtime sync-retry","error":"runtime_not_running"}
```

### `kxm runtime stop`

```text
kxm runtime stop
```

Gracefully stop the Runtime supervisor.

No command-specific options.

- Honors `--dry-run`. When nothing is running it prints `stopped: false` and exits 0.
- JSON keys: `stopped`.

With no supervisor running (the not-running check happens before the dry-run check):

```bash
kxm runtime stop --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"runtime stop","stopped":false}
```

## `kxm agent`

### `kxm agent worker`

```text
kxm agent worker --name <name> --project <project> [--model <id>] [--fallback-models <ids>] [--tools <names>] [--session-isolation workflow|off] [--no-continue] [--fresh-start]
```

Starts a long-lived, supervised Pi RPC worker in the foreground through `scripts/kxm-worker.mjs`. The worker does not read models, tools, roles, or ownership from any workspace file; pass them explicitly.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--name` | `<name>` | `KXM_AGENT_NAME` | Agent name |
| `--project` | `<project>` | `KXM_PROJECT` | Hub project |
| `--model` | `<id>` | `KXM_WORKER_MODEL`, else the Pi default | Primary model |
| `--fallback-models` | `<ids>` | `KXM_WORKER_FALLBACK_MODELS` | Comma-separated fallback models |
| `--tools` | `<names>` | `KXM_WORKER_TOOLS`, else Pi defaults | Comma-separated Pi tool allowlist |
| `--session-isolation` | `<mode>` | `off` | Pi session isolation: workflow or off (default: off for upgrade compatibility) |
| `--no-continue` | none | continue on | Disable every session resume |
| `--fresh-start` | none | off | Skip only the initial session resume |

- Needs Pi and a reachable hub. Runs until stopped (`kxm hub stop` stops managed workers too). The exit code is the worker's.
- A name and project are required (exit 2 otherwise); an invalid isolation mode exits 2.
- `--dry-run` prints a `kxm.worker-result.v1` envelope with `workspace`, `name`, `project`, `model`, `fallbackModels`, `tools`, `sessionIsolation`, `continue`, `freshStart`.
- Before Pi starts, the worker runs `--model` and every `--fallback-models` entry through the Pi native-vendor brake. A model whose vendor has its own harness (for example `xai/…`, `openai-codex/…`, `openrouter/x-ai/…` or `antigravity/claude-…`) exits 1 with `pi_native_impersonation_blocked: <message>` on stderr; use the native harness, or an admitted Pi route such as `openrouter/qwen/qwen3-coder-plus`. `--dry-run` does not run this check. See [Harness routing](harness-routing.md#what-the-brake-refuses).
- The remaining worker variables are described in [Long-lived worker settings](configuration.md#long-lived-worker-settings).

```bash
kxm agent worker --name reviewer --project demo --model openrouter/qwen/qwen3-coder-plus --tools read,grep,find,ls --session-isolation workflow --fresh-start --dry-run
```

```text
would start worker
```

```bash
kxm agent worker --name coordinator --project demo --model openrouter/qwen/qwen3-coder-plus --session-isolation workflow
```

Not run: starts a long-lived Pi worker.

## `kxm workflow`

Hub workflow runs (signed-webhook workflows with stages, evidence, waits, and a journal) and workflow definition files. `list`, `get`, and `export` read the local hub store, not a remote hub. `checkpoint`, `record`, and `wait` call the hub as an agent, like the [`peer`](#kxm-peer) commands, and share their policy checks and output shape. `definitions`, `add`, `remove`, and `modify` edit `kxm.workflow.v1` files in `.kxm/workflows/` (local) or `<KXM_USER_CONFIG_DIR>/workflows/` (global).

### `kxm workflow list`

```text
kxm workflow list
```

List local workflow runs: the newest 200 runs in `.kxm/state/kxm.db` (or `KXM_DATA_PATH`), opened read-only.

No command-specific options.

- JSON keys: `runs`. Exit 1 with `state_unavailable` when the store does not exist.

```bash
kxm workflow list --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"workflow list","runs":[]}
```

### `kxm workflow get`

```text
kxm workflow get <runId>
```

Show one local workflow run with its stages, evidence, waits, and journal.

- Arguments: `<runId>`, Workflow run ID. No command-specific options. Reads only.
- JSON keys: `run`, `journal`. Exit 1 with `workflow_not_found` or `state_unavailable`.

```bash
kxm workflow get wf_missing --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"workflow get","error":"workflow_not_found"}
```

### `kxm workflow checkpoint`

```text
kxm workflow checkpoint [runId] [stageId] [status] [summary] [--evidence <json>] [--evidence-refs <json>]
```

Record a workflow stage checkpoint with evidence. Warnings and failures require another attempt until the stage passes or its attempts are exhausted. Peer-reply requirements must cite durable message IDs through `--evidence-refs`; caller-written evidence strings cannot satisfy them.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--run-id` | `<id>` | none | Workflow run ID |
| `--stage-id` | `<id>` | none | Active stage ID |
| `--status` | `<status>` | none | passed, warning, or failed |
| `--summary` | `<text>` | none | Stage summary |
| `--evidence` | `<json>` | none | Key-value evidence JSON |
| `--evidence-refs` | `<json>` | none | Peer evidence references JSON |
| `--payload` | `<json>` | none | JSON payload |

- Positional arguments and options are interchangeable; `--payload` supplies any of the fields as one JSON object, and explicit flags override it. `--evidence` is an object of up to 64 string values; `--evidence-refs` maps each requirement to `{"messageIds":[...]}` (1 to 16 IDs).
- Needs a hub. Mutates the run. Honors `--dry-run` (prints the parsed `args`).
- Output is the hub's checkpoint result. Policy refusals: `tool_policy_denied`, `session_token_invalid`, `attempt_token_invalid`.

```bash
kxm workflow checkpoint wf_123 implement passed "Tests pass" --evidence '{"implementation-diff":"commit abc123"}' --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"workflow checkpoint","dryRun":true,"args":{"evidence":{"implementation-diff":"commit abc123"},"runId":"wf_123","stageId":"implement","status":"passed","summary":"Tests pass"}}
```

```bash
kxm workflow checkpoint --run-id wf_123 --stage-id review --status passed --summary "Two reviews agree" --evidence-refs '{"independent peer reviews":{"messageIds":["msg_a","msg_b"]}}'
```

Not run: writes to a hub workflow.

### `kxm workflow record`

```text
kxm workflow record [runId] [category] [area] [summary] [--stage-id <id>] [--severity <level>] [--details <text>] [--evidence <items...>] [--related-entry-ids <ids...>]
```

Record workflow journal knowledge in one of ten categories: plan, decision, contradiction, error, lesson, observation, hypothesis, experiment, state-change, or skill-candidate.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--run-id` | `<id>` | none | Workflow run ID |
| `--category` | `<category>` | none | plan, decision, contradiction, error, lesson, observation, hypothesis, experiment, state-change, skill-candidate |
| `--area` | `<area>` | the stage's area with `--stage-id` | harness, gates, implementation, workflow, documentation, security, other (defaults to the stage area with --stage-id) |
| `--stage-id` | `<id>` | none | Stage the entry is about; the hub derives attempt and default area |
| `--severity` | `<level>` | `info` | info, warning, error |
| `--summary` | `<text>` | none | Entry summary |
| `--details` | `<text>` | none | Detailed text |
| `--evidence` | `<items...>` | none | Evidence strings |
| `--related-entry-ids` | `<ids...>` | none | Related entry IDs |
| `--payload` | `<json>` | none | JSON payload |

- `--evidence` (up to 32) and `--related-entry-ids` (up to 16) take space-separated values. `lesson` and `skill-candidate` entries require evidence.
- Area is optional. With three positionals and no `--summary`, the third positional is the summary: `record <runId> <category> <summary>`. The four-positional form `record <runId> <category> <area> <summary>` still works.
- `--stage-id` binds the entry to that stage. The hub derives the attempt (the current attempt for an in-progress or waiting stage, the last attempt consumed for a finished stage); callers cannot set it. Without `--area`, the entry takes the stage's declared area. With neither an area nor a stage that declares one, the hub answers 400 `invalid_improvement_area`; a stage that is not part of the run answers `invalid_journal_relation`.
- The journal covers hub webhook runs only. A `kxm run` ID answers `workflow_not_found`.
- Needs a hub. Mutates the journal. Honors `--dry-run`.

```bash
kxm workflow record wf_123 lesson gates "Flaky test hid a race" --severity warning --evidence https://ci.example.com/run/42 --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"workflow record","dryRun":true,"args":{"severity":"warning","evidence":["https://ci.example.com/run/42"],"runId":"wf_123","category":"lesson","area":"gates","summary":"Flaky test hid a race"}}
```

Bound to a stage, with the area taken from the stage:

```bash
kxm workflow record wf_123 lesson "Flaky test hid a race" --stage-id verify --evidence https://ci.example.com/run/42 --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"workflow record","dryRun":true,"args":{"stageId":"verify","evidence":["https://ci.example.com/run/42"],"runId":"wf_123","category":"lesson","summary":"Flaky test hid a race"}}
```

### `kxm workflow wait`

```text
kxm workflow wait [runId] [stageId] [signalKey] [summary] [--evidence <json>] [--evidence-refs <json>] [--timeout-ms <ms>]
```

Wait for a workflow signal callback: pauses the active stage until a signed external callback checkpoints it. Inside a project, a run that this project's Runtime store holds goes to the Runtime instead of the hub (the supervisor starts if needed); any other run ID, including a hub workflow run of the same `run_` + 32-hex shape, goes to the hub. The Runtime has no wait state yet: it checks that the run exists, answers `waiting: true`, and records nothing, so the command prints `waiting for signal on KXM run <id>` although the run is unchanged.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--run-id` | `<id>` | none | Workflow run ID |
| `--stage-id` | `<id>` | none | Active stage ID |
| `--signal-key` | `<key>` | none | Wait signal key |
| `--summary` | `<text>` | none | Expected result summary |
| `--evidence` | `<json>` | none | Evidence JSON |
| `--evidence-refs` | `<json>` | none | Peer evidence refs JSON |
| `--timeout-ms` | `<ms>` | hub default (24 hours) | Wait timeout in milliseconds |
| `--payload` | `<json>` | none | JSON payload |

- `--timeout-ms` accepts 1000 through 2592000000 (30 days).
- Needs a hub (or the Runtime for KXM runs). Mutates a hub run; changes nothing for a Runtime run. Honors `--dry-run`.

```bash
kxm workflow wait wf_123 verify github-pr-42-checks "Waiting on CI" --timeout-ms 3600000 --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"workflow wait","dryRun":true,"args":{"timeoutMs":3600000,"runId":"wf_123","stageId":"verify","signalKey":"github-pr-42-checks","summary":"Waiting on CI"}}
```

### `kxm workflow signal`

```text
kxm workflow signal <runId> <signalKey> <status> <summary> [evidence...] [--delivery-id <id>]
```

Post a signed workflow callback or unblock a KXM run. It is [`kxm gate signal`](#kxm-gate-signal) without `--recovery-action`; see that section for credentials, output, and errors.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--delivery-id` | `<id>` | `cli-signal:<uuid>` | Stable callback delivery ID |

- Arguments: `<runId>` Workflow run ID; `<signalKey>` Wait signal key; `<status>` passed, warning, or failed; `<summary>` Callback summary; `[evidence...]` required-key=evidence pairs.

```bash
KXM_WORKFLOW_ID=provenance-review KXM_WORKFLOW_SIGNAL_SECRET="$SIGNAL_SECRET" kxm workflow signal wf_123 ci-checks passed "CI green" --dry-run --json
```

```text
{"schema":"kxm.worker-result.v1","ok":true,"command":"signal","runId":"wf_123","signalKey":"ci-checks","status":"passed","evidence":{},...,"outcome":"passed","summary":"would post signed signal"}
```

### `kxm workflow start`

```text
kxm workflow start [definitionId] [--payload <json|@file>] [--delivery-id <id>] [--event <name>]
```

POST a signed workflow-start webhook to `<hub>/v1/webhooks/<definitionId>` under the [KXM sender contract](../guides/webhook-workflows.md#kxm-sender-contract): `x-kxm-signature` is an HMAC-SHA256 over the timestamp (`x-kxm-timestamp`), the delivery ID (`x-kxm-delivery-id`), the definition ID and the body, so a captured request cannot start a second run under another delivery ID. Repeating a delivery ID with the same body returns the existing run ID as a duplicate; with a different body the hub answers 409 `webhook_delivery_conflict`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--payload` | `<json>` | `{}` | JSON object or @file |
| `--delivery-id` | `<id>` | `cli-<uuid>` | Stable provider delivery ID |
| `--event` | `<name>` | none | Optional provider event name |

- Arguments: `[definitionId]`, Workflow definition ID (default `KXM_WORKFLOW_ID`).
- The secret comes from the definition's `secretEnv` when `KXM_WEBHOOK_WORKFLOWS` or `KXM_WEBHOOK_WORKFLOWS_FILE` is configured (never both), otherwise from `KXM_WORKFLOW_SECRET`. `--event` is sent as `x-github-event` and added to the payload as `event` when the payload has none.
- Needs a hub. Creates a run. Honors `--dry-run`.
- JSON keys: `definitionId`, `deliveryId`, `status`, `runId`, `duplicate` (dry run: `definitionId`, `deliveryId`, `event`).
- Errors: missing definition ID or secret (plain text, exit 2), `invalid_payload` (exit 2, the payload must be a JSON object), `workflow_start_failed` (exit 1).

```bash
KXM_WORKFLOW_SECRET="$SECRET" kxm workflow start provenance-review --payload '{"task":{"id":"T-1","summary":"Review auth change"}}' --dry-run
```

```text
would POST a signed workflow webhook
```

```bash
KXM_WEBHOOK_WORKFLOWS_FILE=workflows.json kxm workflow start provenance-review --payload @payload.json --delivery-id jira-T-1 --event issue_updated
```

Not run: posts to a hub and starts a workflow.

### `kxm workflow export`

```text
kxm workflow export <runId> [--input <file>] [--out-dir <dir>]
```

Export a proposed retrospective: writes `<runId>.json` and `<runId>.md` built from the run and its journal. The source is the local hub store, or an offline snapshot (`{"run":...,"journal":[...]}`) with `--input`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--input` | `<file>` | local store | Offline snapshot JSON |
| `--out-dir` | `<dir>` | `.kxm/assets/retrospectives` | Directory under workspace assets |

- Arguments: `<runId>`, Workflow run ID.
- `--out-dir` must resolve inside the workspace assets directory (`output_outside_workspace_assets`, exit 2).
- Writes two files. Honors `--dry-run`.
- JSON keys: `jsonPath`, `mdPath`, `reviewDecision`. Errors (exit 1): `state_database_not_found`, `workflow_not_found`, `snapshot_missing`, `run_id_mismatch`.

```bash
kxm workflow export wf_missing --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"retrospective export","error":"workflow_not_found"}
```

### `kxm workflow definitions`

```text
kxm workflow definitions [--scope all|global|local]
```

List workflow definitions across scopes.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--scope` | `<scope>` | `all` | Filter by scope: all, global, or local |

- Reads only. JSON keys: `workflows` (`id`, `description`, `scope`, `filePath`, `stepCount`, `roles`).

```bash
kxm workflow definitions
```

```text
WORKFLOW DEFINITIONS:
  default                  [local]          3 steps (roles: coordinator, implementer) Plan, implement, and verify a local change.
```

### `kxm workflow add`

```text
kxm workflow add [workflowId] [--template <name> | --file <path> | --pick [selection]] [--description <text>] [--scope global|local] [--overwrite]
```

Add a workflow definition to global or local configuration. With `--template <name>`, the named built-in template is written under the workflow ID. Without a workflow ID, or with `--pick`, you choose from the built-in templates and, for local scope, existing global definitions; a global definition with a template's ID is not offered. The choice is written under its own ID with its content: the template, or a copy of the global definition's file, with `--description` replacing its description. With `--file`, the YAML file is copied as-is once it passes the local check below. Otherwise a one-step scaffold is written: one `implementer` agent step with write access to `control` that ends the run `completed` on `passed` and `failed` on `failed`.

IDs are flat, portable lowercase slugs, at most 64 characters: use `bug-fix`, not `software-engineering/bug-fix`. Paths, traversal, and reserved platform names fail before writing. Imported definitions must use `kxm.workflow.v1`, with `agent` rather than legacy `role` steps and no top-level `id`; installation validates the runner's restricted YAML, schema, and transitions before creating directories or replacing a file. `--pick` copies a selected global definition, honors `--description`, and preserves an explicit destination ID. A global definition is not silently replaced with a scaffold.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--file` | `<path>` | none | Path to YAML workflow definition file |
| `--description` | `<text>` | `Workflow <id>`, or the template's | Workflow description |
| `--scope` | `<scope>` | `local` | Configuration scope: global or local (default: local) |
| `--overwrite` | none | off | Overwrite existing workflow definition if present |
| `--pick` | `[selection]` | none | Pick from available workflow templates (index or id) |
| `--template` | `<name>` | none | Start from a built-in template: `implement-and-verify`, `dual-critic-review`, or `spec-and-plan` |

- Templates: `implement-and-verify` runs the `implementer` agent, then the project's `test` gate, and a failing gate (`implementation-failure`) sends the work back to `implement` at most twice. `dual-critic-review` adds two review steps between them, both run as the `coordinator` agent with read access; point `review-arch` and `review-cli` at your own agents for independent critics. `spec-and-plan` plans and then reviews the plan, both as `coordinator`, reading the repository only.
- The templates and the scaffold are valid `kxm.workflow.v1` definitions that use only what `kxm init` creates: the `coordinator` and `implementer` agents, the `control` repository, and the `test` gate. Each was checked with `kxm init --json` and `kxm run <id> --dry-run` for this page. A new file under `.kxm/workflows/` is a permission expansion that `kxm trust check` asks you to review before you commit it.
- Writes `<scope dir>/workflows/<id>.yaml`. `kxm run` loads only `.kxm/workflows/`, so a `--scope global` definition is not runnable until it is copied into a project. `--dry-run` plans the write and writes nothing.
- Local scope belongs to a KXM project: the file lands in the project root's `.kxm/workflows/` from any subdirectory, and outside a project the command refuses with `project_not_found` and creates nothing. Before writing, the project loader checks the project with the new document in place of any file of that ID, using the parser, schema and bundle rules `kxm run` uses. If the project would not load, the command refuses with `workflow_invalid`, lists each issue and writes nothing, also under `--dry-run`. So `--file` or a picked global definition with a top-level `id` or a `role:` step, the shape `workflow add` wrote through 0.7.92, is refused, and `--overwrite` replaces a file left in that shape. Global definitions receive ID, schema and transition checks, but have no project references to validate.
- Refusals exit 2 and honor `--json`: `workflow_template_unknown` (the text names the three templates), `workflow_id_required` (no workflow ID), `workflow_add_conflict` (`--template` combined with `--file` or `--pick`), `project_not_found`, and `workflow_invalid` (with `issues`, each `{phase, code, file, message}`). Other input, file and overwrite failures exit 1 with `workflow_add_failed` and `message`. No failure writes the destination, and dry runs do not create missing local, global, or runtime directories.
- JSON keys: `workflowId`, `id`, `filePath`, `scope`.

Start a first workflow from a template:

```bash
kxm workflow add implement --template implement-and-verify
```

```text
Added workflow 'implement' to local (/work/proj/.kxm/workflows/implement.yaml)
```

```bash
kxm workflow add demo-flow --description "Demo" --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"workflow add","workflowId":"demo-flow","id":"demo-flow","filePath":"/work/proj/.kxm/workflows/demo-flow.yaml","scope":"local","dryRun":true,"planned":[{"action":"write","target":"/work/proj/.kxm/workflows/demo-flow.yaml"}]}
```

```bash
kxm workflow add implement --template nope
```

```text
workflow add failed: unknown template nope; choose implement-and-verify, dual-critic-review, spec-and-plan
```

Add a definition you wrote yourself (Not run):

```bash
kxm workflow add release-check --file ./release-check.yaml
```

### `kxm workflow remove`

```text
kxm workflow remove [workflowId] [--scope global|local] [--pick [selection]]
```

Remove a workflow definition.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--scope` | `<scope>` | `local` | Configuration scope: global or local (default: local) |
| `--pick` | `[selection]` | none | Pick a workflow to remove (index or id) |

- Deletes a file. `--dry-run` plans the deletion, deletes nothing, and reports `removed: false`. JSON keys: `workflowId`, `id`, `removed`, `filePath`, `scope`.

```bash
kxm workflow remove release-check --dry-run
```

```text
dry run: remove workflow 'release-check' from local
  would delete /work/proj/.kxm/workflows/release-check.yaml
```

### `kxm workflow modify`

```text
kxm workflow modify [workflowId] [--description <text>] [--scope global|local] [--pick [selection]]
```

Modify a workflow definition's description and rewrite its file.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--description` | `<text>` | unchanged | Updated description |
| `--scope` | `<scope>` | first match | Configuration scope: global or local |
| `--pick` | `[selection]` | none | Pick a workflow to modify (index or id) |

- Rewrites the file (re-serialized YAML). `--dry-run` returns the modified definition and plans the write without making it. JSON keys: `workflowId`, `id`, `workflow`, `filePath`, `scope`.

```bash
kxm workflow modify default --description "Changed" --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"workflow modify","workflowId":"default","id":"default","workflow":{"schema":"kxm.workflow.v1","description":"Changed","coordinator":"coordinator",...},"filePath":"/work/proj/.kxm/workflows/default.yaml","scope":"local","dryRun":true,"planned":[{"action":"write","target":"/work/proj/.kxm/workflows/default.yaml"}]}
```

## `kxm gate`

Validates workflow definitions and operates evidence gates. The group has exactly five gates; names declared in a workspace `gates.json` that do not map to one of them have no runner, and there is no generic subcommand that runs a gate by name. Results use the `kxm.worker-result.v1` envelope and, outside `--dry-run`, are appended to `.kxm/logs/telemetry.jsonl`.

### `kxm gate validate`

```text
kxm gate validate [--file <path>]
```

Validate workflow definitions without printing secrets. An explicit `--file` accepts a local `kxm.workflow.v1` YAML/JSON mapping or a webhook JSON array. Local mappings use the runner's restricted YAML parser, schema, and transition compiler; use `kxm init --dry-run` to also validate project references. Without `--file`, `KXM_WEBHOOK_WORKFLOWS_FILE` or inline `KXM_WEBHOOK_WORKFLOWS` remain webhook-only JSON sources, exactly as the hub loads them.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--file` | `<path>` | configured source | Workflow definition file |

- For webhook definitions, each `secretEnv` must name a set variable holding at least 16 characters (likewise `signalSecretEnv` when declared); otherwise parsing fails.
- Reads definitions; appends telemetry. No hub needed.
- JSON keys: `source`, `file`, `workflows`, `warnings`; local entries contain `id` and `schema`, while webhook entries contain `id`, `secretConfigured`, and `signalSecretConfigured`. `outcome` is `warning` when warnings exist.
- Exit 2 for `workflow_source_required` or `ambiguous_workflow_source` (both variables set); exit 1 for `file_not_found` or a parse error.

Validate an installed local template:

```bash
kxm gate validate --file .kxm/workflows/bug-fix.yaml
```

```bash
KXM_WORKFLOW_SECRET="$SECRET" kxm gate validate --file workflows.json
```

```text
validated 1 workflow(s) from file with 1 warning(s)
```

```bash
KXM_WORKFLOW_SECRET="$SECRET" kxm gate validate --file workflows.json --json
```

```text
{"schema":"kxm.worker-result.v1","ok":true,"command":"validate","source":"file","file":"/work/proj/workflows.json","workflows":[{"id":"provenance-review","secretConfigured":true,"signalSecretConfigured":false}],"warnings":["workflow provenance-review stage review evidence policy independent peer reviews: degradation.minProducers is 1 (< 2); a single producer can satisfy the degraded peer-reply quorum"],...,"outcome":"warning",...}
```

### `kxm gate artifacts-exist`

```text
kxm gate artifacts-exist --path <file>
```

Verify a non-empty file under workspace assets. The path resolves against the current directory and must be a regular, non-empty file inside the workspace assets directory both lexically and after resolving links.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--path` | `<file>` | required | Artifact file under workspace assets |

- Reads the file; appends telemetry.
- JSON keys: `path`, `bytes`. Exit 1 with `artifact_missing`, `artifact_empty`, `artifact_not_file`, `artifact_unreadable`, or `artifact_outside_workspace_assets`; a missing `--path` exits 2.

```bash
kxm gate artifacts-exist --path .kxm/assets/reports/summary.md
```

```text
artifact exists and is non-empty under workspace assets
```

```bash
kxm gate artifacts-exist --path README.md --json
```

```text
{"schema":"kxm.worker-result.v1","ok":false,"command":"artifacts-exist","error":"artifact_outside_workspace_assets","path":"/work/proj/README.md",...,"outcome":"failed","summary":"artifact verification failed: artifact_outside_workspace_assets"}
```

### `kxm gate degrade`

```text
kxm gate degrade <runId> <stageId> --requirement <key> --reason <text>
```

Approve a configured lower peer quorum for the current attempt of a stage, as allowed by that requirement's evidence policy. Uses the administrative token in `KXM_AUTH_TOKEN`; do not put secrets in the reason.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--requirement` | `<key>` | none | Canonical requirement key |
| `--reason` | `<text>` | none | Non-secret operator reason |

- Arguments: `<runId>` Workflow run ID; `<stageId>` Active stage ID.
- Both options and `KXM_AUTH_TOKEN` are required (plain text, exit 2).
- Needs a hub. Mutates the run. Honors `--dry-run`.
- JSON keys: `runId`, `stageId`, `requirementKey`, `status`, `duplicate`, `approvalId`. Failure: `workflow_degradation_failed` (exit 1).

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm gate degrade wf_123 review --requirement "independent peer reviews" --reason "one reviewer offline" --dry-run
```

```text
would approve configured degraded quorum for wf_123/review/independent peer reviews
```

### `kxm gate signal`

```text
kxm gate signal <runId> <signalKey> <status> <summary> [evidence...] [--delivery-id <id>] [--recovery-action <action>]
```

Post a signed workflow callback that checkpoints a waiting stage.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--delivery-id` | `<id>` | `cli-signal:<uuid>` | Stable callback delivery ID |
| `--recovery-action` | `<action>` | none | KXM recovery action: retry, fail, cancel, unblock |

- Arguments: `<runId>` Workflow run ID; `<signalKey>` Wait signal key; `<status>` passed, warning, or failed; `<summary>` Callback summary; `[evidence...]` required-key=evidence pairs.
- Inside a project, a run that this project's Runtime store holds is signaled in the Runtime (the supervisor starts if needed) and `--recovery-action` is passed through. JSON keys: `runId`, `signalKey`, `status`, `unblocked`, `deliveryId`. Hub workflow runs share the `run_` + 32-hex shape, so the store, not the ID, decides.
- Otherwise it is a hub webhook callback: `KXM_WORKFLOW_ID` names the definition, and the secret is the definition's `signalSecretEnv` (falling back to `secretEnv`) when a definition source is configured, else `KXM_WORKFLOW_SIGNAL_SECRET`. The callback is signed under the [KXM sender contract](../guides/webhook-workflows.md#kxm-sender-contract), bound to its timestamp, delivery ID, definition, run and signal key. JSON keys: `duplicate`, `deliveryId`.
- Reuse `--delivery-id` to retry one unchanged callback without a duplicate; each send re-signs with a fresh timestamp.
- Honors `--dry-run`. Exit 2 for a missing argument, an invalid status, malformed or duplicate evidence keys, or missing `KXM_WORKFLOW_ID` or secret; exit 1 for `signal_failed`.

```bash
KXM_WORKFLOW_ID=provenance-review KXM_WORKFLOW_SIGNAL_SECRET="$SIGNAL_SECRET" kxm gate signal wf_123 ci-checks passed "CI green" "tests=https://ci.example.com/run/42" --dry-run --json
```

```text
{"schema":"kxm.worker-result.v1","ok":true,"command":"signal","runId":"wf_123","signalKey":"ci-checks","status":"passed","evidence":{"tests":"https://ci.example.com/run/42"},...,"outcome":"passed","summary":"would post signed signal"}
```

```bash
kxm gate signal run_0123456789abcdef0123456789abcdef verify passed "operator verified" --recovery-action unblock --dry-run
```

```text
would post signal to KXM run
```

### `kxm gate github`

GitHub adapters. The only adapter is `watch`.

### `kxm gate github watch`

```text
kxm gate github watch --run-id <id> --stage-id <id> --signal-key <key> --repo <owner/name> --pr <number> [--required <names>] [--timeout-ms <ms>] [--interval-ms <ms>] [--delivery-id <id>]
```

Poll required checks and post the signed signal. The adapter polls the pull request's head commit check runs on `api.github.com` until every required check concludes or the timeout expires, then posts a signed `passed`, `warning`, or `failed` callback. On timeout it posts `failed` with summary `github_watch_timeout` and exits 4.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--run-id` | `<id>` | required | Workflow run ID |
| `--stage-id` | `<id>` | required | Waiting stage ID |
| `--signal-key` | `<key>` | required | Wait signal key |
| `--repo` | `<owner/name>` | required | GitHub repository |
| `--pr` | `<number>` | required | Pull request number |
| `--required` | `<names>` | none | Comma-separated required check names |
| `--timeout-ms` | `<ms>` | `1800000` | Watch timeout |
| `--interval-ms` | `<ms>` | `15000` | Poll interval |
| `--delivery-id` | `<id>` | generated per wait | Stable callback delivery ID |

- Needs `KXM_WORKFLOW_ID`, a signal secret (as for `gate signal`), and `GITHUB_TOKEN` or `GH_TOKEN`. Without a GitHub token it exits 1 with summary `github_auth_unavailable` and `skipped: true`, without calling GitHub.
- Calls GitHub and the hub. `--dry-run` still polls GitHub but does not post.
- JSON keys: `posted`, `status`, `summary`, `evidence`, `deliveryId`, `skipped`. Failure summaries include `github_pr_unavailable`, `github_head_unavailable`, `github_checks_unavailable`, `workflow_not_waiting`, `signal_failed`. A payload that would contain a secret is refused with `redaction_failure`.

```bash
KXM_WORKFLOW_ID=provenance-review KXM_WORKFLOW_SIGNAL_SECRET="$SIGNAL_SECRET" kxm gate github watch --run-id wf_123 --stage-id review --signal-key github-pr-42-checks --repo acme/web --pr 42 --required build,test --dry-run --json
```

```text
{"schema":"kxm.worker-result.v1","ok":false,"command":"github watch","posted":false,"evidence":{},"skipped":true,...,"outcome":"failed","summary":"github_auth_unavailable"}
```

Captured without a GitHub token. With `GITHUB_TOKEN` set, the same command polls GitHub (Not run).

## `kxm peer`

Peer agent messaging through the hub. Each invocation connects to the hub as a short-lived agent named `KXM_AGENT_NAME` (default `cli-<pid>`) in project `KXM_PROJECT` (default: the `package.json` name, else the directory name), using `KXM_AUTH_TOKEN`, else this project's saved project token from `hub-env.json`. It never uses the persisted admin token: with neither, the command exits 2 with `project_token_missing` (`nextAction: "export_kxm_auth_token"`) before contacting the hub. The `kxm workflow` agent verbs (`checkpoint`, `record`, `wait`, `get`, `list`) connect the same way. That agent appears in `peer list` and the dashboard. Every subcommand accepts `--payload <json>` with the tool's fields as one object; explicit flags override it. Tool policy from `KXM_ATTEMPT_TOKEN`, `KXM_SESSION_TOKEN`, or the on-disk session token is enforced first (`tool_policy_denied`, `session_token_invalid`, `attempt_token_invalid`).

All subcommands need a hub, honor `--dry-run` (printing the parsed `args` without connecting), print the hub's result object on success, and print `{"ok":false,"error":"command_failed","detail":"..."}` with exit 1 on failure. Malformed `--payload` exits 2 with `invalid_payload`.

### `kxm peer list`

```text
kxm peer list [--include-offline]
```

List peer agents in this project's hub pool with host and presence.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--include-offline` | none | off | Also list registered peers whose hub lease has expired |
| `--payload` | `<json>` | none | JSON payload |

- Reads the roster (the call itself registers the CLI agent). Output keys: `agents` (`id`, `name`, `purpose`, `project`, `connectedAt`, `lastSeenAt`, `online`, `host`, `leaseExpiresAt`, `presence`).

```bash
kxm peer list --json
```

```text
{"schema":"kxm.cli-result.v1","agents":[{"id":"agt_0c91aef519734fc1bd36518d2fc1cf4e","name":"cli-85922","purpose":"CLI agent client","project":"proj","connectedAt":"2026-09-23T13:53:24.142Z","lastSeenAt":"2026-09-23T13:53:24.156Z","online":true,"host":"host.local","leaseExpiresAt":"2026-09-23T13:53:54.156Z","presence":"online"}]}
```

### `kxm peer send`

```text
kxm peer send [target] [content] [--delivery <mode>] [--correlation-id <id>] [--idempotency-key <key>] [--workflow-context <json>] [--ttl-ms <ms>] [--allow-offline]
```

Send a focused request to a peer agent. Returns a message ID for `peer get` and `peer await`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--target` | `<name>` | none | Peer name or agent ID |
| `--content` | `<text>` | none | Focused request content |
| `--delivery` | `<mode>` | `followUp` | steer, followUp, or nextTurn |
| `--correlation-id` | `<id>` | none | Task grouping ID |
| `--idempotency-key` | `<key>` | none | Deduplication key |
| `--workflow-context` | `<json>` | none | Workflow context JSON |
| `--ttl-ms` | `<ms>` | hub default (24 hours) | Message TTL in milliseconds |
| `--allow-offline` | none | off | Queue the request if the target is registered but offline |
| `--payload` | `<json>` | none | JSON payload |

- `--workflow-context` is `{"runId","stageId","requirementKey","attempt"}` and is the only way a reply can count as peer evidence. `--ttl-ms` accepts 1000 through 604800000.
- Mutates (queues a message). Output keys: `messageId`, `status`, `target`.

```bash
kxm peer send reviewer "Review the diff in PR 42 and list blocking issues" --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"peer send","dryRun":true,"args":{"target":"reviewer","content":"Review the diff in PR 42 and list blocking issues"}}
```

```bash
kxm peer send reviewer "Independent review of the auth change" --workflow-context '{"runId":"wf_123","stageId":"review","requirementKey":"independent peer reviews","attempt":1}' --idempotency-key wf_123:review:1
```

Not run: sends a message through a hub.

### `kxm peer get`

```text
kxm peer get [messageId]
```

Check a peer request status and reply.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--message-id` | `<id>` | none | Message ID |
| `--payload` | `<json>` | none | JSON payload |

- Reads only. Output is the stored message.

```bash
kxm peer get msg_missing --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"error":"command_failed","detail":"message not found"}
```

### `kxm peer await`

```text
kxm peer await [messageId] [--timeout-ms <ms>]
```

Wait for a peer request reply (capped at 60 seconds). Longer waits belong in a workflow wait step.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--message-id` | `<id>` | none | Message ID |
| `--timeout-ms` | `<ms>` | `60000` | Timeout in milliseconds (max 60000) |
| `--payload` | `<json>` | none | JSON payload |

- Reads only. Output is the reply or a terminal error.

```bash
kxm peer await msg_abc --timeout-ms 30000 --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"peer await","dryRun":true,"args":{"timeoutMs":30000,"messageId":"msg_abc"}}
```

### `kxm peer cancel`

```text
kxm peer cancel [messageId]
```

Cancel a sent peer request. Only the agent that sent the request can cancel it, so run with the sender's `KXM_AGENT_NAME`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--message-id` | `<id>` | none | Message ID |
| `--payload` | `<json>` | none | JSON payload |

- Mutates the message.

```bash
kxm peer cancel msg_abc --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"peer cancel","dryRun":true,"args":{"messageId":"msg_abc"}}
```

### `kxm peer fanout`

```text
kxm peer fanout --targets <name>... --content <text> [--correlation-id <id>] [--idempotency-key-prefix <prefix>] [--workflow-context <json>] [--ttl-ms <ms>] [--timeout-ms <ms>]
```

Send the same request to one through three peers and return their replies for comparison. A local timeout returns pending entries with durable message IDs; repeat the exact command (same correlation ID and prefix) to retry without duplicates.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--targets` | `<items...>` | none | Target peer names (1-3) |
| `--content` | `<text>` | none | Request content |
| `--correlation-id` | `<id>` | none | Task grouping ID |
| `--idempotency-key-prefix` | `<prefix>` | none | Idempotency prefix |
| `--workflow-context` | `<json>` | none | Workflow context JSON |
| `--ttl-ms` | `<ms>` | hub default (24 hours) | Message TTL in milliseconds |
| `--timeout-ms` | `<ms>` | `1800000` (30 minutes) | Timeout in milliseconds |
| `--payload` | `<json>` | none | JSON payload |

- `--targets` takes space-separated names (a comma-joined value is sent as one name). `--timeout-ms` accepts 100 through 1800000.
- Mutates (queues messages). Output keys: `responses`.

```bash
kxm peer fanout --targets reviewer critic --content "Independent review of PR 42" --correlation-id wf_123 --idempotency-key-prefix pr42 --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"peer fanout","dryRun":true,"args":{"targets":["reviewer","critic"],"content":"Independent review of PR 42","correlationId":"wf_123","idempotencyKeyPrefix":"pr42"}}
```

### `kxm peer inbox`

```text
kxm peer inbox
```

List the inbound peer requests addressed to this agent that still need a reply, oldest first, read from the hub (`GET /v1/agents/<agentId>/inbox`). Only a stable `KXM_AGENT_NAME` has an inbox: a registered name that is offline keeps its agent ID, so a later call as the same name lists what peers queued for it with `peer send --allow-offline`. The default `cli-<pid>` is a new agent on every call, and its list is always empty. Answer each request with `peer reply` under the same name.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--payload` | `<json>` | none | JSON payload |

- Reads only. Listing acknowledges nothing, so a request stays `queued` for push delivery. Output key: `messages`, each a full message record (`id`, `fromName`, `content`, `status` `queued` or `delivered`, `expiresAt`).
- The call registers the name while it runs, so it exits 1 (`command_failed`, `agent name already active in project`) when another session holds that name online.

```bash
KXM_AGENT_NAME=codex kxm peer inbox --json
```

```text
{"schema":"kxm.cli-result.v1","messages":[{"id":"msg_1f0c…","project":"kxm","from":"agt_9d2e…","fromName":"reviewer","to":"agt_4b7a…","toName":"codex","content":"Review the retry loop in src/sync.ts","delivery":"followUp","hops":0,"maxHops":5,"seq":1,"createdAt":"2026-09-23T21:40:00.000Z","expiresAt":"2026-09-24T21:40:00.000Z","status":"queued"}]}
```

### `kxm peer reply`

```text
kxm peer reply [messageId] [content]
```

Reply to an inbound request. Only the request's recipient may reply (`message_forbidden` otherwise), so run with the recipient's `KXM_AGENT_NAME`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--message-id` | `<id>` | none | Message ID |
| `--content` | `<text>` | none | Reply content |
| `--payload` | `<json>` | none | JSON payload |

- Mutates the message. Output keys: `messageId`, `status`, `recipient`.

```bash
kxm peer reply msg_abc "LGTM with one nit" --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"peer reply","dryRun":true,"args":{"messageId":"msg_abc","content":"LGTM with one nit"}}
```

## `kxm task`

Project tasks stored as `kxm.task.v1` YAML in `.kxm/tasks/` in the current directory. `kxm task` with no subcommand runs `task list`. None needs a hub. Errors are plain text on stderr, even with `--json`.

### `kxm task create`

```text
kxm task create <title> [--goal <goalId>] [--objective <text>] [--workflow <id>] [--tracker github|jira] [--issue <key>]
```

Create a task with status `todo`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--goal` | `<goalId>` | none | Parent goal ID |
| `--objective` | `<text>` | the title | Task objective |
| `--workflow` | `<id>` | none | Assigned workflow ID |
| `--tracker` | `<tracker>` | none | Issue tracker (github or jira) |
| `--issue` | `<key>` | none | Issue number or Jira key |

- A tracker link is recorded only when both `--tracker` and `--issue` are given.
- Writes `.kxm/tasks/<id>.yaml`. `--dry-run` shows the task it would create and plans the write; the ID is assigned when the task is created, so a dry run's ID is not the one a real run gets. JSON keys: `task`.

```bash
kxm task create "Fix flaky test" --objective "Stabilize CI" --workflow default --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"task create","task":{"schema":"kxm.task.v1","id":"task_0e77833bc462","title":"Fix flaky test","objective":"Stabilize CI","acceptanceCriteria":[],"status":"todo","assignedWorkflow":"default",...},"dryRun":true,"planned":[{"action":"write","target":"/work/proj/.kxm/tasks/task_0e77833bc462.yaml"}]}
```

### `kxm task list`

```text
kxm task list [--goal <goalId>] [--status <status>]
```

List project tasks.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--goal` | `<goalId>` | none | Filter by goal ID |
| `--status` | `<status>` | none | Filter by status: todo, in_progress, blocked, in_review, done |

- Reads only. JSON keys: `count`, `tasks`.

```bash
kxm task list
```

```text
[todo] task_4f79c0833e41: Fix flaky test -> default
```

### `kxm task get`

```text
kxm task get <taskId>
```

Get task details and linked workflow status.

- Reads only. JSON keys: `task`. A missing task prints `Task <id> not found` and exits 1.

```bash
kxm task get task_4f79c0833e41
```

```text
Task: task_4f79c0833e41
Title: Fix flaky test
Status: todo
Objective: Stabilize CI
Workflow: default
```

### `kxm task run`

```text
kxm task run <taskId>
```

Prepare a local run from a task's objective and assigned workflow, or the project's `defaultWorkflow` when none is assigned. Read-only live preflight reports unsupported steps, limits, gates, harnesses, or model routes before creating a run. Unsupported work exits 1 with `run_execution_unavailable`, `defaultHarness`, and `execution.prerequisites`; neither the task nor Runtime is mutated. In particular, Claude-only writer work receives the read-only harness limitation instead of a dead-end created run.

- On compatible configuration, output is that of [`kxm run`](#kxm-run): creation only, `execution.status: not_started`, and explicit live drive/status/receipt commands. Authentication is checked on dispatch, not certified by creation. Task status is not changed to `in_progress` merely because a run exists.
- `--dry-run` applies the same live preflight and plans only the run request, with no task write or process start. JSON includes `taskId`, the unchanged task `status`, `projectRoot`, `workflowId`, `configRevision`, `defaultHarness`, `prerequisites`, `execution`, `dryRun`, and `planned`.

For a task assigned a configured, supported read-only workflow, a dry-run excerpt is:

```bash
kxm task run task_4f79c0833e41 --dry-run
```

```text
dry run: create workflow architecture-spike for task task_4f79c0833e41; task status stays todo until work actually starts
  would request POST kxm-runtime /v1/runs (starts the Runtime supervisor if it is not running)
```

### `kxm task sync`

```text
kxm task sync <taskId>
```

Sync task status and evidence with its linked issue board. Today this is local only: it marks the task's tracker link `synced` and updates timestamps without contacting GitHub or Jira.

- Writes the task file. `--dry-run` returns the synced task and plans the write without making it. JSON keys: `task`.
- Exit 1 when the task does not exist or has no tracker link.

```bash
kxm task sync task_4f79c0833e41 --json
```

```text
task sync failed: Task task_4f79c0833e41 does not have an associated issue board tracker
```

## `kxm goal`

Project goals stored as `kxm.goal.v1` YAML in `.kxm/goals/` in the current directory. `kxm goal` with no subcommand runs `goal list`. No hub needed.

### `kxm goal create`

```text
kxm goal create <title> [--area <area>] [--metric <metric...>] [--target-date <date>]
```

Create a project goal with status `active`.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--area` | `<area>` | none | Workflow area (e.g. software-engineering, security-reliability) |
| `--metric` | `<metric...>` | none | Success metrics for this goal |
| `--target-date` | `<date>` | none | Target achievement date (ISO-8601 or YYYY-MM-DD) |

- Writes `.kxm/goals/<id>.yaml`. `--dry-run` shows the goal it would create and plans the write; the ID is assigned when the goal is created. JSON keys: `goal`.

```bash
kxm goal create "Ship v1" --area software-engineering --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"goal create","goal":{"schema":"kxm.goal.v1","id":"goal_47c05405528d","title":"Ship v1","area":"software-engineering","status":"active","successMetrics":[],"createdAt":"2026-09-23T17:51:23.667Z","updatedAt":"2026-09-23T17:51:23.667Z"},"dryRun":true,"planned":[{"action":"write","target":"/work/proj/.kxm/goals/goal_47c05405528d.yaml"}]}
```

With metrics and a target date (Not run):

```bash
kxm goal create "Ship v1" --area software-engineering --metric "p95 < 300ms" "zero sev1" --target-date 2026-12-01
```

### `kxm goal list`

```text
kxm goal list
```

List project goals.

No command-specific options.

- Reads only. JSON keys: `count`, `goals`.

```bash
kxm goal list
```

```text
[active] goal_cebbbf714ed4: Ship v1 (software-engineering)
```

## `kxm suggest`

```text
kxm suggest <prompt...>
```

Recommends a flat workflow ID backed by a shipped template, with category metadata and explicit execution prerequisites. The install command creates a definition only; it does not create or drive a run.

- Explicit `Claude only`, `Claude-only`, or `only Claude Code` constraints exclude other harnesses. A missing, unauthenticated, or unsupported required harness produces `harness_unavailable`; KXM never silently substitutes Grok or Codex.
- A write workflow requires an audited writer profile for the selected harness. Only Pi and Grok currently have one; Claude-only bug fixes produce `live_write_unsupported` with direct-Claude implementation guidance, never a Grok substitution. No misleading create/drive command is emitted for an unsupported profile.
- For supported work, every suggested agent binding uses the selected detected, authenticated, dispatch-ready harness. Configure its compatible admitted model, install the exact template, validate project configuration, then use the separate create/live-drive/status/receipt commands. Writers also require single-assignment/single-run admission, any configured developer policy writer approval, and the repository's actual verification gate. An already-present recommended workflow ID produces `workflow_already_exists`; KXM will not assume its agents or permissions match the template.
- Arguments: `<prompt...>`; no command-specific options. No hub needed. `--dry-run` skips native authentication probes to avoid their side effects and does not claim verified availability.
- JSON keys: `prompt`, `workflowId`, `template`, `area`, `confidence`, `reasons`, `suggestedSkills`, `roles` (an array of `{agent, harness, role}`), `suggestedCommand` (installation only), and `execution`. Supported execution includes `prerequisites`, `shell`, `createCommand`, `driveCommand`, `statusCommand`, and `receiptCommand`; refusal includes `error`, `reason`, and `nextSteps`, sets `ok: false`, and exits 1.

```bash
kxm suggest "Fix a bug in an isolated worktree using Claude only" --json
```

```text
{"ok":false,"workflowId":"bug-fix","template":"implement-and-verify","roles":[],"suggestedCommand":"kxm workflow add bug-fix --template implement-and-verify","error":"live_write_unsupported",...}
```

## `kxm explain`

```text
kxm explain [--mode <name>] [--domains <list>] [--model <id>]
```

Pre-flight context footprint and token cost inspection for workflow modes. The estimate uses a fixed base prompt size, the length of each configured context file (1500 characters when a file is missing), domain prompt snippets, and 650 characters per active tool, at about 3.8 characters per token. Modes come from `.kxm/modes.yaml` or the built-in defaults; costs come from the project price catalog and stay unknown when it is missing or unverified.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--mode` | `<name>` | `coder` | Major mode (coder, planner, auditor, browser) |
| `--domains` | `<list>` | none | Comma-separated domain modules (git, k8s, database, browser) |
| `--model` | `<id>` | mode default | Target model identifier (e.g. grok/grok-4.6, claude/fable) |

- Reads only. No hub needed.
- JSON keys: `majorMode`, `enabledDomains`, `model`, `breakdown` (`name`, `chars`, `estimatedTokens`), `totalChars`, `totalTokens`, `contextWindowRatio`, `projectedCost`, `catalogStatus`, `catalogReason`.

```bash
kxm explain
```

```text
════════════════════════════════════════════════════════════
KXM PRE-FLIGHT CONTEXT EXPLAIN
════════════════════════════════════════════════════════════
Major Mode:       coder
Enabled Domains:  (none)
Target Model:     grok/grok-4.6
Catalog status:   price catalog missing

CONTEXT BREAKDOWN:
  • Base System Prompt (coder)                   843 tokens
  • Context File: AGENTS.md                      395 tokens
  • Tool Schemas (4 active tools)                685 tokens
────────────────────────────────────────────────────────────
  TOTAL PROMPT FOOTPRINT:                    1,923 tokens (1% of 200k window)
...
```

```bash
kxm explain --mode planner --domains git,k8s --model grok/grok-4.6 --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"explain","majorMode":"planner","enabledDomains":["git","k8s"],"model":"grok/grok-4.6","breakdown":[...],"totalChars":10022,"totalTokens":2640,"contextWindowRatio":1.3,"projectedCost":{"inputCostUsd":null,"cacheReadCostUsd":null,"outputCostEstimateUsd":null},"catalogStatus":"missing","catalogReason":"price catalog missing"}
```

## `kxm context`

KXM context operating-system queries. Every subcommand POSTs to the hub's `/v1/context/*` API as the control plane, authenticating only with `KXM_AUTH_TOKEN` (the persisted `hub-env.json` credential is not used; without the variable a hub that has an admin token answers 401 `invalid_auth`, while a loopback hub with no admin token accepts the call). The first argument is the project scope. Results carry the hub's HTTP `status` and response fields. Exit 0 on a 2xx response, 1 otherwise. An unreachable hub crashes the command with a stack trace (exit 1, no JSON). Agents reach the same data through the `kxm_context`, `kxm_recall`, `kxm_state`, `kxm_episode`, and `kxm_promote` tools; there is no `kxm_explain` tool.

### `kxm context get`

```text
kxm context get <project> --role <role> --task <task> [--run <runId>] [--stage <stageId>] [--budget <tokens>] [--kinds <kinds>]
```

Assemble a role-aware context packet within a token budget.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--role` | `<role>` | required | Requesting role (repro, planner, critic, implementer, verifier, or custom) |
| `--task` | `<task>` | required | What the role is trying to do |
| `--run` | `<runId>` | none | Workflow run scope |
| `--stage` | `<stageId>` | none | Workflow stage scope |
| `--budget` | `<tokens>` | hub default | Token budget for the packet |
| `--kinds` | `<kinds>` | all | Comma-separated item kinds to include |

- `--budget` must be an integer from 512 to 200000 (exit 2).
- `--run` and `--stage` do not filter the packet: selection draws on the whole project either way. The hub only echoes them in `audit.request` and its log.
- Reads only. Output keys: `status`, `packet` (`workingState`, `currentState`, `knowledge`, `evidence`, `episodes`, `skills`, `contradictions`, `unresolvedGaps`, `provenanceSummary`, `estimatedTokens`), `audit`.
- Selection is deterministic. Eligible items are ordered by open contradiction, project before `_shared`, task-matched before unmatched, role kind priority, lexical BM25 relevance to `--task`, confidence, authority, recency (newest first), then id. The budget is filled first-fit: an item that does not fit is skipped and smaller ones still fill it.
- `audit.relevance` holds numbers only: `taskTokens` (distinct task words after stopword removal), `matchedCandidates` (eligible items sharing a task word) and `selected` (each selected item's rounded score, in `selectedIds` order).

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context get proj --role planner --task "Plan the auth refactor" --budget 4000 --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"context get","status":200,"packet":{"workingState":{},"currentState":[],"knowledge":[],"evidence":[],"episodes":[],"skills":[],"contradictions":[],"unresolvedGaps":["no context records exist for this project yet"],"provenanceSummary":{},"estimatedTokens":0},"audit":{"request":{"project":"proj","role":"planner","task":"Plan the auth refactor"},"selectedIds":[],"provenanceSummary":{},"estimatedTokens":0,"budgetTokens":4000,"candidateCount":0,"excludedSuperseded":0,"unresolvedGaps":["no context records exist for this project yet"],"relevance":{"taskTokens":3,"matchedCandidates":0,"selected":[]}}}
```

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context get proj --role planner --task "Plan the auth refactor"
```

```text
context get assembled
```

Without `KXM_AUTH_TOKEN`:

```bash
kxm context get proj --role planner --task "Plan the auth refactor" --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"context get","status":401,"error":"invalid administrative authentication token","code":"invalid_auth",...,"nextAction":"check_project_token"}
```

### `kxm context recall`

```text
kxm context recall <project> [--query <text>] [--kinds <kinds>] [--limit <n>]
```

Search durable context records (metadata only).

| Option | Argument | Default | Description |
|---|---|---|---|
| `--query` | `<text>` | none | Query against summaries and state keys |
| `--kinds` | `<kinds>` | all | Comma-separated item kinds to include |
| `--limit` | `<n>` | hub default | Maximum results (1-100) |

- Ranking: items whose summary or state key contains the whole query (ignoring case) come first, then items that share a word with it, by BM25 relevance, then id. Items with neither are left out; an empty query returns every item in id order.
- Reads only. Output keys: `status`, `items` (metadata plus a numeric `relevance`; never summaries), `unresolvedGaps`.

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context recall proj --query auth --limit 5 --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"context recall","status":200,"items":[],"unresolvedGaps":["no matching context records"]}
```

### `kxm context state`

```text
kxm context state <project> <key> [--as-of <iso>]
```

Current or historical value for one state key.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--as-of` | `<iso>` | now | Historical timestamp query |

- Reads only. Output keys: `status`, `state` (`null` when unset), `key`.

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context state proj release.freeze --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"context state","status":200,"state":null,"key":"release.freeze"}
```

### `kxm context episode`

```text
kxm context episode <project> [--run <runId>]
```

Episodic learning records from workflow journals.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--run` | `<runId>` | all runs | Limit to one workflow run |

- Reads only. Output keys: `status`, `episodes`.

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context episode proj --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"context episode","status":200,"episodes":[]}
```

### `kxm context promote`

```text
kxm context promote <project> <proposalId> --evidence <refs>
```

Promote an approved state proposal (control plane).

| Option | Argument | Default | Description |
|---|---|---|---|
| `--evidence` | `<refs>` | required | Comma-separated durable evidence references |

- `--evidence` must contain at least one reference (exit 2).
- Mutates hub state. `--dry-run` sends nothing and plans the request (`POST <hub>/v1/context/state/promote`).
- Errors from the hub include `state_proposal_not_found` (404).

```bash
kxm context promote proj prop_1 --evidence wf_1:journal:1 --dry-run
```

```text
dry run: promote proposal prop_1 in proj
  would request POST http://127.0.0.1:7331/v1/context/state/promote
```

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context promote proj prop_missing --evidence wf_1:journal:1 --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"context promote","status":404,"error":"state proposal prop_missing not found","code":"state_proposal_not_found",...}
```

### `kxm context explain`

```text
kxm context explain <project> <itemId>
```

Explain which evidence and lineage back a context item.

- Arguments: `<project>` Project scope; `<itemId>` Context item ID. No command-specific options. Reads only.
- Output keys: `status`, `found`, `lineage`, `evidenceRefs`, `sources`.

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context explain proj ctx_missing --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"context explain","status":200,"found":false,"lineage":[],"evidenceRefs":[],"sources":[]}
```

### `kxm context wiki-compile`

```text
kxm context wiki-compile <project> [--out <dir>]
```

Compile the Karpathy-style knowledge wiki for review. Without `--out` the pages are listed but not written.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--out` | `<dir>` | dry-run output only | Workspace root to write .kxm/knowledge/wiki into (default: dry-run output only) |

- With `--out`, writes the pages under `<dir>/.kxm/knowledge/wiki/`. With `--out` and `--dry-run`, the hub still compiles (a read) and the pages are listed as `planned` writes; nothing is written.
- Output keys: `project`, `pages`, `openContradictions`, and `written` and `outDir` or `dryRun: true` (plus `outDir` and `planned` for `--out --dry-run`).

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context wiki-compile proj --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"context wiki-compile","project":"proj","pages":[".kxm/knowledge/wiki/architecture/proj-state.md",".kxm/knowledge/wiki/contradictions/proj.md",".kxm/knowledge/wiki/index.md"],"openContradictions":0,"dryRun":true}
```

### `kxm context wiki-lint`

```text
kxm context wiki-lint <project>
```

Lint a compiled wiki for broken refs, orphans, and stale state. Compiles on the hub and reports the lint findings without writing files.

- Reads only. Output keys: `project`, `issues` (`severity`, `rule`, `path`, `message`), `audit`.
- Exit 1 when any issue has severity `error`.

```bash
KXM_AUTH_TOKEN="$ADMIN_TOKEN" kxm context wiki-lint proj
```

Captured as JSON:

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"context wiki-lint","project":"proj","issues":[],"audit":{"project":"proj","pages":[...],"stateItems":0,"contextItems":0,"contradictions":0,"compiledAt":"2026-09-23T13:53:26.436Z"}}
```

## `kxm memory`

Harness-agnostic Git memory. Active facts are Markdown files with `kxm.memory.v1` front matter in `.kxm/memory/`; candidates live in `.kxm/memory/candidates/` and become facts when a reviewed PR moves them. All paths are relative to the current directory. No hub needed.

### `kxm memory brief`

```text
kxm memory brief
```

Show active project memory facts for harness context.

No command-specific options.

- Reads only. JSON keys: `brief` (`schema`, `generatedAt`, `count`, `facts`).

```bash
kxm memory brief
```

```text
No active project memory facts.
```

```bash
kxm memory brief --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"memory brief","brief":{"schema":"kxm.memory-brief.v1","generatedAt":"2026-09-23T13:52:20.033Z","count":0,"facts":[]}}
```

### `kxm memory note`

```text
kxm memory note <fact> [--scope <scope>] [--kind <kind>] [--body <text>]
```

Record an evidence-based memory candidate (promoted via PR).

| Option | Argument | Default | Description |
|---|---|---|---|
| `--scope` | `<scope>` | `project` | Scope: agent, project, run, or operator (default: project) |
| `--kind` | `<kind>` | `learning` | Kind: decision, architecture, convention, policy, learning (default: learning) |
| `--body` | `<text>` | none | Detailed markdown context for the fact |

- Arguments: `<fact>`, Summary of the observed fact or learning.
- Writes `.kxm/memory/candidates/<id>.md`. `--dry-run` shows the candidate and plans the write; the ID is assigned when the candidate is recorded.
- JSON keys: `candidate`, `path`.

```bash
kxm memory note "Use pnpm, not npm" --kind convention --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"memory note","candidate":{"schema":"kxm.memory.v1","id":"cand_project_bf337cc76dda","scope":"project","kind":"convention","summary":"Use pnpm, not npm",...,"lifecycle":"active","evidenceRefs":[]},"path":".kxm/memory/candidates/cand_project_bf337cc76dda.md","dryRun":true,"planned":[{"action":"write","target":"/work/proj/.kxm/memory/candidates/cand_project_bf337cc76dda.md"}]}
```

### `kxm memory sync`

```text
kxm memory sync
```

Regenerate the memory block in whichever of `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` exist in the current directory; never creates them.

No command-specific options.

- Writes only the project's memory block, the active authored facts from `.kxm/memory/`, between `<!-- kxm:memory:start -->` and `<!-- kxm:memory:end -->`. A file without markers gets the block appended at its end. Nothing outside the markers changes, and KXM adds no instructions of its own.
- Updates only the files that already exist. When none of the three exists, it writes nothing and exits 1 with `memory sync failed: none of AGENTS.md, CLAUDE.md, GEMINI.md exists in <dir>; …`.
- Refuses malformed markers. Each file must hold exactly one start marker followed by one end marker, or neither. An orphan marker, an end before its start, or a second block exits 1 with `memory sync failed: <file> has <problem>; wrote no file. …`, and no file is written. Keep one pair, or delete both so sync appends a fresh block.
- `--dry-run` runs the same checks, lists the files it would change, and writes nothing.
- Refusals are plain text on stderr, also under `--json`. JSON keys: `updated`, `unchanged`, `missing` (files that do not exist and were not created).

In a project that has only `AGENTS.md`, with no memory block yet:

```bash
kxm memory sync --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"memory sync","updated":["AGENTS.md"],"unchanged":[],"missing":["CLAUDE.md","GEMINI.md"],"dryRun":true,"planned":[{"action":"write","target":"/work/proj/AGENTS.md"}]}
```

With a stray start marker in `CLAUDE.md`:

```bash
kxm memory sync
```

```text
memory sync failed: CLAUDE.md has <!-- kxm:memory:start --> with no <!-- kxm:memory:end -->; wrote no file. Keep exactly one <!-- kxm:memory:start --> followed by one <!-- kxm:memory:end --> in each file, or delete both so sync appends a fresh block
```

## `kxm skills`

Governed skill candidate lifecycle under `.kxm/skills/` in `KXM_WORKDIR` or the current directory: `candidates/`, `promoted/`, `quarantineds/`, `rejected/`, `history/<id>.jsonl`, and `patches/<id>.patch`. No hub needed. Errors are plain text on stderr.

### `kxm skills create`

```text
kxm skills create --file <path> --name <name> --created-by <id> --harness <name> --models <models> [--description <text>] [--run <ids>] [--journal <ids>] [--receipt <refs>] [--supersedes <id>]
```

Submit a skill candidate from verified episodes.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--file` | `<path>` | required | SKILL.md content file |
| `--name` | `<name>` | required | Skill name |
| `--description` | `<text>` | empty | Short description |
| `--created-by` | `<id>` | required | Author identity |
| `--run` | `<ids>` | none | Comma-separated source run IDs |
| `--journal` | `<ids>` | none | Comma-separated source journal entry IDs |
| `--receipt` | `<refs>` | none | Comma-separated evidence receipts |
| `--harness` | `<name>` | required | Harness compatibility (pi, claude-code, ...) |
| `--models` | `<models>` | required | Comma-separated compatible models |
| `--supersedes` | `<id>` | none | Prior skill this candidate supersedes |

- Writes a candidate. Honors `--dry-run`. JSON keys: `metadata` (or `name` for a dry run).

```bash
kxm skills create --file SKILL.md --name retry-backoff --created-by alice --harness pi --models openrouter/qwen/qwen3-coder-plus --run wf_123 --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"skills create","dryRun":true,"name":"retry-backoff"}
```

### `kxm skills evaluate`

```text
kxm skills evaluate <skillId> --kind <kind> --evaluator <version> [--fail] [--score <n>] [--details <text>]
```

Record a protected evaluation for a candidate. A failed evaluation can quarantine the candidate.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--kind` | `<kind>` | required | static-review, sandbox, functional, safety, or optimization |
| `--evaluator` | `<version>` | required | Evaluator version |
| `--fail` | none | off | Record a failed evaluation |
| `--score` | `<n>` | none | Numeric score |
| `--details` | `<text>` | none | Bounded evaluation details |

- Arguments: `<skillId>`, Skill candidate ID. Mutates. `--dry-run` returns the evaluation and whether it would quarantine the candidate, and plans the history write (and the move to `quarantineds/`) without making them.
- JSON keys: `skillId`, `quarantined`, `evaluation`.

```bash
kxm skills evaluate skill_x --kind static-review --evaluator v1 --json
```

```text
skills evaluate failed: skill skill_x not found in candidate
```

### `kxm skills promote`

```text
kxm skills promote <skillId> --decided-by <id> --evidence <refs> [--reason <text>]
```

Promote a candidate that passed all protected evaluations (`static-review`, `sandbox`, `functional`, `safety`). The promoter must differ from the author. Writes the promoted skill and a patch that adds `.kxm/skills/promoted/<id>/SKILL.md` for review.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--decided-by` | `<id>` | required | Promoter identity (must differ from the author) |
| `--evidence` | `<refs>` | required | Comma-separated durable evidence references |
| `--reason` | `<text>` | `passed protected evaluation` | Decision reason |

- Mutates. `--dry-run` checks the evaluations and the promoter as a real promotion does, returns the metadata with the patch it would write, and plans the promoted files, the patch, and the history entry without writing them. JSON keys: `skillId`, `metadata`, `patchPath`.

```bash
kxm skills promote seed-skill.af5155e66be7 --decided-by promoter --evidence receipt:seed --dry-run
```

```text
dry run: promote skill seed-skill.af5155e66be7
  would write /work/proj/.kxm/skills/promoted/seed-skill.af5155e66be7/SKILL.md
  would write /work/proj/.kxm/skills/promoted/seed-skill.af5155e66be7/metadata.json
  would write /work/proj/.kxm/skills/patches/seed-skill.af5155e66be7.patch
  would write /work/proj/.kxm/skills/history/seed-skill.af5155e66be7.jsonl
```

```bash
kxm skills promote skill_x --decided-by bob --evidence wf_123:journal:4
```

Not run: needs a candidate that passed every required evaluation.

### `kxm skills reject`

```text
kxm skills reject <skillId> --decided-by <id> [--reason <text>]
```

Reject a candidate; history is retained for learning.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--decided-by` | `<id>` | required | Decider identity |
| `--reason` | `<text>` | `rejected` | Decision reason |

- Mutates. `--dry-run` plans the move to `rejected/` and the history entry without making them. JSON keys: `skillId`, `metadata`.

```bash
kxm skills reject skill_x --decided-by bob --reason "duplicates an existing skill"
```

Not run: needs an existing candidate.

### `kxm skills list`

```text
kxm skills list [--state <state>]
```

List skills by state.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--state` | `<state>` | `promoted` | candidate, promoted, quarantined, or rejected |

- Reads only. JSON keys: `state`, `skills` (`id`, `name`, `version`, `createdBy`, `createdAt`, `models`). An invalid state exits 1.

```bash
kxm skills list --state candidate
```

```text
0 candidate skill(s)
```

### `kxm skills verify`

```text
kxm skills verify <skillId> [--state <state>]
```

Verify a stored skill against its pinned content hash.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--state` | `<state>` | `promoted` | candidate, promoted, quarantined, or rejected |

- Reads only. JSON keys: `skillId`, `state`, `contentSha256`. A missing skill or a hash mismatch exits 1.

```bash
kxm skills verify skill_x --json
```

```text
skills verify failed: skill skill_x not found in promoted
```

## `kxm improve`

Proposes coded-repeat candidates from this project's Runtime routing records and telemetry. `kxm improve` with no subcommand runs `improve report`.

### `kxm improve report`

```text
kxm improve report [--file <path>] [--out-dir <path>]
```

Generate the improvement report and candidates from routing records. Inside a KXM project (the current directory's Git root holds `.kxm/project.yaml`) it reads the project's Runtime event store, then `telemetry.jsonl` in the workspace logs directory; `--file` reads only the named file. Routing records (`kxm.routing-record.v1` and `v2`, bare or nested under `routing`, `envelope.routing`, or a `routing.attempt.recorded` event) are grouped by workflow, step, agent role, and ask. Groups that qualify become proposed candidates, each written as a `.diff` and a `.json` file. Nothing is applied.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--file` | `<path>` | the Runtime store, then `.kxm/logs/telemetry.jsonl` | Read only this routing-record JSONL instead of the project's Runtime store and telemetry |
| `--out-dir` | `<path>` | `<project>/.kxm/candidates` | Directory for candidates (default .kxm/candidates) |

- The Runtime store is `<state root>/runtime/projects/<key>/run-events.db`, with the key derived from the checkout's real path, so each checkout and worktree reads only its own. It is opened read-only for one query over its events table and is never created, written, or migrated. Outside a KXM project only telemetry is read, and the text output says `Runtime store not read`.
- A telemetry record whose `attemptId` the store already supplied is dropped (`duplicatesDropped`). Attempts from simulated drives are excluded (`excludedSimulated`). Each Runtime attempt's outcome is resolved from the event log and never written back: `accepted` when the run completed and the step was not re-entered, `reworked` when the step was entered again, `failed` when the run failed, undecided (`undecided`) when the run was cancelled or is still running.
- A group becomes a candidate only when the same objective was decided in at least 2 runs, at least 0.75 of its decided records were accepted, and its step writes no repository. A group that passes but misses shows `no (writes-repository)` or `no (ask-not-repeated)`. `Weighted` is the recency-weighted record count (`improvement.telemetryHalfLifeDays`); it orders rows and never decides candidacy.
- Reads `improvement.*` from the project and user configuration (see [`kxm.config.v1`](config-reference.md#personalization-settings-kxmconfigv1)) and reports each candidate's promotion readiness under `improvement.promotionPolicy`. Readiness never authorizes anything. Under `critic_quorum` every candidate reports not ready, because this command cites no critic receipts. A configuration that cannot be loaded exits 1 with `config_invalid`.
- A Runtime store that exists but cannot be read exits 1 with `improve_source_unreadable`; `detail` names the path.
- Writes candidate files under `--out-dir` (relative to the current directory) and the report at `.kxm/assets/improvements/<timestamp>.json`. Honors `--dry-run` (writes neither). No hub needed.
- JSON keys: `path`, `events`, `recordsCount`, `groupsCount`, `candidatesCount`, `candidates`, `report` (`schema`, `createdAt`, `reviewDecision`, `recordsCount`, `groups`, `candidates`, `promotionPolicy`, `promotion`), `sources`, `projectRoot` (`null` outside a project).
- Each `sources` entry has `kind` (`engine`, `telemetry`, or `file`), `path`, `exists`, `records`, and `duplicatesDropped`; the `engine` entry also has `skippedInvalid`, `excludedSimulated`, and `undecided`.
- Each `report.groups` row has `workflowHash`, `workflowId` (Runtime records), `stepId`, `agentRole`, `promptHash`, `recurrence`, `distinctRuns`, `askRecurrence`, `undecidedRecords`, `meanCost`, `meanLatency`, `verifyPassRate` (accepted share of decided records), `rework`, `weightedRecurrence`, `undatedRecords`, `costSamples`, `writesRepository`, `evidenceRefs`, `isCandidate`, and, when they apply, `excludedReason`, `candidateKind`, and `candidateId`.
- Each `report.promotion` entry has `candidateId`, `policy`, `readyForReview`, and `reason`.

With no routing records yet, from the project root:

```bash
kxm improve --dry-run
```

```text
Sources:
  engine    /home/me/.local/state/kxm/runtime/projects/605a33e70739a298f89939ca/run-events.db (exists=false, records=0, skippedInvalid=0, excludedSimulated=0, undecided=0, duplicatesDropped=0)
  telemetry /work/proj/.kxm/logs/telemetry.jsonl (exists=false, records=0, duplicatesDropped=0)
Project root: /work/proj

Improvement Report (0 record(s), 0 group(s), 0 candidate(s); promotion policy manual_pr)

Workflow       Step         Role         Prompt       Records  Runs  Asks  Weighted  Cost ($)  Latency (ms)  Accepted  Rework  Candidate
------------------------------------------------------------------------------------------------------------------------------------------
```

```bash
kxm improve report --dry-run --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"improve","dryRun":true,"path":"/work/proj/.kxm/assets/improvements/2026-09-23T16-42-18-170Z.json","events":0,"recordsCount":0,"groupsCount":0,"candidatesCount":0,"candidates":[],"report":{"schema":"kxm.improvement-report.v2","createdAt":"2026-09-23T16:42:18.170Z","reviewDecision":"proposed","recordsCount":0,"groups":[],"candidates":[],"promotionPolicy":"manual_pr","promotion":[]},"sources":[{"kind":"engine","path":"/home/me/.local/state/kxm/runtime/projects/605a33e70739a298f89939ca/run-events.db","exists":false,"records":0,"skippedInvalid":0,"excludedSimulated":0,"undecided":0,"duplicatesDropped":0},{"kind":"telemetry","path":"/work/proj/.kxm/logs/telemetry.jsonl","exists":false,"records":0,"duplicatesDropped":0}],"projectRoot":"/work/proj"}
```

When the Runtime store exists but is not a readable database:

```bash
kxm improve report --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"improve","error":"improve_source_unreadable","detail":"/home/me/.local/state/kxm/runtime/projects/605a33e70739a298f89939ca/run-events.db: file is not a database"}
```

## `kxm routing`

Model and harness routing telemetry. No hub needed.

### `kxm routing report`

```text
kxm routing report [-f <path>] [-l] [--prices <path>]
```

Compare verified completion, cost, and rework per behavioral configuration. The table ranks routes quality-first with columns Harness, Model, Effort, Role, Att, Pass%, Rwk%, p50(ms), p95(ms), CtxTok, Metered($), $/Acc, Unm, Unk, Quota, and optionally ListEquiv($).

Without `--file` it reads the same sources as [`kxm improve report`](#kxm-improve-report): the current project's Runtime event store (read-only), then the workspace `telemetry.jsonl`, dropping a telemetry copy of an attempt the store already supplied and excluding simulated drives. A Runtime attempt counts toward Pass% only when the event log shows its run completed without the step being re-entered.

| Option | Argument | Default | Description |
|---|---|---|---|
| `-f`, `--file` | `<path>` | the Runtime store, then workspace telemetry | Read only this telemetry or event log JSONL file (default: this project's Runtime event store plus workspace telemetry) |
| `-l`, `--equivalent-list-cost` | none | off | Include equivalent list price column using price catalog |
| `--list-prices` | none | off | Alias for --equivalent-list-cost |
| `--prices` | `<path>` | `.kxm/prices.yaml` | Path to price catalog (default: .kxm/prices.yaml) |

- Reads only. A price catalog that cannot be loaded is skipped silently.
- `--equivalent-list-cost` loads the catalog without the freshness check the producers apply, so it prices with a catalog of any date, including one the producers treat as stale. Check the catalog `date` before you rely on `ListEquiv($)`.
- A Runtime store that exists but cannot be read exits 1 with `improve_source_unreadable`.
- Ranking: quality first (Pass%, then Rwk%), then cost per accepted attempt. Among routes of equal quality, any route with an unknown-cost attempt ranks after every route without one. Such a route's cost is unknown, not a partial sum: `$/Acc` prints `-` (JSON `costPerAcceptedUsd: null`) and the `*` in `Unk` marks it.
- The `Quota` column counts attempts whose metadata looks quota-exhausted (a quota failure class, a `quota` flag, or text such as `rate limit` or `HTTP 429`). It is a count only: nothing fails over to another route.
- The text output does not list the sources, and prints `no routing records in telemetry` when no source holds a record. The Rwk% column counts records with `transitions` greater than 0, which Runtime records never set.
- JSON keys: `file` (the telemetry path, also when the Runtime store was read), `sources` (without `--file`; the same shape as in `kxm improve`), `configurations` (per behavioral hash for v1 records; `totalCostUsd` is `null` when any record lacks a cost, and `missingCostRuns` counts those records), `report` (`schema`, `generatedAt`, `totalAttempts`, `rows`).

With no routing records yet:

```bash
kxm routing report
```

```text
no routing records in telemetry
```

```bash
kxm routing report --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"command":"routing report","file":"/work/proj/.kxm/logs/telemetry.jsonl","sources":[{"kind":"engine","path":"/home/me/.local/state/kxm/runtime/projects/605a33e70739a298f89939ca/run-events.db","exists":false,"records":0,"skippedInvalid":0,"excludedSimulated":0,"undecided":0,"duplicatesDropped":0},{"kind":"telemetry","path":"/work/proj/.kxm/logs/telemetry.jsonl","exists":false,"records":0,"duplicatesDropped":0}],"configurations":[],"report":{"schema":"kxm.routing-report.v1","generatedAt":"2026-09-23T16:42:18.482Z","totalAttempts":0,"rows":[]}}
```

Read an explicit file and add the list-price column (the missing catalog is skipped):

```bash
kxm routing report --file .kxm/logs/telemetry.jsonl -l --prices .kxm/prices.yaml
```

```text
no routing records in telemetry
```

### `kxm routing benchmark`

```text
kxm routing benchmark [--task <fixture>] [--arms <models>] [--runs <count>]
```

Dedicated offline benchmark for side-by-side model comparison (Decision Q12). Today this prints fixed placeholder figures: it does not run any model, read the task, or measure anything. Latency, tokens, cost, and outcome are constants chosen from the model name. Do not use its output for routing decisions.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--task` | `<fixture>` | `Deterministic benchmark task` | Task prompt or fixture path for benchmark comparison |
| `--arms` | `<models>` | `grok/grok-4.6,claude/fable,pi/qwen3-coder-plus` | Comma-separated model routes to benchmark (e.g. grok/grok-4.6,claude/fable) |
| `--runs` | `<count>` | `1` | Benchmark runs per arm |

- Reads nothing. JSON keys: `task`, `runs`, `timestamp`, `arms` (`harness`, `model`, `latencyMs`, `tokensIn`, `tokensOut`, `costUsd`, `outcome`).

```bash
kxm routing benchmark
```

```text
Routing Benchmark Results (task: Deterministic benchmark task, runs: 1)
Harness    Model                     Latency(ms)   TokensIn  TokensOut    Cost($)    Outcome
grok       grok-4.6                          420       1200        450      $0.17     passed
claude     fable                             680       1200        450      $0.45     passed
pi         qwen3-coder-plus                  560       1200        450      $0.12     passed
```

## `kxm prices`

### `kxm prices acknowledge`

```text
kxm prices acknowledge
```

Stamps the existing `.kxm/prices.yaml` list as today's estimate. It rewrites the file with today's date and a new `sha256` over the same `models` rows, then reads it back and checks both. It does not fetch vendor rates or change any price. Cost estimates treat a catalog whose date is not today as stale and stay unknown, so run this only after you have checked the list against the vendors' current rates.

No command-specific options.

- Reads and rewrites `.kxm/prices.yaml` in the current directory. Needs no hub and no Runtime.
- Refuses `--dry-run` with `dry_run_unsupported` (exit 2).
- JSON keys: `date`, `sha256`, `note`.
- Exit 1 with `prices_acknowledge_failed` and a `message`, for example `price catalog missing` when there is no `.kxm/prices.yaml`.

```bash
kxm prices acknowledge
```

```text
price catalog stamped 2026-09-23 (list estimate only; vendor rates were not fetched)
```

## `kxm backup`

```text
kxm backup [--out <dir>] [--all-projects]
```

Creates a verified SQLite backup of this checkout's hub store and Runtime event store, with a hashed `kxm.backup-manifest.v1` manifest. It acts for the checkout the Runtime would use: the Git root that holds `.kxm/project.yaml`, or the current directory outside one. Under that checkout it discovers the hub store `.kxm/state/kxm.db`, and any `registry.db`, `bindings.db`, and `events/*.db` under `.kxm/runtime/`. Under the user state root (`KXM_STATE_HOME` or the platform default) it discovers the checkout's own `runtime/projects/<key>/run-events.db`, with `<key>` derived from the canonical checkout path as the Runtime derives it, and that store's `run-events.db.run-prompts.json` prompt sidecar, which it copies as a plain file. The shared `runtime/registry.db` and other projects' event stores are left out unless you pass `--all-projects`. It ignores `--workspace` and `KXM_DATA_PATH`. Bindings, `update.yaml` and the other state roots are not included; see [Backup and restore](../operations/backup-and-restore.md).

| Option | Argument | Default | Description |
|---|---|---|---|
| `--out` | `<dir>` | `.kxm/backups/backup-<timestamp>` | Directory to write backup and manifest |
| `--all-projects` | | Off | Also back up the Runtime registry and the event store and prompt sidecar of every project under `runtime/projects/`. Restoring that backup needs `kxm restore --all-projects` |

- Writes a copy of each store and sidecar and `manifest.json`. `--dry-run` lists the stores and files it found and the files it would write without opening any store, so no WAL is checkpointed (JSON: `scope`, `outDir`, `stores` with `storeId`, `sourcePath`, `backupFile`, `files` with `id`, `sourcePath`, `backupFile`, plus `dryRun` and `planned`).
- JSON keys: `ok`, `backupId`, `outDir`, `manifest` (`schema`, `backupId`, `createdAt`, `projectRoot`, `scope` (`project` or `all-projects`), `stateRoot`, `runtimeProjectKey`, `stores` with `storeId`, `sourcePath`, `backupFile`, `schemaVersion`, `sha256`, `bytes`, `integrity`; `files` with `id`, `sourcePath`, `backupFile`, `sha256`, `bytes`; `complete`; `omitted`; `manifestSha256`).
- A store or sidecar that cannot be copied, or that appears while the backup runs, is listed in `omitted` and the manifest records `complete: false`. The command then prints `Backup is incomplete (<n> omitted); not ok:`, sets `ok: false`, and exits 1; `kxm restore` refuses that manifest.
- Exit 1 with `backup_failed`; `issues` carry codes such as `backup_no_stores` (no store found, or none could be copied) and `database_corrupted`.

```bash
kxm backup --out ../bk
```

```text
Created SQLite backup with 2 store(s) (project scope):
  - hub-store: /work/proj/.kxm/state/kxm.db -> kxm.db (schema v5, 110592 bytes, sha256 sha256:56c6d...)
  - events:38ed26cb8eeaa297f3b0b452: /home/me/.local/state/kxm/runtime/projects/38ed26cb8eeaa297f3b0b452/run-events.db -> run-events.db (schema v7, 348160 bytes, sha256 sha256:27c13...)
Manifest: /work/bk/manifest.json
```

The summary lists stores; the prompt sidecar appears under `files` in the manifest.

In a project with a hub store and a Runtime event store:

```bash
kxm backup --dry-run
```

```text
dry run: back up 2 store(s) and 1 file(s) (project scope) to /work/proj/.kxm/backups/backup-2026-09-23T17-44-51-277Z (sources are not opened, so their WAL is not checkpointed)
  would write /work/proj/.kxm/backups/backup-2026-09-23T17-44-51-277Z/kxm.db
  would write /work/proj/.kxm/backups/backup-2026-09-23T17-44-51-277Z/run-events.db
  would write /work/proj/.kxm/backups/backup-2026-09-23T17-44-51-277Z/run-events.db.run-prompts.json
  would write /work/proj/.kxm/backups/backup-2026-09-23T17-44-51-277Z/manifest.json
```

On a machine with no hub store and no Runtime event store for this checkout yet:

```bash
kxm backup --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"backup","error":"backup_failed","issues":[{"phase":"semantic","code":"backup_no_stores","file":"/work/proj","message":"no existing SQLite stores found to backup"}]}
```

## `kxm restore`

```text
kxm restore <manifest> [--all-projects]
```

Restores SQLite stores and prompt sidecars from a verified backup manifest into the checkout the Runtime would use, found as for `kxm backup`. It checks the manifest schema, refuses a manifest that records `complete: false` (`restore_incomplete`), checks that every backup file is present and each file's digest, and works out each target. A path under the manifest's project root is rebased onto this checkout. The backed-up checkout's own event store and its sidecar go to the store the Runtime derives for this checkout under the current user state root. Anything else under the user state root, such as the registry or another project's event store, is refused with `restore_requires_all_projects` unless you pass `--all-projects`, which rebases it onto the current user state root. A manifest written before backups were scoped records its Runtime stores as bare absolute paths; they count as machine-wide too, and `--all-projects` writes them back to those paths. A manifest without a `complete` field, from an older build, still restores.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--all-projects` | | Off | Also restore the Runtime registry and other projects' event stores the backup holds, rolling back every project on the machine |

- Arguments: `<manifest>`, path to `manifest.json` or the directory that holds it.
- Refuses before writing anything while the Runtime supervisor is running (`restore_runtime_running`), judged as `kxm runtime status` judges it but through a read-only open of the registry, and while a live `hub.pid` claim sits beside a hub store it would overwrite (`restore_hub_running`). Stop both first.
- Before overwriting anything, a restore checks every store's recorded schema version against the ceiling for that store, so a store newer than this build is refused (`runtime_schema_newer`) before the first file is replaced. `--dry-run` runs the same manifest, file, digest, schema, scope, supervisor and hub checks and plans each target it would overwrite (and any `-wal` or `-shm` sidecar it would delete) without touching them. Dry-run JSON keys: `backupId`, `manifestPath`, `scope`, `stores` (`storeId`, `targetPath`, `schemaVersion`), `files` (`id`, `targetPath`), `dryRun`, `planned`.
- JSON keys: `backupId`, `manifestPath`, `scope`, `restoredStores` (`storeId`, `sourcePath`, `backupFile`, `schemaVersion`, `integrity`). `scope` is absent for a manifest written before backups were scoped.
- Exit 1 with `restore_failed`; `issues` carry codes such as `runtime_path_invalid`, `restore_manifest_invalid`, `restore_incomplete`, `restore_file_missing`, `restore_manifest_digest_mismatch`, `runtime_schema_newer`, `restore_requires_all_projects`, `restore_runtime_running`, `restore_runtime_unverified` (the registry could not be read to check the supervisor), and `restore_hub_running`.
- Two more checks run per store while restoring, after the plan checks: a backup file whose schema version differs from the version the manifest records is refused with `runtime_schema_mismatch`, and one that fails its SQLite integrity check with `database_corrupted`. In a multi-store restore, stores restored before the refused one stay restored.

```bash
kxm restore ../bk/manifest.json --dry-run
```

```text
dry run: restore 2 store(s) and 1 file(s) from /work/bk/manifest.json; digests verified against the manifest
  would write /work/proj/.kxm/state/kxm.db
  would write /home/me/.local/state/kxm/runtime/projects/38ed26cb8eeaa297f3b0b452/run-events.db
  would write /home/me/.local/state/kxm/runtime/projects/38ed26cb8eeaa297f3b0b452/run-events.db.run-prompts.json
```

While the Runtime supervisor is running:

```bash
kxm restore ../bk/manifest.json
```

```text
restore failed: /home/me/.local/state/kxm/runtime/registry.db: restore_runtime_running: the Runtime supervisor is running (pid 48213); stop it with `kxm runtime stop` and keep it stopped until the restore finishes
```

A missing manifest:

```bash
kxm restore nope.json --json
```

```text
{"schema":"kxm.cli-result.v1","ok":false,"command":"restore","error":"restore_failed","issues":[{"phase":"semantic","code":"runtime_path_invalid","file":"/work/proj/nope.json","message":"manifest path /work/proj/nope.json does not exist"}]}
```

## `kxm tenant`

### `kxm tenant status`

```text
kxm tenant status
```

Read hub metadata and authoritative Runtime run state as one labeled view, for machine clients such as the portal backend. It reads both sources concurrently (5 second hub deadline). The hub part covers the agent roster, message queue, plans, and the hub's own workflow runs; the Runtime part covers event-log-folded runs with their `homeRuntimeId`. It attaches to a running supervisor and never starts one, and it resolves only the administrative hub credential.

No command-specific options.

- Needs a KXM project. Reads only.
- An unreadable source is reported as `unavailable` with a reason (`hub_unreachable`, `hub_timeout`, `hub_unauthorized`, `hub_response_invalid`, `hub_credential_unreadable`, `runtime_supervisor_not_running`), and `degraded` is `true`. Hub and Runtime runs have separate ID spaces, so a comparison with no shared ID is `unverified` (`run_identity_link_absent`), never agreement.
- JSON (`kxm.tenant-status.v1`) keys: `project`, `generatedAt`, `hubUrl`, `bindingScope`, `hub` (`state`, `observedAt`, `value` or `reason`), `runtime`, `runComparison`, `degraded`.
- Exit 0 when at least one source was read; 1 with `tenant_status_no_source` when neither was, or `project_required`.

```bash
kxm tenant status
```

```text
tenant prj_83994a28aa6b472992394a5936c6b7c2 @ http://127.0.0.1:46315 (loopback)
hub 0/0 agents online, 0 hub runs, 0 open messages
runtime unavailable (runtime_supervisor_not_running)
cross-check: unavailable (runtime_runtime_supervisor_not_running)
```

```bash
kxm tenant status --json
```

```text
{"schema":"kxm.tenant-status.v1","ok":true,"command":"tenant status","project":"prj_83994a28aa6b472992394a5936c6b7c2","generatedAt":"2026-09-23T13:53:27.391Z","hubUrl":"http://127.0.0.1:46315","bindingScope":"loopback","hub":{"state":"ok",...},"runtime":{"state":"unavailable","observedAt":"2026-09-23T13:53:27.384Z","reason":"runtime_supervisor_not_running"},"runComparison":{"state":"unavailable","reason":"runtime_runtime_supervisor_not_running"},"degraded":true}
```

## `kxm ssh`

Multiplexed remote SSH execution. Commands reuse an OpenSSH ControlMaster socket in `.kxm/run/ssh-sockets/` in the current directory (`ControlPersist=10m`, `BatchMode=yes`, `StrictHostKeyChecking=yes`; 120 second timeout, 60 seconds for `ssh file` writes).

Host keys must already be pinned: with those options, OpenSSH refuses a host whose key is not in your `known_hosts` instead of prompting, so add the key yourself (for example with `ssh <host>` once) before the first `kxm ssh` call. KXM also refuses any option that would weaken the check (`StrictHostKeyChecking=accept-new`, `no` or `off`, or `UserKnownHostsFile=/dev/null`). JSON results carry `ok`, `action`, `host`, and the fields below, but no `command` field except `ssh close`. Under `--dry-run`, `ssh run`, `ssh file`, and `ssh close` connect to nothing: they print a plan (`command`, `host`, the remote command or path, `dryRun`, and `planned` with action `ssh`) instead. `ssh info` reads only, with or without the flag.

### `kxm ssh info`

```text
kxm ssh info [host]
```

Discover SSH host aliases and parameters safely without opening sockets. Without a host it lists the aliases in `~/.ssh/config`; with a host it resolves that host's effective settings with `ssh -G`.

- Arguments: `[host]`. No command-specific options. Reads only; no network connection.
- JSON keys: `action`, `hosts` (`alias`, `hostName`, `user`, `port`), `durationMs`, and for one host `host`, `resolvedHost`, `user`, `port`.

```bash
kxm ssh info
```

```text
No configured SSH host aliases found in ~/.ssh/config
```

```bash
kxm ssh info --json
```

```text
{"schema":"kxm.cli-result.v1","ok":true,"action":"info","hosts":[],"durationMs":0}
```

### `kxm ssh run`

```text
kxm ssh run <host> <command...> [--sudo]
```

Execute a command on a remote SSH host via multiplexed ControlMaster socket. Commands that match KXM's destructive-command patterns (`rm` with recursive and force flags, `git reset --hard`, `git clean -f`, `git checkout --` with paths, and `git restore .` or `*`) are refused before connecting.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--sudo` | none | off | Execute remote command with sudo privileges |

- Connects to the remote host and runs the command. `--dry-run` connects to nothing and prints the command it would run.
- JSON keys: `exitCode`, `stdout`, `stderr`, `truncated`, `socketReused`, `durationMs`, `error`. The exit code is the remote command's.
- stdout and stderr are each capped at 50 KB and 2,000 lines. Longer output is cut, ends with `[kxm: ssh output truncated to 50KB / 2000 lines]`, and sets `truncated: true`. Output over 10 MB fails the command. `ssh file --read` uses the same caps.

```bash
kxm ssh run build-01 uptime --dry-run
```

```text
dry run: run a command on build-01
  would ssh build-01: uptime
```

```bash
kxm ssh run build-01 uptime
```

Not run: connects to a remote host.

### `kxm ssh file`

```text
kxm ssh file <host> <path> (--read | --content <text> [--append]) [--sudo]
```

Read or write remote files over SSH.

| Option | Argument | Default | Description |
|---|---|---|---|
| `--content` | `<text>` | empty | Content to write to remote file |
| `--read` | none | off | Read remote file content |
| `--append` | none | off | Append content to remote file |
| `--sudo` | none | off | Use sudo privileges on remote file |

- Warning: without `--read` or `--append` the command overwrites the remote file, with empty content when `--content` is omitted.
- Connects to the remote host; `--dry-run` connects to nothing and names the read or write it would make. JSON keys include `stdout` for reads and `bytesProcessed` for writes.

```bash
kxm ssh file build-01 /etc/hostname --read
```

Not run: connects to a remote host.

### `kxm ssh close`

```text
kxm ssh close <host>
```

Close active ControlMaster socket for an SSH host (`ssh -O stop`).

- Always exits 0. JSON keys: `closed`, `command`, `host`.

```bash
kxm ssh close build-01
```

Not run: talks to a local SSH control socket for a real host.

## `kxm help`

```text
kxm help [command]
```

Shows help for the CLI or one command, like `--help`. Every group also has a `help` subcommand (`kxm runs help status`). Exits 0.

```bash
kxm help runs
```

```text
Usage: kxm runs [options] [command]

Inspect KXM runs
...
```

## Known behavior gaps

These are behaviors of the current build that differ from what the help text or the flag names suggest. Each is also noted in the command's section.

- `kxm routing benchmark` prints constant placeholder figures.
- `kxm task sync` does not contact GitHub or Jira.
- `kxm context` subcommands crash with a stack trace when the hub is unreachable, and they ignore the persisted hub credential.
- `kxm completion <shell>` generates a command list that includes a nonexistent `plan` command, omits `models`, `routes`, `explain`, and `ssh`, lists a nonexistent `goal get`, and omits `runs drive`, `runs receipt`, `runtime sync-retry`, and `improve report`.
- `kxm backup` JSON shows `manifestSha256` redacted.
- `--help` after an unknown subcommand (for example `kxm hub nope --help`) prints the parent group's help and exits 0, so `--help` cannot be used to test whether a subcommand exists; compare the `Usage:` line instead.

## Related

- [Environment variables and limits](configuration.md): every variable the commands read
- [Configuration file reference](config-reference.md): the files the commands read and write
- [Agent tools](tools.md): the `kxm_*` tools behind `kxm peer` and `kxm workflow`
- [Hub HTTP API](http-api.md): the routes the commands call
