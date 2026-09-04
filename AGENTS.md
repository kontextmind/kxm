# KXM session brief

Read this first. Then follow
[`docs/vnext/implementation-plan.md`](docs/vnext/implementation-plan.md)
(especially **Tracking**). Do not invent a parallel process.

## Product

- Name is **KXM**. Not Mesh, not pi-extensions.
- Hub process: `kxm hub start` · `kxm hub view` · `kxm hub stop`
- Live screens: `kxm dash` (optional `--screen agents|tasks|workflows|plans|inbox|procs`)
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

If the native harness is missing or logged out, do **not** silently bill through Pi’s other-provider key. Fail closed or ask to log in. Pi remains default only for providers it actually hosts (today: Grok and anything `pi auth check` covers that has **no** better native harness logged in).

**Cost and quality insights:** Every assignment should make the next one faster, cheaper, or better — not just billed. Track harness + provider + model + thinking + **latency + cost + whether verify passed / rework happened**. Use `kxm routing report` (and later `kxm dash`) to prefer the cheapest logged-in native harness that still meets quality. Drop xhigh thinking and extra critics when the report shows they don’t pay for themselves. Do not “upgrade” model or harness without evidence. Fail closed on untracked spend.

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

## Do not

- Bulk-migrate jira / provenance / v04 just to “set up”
- Add a harness preferences overlay
- Bypass fail-closed identity checks
- Weaken `/fix` independent repro-before-oracle
