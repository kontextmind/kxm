---
schema: "kxm.doc.v1"
id: "RESEARCH-RUNTIME-LANGUAGES"
type: "architecture"
title: "Where uv-managed Python and Rust could improve KXM"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-14"
updated: "2026-09-21"
authority: "hypothesis"
confidence: "uncertain"
summary: "Evidence-led choices for TS orchestration, optional Python tooling and bounded Rust helpers within the unified milestones."
tags: ["research", "setup", "python", "uv", "rust"]
related:
  - implementation-plan.md
  - plan-unified-kxm-milestones.md
  - research-harness-streaming-capabilities.md
  - research-additional-forks.md
  - research-kxm-harness-strategy.md
  - research-memory-studio-forks.md
depends_on: []
blocked_by: []
details:
  baseline_commit: "5ff9f642e82d7a1e52aeab9245282d89560bb535"
  delivery_status: "investigation"
---

# Where uv-managed Python and Rust could improve KXM

## Recommendation

Keep TypeScript as KXM's shared application and integration layer. Investigate
**uv-managed Python for document extraction, OCR and specialist data processing**,
and **Rust for search and narrowly scoped operating-system helpers**. Admit an
additional implementation when it demonstrates a useful capability, a correctness
improvement, or a material measured performance benefit after distribution cost.
There is currently no evidence justifying a wholesale KXM rewrite.

uv is a Python package/project and interpreter manager, itself written in Rust.
It can simplify Python installation and dependency isolation; it does not replace
npm or make Python application code intrinsically faster.
[uv overview](https://docs.astral.sh/uv/).

This investigation supplies technical evidence for the
[unified M0–M9 plan](plan-unified-kxm-milestones.md), the single proposed scope
and sequence. The [implementation plan](implementation-plan.md) alone records
decisions, execution status, accountable owners and phase-gate acceptance.
The operator requested the investigation, not a language migration. Recommendations
and trial thresholds below are proposed; no runtime or dependency was changed.

## What the inspected code tells us

This source inspection retains its historical `5ff9f642` baseline. Current KXM
is `02aaed31`; A1 has accepted bounded async product probes, escalation after
child close, conservative descendant settlement, redacted v2 process evidence
and supervisor rejection handling. Preserve these repairs and measure the current
path. Remaining live permission and broader HTTP lifetime witnesses stay open in
[Tracking](implementation-plan.md). A retained synchronous compatibility/helper
function is not evidence that the repaired product path still blocks.

| Observed KXM surface | Implication for this decision |
|---|---|
| [package.json](../package.json) publishes CLI, core, Runtime, client, extension and MCP exports; Node range is `^22.19.0` or `>=24.0.0` | TS already serves the one-install goal and the Pi host contract |
| [build-runtime.mjs](../scripts/build-runtime.mjs) bundles TS with esbuild and generates host artifacts | Keep the existing build/distribution owners; adding Python does not simplify this pipeline automatically |
| [package-install.test.ts](../test/core/package-install.test.ts) exercises actual package consumers | Expand installed-package tests to optional helpers rather than replace existing npm setup |
| [vnext-oneshot-process.ts](../plugins/kxm/src/oneshot-process.ts) uses asynchronous spawn, buffers output to settlement and closes initial stdin | Live progress first needs incremental decoding and backpressure; a language change is not required to expose the bytes |
| The historical [vnext-harness.ts](../plugins/kxm/src/harness.ts) and [ssh-remote.ts](../plugins/kxm/src/ssh-remote.ts) contain synchronous process calls; current A1 routes product inventory through bounded async probes | Profile the actual current call path and remaining SSH work before attributing stalls to JavaScript; do not reopen repaired product probes based on a retained helper |
| [sqlite.ts](../plugins/kxm/src/sqlite.ts) wraps native `node:sqlite` or `bun:sqlite` | The database engine is already native; porting its wrapper does not automatically accelerate queries or fix ownership |
| Snapshot search found no `.py`, `.rs`, `pyproject.toml` or `Cargo.toml` files; no Python/uv/Cargo invocation in product TS/JS sources | There is no existing KXM Python environment to consolidate today; a new runtime introduces new support work |
| Audited FFF contains a Rust engine plus Node/Bun bindings and native release packaging | Evaluate reuse behind KXM's search API before writing a new Rust engine or installing another Pi extension |

The FFF source is pinned in the [fork register](evidence/unified-kxm-forks.json).
Its [native finder implementation](https://github.com/kontextmind/fff/blob/c3f2c7f21ce6e528a320313e04d101a9dd4be833/packages/fff-node/src/finder.ts)
and [release packaging](https://github.com/kontextmind/fff/blob/c3f2c7f21ce6e528a320313e04d101a9dd4be833/.github/workflows/release.yaml)
show a reuse candidate, not measured speed or installation success in KXM.

An actual setup failure during the preceding planning work selected system Node
18 for documentation lint; selecting the intended executable fixed it. The new
probe resolves that intended remote Node as **26.8.1**, not 24. This supports
recording executable identity and supported versions in M1. Rewriting the
launcher in another language would not automatically fix PATH ambiguity.

## Tool availability observed

| Host | Node | uv | Python | Rust compiler/Cargo |
|---|---|---|---|---|
| Local Windows | 22.21.0 | 0.12.6 | 3.14.3 | Not resolved by the command discovery used |
| kxm-dev Linux | 26.8.1 on explicit local-bin PATH | 0.12.7 | 3.12.3 system Python | Not found on the probed PATH |

These are observations, not supported-version decisions. Python versions differ,
which is a concrete reason to pin the interpreter for any future Python component.
uv is already available for an isolated trial on both hosts. Rust compiler
availability is a contributor/build concern; shipped helpers should not require
users to install a compiler. Absence on this PATH does not establish absence
everywhere. See [probe and planning evidence](evidence/runtime-language-observations.json).

## Component decisions

| Area | Preferred starting point | When another language earns adoption | Cost/limit |
|---|---|---|---|
| npm installation, init, mode activation, host registration | TS and existing package | No demonstrated replacement need | uv would add Python tooling without removing Node/Pi requirements |
| Harness handoffs, JSONL/SSE, MCP, channels, browser HTTP/CDP | TS async I/O and bounded parsing | Rust only after measured CPU/memory or OS-control constraint | Protocol correctness, permissions and recovery remain necessary in either language |
| Repository search and indexing | Evaluate pinned existing Rust-backed engine/tool behind KXM | Same scope/completeness with useful latency or index features | Native artifacts, watcher lifecycle, platform matrix and license obligations |
| Process-tree ownership and cancellation | Existing Node route plus concrete OS tests | Small Rust helper if stronger OS APIs close a witnessed correctness gap | Requires OS-specific implementation; Rust alone is not containment |
| PDF/OCR/document ingestion and specialist analytics | Compare existing JS/external-tool route with Python worker | Better output coverage/quality or substantially less integration work on a fixed corpus | Interpreter, wheels, models and external libraries can dominate install size |
| Markdown UI, forms, preview and browser automation | Existing TS/browser tooling | Python for a specific conversion/extraction task, not the surrounding UI | Python does not remove Pandoc/Chromium or other external prerequisites |
| Memory authority, workflow policy, SQLite ownership | Existing TS owners and schema contracts | Optimize measured queries, batching and isolation first | Another DB writer or policy implementation creates reconciliation work |
| Stream filtering, redaction and large-corpus transforms | Bounded TS implementation, pooled workers if CPU-bound | Rust only for a measured bottleneck with identical semantic tests | Streaming secrets and Unicode boundaries remain hard regardless of language |

Node documents async child processes and worker threads for CPU-heavy JavaScript;
workers generally do not improve I/O-heavy work. Our inference is to measure
KXM's process/stream path before adding native codecs. Modern Node documentation
also contains newer APIs: use only APIs verified on KXM's minimum supported
runtime. [Node child processes](https://nodejs.org/api/child_process.html),
[Node worker threads](https://nodejs.org/api/worker_threads.html).

## Python with uv: where it helps

### KXM-managed optional environments

For a qualifying document/ingest component, maintain its own `pyproject.toml`,
`uv.lock`, interpreter version and tests. Place the installed environment in
KXM-managed application data, outside the user's repository and virtualenv.
Identify it by component version, platform, interpreter and lock hash. Ordinary
KXM installation and non-Python capabilities remain usable when it is absent.

Setup is explicit through KXM's readiness flow. During setup, validate the lock,
sync only runtime dependencies, run a health check, record the installed identity
and activate the component atomically. Ordinary tasks use the prepared interpreter
directly or a validated no-sync invocation; they must not resolve dependencies or
download an interpreter unexpectedly. An unavailable component returns a typed
readiness reason. Updates and repair rebuild a new environment before switching;
rollback verifies the old lock and artifact identity before reactivation.

uv supports locking and environment synchronization. `--locked` rejects a stale
lock, while `--frozen` skips its freshness check; they are not equivalent. Its
default exact sync can remove packages outside the lock, so only operate on
KXM-owned environments. Do not rely on `--no-sync` without readiness validation.
[uv locking and syncing](https://docs.astral.sh/uv/concepts/projects/sync/).

Interpreter pinning can use uv-managed Python, subject to platform availability.
uv obtains managed CPython builds from `python-build-standalone`; verify the
selected build and any behavior differences in the supported platform tests.
Python package locks do not pin external OCR engines, browser binaries or model
weights: those require their own version/hash and readiness records.
[uv Python versions](https://docs.astral.sh/uv/concepts/python-versions/).

### uvx versus a locked component

`uvx` is convenient for isolated command-line tools and developer experiments.
For a production KXM component, a top-level tool version alone does not provide
the complete dependency/interpreter identity we need. Prefer a locked environment.
Avoid unversioned tool execution: tool resolution and cached versions can differ
across machines or after cache cleanup.
[uv tool environments and version selection](https://docs.astral.sh/uv/concepts/tools/).

### What would justify Python

Use a bounded corpus of real document formats and a fixed extraction contract:
text sections, tables, metadata, provenance and failure status. Compare output
quality, unsupported formats, integration effort, cold setup size/time, warm
latency and maintenance. A Python library's useful functionality can justify the
component even when it is slower than JS; benchmark its entire pipeline, including
native dependencies and model files. No library or OCR package is selected here.

Avoid moving setup/config scripts, OAuth HTTP calls or streaming orchestration to
Python merely to use uv. They currently share types and owners with the TS core.

## Rust: where it helps

### Search and bounded CPU-heavy work

Begin with the audited FFF implementation or an existing suitable search binary.
Reusing a Rust-backed tool is a backend/distribution decision; it does not require
KXM to become a Rust project. Compare correct complete searches, negative queries,
initial indexing, warm queries, changed-file updates, memory and shutdown.
Keep root authorization, symlink rules, index scope and incomplete-result handling
inside the same service contract. Do not port an efficient native engine back to
TS just for language uniformity.

For an original helper, prefer a separately launched versioned executable first.
It separates native crashes from the hub and avoids immediately taking on an
in-process Node/Bun binding contract. It adds spawn and serialization costs;
measure them. If FFF's existing binding is the strongest route, test it explicitly
on both host runtimes before choosing it. Do not wrap a library as a nonexistent
CLI without accounting for that development work.

### OS process supervision

The strongest correctness candidate is a small helper that creates and owns a
process group/job with a clear lifetime, rather than rewriting the entire hub.
Test grandchildren, ignored termination, abrupt parent exit and detached children.
On Windows, Job Objects provide group management and termination, subject to
nesting/breakaway behavior. They do not by themselves restrict all filesystem or
network access. On Linux, distinguish process-group cleanup from stronger
containment and assess the required OS facilities separately.
[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

A language change alone does not grant privileges, prevent escape or reconcile
an external browser/network action. The helper must retain truthful unknown
effects and all Phase 11 admission requirements. A passing throughput benchmark
cannot waive these correctness tests.

### Distribution is part of the implementation

Build and test specific OS/architecture/libc targets, publish verified artifacts,
retain notices and provide an explicit unsupported-platform result. A Rust target
being supported upstream does not prove KXM's dependencies work on it. Avoid
source compilation on end-user installation or task startup. Pin the compiler
and `Cargo.lock` for an original helper; locked builds protect dependency
resolution, while reproducible artifact identity still needs verification.
[Rust platform support](https://doc.rust-lang.org/rustc/platform-support.html),
[Cargo build options](https://doc.rust-lang.org/cargo/commands/cargo-build.html).

One npm entry point may select KXM-managed platform artifacts. Start with the
Windows/Linux environments already in scope; do not imply macOS/ARM support
without matching release tests. Restore the paused Windows release coverage
before advertising a Windows native component.

## Shared contract and proposed structure

All languages use KXM's existing command authority and durable state owners.
The helper receives a resolved workspace, limited input and request identity,
and returns typed events/artifacts. It cannot independently settle a workflow,
change policy, mutate the authoritative DB or transfer provider credentials.

Extend the M2 transport contract with explicit protocol version, capability
handshake, correlation, bounded framing/backpressure, cancellation, exit and
typed-final semantics where needed. Generate or verify JSON schemas from one
canonical source. Redact before persistence; keep diagnostics separate from
protocol stdout. Use unbuffered/flushed Python output when live events are needed.
Every helper remains subject to KXM supervision and OS effect restrictions.

If an experiment passes, a possible small addition is:

```text
plugins/kxm/src/       existing TS services, policy and host adapters
components/documents/  optional Python source, pyproject.toml, uv.lock, tests
native/process-host/   optional Rust source, Cargo.toml, Cargo.lock, tests
schemas/               shared versioned wire contracts
scripts/               existing build/release owners plus component packaging
```

These are proposed paths, not directories created by this investigation. Do not
create empty components, a new workspace manager or another top-level lockfile
until a trial selects that component. Skills remain bundled KXM resources and
invoke shared capabilities; users do not install language-specific Pi extensions.

## Decision experiments within existing milestones

The matrix specifies technical comparisons, not execution ownership or a second
delivery order. The unified plan selects their scope and sequence; Tracking
records the accountable owners, decisions and acceptance.

| Trial | Unified packet reference | Comparison and evidence | Adoption decision |
|---|---|---|---|
| L1 Runtime/setup identity | M1 | Actual tarball install and repeated setup under ambiguous PATH, missing runtime, offline/prepared cache and failed update | Deterministic executable/version selection and recoverable setup; no new language required |
| L2 Stream/process baseline | M2 | Bounded async Node route; fixed transcript flood, slow readers, UTF-8 splits, concurrent runs, cancellation; record event-loop delay/RSS/p95 forwarding | Retain TS by default; measure M2's proposed 500 ms forwarding target alongside implementation. A miss opens Node profiling, not language adoption; component choices still need their separate evidence |
| L3 Search backend | M5 | Current correct route versus pinned Rust-backed candidate; same corpus, exclusions, completeness and concurrency; cold/warm costs | Proposed performance bar: at least 2x lower p95 query latency with no more than 10% peak RSS regression, or a documented required indexing capability unavailable in baseline |
| L4 Document component | M7/M5 | JS/external baseline versus locked uv/Python route on 30 annotated representative documents, including scans and tables | All required sections/provenance/denial cases pass; at least 95% of agreed extraction assertions and a material coverage or maintenance benefit; compare setup cost before selection |
| L5 Native supervision | M2/Phase 11 | Node cleanup versus OS helper on Windows/Linux; Windows arm waits for canonical resumption or an accepted decision; child/grandchild, immediate exit, ignored signals, parent crash, invalid cwd, inherited jobs | Adopt only for a reproduced lifecycle/containment requirement the baseline cannot meet; zero false stopped/settled claims in the fault corpus |
| L6 Optional-component distribution | M1/M9 | Prepared/unprepared/offline setups, lock drift, interrupted install, artifact tampering, rollback, concurrent setup, removal | No compiler/manual environment assembly for end users; no task-time hidden downloads; unchanged unrelated user configuration |

Thresholds are proposals, not performance claims. Record before measuring: corpus
hash, KXM revision, implementations and dependency versions, machine/OS, sample
count and cold/warm definitions. For timings use at least 30 samples per arm and
report spread; include spawn, serialization and initial setup rather than timing
only the inner algorithm. Report quality and correctness separately from speed.
Choose equal work and complete output; a truncated fast response cannot win.

L3/L4 research can proceed while L2 fixes Node behavior. Rust process correctness
has a separate trigger from streaming throughput. Set cold-download and disk
budgets before each dependency-bearing prototype, after identifying its actual
assets; no credible size/time bound can be promised before that inventory.
Record retain/adopt/reject with an owner and evidence in the canonical tracker.
Revalidate when the relevant CLI, runtime, component, OS target or KXM ownership
contract changes; old benchmark results are not permanent admission.

## Evidence status

### Additional source cases from the expanded fork audit

The [four-fork addendum](research-additional-forks.md) adds concrete examples for
these experiments: Archify uses JS for diagrams; EverOS uses locked Python/uv
for memory; WeKnora combines Go services, a Python reader and Rust AnyDoc;
DSH combines TS with C/Node-API OS facilities and a Python SDK distribution.
These are component-design evidence, not comparative performance results.
Use EverOS for scoped-index/recovery scenarios, WeKnora for L4/L6 parser trials,
Archify as a JS diagram baseline, and DSH for native-interface/platform checks.
KXM's own baseline remains TS with no Python/Rust component introduced here.

### Work completed and still unmeasured

Completed: baseline source inspection, installed tool discovery on both hosts,
primary-document research, and a native Fable planning advisory. No comparative
performance benchmark, document extraction prototype, Python environment sync,
Rust build or native lifecycle witness ran in this investigation. The advisory
is retained with corrections in the evidence file; it is not acceptance review.
Doc/traceability checks cover the plans only. Follow the unified plan's selected
sequence for L1–L6 experiments; these unrun comparisons establish no language
migration requirement or additional release blocker.
