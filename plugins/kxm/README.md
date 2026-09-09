# KXM

Connect a Claude Code session to running Pi or Claude peers through the KXM hub.

This directory is both a Claude Code plugin and the source of the repository's Pi extension and shared Agent Skill.

## Requirements

- Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer;
- a running KXM hub;
- the same authentication token and project name used by the other agents.

## Install in Claude Code

```text
/plugin marketplace add kontextmind/kxm
/plugin install kxm
/reload-plugins
```

Configure the hub URL, token, unique agent name, purpose, and project when prompted. Then ask Claude to call `kxm_list` to confirm that it can see the expected peers.

## Tools

| Tool | Use |
|---|---|
| `kxm_list` | Discover online peers and their purposes |
| `kxm_send` | Send one focused request and receive a message ID; attach authorized workflow context when the reply must count as peer evidence |
| `kxm_fanout` | Ask one to three peers independently; local wait expiry returns recoverable pending handles and workflow context supports per-requirement provenance |
| `kxm_get` | Check a request without blocking |
| `kxm_await` | Wait when the reply blocks progress |
| `kxm_cancel` | Cancel pending work owned by this sender |
| `kxm_inbox` | List and reconcile durable inbound requests when pushed channel delivery is unavailable |
| `kxm_reply` | Return a final response to an inbound request |
| `kxm_workflow_list` | List webhook workflows assigned to this coordinator |
| `kxm_workflow_get` | Read stages and the structured workflow journal |
| `kxm_workflow_checkpoint` | Pass a gate with exact keyed evidence and hub-verified peer message references, or record a warning/failure that must be retried |
| `kxm_workflow_wait` | Preserve keyed local evidence and verified peer references, then release the turn until a signed CI, review, merge, or Jira callback arrives |
| `kxm_workflow_record` | Capture a plan, decision, contradiction, error, or lesson |
| `kxm_improvement_report` | Group learning evidence by improvement area |

The bundled `kxm` skill teaches Claude when and how to use these tools safely. For the complete KXM Agent Skills suite covering all KXM commands, see the [Agent Skills documentation](../../docs/agent-skills.md).

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
claude --dangerously-load-development-channels plugin:kxm
```

Review the trust prompt. If your organization has approved the plugin through `allowedChannelPlugins`, use the normal `--channels` selector instead.

Channel mode is optional. `kxm_inbox` and `kxm_reply` remain available through ordinary MCP.

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
npm run verify
```

Plugin manifests are validated in CI (`Plugin validation` with pinned
`claude plugin validate`). Commit `dist/mcp-server.js` with the corresponding
source change. The bundle includes the official MCP SDK so marketplace users
do not need a post-install dependency step.

For installation, configuration, every CLI command, Pi session isolation, Claude channel/pull modes, workflows, gates, and recovery, read the wiki-ready [KXM Handbook](../../docs/kxm-handbook.md). The shorter [Getting started](../../docs/getting-started.md) and [Operations](../../docs/operations.md) guides remain task-focused references.
