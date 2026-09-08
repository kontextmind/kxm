---
schema: "kxm.doc.v1"
id: "PM-0001"
type: "postmortem"
title: "Incident Postmortem: <Incident Title>"
project: "kxm"
status: "approved"
owner: "@incident-lead"
created: "2026-09-08"
updated: "2026-09-08"
authority: "evidence"
confidence: "verified"
summary: "Blameless analysis, timeline, root cause, and action items for <incident>."
tags: ["incident", "postmortem", "reliability"]
related: []
details:
  incident_date: "2026-09-08"
  severity: "sev-2" # sev-1 | sev-2 | sev-3
  time_to_detect_minutes: 5
  time_to_mitigate_minutes: 20
---

# Incident Postmortem: <Incident Title>

## Executive Summary

- **Incident Period:** `2026-09-08 14:10 UTC` to `2026-09-08 14:35 UTC` (25 minutes)

- **User Impact:** <Number of workflow runs blocked or delayed>

- **Root Cause:** <One-sentence summary of failure mechanism>

## Incident Timeline (UTC)

| Time | Event Description | Detected By |

|---|---|---|
| 14:10 | AI worker crashed during git push; CAS effect left in `dispatched` state | Log watcher |

| 14:15 | Subsequent retry attempts blocked due to unexpired CAS lease | `kxm dash` operator |
| 14:22 | Operator pressed `d` (degrade) to inspect worktree manually | Interactive TUI |

| 14:30 | Fix committed; lease expiration policy patched | Operator |
| 14:35 | Hub restarted; all queued workflow runs completed | Verifier |

## Root Cause Analysis (5 Whys)

1. **Why did the retry fail?** Because the CAS effect lease was locked in `dispatched` state.

2. **Why was it still locked?** Because the previous worker process exited abnormally without calling abort.

3. **Why did the lease not expire?** Because the lease had no automated heartbeat timeout.

4. **Why was there no timeout?** Because CAS leasing was assumed to be synchronous.

5. **Systemic Root Cause:** Missing failure recovery watchdog for unconfirmed external side-effect leases.

## What Went Well / What Went Wrong

### What Went Well

- The database remained consistent; zero duplicate PRs were created on GitHub.

- Degrade-to-human hotkey (`d`) allowed the operator to take over immediately.

### What Went Wrong

- The error message in `kxm dash` did not explicitly indicate how to force-release an abandoned lease.

## Corrective & Preventive Action Items

| Action Item | Type | Owner | Target Date | Issue Reference |

|---|---|---|---|---|
| Add 300s automated lease timeout to `ExternalEffectsLedger` | Prevent | Platform Lead | 2026-09-10 | #165 |

| Add `kxm routing unquarantine` CLI command | Mitigate | CLI Lead | 2026-09-12 | #166 |
