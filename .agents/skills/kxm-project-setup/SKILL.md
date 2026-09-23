---
name: kxm-project-setup
description: Set up KXM in a new or existing Git repository and run a first workflow, especially with Claude Code. The agent runs kxm init, kxm trust diff and check, writes a first workflow, and drives a model-free first run, while the user starts the hub, installs the kxm Claude Code plugin, and reviews and commits .kxm permission changes. Use when asked to install, set up, onboard, initialize, upgrade, or get started with KXM.
---

# KXM project setup and first workflow

One guide from a Git repository to a completed first run. Run the agent steps
in order and stop where a phase says STOP. Everything under Operator steps is
the user's to run in their own terminal or in Claude Code.

- Read `kxm <group> <verb> --help` before a mutation; flags differ per command.
- Never commit `.kxm` changes yourself. The user's reviewed commit is the trust
  approval, and `kxm trust --help` lists only `diff` and `check`.
- Never generate, print, read, or store a hub admin token or project token.

## Agent steps

### Phase 1: initialize

1. `kxm init --dry-run --json` plans without writing. `mode` is `create`,
   `ready`, `repair`, or `legacy`, and `issues` lists anything to fix first.
2. `kxm init --name "<display name>"` prints
   `initialized KXM project at <root>`. It writes `.kxm/project.yaml`,
   `.kxm/agents/coordinator.yaml`, `.kxm/agents/implementer.yaml`,
   `.kxm/gates.yaml`, `.kxm/repo/repo.yaml`, `.kxm/template-provenance.yaml`,
   and `.kxm/workflows/default.yaml`. Outside Git it fails with
   `git_root_required`. In an existing project, plain `kxm init` validates,
   prints `validated KXM project at <root>`, and keeps local edits; there is
   no `--force`.
3. Add `.kxm/state/` and `.kxm/logs/` to `.gitignore`. `kxm init` writes no
   ignore rules.
4. `kxm hub view` reads hub health. It exits 1 with `hub health=false` until
   the user has started a hub; that does not block phases 2 and 3.
5. STOP. Ask the user to review `.kxm/` and `.gitignore` and commit them.
   Until they do, `kxm trust diff` fails with `resource_missing` for
   `.kxm/project.yaml` at base `HEAD`.

### Phase 2: write a first workflow

After the user's commit:

1. Write `.kxm/workflows/first.yaml`, a slim agent-only workflow the Runtime
   can drive end to end:

   ```yaml
   schema: kxm.workflow.v1
   description: Plan, then implement. A first workflow you can drive end to end.
   coordinator: coordinator
   limits:
     maxTransitions: 6
   steps:
     - id: plan
       kind: agent
       agent: coordinator
       maxAttempts: 2
       repositories:
         control: read
       on:
         passed: implement
         failed:
           target: $terminal
           terminalStatus: failed
     - id: implement
       kind: agent
       agent: implementer
       maxAttempts: 2
       repositories:
         control: write
       on:
         passed:
           target: $terminal
           terminalStatus: completed
         failed:
           target: $terminal
           terminalStatus: failed
   ```

2. `kxm init` validates it and prints `validated KXM project at <root>`.
3. `kxm workflow definitions` lists `default` and `first`.
4. `kxm trust diff`, then `kxm trust check`. Both print
   `EXPANSION  .kxm/workflows/first.yaml added (expansion)` and
   `1 expansion(s) require explicit reviewed trust action`. `kxm trust check`
   adds `trust check failed: review every expansion above before merging` and
   exits 1.
5. STOP. Show the user each EXPANSION line, ask them to review it and commit
   the file themselves, and wait. The `implement` step gets
   `repositories: control: write`. Never commit `.kxm` changes yourself; the
   reviewed commit is the trust approval.

### Phase 3: drive a model-free first run

After the user's commit:

1. `kxm trust check` prints `no authority-bearing or prose changes` and exits 0.
2. `kxm run first "<prompt>" --dry-run` prints
   `run plan: workflow first at sha256:… (no run created)`.
3. `kxm run first "<prompt>"` prints `run created: run_<id> …` and starts the
   Runtime supervisor.
4. `kxm runs status <runId>` prints `created`.
5. `kxm runs drive <runId> --simulated --wait --timeout-ms 60000` prints a
   `kxm.drive-receipt.v1` whose settlement is terminal `completed`, and exits 0.
   Always pass `--simulated`; without it, drive calls live harnesses.
6. `kxm runs status <runId>` prints `completed … (receipt verified)`.
7. `kxm runs receipt <runId>` and `kxm runs list`. Cancel a stuck run with
   `kxm runs cancel <runId>`.
8. `kxm runtime stop` when you are done.

To add more workflows, write the YAML by hand as in phase 2, or see
`kxm workflow add --help`. Validate any new definition with
`kxm init --dry-run --json`, then repeat the phase 2 trust review.

## Operator steps

Ask the user to run these in their own terminal. Never generate, print, read,
or store the admin or project token in the conversation. The user enters
`auth_token` at the plugin prompt.

1. Create a project token and export `KXM_PROJECT_TOKENS` before starting the
   hub. The map must list every project's token, because it replaces the saved
   map rather than merging with it. When a hub already serves other projects,
   use the merge command in the KXM README.
2. `kxm hub start` in a second terminal. It generates and persists an admin
   credential in `hub-env.json` under the user state root; that token never
   goes to an agent.
3. `kxm hub bind http://127.0.0.1:7331`.
4. In Claude Code, `/plugin marketplace add kontextmind/kxm`,
   `/plugin install kxm@kxm`, then `/plugin configure kxm@kxm` for
   `server_url`, `auth_token`, `agent_name`, `agent_purpose`, and `project`.
5. Review and commit `.kxm/` and `.gitignore` after phase 1, and every
   `kxm trust diff` EXPANSION after phase 2, for example
   `git add .kxm .gitignore && git commit`.
6. `kxm session token --clear` when kxm_* tools report `tool_policy_denied`
   for an expired or malformed session token file.
7. `kxm session brief`, in any form including `--status`. Until kxm session
   brief stops minting tokens, running it saves a 24-hour operator session
   token; when that token expires every kxm_* tool fails with
   tool_policy_denied.

## Pitfalls

- `kxm init` says `legacy state is not migrated by this build`: run
  `kxm init --dry-run --json` and fix every listed issue whose code is not
  `legacy_state_unsupported`, for example a `schema_additionalProperties` typo
  in a workflow step, then run `kxm init` again. Only when
  `.kxm/project.yaml` does not exist yet, ask the user to follow the README's
  move-aside workaround; never do that in a committed project.
- The template `default` workflow declares `limits.maxAgentTimeMs`, so
  `kxm runs drive` on it fails with `run_handoff_required`. Use `first`.
- `kxm run` starts the Runtime supervisor. Stop it with `kxm runtime stop`.
- Only run workflow IDs that `kxm workflow definitions` lists; any other ID
  fails with `run_workflow_unknown`.
- `kxm workflow list` shows hub webhook runs, not these runs; use
  `kxm runs list`.
- `KXM_SKIP_COMPLETION_PROMPT=1` and `KXM_SKIP_GUIDE_SETUP_PROMPT=1` suppress
  the interactive offers after `kxm init`.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm init` | Create, validate, repair, or join a KXM project (a legacy tree is reported as `mode: "legacy"` and never converted) | `--json`, `--dry-run`, `--name`, `--project-id`, `--repository <id=absolute-path>` |
| `kxm trust diff` | Structured permission diff against a Git revision | `--base <revision>` (default `HEAD`) |
| `kxm trust check` | Exit 1 when the working tree expands permissions | `--base <revision>` (default `HEAD`) |
| `kxm config get <key>` | Get a configuration value | `--json` |
| `kxm config set <key> <value>` | Set a configuration value | `--scope user\|project` |
| `kxm config list` | List resolved configuration | `--json` |
| `kxm completion install` | Install tab completion for the detected shell and ensure kxm is on `PATH` | `--shell <bash\|zsh\|fish>`, `--no-path`, `--dry-run`, `--json` |

`kxm completion <shell>` prints the script without installing it. `kxm trust`
reviews configuration permission diffs; it does not add website domains.
`kxm init` is project-only and does not start the hub.
