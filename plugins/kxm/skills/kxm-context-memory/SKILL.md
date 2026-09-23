---
name: kxm-context-memory
description: Retrieve role-aware KXM context and record Git memory candidates with kxm context get, recall, state, episode and explain (MCP kxm_context, kxm_recall, kxm_state, kxm_episode), propose a state change with kxm_promote, check a mode's context footprint with kxm explain, and note or sync project memory. Promoting an approved proposal with kxm context promote is an operator action. Use when asked what we know or decided, to recall prior runs or lessons, to explain why an item is in a packet, or to record a durable learning.
---

# KXM context and memory

Use KXM's common CLI or MCP tools across supported harnesses. Do not query
underlying memory providers directly or copy credentials into context. Begin
with a small role-aware packet rather than an unbounded history dump.

## Context commands

| Command | Purpose | Options |
|---|---|---|
| `kxm context get <project>` | Assemble a role-aware packet | Required `--role`, `--task`; optional `--run`, `--stage`, `--budget`, `--kinds` |
| `kxm context recall <project>` | Search durable context records (metadata only) | `--query`, `--kinds`, `--limit` (1-100) |
| `kxm context state <project> <key>` | Current or historical value of one state key | `--as-of <iso>` |
| `kxm context episode <project>` | Episodic learning from workflow journals | `--run` |
| `kxm context explain <project> <itemId>` | Evidence and lineage behind one context item | `--json` |

All commands accept `--json`. Use comma-separated kind filters. The `context`
commands need a reachable hub: check `kxm hub view` first, because they exit 1
with a stack trace and no JSON when the hub is down.

## CLI and MCP

| CLI | MCP tool | MCP arguments |
|---|---|---|
| `kxm context get` | `kxm_context` | `role`, `task`, `workflowRunId`, `stageId`, `budgetTokens`, `includeKinds` (`evidence`, `state`, `episode`, `knowledge`, `skill`) |
| `kxm context recall` | `kxm_recall` | `query`, `kinds`, `limit` (1-100) |
| `kxm context state` | `kxm_state` | `key`, `asOf` |
| `kxm context episode` | `kxm_episode` | `workflowRunId` |
| none | `kxm_promote` | Proposes a state change only (`key`, `summary`, `authority`, `confidence`, `evidenceRefs`) |

Packets and recall are ranked deterministically, without a model. `context get`
orders eligible items by contradiction, project before shared defaults, task
match, role kind, lexical relevance to `--task`, confidence, authority and
recency, fills the budget first-fit, and reports numeric `audit.relevance`.
`context recall` returns whole-query matches first, then items sharing a query
word by relevance, then id, each with a numeric `relevance` and never a
summary. Write a specific `--task` or `--query`: the words drive the ranking.

```bash
kxm context get my-project --role implementer --task "inspect configuration authority" --budget 4000 --json
kxm context recall my-project --query "configuration decisions" --limit 5 --json
kxm context state my-project "configuration.authority" --json
kxm context explain my-project ctx_123 --json
```

## Context footprint

`kxm explain [--mode coder|planner|auditor|browser] [--domains <list>] [--model <id>]`
estimates the prompt footprint and per-turn cost of a workflow mode before a
run. It reads only; costs stay unknown when the price catalog is missing.

```bash
kxm explain --mode planner --model claude/fable --json
```

## Git memory commands

| Command | Purpose | Options |
|---|---|---|
| `kxm memory brief` | Read active project memory facts | `--json` |
| `kxm memory note <fact>` | Record a candidate for reviewed promotion | `--scope`, `--kind`, `--body`, `--json` |
| `kxm memory sync` | Regenerate the memory block in existing `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | `--json` |

Scopes are `agent`, `project`, `run`, or `operator`. Kinds are `decision`,
`architecture`, `convention`, `policy`, or `learning`. Scope and kind labels
never elevate the candidate's authority.

1. Inspect existing context and active memory before recording a duplicate.
2. Record only observed facts, with concise supporting evidence and caveats.
3. Review the generated candidate and Git diff. Promotion requires the
   project's review process; a successful note command is not promotion.
4. Regenerate projections only as an authorized write, inspect their diff,
   and run the existing verification gate.

`kxm memory sync` rewrites only the text between `<!-- kxm:memory:start -->`
and `<!-- kxm:memory:end -->` (appending that block when a file has none) and
never creates an instruction file. If the project has none of the three, sync
refuses; create the file your harness reads yourself rather than expecting KXM
to author it.

Do not invent search, save, delete, list, or clear subcommands under memory.
Use context retrieval for discovery and reviewed authored changes for
corrections, respecting provenance and historical records.

## Authority and safety

- `kxm_promote` only proposes a state change. The proposal is not approval,
  and a state key is never a proposal ID.
- A candidate, recommendation, or learned skill cannot grant tools, admit a
  writer, change a workflow gate, or waive independent review.
- Do not self-approve a proposal merely because you generated it.
- Preserve project/run scope and distinguish hypotheses from verified facts.
- Keep secrets and unrelated private observations out of shared packets.
- Pi, native harnesses, and generated instruction projections consume the
  same KXM policy; none creates a separate authoritative memory store here.
- `kxm run` agents receive only committed, pinned memory (project or operator
  scope) and hash-verified promoted skills. Uncommitted or changed memory is
  withheld with a `dispatch_context_*` gap until it is committed and a new run
  pins it; a successful `memory note` does not reach a dispatched agent.
- Wiki compile/ingest is deferred by this project's release policy. Do not
  activate it merely because a CLI entry exists.

## Operator steps

Promotion is a control-plane decision that belongs to the user or another
authorized approver, not to the agent that proposed it.

| Command | Purpose | Options |
|---|---|---|
| `kxm context promote <project> <proposalId>` | Promote an approved state proposal | Required `--evidence <refs>` |
