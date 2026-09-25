---
name: kxm-harness-auth
description: Check which coding-agent harnesses are installed and authenticated, update kxm, harness CLIs and the Claude plugin, manage the Runtime supervisor, refresh the model inventory, admit or disable model routes, run remote SSH workers, and start Pi workers. Use when a dispatch fails on auth, a route is not admitted, the runtime is down, or the operator asks to update.
---

# KXM harness and auth

`kxm harness list` is observational (`yes|no|unknown`); `unknown` and `no` are
never eligible. Native harnesses keep their own login; do not silently bill
through Pi. Do not invent install, login, or status verbs.

## Harnesses and tokens

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm harness list` | Installed harnesses, auth, and native updaters | `--json` |
| `kxm auth token --status` | Report the local session token | `--json` |
| `kxm auth token --clear` | Delete the local session token file | `--json` |

Issuing a token is an operator action. When kxm_* tools fail with
`tool_policy_denied` for an expired or malformed session token file,
`kxm auth token --clear` removes it; `--status` reports
`No active session token found in env or disk` for such a file even though it
still blocks the tools.

## Plugins

| Command | Purpose | Options |
|---|---|---|
| `kxm plugin install` | Install KXM plugin for discovered or specified harnesses | `--all`, `--claude`, `--omp`, `--pi`, `--dry-run`, `--json` |

## Updates

| Command | Purpose |
|---|---|
| `kxm update --check` | Check for a kxm package update without applying it |
| `kxm update --kxm` | Apply the kxm package update |
| `kxm update [harness] --self` | Update only the harness CLI |
| `kxm update [harness] --extensions` | Update only extensions and plugins (Pi packages, the Claude kxm plugin) |
| `kxm update [harness] --models` | Refresh model catalogs where the harness supports it |

- `kxm update --kxm` downloads the GitHub release tarball by default, so it
  needs an authenticated `gh`.
- `kxm update claude --extensions` updates only a user-scope plugin install;
  its dry run prints `claude extensions: would claude plugin update kxm -y`.
  A project-scope install is the operator's `claude plugin update kxm@kxm --scope project`.
- Preview any update with `--dry-run`.

## Runtime supervisor

| Command | Purpose |
|---|---|
| `kxm runtime start` | Start the Runtime supervisor if it is not running |
| `kxm runtime status` | Supervisor liveness and per-project sync state; exits 1 when it is down |
| `kxm runtime sync-retry` | Re-queue outbox rows the hub durably refused, after the hub-side state is corrected |
| `kxm runtime stop` | Gracefully stop the supervisor |

`kxm run` starts the supervisor on demand. Stop it with `kxm runtime stop` when
work is finished.

## Models and routes

| Command | Purpose | Options |
|---|---|---|
| `kxm models inventory-refresh` | Refresh `.kxm/models/inventory.yaml` from the OpenRouter and Nous catalogs (alias `refresh`) | `--dry-run`, `--json` |
| `kxm routes list` | List admitted and disabled routes | `--json` |
| `kxm routes count` | Count admitted and disabled routes | `--json` |
| `kxm routes admit` | Admit a model route from the inventory | `--model <id>`, `--dry-run` |
| `kxm routes disable` | Disable a model route | `--model <id>`, `--dry-run` |

`kxm routes admit` and `kxm routes disable` write `.kxm/routes.yaml`, and the
model must exist in the inventory. Without `--model` in a non-interactive
shell they exit 2 with `model_selection_required`. Run them only when the user
asks, then show `kxm trust diff` and let the user review and commit the
change. A listed or admitted route is not proof of authentication.

## SSH workers

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm ssh info [host]` | Discover SSH host aliases and parameters without opening sockets | `--json` |
| `kxm ssh run <host> <command...>` | Run a command on a host over a multiplexed ControlMaster socket | `--sudo` |
| `kxm ssh file <host> <path>` | Read or write a remote file | `--read`, `--content <text>`, `--append`, `--sudo` |
| `kxm ssh close <host>` | Close the host's ControlMaster socket | `--json` |

`kxm ssh run` and `kxm ssh file` act on the remote host. Confirm the host and
command with the user first and never use `--sudo` unasked.

## Pi workers

| Command | Purpose | Options |
|---|---|---|
| `kxm agent worker` | Start a long-lived Pi worker | `--name`, `--project`, `--model`, `--fallback-models`, `--tools`, `--session-isolation`, `--no-continue`, `--fresh-start` |

Only Pi is a supervised RPC worker (`kxm agent worker`, `pi --mode rpc`).
Grok and agy are one-shot headless CLIs, not workers. Listing a harness does
not grant edit permission or writer admission.

```bash
kxm harness list --json
kxm auth token --status --json
kxm update --check --json
kxm runtime status --json
kxm routes list --json
kxm ssh info --json
```
