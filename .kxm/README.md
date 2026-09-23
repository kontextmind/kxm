# The `.kxm` directory

`.kxm/` holds a KXM project's reviewable definition and its local workspace. You
commit the configuration; logs, restart state and generated files stay on the
machine. This directory is the KXM repository's own project. In your project,
`kxm init` creates the core files: `project.yaml`, `repo/repo.yaml`, two agents,
a `default` workflow, `gates.yaml` and `template-provenance.yaml`.

## Layout

| Path | Contents | Git |
|---|---|---|
| `project.yaml` | Project identity, repositories and defaults (`kxm.project.v1`) | Tracked |
| `repo/repo.yaml` | This repository's definition (`kxm.repository.v1`) | Tracked |
| `agents/`, `models/`, `workflows/` | Agents, model profiles and workflows, one YAML file each | Tracked |
| `gates.yaml` | The executable gate registry | Tracked |
| `roles/`, `routes.yaml`, `prices.yaml` | Role rosters, admitted model routes, dated list prices | Tracked |
| `roster.yaml` | The developer assignment roster for this repository | Tracked, and must be committed |
| `template-provenance.yaml` | Hashes of the template `kxm init` used | Tracked |
| `models/inventory.yaml` | The discovered model catalog | Generated; track it for a reviewed snapshot |
| `config.yaml` | Shared personalization settings | Tracked if the project shares them |
| `memory/` | Project memory facts that `kxm memory` projects into `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` | Tracked |
| `assets/` | Intentional workflow inputs and outputs; `assets/generated/` is for machine output | Tracked intentionally; `generated/` ignored |
| `tasks/` | Task records from `kxm task` | Your choice |
| `logs/` | Hub, worker and agent logs | Ignored |
| `state/` | The hub database `kxm.db`, Pi sessions and restart state | Ignored |
| `run/` | SSH control sockets from `kxm ssh` | Ignored |

The [configuration reference](../docs/reference/config-reference.md#workspace-layout-tracked-ignored-and-state)
describes every file, the ignore rules to add, and the state KXM keeps outside
the project.

## Rules

- **No secrets here.** Keep tokens, webhook secrets and credentials in
  environment variables or a secret manager. Never commit logs, SQLite files, or
  raw prompts.
- **YAML only.** JSON definitions in a `config/` subdirectory are a retired
  format: their presence makes the project refuse to load with
  `legacy_state_unsupported`. The hub may create an empty `config/` directory;
  that alone is harmless.
- **Moving the workspace.** `KXM_WORKSPACE_DIR`, `KXM_LOGS_DIR`,
  `KXM_ASSETS_DIR` and `KXM_STATE_DIR` relocate `logs/`, `assets/` and
  `state/`. The configuration files always stay in `<project root>/.kxm/`.
