---
name: kxm-project-setup
description: Initialize, review permission changes, configure, and add shell completion for KXM projects.
---

# KXM Project Setup

Use the current CLI. Inspect `kxm <command> --help` before mutations. Do not
invent `force`, domain-trust, or legacy-migration verbs: this build converts
nothing.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm init` | Create, validate, repair, or join a KXM project (a legacy tree is reported as `mode: "legacy"` and never converted) | `--json`, `--dry-run`, `--name`, `--project-id`, `--repository <id=absolute-path>` |
| `kxm trust diff` | Structured permission diff against a Git revision | `--base <revision>` |
| `kxm trust check` | Fail when the working tree expands permissions | `--base <revision>` |
| `kxm config get <key>` | Get a configuration value | `--json` |
| `kxm config set <key> <value>` | Set a configuration value | `--scope user\|project` |
| `kxm config list` | List resolved configuration | `--json` |
| `kxm completion install` | Install tab completion for the detected shell and ensure kxm is on `PATH` | `--shell <bash\|zsh\|fish>`, `--no-path`, `--dry-run`, `--json` |

```bash
kxm init --dry-run --json
kxm trust diff --base HEAD --json
kxm config list --json
kxm completion install
```

`kxm completion install` detects the shell from `$SHELL`, writes the
completion script under the user config directory, appends one idempotent
stanza to the shell rc file, and adds the kxm bin directory to `PATH` when
missing. `kxm completion <shell>` (generate only) remains available for
manual setup. After `kxm init` succeeds in an interactive terminal, kxm
offers the same install once per shell.

`kxm trust` reviews configuration permission diffs; it does not add website
domains. `kxm init` is project-only and does not start the hub.
