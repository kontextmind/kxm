# Operate a KXM hub

This page is the operator index for a [hub](glossary.md#hub): where the other
operations guides live, and how to attach a client on another machine to a hub
that is not reachable from the internet. The client in that setup is a local
`kxm` CLI, plus the Pi and Claude Code agents that CLI starts.

## Where each procedure lives

| Procedure | Page |
|---|---|
| Install the services on a tenant box, including loopback listeners | [Deploy KXM](operations/deploy.md) |
| Health, readiness, metrics, logs, and alerts | [Monitor KXM](operations/monitoring.md) |
| Stopped-state backup of all six state roots, and restore | [Back up and restore KXM](operations/backup-and-restore.md) |
| Package update, plugin reinstall, and schema ceilings | [Upgrade KXM](operations/upgrade.md) |
| Runtime outbox, sync refusals, and hub leases | [Operate Runtime sync and leases](operations/runtime-sync.md) |
| Symptoms, causes, and fixes | [Troubleshoot KXM](operations/troubleshooting.md) |

The six roots are the checkout, the workspace, workspace state, the user state
root, user config, and federated telemetry. The stopped-state copy of each one
is in [Back up and restore KXM](operations/backup-and-restore.md).

## Before you begin

- The `kxm` CLI is installed on the client machine.
- You can open SSH to the hub host, and you already have that host's key.
- The hub's admin token is in a password manager. 1Password CLI (`op`) is the
  usual source. The token is never written into `hub-binding.json`.

## Cross-box peer attach

Use this when the hub listens on loopback on a private machine and your client
reaches it through an SSH local forward. A plain `kxm hub bind` of
`http://127.0.0.1:17331` is a loopback bind: it stores no credential, and later
commands send this machine's hub-env admin token. The remote hub rejects that
token with 401. `--cloud` marks the binding remote even though the URL is
loopback, and names where the token comes from without storing the token.

### Open the forward with a pinned host key

Pin the host key before the first connection. Do not accept a key on first use.

```bash
ssh-keyscan -H 10.31.0.21 >> ~/.ssh/known_hosts
ssh -N \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts" \
  -L 127.0.0.1:17331:127.0.0.1:7331 \
  user@10.31.0.21
```

Leave that SSH session open. Hub traffic then goes to `127.0.0.1:17331` on the
client and comes out on the hub host's loopback port 7331.

<details><summary>PowerShell</summary>

```powershell
ssh-keyscan -H 10.31.0.21 >> $env:USERPROFILE\.ssh\known_hosts
ssh -N `
  -o ExitOnForwardFailure=yes `
  -o StrictHostKeyChecking=yes `
  -o UserKnownHostsFile="$env:USERPROFILE\.ssh\known_hosts" `
  -L 127.0.0.1:17331:127.0.0.1:7331 `
  user@10.31.0.21
```

</details>

### Bind the forward as a cloud hub

Pick one token source. The environment variable is enough when the shell
already holds the token. The command form asks 1Password each time a command
needs the token. Do not put the token text in `--token-command`: that string
is stored in the binding.

```bash
export KXMD_HUB_TOKEN="$(op read 'op://Private/kxmd/admin-token')"
kxm hub bind --cloud --token-env KXMD_HUB_TOKEN http://127.0.0.1:17331
kxm hub view
```

Or name the 1Password command and skip the variable:

```bash
kxm hub bind --cloud \
  --token-command "op read op://Private/kxmd/admin-token" \
  http://127.0.0.1:17331
```

Expected output:

```text
bound hub http://127.0.0.1:17331 · remote · health=on · token is not stored
hub health=true ready=true · remote hub · mode=cloud project=prj_example (.kxm/config.yaml hub.cloud.project) key=env:KXMD_HUB_TOKEN
```

`--token-env` and `--token-command` can be combined. A non-empty variable wins.
Otherwise the command runs. The command is a program and arguments, not a shell
pipeline (`|`, `&`, `;`, and redirection are refused).

<details><summary>PowerShell</summary>

```powershell
$env:KXMD_HUB_TOKEN = op read "op://Private/kxmd/admin-token"
kxm hub bind --cloud --token-env KXMD_HUB_TOKEN http://127.0.0.1:17331
kxm hub view
```

</details>

### What --cloud changes

| | Local bind | `--cloud` bind |
|---|---|---|
| Loopback URL | Scope `loopback`. No credential required | Scope `remote`, including an SSH forward |
| Token stored in `hub-binding.json` | No | No. The file names `tokenEnv` and/or `tokenCommand` |
| Credential later commands send | `KXM_AUTH_TOKEN`, then the active mode's key reference in `.kxm/config.yaml`, then this machine's hub-env | The active mode's key reference, then the binding's named source. Hub-env is not a fallback |
| Missing source | Agent commands report `project_token_missing` and name the project id that was sent | `cloud_token_missing` or `cloud_token_command_failed`. The local admin token is not sent |
| `kxm hub start` from an extension | May start a local hub | Does not start a local hub when the forward is down (`cloud_hub_unreachable`) |

`kxm hub view`, `kxm tenant status`, `kxm peer`, `kxm workflow` agent commands,
`kxm context`, Runtime presence, and the environment exported for a Pi worker
all use that source. `kxm agent worker` puts `KXM_AUTH_TOKEN` in the child
process environment only. It does not write the token to disk.

The hub project id is the same value everywhere: `--project` or `KXM_PROJECT`,
then the active mode's `project` in `.kxm/config.yaml`, then the `id` in
`.kxm/project.yaml`, then `package.json` `name`, then the directory name.

### Hub identity in config

Hub URL, mode, project id, and key reference live in `.kxm/config.yaml`
(`kxm.config.v1`), the same file as `hub.autoStart`. `.kxm/project.yaml` stays
the stable project id. The project file wins over
`~/.config/kxm/config.yaml`. `KXM_PROJECT` and `KXM_SERVER_URL` select the
live connection for one process. They do not rewrite the file.

```yaml
hub:
  autoStart: background
  mode: local                 # local | cloud
  local:
    url: http://127.0.0.1:7331
    project: prj_example      # optional; defaults to the project.yaml id
    key:
      op: op://Private/kxm/local-project-token
      env: KXM_LOCAL_PROJECT_TOKEN
  cloud:
    url: https://hub.kxmd.dev
    project: prj_example
    key:
      op: op://Private/kxmd/project-token
      env: KXMD_HUB_TOKEN
  projects:                   # hub process map; references only
    prj_example:
      op: op://Private/kxm/local-project-token
      env: KXM_LOCAL_PROJECT_TOKEN
```

`key.op` is an `op://vault/item/field` reference. `key.env` is an environment
variable name. A non-empty variable wins; otherwise `op read` runs when the
client or the hub needs the token. The resolved value is not written to
config, `hub-binding.json`, or `hub-env.json`. A literal token is refused
with `hub_config_invalid`.

`kxm hub bind` and `kxm hub bind --cloud` write the mode, URL, project id, and
key reference. `--key-op` is the `op://` reference for either mode.
`--token-env` names the variable for either mode. `--token-command` stays
cloud-only. `kxm hub view` prints the mode, URL, project id, and key source.
It does not print the token. `kxm hub unbind` removes the binding and
`hub.mode`, and leaves the `local` and `cloud` blocks in place.

On the hub, `hub.projects` is that same kind of map. `KXM_PROJECT_TOKENS`
still replaces the map and is saved. A config map is resolved in memory and
does not replace the saved file.

A setup whose hub map is still keyed by the package name should set
`hub.local.project` or `hub.cloud.project` to that name. Otherwise clients
send the `.kxm/project.yaml` id and the hub has no token for it.

### Remove the binding

```bash
kxm hub unbind
```

Unbind deletes `hub-binding.json` and clears `hub.mode` in `.kxm/config.yaml`.
The `local` and `cloud` blocks stay, so the next bind can switch mode again.
It does not delete hub-env, and it does not close the SSH forward. Stop the
forward by ending the `ssh -N` session.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 401 `invalid_auth` after binding `127.0.0.1:17331` | The bind was not `--cloud`, so the client sent this machine's hub-env admin token | Bind again with `--cloud` and a token source that holds the remote hub's token. Unset a stale `KXM_AUTH_TOKEN` that points at the local hub |
| `cloud_token_missing` | `KXMD_HUB_TOKEN` (or the variable you named) is unset or empty, and no command is configured | Export the variable or pass `--token-command`. The local hub-env token is intentionally unused |
| `project_token_missing` | The project id sent to the hub has no agent token. The message names that id and where it came from | Set `hub.local.project` or `hub.cloud.project` in `.kxm/config.yaml` to the id the hub already knows, and point `key.op` or `key.env` at the token. `KXM_PROJECT` or `--project` overrides the id for one command. Do not paste the token into the file |
| `cloud_token_command_failed` | `op` exited non-zero, timed out, or printed more than one line | Run the same command in a terminal and sign in to 1Password. Do not paste the token into the binding |
| Clients through one SSH host get locked out together | The hub rate-limits by agent id, otherwise by source address. Every forward from one SSH session shares `127.0.0.1` on the hub. `sshd` `MaxStartups` and `MaxSessions` can refuse new forwards first | Give each long-lived agent its own name. Raise the SSH limits on that host if many people share one jump host. Do not point two tenants at one hub |
| `kxm hub view` says `loopback` for the forward | `--cloud` was omitted | Bind again with `--cloud`. `KXM_SERVER_URL` overrides the binding URL and is labeled on its own |

## Next steps

- Deploy the hub itself: [Deploy KXM](operations/deploy.md)
- Read health and metrics: [Monitor KXM](operations/monitoring.md)
- Command flags: [kxm hub bind](reference/cli-reference.md#kxm-hub-bind)
