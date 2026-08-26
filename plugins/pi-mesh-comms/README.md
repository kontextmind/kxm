# Pi Mesh Comms

Connect a Claude Code session to running Pi or Claude peers through the Pi Mesh hub.

This directory is both a Claude Code plugin and the source of the repository's Pi extension and shared Agent Skill.

## Requirements

- Node.js 22.13 or newer on the 22.x line, or Node.js 24 or newer;
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
| `mesh_send` | Send one focused request and receive a message ID; attach authorized workflow context when the reply must count as peer evidence |
| `mesh_fanout` | Ask one to three peers independently; local wait expiry returns recoverable pending handles and workflow context supports per-requirement provenance |
| `mesh_get` | Check a request without blocking |
| `mesh_await` | Wait when the reply blocks progress |
| `mesh_cancel` | Cancel pending work owned by this sender |
| `mesh_inbox` | List and reconcile durable inbound requests when pushed channel delivery is unavailable |
| `mesh_reply` | Return a final response to an inbound request |
| `mesh_workflow_list` | List webhook workflows assigned to this coordinator |
| `mesh_workflow_get` | Read stages and the structured workflow journal |
| `mesh_workflow_checkpoint` | Pass a gate with exact keyed evidence and hub-verified peer message references, or record a warning/failure that must be retried |
| `mesh_workflow_wait` | Preserve keyed local evidence and verified peer references, then release the turn until a signed CI, review, merge, or Jira callback arrives |
| `mesh_workflow_record` | Capture a plan, decision, contradiction, error, or lesson |
| `mesh_improvement_report` | Group learning evidence by improvement area |

The bundled `pi-mesh-comms` skill teaches Claude when and how to use these tools safely.

Signed webhooks can create durable workflows for long-lived Pi coordinators. See the repository's [Webhook workflows](../../docs/webhook-workflows.md) guide and Jira development example.

Workflow authors can require replied messages from a snapshotted set of
eligible peer identities. The coordinator supplies exact `workflowContext` on
the send or fanout and later cites returned message IDs in `evidenceRefs`; the
hub derives provenance and counts unique producers. Ordinary evidence strings,
correlation IDs, and idempotency prefixes do not satisfy a peer policy. See
[Peer provenance and quorum gates](../../docs/provenance-gates.md) for the
schema, command-first runbook, explicit admin degradation, retention model, and
trust boundary.

Repository-local configuration, logs, workflow assets, and SQLite state use the `.kxm` workspace layout. Configuration and intentional assets can be tracked; runtime logs, generated assets, and state are ignored. See [Configuration](../../docs/configuration.md) for defaults and overrides.

## Pushed inbound requests

Claude Code channels can inject peer requests into a running session. During the research preview, launch this community channel explicitly:

```text
claude --dangerously-load-development-channels plugin:pi-mesh-comms@kontextmind-pi-extensions
```

Review the trust prompt. If your organization has approved the plugin through `allowedChannelPlugins`, use the normal `--channels` selector instead.

Channel mode is optional. `mesh_inbox` and `mesh_reply` remain available through ordinary MCP.

## Safety and limits

- Peer messages are untrusted input; normal tool and approval controls still apply.
- Peer quorum proves durable provenance within the shared project-token boundary, not truth, model independence, non-collusion, or approval authority.
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
