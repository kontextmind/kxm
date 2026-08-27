# Findings: SSSF factory → `.kxm`

Source: `kxm-dev-svr:~/source/payk12/factory`  
Target: `C:\source\payk12\.kxm` (no `sssf/` directory)

## Mapping (good)

| SSSF | kxm |
|---|---|
| `kind=agent` | `kxm.worker.v1` kind=agent driver=ai |
| `kind=code` | `kxm.worker.v1` kind=gate driver=code |
| `EnvelopeBase` | `kxm.worker-result.v1` |
| `sssf.config.yaml` agents | `.kxm/config/agents.json` |
| code phases | `.kxm/config/gates.json` |
| `adw_scout` | `factory-scout` |
| `adw_simple_sdlc` | `factory-simple-sdlc` |
| `adw_ticket_sdlc` | `factory-ticket` |
| `adw_data/sessions` | `.kxm/assets/sessions/<id>/` |
| `sssf.db` events | `.kxm/logs/telemetry.jsonl` (intended) |
| `just obs` | spec only (`docs/kxm-observability-dashboard.md`) |

## Lost in translation (must not pretend otherwise)

1. **Retry loops.** SSSF `test_i` / `fix_i` / `review_i` are a real state machine. kxm stages are a flat list with `maxAttempts`. You cannot `gate(envelope)` back into the same Pi session like SSSF does.
2. **`writes:` enforcement.** SSSF rolls back unauthorized repo edits in `permissions.py`. kxm `--tools` cannot stop `bash git checkout`.
3. **Typed triad.** SSSF: Pydantic type + `user.md` JSON example + `output_type=` call site. kxm: one envelope + additive fields. Fine for CLI; weak for planner/builder handoff until `PlanOutput`/`BuildOutput` become `details` schemas.
4. **Ticket ADW** still lives in Python on the server. JSON `factory-ticket.json` is a **story**, not a runner.
5. **Visualizer / tickets button** not ported (correct for now).

## Critics roster vs SSSF roster

SSSF: planner, builder, repro, scout, reviewer, documenter (Claude by default).  
kxm PayK12: grok (writer), fable, gpt-sol, kimi (critics).

Roles in `agents.json` `roles.planner=fable` etc. are **not read by any code**. Either load them in `kxm session start --workflow` or delete them.

## Recommendation

Keep Python factory on the server as the ticket runner until kxm can:

- spawn workers from a session record
- run code gates as subprocesses
- return envelopes into the same session

Until then, `.kxm` factory JSON is documentation + future `kxm workflow start`, not a replacement for `just ticket PK-1416`.
