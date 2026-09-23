# KXM Agent Skills

This document describes the skills bundled in `plugins/kxm/skills`. They
document the existing CLI and MCP tools. They do **not** land unified YAML
role/project/workflow authority, admit new writers, or replace trusted
`.kxm/roster.yaml` policy. For per-command flags, output, and exit codes, see
the [KXM CLI reference](cli-reference.md); skills do not repeat it.

The suite has three groups, all declared in `plugins/kxm/skill-suite.json`:

- 13 KXM command skills that together own every top-level `kxm` command;
- 7 browser automation skills;
- 9 skills for KontextMind, a separate product with its own `kontext` CLI and
  `km_` tools.

## KXM command skills

Each top-level command registered in `plugins/kxm/src/cli.ts` is owned by
exactly one skill. A skill can own several commands, and the `kxm` router owns
none.

| Feature area | Skill | Commands owned | Use it to |
|---|---|---|---|
| Router | `kxm` | none | Pick the right skill or kxm_* tool and follow the universal safety rules |
| Project setup | `kxm-project-setup` | `init`, `trust`, `config`, `completion` | Set up a repository, review permission changes, and run a first workflow |
| Harness and auth | `kxm-harness-auth` | `harness`, `auth`, `update`, `runtime`, `agent`, `models`, `routes`, `ssh` | Check harness auth, update, run the Runtime supervisor, refresh models, admit routes, use SSH and Pi workers |
| Hub operations | `kxm-hub-ops` | `hub`, `backup`, `restore`, `tenant` | Inspect and bind the hub, read tenant status, back up and restore |
| Session | `kxm-session` | `session`, `dash`, `studio` | Read session and hub status and open dashboard or studio screens |
| Peer communication | `kxm-peer` | `peer` | Delegate to, fan out to, await, and answer other agents |
| Workflows and gates | `kxm-workflow` | `workflow`, `gate` | Record journal entries, pass checkpoints, and wait on signed callbacks |
| Definitions | `kxm-definitions` | `role` | Inspect or edit roles, role hosts, and model rosters without granting writer admission |
| Runs | `kxm-runs` | `run`, `runs` | Create, drive, inspect, and cancel runs, or smoke-test a workflow model-free |
| Context and memory | `kxm-context-memory` | `context`, `memory`, `explain` | Recall what the project knows, explain a context footprint, and record memory candidates |
| Skill lifecycle | `kxm-skill-lifecycle` | `skills` | Turn a repeated practice into a governed skill candidate |
| Self-improvement | `kxm-routing-improve` | `routing`, `improve` | Find what KXM learned and what repeats, and read recorded route spend |
| Tasks and goals | `kxm-tasks` | `suggest`, `goal`, `task` | Pick a workflow and plan work as goals and tasks |

## Browser automation skills

KXM includes dedicated skills for remote browser automation on self-hosted Steel (DOKS), exploratory navigation via `agent-browser`, testing with `Playwright`, and visual feedback. They own no `kxm` command. See [Browser Automation Guide](browser-automation.md) and [ADR-0002](adr/ADR-0002-browser-automation-steel-doks.md).

| Feature area | Skill | Purpose |
|---|---|---|
| Browser Sessions | `kxm-browser-session` | Start, attach, inspect, and release Steel sessions on DOKS |
| Human Takeover | `kxm-browser-takeover` | Handoff protocol for MFA, login, CAPTCHA, and sensitive consent |
| Credentials & Profiles | `kxm-browser-auth` | Retrieve credentials from `pass-cli` and manage authenticated profiles safely |
| Exploration | `kxm-browser-explore` | Exploratory navigation, DOM inspection, and workflow mapping via `agent-browser` |
| Reproduction & Verify | `kxm-browser-verify` | Reproduce UI bugs, gather evidence, and author durable Playwright tests |
| Diagnostics & Recovery | `kxm-browser-diagnostics` | Investigate Steel connectivity, CDP errors, timeouts, and orphan cleanup |
| Section Annotation | `kxm-browser-annotate` | Capture DOM sections, attach structured annotations, and feed changes to agents |

## KontextMind knowledge plane (separate product)

These skills teach KontextMind: its `kontext` CLI, its server, and its `km_`
tools. They are not KXM and do not use the plugin's kxm_* tools. Each
description starts with "KontextMind knowledge plane only, the separate
kontext CLI and km_ tools, not KXM" and ends with "Use only when the user names
KontextMind, the kontext CLI, or a km_ tool", so a KXM request never loads
them. They own no `kxm` command. `plugins/kxm/skills/SUITE.md` introduces
them, and `plugins/kxm/skills/hints.json` holds their slash hints.

| Skill | Purpose |
|---|---|
| `kxm-mind` | Route a KontextMind request to the matching knowledge-plane skill |
| `kxm-query` | Search and read a mind with provenance |
| `kxm-harvest` | Draft redacted session learnings into a mind |
| `kxm-triage` | Work the KontextMind review queue |
| `kxm-work` | Read and update tracker work state and handoffs |
| `kxm-insights` | List and dismiss loop, gap, and recommendation insights |
| `kxm-projects` | Manage mind repositories and members |
| `kxm-protocol` | Explain KontextMind contracts, trailers, trust modes, and authorization |
| `kxm-mind-setup` | Connect a machine to a KontextMind server with the `kontext` CLI |

`kxm-mind-setup` was named `kxm-setup` before; the old name has no alias.

## Installation and discovery

### Claude Code

Claude Code loads `plugins/kxm/skills` directly; invoke a skill as
`/kxm:<name>`, for example `/kxm:kxm-project-setup`. The plugin also serves
the kxm_* MCP tools that the skills name.

### Pi

Pi discovers the skills from the `pi` section of the root `package.json`:

```json
{
  "pi": {
    "skills": ["./plugins/kxm/skills"]
  }
}
```

### Codex and other harnesses

`scripts/emit-codex-artifacts.mjs` mirrors every declared skill into
`.agents/skills/`, which Codex reads together with the AGENTS.md command
block. Discovery by other `.agents/skills` consumers remains harness-specific.

## Progressive disclosure

1. Start with the `kxm` router to choose a skill.
2. Use the named skill for that request.
3. Teach only verbs and options that `kxm <group> <verb> --help` prints, and
   confirm a verb by its `Usage:` line.

```bash
kxm peer list --json
kxm peer send --target alice --content "Please review" --json
kxm runs list --json
kxm workflow checkpoint run_123 stage_a passed "Completed stage A" --json
```

## Writing skill descriptions

Skills are model-visible, and the description decides when a harness loads
one.

- Say what the skill does and when to use it, key use case first, in at most
  1024 characters.
- Write a single line that parses as strict YAML. An unquoted value cannot
  contain `': '` anywhere; the strict-YAML test in
  `test/core/skill-suite.test.ts` enforces this for every `SKILL.md`.
- Do not add `allowed-tools`.
- Do not use the retired Mesh product name, `pi-extensions`, or `mcp__`.
- Do not teach `--issue` on token commands, and do not make
  `kxm session brief` an agent step: it saves a 24-hour operator session
  token. List it only under an `## Operator steps` heading.

## Verified vs unverified harness limits

### Verified harnesses

- **Claude Code**: Loads `plugins/kxm/skills` from the installed plugin
- **Pi**: Discovers `plugins/kxm/skills`
- **Codex**: Consumes the generated `.agents/skills` mirror and AGENTS command block

### Unverified harnesses

The following harnesses have discovery claims that remain explicitly unverified:

- **Kimi**: `.agents/skills` consumer capability unverified
- **Copilot**: Integration capability unverified
- **OpenCode**: Compatibility unverified
- **Other `.agents/skills` consumers**: Capabilities unverified

## Bundled skills vs governed skills

### Bundled skills

The skills in this suite ship with the plugin and are maintained in Git as
part of the KXM distribution. Command skills are grouped by task, so one skill
can own several command groups.

### Governed candidates

Separately, `kxm skills` manages community or experimental candidates through
create/evaluate/promote/reject/verify. Those governed skills are distinct from
this bundled suite. Telemetry cannot auto-promote a skill. See
[Skill candidate lifecycle](skills.md) for the full lifecycle, and
[Repository work delivery](skills/repo-work-delivery.md) for converting a
repository request into a delivery prompt.

## Development and maintenance

### Authoring location

Skills are authored in `plugins/kxm/skills/` as the primary source of truth.
Every skill directory must be declared in `plugins/kxm/skill-suite.json`
with `name`, `path`, `ownedCommands`, and a 10-200 character `intent`.

### Generated mirror

`scripts/emit-codex-artifacts.mjs` copies owned skills byte-for-byte to
`.agents/skills/` and leaves unrelated skills in that tree untouched. The
suite manifest `plugins/kxm/skill-suite.json` is required; missing, symlink,
or malformed manifests fail closed.

### Build process

1. Validate `plugins/kxm/skill-suite.json`
2. Replace owned generated skill directories
3. Preserve foreign skills in `.agents/skills/`
4. `scripts/check-generated.mjs` requires every owned mirror path

### Testing

- `test/core/skill-suite.test.ts` checks that every registered top-level
  command has exactly one owner, every skill directory is declared, every
  `SKILL.md` frontmatter parses as strict YAML, the knowledge-plane skills
  stay separate from the command skills, and the mirrors match
- `test/core/commands-policy.test.ts` checks taught verbs against `cli.ts` and
  keeps `kxm session brief` under `## Operator steps`
- `test/core/generated-artifacts.test.ts` checks manifest-backed generated paths
- `test/core/docs-copy.test.ts` scans every Markdown file under
  `plugins/kxm/skills` for removed product names
