# Assignment runner maintainer guide

> **Status.** The assignment runner (`scripts/assignment-run.mjs`, `just assign`)
> is the developer orchestration policy and verification runner for issue 127.
> It manages native developer assignments, deterministic witness verification,
> and multi-vendor dual-critic acceptance. It is not the runtime workflow
> engine (`kxm run`), an agent RPC worker (`kxm agent worker`), or a Phase 11
> dispatch adapter.

This guide explains how maintainers run, verify, attribute, and accept
assignments, as well as the safety invariants enforced by the developer roster
policy.

---

## 1. Overview and role rotation

Developer orchestration on this runner uses a role-based rotation backed by
trusted policy in [`.kxm/roster.json`](../.kxm/roster.json). Roles, harnesses,
and models are admitted with strict permission and vendor boundaries:

| Role | Admitted route | Vendor | Permission | Purpose |
|---|---|---|---|---|
| **`writer`** | `grok` / `grok-4.6`, `pi` / `openrouter/qwen/qwen3-coder-plus` | `xai`, `alibaba` | `edit` | Native code authoring. Grok is the default rotation; Qwen on Pi is admitted relief. |
| **`planner`** | `claude` / `fable` | `anthropic` | `read-only` | Architectural planning and permission boundaries. |
| **`reviewer-arch`** | `claude` / `fable` | `anthropic` | `read-only` | Architecture, permission, and safety review. |
| **`reviewer-cli`** | `codex` / `gpt-5.6-sol` | `openai` | `read-only` | CLI surface, documentation, and interface review. |

### Core principles

- **Independent critics:** Acceptance requires independent review from
  different providers. The writer and each critic must have distinct canonical
  vendors (`xai` / `alibaba`, `anthropic`, `openai`).
- **Fail-closed dispatch:** Route validation fails closed with `route_invalid` if
  a requested harness/model is not in the admitted role lineup, or if permissions
  exceed the admitted ceiling (e.g. attempting to give edit permissions to a
  read-only reviewer).
- **Deterministic witness beats extra models:** Implementers run `npm run verify`.
  Root re-runs the fixed witness. Reviewers verify candidate trees; they do not
  replace tests.
- **Closed schemas:** `accepted.json` (`kxm.task-accepted.v1`) and
  `completion.json` (`kxm.assignment-completion.v1`) schemas are closed. Do not
  add ad-hoc properties.

---

## 2. The developer loop

The standard progression follows a slim four-step lifecycle:

```text
plan-current ──> assign (writer) ──> witness ──> review (arch + cli) ──> accept
```

Do not run the 13-stage `/fix` workflow for daily developer tasks or docs.

### Step 1: Current plan pointer

Every assignment binds to an explicit plan reference. When working against the
active plan, stamp or update the pointer:

```bash
just plan-current /abs/task-dir /abs/plan.md <sha256> <base-commit> <expected-generation>
```

The pointer is recorded as `plan-current.json` (`kxm.plan-pointer.v1`) in the
task directory.

### Step 2: Dispatch assignment

Create an assignment manifest (`kxm.assignment.v1`) specifying the task id,
assignment id, kind (`implement`, `review-arch`, `review-cli`), admitted route,
clean or staged base commit, and deliverables contract.

Dispatch using:

```bash
just assign /absolute/path/to/manifest.json
```

Under the hood:

```bash
node scripts/assignment-run.mjs run --manifest /absolute/path/to/manifest.json
```

- Manifest validation asserts worktree cleanliness and validates the route
  against `.kxm/roster.json`.
- Headless execution dispatches to the native harness (or OpenRouter via Pi for
  admitted relief).
- Successful runs write `completion.json`, candidate snapshot metadata, and
  private sidecars under the assignment record directory.

### Step 3: Run the verification witness

After the writer completes code changes, execute the fixed verification
witness:

```bash
just witness /absolute/path/to/record-dir
```

Under the hood:

```bash
node scripts/assignment-run.mjs witness --record-dir /absolute/path/to/record-dir
```

The witness executes the fixed gate (`npm run verify`) in the workspace, hashes
the index and worktree states, and records `witness-receipt.json`
(`kxm.assignment-witness.v1`). Acceptance requires a witness receipt with
`result: "passed"`.

### Step 4: Dispatch critics

Dispatch both designated critics against the candidate index tree:

1. **Architecture review (`review-arch`):** Claude Fable (`fable`, read-only).
2. **CLI & docs review (`review-cli`):** Codex Sol (`gpt-5.6-sol`, read-only).

Each review produces its own record directory containing `completion.json` with
a structured critic verdict (`PASS` or `BLOCK`) bound to the reviewed tree.

### Step 5: Acceptance

Once the writer passes the witness, changes are committed to Git, and both
critics have rendered `PASS` verdicts:

```bash
just accept /abs/task-dir <commit-sha> /abs/writer-record /abs/arch-review /abs/cli-review
```

Under the hood:

```bash
node scripts/assignment-run.mjs accept \
  --task-dir /abs/task-dir \
  --commit <commit-sha> \
  --record-dir /abs/writer-record \
  --critic /abs/arch-review \
  --critic /abs/cli-review \
  [--observed-pr <pr-id>] \
  [--observed-ci <ci-id>]
```

`accept` validates all acceptance invariants:

1. The commit exists and its tree matches the witness index tree.
2. The writer record matches the latest passed witness.
3. Both required critic roles (`review-arch` and `review-cli`) are present.
4. Both critics judged the exact accepted tree and issued `PASS`.
5. No unresolved `BLOCK` review exists for the tree in the task directory (unless
   superseded by an unbroken `rework_of` lineage).
6. The writer and all critics satisfy pairwise vendor independence.
7. Writes `accepted.json` (`kxm.task-accepted.v1`) into the task directory.

---

## 3. Attribution and cost tracking

### Private attribution notes

When friction, environment issues, or model regressions occur, record private
handoff notes without altering closed completion schemas:

```bash
just attribute /abs/task-dir /abs/record-dir <class> /abs/note.txt
```

- Allowed classifications: `orchestration`, `model`, `environment`,
  `unclassified`.
- Appends an immutable attribution entry in the task's attribution history.

### Historical cost observation

For manual bootstrap runs or unmetered subscription sessions where native
telemetry was not captured directly:

```bash
just observe-cost /abs/task-dir /abs/observation.json
```

Imports a `kxm.cost-observation.v1` record. Cost observations are strictly
cost-only; they cannot authorize acceptance or mint witness proof.

### Unified change report

Generate a consolidated change and cost summary for a task:

```bash
just change-report /abs/task-dir
```

The change report cleanly separates:

- Provider-reported metered spend vs list price estimates.
- Unmetered subscriptions (e.g. Claude Code or Codex subscription) vs unknown.
- Token counts, elapsed wall time, witness durations, and attempt counts.
- Failed or interrupted attempts (never silently omitted or zeroed).

---

## 4. Safety invariants and failure codes

The runner fails closed with bounded error codes defined in `RUNNER_CODES`:

| Code | Trigger condition | Remedy |
|---|---|---|
| `route_invalid` | Harness/model not admitted in lineup for the requested role, or permission exceeds route ceiling. | Check `.kxm/roster.json` lineup and permissions for the role. |
| `critic_invalid` | Missing required critic role, duplicate roles, wrong model, or vendor collision between writer and critics. | Ensure independent critics (Fable + Sol) from distinct providers. |
| `critic_block` | An unresolved `BLOCK` verdict exists for the target tree. | Rework the changes, address findings, and pass review with a `rework_of` link. |
| `commit_tree_mismatch` | Git commit tree does not equal the witnessed tree. | Commit the exact candidate tree verified by the witness before running accept. |
| `witness_failed` | Fixed gate (`npm run verify`) returned a non-zero exit code. | Fix code, typecheck, lint, or test failures and re-witness. |
| `witness_binding_invalid` | Writer transport incomplete, wrong deliverables boundary, or writer route unadmitted. | Re-run writer assignment through admitted rotation route. |
| `accepted_exists` | `accepted.json` is already present in the task directory. | Acceptance records are immutable; use a new task directory for new units. |

---

## 5. File layout in task directories

A completed task directory contains:

```text
<task-dir>/
├── plan-current.json            # Active plan pointer (kxm.plan-pointer.v1)
├── plan-current.md              # Current plan markdown
├── accepted.json                # Final acceptance proof (kxm.task-accepted.v1)
├── asg-writer-1/                # Writer assignment record directory
│   ├── manifest.json            # Bound input manifest (kxm.assignment.v1)
│   ├── prompt.txt               # Rendered assignment prompt
│   ├── completion.json          # Completion record (kxm.assignment-completion.v1)
│   ├── witness-receipt.json     # Deterministic gate witness receipt
│   └── telemetry.jsonl          # Usage, latency, and cost telemetry
├── asg-review-arch/             # Architecture critic record directory
│   ├── manifest.json
│   └── completion.json          # Contains critic PASS verdict
├── asg-review-cli/              # CLI critic record directory
│   ├── manifest.json
│   └── completion.json          # Contains critic PASS verdict
└── runner-errors.jsonl          # Diagnostic log of bounded failure codes
```
