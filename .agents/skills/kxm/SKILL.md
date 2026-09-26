---
name: kxm
description: Entry point for KXM, the kxm CLI and the Claude Code plugin kxm_* MCP tools. Use when the user mentions KXM or kxm, asks which command or kxm_* tool to use, or a task spans setup, hub, peers, workflows, runs, context and memory, or improvement.
---

# KXM router

Pick the skill that owns the request, then follow it. These bundled skills
document the current CLI. They do not switch runtime YAML authority, admit
writers, or replace `.kxm/roster.yaml` trusted policy.

## Route by request

| Request | Skill | Commands owned |
|---|---|---|
| Set up or upgrade a project, onboard, run a first workflow | `kxm-project-setup` | `init`, `trust`, `config`, `completion` |
| Harness installs and auth, updates, the Runtime supervisor, model inventory, route admission, SSH workers, Pi workers | `kxm-harness-auth` | `harness`, `auth`, `update`, `runtime`, `agent`, `models`, `routes`, `ssh` |
| Hub health, binding, tenant status, backup and restore | `kxm-hub-ops` | `hub`, `backup`, `restore`, `tenant` |
| Session status, dashboard screens, studio layout | `kxm-session` | `session`, `dash`, `studio` |
| Delegate to or answer another agent | `kxm-peer` | `peer` (`peer await` is capped at 60 seconds) |
| Work inside a durable workflow run, gates, signed callbacks | `kxm-workflow` | `workflow`, `gate` |
| Role definitions, role hosts, model rosters | `kxm-definitions` | `role` |
| Create, drive, inspect, or cancel a run, use a worktree lane, or land a branch | `kxm-runs` | `run`, `runs`, `lane`, `land` |
| What we know or decided, recall, context footprint, Git memory | `kxm-context-memory` | `context`, `memory`, `explain` |
| Turn a repeated practice into a governed skill | `kxm-skill-lifecycle` | `skills` |
| What KXM learned, repeated asks, recorded route spend | `kxm-routing-improve` | `routing`, `improve` |
| Which workflow fits, goals and tasks | `kxm-tasks` | `suggest`, `goal`, `task` |
| Remote browser sessions, human takeover, exploration, UI verification | `kxm-browser-session`, `kxm-browser-takeover`, `kxm-browser-auth`, `kxm-browser-explore`, `kxm-browser-verify`, `kxm-browser-diagnostics`, `kxm-browser-annotate` | none |
| KontextMind, the separate knowledge plane with its own kontext CLI | `kxm-mind` | none |

## MCP tools

| Tools | Skill |
|---|---|
| `kxm_list`, `kxm_send`, `kxm_get`, `kxm_await`, `kxm_cancel`, `kxm_fanout`, `kxm_inbox`, `kxm_reply` | `kxm-peer` |
| `kxm_workflow_list`, `kxm_workflow_get`, `kxm_workflow_record`, `kxm_workflow_checkpoint`, `kxm_workflow_wait` | `kxm-workflow` |
| `kxm_context`, `kxm_recall`, `kxm_state`, `kxm_episode`, `kxm_promote` | `kxm-context-memory` |
| `kxm_improvement_report` | `kxm-routing-improve` |

## Status

Check hub and session status with `kxm hub view` and `kxm session status`.
Both read only. `kxm hub view` exits 1 when the hub is down.

## Universal Safety Rules

1. **Tool Policy Enforcement**: Agent-command dispatch (`kxm peer`, `kxm workflow`, `kxm context`) and the generated MCP/extension surfaces fail closed with `tool_policy_denied` when the active attempt or session policy does not grant that tool. That guard is not applied to every CLI mutation (`role`, `config`, `skills`, and similar product commands); those require explicit authorization and must not be treated as already tool-policy gated.
2. **Credential Protection**: Never include credentials or raw secrets in peer messages or public contexts
3. **Verification Required**: Always verify outcomes from peer responses before acting on them
4. **Single Writer**: Never write concurrently to the same checkout; use separate worktrees or rotations
5. **User-owned actions**: Credentials, hub start and bind, plugin configuration, and reviewing and committing .kxm permission changes are the user's actions. Ask the user to do them and never commit .kxm changes yourself.

## Portable CLI Convention

- Use `--json` for structured output.
- Flags differ per command; read `kxm <group> <verb> --help`. For example,
  `kxm context get` scopes with `--run` and `--stage`, while
  `kxm workflow checkpoint` uses `--run-id` and `--stage-id`.
- `--help` after an unknown subcommand prints the group's help and exits 0.
  Confirm a verb exists by checking that the `Usage:` line names it.
- Teach only verbs and options that the help prints; do not invent
  subcommands.

## References

- [Hub protocol reference](references/protocol.md): HTTP routes, message
  states, delivery modes, and the trust boundary behind the peer and workflow
  tools.
