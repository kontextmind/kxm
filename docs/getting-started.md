# Getting started

This guide takes you from a clean machine to a successful peer request. Allow about ten minutes once Node.js, Git, and your agent harnesses are installed.

## Before you begin

You need:

- Node.js 22.6 or newer;
- Git;
- Pi for Pi agents;
- Claude Code only if you want a mixed Pi/Claude pool;
- access to `kontextmind/pi-extensions` while the repository is private.

All agents in one pool must use the same hub URL, authentication token, and project name. Every active agent in that project must have a unique name.

## Start the hub

Clone the repository and install the locked dependencies:

```powershell
git clone https://github.com/kontextmind/pi-extensions.git
cd pi-extensions
npm ci
$env:PI_MESH_AUTH_TOKEN = "replace-with-a-long-random-token"
npm run hub
```

On macOS or Linux, use:

```bash
export PI_MESH_AUTH_TOKEN="replace-with-a-long-random-token"
npm run hub
```

A successful start prints:

```text
pi-mesh hub listening at http://127.0.0.1:7331; storage=.pi-mesh/mesh.db
```

In another terminal, verify the health endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:7331/health
```

The response should contain `ok: true`. Check `/ready` as well when validating storage readiness. The default database survives hub restarts and is ignored by Git.

## Connect Pi agents

Install the package once:

```text
pi install git:github.com/kontextmind/pi-extensions
```

If the repository is private, authenticate Git before running the install.

Set an identity and start the first agent:

```powershell
$env:PI_MESH_SERVER_URL = "http://127.0.0.1:7331"
$env:PI_MESH_AUTH_TOKEN = "replace-with-a-long-random-token"
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
Use the pi-mesh-comms skill. List peers, ask reviewer to examine the current
plan for its three highest correctness risks, and wait for the response.
```

The planner should call `mesh_list`, `mesh_send`, and `mesh_await`. The reviewer receives an agent turn and its settled response returns to the planner.

For an executable transport-only demonstration, run `npm run example`. It starts a temporary in-memory hub, completes a planner-to-reviewer round trip, and exits without changing the normal database.

## Connect Claude Code

Keep the same hub running. Inside Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add kontextmind/pi-extensions
/plugin install pi-mesh-comms@kontextmind-pi-extensions
/reload-plugins
```

Configure these values when prompted:

| Setting | Example |
|---|---|
| Mesh server URL | `http://127.0.0.1:7331` |
| Authentication token | The same token used by the hub |
| Agent name | `claude-reviewer` |
| Agent purpose | `Reviews implementation and tests` |
| Project | `demo` |

Restart Claude Code after configuration. Ask it to use `mesh_list`; the connected Pi agents should appear.

### Optional pushed delivery

Claude channels can inject an inbound request into a running session. They are currently a research-preview feature, and a community channel must be explicitly trusted at launch:

```text
claude --dangerously-load-development-channels plugin:pi-mesh-comms@kontextmind-pi-extensions
```

Review the trust prompt before accepting it. If an organization administrator has approved the plugin through `allowedChannelPlugins`, use:

```text
claude --channels plugin:pi-mesh-comms@kontextmind-pi-extensions
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

- Adjust names, project isolation, and network settings in [Configuration](configuration.md).
- Learn the request lifecycle in [Architecture](architecture.md).
- Read [Operations](operations.md) before binding beyond localhost.
- Review the [Test matrix](test-matrix.md) for verified features and example coverage.
- Start a long-lived coordinator from Jira with [Webhook workflows](webhook-workflows.md).
- Use [Troubleshooting](troubleshooting.md) if an agent does not appear or a request does not arrive.
