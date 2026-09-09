---
name: kxm-hub-ops
description: Run and protect the local hub and its durable SQLite state.
---

# KXM Hub Operations

Hub process CLI is `start`, `view`, `stop`, plus bind/unbind. Backup writes a
verified SQLite archive; restore takes that manifest. Do not invent restart
or backup subcommands.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm hub start` | Start the hub | `--json` |
| `kxm hub view` | Check `/health` and `/ready` | `--json` |
| `kxm hub stop` | Request managed shutdown | `--wait-ms <ms>` |
| `kxm hub bind <url>` | Bind this machine to a running hub | http or https URL |
| `kxm hub unbind` | Remove this machine's hub binding | `--json` |
| `kxm backup` | Verified SQLite backup of all stores | `--out <dir>` |
| `kxm restore <manifest>` | Restore from a verified backup manifest | `--json` |

Durable hub SQLite default is `.kxm/state/kxm.db` (`KXM_DATA_PATH`).

```bash
kxm hub start
kxm hub view --json
kxm hub bind http://127.0.0.1:8787
kxm backup --out /tmp/kxm-backup
kxm restore /tmp/kxm-backup/manifest.json
```

Do not hand-edit the hub database or skip restore verification.
