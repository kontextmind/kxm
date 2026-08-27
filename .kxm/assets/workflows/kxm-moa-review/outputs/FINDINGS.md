# kxm critic findings (grok / xhigh)

**Date:** 2026-08-27  
**Reviewer:** grok (`xai/grok-4.6`, thinking xhigh)  
**Peers:** fable, gpt-sol, kimi — **not run** (no live workers)  
**This is not quorum.** Treat as one critic.

## Verdict

kxm has a usable *shape* (Commander tools, shared worker envelope, factory mapped into `.kxm`). It is **not** a thorough replacement for SSSF yet, and the original “standardize CLI + packages/skills + assets + sessions + telemetry improve loop” request is **partially implemented**.

Do not call this done.

## Severity

| ID | Area | Sev | Finding |
|---|---|---|---|
| KXM-1 | harness | high | Four-critic MOA never executed; only grok wrote a review |
| KXM-2 | harness | high | `kxm improve` existed as a function but was not a CLI command until this pass |
| KXM-3 | documentation | high | Skill `kxm-mesh` still teaches `mesh_*` tools, not `kxm agent/session/workflow/gate` |
| KXM-4 | implementation | high | Plugin/package names mixed: `@kontextmind/pi-extensions`, plugin `kxm-mesh`, bins `kxm` + leftover `pi-mesh-*` |
| KXM-5 | gates | med | SSSF `writes:` / `protected_files` not ported; `--tools` is not a path boundary |
| KXM-6 | workflow | med | Session mix/workflow start writes JSON; does not launch workers or bind `KXM_SESSION_ID` for children |
| KXM-7 | harness | med | `session stop` and `mesh stop` are the same PID drain |
| KXM-8 | documentation | med | Dist artifacts likely stale vs Commander CLI source |
| KXM-9 | security | med | Telemetry JSONL can contain command details; no retention/redaction policy beyond “don’t fail the command” |
| KXM-10 | workflow | low | Factory ADWs simplified; ticket/simple-sdlc lose retry loops (`test_i`/`fix_i`) |
| KXM-11 | other | low | Dashboard is spec-only (correct); SSSF `just obs` still the only live UI |

## What we asked vs what exists

| Ask | Status |
|---|---|
| Separate critics fable / gpt-sol / kimi / grok @ max thinking | **Roster only.** Grok review exists. Others are stubs. |
| Suggest improvements / simplify / standardize CLI | **Partial.** Commander namespaces exist. Dual stop, leftover `pi-mesh` bins, skill lag. |
| Standardize extensions / packages / skills (local + mesh) | **Not done.** One plugin blob; no neuro vs neuro-mesh split; skill not rewritten for kxm CLI. |
| Organize assets per workflow | **Convention + session start mkdirs.** Not used by hub/workflows automatically. |
| Session = mix of agents+gates **or** a workflow | **CLI `kxm session start --mix\|--workflow`.** Does not spawn anyone. |
| Telemetry JSONL | **Agent/gate `printWorker` appends `.kxm/logs/telemetry.jsonl`.** Mesh/session/workflow inspect commands do not. |
| Process that uses logs to improve CLI **and** project setup | **`kxm improve --target cli\|project`** now registered. Heuristic bucket counts, not an LLM critic. |
| Factory → kxm, no sssf folder | **PayK12 `.kxm/config` mapping.** Python ADWs still on `kxm-dev-svr`. |

## Improve kxm (product)

1. Rebuild `plugins/kxm-mesh/dist` and drop or alias `pi-mesh` / `pi-mesh-hub` / `pi-mesh-worker` bins.
2. Rewrite the skill around `kxm` tools; keep `mesh_*` as the *agent-to-agent* protocol, not the operator CLI.
3. One stop command. Alias the other.
4. Bind session id: `kxm session start` should print `KXM_SESSION_ID=` and worker spawn should inherit it.
5. Port SSSF `writes:` as a gate (`artifacts-exist` + unauthorized path rollback) before claiming factory parity.
6. `kxm improve` should classify `cli` vs `project` with an explicit field on telemetry, not `PI_MESH_PROJECT===payk12`.
7. Do not implement the dashboard until JSONL + session files are the boring path (see `docs/kxm-observability-dashboard.md`).

## Improve PayK12 (project custom)

1. Keep conversion in `.kxm/config/workflows/factory-*.json`. Do not clone `factory/` onto Windows.
2. Replace coordinator/reviewer names in leftover Jira workflow if it still points at generic mesh identities.
3. When fable/gpt-sol/kimi workers exist, run `kxm-moa-review` for real; until then degrade quorum and label grok-only.
4. Point `kxm improve --target project` at PayK12 telemetry once a hub actually runs factory-ticket.

## Tests still owed

- `kxm session start --mix` / `--workflow` creates asset dirs + session.json
- agent/gate commands append telemetry.jsonl
- `kxm improve` writes `kxm.improvement-report.v1`
- `kxm mesh init` extra asset dirs vs package-install snapshot
- envelope `thinking` on agent workers
