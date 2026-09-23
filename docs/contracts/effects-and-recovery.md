# Effects, idempotency, and recovery

> [!IMPORTANT]
> Planned: this contract is the target design. Today only Runtime gate steps record effect intents, observations and settlements, and a gate outcome that cannot be proven blocks the run as `blocked_uncertain`; the effect registry, adapters, receipt queries and leases around external effects are not wired.

KXM provides at-least-once command delivery with effect-aware recovery. It does
not claim exactly-once external execution.

## Effect declaration

Every Runtime-managed tool or adapter declares an effect class in a trusted,
versioned adapter/tool-preset registry. A workflow references the adapter or
preset; it does not declare its own effective class. Model output and workflow
YAML cannot downgrade the registry classification.

A resolved policy stored in an event or delivery manifest has this shape:

```yaml
effect:
  class: external-idempotent
  idempotencyKey: assignment
  receiptQuery: github-pull-request-by-head
  sharedMutable: false
```

Unknown tools and arbitrary shell commands default to `unknown`. A wrapper may
provide a stronger declaration only when it owns both dispatch and deterministic
reconciliation. Registry changes are reviewed permission changes and receive a
pinned `toolPolicyRevision` or `executorPolicyRevision`.

## Classes and automatic behavior

| Class | Examples | Recovery |
|---|---|---|
| `read-only` | Read file, Git status, query API | Retry with bounded policy |
| `workspace-mutation` | Edit isolated worktree, formatter, generated fixture | Inspect and reconcile workspace; do not blindly reapply |
| `external-idempotent` | Put by stable key, push exact commit to unique ref | Query stable key/ref; retry only after confirmed absence |
| `receipt-queryable` | PR by unique head branch, named CI job | Query external system; record found receipt or execute after confirmed absence |
| `unknown` | Arbitrary shell/API/deploy script | Enter `blocked_uncertain` after a lost acknowledgement |
| `external-non-idempotent` | Unkeyed payment, irreversible deployment | Enter `blocked_uncertain`; require evidence or human resolution |

A local filesystem mutation outside the assigned isolated workspace is
`unknown`, even if the command was expected to edit a file.

## Dispatch fence

The Runtime uses this order:

1. Resolve and validate effective permissions.
2. Allocate `assignmentId`, `attemptId`, and effect ID.
3. Compute any deterministic idempotency key.
4. Append the dispatch-intent event.
5. Commit the event transaction.
6. Start the process or external call.
7. Observe completion.
8. Append the result and receipt.
9. Advance the assignment/step only after the result transaction commits.

Crashing before step 6 is safe to restart. Crashing between steps 6 and 8 is
handled according to effect class.

## Crash matrix

| Last durable evidence | Recovery decision |
|---|---|
| Intent recorded; process provably never started | Start same planned attempt or mint a new attempt according to executor contract |
| Exact process/session still alive | Reattach same attempt from its cursor |
| Process ended; workspace state inspectable | Reconcile expected filesystem/Git postcondition |
| Stable external receipt found | Record receipt; do not repeat action |
| Receipt query proves absence | Retry using the same deterministic key where supported |
| Query unavailable, ambiguous, or non-authoritative | `blocked_uncertain` |
| Replacement process already exists | Do not reattach old attempt; reconcile or block |

Provider inference is not evidence that a tool effect did or did not happen.

## `blocked_uncertain`

The state records:

- run, step, assignment, attempt, and effect identities;
- effect classification;
- last durable transition and cursor;
- expected postcondition and receipt query;
- reconciliation attempts and bounded diagnostics;
- permitted resolution actions.

Automatic execution stops only where dependent work could compound the unknown
effect. Independent read-only inspection MAY continue in a separate assignment
if the workflow permits it.

Resolution options:

| Resolution | Required evidence |
|---|---|
| Mark completed | Authoritative receipt or verified postcondition |
| Confirm absent and retry | Authoritative negative query plus new `attemptId` when a process is restarted |
| Compensate then retry | Compensation receipt and workflow-authorized new attempt |
| Mark failed | Audited deterministic or human decision |
| Cancel | Proof no unresolved owned effect remains, otherwise uncertainty remains visible |

A human resolution is an audited control-plane action, not retroactive proof.
The event records actor, reason, supplied references, and resulting action.

## Workspace reconciliation

For isolated workspaces, recovery compares:

- pinned baseline snapshot;
- current manifest and Git index/worktree state;
- expected changed paths or postcondition;
- child process identity and open file/process handles where available;
- produced artifacts and hashes.

KXM applies no patch a second time merely because the prior tool result is
missing. If intent cannot be compared deterministically with state, the effect
is uncertain.

## Git operations

Safe conventions:

- commits include run/assignment provenance in metadata or notes;
- run branches are globally unique;
- pushes target an exact expected object ID;
- receipt queries compare the remote ref to the expected object ID;
- shared branches, tags, merges, and releases require an online lease;
- a force update is never inferred safe from branch uniqueness.

Creating a pull request is queryable only when the adapter uses a deterministic
head branch and can authoritatively find an existing matching request.

## Remote execution

The SSH helper reports a helper generation, process identity, attempt identity,
and monotonic event cursor. Connection loss alone does not create a new attempt.

Reattach only when the same remote helper and process can prove continuity. If
the remote host or helper has been recreated, reconcile workspace and external
receipts before starting a new attempt. An absent remote process does not prove
that an external side effect failed.

## Cancellation

Cancellation is a request followed by supervised settlement:

1. append cancellation intent;
2. stop new dispatches;
3. request graceful child cancellation;
4. wait a bounded drain interval;
5. terminate the owned process group where safe;
6. reconcile in-flight effects;
7. mark cancelled only when no unresolved effect remains.

A run with an unresolved effect remains `blocked_uncertain` rather than being
made cosmetically cancelled.

## Lease failure

A shared mutable operation records lease identity and fencing token with its
dispatch intent. If the lease expires before dispatch, the operation is not
started. If it expires after dispatch, recovery queries the receipt; KXM never
assumes expiry rolled the external action back.

## User interface

The TUI and Pi menu show uncertainty as an attention state with:

- last known operation;
- why automatic recovery is unsafe;
- available reconciliation adapter;
- supplied receipts;
- actions requiring human authorization.

Normal read, workspace, and queryable operations recover automatically. Manual
intervention is reserved for genuinely unprovable effects.
