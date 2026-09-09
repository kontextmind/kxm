---
name: kxm-triage
description: Work the KontextMind review queue. Use when asked to triage the mind, review drafts, promote or skip learnings, resolve drift/contradiction/gap/loop items, or call km_review.
license: Apache-2.0
metadata:
  workflow: memory-triage
  version: "0.1.0"
  suite: kxm
---

# kxm-triage

Beacon — `km_status` with `skill: "kxm-triage"`.

## Queue

1. `km_review` `action=list` (optional kind filter). Group by kind — learning, drift, contradiction, gap, loop, suspicious.
2. **Suspicious first.** Secret-gate trips resolve before anything else. Never paste the matched secret; name the rule only.
3. Resolve with `km_review` `action=resolve`, `id`, `verdict`, `reason`.
   - `promote` — true, correctly scoped, deduped. Server commits to curated pages. No PR ceremony.
   - `research` — needs evidence; say what is missing.
   - `skip` — noise; mandatory reason (duplicate, wrong-scope, low-value, false-positive).
   - `suspicious` — gate/threat follow-up.

CLI — `kontext review list [--kind]`, `kontext review resolve <id> <verdict>`.

## Kind notes

- Drift — verify against repo HEAD. `doc_claims` is the probe evidence.
- Loop/gap promotions become artifacts. Insight `promoted_to` must point at the resulting page or skill.
- Three dismissals of the same insight type mute it 30 days. Do not dismiss unread items.

## Rules

- Every verdict has a reason.
- Strict namespaces — show author, source session, SHA to the human before promote.
