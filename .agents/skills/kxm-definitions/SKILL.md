---
name: kxm-definitions
description: Inspect and edit KXM role YAML, skill references, tool policies, and model rosters across supported harnesses. Use when configuring a role or diagnosing its selected model; role edits do not grant trusted writer admission.
---

# KXM Role Definitions

Use the common KXM CLI for every supported harness. A role identifies work,
references skills, constrains tools, and declares harness/model choices.
A model appearing in a roster is not proof of authentication, capability,
or permission to execute an assignment.

## Inspect Before Editing

```bash
kxm role list --scope all --json
kxm role get writer --scope local --json
kxm role --help
```

Check the effective scope and existing definition before changing it. Current
role commands support global and local scopes; do not assume a local edit
changes every project or the trusted developer runner.

## Supported Commands

| Command | Purpose | Options |
|---|---|---|
| `kxm role list` | List configured roles | `--scope all\|global\|local` |
| `kxm role get <roleId>` | Read role YAML and details | `--scope all\|global\|local` |
| `kxm role add [roleId]` | Add a YAML definition or construct a role | `--file`, `--description`, `--skills`, `--harness`, `--model`, `--scope`, `--overwrite`, `--pick` |
| `kxm role modify [roleId]` | Change description, skill references, or the route roster | `--description`, `--add-skill`, `--remove-skill`, `--add-route <route-id>`, `--remove-route <route-id>`, `--scope`, `--pick` |
| `kxm role remove [roleId]` | Remove a definition | `--scope`, `--pick` |
| `kxm role resume <runId> [ruling]` | Resume an audit-escalated run with an operator directive | `[ruling]` free text |

Use `--json` for structured output. Inspect command-specific `--help` before
constructing a mutation; do not invent `create`, `update`, `delete`, `validate`,
or `apply` subcommands under `kxm role`.

`kxm role resume`
records the operator's ruling on an audit escalation: run it only with the
ruling the user gave you, and preview a KXM run with `--dry-run` first.

## Make an Authorized Change

1. Inspect the existing role and its owning scope.
2. Confirm the requested mutation, particularly removal, overwrite, tool
   expansion, or changes to writer and critic identities.
3. Supply a reviewed YAML definition using `kxm role add --file <path>` or use
   the supported `modify` options. Keep credentials out of role files.
4. Inspect the resulting YAML and Git diff. Validate it through the project's
   existing configuration and verification gates.
5. Before dispatch, require the exact route's admission, harness capability,
   authentication, and applicable tool policy. Never treat a successful file
   edit as successful admission or execution.

## Harness-Neutral Boundaries

- Pi is one harness, not the authority for all model catalogs or permissions.
  Native harnesses retain their own authentication and model discovery.
- A supported one-shot writer is not automatically a long-lived worker.
- Research recommendations are candidates, not grants. Recommendations must
  be grounded in results for the relevant role, not an unverified global list.
- Preserve independent writer/critic vendors and all required review gates.
- Do not copy secrets or host credential files into YAML, prompts, or Git.
- During a configuration cutover, follow the accepted migration plan and stop
  on conflicting authorities; do not silently fall back to legacy settings.

For workflow definitions use `kxm-workflow`; for route capability and
credentials use `kxm-harness-auth`.
