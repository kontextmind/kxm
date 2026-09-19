---
schema: "kxm.doc.v1"
id: "REVIEW-INTAKE-CONTRACT-ASTRA"
type: "architecture"
title: "Codex gpt-6-astra review of the Runtime intake contract (#248)"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-18"
updated: "2026-09-19"
authority: "hypothesis"
confidence: "uncertain"
summary: "Six passes of an independent critic on the M1+M6 intake contract: BLOCK, then STILL BLOCKED four times — on the fix, on the closure of the fix, on the injectable seam that closure introduced, and on bun:sqlite's error shape — then CLOSED on the sixth pass. Every finding reproduced; each pass also corrected the previous pass's overstated claims. Critic opinion, not assignment, witness or acceptance proof."
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

Six passes: **BLOCK** on the contract, **STILL BLOCKED** on the fix, **STILL BLOCKED** on
the closure of that fix, **STILL BLOCKED** on the closure of *that* (the injectable seam
my own round-3 fix introduced), **STILL BLOCKED** on a runtime this repository also ships
on, and **CLOSED** on the closure of that. Each pass reviewed the previous pass's claims as well as the
code, and each one was right; the tables below are ordered by round, and a later row
supersedes an earlier **Fixed**.

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

These are first-pass dispositions. The second- and third-pass sections below
supersede any row marked **Fixed** that later proved partial — read them in that
order rather than treating this table as the current state.

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
| #5 create-race + set order | PARTIAL — the loser returned `created: true`, and records written by 0.7.46 with unsorted `effects` demanded a policy rebind after upgrade | **Partly fixed:** the flag now comes from the insert itself, and `kxmCeilingHash` normalises. The claim in this row that a new test "proves both halves" was **false** — the test inserted the row before binding, so it exercised the initial lookup and never lost an insert, and it still passed with the create-race fix reverted. Corrected by the third pass, which also found the legacy comparison missing from both read-back paths |

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
   **Partly undone anyway** — the third pass caught this row's own successor
   claiming a test "proves both halves" when it proved neither. See below.

Its one judgement I would qualify: it scored the payload-only `doesNotThrow`
assertion as "records a known weakness, not an integrity guarantee". Agreed — which
is why it is written as `assert.doesNotThrow` with the reason inline rather than as
a passing guarantee.

## Third pass — the critic reviewed the closure of its own second pass

Verdict: **STILL BLOCKED**, five findings, all reproduced against this working
tree and all accepted. It also volunteered that two of its own round-2 dispositions
had been overstated, which is the point of asking the same critic twice.

| Finding | Severity | What was actually wrong | Then |
|---|---|---|---|
| 1. The backoff could deny transactions for hours | MED | The deadline was `Date.now() + 1000`. A clock step backwards kept a long-gone write lock refusing transactions until wall time caught up; a step forward ended the throttle early. The check also ran before the mode was considered, so a `DEFERRED` transaction — which takes no write lock — was refused for another caller's contention | Monotonic deadline from `process.hrtime.bigint()`, injectable so a test can step it instead of sleeping through it. The test steps `Date.now` by ±1 h against the **default** clock and requires the refusal to stay inside the window both ways; `DEFERRED` is exempt from the throttle, and a `DEFERRED` success does not clear one. Verified to fail when the default clock becomes `Date.now()` again, and when either mode rule is removed |
| 2. Every `BEGIN` error was classified as contention | MED | The catch installed the backoff and threw `runtime_transaction_busy` for anything, including `cannot start a transaction within a transaction` and a closed connection — turning a programming bug into a retryable-looking condition and discarding the original error | `isTransactionContention()` gates it. It decides on SQLite's **numeric result code** where one exists (`code & 0xff` in `SQLITE_BUSY` 5, `SQLITE_LOCKED` 6, `SQLITE_PROTOCOL` 15 — so `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT` and `SQLITE_LOCKED_SHAREDCACHE` land on their primaries), and falls back to anchored message text only when there is no numeric **or symbolic** result code, because a wrapper that merely quotes "database is locked" is not evidence of contention. `SQLITE_FULL`, `SQLITE_CANTOPEN` and read-only writes are not contention and rethrow unchanged |
| 3. Legacy equivalence held on the initial lookup but not on the race read-back | MED | `bindKxmCoordinator` recomputed the fingerprint over the stored authority; `persistCoordinator` and the rebind read-back compared persisted hashes only, so the same legacy row was idempotent on one path and `coordinator_write_lost` on the other | One `ceilingsMatch(stored, ceilingHash)` used by all three paths. New test forces a losing insert against a legacy-hash winner and expects the winner, not a conflict |
| 4. Drain completeness was fixed, but resume cost is unbounded | CONCERN | One `IMMEDIATE` transaction parses, validates, rewrites and **retains** every held row. Measured here: 150k rows of 64-byte payloads = 4.54 s synchronous and ~95 MiB heap; 500k maximum-size payloads ≈ 7.6 GiB retained. The write lock makes it finite, so this is throughput and memory, not correctness | Kept as-is deliberately, and recorded as an M2 pre-condition with these numbers ("Still open" item 9). The loop's cost is now named in the code where it is paid |
| 5. The record still overstated what its tests prove | LOW | Round 2's table claimed the new test proved both legacy equivalence **and** the create-race flag; it proved neither — it inserted the row before binding, so it exercised the initial lookup, and it never lost an insert | Corrected below, and the forced losing-insert test now exists |

## Tests the third pass found decorative, and what replaced them

| Claim | Problem | Now |
|---|---|---|
| "drains more held intent than one page" | passed with the old 1,000-page cap restored; it crossed one page, not the cap | 1,002 held rows with a forced one-row page: 1,003 pages, and the assertion is that nothing is left held. Verified to fail when the page cap is put back |
| "a stall rolls the resume back" | not tested at all | forced `updateIntakeDispatch` refusal: expects `intake_drain_stalled`, then asserts the project is **still paused** and the row is still held, then that a real resume drains it |
| `created: false` on the race path | the sequential assertions never lose an insert, so they passed with the fix reverted | Two forced losing writes against a legacy-fingerprint winner: one lost **insert** (`insertCoordinatorIfAbsent`) and one lost **rebind replace** (`replaceCoordinatorInSlot`, which installs the winner through the real method first, so the end state is the raced one and only the boolean is the loss). Deleting either fixture patch flips `created` to `true` |
| ceiling normalisation | the reordered-ceiling test passed with normalisation removed from `kxmCeilingHash`, because binding already normalises its inputs | `kxmCeilingHash` is now compared directly over reordered, repeated and genuinely different sets, plus the binder's own refusal of repeated members |
| busy/backoff | the old test waited out its own deadline, so it passed whether or not a successful `BEGIN` cleared the backoff; and it never tried a non-contention error, another connection, or a failed `COMMIT` | Seven transaction-focused tests now (the fifth pass corrected "Four", then "Five"): the real contention path (pays the timeout once, refuses fast inside the window, recovers), the deadline's clock (stepped in both directions on the default clock, with a numeric bound each way), clock-domain isolation, mode scoping (`DEFERRED` runs and does not clear), classification on both runtimes, and recovery after a failed `COMMIT`. Each was mutation-checked against the fix it claims |
| "one admitted task" | admitted one `runId` record; no task exists at this layer | renamed to "one admission record", with the M2 consumer named as the thing that would create a task |
| "reordering or repeating" | only reordering was tested | repeats are tested, against the fingerprint and against the binder's refusal |

## What the third pass accepted without change

- No allowlist bypass in the transitions it probed: policy presence, preset
  identity, added allow entries, disappearing allow lists and lifted denials are
  each refused, and `isToolAllowed` does not consult `preset` as an allow list.
- No new path that widens authority, bypasses a committed pause, or admits one
  message to two runs.
- Deferring immutable coordinator history, record digests and a durable arrival
  sequence to schema v6 — the same list this record has been building.
- Its own note that a cleared marker after a failed `ROLLBACK` does not prove
  SQLite exited the transaction. Pre-existing; now stated in the code comment
  rather than assumed away, and a deferred-foreign-key test proves the connection
  is still usable and the failed write is not half-applied.
- One thing it found that round 2's own fix had made redundant: clearing the
  backoff on any successful `BEGIN` also let a `DEFERRED` read clear a throttle
  armed by write contention. That is now mode-scoped, which is also what makes the
  assertion distinguishable.

## Fourth pass — the critic reviewed the closure of the third pass

Verdict: **STILL BLOCKED**, on one point, and it was right: my fix for round 3's
clock finding reintroduced the same class of defect one layer up.

| Finding | Sev | What was wrong | Disposition |
|---|---|---|---|
| 2. Deadlines shared a connection key but not a clock domain | MED | The injectable `clock` stored an absolute number in a per-connection slot and the next call subtracted **whichever** clock it was given. A valid monotonic clock an hour ahead therefore throttled a default-clock caller for an hour (`retry deferred 3601000ms`), and `() => NaN` reached `BEGIN` with no deadline at all. The seam the critic had itself asked for was the hazard | **Fixed**: throttle state is keyed by connection **and** clock, so a deadline can only be read, expired or replaced by the clock that armed it; a non-finite reading throws `runtime_transaction_clock_invalid` instead of meaning "no deadline" — at the points where throttle state is read or armed, which is the honest scope the fifth pass asked for: an uncontended `BEGIN` never consults the clock, so this guards the seam rather than every transaction. One test steps both domains and asserts neither borrows the other's refusal nor clears it, including that a bad clock leaves the good domain throttled |
| 3. Classification predicate | CONCERN | Message-only matching had no stability guarantee, missed `SQLITE_LOCKED_SHAREDCACHE` (`database schema is locked: main`, errcode 262) and `SQLITE_BUSY_RECOVERY`, and said "contention" for any wrapper that quoted a busy message | **Fixed by result code** — and then caught again in the fifth pass for being **Node-only**: it read `errcode` and ignored `bun:sqlite`'s `errno`, so on the runtime Pi hosts extensions in, a real shared-cache `BEGIN` failure classified as permanent and armed nothing. Order is now `errcode`/`errCode`/`errno`, then a symbolic `SQLITE_*` name, then anchored text, with the number beating the message in both directions. The `SQLITE_PROTOCOL` decision the critic asked for: **counted as contention**, because SQLite raises it after exhausting retries to start a WAL transaction. What remains open (item 10) is now narrower: shared-cache contention has been reproduced live on Bun, and what this stack has never raised is `SQLITE_PROTOCOL` and `SQLITE_BUSY_RECOVERY` |
| 4. Raw non-contention errors change output shape | CONCERN | A `BEGIN` failure that is not contention now reaches `runtime-supervisor.ts` as a plain `Error` → 500/`runtime_internal` instead of 400 with a code; `cli/project.ts` falls back to `run_io_failed` | **Accepted as correct.** A permanent failure must not be reported as a retryable busy condition; `engine.ts` guards `.issues` and reports `retryable: false`, and `hub.ts` already maps both shapes to `internal_error`. No caller dereferences `.issues` blindly. Recorded so the next reader of this contract knows the mapping changed on purpose |
| 5. Rebind read-back policy | CONCERN | Returning the winner with `created: false` is honest about *creation* but says nothing about whether this caller's approval and reason were persisted; the comment said "same policy" | **Fixed the wording** to "same ceiling". The distinction is recorded rather than patched: `created` reports whether this call inserted a row, never whether an approval was recorded — immutable rebind history is deferred item 1 (schema v6). The critic re-ran both race fixtures through the real losing SQL and they held |
| 8. Claims still exceeded evidence | LOW | "forced losing insert, twice" (it is one insert and one rebind), "Four tests now" (five), "the store treats the handle as suspect" (no such behaviour exists), and a forward-step assertion that only matched text while the Tracking said it bounded the window | All four corrected, in the code comment, in this record, in Tracking — and the forward assertion now bounds numerically, so the claim is the weaker of the two |

## What the fourth pass confirmed rather than changed

- **No disagreement-driven loop in the drain.** It corrupted the dispatch-column vs
  record relationship in memory, called resume, and got `intake_record_divergent`
  with the project still paused: the store rejects the divergent row *before*
  returning the page, so a stale row cannot spin the loop.
- **The two forced-write fixtures are not self-fulfilling.** It replaced the
  hardcoded `false` returns with the real attempted insert/update after installing
  the winner; both tests still passed, and deleting the patches flips `created` to
  `true`.
- **Bounded resume, immutable history, record digests, durable arrival sequence and
  two-process barriers** stay deferred to the schema-v6 / M2 slices, as accepted in
  round 3.
- Its own limit, stated rather than discovered later: 18 of the 20 intake tests could
  not run in the read-only sandbox (temp-dir writes returned `EPERM`), so it re-ran
  14 test bodies with the fixture construction replaced in memory. That covers the
  policy logic, not the store constructors, migrations or restart persistence —
  which is what `npm run verify` and the container smoke on the PR are for.

## Fifth pass — the closure of the fourth, on a runtime this repository also ships on

Verdict: **STILL BLOCKED**. Not another recursion of the clock-domain pattern this
time — a portability hole. The classifier read Node's `errcode` and ignored
`bun:sqlite`'s `errno`, so in the runtime Pi actually hosts extensions in, the
reviewer's reproduction (Bun 1.3.14, two connections on one attached database)
gave `errno: 262`, `code: "SQLITE_LOCKED_SHAREDCACHE"`, message
`"database schema is locked: shared"`, and `isTransactionContention` answered
**false**: the raw error propagated and no throttle armed.

| Finding | Sev | Disposition |
|---|---|---|
| Bun's numeric code ignored | MED, blocking | **Fixed.** `errcode` → `errCode` → `errno`, then a symbolic `SQLITE_BUSY*` / `SQLITE_LOCKED*` / `SQLITE_PROTOCOL*` name, then anchored text only when neither exists — and a numeric code wins over the text in **both** directions, so `errno: 13` (`SQLITE_FULL`) wearing a "database is locked" message is not contention. The classifier test carries the exact Bun-shaped triple, a symbolic-name-only case, and the contradiction. Mutation-checked: dropping `errno` and message-only classification each turn it red |
| Retention grows per distinct clock identity | LOW, nonblocking | **Fixed as far as design goes**: the inner map is `WeakMap<MonotonicClock, number>`: it keeps no otherwise-unreachable clock function alive, so a caller building a fresh closure per attempt leaves nothing behind once that closure is collected. A *retained* clock retains its entry; collection is neither immediate nor size-bounded, and nothing measures GC here — what is asserted is that distinct closures with identical readings get independent deadlines. Stated rather than gated: the growth was shown on an instrumented copy, no committed assertion measures it, and no production caller passes a clock |
| Invalid-clock scope overstated | LOW | **Claim narrowed** in the code comment, CHANGELOG and Tracking, as above |
| Descriptions exceeding assertions | LOW | Fixed: domain coverage is **one** test (the record said two) and the transaction-focused count is **seven** (it said "four", then "five"); `doesNotMatch(/retry deferred/)` became `match(/blocked by another transaction/)` so a released domain must actually reach `BEGIN`; "keyed by connection and clock" is stated as *function identity*; and the fourth pass's drain and losing-write confirmations are now labelled **reviewer probes**, not committed integration coverage |
| `SQLITE_PROTOCOL` and `SQLITE_LOCKED` decisions | CONCERN | **Accepted, with the critic's own boundary evidence**: a same-connection active reader made a *statement* fail with code 6 inside `work()`, which stayed untranslated and unthrottled because only the `BEGIN` catch classifies. That boundary is why including `LOCKED` is safe here |

Its stated limits, recorded so nobody over-reads this: 3 of 22 committed intake tests
ran under the read-only sandbox and 19 stopped at temp-directory creation, so the
reviewer re-derived those bodies in memory and probed both runtimes directly. That is
not verification of store constructors, migrations, restart persistence or the
configured busy timeout — `npm run verify` and the container install smoke are.

## Sixth pass — verdict: CLOSED

Round 5's fix held on both runtimes, and the critic's strongest evidence was executed,
not read: a genuine shared-cache `BEGIN` failure was reproduced on **Node 24.15.0**
(`errcode: 262`, `code: "ERR_SQLITE_ERROR"`) and **Bun 1.3.14** (`errno: 262`,
`code: "SQLITE_LOCKED_SHAREDCACHE"`) using two connections on one attached, shared-cache
database with a schema change between them; both classified as contention, both armed the
throttle, and a genuine `SQLITE_READONLY` (8) via `PRAGMA query_only=ON` stayed permanent
and unthrottled on both. It also reproduced an active-reader `SQLITE_LOCKED` (6) raised
by a *statement* inside `work()`, which correctly stayed untranslated.

Four nonblocking corrections came out of it, all landed:

| Point | What it found | Then |
|---|---|---|
| Q2 | A permanent **symbolic** name with no number fell through to the text fallback, so `SQLITE_FULL` quoting "database is locked" was still called contention — and the blanket claim in three documents was therefore too broad | A SQLite result *name* now decides in both directions, exactly as a number does; Node's `ERR_SQLITE_ERROR` is explicitly not a result name. Assertions added for symbolic-permanent, symbolic-contention-without-a-number, and the code/name precedence; mutation-checked against the old fall-through |
| Q1 retention | "cannot accumulate entries" overstated a `WeakMap`: a retained clock keeps its entry, and collection is neither immediate nor size-bounded | Claim rewritten in code, CHANGELOG, Tracking and this record. What *is* now asserted is the behaviour that matters: two distinct closures with identical readings get independent deadlines |
| Q1 scope | "an uncontended transaction never consults the clock" was wrong in the case where an entry was already pending — the preflight still reads the clock | Reworded, then re-reworded after round 8: the clock is consulted **twice**, to check a pending deadline and to arm a fresh one, so the only transaction that never reads it is a **successful `BEGIN` with no pending deadline**. Asserted directly: a `NaN` clock on a quiet connection runs `work()` untouched, while fresh contention on an untouched connection yields exactly one read and `runtime_transaction_clock_invalid` |
| The committed-coverage row itself, and this record's claim that the wording had been rewritten in Tracking | LOW | The row listed reviewer probes as if they were tests, and two Tracking sentences still carried the pre-correction wording, so "claim rewritten in Tracking" was false. "Claimed committed, now actually committed": the divergent-row resume and both real-losing-SQL fixtures are tests, the Tracking sentences were rewritten (round 7 caught that the first two attempts had not landed), and the Bun reproduction was replaced with a form that runs |
| Original Q4/Q5 committed coverage | Several round-5 confirmations were reviewer probes, not tests: the divergent-row resume, and both forced-write fixtures returning an authored `false` | **Committed.** A forged index column (`held_paused` against a record that says `ready`) now has a test asserting `intake_record_divergent` with the project still paused and the row untouched; both race fixtures obtain their `false` from the real guarded SQL, so the boolean is SQLite's verdict rather than mine |
| Q4 wording | "only when there is no code" survived in one round-3 row; the printed Bun reproduction was not runnable as written (`SQL` undefined, no shared-cache attachment) | Both fixed here — the runnable form is quoted above, and the count is now 23 intake tests, seven of them transaction- and throttle-focused |

What it declined to treat as blockers, and so what stays deferred: immutable coordinator
history, record digests, populated migration coverage and a shared version constant,
two-process barriers, read-side byte bounds, untrusted classification enforcement,
transaction composition, the durable arrival sequence, bounded atomic resume, and the
live witnesses for `SQLITE_PROTOCOL` / `SQLITE_BUSY_RECOVERY` — with failed-rollback
handle invalidation and the public clock seam recorded as named limits, not solved
problems.

## Seventh pass — the corrections to the corrections

Verdict: **STILL BLOCKED**, and correctly so: it reviewed my *closure claims* rather
than only the code, and found three of them untrue.

| Point | What it caught | Then |
|---|---|---|
| Twin clocks | `runtime_transaction_busy` is the label for fresh contention **and** a borrowed deadline, so the twin block proved nothing; a mutant that merged clock identities **by value** passed it | Each twin's first attempt must now reach `BEGIN` (`blocked by another transaction`) and each must then be refused in its own window. Re-run as a mutation: value-keyed clock merging now fails |
| Tracking | Two sentences still carried the pre-correction wording ("cannot grow it", "an uncontended `BEGIN` never consults the clock"), which made this record's claim that the wording was rewritten in Tracking **false** | Both rewritten to what the code does; the assertion named in their place is the twin case, not a garbage-collection measurement |
| Bun reproduction | The snippet this record printed still did not run (`SQL` undefined, no attachment) — the same failure mode as round 6's, in the sentence written to fix it | Replaced with the two-connections-attach-one-named-shared-cache form, with the observed numbers for both runtimes |
| Precedence | The classifier test survived deleting `errno` **and** putting the symbolic name ahead of the number: every fixture had them agreeing, so nothing pinned the order | Two disagreeing fixtures added (`errno: 5` against `code: "SQLITE_LOCKED_SHAREDCACHE"`, and `code: "SQLITE_BUSY"` against `errno: 13`), plus `errcode` vs `errno` disagreement. Mutation-checked: dropping `errno`, and reordering symbolic ahead of numeric, each now turns the test red |

Its other conclusion, recorded because it is the point of the whole exercise: no
authority, pause, duplication, success-reporting or spend defect was found in any
runtime path — the blocks since round 3 have been about what this repository *claims*
and what its gates *enforce*, which is the same failure class in a smaller hat.

## Eighth pass — the corrections to the corrections, again

Verdict: **STILL BLOCKED** on three claims, with the substance accepted: the twin-clock
assertions are load-bearing and both requested precedence mutations die. It also
corrected me on its own suggestion — attaching a file-backed database did **not** raise
shared-cache contention; two in-memory connections attaching one named
`file:…?mode=memory&cache=shared` database did.

| Point | What was still wrong | Then |
|---|---|---|
| Precedence, second direction | `errno: 5` paired with `SQLITE_LOCKED_SHAREDCACHE` — both contention, so the "number beats name" label proved nothing; a mutant consulting `SQLITE_FULL` before the numbers survived the whole test | Fixtures that disagree in **both** directions: `errno: 5` with `code: "SQLITE_FULL"` must be contention, `errno: 13` with `code: "SQLITE_BUSY"` must not, `errcode: 13` with `errno: 5` settles which number wins. Re-running the critic's veto mutant now fails |
| Clock scope, third wording | "no pending deadline" still omitted that **arming** a fresh deadline reads the clock too, so freshly contended transactions do reach the guard | Stated as the implementation does: consulted to read a pending deadline and to arm one; the only transaction that never consults it is a **successful `BEGIN` with no pending deadline** — in code, CHANGELOG and Tracking |
| The printed Bun logger | `console.log(e.errcode, …)` prints `undefined` on Bun, in the very snippet added to replace a non-runnable one | Split into two runnable blocks with each runtime's own field and observed output |
| A fixture named in prose | Tracking claimed a `code: "SQLITE_FULL"` pairing that the test did not contain | Rewritten to name the fixtures that exist |

Confirmed accurate by the pass rather than merely asserted: the retention wording against
the `WeakMap`, the twin assertions as behavioural independence, the test count (23, seven
transaction- and throttle-focused, names listed), and no new authority, pause,
duplication, spend or success-misreport route. Its own limit, restated: 20 of the 23
intake tests cannot create temp directories in the read-only sandbox, so the committed
suite is not what it executed.

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
second and third passes used the same form with a fix-diff brief; note that the
operator's `~/.codex/rules` wrapper (`rtk proxy …`) failed a few early commands
with `command not found: rtk` inside the sandbox before Codex fell back to direct
`nl`/`rg`/`sed` reads — worth knowing if a future run looks mysteriously stalled.

The fourth and fifth passes ran measurements rather than only reading, including a
Bun 1.3.14 reproduction of shared-cache contention to check the classifier's shape:

The runnable form is the one round 7 produced — two in-memory connections that
**attach the same named shared-cache database**, because a second handle to a file does
not raise it. Run on Node 24.15.0 and Bun 1.3.14:

```js
// node:sqlite — connection A
const a = new DatabaseSync(":memory:");
a.exec("ATTACH DATABASE 'file:shared_probe?mode=memory&cache=shared' AS shared");
a.exec("BEGIN IMMEDIATE");
a.exec("CREATE TABLE shared.t (x)");
// connection B, same process
const b = new DatabaseSync(":memory:");
b.exec("ATTACH DATABASE 'file:shared_probe?mode=memory&cache=shared' AS shared");
try { b.exec("BEGIN IMMEDIATE"); } catch (e) { console.log(e.errcode, e.code, e.message); }
// Node 24.15.0: 262 ERR_SQLITE_ERROR  "database schema is locked: shared"
```

```js
// bun:sqlite — same shape; the number lives in `errno`, and `errcode` is undefined
try { b.run("BEGIN IMMEDIATE"); } catch (e) { console.log(e.errno, e.code, e.message); }
// Bun 1.3.14: 262 SQLITE_LOCKED_SHAREDCACHE  "database schema is locked: shared"
```

Round 8 caught this record printing the Bun half with `e.errcode`, which yields
`undefined` — the defect in miniature, inside the sentence written to fix it.

`bun:sqlite` takes the same shape with `new SQL(":memory:")` and
`db.run("ATTACH DATABASE 'file:shared_probe?mode=memory&cache=shared' AS shared")`.
Both numbers and both names are what the classifier now consumes.

The third pass also ran measurements rather than only reading: it reproduced the
backoff against a wall-clock step, forced a losing insert against a legacy-hash
winner, forced a 1,003-page drain, and timed the drain at 150k rows. Ask for that
explicitly in the brief, or a review of a diff becomes a read of a diff.
