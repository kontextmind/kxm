---
name: kxm-project-setup
description: Initialize, migrate, review permission changes, configure, and add shell completion for KXM projects.
---

# KXM Project Setup

Use the current CLI. Inspect `kxm <command> --help` before mutations. Do not
invent `force`, domain-trust, or extra migrate verbs.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm init` | Create, validate, or plan migration of a vNext project | `--json`, `--dry-run`, `--name`, `--project-id`, `--repository <id=absolute-path>` |
| `kxm migrate plan` | Compute the legacy-to-vNext plan without writes | `--json` |
| `kxm migrate apply` | Install a reviewed migration with a hash-linked receipt | `--decisions <file>`, `--project-id`, `--name` |
| `kxm migrate verify` | Verify a migration receipt | `--json` |
| `kxm trust diff` | Structured permission diff against a Git revision | `--base <revision>` |
| `kxm trust check` | Fail when the working tree expands permissions | `--base <revision>` |
| `kxm config get <key>` | Get a configuration value | `--json` |
| `kxm config set <key> <value>` | Set a configuration value | `--scope user\|project` |
| `kxm config list` | List resolved configuration | `--json` |
| `kxm completion <shell>` | Generate completion script | `bash`, `zsh`, or `fish` |

```bash
kxm init --dry-run --json
kxm migrate plan --json
kxm trust diff --base HEAD --json
kxm config list --json
kxm completion zsh
```

`kxm trust` reviews configuration permission diffs; it does not add website
domains. `kxm init` is project-only and does not start the hub.
