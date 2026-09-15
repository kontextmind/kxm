---
schema: "kxm.doc.v1"
id: "RESEARCH-ADDITIONAL-FORKS"
type: "architecture"
title: "Four additional forks: diagrams, knowledge, memory and DSH"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-14"
updated: "2026-09-15"
authority: "hypothesis"
confidence: "uncertain"
summary: "Incremental review and milestone placement of archify, WeKnora, EverOS and deepseek-harness."
tags: ["fork-audit", "diagrams", "memory", "harnesses"]
related:
  - implementation-plan.md
  - plan-unified-kxm-milestones.md
  - research-harness-streaming-capabilities.md
  - research-runtime-language-choices.md
depends_on: []
blocked_by: []
details:
  baseline_commit: "5ff9f642e82d7a1e52aeab9245282d89560bb535"
  delivery_status: "proposed"
---

# Four additional fork reviews

The inventory observed for this historical batch had **41 repositories, including
29 forks**; the subsequent seven-fork study brings unified review coverage to 36.
Four forks were added after the original 25-repository review. Each received a
separate source review against KXM `5ff9f642`, verified as main at that time. The
original audit artifacts remain unchanged; this addendum carries the new reviews.
No fork was installed, authenticated or executed.

Those inspections and citations retain their original baseline. Current KXM is
`02aaed31`, whose accepted A1 delta includes bounded async product probes,
escalation after child close, conservative descendant settlement, redacted v2
process evidence and supervisor rejection handling. Do not reopen those repairs
from older observations; remaining live permission and broader HTTP lifetime
witnesses stay open in [Tracking](implementation-plan.md).

| Fork | Category | Recommended use in KXM | Packet |
|---|---|---|---|
| [archify](reviews/fork-additions/archify.md) | Diagrams and validated artifacts | Source-bound workflow/architecture views, safe delivery and complete skill packaging | M1, M6, M7, M9 |
| [WeKnora](reviews/fork-additions/WeKnora.md) | Document ingestion, retrieval and wiki | Select bounded parsing/retrieval/provenance mechanisms; evaluate specialist components | M1, M5, M7, M8, M9 |
| [EverOS](reviews/fork-additions/EverOS.md) | Persistent memory and derived indexes | Scoped recall, index reconciliation, explicit readiness and reviewed learning candidates | M1, M5, M6, M9 |
| [deepseek-harness](reviews/fork-additions/deepseek-harness.md) | Native harness and plugin platform | Distinct DSH identity, ACP experiment, KXM MCP/skill registration | M1, M2, M3, M6, M9 |

The [unified plan](plan-unified-kxm-milestones.md) owns the single proposed M0–M9
scope and sequence. This packet supplies source findings and acceptance fixtures,
not an additional priority list, mandatory service stack or language migration.
[Tracking](implementation-plan.md) alone records decisions, execution status,
accountable owners and phase-gate acceptance.

## Source-backed capability findings

### 1. Source-bound diagram artifacts — M7

Use Archify's typed JSON specifications, source-reference verification and
candidate-before-commit delivery to improve KXM's architecture, workflow,
sequence and lifecycle views. Generate semantic diagrams from the current KXM
plan and durable state; preserve stable IDs and revision-bound artifact hashes.
Keep renderer validation, source-reference existence and workflow acceptance
as separate claims. Repair misleading state projection before making it prettier.

**Exit criteria:** failed generation preserves old bytes while reporting the
current failure; changed source/specification invalidates the receipt; failed or
cancelled steps cannot appear passed; browser checks distinguish skipped from
passed; complete companion assets are present in the actual KXM tarball.

The renderer fits the existing JS runtime. Browser export remains an optional
managed prerequisite. Adapt the implementation with selected assets and notices;
do not assume the core MIT license covers all bundled brand marks and fonts.
See the [Archify review](reviews/fork-additions/archify.md).

### 2. Improve recall and ingestion as shared services — M5/M7

EverOS is strongest as a reference for scoped search and reconciling derived
indexes with canonical files. Adopt content-hash-based freshness, deletion
recovery, retry classification and backlog/readiness reporting. Preserve KXM's
source revisions, authority ceilings and reviewed memory/skill promotion.

**Exit criteria:** restart and missed events converge; identical timestamps with
different bytes invalidate the index; nested filters cannot broaden caller
scope; failed providers shrink context truthfully; generated learning stays a
candidate and cannot overwrite approved skills.

EverOS's stock API startup requires LLM configuration, even though narrower
search code can tolerate no LLM. A keyword-only/offline KXM component needs an
explicit composition. Its Python/uv environment and native search dependencies
must be measured rather than adopted as a whole stack.
See the [EverOS review](reviews/fork-additions/EverOS.md).

WeKnora supplies another reference for ingestion, retrieval and source-backed
knowledge. Its mixed Go/Python/Rust design gives the runtime trials actual
component boundaries to inspect. Evaluate document parsing independently of its
whole service deployment; retain KXM's canonical records and governance for wiki
or memory changes. Adapt atomic revision history within the existing proposal
path and retain explicit missing-citation IDs rather than silently dropping them.
Its Python container also requires native tools such as Java/LibreOffice;
uv locking alone does not remove those setup costs. Parser transport streaming is not proof of incremental parsing:
the inspected ReadStream path parses before sending its metadata/results.
See the [WeKnora review](reviews/fork-additions/WeKnora.md).

**Exit criteria:** scope and provenance survive retrieval; cancellation/partial
work has explicit semantics; a parser must demonstrate early progress if that
capability is claimed; optional component readiness includes models, native
assets and external services. No parsing/retrieval backend obtains KXM's native
harness credentials by default.

### 3. Treat DSH as a new verified identity — M1/M2/M3

The fork exposes `@deepseek-ai/dsh` and executable `dsh`. KXM's existing
`deepseek --json` catalog entry is not evidence of compatibility. Do not add an
alias to make those names appear interchangeable. Discovery found neither
executable on the PATHs probed on Windows and kxm-dev; no CLI behavior or
authentication was witnessed here.

DSH's source ACP bridge is the useful candidate: structured committed updates,
workspace-checked session resume and cancellation. Its headless profile prints
final text and emits reasoning to stderr; it is not a substitute JSONL contract.
ACP resume does not promise replay of prior updates, and concurrent prompts are
rejected; live steering is unproven. KXM needs its own durable cursor and must
keep reasoning/private diagnostics out of the default shared stream.

**Exit criteria:** detect the correct package/executable; verify credentials
separately from ACP's no-op authentication method; deny unknown permissions;
reject wrong-workspace resume; prove cancellation and actual event granularity;
register one KXM MCP surface and selected governed skills. Worker admission
remains a Phase 11 decision. See the [DSH review](reviews/fork-additions/deepseek-harness.md).

## Runtime-language implications

The new forks strengthen the case for evaluating components rather than choosing
one language for all of KXM:

- Archify demonstrates a useful diagram capability built in JavaScript.
- EverOS offers a uv/Python memory component, with meaningful environment and
  service-composition costs; it does not establish a Rust rewrite benefit.
- WeKnora includes a locked Python document reader and Rust AnyDoc binding
  alongside Go services. Evaluate those boundaries and packaging in L4/L6.
- DSH remains primarily TS, with C/Node-API OS support and a Python SDK distribution
  route. Its native subsystem is not evidence that it uses Rust, nor that Windows
  has the same isolation implementation as Linux.

Attach these cases to L3 search, L4 document quality, L5 supervision and L6
distribution in the [runtime investigation](research-runtime-language-choices.md).
No performance comparison, install witness or production-runtime selection follows
from source inspection alone.

## Tracking and evidence

The [canonical tracker](implementation-plan.md) records decisions, owners, status
and gates; the [unified plan](plan-unified-kxm-milestones.md) maps all 36 reviewed
forks, including this historical four-fork batch. Each linked
review has pinned source citations on both sides, specific acceptance checks,
setup/runtime implications and license discussion. Source revisions and DSH
discovery are in the plan's evidence directory. Source-link validation verifies
paths/ranges and review coverage; it does not certify every semantic claim or
replace runtime and independent acceptance tests.
