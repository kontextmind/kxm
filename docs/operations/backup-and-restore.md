# Back up and restore KXM

Protect every piece of KXM state, not only the hub database, and bring it back after a disk loss, a bad change, or a move to a new host. This page is for operators. You learn which six roots hold state, what `kxm backup` and `kxm restore` do and do not cover, and a stopped-state procedure for the rest.

## Before you begin

- The `kxm` CLI and the project checkout, on the machine that runs the hub and the [Runtime](../glossary.md#runtime).
- Permission to stop the hub, the Runtime supervisor, and anything that restarts them.
- Protected, preferably encrypted, backup storage. Backups contain message bodies, prompts and, if you include them, credentials.

## Know where state lives

KXM spreads state over six roots. Some of them move with environment variables, and a backup that assumes one location silently misses another. The following diagram shows each root, what it holds, and the variable that moves it.

```mermaid
flowchart TB
  subgraph R["$R checkout root: the Git checkout, never moves"]
    R1["Project definition: .kxm/project.yaml, config.yaml, agents/, models/, workflows/, gates.yaml, roles/, role-hosts.yaml, routes.yaml, roster.yaml, prices.yaml, repo/, project/env.yaml"]
    R2["Durable records: .kxm/memory/, skills/, goals/, tasks/, candidates/"]
  end
  subgraph D["$D workspace: KXM_WORKSPACE_DIR or --workspace, default $R/.kxm"]
    D1["logs/ (KXM_LOGS_DIR): kxm-hub.jsonl (KXM_LOG_PATH), worker logs, telemetry.jsonl"]
    D2["assets/ (KXM_ASSETS_DIR): retrospectives, improvements, evidence"]
  end
  subgraph W["$W workspace state: KXM_STATE_DIR, default $D/state"]
    W1["kxm.db hub store (KXM_DATA_PATH)"]
    W2["Pi sessions, worker manifests, PID claims"]
  end
  subgraph S["$S user state root: KXM_STATE_HOME"]
    S1["runtime/registry.db, runtime/projects/KEY/run-events.db and prompt sidecars"]
    S2["hub-env.json, hub-binding.json, update.yaml, projects/HASH/repository-bindings.json"]
  end
  subgraph C["$C user config: KXM_USER_CONFIG_DIR, default ~/.config/kxm"]
    C1["config.yaml, roles/, workflows/, role-hosts.yaml, session.token"]
  end
  subgraph T["$T federated telemetry: XDG_CONFIG_HOME/kxm/telemetry"]
    T1["model-metrics.jsonl, not written by any command today"]
  end
  R -->|".kxm/ by default"| D
  D -->|"state/ by default"| W
```

| Root | Default | Moved by |
|---|---|---|
| `$R` checkout | The Git checkout | Nothing. `.kxm/` definition files always stay here |
| `$D` workspace | `$R/.kxm` | `KXM_WORKSPACE_DIR` or `--workspace`, relative to `KXM_WORKDIR` or the current directory |
| `$W` workspace state | `$D/state` | `KXM_STATE_DIR`; `KXM_DATA_PATH` moves only `kxm.db` |
| `$S` user state root | `~/.local/state/kxm` (Linux, honoring `XDG_STATE_HOME`), `~/Library/Application Support/KXM` (macOS), `%LOCALAPPDATA%\KXM` (Windows) | `KXM_STATE_HOME`, which must be absolute |
| `$C` user config | `~/.config/kxm` | `KXM_USER_CONFIG_DIR` |
| `$T` federated telemetry | `~/.config/kxm/telemetry` | `XDG_CONFIG_HOME` |

Three override rules catch people out:

- `--workspace` derives `config/`, `logs/`, `assets/` and `state/` from one directory and ignores the per-directory variables. Without it, `KXM_CONFIG_DIR`, `KXM_LOGS_DIR`, `KXM_ASSETS_DIR` and `KXM_STATE_DIR` each move only their own target. `KXM_STATE_DIR=/srv/state` alone leaves `$D` at `$R/.kxm`.
- A relative `KXM_STATE_HOME` fails with `local_state_root_not_absolute`. A relative `XDG_STATE_HOME` or `LOCALAPPDATA` base is ignored without an error, and the platform default is used.
- `KXM_WORKER_LOG_PATH` and `KXM_AGENT_LOG_PATH` move worker logs out of `$D/logs`.

Record every override with the backup. A restore that lands where the running service does not look is not a restore.

## Know what each backup covers

`kxm backup` copies the SQLite stores it can find: the hub store under the current directory, and the Runtime stores and their prompt sidecars under the user state root. Everything else needs the stopped-state copy described below.

> [!WARNING]
> The Runtime stores are shared by every project on the machine. `kxm backup` copies `$S/runtime/registry.db` and the `run-events.db` of every project under `$S/runtime/projects/`, not only the project you run it from, and `kxm restore` writes all of them back. Restoring one project's backup returns every project's runs to the moment of that backup.

| Path | Holds | In `kxm backup` |
|---|---|---|
| `$W/kxm.db` | Hub store: agents, messages, workflow runs, journals, context items, leases, synced run facts | Yes, at `<current directory>/.kxm/state/kxm.db` only |
| `$S/runtime/registry.db` | Runtime registry: projects, their roots, the supervisor identity and claim | Yes (`registry`) |
| `$S/runtime/projects/<key>/run-events.db` | Event-sourced runs, drive receipts, gate evidence, the sync outbox | Yes, for every project (`events:<key>`) |
| `$S/runtime/projects/<key>/run-events.db.run-prompts.json` | Run prompt text; restoring a store without it loses every prompt | Yes, as a plain file (`events:<key>:run-prompts`) |
| `$S/projects/<hash>/repository-bindings.json`, `$S/update.yaml` | Member repository paths; updater settings | No |
| `$S/hub-env.json`, `$S/hub-binding.json`, `$C/session.token` | Credentials and the machine's hub binding | No; prefer regenerating secrets to copying them |
| `$R/.kxm/` definition files and durable records | Project, roles, routes, prices, roster, memory, skills, goals, tasks, candidates | No; commit them to Git or copy the checkout |
| Each member repository's `.kxm/repo/*.yaml` | Member definition and environment | No; they live in the member's own checkout |
| `$W/worker-*.json`, `$W/pi-sessions/` | Worker routing and recovery manifests; Pi model history | No; manifests are required for resumable workers, Pi history is optional |
| `$D/assets/`, `$D/logs/` | Retrospectives and evidence; logs and local usage accounting (`telemetry.jsonl`) | No |
| `$C` | User-level roles, workflows and settings | No |

A restore without `roster.yaml`, `routes.yaml` or `prices.yaml` comes back healthy but with different admission and cost behavior, so treat them as part of the backup even though they are plain files. `kxm improve report --out-dir` can write candidates outside `$R/.kxm/candidates/`; include that directory if you use it.

These files are disposable and need no backup: `hub.pid`, `hub.stop`, `worker-*.pid`, `session-brief.json`, `update-check.json`, `runtime/supervisor.token`, `runtime/supervisor.error`.

## Back up the SQLite stores with `kxm backup`

Run it from the checkout root. It finds the hub store from the current directory and ignores `--workspace`, `KXM_WORKDIR`, `KXM_STATE_DIR` and `KXM_DATA_PATH`, so a relocated hub database is not found. It finds the Runtime stores under the user state root, including one moved with `KXM_STATE_HOME`.

Preview first. A dry run lists what it would write, opens no store and writes nothing:

```bash
cd /srv/kxm/product
kxm backup --dry-run
```

Expected output:

```text
dry run: back up 3 store(s) and 1 file(s) to /srv/kxm/product/.kxm/backups/backup-2026-09-23T18-29-09-107Z (sources are not opened, so their WAL is not checkpointed)
  would write /srv/kxm/product/.kxm/backups/backup-2026-09-23T18-29-09-107Z/kxm.db
  would write /srv/kxm/product/.kxm/backups/backup-2026-09-23T18-29-09-107Z/registry.db
  would write /srv/kxm/product/.kxm/backups/backup-2026-09-23T18-29-09-107Z/run-events.db
  would write /srv/kxm/product/.kxm/backups/backup-2026-09-23T18-29-09-107Z/run-events.db.run-prompts.json
  would write /srv/kxm/product/.kxm/backups/backup-2026-09-23T18-29-09-107Z/manifest.json
```

Then write the backup outside the checkout:

```bash
kxm backup --out /backups/kxm/2026-09-23/sqlite
```

Expected output:

```text
Created SQLite backup with 3 store(s):
  - hub-store: /srv/kxm/product/.kxm/state/kxm.db -> kxm.db (schema v5, 110592 bytes, sha256 sha256:86549...)
  - registry: /home/kxm/.local/state/kxm/runtime/registry.db -> registry.db (schema v1, 20480 bytes, sha256 sha256:a5bde...)
  - events:38ed26cb8eeaa297f3b0b452: /home/kxm/.local/state/kxm/runtime/projects/38ed26cb8eeaa297f3b0b452/run-events.db -> run-events.db (schema v7, 348160 bytes, sha256 sha256:27c13...)
Manifest: /backups/kxm/2026-09-23/sqlite/manifest.json
```

The summary lists stores only; the prompt sidecar is in the manifest's `files`. When two projects' event stores share a file name, the second copy is prefixed with its store id.

For each store, `kxm backup` checkpoints the write-ahead log, runs `PRAGMA integrity_check`, copies the database with `VACUUM INTO`, checks the copy's integrity, sets mode `0600`, and records its schema version and SHA-256 in `manifest.json` (`kxm.backup-manifest.v1`). `VACUUM INTO` reads one consistent snapshot, so the hub and the Runtime can keep running during this step. Each prompt sidecar is copied as a regular file with mode `0600` and its SHA-256 recorded.

A backup is complete only when it copied everything it found. If a store or sidecar cannot be copied, or one appears while the backup runs, the manifest lists it under `omitted` and records `complete: false`, the command prints `Backup is incomplete (<n> omitted); not ok:` and exits 1, and `kxm restore` refuses that manifest.

> [!NOTE]
> Without `--out`, backups go to `.kxm/backups/` inside the checkout. Keep that directory out of Git, or always pass `--out`.

It fails with `backup_no_stores` when it finds no store at all, neither `.kxm/state/kxm.db` under the current directory nor a Runtime store under the user state root, and with `database_corrupted` when an integrity check fails.

## Back up everything else

Copy the remaining state with both services stopped. SQLite runs in write-ahead-log mode, so a plain copy of a live database can miss committed data.

1. Stop the Runtime, then the hub, and confirm both are down:

   ```bash
   kxm runtime stop
   kxm hub stop
   kxm runtime status   # expect "runtime supervisor is not running" and exit status 1
   kxm hub view         # expect "hub health=false ready=false" and exit status 1
   ```

2. Keep them down until the copy finishes. Pause your service manager's restart policy, Pi sessions with `hub.autoStart: background`, and anything that runs Runtime commands, because `kxm run`, `kxm runs list` and similar commands start the supervisor on demand.
3. Copy the hub store and the user state root:

   ```bash
   S="${KXM_STATE_HOME:-$HOME/.local/state/kxm}"   # macOS: "$HOME/Library/Application Support/KXM"
   B=/backups/kxm/2026-09-23
   mkdir -p "$B"
   kxm backup --out "$B/sqlite"
   tar -C "$S" --exclude 'supervisor.token' --exclude 'hub-env.json' -czf "$B/user-state.tgz" .
   ```

   `kxm backup` already holds the Runtime stores and sidecars. The archive holds them again, as files, together with what `kxm backup` does not copy: the repository bindings, the hub binding and `update.yaml`. It leaves out the credential file; keep tokens in your secret store, or include `hub-env.json` and protect the archive as a secret.

   If `KXM_STATE_DIR` or `KXM_DATA_PATH` moved the hub database, `kxm backup` fails with `backup_no_stores`. With both services stopped, copy that database file and any `-wal` and `-shm` files instead.
4. Copy the other roots your recovery needs: the checkout's untracked `.kxm/` records, `$D/assets/`, `$W/worker-*.json` (and `$W/pi-sessions/` only if your policy keeps model history), and `$C`.
5. Record the KXM version (`kxm --version`), the configuration commit, the schema versions from `manifest.json`, and every override variable, next to the copy.
6. Start the hub, then the Runtime with `kxm runtime start`, and resume the paused restart policies.

Keep at least one previous backup, and bound retention: run events and prompt sidecars grow with every run.

## Restore with `kxm restore`

`kxm restore` overwrites every live database in the manifest, including the Runtime stores of every project on the machine, and deletes their `-wal` and `-shm` files. It does not check whether the hub or the Runtime is running. Stop the hub and the Runtime first, and move the current state aside rather than deleting it.

Preview the restore. The dry run performs every check below and lists what it would overwrite:

```bash
cd /srv/kxm/product
kxm restore /backups/kxm/2026-09-23/sqlite/manifest.json --dry-run
```

Expected output:

```text
dry run: restore 3 store(s) and 1 file(s) from /backups/kxm/2026-09-23/sqlite/manifest.json; digests verified against the manifest
  would write /srv/kxm/product/.kxm/state/kxm.db
  would delete /srv/kxm/product/.kxm/state/kxm.db-wal
  would delete /srv/kxm/product/.kxm/state/kxm.db-shm
  would write /home/kxm/.local/state/kxm/runtime/registry.db
  would write /home/kxm/.local/state/kxm/runtime/projects/38ed26cb8eeaa297f3b0b452/run-events.db
  would write /home/kxm/.local/state/kxm/runtime/projects/38ed26cb8eeaa297f3b0b452/run-events.db.run-prompts.json
```

Then run it without `--dry-run`:

```bash
kxm restore /backups/kxm/2026-09-23/sqlite/manifest.json
```

Expected output:

```text
Restored 3 SQLite store(s) from /backups/kxm/2026-09-23/sqlite/manifest.json:
  - hub-store: -> /srv/kxm/product/.kxm/state/kxm.db (schema v5, integrity ok)
  - registry: -> /home/kxm/.local/state/kxm/runtime/registry.db (schema v1, integrity ok)
  - events:38ed26cb8eeaa297f3b0b452: -> /home/kxm/.local/state/kxm/runtime/projects/38ed26cb8eeaa297f3b0b452/run-events.db (schema v7, integrity ok)
```

Before it overwrites anything, `kxm restore` checks that the manifest is a `kxm.backup-manifest.v1` document that does not record `complete: false` (`restore_incomplete`), that every listed file exists, that each file's SHA-256 matches the manifest, and that no store is newer than this build supports. The manifest's own `manifestSha256` is not checked. A manifest from an older build that has no `complete` field still restores.

It then checks each backup's integrity and schema version again, copies it into place with mode `0600`, checks the result, and then copies the prompt sidecars back. A store under the checkout is rebased onto the current directory when the manifest came from another checkout. The Runtime stores and sidecars return to their recorded absolute paths under the user state root; restore does not move them to a different machine's or a different `KXM_STATE_HOME`.

### Restore ceilings

A backup newer than this build is refused with `runtime_schema_newer` before any file changes. KXM has no migrations: an older backup restores, but its store then refuses to open with `runtime_schema_outdated`. Restore an older backup with the release that wrote it; see [Upgrade KXM](upgrade.md#understand-schema-changes).

The ceilings come from `KXM_BACKUP_CEILINGS` in `plugins/kxm/src/database.ts` and match each store's own schema version:

| Store id | Highest schema version restored |
|---|---|
| `hub-store` | 5 |
| `registry` | 1 |
| `events:<key>` | 7 |
| `binding-store` | 1 (no current store uses it) |

### Restore the Runtime stores by hand

`kxm restore` puts the Runtime stores back at the paths they came from. Use the archive instead when the user state root moved, or when you also need the bindings and `update.yaml`.

1. Stop the Runtime and the hub, as in the backup procedure.
2. Move `$S/runtime/registry.db` and `$S/runtime/projects/` aside.
3. Extract the archive into the user state root:

   ```bash
   S="${KXM_STATE_HOME:-$HOME/.local/state/kxm}"
   tar -C "$S" -xzf /backups/kxm/2026-09-23/user-state.tgz
   ```

   The archive also brings back the hub binding, `update.yaml` and repository bindings.
4. Keep the checkout at the same absolute path. The Runtime derives each project's store key from the canonical checkout path, so a checkout restored elsewhere does not find its runs.

## Verify the restore

1. Start the hub and check `/ready` and `kxm hub view`, including that the reported `loopback` or `remote` scope matches the environment.
2. Run `kxm runtime start`, then `kxm runtime status`, and wait for the sync state to return to `ok`.
3. Run `kxm runs list`, open one run with `kxm runs status <run-id>`, and confirm its prompt sidecar came back. A run store without its sidecar is a partial restore.
4. Send one test request between two agents.

Test a full restore on a spare machine before you rely on it, and repeat the test periodically.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `backup_no_stores` | No `.kxm/state/kxm.db` under the current directory (or it was moved with `KXM_STATE_DIR` or `KXM_DATA_PATH`) and no Runtime store under the user state root | Run from the checkout root; copy a relocated database with the stopped-state procedure |
| `Backup is incomplete (<n> omitted); not ok:`, exit 1 | A store or sidecar could not be copied, or appeared while the backup ran | Fix the source named after `omitted`, then run `kxm backup` again |
| `restore_incomplete` | The manifest records `complete: false` | Restore a complete backup; the partial one is not restorable |
| Runs are missing after a restore | The checkout moved to another absolute path, so the Runtime derives a different store key, or the user state root changed | Keep the checkout at its original path and restore under the same `KXM_STATE_HOME` |
| Another project's recent runs disappeared after a restore | `kxm restore` rolled back every project's Runtime store to the backup's moment | Restore that project's store from a newer backup or from the moved-aside copy |
| `restore_manifest_digest_mismatch` | A backup file changed after the manifest was written | Use another backup; do not edit files in a backup set |
| `restore_file_missing` | A file listed in the manifest is not beside it | Copy the whole backup directory, not only `manifest.json` |
| `runtime_schema_mismatch` | A backup file's schema version differs from the one its manifest records | Use another backup set; never mix files between sets |
| `runtime_schema_newer` | The backup came from a newer release | Upgrade KXM first, then restore |
| The hub refuses to start with `runtime_schema_outdated` | The restored store is older than this build | Run the release that wrote it, or start fresh |

## Next steps

- Move to a new release safely: [Upgrade KXM](upgrade.md)
- What each store contains and how sensitive it is: [Data and storage](../concepts/data-and-storage.md)
- Watch the restored service: [Monitor KXM](monitoring.md)
- Exact flags and JSON fields: [CLI reference](../reference/cli-reference.md#kxm-backup)
