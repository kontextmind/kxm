# Getting started

This guide takes you from a clean machine to a successful peer request. Allow about ten minutes once Node.js, Git, and your agent harnesses are installed.

## Before you begin

You need:

- Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer;
- Git;
- GitHub CLI for the command-first release install;
- Pi for Pi agents;
- Claude Code only if you want a mixed Pi/Claude pool;
- access to `kontextmind/kxm` while the repository is private.

All agents in one pool must use the same hub URL, project token, and project name. Keep the hub/operator administrative token separate. Every active agent in that project must have a unique name.

## 1. Install

Pi's Git package installation supplies the extension and Agent Skill but does
not add `kxm` to `PATH`. Download the packed release through an authenticated
GitHub CLI session and install that local tarball. Run `gh auth login` first if
necessary.

PowerShell:

```powershell
$version = "<release-version>"
$asset = "kxm-$version.tgz"
$releaseDir = Join-Path $PWD ".kxm-release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
gh release download "v$version" --repo kontextmind/kxm --pattern $asset --dir $releaseDir --clobber
npm install --global --omit=peer (Join-Path $releaseDir $asset)
pi install git:github.com/kontextmind/kxm@main
kxm --help
```

Bash:

```bash
version='<release-version>'
asset="kxm-${version}.tgz"
mkdir -p .kxm-release
gh release download "v${version}" --repo kontextmind/kxm \
  --pattern "$asset" --dir .kxm-release --clobber
npm install --global --omit=peer ".kxm-release/$asset"
pi install git:github.com/kontextmind/kxm@main
kxm --help
```

Do not substitute a global `git+https` npm install; the supported global
operator package is the versioned release tarball. To run from source instead,
clone the repository, run `npm ci`, and use `node scripts/kxm.mjs` in place
of `kxm`.

## 2. Initialize the project

```text
kxm init
```

`kxm init` never copies the package repository's dogfood roster or workflows into a consumer workspace.
The current template workflow can be driven: it does not set `limits.maxAgentTimeMs`,
and its coordinator and implementer name admitted harness/model pairs
(`claude` / `anthropic/fable`, `grok` / `xai/grok-4.6`) in `.kxm/routes.yaml`.
Driving them spends those harnesses only when they are installed and authenticated.
A missing model is refused; kxm does not substitute an unadmitted default.

When `kxm init` succeeds in an interactive terminal, it offers to install shell
completion for the detected shell. Accepting writes the completion script
under the user config directory, appends one idempotent stanza to the shell
rc file, and, when the kxm bin directory is not already on `PATH`, adds a
`PATH` export. Declining is safe: run `kxm completion install` later, or set
`KXM_SKIP_COMPLETION_PROMPT=1` to suppress the offer. Non-interactive,
`--json`, and `--dry-run` runs never prompt or write shell files.

After the completion offer, an interactive `kxm init` also offers to set up
workflow-guide agents and workflows for the harnesses you have installed and
authenticated. Accepting lists the software-engineering workflows from
[`workflow-guide.md`](workflow-guide.md); pick by number or slug (`all` works
too). kxm keeps a role only when a guide candidate maps to an admitted
harness and model and that harness is authenticated. It writes
`.kxm/agents/<role>.yaml` (`kxm.agent.v1`), `.kxm/workflows/<slug>.yaml`
(`kxm.workflow.v1`), and appends those selectors to `.kxm/routes.yaml`.
Google candidates use the Pi `antigravity` provider. Unmapped research ids,
including ones whose harness is logged in, are skipped. It never writes
retired legacy authority (`.kxm/config`, retired `.kxm/roster.json`) or the
trusted `.kxm/roster.yaml` policy. Guide candidates are dated research —
verify them before dispatch. Declining is safe: set
`KXM_SKIP_GUIDE_SETUP_PROMPT=1` to suppress the offer.

## 3. Start the hub in another terminal

`kxm hub start` is foreground. Keep that terminal running. The Pi extension
can also start the hub for you (`hub.autoStart: background`, the default in
`kxm.config.v1`): on load it reuses a healthy bound hub or a live local claim
and starts a detached wrapper only when none exists.

PowerShell:

```powershell
$env:KXM_AUTH_TOKEN = "replace-with-an-admin-token"
$env:KXM_PROJECT_TOKENS = '{"demo":"replace-with-a-demo-project-token"}'
kxm hub start
```

Bash:

```bash
export KXM_AUTH_TOKEN="replace-with-an-admin-token"
export KXM_PROJECT_TOKENS='{"demo":"replace-with-a-demo-project-token"}'
kxm hub start
```

A successful start prints:

```text
kxm hub listening at http://127.0.0.1:7331; storage=<workspace>/.kxm/state/kxm.db
```

The default database survives hub restarts and is ignored by Git.

## 4. Bind this machine to the hub

```text
kxm hub bind http://127.0.0.1:7331
```

## 5. Confirm the session

```text
kxm session brief
```

## 6. Open Pi and check the hub

Set an identity and start the first agent. Do not give agents the administrative token.

PowerShell:

```powershell
$env:KXM_SERVER_URL = "http://127.0.0.1:7331"
$env:KXM_AUTH_TOKEN = "replace-with-a-demo-project-token"
$env:KXM_PROJECT = "demo"
$env:KXM_AGENT_NAME = "planner"
$env:KXM_AGENT_PURPOSE = "Plans work and coordinates handoffs"
pi
```

Bash:

```bash
export KXM_SERVER_URL=http://127.0.0.1:7331
export KXM_AUTH_TOKEN="replace-with-a-demo-project-token"
export KXM_PROJECT=demo
export KXM_AGENT_NAME=planner
export KXM_AGENT_PURPOSE="Plans work and coordinates handoffs"
pi
```

In Pi, run `/kxm hub`. It should show the connected identity and server.

Open a second terminal, repeat the settings, and change only the identity:

```powershell
$env:KXM_AGENT_NAME = "reviewer"
$env:KXM_AGENT_PURPOSE = "Reviews plans and code for correctness risks"
pi
```

Ask the planner:

```text
Use the kxm skill. List peers, ask reviewer to examine the current
plan for its three highest correctness risks, and wait for the response.
```

The planner should call `kxm_list`, `kxm_send`, and `kxm_await`. The reviewer receives an agent turn and its settled response returns to the planner.

For an executable transport-only demonstration, run `npm run example`. It starts a temporary in-memory hub, completes a planner-to-reviewer round trip, and exits without changing the normal database.

## Connect Claude Code

Keep the same hub running. Inside Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add kontextmind/kxm
/plugin install kxm
/reload-plugins
```

Configure these values when prompted:

| Setting | Example |
|---|---|
| KXM server URL | `http://127.0.0.1:7331` |
| Authentication token | The `demo` project token, not the administrative token |
| Agent name | `claude-reviewer` |
| Agent purpose | `Reviews implementation and tests` |
| Project | `demo` |

Restart Claude Code after configuration. Ask it to use `kxm_list`; the connected Pi agents should appear.

### Optional pushed delivery

Claude channels can inject an inbound request into a running session. They are currently a research-preview feature, and a community channel must be explicitly trusted at launch:

```text
claude --dangerously-load-development-channels plugin:kxm
```

Review the trust prompt before accepting it. If an organization administrator has approved the plugin through `allowedChannelPlugins`, use:

```text
claude --channels plugin:kxm
```

Without channel mode, Claude can still send requests and receive them by calling `kxm_inbox`, then answer with `kxm_reply`.

## Your first useful topology

Start with two or three purposeful roles:

| Role | Good responsibilities |
|---|---|
| Planner | Break down work, define ownership, collect results |
| Builder | Implement one bounded change |
| Reviewer | Check correctness, tests, security, or documentation |

Avoid assigning two agents to edit the same files in one checkout. Use separate Git worktrees or give one agent write ownership.

## Next steps

- Use the wiki-ready [KXM Handbook](kxm-handbook.md) for the complete CLI, Pi, Claude, workflow, gate, and recovery reference.
- Adjust names, project isolation, and network settings in [Configuration](configuration.md).
- Learn the request lifecycle in [Architecture](architecture.md).
- Read [Operations](operations.md) before binding beyond localhost.
- Review the [Test matrix](test-matrix.md) for verified features and example coverage.
- Start a long-lived coordinator from Jira with [Webhook workflows](webhook-workflows.md).
- Use [Troubleshooting](troubleshooting.md) if an agent does not appear or a request does not arrive.

## Try the v0.5 context features

With a hub running (`kxm hub start`):

```bash
# Role-aware context packet for the current project
kxm context get my-project --role planner --task "plan the CI migration" --budget 8192

# Search durable context records (metadata only)
kxm context recall my-project --query "flaky"

# Explain evidence and lineage for one context item
kxm context explain my-project ctx_item_abc123

# Authoritative temporal state (and historical queries)
kxm context state my-project ci.pipeline
kxm context state my-project ci.pipeline --as-of 2026-01-15T00:00:00.000Z

# Episodic learning from workflow journals
kxm context episode my-project

# Compile the knowledge wiki. Without --out this is a dry run and writes nothing.
kxm context wiki-compile my-project
kxm context wiki-compile my-project --out .
kxm context wiki-lint my-project

# Routing telemetry per behavioral configuration. A missing cost stays unknown.
kxm routing report

# Stamp the local list-price file as today's estimate. This does not fetch vendor rates.
# Until you do, cost estimates stay unknown.
kxm prices acknowledge
```

State changes follow a propose-then-promote flow: agents propose through the
`kxm_promote` Pi/MCP tool (or the context API), and an operator promotes with
durable evidence:

```bash
kxm context promote my-project ctx_prop_abc123 --evidence "receipt:run_9/verify"
```

Role-aware packets differ by role: repro agents see prior reproductions and
incidents; planners see current state and decisions; critics see
contradictions; implementers see the approved plan and skills; verifiers see
acceptance evidence. The same requests through Pi (`kxm_context`) or Claude
Code (MCP) return the same packets — agents never talk to a memory backend
directly.
