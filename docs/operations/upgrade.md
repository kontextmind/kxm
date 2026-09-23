# Upgrade KXM

Move the `kxm` CLI, the hub, the Runtime, and the Claude Code or Pi integrations to a new release, and roll back if the new release misbehaves. This page is for operators. KXM stores have no migrations, so the order of steps matters more than usual.

## Before you begin

- Protected storage for a full backup; see [Back up and restore KXM](backup-and-restore.md).
- A window in which the hub, the Runtime supervisor and long-lived workers may stop.
- The GitHub CLI (`gh`, signed in) if you apply updates with `kxm update --kxm` from the default `github` source, which downloads the release tarball with it.

## Check for an update

```bash
kxm update --check
```

Expected output when a newer release exists:

```text
kxm 0.7.1 → 0.7.2 available · kxm update --kxm
```

From a source checkout, the check makes no network call and reports the checkout instead:

```text
kxm 0.7.1 (running from source at /work/kxm)
```

The check reads `update.yaml` under the user state root. Its `source` is `github` (release tarballs) by default; `npm` is also accepted. See [Updater settings](../reference/config-reference.md#updater-settings-kxmupdatev1). Add `--json` to see the install kind KXM detected.

## Stop the services and back up

Stop everything that holds a KXM database open, in this order, and confirm each one is down:

```bash
kxm runtime stop
kxm hub stop            # also stops long-lived workers that recorded PID claims
kxm runtime status      # expect "runtime supervisor is not running"
```

Pause service-manager restarts and background hub starts (`hub.autoStart`) until the upgrade finishes. An old process that keeps running against a store the new release rewrites, or a new process that opens an old store, fails closed at best.

Then take the stopped-state backup in [Back up everything else](backup-and-restore.md#back-up-everything-else), and record the current version with `kxm --version`.

## Upgrade the CLI

Use the path that matches how KXM was installed. `kxm update --kxm` applies an update only for a global npm install; for every other install kind it exits `2` and prints the command to use instead.

| Install kind | Upgrade with |
|---|---|
| Global npm install | `kxm update --kxm` (release tarball, or npm with `source: npm`), or `npm install --global --omit=peer @kontextmind/kxm@latest` |
| Pi package | `pi update` |
| Claude Code marketplace plugin | `claude plugin update kxm@kxm` (see the plugin note below) |
| Project dependency | `npm install @kontextmind/kxm@latest` in that project |
| Source checkout | `git pull`, then `npm ci` |

`kxm update --kxm` refuses to install a GitHub release that does not publish a SHA-256 digest for its tarball (`release_digest_missing`) or whose download does not match it (`release_digest_mismatch`). Preview the steps first:

```bash
kxm update --kxm --dry-run
```

### Update harnesses and plugins

Without `--check` or a lone `--kxm`, `kxm update` also runs the native updaters of detected harnesses. Narrow it with a harness id and one scope:

```bash
kxm update --dry-run               # plan every detected harness
kxm update pi --extensions         # pi update --extensions
kxm update claude --extensions     # claude plugin update kxm -y (user scope)
kxm update pi --models             # refresh Pi model catalogs
```

For the Claude Code plugin, follow [Update KXM and the plugin](../start/quickstart-claude-code.md#update-kxm-and-the-plugin) or the [plugin update notes](../../plugins/kxm/README.md#update). The plugin version is pinned, so an ordinary `claude plugin update` can report "already at the latest version" while the cached copy is old; the notes give the reinstall that refreshes it.

## Start and verify

1. Start the hub (or its service), then the Runtime with `kxm runtime start`.
2. Check `kxm hub view`, `/ready` and `/metrics`.
3. Check `kxm runtime status` until every project reports `ok` or `no_hub`.
4. Send one request between two agents and read one Runtime run with `kxm runs status <run-id>`.
5. Restart long-lived workers and reload Claude Code (`/reload-plugins`) so every agent runs the matching release.

## Understand schema changes

Each store records a schema version, and KXM never upgrades a store in place.

| Store | Location | Created by |
|---|---|---|
| Hub store | `.kxm/state/kxm.db` (`KXM_DATA_PATH`) | `kxm hub start` |
| Runtime registry | `runtime/registry.db` under the user state root | The Runtime supervisor |
| Run event store | `runtime/projects/<key>/run-events.db` under the user state root | The Runtime supervisor |

- A store **newer** than the running release refuses to open (`runtime_schema_newer`). Do not delete it; run the release that created it, or upgrade.
- A store **older** than the running release also refuses to open (`runtime_schema_outdated`), and the error names the store. There is no migration.

When a release changes a schema, either stay on the old release, or accept a fresh store: stop the owner, move the old file aside (keep it with your backup), and start the owner, which re-creates it. `kxm init` rebuilds no database. A fresh hub store loses message and workflow history; a fresh Runtime store loses local run history. Check the changelog for schema changes before you upgrade.

> [!CAUTION]
> Deleting a store is irreversible for the history it holds. Move it aside instead, and keep the pre-upgrade backup until the new release has run cleanly.

## Roll back

1. Stop the Runtime, the hub and the workers.
2. Reinstall the earlier release the same way you upgraded (for npm, `npm install --global --omit=peer @kontextmind/kxm@<version>`).
3. Restore the pre-upgrade backup of every store the new release touched. Never open a newer-schema store with an older release.
4. Start and verify as above.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `install_kind_source` or `install_kind_<kind>` from `kxm update --kxm` | KXM was not installed with a global npm install | Use the command from the table above |
| `release_digest_missing` or `release_digest_mismatch` | The GitHub release has no or a different digest | Wait for a published release, or install from npm |
| `kxm_update_config_invalid` | `update.yaml` has an unknown field or a wrong type | Fix it; only `schema`, `auto` and `source` are allowed |
| The hub refuses to start with `runtime_schema_outdated`, or a Runtime project reports that its store is not readable | The store predates this release | Roll back, or move the store aside and start fresh |
| Claude still runs the old plugin | The plugin version pin kept the cached copy | Reinstall as the plugin update notes describe |

## Next steps

- Confirm the service is healthy: [Monitor KXM](monitoring.md)
- Recover from a failed upgrade: [Back up and restore KXM](backup-and-restore.md)
- Every `kxm update` flag: [CLI reference](../reference/cli-reference.md#kxm-update)
