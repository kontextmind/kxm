---
schema: "kxm.doc.v1"
id: "PLAN-STUDIO-CLOUD-HOST"
type: "architecture"
title: "Studio screens for the shared kxmd hub: TUI parity, live work, and reviewed configuration"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-27"
updated: "2026-09-27"
authority: "hypothesis"
confidence: "medium"
summary: "Draft companion to plan-kxm-harness-first-run.md. KXM Studio on the kxmd host should set up and show the shared hub: the seven dash TUI screens, the setup wizard, policy editors that open pull requests, and a live workflow view. Humans authenticate with Authentik at the edge. The browser never holds a hub token. Policy files stay on origin/main. The same three dependencies gate this plan and the first-run plan. Execution tracking stays in implementation-plan.md."
tags: ["studio", "hub", "tui", "authentik", "sse", "onboarding", "a11y"]
related:
  - plan-kxm-harness-first-run.md
  - evidence/harness-first-run-2026-09-27.md
  - plan-omp-config-alignment.md
  - plan-per-tenant-hosting.md
  - implementation-plan.md
depends_on:
  - plan-kxm-harness-first-run.md
blocked_by: []
details:
  describes: "proposed"
  observed_at: "7a956e0 on 2026-09-27, package @kontextmind/kxm 0.7.1"
  decisions: "proposed, not taken"
---

# Studio screens for the shared hub

Read [the execution tracker](implementation-plan.md) first. This file is
proposed work, not scheduled work. It is the web companion to
[`plan-kxm-harness-first-run.md`](plan-kxm-harness-first-run.md). That plan
owns the CLI and TTY wizard. This plan owns the same jobs on Studio. Neither
plan starts until section 6 of the first-run plan is true.

Operator request, 2026-09-27: Studio, the web UI, should support setup and
configuration of the cloud host, the shared kxmd hub.

## 1. What is on the box today

Tracker, 2026-09-25: Studio and the hub run on `kxmd-studio` (`10.31.0.21`).
The proxy reaches that guest on ports 4242 and 7331 only. Host copies are
stopped. S5 in the tracker records the edge as deployed: Caddy TLS,
Authentik forward-auth, a tenant-admin group check on
`X-Authentik-Groups`, identity headers stripped, Studio bound to the tenant
VLAN, hub and supervisor on loopback. Interactive login remains an open
witness. Those sentences are tracker facts. This checkout does not contain
the proxy config.

Code at `7a956e0`:

| Piece | Where | What it does |
|---|---|---|
| Studio listener | `createStudioServer` in `plugins/kxm/src/studio-layout.ts`, default `127.0.0.1:4242` | One HTML page. `GET /api/layout` returns `kxm.studio-layout.v1` (stepper, DAG nodes and edges, swimlanes). `GET /health`. `POST /api/mutate` allow-lists CLI-shaped command names and returns 501 `mutation_handler_missing` when no handler is passed. The CLI serve path does not pass one. The tracker already records that the old "mapped to CLI" success claim was false. |
| Page behavior | same file, inline script | Polls `/api/layout` every 3 seconds. No hub client. CORS is `Access-Control-Allow-Origin: *`. |
| Visual system | same file, `:root` | Dark tokens: `--bg #0b0f19`, `--panel-bg #111827`, `--card-bg #1f2937`, `--border #374151`, `--text #f9fafb`, `--text-muted #9ca3af`, `--primary #38bdf8`, `--success #10b981`, `--warning #f59e0b`, `--danger #ef4444`. System font stack. A viewport meta tag is present. One column layout, `height: 100vh`, `overflow: hidden`. |
| Dash TUI | `plugins/kxm/src/tui.ts` | Seven panels. Live data prefers hub SSE, then a snapshot. |
| Hub SSE | `plugins/kxm/src/hub.ts` | `GET /v1/ops/events?project=` requires the admin credential, `text/event-stream`, 15 second heartbeat. `GET /v1/events?agentId=` requires the project credential. `presenceOnly=true` is only for an observer whose model is `tui`. |
| WebSocket | hub and Studio | None. Browser CDP sockets in `browser.ts` are for Obscura and Steel, not for Studio. |
| Identity | [ADR-0004](../docs/adr/ADR-0004-edge-identity-authentik.md) | Authentik at the proxy for browsers. The hub never reads a browser identity header. Machine clients use the admin token and project tokens. A timing-safe compare for the Studio session token is still an open hardening note in that ADR. |

`packages/core/tui` is a component library the dash theme already imports.
It is not a second set of product screens. The Pi extension progress view
is `plugins/kxm/src/workflow-tui.ts`.

## 2. Screen map

### 2.1 Dash panels, one Studio route each

`MESH_TUI_PANELS` in `tui.ts` is the inventory. Studio routes use the same
ids so a deep link and `kxm dash --screen` name the same thing.

| TUI panel | What the TUI shows | Studio route | Notes |
|---|---|---|---|
| `agents` | name, online, model, age, purpose | `/agents` | Peer presence. Fed by the same agent records the dash paints. |
| `tasks` | running and waiting runs, progress bar, stage marks, attempt counts | `/tasks` | Active work only, matching the TUI filter. |
| `workflows` | run status, workflow id, current stage, done/total | `/workflows` | List plus the live graph in section 4. |
| `plans` | age, run, stage, plan summary | `/plans` | Read-only journal lines. |
| `inbox` | status, from, to, delivery, age, id | `/inbox` | Open peer messages. |
| `procs` | live or dead, role, pid, file | `/procs` | Process monitor. |
| `spend` | age, harness/model, cost, tokens in+out, outcome | `/spend` | Includes cache tokens when the workflow progress metrics have them. |

Empty states use the same words the TUI uses when a panel has no rows.
Status is a word plus a color, never color alone. The TUI already does
this with `yes`/`no` and stage marks.

### 2.2 Library capabilities, not extra products

| `packages/core/tui` piece | Studio use |
|---|---|
| Panel sections, fields, browse / edit / choices (`tui/panel.ts`) | Wizard and settings forms. Same field kinds: text, enum, choice, info. |
| OMP overlay modes collapsed, expanded, history, optimizer (`adapters/omp.ts`) | Run drawer. Collapsed is a one-line status. Expanded is the graph. History and optimizer are the other two drawer tabs. |
| Queue reorder (`tui/queue.ts`) | Upcoming work on `/tasks`. Reorder is a reviewed change, not a live policy write. |
| History filters all, task, gate, retry, peer, state (`tui/history.ts`) | The log stream filters. |
| Role budget (`tui/roleBudget.ts`) | A column on `/spend`. |
| Model selector (`tui/modelSelector.ts`) | Picker inside the route editor. It lists admitted routes. It does not admit one. |
| Theme roles accent, dim, error, success, warning (`tui/theme.ts`) | The CSS variables already on the Studio page. |
| Workflow progress stepper (`workflow-tui.ts`) | The stepper `generateStudioLayout` already returns. |

Claude and Pi adapters format strings for those hosts. Studio does not
reimplement them.

### 2.3 Screens the dash does not have

| Route | Job | Write? |
|---|---|---|
| `/setup` | First-run wizard. Same scenes as the first-run plan section 4.3. | Calls the CLI. No secret fields that store a pasted key. |
| `/harness` | Installed harness, version, auth. DeepSeek copy matches the first-run plan: official `dsh` is a web kernel, and the catalog id `deepseek` is not that binary. | Read-only. Login buttons start the harness login on the box, the same handoff the TTY wizard uses. |
| `/roles` | Role, route, and model files. The naming validator from the in-flight naming work is the checker. | A pull request. Not a live file on the runner's checkout. |
| `/routes` | Admitted and disabled routes, and `prices.yaml` acknowledgement state. | A pull request to change admission. Acknowledge stays the existing CLI. |
| `/gates` | `gates.yaml` entries and the last result per gate. | A pull request to add or edit a gate. Results are read-only. |
| `/bind` | Hub binding scope, project id, client bindings. `hub bind --cloud` appears here only after that flag is on main. Token values are never rendered. The page shows "present" or "missing". | Calls `kxm hub bind` / `unbind`. Does not write `hub-env.json` by hand. |
| `/peers` | Hosts and peer presence beyond the agent table: binding scope, last seen, stale, offline. | Read-only. |
| `/doctor` | The `kxm doctor` report, including repair. | Repair calls `kxm doctor --repair` from the first-run plan. |

`/setup` is the Studio face of the first-run wizard. It does not grow a
second questionnaire.

## 3. Live work

`/workflows/:runId` is the live view. It uses `generateStudioLayout` so the
DAG, stepper, and swimlanes stay one payload.

Show, when the hub event or the run record has the field:

- Step state: pending, preparing, running, passed, failed, waiting, cancelled. Those are the statuses `StudioDagNode` already allows.
- Assignments and joins. Join labels stay `all` and `all-settled` until the engine executes more. A join the engine refuses is drawn as blocked, with the `step_unsupported` detail, and is not animated as running.
- Gate results: pass, fail, and the command id from `gates.yaml`.
- Route switches and fallbacks, once omp-alignment P4 emits `route_switch`. Before that, the pane says fallback is not recorded.
- Cost and token burn from the spend records and `WorkflowProgressMetrics` (input, output, cache read, latency, effort).
- Log stream with the history filters from `tui/history.ts`.
- Peer presence on the agents that this run assigned.

Monitors on every route, in the header: hub health, Studio health, binding
scope (loopback or remote), and whether the live stream is `sse` or
`snapshot`. The dash snapshot already has a `transport` field. Studio
reuses those two words.

Notifications are an `aria-live="polite"` region plus a dismissible list
for step completion, gate failure, route switch, and stream loss. No
email, SMS, or browser push vendor. Those stay out, matching the tracker's
intake boundaries.

Operational actions that the dash already performs over the hub, cancel
and the operator signal, may appear as buttons once a server handler runs
the same request the TUI sends. They are not policy edits. A button is
absent until that handler exists. The page does not pretend a 501 is
success.

## 4. Realtime transport

The hub already has SSE. Studio does not consume it. The browser must not
open `/v1/ops/events` itself, because that request needs the admin
credential.

Shape:

1. The Studio server on the box subscribes to `GET /v1/ops/events?project=`
   with the admin credential it already holds server-side. If that stream
   returns 401, 403, 404, or 503, it falls back the way `tui.ts` does:
   observer registration and `GET /v1/events?presenceOnly=true`.
2. The browser opens one same-origin stream, `GET /api/events`, also
   `text/event-stream`, with the same heartbeat idea (comments, 15
   seconds). Events are the public snapshot fields the dash already
   renders, plus layout deltas for the open run.
3. When the hub stream drops, Studio serves the last snapshot and sets
   `transport` to `snapshot`. The page polls `/api/layout` at the current
   3 second interval only in that degraded mode. A healthy SSE connection
   does not also poll.
4. No WebSocket is added to the hub or to Studio for this plan. The hub
   has no WebSocket route. SSE already matches the dash.

`Access-Control-Allow-Origin: *` goes away on the hosted listener. The
page and `/api/*` are same-origin behind the proxy.

## 5. Auth

[ADR-0004](../docs/adr/ADR-0004-edge-identity-authentik.md) stays the rule.

| Caller | Credential | Where it lives |
|---|---|---|
| Human browser | Authentik session at the reverse proxy. The tenant-admin group check stays at the proxy, as S5 deployed it. | Browser cookie on the proxy. Studio does not read or mint it. |
| Studio server to the hub | Admin token for `/v1/ops/events` and the health routes that need it. Project token for project-scoped reads. | Server-side hub env on the box. Never in HTML, JSON to the browser, or a query string. |
| Agent or Runtime | Project token and agent key, unchanged. | Unchanged. |
| Studio mutation bearer | The existing session token, compared in constant time. | Operator config on the box. The ADR already asks for the constant-time compare. |

The hub still does not parse `X-Authentik-*` headers. The proxy keeps
stripping them before anything reaches loopback. Studio may show a display
name only if the proxy injects a single non-secret header onto the Studio
listener and that header is not forwarded to the hub. If that header is
absent, the page says the operator is signed in at the edge and does not
invent a name.

A machine call from CI uses `kxm` and the hub token, not Studio.

## 6. What an edit is allowed to change

Two stores, two gestures.

| Store | Examples | Gesture |
|---|---|---|
| Project policy, read by the runner from `origin/main` | `.kxm/roles`, `.kxm/models`, `.kxm/routes.yaml`, `.kxm/gates.yaml`, `.kxm/workflows`, `prices.yaml` | Studio writes a branch and opens a pull request. The editor shows the validator result before the PR exists. The live runner does not read the branch. |
| This host | Onboarding marker, user config effort, hub binding, doctor repair | The same CLI the first-run plan specifies, including `--yes` when the page has already confirmed. Output is the CLI envelope. Secrets and `op://` values are not echoed. |

A text box that saves YAML straight into the working tree is not a
feature. The first-run plan's hybrid composer, if the operator accepts
it, persists a workflow file through that same PR gesture when the run is
an assignment. A local `kxm run` file is labeled worktree, as that plan
requires.

`/api/mutate` stays fail-closed. New handlers are named routes (`POST
/api/doctor/repair`, `POST /api/bind`) that shell one CLI command each.
They do not revive the allow-list that returns success without running.

## 7. Design, motion, and accessibility

Stay on the page Studio already serves. The CSS variables in section 1 are
the design system. TUI theme roles map onto them: accent to `--primary`,
success, warning, and danger to the matching variables, dim to
`--text-muted`. No second component kit and no new frontend framework in
S1 through S6. The layout payload already uses DAG coordinates. The page
draws them with the markup it has. Extracting the HTML string into a
static file under the plugin is allowed when the string is the thing that
blocks a test. That extraction is not a rewrite.

Layout:

| Width | Arrangement |
|---|---|
| Desktop, from 1100px | Left rail with the seven dash routes plus Setup, Doctor, and Bind. Main pane. Right inspector for the selected row. |
| Tablet, 700px to 1099px | Top tabs. Inspector is a sheet. |
| Phone, under 700px | One column. Bottom bar with Tasks, Workflows, Inbox, Spend, and More. The graph is the stepper. Tables become cards. |

The current page locks `overflow: hidden` and a full viewport. Phone
layout needs document scroll. The rail and the bottom bar stay put.

Motion:

- Route change: the main pane fades and moves 8px, 160ms, ease-out.
- A running DAG node uses the edge `animated` flag Studio already sets, as a short dash offset, 1.2s, linear.
- A step that just passed flashes its status word, 200ms.
- `prefers-reduced-motion: reduce` disables offset, dash, and flash. Status text still updates immediately.

Accessibility:

- One `h1`. Each route has an `h2`.
- The rail is a `nav`. The live region is `aria-live="polite"`.
- Focus order follows the rail, then the main list, then the inspector.
- Hit targets are at least 44px on the phone bar.
- Contrast uses the existing tokens. Status text is always present.
- The wizard fields expose labels, not placeholder-only names.

## 8. Wireframes

Desktop shell:

```text
+------------------------------------------------------------------+
| KXM Studio          hub ok · sse · loopback            Doctor    |
+--------+-------------------------------------------+-------------+
| Agents |  workflows                                | inspector   |
| Tasks  |  running  default   review-arch   2/4     | step        |
| Work.. |  waiting  land      land-rebase   3/6     | status      |
| Plans  |                                           | agent       |
| Inbox  |  +--------+    +-----------+    +------+  | tokens      |
| Procs  |  |implement|-->|review-arch|->| verify|  |             |
| Spend  |  | passed  |   | running   |  | wait |  |             |
|        |  +--------+    +-----------+    +------+  |             |
| Setup  |  live: route grok-native · $0.04 · 12k+2k |             |
| Bind   |                                           |             |
+--------+-------------------------------------------+-------------+
| polite: review-arch started                                  [x] |
+------------------------------------------------------------------+
```

Phone, the same run:

```text
+---------------------------+
| Studio    sse · hub ok    |
| default · review-arch 2/4 |
| [implement] done          |
| [review-arch] running     |
| [review-cli] waiting      |
| [verify] waiting          |
| grok-native · $0.04       |
+---------------------------+
| Tasks Workflows Inbox More|
+---------------------------+
```

Wizard, first scene after a signed-in load:

```text
+----------------------------------+
| Setup · 1 of 7 · Git project     |
| This directory is a Git worktree |
| .kxm/project.yaml is absent      |
| [ Create project ]  [ Skip ]     |
| Next scenes: harness, auth,      |
| defaults, hub, doctor            |
+----------------------------------+
```

Roles editor, before a pull request exists:

```text
+----------------------------------+
| Roles · writer                   |
| route grok-native · effort medium|
| route qwen-openrouter-pi         |
| Validator: names ok              |
| Diff vs origin/main: 2 lines     |
| [ Open pull request ]            |
| The runner still reads main.     |
+----------------------------------+
```

## 9. Sequence

This plan uses the first-run plan's section 6 as its entry gate:

1. `kxm hub bind --cloud` and the unified project id on main.
2. The agent, role, and route naming validator on main.
3. omp-alignment P3 through P7 on main, P4 before any screen claims a
   route switch happened.

S3 also waits for first-run P1 through P5, because the wizard and doctor
buttons call those commands. S1 and S2 do not.

## 10. Phases

One PR each, admitted writer, both critics, `npm run verify` while CI
test workflows stay paused. Playwright uses the Obscura CDP fixture in
`test/e2e/fixtures.ts` ([ADR-0005](../docs/adr/ADR-0005-obscura-default-playwright.md)).
Video stays off. Assertions are roles, names, and text. A screenshot is
taken per breakpoint only when `page.screenshot` succeeds on that CDP
session. A refused screenshot is recorded and does not fail the suite.
The structural assertions still have to pass.

| Phase | Scope | Exit | Effort |
|---|---|---|---|
| S0 | Confirm the shared gate. No product code. | The three dependencies are on main, same record as first-run P0. | a status edit |
| S1 | Shell, seven routes, read-only snapshot, tokens unchanged, CORS no longer `*`, session compare in constant time. | A fixture HTML page exposes each route's heading. `test/core/studio-layout.test.ts` still passes. One Obscura test loads `/workflows` and finds the empty state. | medium |
| S2 | Server-side hub SSE and `GET /api/events`. Live graph, stepper, spend, logs, presence. Polling only after a drop. | A fake hub SSE updates the page without a 3 second poll. Disconnect sets `transport` to `snapshot`. | medium |
| S3 | `/setup`, `/harness`, `/doctor` calling the first-run CLI. | A logged-out harness does not write a marker. The page never shows an `op://` secret value. Depends on first-run P5. | medium |
| S4 | `/roles`, `/routes`, `/gates` open a PR. Validator runs first. | A unit test refuses a name the validator rejects. The working tree the runner reads is unchanged. | larger |
| S5 | `/bind` and `/peers`. Cloud bind control appears only when the CLI has the flag. | Token strings are absent from the HTML fixture. Bind calls the CLI and renders scope. | medium |
| S6 | Breakpoints, motion, reduced motion, focus, live region. | Obscura tests at 390, 800, and 1280 widths. Reduced motion disables the dash animation. Keyboard reaches the inspector. | medium |

S1 is the first product PR. S4 and S5 can follow S1 in either order. S3
follows first-run P5. S6 follows S2.

Suggested commits, when a phase is selected:

- S1 `feat(studio): add read-only routes for the dash panels`
- S2 `feat(studio): stream hub events to the browser`
- S3 `feat(studio): run first-run setup and doctor from the page`
- S4 `feat(studio): open a pull request for policy edits`
- S5 `feat(studio): show hub binding without revealing tokens`
- S6 `feat(studio): adapt layout, motion, and focus`

## 11. Tests

| Behavior | Where |
|---|---|
| Layout payload unchanged for a known workflow | `test/core/studio-layout.test.ts` |
| `/api/mutate` without a handler stays 501 | that suite, if not already asserted |
| CORS and constant-time compare | studio server unit test |
| SSE fallback to snapshot | fake hub in a unit test |
| No admin token in any response body | fixture that searches the HTML and JSON |
| Seven routes render headings | `test/e2e/` via Obscura |
| Phone stepper instead of the wide graph | same, viewport 390 |
| Reduced motion | `emulateMedia` and a computed style, if the CDP session allows it. If it does not, a unit test of the stylesheet covers the media query. |

## 12. Risks

- Putting the admin token in the browser would make every signed-in user
  a hub admin. Section 5 forbids it. The S1 test searches responses.
- A hosted page with `Access-Control-Allow-Origin: *` accepts other
  origins. S1 removes it.
- Writing `.kxm` on the live checkout would bypass `origin/main`. S4's
  test is the brake.
- Drawing `approval` and `wait` as running overclaims the engine. Section
  3 draws them blocked when the prerequisite says `step_unsupported`.
- The 3 second poll and an SSE stream together will flicker. Section 4
  uses one of them.
- Obscura does not record video and may refuse a screenshot. The exit
  criteria do not depend on pixels.
- Authentik headers forwarded onto the hub would reopen ADR-0004. This
  plan does not add hub code that reads them.

## 13. Open questions

- Does the hosted Studio process stay `kxm studio serve` inside the guest,
  or does the portal keep rendering and call the CLI over guest exec, as
  S2 and S4 of the hosting plan did? This draft extends `kxm studio serve`
  on 4242, because that is the listener the proxy already reaches. The
  portal can keep its read-only status page.
- Should `/setup` on the shared host be limited to the tenant-admin group
  only? The edge already gates that group. This draft adds no second
  group.
- When the naming validator lands, does Studio shell it or import it?
  Importing the same module the CLI uses is the smaller drift.

## 14. Out of scope

- A new identity system inside the hub.
- WebSocket, email, SMS, or browser push.
- Admitting routes from the page.
- Replacing the TTY wizard. Studio calls it.
- The first-run hybrid composer itself. If it lands, S4 is how a human
  reviews the file.
- Pixel-perfect visual regression as a merge gate.
- Editing the tracker. The operator selects the slice.

## 15. Change log

| Date | Note |
|---|---|
| 2026-09-27 | Companion draft opened against Studio and the dash TUI at `7a956e0`. |
