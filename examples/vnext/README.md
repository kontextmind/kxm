# KXM vNext complete project example

> This is a planned-contract fixture used by configuration loader tests, not a
> workflow activated or executed by the current v0.5 Runtime.

The fixture demonstrates one authoritative project root, two member
repositories, minimal individual resources, bounded dirty snapshots,
provider-tagged models, an ordered workflow with typed back-edges, MOA join
rules, and representative durable records.

```text
examples/vnext/
├── .kxm/
│   ├── project.yaml
│   ├── agents/
│   ├── models/
│   ├── workflows/default.yaml
│   ├── workflows/fix.yaml
│   └── project/env.yaml
├── repositories/
│   ├── api/.kxm/repo/
│   └── web/.kxm/repo/
└── records/
```

Identity for agents, models, and workflows comes from the filename. For
example, `.kxm/agents/reviewer.yaml` defines agent `reviewer`.

The workflow is sequential at the top level:

```text
intake → repro-explore → repro-write → repro-review (MOA)
                              ▲              │
                              └── invalid ───┘
  → plan → critics (MOA) → final-plan → approval
     ▲           │                           │
     └─ invalid ─┘                           ▼
  → implement → local-verify → delivery → CI/review wait → ready
        ▲              │                             │
        └── failure ───┴─────────────────────────────┘
```

`default.yaml` is the no-MOA, local-only initial workflow. `fix.yaml` preserves
the current `/fix` controls: an immutable reproduction oracle, approved-plan
hash, required plan hash for mutation/delivery stages, bounded back-edges,
producer policies, delivery receipt, and CI/review wait. The Runtime, not the
coordinator, enforces transition, assignment, provider diversity, timeout, and
join bounds.

`test/contracts-vnext.test.ts` parses every YAML file and validates it plus the
JSON records against `schemas/vnext`. Production loader tests copy the fixture
to temporary control and member Git worktrees because committed fixtures cannot
contain nested `.git` metadata.
