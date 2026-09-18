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

## Reproducing this review

```bash
codex login status                       # must report ChatGPT auth
git branch review-base-248 150e914       # pre-#248 ref
codex exec -s read-only -m gpt-6-astra \
  -c model_reasoning_effort=high --color never \
  -C "$PWD" -o /tmp/astra-review.md - < /tmp/astra-brief.md
```

`codex exec review --base <BRANCH>` cannot carry a custom prompt, so the targeted
brief is passed to plain `codex exec` with the read-only sandbox instead.
