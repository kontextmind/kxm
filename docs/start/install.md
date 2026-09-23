# Install KXM

KXM has three parts you can install: the `kxm` command-line tool, the Claude Code plugin, and the Pi package. This page installs each one and shows how to check it. Install the CLI first, because it is the only part that creates projects and starts a [hub](../glossary.md#hub); the plugin and the Pi package connect agents to one.

## Before you begin

- Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer, with npm. Check with `node --version`.
- Git.
- Claude Code, if you want the plugin.
- Pi, if you want Pi agents. Install it with `npm install --global @earendil-works/pi-coding-agent` and sign in to a model provider as the [Pi documentation](https://pi.dev/docs/latest) describes.
- The GitHub CLI (`gh`), only if you plan to update with `kxm update --kxm`, which downloads the release tarball from GitHub.

## Choose what to install

| Part | What it gives you | How to install |
|---|---|---|
| `kxm` CLI | `kxm init`, the hub, runs, backups and updates. Every setup needs it. | [npm](#install-the-cli) |
| Claude Code plugin | MCP tools, KXM skills, a session-start brief, and optional pushed requests | [Claude Code marketplace](#install-the-claude-code-plugin) |
| Pi package | The Pi extension (tools, the `/kxm` command, hub auto-start) and KXM skills | [`pi install`](#install-the-pi-package) |
| Source checkout | The same CLI from a clone, for contributors | [`git clone` and `npm ci`](#run-from-a-source-checkout) |

## Install the CLI

1. Confirm that npm can see the package:

   ```bash
   npm view @kontextmind/kxm version
   ```

   Expected output: the latest published version number.

2. Install it globally:

   ```bash
   npm install --global --omit=peer @kontextmind/kxm
   ```

   `--omit=peer` skips the package's peer dependencies. They are Pi libraries that only the Pi extension loads, and Pi supplies them itself.

3. Check that `kxm` is on your `PATH`:

   ```bash
   kxm --version
   ```

   Expected output: the same version number that `npm view` printed.

Optionally, install tab completion for bash, zsh or fish. It also adds the npm global `bin` directory to `PATH` in your shell startup file when it is missing:

```bash
kxm completion install
```

> [!NOTE]
> Only the npm install puts `kxm` on your `PATH`. The Claude Code plugin and the Pi package do not install the CLI.

## Install the Claude Code plugin

In Claude Code:

```text
/plugin marketplace add kontextmind/kxm
/plugin install kxm@kxm
/reload-plugins
```

Choose project scope to share the plugin with everyone who works in the repository. Claude Code then asks for the plugin options; [Quick start: Claude Code](quickstart-claude-code.md#6-configure-the-plugin) explains each one.

The same install from a shell, at project scope:

```bash
claude plugin marketplace add kontextmind/kxm
claude plugin install kxm@kxm --scope project
```

Expected output:

```text
✔ Successfully installed plugin: kxm@kxm (scope: project)
5 userConfig options not yet set (3 required) — run /plugin configure kxm@kxm in Claude Code, or pass --config KEY=VALUE.
```

A project-scope install writes `{"enabledPlugins": {"kxm@kxm": true}}` to `.claude/settings.json`. Commit that file so teammates get the plugin too.

The plugin's MCP server and its session-start hook run `node` from the `PATH` that Claude Code uses. They are bundled with the plugin, so they do not need `kxm` on `PATH`.

## Install the Pi package

In a terminal:

```bash
pi install git:github.com/kontextmind/kxm@main
```

Restart Pi after you install or update the package. `pi list` shows it.

The package adds the KXM extension and the KXM Agent Skills to Pi. The extension registers the `kxm_*` tools and the `/kxm` command, and by default it starts a local hub in the background when none is running. [Quick start: Pi](quickstart-pi.md) connects two Pi agents.

## Run from a source checkout

Contributors can run the CLI from a clone instead of installing it:

```bash
git clone https://github.com/kontextmind/kxm.git
cd kxm
npm ci
node scripts/kxm.mjs --version
```

Use `node scripts/kxm.mjs` wherever the docs show `kxm`. It runs the CLI bundle committed in `plugins/kxm/dist/`. Update a checkout with `git pull` and `npm ci`; `kxm update --kxm` refuses to run there. [Develop KXM](../contributing/development.md) covers building and testing.

## Update

| Part | Command |
|---|---|
| `kxm` CLI | `npm install --global --omit=peer @kontextmind/kxm@latest` (check first with `kxm update --check`) |
| Claude Code plugin | `claude plugin marketplace update kxm`, then `claude plugin update kxm@kxm` |
| Pi package | `pi update --extensions` |

Back up and stop the hub before you update the CLI. [Update KXM and the plugin](quickstart-claude-code.md#update-kxm-and-the-plugin) covers the plugin's scopes and version pin, and [Upgrade KXM](../operations/upgrade.md) covers the full procedure and rollback.

## Uninstall

```bash
npm uninstall --global @kontextmind/kxm
claude plugin uninstall kxm@kxm
pi remove git:github.com/kontextmind/kxm
```

Add `--scope project` to the `claude plugin uninstall` command for a project-scope install. Uninstalling leaves project files (`.kxm/`) and the hub database in place.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `kxm: command not found` after the npm install | The npm global `bin` directory is not on `PATH` | Run `"$(npm prefix --global)/bin/kxm" completion install`, then restart the shell |
| npm warns `EBADENGINE` | Node.js is older than 22.19, or is 23 | Install Node.js 22.19 or newer on 22.x, or 24 or newer |
| The `kxm_*` tools do not appear in Claude Code | `node` is not on the `PATH` Claude Code uses, or the plugin is disabled | Check `/mcp`, `node --version` and `claude plugin list`, then run `/reload-plugins` |
| Pi update fails with `couldn't find remote ref refs/heads/master` | An old Pi checkout tracks `master` | Run `pi remove git:github.com/kontextmind/kxm`, then install again with `@main` |

## Next steps

- Connect Claude Code to a hub: [Quick start: Claude Code](quickstart-claude-code.md)
- Connect two Pi agents: [Quick start: Pi](quickstart-pi.md)
- Run a workflow: [Run your first workflow](first-workflow.md)
- Every `kxm` command: [CLI reference](../reference/cli-reference.md)
