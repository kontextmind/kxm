# KXM Agent Skills

This document describes the bundled KXM Agent Skills suite: focused skills
that cover current KXM top-level command groups. The suite documents the
existing CLI. It does **not** land unified YAML role/project/workflow
authority, admit new writers, or replace trusted `.kxm/roster.json` policy.

## Feature-to-Skill Matrix

| Feature Area | Skill | Commands Covered | Purpose |
|---|---|---|---|
| Core Routing | `kxm` | — | Select the right suite skill; state universal safety rules and portable CLI convention |
| Project Setup | `kxm-project-setup` | `init`, `migrate`, `trust`, `config`, `completion` | Initialize, migrate, review permission changes, configure, and add shell completion |
| Harness & Auth | `kxm-harness-auth` | `harness`, `auth`, `update`, `runtime`, `agent` | Inspect authenticated harness capability and operate supported runtimes/workers |
| Hub Operations | `kxm-hub-ops` | `hub`, `backup`, `restore` | Run and protect the local hub and its durable SQLite state |
| Session Management | `kxm-session` | `session`, `dash`, `studio` | Resume/inspect operator work and use UI capabilities each harness supports |
| Peer Communication | `kxm-peer` | `peer` | Discover, send, poll/await, cancel, fan out, inbox, and reply safely |
| Workflow Management | `kxm-workflow` | `workflow`, `gate` | Operate webhook workflows, waits/signals, evidence checkpoints, provenance |
| Definitions | `kxm-definitions` | `role` | Manage role YAML through configuration commands; role edits do not grant trusted writer admission |
| Run Management | `kxm-runs` | `run`, `runs` | Create and inspect local vNext runs while preserving execution boundaries |
| Context & Memory | `kxm-context-memory` | `context`, `memory` | Query role-aware context and manage Git-authored memory proposals |
| Skill Lifecycle | `kxm-skill-lifecycle` | `skills` | Govern candidate/evaluate/promote/reject/verify lifecycle |
| Routing & Improve | `kxm-routing-improve` | `routing`, `improve` | Inspect real route quality/cost and propose reviewed improvements |
| Tasks & Goals | `kxm-tasks` | `suggest`, `goal`, `task` | Recommend workflows and manage goals/tasks with SCM/tracker boundaries |

## Installation and Discovery

### For Pi Users

Pi automatically discovers skills in the `pi.skills` section of `package.json`. The KXM skills are included in the standard distribution:

```json
{
  "pi.skills": [
    "./plugins/kxm/skills"
  ]
}
```

### For Claude Users

Claude plugins package the authored skills from `plugins/kxm/skills/` during the build process.

### For Other Harnesses

Skills in `.agents/skills/` follow the standard agent skill format. Discovery
outside Pi and Claude remains harness-specific; do not assume every consumer
loads this mirror.

## Progressive Disclosure Usage

1. Start with the core `kxm` skill to choose a specialized skill.
2. Use the named skill for that command group.
3. Teach only verbs and options that exist in `kxm <group> --help`.

### Example Usage Patterns

```bash
kxm peer list --json
kxm peer send --target alice --content "Please review" --json
kxm workflow list --json
kxm workflow checkpoint run_123 stage_a passed "Completed stage A" --json
```

## Verified vs Unverified Harness Limits

### Verified Harnesses

- **Pi**: Discovers `plugins/kxm/skills`
- **Claude**: Plugin packaging of the authored skills
- **Codex**: Consumes the generated `.agents/skills` mirror and AGENTS command block

### Unverified Harnesses

The following harnesses have discovery claims that remain explicitly unverified:

- **Kimi**: `.agents/skills` consumer capability unverified
- **Copilot**: Integration capability unverified
- **OpenCode**: Compatibility unverified
- **Other `.agents/skills` consumers**: Capabilities unverified

## Distinguishing Operational vs Governed Skills

### Bundled Operational Skills

The skills in this suite (`kxm-*`) are bundled and operational by default. They map 1:1 with KXM's top-level command groups and are maintained as part of the core KXM distribution.

### Governed Candidates

Separately, `kxm skills` manages community or experimental candidates through
create/evaluate/promote/reject/verify. Those governed skills are distinct from
this bundled suite. Telemetry cannot auto-promote a skill. See
[Skill candidate lifecycle](skills.md) for the full lifecycle, and
[Repository work delivery](skills/repo-work-delivery.md) for converting a
repository request into a delivery prompt.

## Development and Maintenance

### Authoring Location

Skills are authored in `plugins/kxm/skills/` as the primary source of truth.

### Generated Mirror

`scripts/emit-codex-artifacts.mjs` copies owned skills byte-for-byte to
`.agents/skills/` and leaves unrelated skills in that tree untouched. The
suite manifest `plugins/kxm/skill-suite.json` is required; missing, symlink,
or malformed manifests fail closed.

### Build Process

1. Validate `plugins/kxm/skill-suite.json`
2. Replace owned generated skill directories
3. Preserve foreign skills in `.agents/skills/`
4. `scripts/check-generated.mjs` requires every owned mirror path

### Testing

- `test/core/skill-suite.test.ts` validates command coverage and mirrors
- `test/core/commands-policy.test.ts` checks taught verbs against `cli.ts`
- `test/core/generated-artifacts.test.ts` checks manifest-backed generated paths
