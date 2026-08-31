# Getting started

This guide takes you from a clean machine to a successful peer request. Allow about ten minutes once Node.js, Git, and your agent harnesses are installed.

## Before you begin

You need:

- Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer;
- Git;
- GitHub CLI for the command-first release install;
- Pi for Pi agents;
- Claude Code only if you want a mixed Pi/Claude pool;
- access to `kontextmind/pi-extensions` while the repository is private.

All agents in one pool must use the same hub URL, project token, and project name. Keep the hub/operator administrative token separate. Every active agent in that project must have a unique name.

## Install the operator command

Pi's Git package installation supplies the extension and Agent Skill but does
not add `kxm` to `PATH`. For command-first operation, download the packed
release through an authenticated GitHub CLI session and install that local
tarball. Run `gh auth login` first if necessary.

```powershell
$version = "<release-version>"
$asset = "kontextmind-pi-extensions-$version.tgz"
$releaseDir = Join-Path $PWD ".kxm-release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
gh release download "v$version" --repo kontextmind/pi-extensions --pattern $asset --dir $releaseDir --clobber
npm install --global --omit=peer (Join-Path $releaseDir $asset)
kxm mesh help
```

Do not substitute a global `git+https` npm install; the supported global
operator package is the versioned release tarball. To run from source instead,
clone the repository, run `npm ci`, and use `node scripts/kxm.mjs` in place
of `kxm`.

## Start the hub

With the packed operator command installed:

```powershell
$env:PI_MESH_AUTH_TOKEN = "replace-with-an-admin-token"
$env:PI_MESH_PROJECT_TOKENS = '{"demo":"replace-with-a-demo-project-token"}'
kxm mesh hub
```

On macOS or Linux, use:

```bash
export PI_MESH_AUTH_TOKEN="replace-with-an-admin-token"
export PI_MESH_PROJECT_TOKENS='{"demo":"replace-with-a-demo-project-token"}'
kxm mesh hub
```

For the source alternative, start the clone with `npm run hub`.

A successful start prints:

```text
kxm mesh hub listening at http://127.0.0.1:7331; storage=<workspace>/.kxm/state/mesh.db
```

In another terminal, verify the health endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:7331/health
```

The response should contain `ok: true`. Check `/ready` as well when validating storage readiness. The default database survives hub restarts and is ignored by Git.

The additive `kxm` command initializes empty project-owned workspace directories. After adding your reviewed workflow file, validate it without printing secrets:

```powershell
kxm mesh --json init
kxm gate --json validate --file .kxm/config/workflows/product.json
kxm mesh --json status
```

`mesh init` never copies the package repository's dogfood roster or workflows into a consumer workspace.

## Connect Pi agents

Install the package once:

```text
pi install git:github.com/kontextmind/pi-extensions
```

If the repository is private, authenticate Git before running the install.
This step configures Pi only; it does not install the operator command described
above.

Set an identity and start the first agent:

```powershell
$env:PI_MESH_SERVER_URL = "http://127.0.0.1:7331"
$env:PI_MESH_AUTH_TOKEN = "replace-with-a-demo-project-token"
$env:PI_MESH_PROJECT = "demo"
$env:PI_MESH_AGENT_NAME = "planner"
$env:PI_MESH_AGENT_PURPOSE = "Plans work and coordinates handoffs"
pi
```

Open a second terminal, repeat the settings, and change only the identity:

```powershell
$env:PI_MESH_AGENT_NAME = "reviewer"
$env:PI_MESH_AGENT_PURPOSE = "Reviews plans and code for correctness risks"
pi
```

Run `/mesh-status` in either session. It should show the connected identity and server.

Ask the planner:

```text
Use the kxm-mesh skill. List peers, ask reviewer to examine the current
plan for its three highest correctness risks, and wait for the response.
```

The planner should call `mesh_list`, `mesh_send`, and `mesh_await`. The reviewer receives an agent turn and its settled response returns to the planner.

For an executable transport-only demonstration, run `npm run example`. It starts a temporary in-memory hub, completes a planner-to-reviewer round trip, and exits without changing the normal database.

## Connect Claude Code

Keep the same hub running. Inside Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add kontextmind/pi-extensions
/plugin install kxm-mesh@kontextmind-pi-extensions
/reload-plugins
```

Configure these values when prompted:

| Setting | Example |
|---|---|
| Mesh server URL | `http://127.0.0.1:7331` |
| Authentication token | The `demo` project token, not the administrative token |
| Agent name | `claude-reviewer` |
| Agent purpose | `Reviews implementation and tests` |
| Project | `demo` |

Restart Claude Code after configuration. Ask it to use `mesh_list`; the connected Pi agents should appear.

### Optional pushed delivery

Claude channels can inject an inbound request into a running session. They are currently a research-preview feature, and a community channel must be explicitly trusted at launch:

```text
claude --dangerously-load-development-channels plugin:kxm-mesh@kontextmind-pi-extensions
```

Review the trust prompt before accepting it. If an organization administrator has approved the plugin through `allowedChannelPlugins`, use:

```text
claude --channels plugin:kxm-mesh@kontextmind-pi-extensions
```

Without channel mode, Claude can still send requests and receive them by calling `mesh_inbox`, then answer with `mesh_reply`.

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

With a hub running (`kxm mesh hub`):

```bash
# Role-aware context packet for the current project
kxm context get my-project --role planner --task "plan the CI migration" --budget 8192

# Search durable context records (metadata only)
kxm context recall my-project --query "flaky"

# Authoritative temporal state (and historical queries)
kxm context state my-project ci.pipeline
kxm context state my-project ci.pipeline --as-of 2026-01-15T00:00:00.000Z

# Episodic learning from workflow journals
kxm context episode my-project

# Compile and lint the knowledge wiki
kxm context wiki-compile my-project
kxm context wiki-lint my-project

# Routing telemetry per behavioral configuration
kxm routing report
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
