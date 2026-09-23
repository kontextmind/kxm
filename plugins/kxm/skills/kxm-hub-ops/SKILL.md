---
name: kxm-hub-ops
description: Start, inspect, stop, bind, and unbind the KXM hub (default http://127.0.0.1:7331), read tenant status, and back up or restore its SQLite state. Use when kxm_list or peer commands cannot reach the hub, when binding to a local or authenticated remote hub, or before upgrades.
---

# KXM hub operations

The hub serves peers and webhook workflows on `http://127.0.0.1:7331` by
default. Its CLI is `start`, `view`, `stop`, `bind`, and `unbind`. Do not
invent restart or status subcommands.

## Agent steps

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm hub view` | Check `/health` and `/ready`; exits 1 when the hub is down | `--json` |
| `kxm tenant status` | Hub metadata and Runtime run state as one labeled view; reads only and never starts the supervisor | `--json` |
| `kxm backup` | Verified SQLite backup of this project's hub store and Runtime event store with a hashed manifest; exits 1 when the backup is incomplete | `--out <dir>`, `--all-projects`, `--json` |

```bash
kxm hub view --json
kxm tenant status --json
kxm backup --out .kxm/backups/pre-upgrade --json
```

`kxm tenant status` reports an unreadable source as `unavailable` with a
reason such as `hub_unreachable` or `runtime_supervisor_not_running`, and sets
`degraded`. It exits 0 when at least one source was read. Hub runs and Runtime
runs have separate ID spaces, so a comparison with no shared ID is
`unverified`, never agreement.

The durable hub store defaults to `.kxm/state/kxm.db` (`KXM_DATA_PATH`). Do not
hand-edit it. `kxm backup` also copies this project's Runtime event store and
prompt sidecar from the user state root. The shared Runtime registry and other
projects' event stores are copied only with `--all-projects`, and only
`kxm restore --all-projects` restores them, rolling back every project on the
machine. Do not pass `--all-projects` unless the user asked for a whole-machine
backup or restore.

## Operator steps

Ask the user to run these in their own terminal. Never read, print, or store
the hub admin token or a project token.

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm hub start` | Start the hub in the foreground | `--json` |
| `kxm hub stop` | Request managed hub and worker shutdown | `--wait-ms <ms>` |
| `kxm hub bind <url>` | Bind this machine to a running hub | http or https URL |
| `kxm hub unbind` | Remove this machine's hub binding | `--json` |
| `kxm restore <manifest>` | Replace this project's live stores from a verified backup manifest | `--all-projects`, `--json` |

```bash
kxm hub start
kxm hub bind http://127.0.0.1:7331
kxm restore .kxm/backups/pre-upgrade/manifest.json
```

- `kxm hub start` needs no token setup on a fresh machine. When
  `KXM_AUTH_TOKEN` is unset it generates a long random admin token once and
  persists it in `hub-env.json` (schema `kxm.hub-env.v1`, mode `0600`) under
  the user state root, then reuses it on every restart.
- `KXM_PROJECT_TOKENS` must list every project's token. It replaces the saved
  token map rather than merging with it, and the replacement is saved. When a
  hub already serves other projects, build the full map with the merge
  command in the KXM documentation's Claude Code quick start
  (docs/start/quickstart-claude-code.md, section "Start the hub") before
  restarting the hub.
- `kxm hub bind` to a remote (non-loopback) URL fails closed with
  `hub_bind_unauthenticated` unless a credential for the current project
  resolves from `KXM_AUTH_TOKEN` or the persisted `hub-env.json`.
- Hub PID claims record the wrapper and server child PID. A dead wrapper's
  claim is reclaimed automatically, an orphaned server is terminated first,
  and `kxm hub stop` recovers such orphans directly.
- `kxm restore` replaces the live stores. Preview it with
  `kxm restore <manifest> --dry-run`, and never skip restore verification. It
  refuses before writing while the Runtime supervisor runs
  (`restore_runtime_running`) or a hub holds the hub store
  (`restore_hub_running`), so stop both first (`kxm runtime stop`,
  `kxm hub stop`). A backup that holds the registry or another project's
  event store is refused with `restore_requires_all_projects`.
