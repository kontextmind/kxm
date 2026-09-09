---
name: kxm-context-memory
description: Retrieve scoped KXM context, inspect evidence lineage, and record Git memory candidates across supported harnesses. Use for recalling decisions or proposing durable learning; distinguish candidates from approved authoritative state.
---

# KXM Context and Memory

Use KXM's common CLI across supported harnesses. Do not query underlying
memory providers directly or copy credentials into context. Begin with a
small role-aware packet rather than an unbounded history dump.

## Context Commands

| Command | Purpose | Options |
|---|---|---|
| `kxm context get <project>` | Assemble a role-aware packet | Required `--role`, `--task`; optional `--run`, `--stage`, `--budget`, `--kinds` |
| `kxm context recall <project>` | Search durable metadata | `--query`, `--kinds`, `--limit` |
| `kxm context state <project> <key>` | Inspect current or historical state | `--as-of` |
| `kxm context episode <project>` | Inspect learning from workflow journals | `--run` |
| `kxm context explain <project> <itemId>` | Inspect evidence and lineage | `--json` |
| `kxm context promote <project> <proposalId>` | Control-plane promotion of an approved proposal | Required `--evidence <refs>` |

All commands accept `--json`. Use comma-separated kind filters and evidence
references where requested. Verify command-specific `--help` before mutations.
The CLI promotion command is not the same interface as an agent tool that
merely proposes state: never substitute a state key for a proposal ID or
assume that a proposal grants approval.

```bash
kxm context get my-project --role implementer --task "inspect configuration authority" --budget 4000 --json
kxm context recall my-project --query "configuration decisions" --limit 5 --json
kxm context state my-project "configuration.authority" --json
```

## Git Memory Commands

| Command | Purpose | Options |
|---|---|---|
| `kxm memory brief` | Read active project memory facts | `--json` |
| `kxm memory note <fact>` | Record a candidate for reviewed promotion | `--scope`, `--kind`, `--body`, `--json` |
| `kxm memory sync` | Regenerate harness instruction memory projections | `--json` |

Scopes are `agent`, `project`, `run`, or `operator`. Kinds are `decision`,
`architecture`, `convention`, `policy`, or `learning`. Scope and kind labels
never elevate the candidate's authority.

1. Inspect existing context and active memory before recording a duplicate.
2. Record only observed facts, with concise supporting evidence and caveats.
3. Review the generated candidate and Git diff. Promotion requires the
   project's review process; a successful note command is not promotion.
4. Regenerate projections only as an authorized write, inspect their diff,
   and run the existing verification gate.

Do not invent search, save, delete, list, or clear subcommands under memory.
Use context retrieval for discovery and reviewed authored changes for
corrections, respecting provenance and historical records.

## Authority and Safety

- A candidate, recommendation, or learned skill cannot grant tools, admit a
  writer, change a workflow gate, or waive independent review.
- Promotion requires durable evidence and authorized control-plane approval.
  Do not self-approve a proposal merely because you generated it.
- Preserve project/run scope and distinguish hypotheses from verified facts.
- Keep secrets and unrelated private observations out of shared packets.
- Pi, native harnesses, and generated instruction projections consume the
  same KXM policy; none creates a separate authoritative memory store here.
- Wiki compile/ingest is deferred by this project's release policy. Do not
  activate it merely because a CLI entry exists.
