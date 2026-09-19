---
schema: "kxm.doc.v1"
id: "REVIEW-INTAKE-CONTRACT-ASTRA"
type: "architecture"
title: "Codex gpt-6-astra review of the Runtime intake contract (#248)"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-18"
updated: "2026-09-18"
authority: "hypothesis"
confidence: "uncertain"
summary: "Independent one-shot critic review of the M1+M6 intake contract; verdict BLOCK with five blocking findings, all reproduced or fixed. Critic opinion, not assignment, witness or acceptance proof."
tags: ["review", "runtime", "intake", "harnesses"]
related:
  - ../implementation-plan.md
  - ../../plans/plan-unified-kxm-milestones.md
depends_on: []
blocked_by: []
details:
  reviewed_commit: "709f589f72cda5036b86e55729db43df007236ed"
  diff_base: "review-base-248 (150e914)"
---

# Codex gpt-6-astra review of the Runtime intake contract (#248)

## Transport and admission status — read this first

| Field | Value |
|---|---|
| Harness | Codex CLI `codex-cli 0.153.4`, provider-native OpenAI route |
| Auth | `codex login status` → `Logged in using ChatGPT` (subscription, not API key) |
| Model requested | `gpt-6-astra` |
| Reasoning effort | `high` (set explicitly; the user default `xhigh` was lowered to bound cost) |
| Sandbox | `read-only` |
| Wall time | ~9 min, one-shot, exit 0 |
| Cost | subscription quota — reported spend **unknown**, not zero |

**`gpt-6-astra` is not an admitted reviewer route.** The sanctioned transport
(`scripts/harness-run.mjs`, reached by `just review-cli`) failed closed before any
model call:

```json
{"schema":"kxm.harness-result.v2","ok":false,"status":"failed","stage":"preflight",
 "errorCode":"preflight_failed",
 "error":"codex does not accept model gpt-6-astra; allowed: gpt-5.6-sol"}
```

That unbilled preflight refusal is the intended behaviour and is preserved here as
evidence. The review below was therefore obtained by invoking the Codex CLI
**directly**, read-only, as a bounded one-off experiment — not through the runner,
not as the designated critic, and **not as acceptance evidence**. The designated
Codex critic remains `gpt-5.6-sol`; making `gpt-6-astra` routable needs its own
reviewed admission of the allowlist constant plus tests, which nobody has asked for
yet. Nothing in this record grants tools, waives verification, or substitutes for
the Fable/Sol critics.

## Verdict

**BLOCK.** Five blocking findings; four were confirmed real and fixed, one
(history retention) is a design gap recorded for a reviewed follow-up. No finding
was disputed. **All of it shipped in v0.7.46**, so the released contract carried
these holes until the follow-up.

## Findings and disposition

These are first-pass dispositions. The second-pass section below supersedes any
row marked **Fixed** that later proved partial — read them in that order rather
than treating this table as the current state.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | CONCERN | `database.ts` restore ceiling is still a literal (`5`); round-trip catches an undershoot but not an over-permissive ceiling, and there is no populated v4 fixture | **Partly.** Comment now names the constant it tracks and the e6 pin. Sharing it without an import cycle, plus a populated v4 migration fixture, is ticketed |
| 2 | **BLOCK** | Lost insert race returned the winner as a `duplicate` **without comparing content hashes** — altered content accepted under a used key | **Fixed.** Both the probe path and the read-back path now go through `requireSamePayload`, inside one transaction |
| 3 | **BLOCK** | Pause / ingress / resume were not atomic: `paused=true` read → concurrent resume → insert `held_paused` stranded a row in an unpaused project; a crash between the control write and the release did the same | **Fixed.** Ingress, admission, and control-write-plus-release are each one `eventStore.transaction(...)`. Nesting is now a constraint on the M2 consumer — recorded |
| 4 | **BLOCK** | Resume drained only one 500-row page: the 501st held message stayed `held_paused` forever, contradicting "resume releases held intent" | **Fixed.** Paged drain to exhaustion, pinned by a new 601-message test asserting zero stranded rows |
| 5 | **BLOCK** | Tool ceilings could widen under a valid rebind: lift `deny` entries, change `preset`, drop the `tools` object, or empty an allowlist. The plan's "may never widen … tools" claim was false | **Fixed.** Preset must be identical, `tools` may be neither added nor removed, no denial may be lifted, no new tool allowed. Four refusals pinned by tests. Plan wording corrected |
| 6 | CONCERN | Two processes binding an empty slot: loser threw `coordinator_write_lost` instead of returning the winner; and set order changed the ceiling hash, so an equivalent ceiling looked like a rebind | **Fixed.** Read back the winner and return it when the ceiling matches (conflict only if it differs); `effects`/`allow`/`deny` are stored as sorted, deduplicated sets; repeated members are refused as ambiguous input |
| 7 | CONCERN | Classification is caller-supplied, so "intake cannot become a secret store" overstates it; a retry could relabel a stored plaintext row as `secret` and get it back | **Partly fixed.** `intake_classification_conflict` on a relabelled duplicate. The guarantee is restated honestly as a *storage decision under a trusted classifier*; enforcement for untrusted adapters is ticketed. The plan's overstated clause is corrected |
| 8 | CONCERN | `contextConfigRevision()` hashed `projectId`/`projectRoot`/`homeRuntimeId`, so it was not a configuration revision at all | **Fixed.** `KxmRuntimeContext` now carries the loaded bundle's real `configRevision`; the fallback hash is gone, and a test asserts the coordinator stores the bundle revision |
| 9 | CONCERN | Read-time drift checks omitted identity columns and had no record digest, so payload-only tampering passed | **Partly fixed.** Every duplicated column plus the `schema` column is now cross-checked. Payload-only tampering is still undetected — now asserted as a *known limit* in the test, with a digest column (schema v6) ticketed |
| 10 | CONCERN | Rebinding replaced the row: `rebindOf` could not resolve, in-flight messages referenced a vanished identity, and intermediate ceilings/reasons were erased | **Ticketed.** Needs immutable retained versions plus an active-slot pointer — a table change on a released schema, so it gets its own reviewed slice rather than a quiet edit |
| 11 | CONCERN | `ORDER BY received_at` is text order: `…T00:00:00Z` sorts after `…T00:00:00.100Z`, and ties fell back to random message ids, letting a caller control queue priority | **Fixed differently (better).** Dispatch order is now Runtime arrival order (`rowid`); a test asserts a backdated `now` cannot jump the queue |
| 12 | CONCERN | Seven sequential tests did not establish the advertised guarantees (no concurrency, no >500 drain, no tool-policy removal, no corrupted-record, no populated migration, no actual task creation) | **Partly fixed.** Five tests added (drain, four tool-widening refusals plus a permitted narrowing, canonical hash + real revision, classification conflict + tamper detection, arrival order); task creation is still out of scope because no consumer exists yet. Two-process barriers and the populated v4 fixture remain ticketed. Its note that the derived table-name list is acceptable is retained |
| 13 | CONCERN | Closed objects still allowed contradictions: `secret` without `contentOmittedReason`, non-secret carrying it, and `runId` on non-admitted states; `maxLength` counts characters while ingress promises bytes; `refused` had no producer | **Mostly fixed.** Schema now couples omission reason to `secret` bidirectionally and restricts `runId` to `admitted` by a separate rule; `refused` is documented as reserved for the M2 dispatch-refusal path. The byte bound on read needs the limit shared with the store — ticketed |

## What this changes about the merged claim

`#248` said the contract enforced idempotent ingress, a never-widening ceiling,
held-but-never-lost pause intent, and no persisted secrets. After this review: the
dedupe and pause rules were real only for **sequential** callers and were wrong
under concurrency and beyond 500 rows (now fixed); the tool-ceiling claim was
**false** (now true, with refusals pinned); the secret claim was **overstated**
(now scoped to what it actually guarantees); and coordinator revisions were not
configuration revisions (now they are).

## Standing limitations, deliberately not papered over

- No consumer exists, so "duplicate ingress cannot create another task" is proven
  at the intake boundary only; task creation is the M2 step and must re-prove it
  end to end.
- `transaction(...)` is not reentrant (`runtime_transaction_nested`), so the M2
  dispatch consumer must call these functions at the top level or be folded into
  the same transaction deliberately.
- Records carry no digest column; payload-only offline tampering is undetectable
  until schema v6.
- Rebind still replaces the active row; identity history is not retained.
- Classification remains caller-asserted.

## Second pass — the same critic reviewed the fix

The follow-up run was asked, per finding, whether the fix closed it. Verdict:
**STILL BLOCKED** — and again it was right on every point.

| Finding | Second-pass verdict | Then |
|---|---|---|
| #1 hash compare on the race path | CLOSED | test covers the sequential path only; concurrency is by construction |
| #2 transactional pause/ingress/admission | CLOSED — "the atomicity claim is now **true**, independently of #3" because `BEGIN IMMEDIATE` takes the single writer slot before the reads | confirmed; tests remain sequential |
| #3 paged drain | PARTIAL — my loop stopped after 1,000 pages, so 500,001 held rows could still strand | **Fixed:** uncapped loop that throws `intake_drain_stalled` on no progress, inside the resume transaction, so a stuck drain rolls the resume back instead of half-resuming |
| #4 tool widening | PARTIAL — `allow: ["read"]` → `allow: []` (or omitted) still passed, and `commands.ts` applies **no** allowlist restriction to an empty/absent list | **Fixed:** verified the claim in `commands.ts` before acting on it, then refused `coordinator_rebind_clears_allowlist`; both the emptied and the omitted case are tested |
| #5 create-race + set order | PARTIAL — the loser returned `created: true`, and records written by 0.7.46 with unsorted `effects` demanded a policy rebind after upgrade | **Fixed:** the flag now comes from the insert itself, and `kxmCeilingHash` normalises, so a legacy fingerprint still matches an equivalent bind (new test proves both halves) |

New findings it raised, and where they went:

1. **HIGH — `withDatabaseTransaction` poisoned the connection.** `activeTransactions`
   was claimed *before* `BEGIN`, and `BEGIN` sat outside the `try/finally`, so a
   `BEGIN` that threw on a busy database left the connection permanently marked as
   in-transaction and every later call failed with a misleading
   `runtime_transaction_nested`. Pre-existing, but my new transactions exposed it.
   **Fixed** in `database.ts` (claim after `BEGIN`, wrap `BEGIN` and surface
   `runtime_transaction_busy`), with a regression test that holds the write lock
   from a second connection and then proves the same connection still works.
   **The first version of that fix was worse than the bug for throughput:** measured
   on this suite, main's `database.ts` ran 1199 tests in **818 s**; with the
   unpoison-but-no-backoff version a single U2a-2 recovery test took **1024 s** and
   the run never finished in 40 minutes, because SQLite's 5 s busy timeout is
   per-connection and recovery paths open several transactions in a row. The
   committed version adds `TRANSACTION_BUSY_BACKOFF_MS` (1 s): the first blocked
   `BEGIN` pays the timeout once, immediate retries refuse fast with
   `retry deferred`, and a successful `BEGIN` clears the window. Same test now
   asserts all three, and the full suite came back to **442 s**. So the finding is
   closed without trading correctness for a 2× slowdown, and the earlier
   fast-fail came from the defect rather than from design.
2. MEDIUM — legacy hash drift: fixed as above.
3. MEDIUM — false `created: true`: fixed as above.
4. MEDIUM — **`rowid` is not a durable arrival sequence**: correct, and it bites
   this repository specifically because backups use `VACUUM INTO`, and implicit
   rowids may be renumbered by a vacuum. Kept as same-store ordering, with the
   claim narrowed in code and Tracking; an explicit immutable arrival sequence is
   added to the schema-v6 follow-up list.
5. MEDIUM — **"closure claims exceed the implementation"**, including that this
   record's own table mislabeled deferred finding 10 (coordinator history) as the
   fifth blocker when the fifth was the create-race/normalisation pair. Accepted:
   the dispositions above replace that table's "Fixed" wording, and the Tracking
   entry now states what is true, what is by-construction, and what is still open.

Its one judgement I would qualify: it scored the payload-only `doesNotThrow`
assertion as "records a known weakness, not an integrity guarantee". Agreed — which
is why it is written as `assert.doesNotThrow` with the reason inline rather than as
a passing guarantee.

## Reproducing these reviews

```bash
codex login status                       # must report ChatGPT auth
git branch review-base-248 150e914       # pre-#248 ref
codex exec -s read-only -m gpt-6-astra \
  -c model_reasoning_effort=high --color never \
  -C "$PWD" -o /tmp/astra-review.md - < /tmp/astra-brief.md
```

`codex exec review --base <BRANCH>` cannot carry a custom prompt, so the targeted
brief is passed to plain `codex exec` with the read-only sandbox instead. The
second pass used the same form with the fix-diff brief; note that the operator's
`~/.codex/rules` wrapper (`rtk proxy …`) failed a few early commands with
`command not found: rtk` inside the sandbox before Codex fell back to direct
`nl`/`rg`/`sed` reads — worth knowing if a future run looks mysteriously stalled.
