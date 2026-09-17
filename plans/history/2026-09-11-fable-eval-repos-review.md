# Fable review: five reference repos vs KXM (2026-09-11)

Role: Claude Fable, architecture/permissions critic. Input: `/tmp/kxm-eval-repos/`
(doompi, pix-mono, ak-pi-workflow-roles, omp-hooks-plus, pi-antigravity) read
against `plugins/kxm/src/harness.ts`, `oneshot-producer.ts`,
`engine.ts`, `routing.ts`, `permission.ts`, `extension.ts`, `.kxm/`,
and `plans/implementation-plan.md` Tracking. This is a proposal. The current
writer applies any accepted slice with tests; nothing here is a plan edit yet.

## Headline judgement

Four of the five repos validate KXM's existing shape rather than argue for a
new one. The one that argues for a new route (pi-antigravity, an in-process Pi
provider for Google OAuth) **contradicts** the AGENTS.md provider-native rule and
should be mined for patterns, not adopted as a route. The two highest-value
findings are not in any README:

1. **`kimi acp`** exists on this machine. ACP over stdio is a real long-lived
   protocol, and ak-pi-workflow-roles already ships a generic ACP
   `RoleTurnHost`. That is the first credible path to a *second* supervised
   worker beside Pi — an experiment for Phase 11, not a change to today's rule.
2. **agy and kimi one-shot argv have no read-only profile.**
   `READ_ONLY_ONESHOT_ARGS` covers claude/codex/grok only, yet `agy --help`
   exposes `--mode plan` / `--sandbox` and `kimi --help` exposes `--plan`. A
   critic dispatched to agy or kimi today can write. This is a permission gap
   and should be fixed before any new provider work.

## 1. Native provider architecture for agy and kimi

**What pi-antigravity does.** OAuth 2.0 PKCE against Google with an embedded
client id/secret, five scopes including `cloud-platform`, loopback callback on
port 51121 with paste-back for headless hosts, `registerProvider` +
`registerApiProvider` for native streaming, dynamic catalog refresh that
collapses `-low/-medium/-high` runtime ids into one public id with thinking
levels, server-reported quota groups (`remainingFraction`, `resetTime`), and a
sanitized `/doctor`.

**Critical view.**

- Adopting it as a KXM route would bill Google through Pi while an
  authenticated native harness (`agy`) is installed — exactly what AGENTS.md
  forbids ("do not silently bill through Pi's other-provider key"). The
  embedded OAuth client belongs to another product; `cloud-platform` scope is
  far wider than KXM needs. **Reject as a route.**
- The catalog-grouping pattern is already mirrored in KXM
  (`gemini-3.8-flash-high` default in `oneshot-producer.ts`), so no gain.
- The *quota* pattern is valuable but agy has no `usage` subcommand
  (verified via `agy --help`), so KXM cannot read Antigravity quota without
  agy's tokens. The observable signal for agy is the 429 body in one-shot
  output. pi-antigravity's 429 classifier (`Individual quota reached`, `Resets
  in …`) is the reusable piece.
- Kimi: `parseKimiOneShotUsage` returns all-null usage and no `authMethod`.
  Combined with the subscription list in the producer
  (`["claude.ai","ChatGPT","antigravity-oauth"]`), every kimi attempt lands as
  `costBasis: "unknown"` and burns the hard-coded 100 unmetered/unknown attempt
  budget while being labelled less honestly than Claude subscription runs.

**Recommendations.**

| # | Action | Gate |
|---|---|---|
| 1.1 | Extend `READ_ONLY_ONESHOT_ARGS` with `agy: ["--mode","plan","--sandbox","--disable-slash-commands"]` and `kimi: ["--plan"]`; critic agents on these harnesses must get them. | Test: critic dispatch to agy/kimi rejects when read-only args are absent; witness one agy critic run that refuses an edit. |
| 1.2 | Kimi auth probe returns `authMethod: "kimi-managed"` when `managed:kimi` is seen; add it to the subscription list so basis is `unmetered`, not `unknown`. | Unit test on parser + producer basis. |
| 1.3 | Add a shared 429/quota classifier (harness-neutral) fed by one-shot stderr/stdout, producing `failureClass: "quota"` and `resetAt` when parseable. Routing already reads `failureClass === "quota"`. | Fixtures from agy, grok, claude, codex 429 bodies. |
| 1.4 | **Experiment (bounded):** ACP adapter for `kimi acp` as a supervised worker candidate. Borrow the ak `RoleTurnHost` contract shape (session open/continue/close, turn, tool mount, capability declaration; controlled failure causes `activation\|provider\|session\|output\|timeout\|unrecognized`). Same task on Pi vs kimi-ACP, side by side, three runs. | Do not update AGENTS.md's "Pi is the only long-lived worker" until the witness passes. |

## 2. Usage tracking and quota/spend limits

**What KXM has.** Routing v2 with fail-closed `costBasis`, dated/hashed
`prices.yaml`, list estimates only for Claude flat tiers, `limits.maxModelCost`
on metered spend, a hard-coded ceiling of 100 unmetered/unknown attempts per
run, `quotaExhaustedAttempts` in the report.

**What the repos add.**

- pi-antigravity: quota is a *bucket* (`displayName`, `window`,
  `remainingFraction`, `resetTime`), shared across models in a pool.
- doompi: `--explain` prints estimated prompt cost *before* launch; a local
  log sink retains per-agent token burn.
- pix-data/pix-footer: modelgrep/benchlm as pricing/score sources.

**Critical view.**

- modelgrep/benchlm are undated, unhashed third-party aggregates. AGENTS.md
  requires a dated, hashed feed and forbids LLM-adjacent guesswork. **Do not
  adopt as pricing truth.** Acceptable only as an ingestion source into
  `kxm models refresh` with `source` and fetch status, prices still `unknown`
  unless the vendor row matches.
- The 100-attempt unmetered ceiling is a magic number in the engine, not a
  YAML limit. `permission.ts` already models `budget` as an authority
  field; the number should live there so a permission expansion is visible.
- Subscription attempts are not free — they consume a window. KXM records
  them as `unmetered` and then has no notion of "how much window is left".

**Recommendations.**

| # | Action | Gate |
|---|---|---|
| 2.1 | Add `kxm.quota-observation.v1`: `harness, provider, bucket, remainingFraction\|null, resetAt\|null, source: server-reported\|status-parsed\|unknown, observedAt`. Emit from the 429 classifier (1.3) and, later, from harnesses that expose usage. | Schema test; report shows the population separately. |
| 2.2 | Routing eligibility: a route with an observed exhaustion and `resetAt` in the future is **ineligible** until `resetAt`; with no `resetAt`, ineligible for a bounded cool-down. Never fall through to Pi's same-vendor key. | Failing-first test: exhausted route not selected; no same-vendor Pi fallback. |
| 2.3 | Move `maxUnmeteredAttempts` to `limits` in workflow/project YAML (default 100). | Permission projection test shows raising it as `expansion`. |
| 2.4 | `kxm assign --explain` (doompi pattern): print estimated prompt tokens per role = system prompt + skills + tool schemas + context packet, plus catalog price at that context if known. Record estimate vs actual `tokensIn` in routing metadata. | Estimate present in record; drift visible in `kxm routing report`. |

## 3. Role configuration and workflow governance

**What ak-pi-workflow-roles does well.** Typed receipts as the *only* lawful
exit (`ak_<role>_output`); exit code = lifecycle honesty, not business
success; in-place retry ceiling (`autoResumeLimit`, default 2); host×model
mismatch fails loud with no substitution; three layers (role body / host
adapter / public face) with a one-layer change locator; a "successor test" for
deleting mechanisms (delete if some other path catches that failure class).
Governance stays on the orchestrator side; the CLI supplies "brain turns"
only — which is KXM's one-shot producer design, validated.

**What omp-hooks-plus does well.** Project trust gates which hooks may run;
`PreToolUse` returns `deny | ask | updatedInput | additionalContext`;
deny-wins merge; process-group kill on timeout; plugin hook paths cannot
escape the plugin root.

**Critical view of KXM.**

- **Three places declare who the implementer is:** `.kxm/agents/implementer.yaml`
  (grok/grok-4.6), `.kxm/producers.yaml` `roles.implementer`, and
  `.kxm/roles/writer.yaml` roster (`openrouter/qwen/qwen3-coder-plus`). They do
  not agree. This is the "parallel process" AGENTS.md warns about. One must be
  authority; the others are ledgers or get a brake.
- `determineOutcome` already refuses prose. Good. But peer replies (critic
  PASS/FAIL) are freeform `content`; `just accept` relies on separate PASS
  records. Typed verdict envelopes would close that seam.
- Tool presets (`tools.preset: workspace-writer`) are tracked as authority in
  `permission.ts`, but I found no `tool_call` interception in
  `extension.ts` (hooks present: `session_start`, `message_start`,
  `agent_end`, `tool_result`, `agent_settled`, `session_shutdown`,
  `turn_end`). For the Pi worker, the preset is declarative, not enforced.
- ak's scale (13 roles, 79 ADRs, 136 source files) is a cautionary tale. KXM
  has four agents. Keep it that way; do not import the Tang bureaucracy.

**Recommendations.**

| # | Action | Gate |
|---|---|---|
| 3.1 | Make `.kxm/agents/*.yaml` the sole authority for harness+model per agent. `producers.yaml` stays a promotion ledger; `roles/*.yaml` roster is either derived or removed with a brake (`role_roster_conflicts_with_agent`). | Loader fails closed when they disagree. |
| 3.2 | Add a `tool_call` hook in the KXM Pi extension that enforces the agent's `tools.preset` (deny outside the allowlist, reason names the preset) and the ak ADR 0008 literal seatbelt for writer roles: `rm -rf`, `git reset --hard`, `git clean`, `git checkout --` blocked verbatim, no heuristics. | Tests for allow/deny/seatbelt; critic preset cannot call `edit`/`write`. |
| 3.3 | Typed critic verdict envelope `kxm.review-verdict.v1` (`verdict: pass\|fail\|escalate`,`findings[]`,`evidenceRefs[]`);`kxm_reply` from a critic role must carry it; `just accept` reads the field, never prose. | Accept refuses a PASS record without the envelope. |
| 3.4 | Adopt the "successor test" as a plan-hygiene rule for deletions (one sentence in Tracking hygiene). | Docs only. |

## 4. Agent communication and steering

**KXM today.** `steer > followUp > nextTurn` priority queue in the hub
extension; `nextTurn` is delivered as `followUp`; run-level cancel with
`operator_cancel`; message-level `kxm_cancel`.

**What the repos add.** pix-subagent: `agent_control` with
`info|result|steer|stop`, parent abort propagates to children, model name
always visible in the widget. ak: three-state verdict
(`converged|continue|escalate`) plus `resume <runId> "<ruling>"` so an owner
ruling re-enters the same run.

**Critical view.** A `steer` to a *one-shot* producer (grok/agy/kimi/claude -p)
is meaningless mid-flight; there is no session to steer. Today that is not
stated anywhere, so a caller may believe a steer landed.

**Recommendations.**

| # | Action | Gate |
|---|---|---|
| 4.1 | Define steer semantics per producer kind: Pi worker → in-session steer; one-shot → `cancel + re-dispatch with amendment`, counted against `maxAttempts`, recorded as `steer_redispatch`. Never silently drop. | Test: steer to a one-shot attempt yields a new attempt id and a journal entry. |
| 4.2 | Fanout cancel propagates to all children (pix-subagent parent-abort pattern). | Test on `kxm_fanout` + `kxm_cancel`. |
| 4.3 | `escalate` as a first-class step outcome that parks the run in a waiting state with a `signalKey`, resumed by `kxm workflow signal` carrying the ruling (ak `resume` pattern; KXM already has `wait`/`signal`). | Simulation test: escalate → human signal → same run continues. |

## 5. Token reduction with rtk-ai

**What pix-optimizer does.** Probes `rtk --version`; injects a prompt asking
the model to prefix commands with `rtk`; rewrites `bash` commands from a known
set (`git`, `ls`, `cargo`, …) to `rtk <cmd>`, splitting chains on
`&& || ; |` with quote awareness; falls back when missing; blocks `sudo`.

**Critical view.**

- `rtk` is not installed on this host. The gain is unmeasured for KXM.
- rtk is a lossy output filter. For the `verify` gate and for critic evidence,
  a filtered test log can hide the failure the gate exists to catch. **Never
  route gate or critic output through rtk.**
- The larger, safer win is structural, per doompi: every tool schema and skill
  in context costs tokens before work starts. The KXM MCP surface exposes the
  full `kxm_*` tool set to every role; a critic does not need
  `kxm_workflow_wait` or `kxm_promote`. Measure this first with routing v2
  `tokensIn`.

**Recommendations.**

| # | Action | Gate |
|---|---|---|
| 5.1 | Role-scoped tool exposure: MCP server / extension exposes only the tools the agent's preset allows (doompi "selective loading"). | `tokensIn` delta recorded on the same task before/after. |
| 5.2 | Skill loading per role: critics load `kxm` skill sections relevant to review only; writer loads implement/verify sections. | Same measurement. |
| 5.3 | rtk as a **bounded experiment**, writer role only, declared on the agent YAML (`tools.bashRewrite: rtk`), presence-probed, chain-split rewrite copied from pix (pure, tested). Two arms on the same task; keep only if `tokensIn` drops without rework rising. | Experiment record in routing telemetry with dissent preserved. |
| 5.4 | Explicit brake: rtk rewrite disabled for `kind: gate` steps and for agents with critic presets. | Test. |

## 6. SSH support for remote hosts

**What pix-ssh does.** `ssh_run` tool with `ssh -G` host discovery,
`BatchMode=yes` key/agent probe first, `sshpass -e` password fallback via env,
in-memory per-host password cache, ControlMaster/ControlPersist multiplexing
with a stable socket path, `StrictHostKeyChecking=accept-new`, 10 s connect
timeout, 60 s auto-deny approval, blocked in non-interactive mode, output
capped at 50 KB / 2000 lines.

**Critical view.** pix-ssh is a *model tool*: the agent runs one command on a
box. KXM Phase 6 is an *executor*: a whole attempt runs remotely with
event cursors, reattachment, verified workspace transfer, and uncertain-effect
recovery. The overlap is the transport layer only.

- `accept-new` is a TOFU policy. For a fail-closed product with recovery
  semantics, host keys must be pinned (`.kxm/repo/env.yaml` or a known_hosts
  path) with `StrictHostKeyChecking=yes`.
- Password auth via `sshpass` requires an interactive prompt. KXM executors
  are headless. **Keys/agent only; fail closed otherwise.**
- The three-layer lesson from ak applies: transport (ssh/ControlMaster) is
  adapter-internal; the executor contract (start attempt, cursor, reattach,
  reconcile) is the public face.

**Recommendations.**

| # | Action | Gate |
|---|---|---|
| 6.1 | Transport module (pure, tested like `pix-ssh/lib.ts`): argv builder with ControlMaster/ControlPersist and a per-host socket under `.kxm/state/ssh/`, `BatchMode=yes` always, pinned host keys, no password path. | Unit tests mirror pix tests for argv shape; a test asserts `accept-new` never appears. |
| 6.2 | Versioned remote helper (`kxm-remote`, hash-pinned) that writes attempt events as sequenced JSONL; local side keeps a cursor; reattach = reconnect + read from cursor (Phase 6 "event cursors, process reattachment"). | Connection-loss simulation resumes from cursor without duplicating effects. |
| 6.3 | Sequence: **do not start Phase 6 while the Phase 11 one-shot settlement release blocker is open** in Tracking. Remote execution multiplies every unsettled failure mode. | Tracking order. |
| 6.4 | Note `agy remote-control` and `kimi acp` as candidate remote-host surfaces to evaluate inside 6.2, not as substitutes for the executor. | Docs note only. |

## Ordered next steps (smallest gate first)

1. **1.1 + 1.2** — read-only argv for agy/kimi; kimi subscription basis.
   Permission gap, one file each, deterministic tests. Do this first.
2. **3.1** — single authority for agent harness/model; brake on roster drift.
3. **3.2** — `tool_call` enforcement of presets + literal seatbelt.
4. **1.3 + 2.1 + 2.2** — quota classifier, observation record, eligibility.
5. **2.3 + 2.4** — YAML unmetered limit; `--explain` estimate.
6. **5.1 + 5.2** — role-scoped tools/skills, measured. Then **5.3** rtk arm.
7. **3.3 + 4.1–4.3** — typed verdicts; steer semantics; escalate/signal.
8. **1.4** — kimi ACP worker experiment (Phase 11).
9. **6.x** — SSH transport after Phase 11 settlement passes.

## What not to do

- Do not install pi-antigravity or any in-process Google/Moonshot OAuth
  provider as a KXM route while `agy`/`kimi` are installed and authenticated.
- Do not take modelgrep/benchlm prices as catalog truth.
- Do not route gate or critic output through rtk.
- Do not add a fifth agent role or a role-runtime layer modelled on ak's
  thirteen offices.
- Do not add a preferences overlay for any of the above; agent YAML plus
  workflow limits are the only knobs.

## Remaining risks in this review

- I did not execute `kimi acp` or `agy --sandbox`; flag presence is from
  `--help`, behaviour is unverified.
- Tool-preset non-enforcement in the Pi worker is inferred from the hook list
  in `extension.ts`; the writer should confirm before building 3.2.
- Token savings from 5.1/5.2 are hypotheses until routing v2 `tokensIn` shows
  them.
