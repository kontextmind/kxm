# Spec: kxm observability dashboard (later)

**Status:** discuss only — not in the current conversion  
**Inspiration:** SSSF `just obs` (`~/source/payk12/factory` + skill `apps/visualizer`)  
**Do not:** recreate an `sssf/` folder or copy the Vue app yet

---

## Problem

SSSF already has a local live UI:

- sessions list
- per-run trace (phases, agent vs code, attempts)
- tickets view (Jira PK-* → kick a ticket ADW)
- poll SQLite WAL (`sssf.db`) so reads never block runs
- localhost `:4601` UI / `:4600` API

kxm today is CLI + JSONL/SQLite only (`kxm session status`, hub `/health`, `.kxm/logs/*.jsonl`, `.kxm/state/mesh.db`). Operators who used `just obs` will expect a similar pane once factory ADWs live under `.kxm`.

## Non-goals (this issue)

- Shipping UI in the factory-to-`.kxm` mapping
- Non-localhost / multi-tenant hosting (that is neuro-mesh later)
- Replacing GitLab/Jira UIs
- Showing prompt or reply bodies

## Goals (when we pick it up)

A **read-only, local** dashboard that answers:

1. What sessions are running or last finished?
2. Which workers (AI **agent** vs code **gate**) ran, and their `kxm.worker-result.v1` outcome?
3. Where is this workflow in its stages / evidence / waits?
4. (Optional) Which PayK12 tickets are eligible to start `factory-ticket`?

## Proposed views (MVP)

Same three as SSSF, renamed to kxm:

| View | Reads | Shows |
|---|---|---|
| **Sessions** | `.kxm/assets/sessions/*/session.json`, mesh workflow runs | id, mode (`mix` \| `workflow`), host (`local` \| `mesh`), worker chips (agent/gate), status |
| **Trace** | `.kxm/logs/telemetry.jsonl` + hub JSONL + workflow journal | timeline of envelopes; agent vs gate color; outcome; artifact paths under `.kxm/assets/workflows/<id>/` |
| **Tickets** (PayK12 only) | Jira API same as today, **start** still goes through `kxm workflow start factory-ticket` | list + “start” that does not embed factory Python |

Live hint: poll files/SQLite like SSSF (`poll_ms` ~500), or reuse hub SSE later.

## Data contract (already decided)

Do **not** invent a second trace schema.

- Identity: `kxm.worker.v1` (`kind: agent\|gate`, `driver: ai\|code`)
- Result: `kxm.worker-result.v1` (`ok`, `outcome`, `summary`, additive details)
- Session: `kxm.session.v1` (mix of agents+gates **or** a workflow id)
- Workflow: existing hub run + journal
- Telemetry: append-only JSONL under `.kxm/logs/` (gitignored)

Dashboard is a **viewer** of those records. If JSONL is missing, the CLI work to emit it is a prerequisite issue, not part of the UI issue.

## Hosting

| Phase | Where | Auth |
|---|---|---|
| MVP | `127.0.0.1` only, bind like the hub | none on loopback; never show tokens |
| Later | neuro-mesh / reverse proxy | same project tokens as the hub; no cookie session store in v1 |

## Open questions for discussion

1. **New small app** (Vite, like SSSF) vs **hub-served static** from `kxm mesh hub` (one port)?
2. Tickets view in **pi-extensions** (generic) vs **PayK12-only** plugin?
3. Write actions: start workflow / stop session from the UI, or observe-only until CLI is boringly reliable?
4. Keep SSSF visualizer running against factory until kxm JSONL exists, then freeze `just obs`?

## Suggested issue split

1. **Prerequisite:** append `kxm.worker-result.v1` to `.kxm/logs/telemetry.jsonl` from agent/gate CLI.
2. **This spec:** dashboard MVP (sessions + trace, localhost).
3. **Follow-up:** tickets view + optional start button.
4. **Later:** mesh-mode (non-localhost) with hub auth.

## Acceptance (MVP, when scheduled)

- `kxm mesh hub` running locally; dashboard shows sessions without copying secrets.
- Agent and gate rows are visually distinct.
- Clicking a session shows envelope timeline and links to `.kxm/assets/workflows/<id>/`.
- No `sssf/` directory in PayK12.
