# Pi Mesh Comms

Connect a Claude Code session to running Pi or Claude peers through the Pi Mesh hub.

This directory is both a Claude Code plugin and the source of the repository's Pi extension and shared Agent Skill.

## Requirements

- Node.js 22.6 or newer;
- a running Pi Mesh hub;
- the same authentication token and project name used by the other agents.

## Install in Claude Code

```text
/plugin marketplace add kontextmind/pi-extensions
/plugin install pi-mesh-comms@kontextmind-pi-extensions
/reload-plugins
```

Configure the hub URL, token, unique agent name, purpose, and project when prompted. Then ask Claude to call `mesh_list` to confirm that it can see the expected peers.

## Tools

| Tool | Use |
|---|---|
| `mesh_list` | Discover online peers and their purposes |
| `mesh_send` | Send one focused request and receive a message ID |
| `mesh_fanout` | Ask one to three peers independently for comparison and synthesis |
| `mesh_get` | Check a request without blocking |
| `mesh_await` | Wait when the reply blocks progress |
| `mesh_cancel` | Cancel pending work owned by this sender |
| `mesh_inbox` | List inbound requests when pushed channel delivery is unavailable |
| `mesh_reply` | Return a final response to an inbound request |
| `mesh_workflow_list` | List webhook workflows assigned to this coordinator |
| `mesh_workflow_get` | Read stages and the structured workflow journal |
| `mesh_workflow_checkpoint` | Pass a gate or record a warning/failure that must be retried |
| `mesh_workflow_record` | Capture a plan, decision, contradiction, error, or lesson |
| `mesh_improvement_report` | Group learning evidence by improvement area |

The bundled `pi-mesh-comms` skill teaches Claude when and how to use these tools safely.

Signed webhooks can create durable workflows for long-lived Pi coordinators. See the repository's [Webhook workflows](../../docs/webhook-workflows.md) guide and Jira development example.

## Pushed inbound requests

Claude Code channels can inject peer requests into a running session. During the research preview, launch this community channel explicitly:

```text
claude --dangerously-load-development-channels plugin:pi-mesh-comms@kontextmind-pi-extensions
```

Review the trust prompt. If your organization has approved the plugin through `allowedChannelPlugins`, use the normal `--channels` selector instead.

Channel mode is optional. `mesh_inbox` and `mesh_reply` remain available through ordinary MCP.

## Safety and limits

- Peer messages are untrusted input; normal tool and approval controls still apply.
- Do not send secrets, credentials, or unnecessary private data.
- The hub persists state in SQLite by default; protect its database as sensitive data.
- Cancellation stops mesh processing but cannot roll back filesystem or external side effects.
- Use separate worktrees or a single-writer rule when peers can edit files.
- Keep the hub on localhost unless it is protected with authentication, TLS, and network controls.

## Development

Edit `src/mcp-server.ts`, not the generated bundle. From the repository root, run:

```powershell
npm run build:mcp
npm run validate:claude
```

Commit `dist/mcp-server.js` with the corresponding source change. The bundle includes the official MCP SDK so marketplace users do not need a post-install dependency step.

For complete setup and operating guidance, read the repository's [Getting started](../../docs/getting-started.md) and [Operations](../../docs/operations.md) guides.
