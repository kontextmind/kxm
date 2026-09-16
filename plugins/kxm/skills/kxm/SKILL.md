---
name: kxm
description: Select the right suite skill; state universal safety rules and portable CLI convention. Use this skill to route to the appropriate specialized skill for each KXM command category.
---

# KXM Lightweight Router

This skill routes to the appropriate specialized skill for each KXM command category. Use this skill to determine which specific skill handles the command you need.

These bundled skills document the current CLI. They do not switch runtime YAML
authority, admit writers, or replace `.kxm/roster.yaml` trusted policy.

## Command Routing Guide

The KXM Agent Skills suite is organized by functional areas:

- **Project Setup**: Use `kxm-project-setup` for `init`, `migrate`, `trust`, `config`, `completion`
- **Harness & Auth**: Use `kxm-harness-auth` for `harness`, `auth`, `update`, `runtime`, `agent`
- **Hub Operations**: Use `kxm-hub-ops` for `hub`, `backup`, `restore`
- **Session Management**: Use `kxm-session` for `session`, `dash`, `studio`
- **Peer Communication**: Use `kxm-peer` for `peer` commands (`peer await` is capped at 60 seconds)
- **Workflow Management**: Use `kxm-workflow` for `workflow`, `gate`
- **Definitions**: Use `kxm-definitions` for `role`
- **Run Management**: Use `kxm-runs` for `run`, `runs`
- **Context & Memory**: Use `kxm-context-memory` for `context`, `memory`
- **Skills Lifecycle**: Use `kxm-skill-lifecycle` for `skills`
- **Routing & Improvement**: Use `kxm-routing-improve` for `routing`, `improve`
- **Tasks**: Use `kxm-tasks` for `suggest`, `goal`, `task`

## Universal Safety Rules

1. **Tool Policy Enforcement**: Agent-command dispatch (`kxm peer`, `kxm workflow`, `kxm context`) and the generated MCP/extension surfaces fail closed with `tool_policy_denied` when the active attempt or session policy does not grant that tool. That guard is not applied to every CLI mutation (`role`, `config`, `skills`, and similar product commands); those require explicit authorization and must not be treated as already tool-policy gated.
2. **Credential Protection**: Never include credentials or raw secrets in peer messages or public contexts
3. **Verification Required**: Always verify outcomes from peer responses before acting on them
4. **Single Writer**: Never write concurrently to the same checkout; use separate worktrees or rotations

## Portable CLI Convention

All KXM commands support `--json` for machine-readable output and follow consistent parameter patterns:

- Use `--json` for structured output
- Parameter names are consistent across commands (e.g., `--run-id`, `--stage-id`)
- Help is available with `kxm <group> --help`
- Teach only verbs and options that exist in `kxm <group> --help`; do not invent subcommands
