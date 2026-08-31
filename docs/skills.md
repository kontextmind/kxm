# Skill candidate lifecycle

KXM turns verified episodes and lessons into reusable Agent Skills through a governed lifecycle. Runtime experience never becomes promoted skill content automatically, and promoted skills never grant tool or permission authority.

## Lifecycle

```text
verified episode(s)  →  skill candidate  →  static/provenance review
  →  sandbox execution  →  protected functional + safety eval
  →  promote / quarantine / reject
```

## Storage

```text
.kxm/skills/
├── candidates/<id>/SKILL.md + metadata.json
├── promoted/<id>/SKILL.md + metadata.json
├── quarantined/<id>/SKILL.md + metadata.json
└── history/<id>.jsonl
```

Skill IDs are content-addressed (`<slug>.<hash-prefix>`): changed behavior means changed content means a new candidate. Identical resubmissions are rejected as duplicates.

## Rules

- A candidate must cite at least one source run, journal entry, or evidence receipt.
- Candidate metadata records explicit cross-model/cross-harness compatibility (`harness`, `models`).
- Promotion requires passing `static-review`, `sandbox`, `functional`, and `safety` evaluations, durable evidence references, and a decision by someone other than the author.
- A failed functional or safety evaluation quarantines the candidate automatically; the evaluator records the decision and a human may later reject fully.
- Rejected and quarantined candidates remain queryable in `history/` for future learning.
- Promoted skills are hash-pinned and immutable: `kxm skills verify` detects out-of-band edits (`skill_integrity_violation`), and behavior changes require a new candidate/eval cycle (optionally `supersedes`-linked).
- Skill content is redacted of secret material at creation; evaluation details are redacted and bounded.
- Optimization evaluations (skillopt/WikiSkill-style) are a gated hook, disabled unless explicitly enabled.

## CLI

```text
kxm skills create --file SKILL.md --name <name> --created-by <id> --harness pi --models <models> --run <ids> --journal <ids>
kxm skills evaluate <id> --kind static-review|sandbox|functional|safety --evaluator <version> [--fail]
kxm skills promote <id> --decided-by <id> --evidence <refs>
kxm skills reject <id> --decided-by <id>
kxm skills list --state candidate|promoted|quarantined|rejected
kxm skills verify <id> --state promoted
```
