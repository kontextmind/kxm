# KXM session brief

Read this first. Then follow
[`plans/implementation-plan.md`](plans/implementation-plan.md)
(especially **Tracking**). Do not invent a parallel process.

## Product

- Name is **KXM**. Not Mesh, not pi-extensions.
- Future work is not backwards-compatible. Fix leftovers with **brakes** (fail
  closed on old names), not dual Mesh/KXM aliases.
- Hub process: `kxm hub start` · `kxm hub view` · `kxm hub stop`
- Live screens: `kxm dash` (optional `--screen agents|tasks|workflows|plans|inbox|procs|spend`)
- Hub-local session: `kxm session brief`; Pi TUI `/kxm` picker + status line.
  `kxm hub bind <url>` binds this host to a running hub; `kxm init` is project-only.
- DB: `.kxm/state/kxm.db`
- Plugin / npm: `kxm` / `@kontextmind/kxm`
- Punt wiki compile/ingest and npm update-source until a **public npm** release.

## Who does what

Agents are a **rotation per workflow role**, chosen from authenticated,
supported helper routes using verified quality, total time/cost, and rework.
Root may change agents without asking again. Capability and auth checks stay
fail-closed. Different providers supply independent review. This is developer
orchestration policy for the issue 127 runner, not a Phase 4/11 product
router.

| Role | Starting rotation | Why |
|---|---|---|
| **Implement / write code** | **Grok** (`grok --model grok-4.6`), headless | Currently admitted native writer on this runner. Fast at repo-shaped edits. After failure, immediately use the next eligible authenticated model. Qwen `qwen/qwen3-coder-plus` is admitted through OpenRouter/Pi with exact model auth; never bill Grok through Pi. Not a fixed sole writer. |
| **Plan** | **Claude Fable** (`claude --model fable`) | Architecture and permissions; independent of the writer. |
| **Review** | **Fable** (architecture/permissions) and **Codex gpt-5.6-sol** (CLI/docs) | Different providers from the writer. Both designated critics are required for acceptance on this runner; a single critic is at most preliminary triage. |
| **Portability / mapping** | **Kimi** only when the task is Windows/path/CLI-portability | Not a default reviewer. |
| **Verify** | The implementer runs `npm run verify`. Critics do not replace tests. | Deterministic gates beat a third model. Root re-runs the fixed witness. |

Claude is for **planning and review**, not the default writer. Do not treat
`claude -p` output as hub peer-reply evidence; save it as an artifact plus
human signoff. Do not declare Codex and Grok interchangeable in current
harness-run role mapping. Codex session work is an authorized **bootstrap**
route with unknown root usage/cost, never a forged native writer completion.
If a different native writer route is needed, resolve it with capability/auth
evidence.

**Attempts and relief (operator, 2026-09-07).** Never stop solely because
attempts are exhausted or failed. Immediately try the next suggested eligible
authenticated model and transfer findings. Preserve every attempt, candidate,
failed check, and cost record. Prefer an authenticated native subscription for
the same model. The narrowly admitted Pi writer is OpenRouter Qwen
`qwen/qwen3-coder-plus`, which has no supported native route here; other models
require reviewed admission. Identity, witness, both critics, and acceptance
remain mandatory.
New-model comparisons are bounded experiments, not fanout on every task. The
standalone `just assign` command does not automatically schedule failover.

**Private handoff notes.** When needed, each role leaves concise private notes:
missing input, friction, what worked, suggested next change, artifact/check
refs, and approaches already tried. Those notes live in private model
summaries (`summary` / sidecars) and in `just attribute` history
(`orchestration|model|environment|unclassified` plus a private explanation).
Notes never grant tools, waive verification, skip review, or become
human/hub approval. Do not add schema fields for them.

**Normal entry** is a closed assignment manifest plus the current plan through
`just assign`. Fixed `just witness` verifies the exact candidate. `just accept`
binds the actual commit and independent Fable/Sol PASS records. `just
attribute` and `just observe-cost` keep private history without editing
`completion.json`. `just change-report` separates provider-reported spend,
list estimates, unmetered, unknown, partial data, all attempts, and explicit
exclusions. Root bootstrap costs remain unknown and are recorded as
cost-only. Public PR/CI ids are observations, not success proof. Low-level
`just impl|plan|review-arch|review-cli` recipes are harness transport only;
they do not mint assignment, witness, or acceptance proof.

Evidence-informed **effort defaults** (not a ranking, not a catalog): medium
for implementation, planning, and architecture review; low for CLI review.

**Provider-native harness:** If the model’s provider has its own harness and that harness is **installed and logged in**, use it — not Pi’s copy of the same provider. That is why `kxm harness list` checks auth.

Examples: Anthropic → Claude CLI (subscription); OpenAI → Codex; Moonshot → Kimi; Google → **agy (Antigravity CLI)** (`agy`, Antigravity OAuth) as an admitted native Google subscription writer/experiment edit route for Gemini kebab ids only (not a worker; starting rotation remains Grok; the deprecated `gemini` CLI catalog entry stays); xAI → **Grok CLI** (`grok`, OAuth to `auth.x.ai`), which superseded Pi for the writer role on 2026-09-04.

**Aggregators are Pi *providers*, not a second coding harness.** There is no
OpenRouter or Nous `kxm agent worker` CLI and no fake Nous harness. Pi is
still the only long-lived worker (`kxm agent worker` / `pi --mode rpc`).
Two helper prefixes are allowlisted after fail-closed `pi auth check
--provider <id>`:

- **OpenRouter** (`openrouter/…`): `/login openrouter` or
  `OPENROUTER_API_KEY`. Bills OpenRouter credit. The narrowly admitted Pi
  writer remains `openrouter/qwen/qwen3-coder-plus` with exact model auth
  and edit permission.
- **Nous Research Portal** (`nous-portal/…`): install
  `@jayteelabs/pi-nous-portal-provider` (`pi install
  npm:@jayteelabs/pi-nous-portal-provider`), then `/login` → subscription
  or API key → Nous Research Portal, or `NOUS_API_KEY`. Optional
  `NOUS_PORTAL_BASE_URL` (default `https://portal.nousresearch.com`) and
  `NOUS_INFERENCE_BASE_URL` (default
  `https://inference-api.nousresearch.com/v1`). Bills Portal, not
  OpenRouter. `nous-portal/tencent/hy4-preview` is the reviewed experiment
  example (`pi -p nous-portal -m tencent/hy4-preview`). Verify live ids
  and list prices on Portal `/models`. Hy4 is **not** a second Pi writer.

Same auth-or-fail-closed rule. Other `nous-portal` or OpenRouter writer
routes need reviewed admission.

If the native harness is missing or logged out, do **not** silently bill through Pi’s other-provider key. Fail closed or ask to log in. Pi remains default only for providers it actually hosts that have **no** authenticated native harness — today that is whatever `pi auth check` covers beyond Anthropic (Claude CLI), OpenAI (Codex), xAI (Grok CLI), Moonshot (Kimi), and Google (agy / Antigravity CLI; deprecated Gemini CLI catalog remains).

**Harness ≠ long-lived worker.** Moving the writer role to the Grok CLI does not make `grok` a supervised RPC worker: `kxm agent worker` / `pi --mode rpc` is still Pi-only. The Grok CLI is a one-shot headless writer (`grok --prompt-file`). `agy` is also one-shot headless (`agy -p`), not a worker. Do not declare a `grok` or `agy` long-lived worker until one exists and is tested.

**Cost and quality insights:** Every assignment should make the next one faster, cheaper, or better — not just billed. Track harness + provider + model + thinking + **context size + input/output (and cache) tokens + latency + cost + whether verify passed / rework happened**. Some providers charge **more as context grows** (long-context premiums, thinking tokens, uncached input). Sticker $/1M is not enough — compare **cost at the context we actually send**. Prefer the cheapest logged-in native harness that still meets quality. Drop xhigh thinking, extra critics, and huge dumps when the report shows they don’t pay for themselves. Do not “upgrade” model or harness without evidence. Fail closed on untracked spend.

**Catalog and prices:** Refresh model lists through each harness’s updater (`kxm update --models` for Pi; other CLIs as they support it). Do not let an LLM invent prices or “top models.” A later catalog feed (vendor/OpenRouter-style JSON, dated, hashed) should list **current models, context tiers, and list prices**; **our** ranking of “top” providers is that feed **plus** `kxm routing report` (quality, latency, real spend). Until that feed exists, treat list prices as `unknown` and use recorded run cost. Stale catalog must not silently underquote.

**Side by side:** When we need evidence (new model, harness, or thinking level), run two or three routes on the **same** task and compare. That is an experiment, not the daily loop. Don’t fan out every plan. Record all arms in routing telemetry, including dissent.

**Subscription limits:** Treat quota/rate-limit as a routing signal. If the preferred logged-in harness is exhausted, take the **next best** authenticated option by quality-then-cost from the report — not a silent Pi API key for the same vendor. Skip logged-out or unsupported pairs. If nothing eligible remains, fail closed and say which limits were hit. Fallback is not a second critic and does not mint quorum.

**Later (not MVP):** API budgets and using **rollover** leftover quota when the report says it’s worth it. Remember it when planning cost views; do not build it in this phase.

**Code the repeats:** Insights should also flag **repeatable asks/steps** that a script, test, or workflow `gate` can do as well as a model. Promote those into coded steps (Git-reviewed) so providers only handle judgment. That cuts cost/latency and **enforces consistency**. Do not auto-promote skills or gates from telemetry. Learned behavior still cannot grant tools or skip review.

**Gates and tests enforce loops.** Routing, failover, “don’t use Pi for Claude sub,” verify-before-pass, and “this step is now a script” are **gates/tests**, not prompt memory. If the loop isn’t in a failing test or a workflow `gate`, it will drift. Models propose; gates hold the line.

Harness default is **Pi** (omit `harness:` in YAML). Other CLIs are opt-in on the agent.

**Harness ≠ model, and not every harness is headless.** Pi is the only harness we treat as a long-lived headless worker (`kxm agent worker` / `pi --mode rpc`). Claude/Codex/Kimi/Gemini/DeepSeek each have their own model catalog; e.g. `harness: claude` cannot run Grok. Some only have interactive or one-shot print modes (`claude -p`, `codex exec`) — that is not a Pi-style RPC worker. Do not declare a harness/model pair the CLI cannot run. `kxm harness list` reports installed/auth, not “this can go headless.”

## Daily loop

Use a slim path: plan → implement → verify. Do **not** run the 13-stage `/fix`
for setup or docs. Dual-critic `/fix` is Phase 7. For this repo's issue 127
runner, that slim path is assignment → witness → (attribute/observe-cost as
needed) → accept, not a scratch `just impl` call.

## Plans and slices

When a gate passes, a slice lands in the wrong phase, or a name/CLI change
ages the plan, update **Tracking** and the affected phase gate in
`plans/implementation-plan.md` in the **same** change. Do not refresh the
plan every session. Do not enlarge earlier phases. Fable proposes plan edits;
the current writer applies them (starting rotation: Grok).

## Git and issue trackers

Do not assume GitHub. Bind SCM and tickets from **this repo’s conventions**, then let the operator confirm at workflow/project creation:

- Git remote (`github.com` / `gitlab.com` / other) and CI files (`.github/workflows` vs `.gitlab-ci.yml`)
- Issue tracker if obvious (Jira key, GitHub Issues, GitLab issues) or **none**

Ship GitHub checks + Jira webhooks first. GitLab (and other trackers) are adapters to add; until they exist, **offer the choice and fail closed** if the user picks an unimplemented one — don’t silently use GitHub.

## Verify and ship (gates, not memory)

On `/new` and `/fork`, update Tracking and affected docs in the **same** change.
Work is **agents** and **workflows**. Warn before fixing contradictions or
deleting duplicate docs/code. Product name is KXM.

Two combined gates (already in npm/CI). Do not add a third unless a test fails.

| When | Gate | What it combines |
|---|---|---|
| **Commit** | `npm run verify` | `npm test` (build + tests), `npm run check` (tsc + lint:docs + versions), then generated `dist` matches the staged `dist` |
| **PR/MR** | CI `validate:ci` + `check:generated` on two Linux legs (Node 22.19.0 and 24) plus Classify changes, Docs lint, and Plugin validation, five jobs. Local Mac `npm run verify` before push. Windows tests, builds, and release automation are paused, not deprecated. | coverage + check + pack dry-run; generated `dist` current. Plugin validation is a CI job, not a third npm script. |

Cleanup (`git status`, no `nul`/tmp/secrets; `dist` if CLI changed) is **before** the commit gate and **again before push**. Session-ready `/new`/`/fork` and Mesh operator copy are held by tests under `npm test` (extension readiness test, docs brake); no extra npm script. Come-back list: Tracking **Still open**. Ship hint belongs on the Pi status/widget (`ship dirty` / `N local` / `PR after CI`), not in every chat turn.

A commit is not a PR. A PR is not a release.

**PR loop (do not sit on this in the interactive session):** push the branch,
open the MR, enable auto-merge, watch CI on a background worker. Fix failures
and conflicts until green. After merge: update local `main`, delete the branch
(and worktree if used).

<!-- kxm:codex:commands:start -->
## KXM agent commands

The `kxm` CLI is the unified agent surface for peer collaboration and workflow stages. Every command supports `--json`.

### Peer messaging (`kxm peer <verb> --json`)

| Command | Purpose | Key options |
|---|---|---|
| `kxm peer list` | List online peer agents and purposes | `--json` |
| `kxm peer send [target] [content]` | Send a focused request to a peer | `--target`, `--content`, `--delivery <steer\|followUp\|nextTurn>`, `--correlation-id`, `--idempotency-key`, `--workflow-context <json>`, `--ttl-ms` |
| `kxm peer get [messageId]` | Check request status without blocking | `--message-id` |
| `kxm peer await [messageId]` | Wait for reply (capped at 60 seconds) | `--message-id`, `--timeout-ms` (max 60000) |
| `kxm peer cancel [messageId]` | Cancel a queued or delivered request | `--message-id` |
| `kxm peer fanout` | Send same request to 1–3 peers | `--targets <t1,t2>`, `--content`, `--timeout-ms`, `--workflow-context <json>` |
| `kxm peer inbox` | List inbound requests awaiting a reply | `--json` |
| `kxm peer reply [messageId] [content]` | Reply to an inbound request | `--message-id`, `--content` |

### Workflow lifecycle (`kxm workflow <verb> --json`)

| Command | Purpose | Key options |
|---|---|---|
| `kxm workflow checkpoint [runId] [stageId] [status] [summary]` | Record stage result with verified evidence | `--run-id`, `--stage-id`, `--status <passed\|warning\|failed>`, `--summary`, `--evidence <json>`, `--evidence-refs <json>` |
| `kxm workflow record [runId] [category] [area] [summary]` | Record plans, decisions, contradictions, errors, lessons | `--run-id`, `--category <plan\|decision\|contradiction\|error\|lesson>`, `--area`, `--severity <info\|warning\|error>`, `--details`, `--evidence <items...>` |
| `kxm workflow wait [runId] [stageId] [signalKey] [summary]` | Pause stage until an external signed signal arrives | `--run-id`, `--stage-id`, `--signal-key`, `--summary`, `--evidence <json>`, `--evidence-refs <json>`, `--timeout-ms` |
| `kxm workflow signal <runId> <signalKey> <status> <summary>` | Resume or unblock a waiting stage or vNext run | `[evidence...]`, `--delivery-id` |
| `kxm workflow list` | List local workflow runs | `--json` |
| `kxm workflow get <runId>` | Get stages and journal for a run | `--json` |

### Context operating system (`kxm context <verb> --json`)

| Command | Purpose | Key options |
|---|---|---|
| `kxm context get <project>` | Assemble role-aware context packet | `--role`, `--task`, `--run`, `--stage`, `--budget` |
| `kxm context recall <project>` | Search durable context metadata | `--query`, `--kinds`, `--limit` |
| `kxm context state <project> <key>` | Query authoritative temporal state | `--as-of <timestamp>` |
| `kxm context episode <project>` | Query workflow learning episodes | `--run` |
| `kxm context promote <project> <proposalId>` | Promote an approved state proposal (control plane) | required `--evidence <refs>` |
<!-- kxm:codex:commands:end -->

<!-- kxm:memory:start -->
## Project memory (read-only projection)

*No active project memory.*
<!-- kxm:memory:end -->

## Do not

- Bulk-migrate jira / provenance / v04 just to “set up”
- Add a harness preferences overlay
- Bypass fail-closed identity checks
- Weaken `/fix` independent repro-before-oracle
- Add backwards-compat shims or dual product names; brake old names instead

@RTK.md
