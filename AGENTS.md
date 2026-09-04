# KXM session brief

Read this first. Then follow
[`docs/vnext/implementation-plan.md`](docs/vnext/implementation-plan.md)
(especially **Tracking**). Do not invent a parallel process.

## Product

- Name is **KXM**. Not Mesh, not pi-extensions.
- Future work is not backwards-compatible. Fix leftovers with **brakes** (fail
  closed on old names), not dual Mesh/KXM aliases.
- Hub process: `kxm hub start` · `kxm hub view` · `kxm hub stop`
- Live screens: `kxm dash` (optional `--screen agents|tasks|workflows|plans|inbox|procs`)
- Hub-local session: `kxm session brief`; Pi TUI `/kxm` picker + status line.
  `kxm init --hub existing|new` is opt-in; default init is local-only.
- DB: `.kxm/state/kxm.db`
- Plugin / npm: `kxm` / `@kontextmind/kxm`

## Who does what

| Role | Who | Why |
|---|---|---|
| **Implement / write code** | **Grok** (`xai/grok-4.6`) via Pi, headless | Designated sole writer. Fast at repo-shaped edits. |
| **Plan** | **Claude Fable** (`claude --model fable`) | Architecture and permissions; independent of the writer. |
| **Review** | **Fable** (architecture/permissions) and **Codex gpt-sol** (CLI/docs) | Different providers from the writer. One critic is enough unless the change is auth, workflow policy, or multi-package. |
| **Portability / mapping** | **Kimi** only when the task is Windows/path/CLI-portability | Not a default reviewer. |
| **Verify** | The implementer runs `npm test` / `npx tsc --noEmit`. Critics do not replace tests. | Deterministic gates beat a third model. |

Claude is for **planning and review**, not the default writer. Do not treat `claude -p` output as hub peer-reply evidence; save it as an artifact plus human signoff.

**Provider-native harness:** If the model’s provider has its own harness and that harness is **installed and logged in**, use it — not Pi’s copy of the same provider. That is why `kxm harness list` checks auth.

Examples: Anthropic → Claude CLI (subscription); OpenAI → Codex; Moonshot → Kimi; Google → Gemini CLI when present. xAI/Grok stays on Pi unless a Grok harness exists and is authenticated.

**Aggregators (OpenRouter, etc.) are Pi *providers*, not a second coding harness.** If `pi auth check` / `/login openrouter` (or `OPENROUTER_API_KEY`) is good, Nous and other OpenRouter models are usable **on Pi** as `openrouter/…` ids. There is no OpenRouter/Nous `kxm agent worker` CLI. Prefer OpenRouter for those models so your OpenRouter credit is what gets billed; don’t invent a fake harness. Same auth-or-fail-closed rule.

If the native harness is missing or logged out, do **not** silently bill through Pi’s other-provider key. Fail closed or ask to log in. Pi remains default only for providers it actually hosts (today: Grok and anything `pi auth check` covers that has **no** better native harness logged in).

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

Use a slim path: plan → implement → verify. Do **not** run the 13-stage `/fix` for setup or docs. Dual-critic `/fix` is Phase 7.

## Plans and slices

When a gate passes, a slice lands in the wrong phase, or a name/CLI change
ages the plan, update **Tracking** and the affected phase gate in
`docs/vnext/implementation-plan.md` in the **same** change. Do not refresh the
plan every session. Do not enlarge earlier phases. Fable proposes plan edits;
Grok applies them.

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
| **Commit** | `npm run verify` | `npm test` (build + tests) then `npm run check` (tsc + lint:docs + versions) |
| **PR/MR** | CI `validate:ci` + `check:generated` | coverage + check + pack dry-run; generated `dist` current |

Cleanup (`git status`, no `nul`/tmp/secrets; `dist` if CLI changed) is **before** the commit gate and **again before push**. Session-ready `/new`/`/fork` and leftover Mesh operator copy are **PR judgment**, not extra npm scripts, until they can fail a test without a live harness. Come-back list: Tracking **Still open**. Ship hint belongs on the Pi status/widget (`ship dirty` / `N local` / `PR after CI`), not in every chat turn.

A commit is not a PR. A PR is not a release.

## Do not

- Bulk-migrate jira / provenance / v04 just to “set up”
- Add a harness preferences overlay
- Bypass fail-closed identity checks
- Weaken `/fix` independent repro-before-oracle
- Add backwards-compat shims or dual product names; brake old names instead
