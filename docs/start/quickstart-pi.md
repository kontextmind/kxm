# Quick start: Pi

This tutorial connects two Pi agents through a KXM [hub](../glossary.md#hub) and has one ask the other for a review. It takes about ten minutes once Node.js, Git and Pi are installed. At the end, a planner and a reviewer exchange a durable request, and you can add Claude Code to the same project.

## Before you begin

- Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer, and Git.
- Pi, signed in to a model provider. Install it with `npm install --global @earendil-works/pi-coding-agent`; the [Pi documentation](https://pi.dev/docs/latest) covers sign-in.
- A Git repository for the project, and three terminals.

Every agent in one project uses the same hub URL, project key and project token, and each needs a unique name. The hub's admin token stays with you, the operator; no agent gets it.

## 1. Install

Install the `kxm` CLI with npm, and the KXM package into Pi:

```bash
npm install --global --omit=peer @kontextmind/kxm
pi install git:github.com/kontextmind/kxm@main
kxm --version
```

`kxm --version` prints the installed version. The Pi package adds the KXM extension and skills to Pi but does not put `kxm` on your `PATH`; only the npm install does. [Install KXM](install.md) covers other options.

## 2. Initialize the project

In the first terminal, before you start Pi or a hub in this repository:

```bash
cd <your-repo>
kxm init --name "<display-name>"
printf '%s\n' '.kxm/state/' '.kxm/logs/' '.kxm/backups/' >> .gitignore
git add .gitignore .kxm
git commit -m "Add KXM project configuration"
```

`kxm init` prints `initialized KXM project at <repo-root>`. It writes the project's agents, gates and a default workflow under `.kxm/`, and no ignore rules, so the second command adds them.

> [!NOTE]
> In an interactive terminal, `kxm init` offers to install shell completion and to add workflow-guide agents for the harnesses you have signed in to. Both are safe to decline. Set `KXM_SKIP_COMPLETION_PROMPT=1` and `KXM_SKIP_GUIDE_SETUP_PROMPT=1` to skip them.

## 3. Start the hub

In the second terminal, from the repository root, create a token for the project `demo` and start the hub. The commands keep any projects the hub already saved:

```bash
# The user state root is KXM_STATE_HOME when set; the default below is for macOS.
# On Linux, use "${XDG_STATE_HOME:-$HOME/.local/state}/kxm/hub-env.json" instead.
HUB_ENV="${KXM_STATE_HOME:-$HOME/Library/Application Support/KXM}/hub-env.json"
export KXM_NEW_PROJECT_TOKEN="$(openssl rand -hex 32)"
export KXM_PROJECT_TOKENS="$(node -e '
const fs = require("node:fs");
const [file, project] = process.argv.slice(1);
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).projectTokens ?? {} : {};
saved[project] = process.env.KXM_NEW_PROJECT_TOKEN;
process.stdout.write(JSON.stringify(saved));
' "$HUB_ENV" demo)"
kxm hub start
```

<details><summary>PowerShell</summary>

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:KXM_NEW_PROJECT_TOKEN = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
$stateRoot = if ($env:KXM_STATE_HOME) { $env:KXM_STATE_HOME } else { Join-Path $env:LOCALAPPDATA 'KXM' }
$hubEnv = Join-Path $stateRoot 'hub-env.json'
$env:KXM_PROJECT_TOKENS = node -e "const fs=require('node:fs');const [f,p]=process.argv.slice(1);const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')).projectTokens??{}:{};s[p]=process.env.KXM_NEW_PROJECT_TOKEN;process.stdout.write(JSON.stringify(s))" $hubEnv 'demo'
kxm hub start
```

</details>

Expected output:

```text
kxm hub: using newly generated KXM_AUTH_TOKEN from <state-root>/hub-env.json
kxm hub listening at http://127.0.0.1:7331; storage=<repo-root>/.kxm/state/kxm.db; auth=token
```

Keep this terminal open. The hub generates its admin token on the first start and saves it, with the project tokens, in `hub-env.json`. `KXM_PROJECT_TOKENS` replaces the saved project map rather than adding to it, which is why the command starts from the saved map.

> [!TIP]
> The Pi extension can start a hub for you: with the default `hub.autoStart: background`, it reuses a healthy bound hub or starts a detached one. This tutorial starts the hub by hand so that you create the project token yourself.

## 4. Bind this machine to the hub

In the first terminal:

```bash
kxm hub bind http://127.0.0.1:7331
```

Expected output:

```text
bound hub http://127.0.0.1:7331 · loopback · health=on
```

## 5. Confirm the session

```bash
kxm hub view
kxm session status
```

Expected output:

```text
hub health=true ready=true · loopback hub
1 session claim(s), 0 recovery envelope(s)
```

The hub is healthy and ready, and its process is the one session claim.

## 6. Start the planner

Still in the first terminal, give the agent the project token, which the command reads from `hub-env.json` without printing it, and an identity:

```bash
HUB_ENV="${KXM_STATE_HOME:-$HOME/Library/Application Support/KXM}/hub-env.json"
export KXM_AUTH_TOKEN="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).projectTokens[process.argv[2]] ?? "")' "$HUB_ENV" demo)"
export KXM_SERVER_URL=http://127.0.0.1:7331
export KXM_PROJECT=demo
export KXM_AGENT_NAME=planner
export KXM_AGENT_PURPOSE="Plans work and coordinates handoffs"
pi
```

<details><summary>PowerShell</summary>

```powershell
$stateRoot = if ($env:KXM_STATE_HOME) { $env:KXM_STATE_HOME } else { Join-Path $env:LOCALAPPDATA 'KXM' }
$env:KXM_AUTH_TOKEN = (Get-Content -Raw (Join-Path $stateRoot 'hub-env.json') | ConvertFrom-Json).projectTokens.'demo'
$env:KXM_SERVER_URL = "http://127.0.0.1:7331"
$env:KXM_PROJECT = "demo"
$env:KXM_AGENT_NAME = "planner"
$env:KXM_AGENT_PURPOSE = "Plans work and coordinates handoffs"
pi
```

</details>

Pi reports `Connected to the KXM hub as planner`. In Pi, run:

```text
/kxm hub
```

Expected output:

```text
kxm hub view: health=ok; planner; 1 online agent(s)
```

> [!NOTE]
> Without `KXM_AUTH_TOKEN`, the extension signs in with this machine's saved admin token, which the hub accepts only for projects that have no token of their own. Set the project token so that each agent holds only its own project's credential.

## 7. Start the reviewer and send a request

In the third terminal, run the `HUB_ENV`, `KXM_AUTH_TOKEN`, `KXM_SERVER_URL` and `KXM_PROJECT` lines from step 6, then set a different identity and start Pi:

```bash
export KXM_AGENT_NAME=reviewer
export KXM_AGENT_PURPOSE="Reviews plans and code for correctness risks"
pi
```

In the planner's Pi session, ask:

```text
Use the kxm skill. List peers, ask reviewer to examine the current plan for
its three highest correctness risks, and wait for the response.
```

The planner calls `kxm_list`, `kxm_send` and `kxm_await`. The reviewer's Pi receives the request as a new turn, and the extension returns that turn's final response as the reply. The planner then shows the reviewer's answer.

The hub stores the request as a durable record that moves from `queued` to `delivered` to `replied`, so it survives a hub restart. `kxm_await` waits at most 60 seconds; a slower reply stays pending, and the planner can check it later with `kxm_get`. [Message peer agents](../guides/peer-messaging.md) covers fanout, cancellation and delivery modes.

## 8. Add Claude Code (optional)

Claude Code can join the same project. Install the plugin as in [Quick start: Claude Code](quickstart-claude-code.md#5-install-the-plugin), with `project` set to `demo`, a unique `agent_name` such as `claude-reviewer`, and `auth_token` left blank on this machine. Then ask Claude to call `kxm_list`: the planner and the reviewer appear.

## Your first useful topology

Start with two or three agents that have clear, separate jobs:

| Role | Good responsibilities |
|---|---|
| Planner | Break down work, define ownership, collect results |
| Builder | Implement one bounded change |
| Reviewer | Check correctness, tests, security or documentation |

KXM does not coordinate file ownership. Do not let two agents edit the same files in one checkout: use separate Git worktrees, or give one agent write ownership.

## Troubleshooting

| Message or symptom | Cause | Fix |
|---|---|---|
| `agent name already active in project: <name>` | Another live Pi agent in the project uses the name | Set a different `KXM_AGENT_NAME` and restart Pi |
| `/kxm hub` prints `no agent connected` | The extension could not register | Check `KXM_SERVER_URL`, `KXM_PROJECT` and `KXM_AUTH_TOKEN`, then restart Pi |
| `invalid project authentication token` | `KXM_AUTH_TOKEN` is not the hub's token for `KXM_PROJECT` | Read the token again as in step 6 |
| `kxm init` prints `legacy state is not migrated by this build` | Pi or a hub ran here before `kxm init` | See [Check the project](quickstart-claude-code.md#check-the-project) |

[Troubleshooting](../operations/troubleshooting.md) covers workers, sessions and the hub.

## Next steps

- Keep Pi agents running unattended: [Run supervised Pi workers](../guides/pi-workers.md)
- Run a workflow end to end: [Run your first workflow](first-workflow.md)
- Send, fan out and cancel requests: [Message peer agents](../guides/peer-messaging.md)
- Hub and agent settings: [Environment variables and limits](../reference/configuration.md)
