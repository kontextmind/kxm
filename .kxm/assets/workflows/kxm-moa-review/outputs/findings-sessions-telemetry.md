# Findings: sessions, assets, telemetry

## Sessions

`kxm.session.v1` supports `mode: mix | workflow`. That matches the ask.

Gaps:

- Start does not set a durable “current session” except whatever the operator exports as `KXM_SESSION_ID`.
- `session status` lists PID claims and recovery envelopes, **not** `assets/sessions/*/session.json`.
- Mix names that are missing from agents.json/gates.json silently become `gateWorker({name})` — a typo becomes a fake code gate.

## Assets

Intended layout:

```text
.kxm/assets/workflows/<id>/{inputs,outputs,generated}
.kxm/assets/sessions/<id>/{inputs,outputs,session.json}
.kxm/assets/improvements/<timestamp>.json
```

`kxm session start` creates those dirs. Hub workflow runs do **not**. A Jira webhook will not drop artifacts in `workflows/factory-ticket/PK-1416/` unless the agent is told to. Put the path in every stage `instructions` (already true for converted JSON) and in the skill.

Gitignore: add `assets/sessions/*/outputs`, `assets/workflows/*/generated`, keep `session.json` if you want the mix checked in.

## Telemetry

`printWorker` appends `kxm.telemetry.v1` wrapping the worker envelope. Good.

Gaps:

- `kxm mesh *`, `kxm workflow list/get/start`, `kxm session status` do not go through `printWorker` → invisible to improve.
- Target inference (`payk12` or `factory-*` → project) is a hack. Put `target` on the session record and copy it.
- No rotation. JSONL will grow; SSSF used SQLite WAL with a UI. Either rotate or cap.
- Redaction uses existing CLI redactors on stdout; the file write JSON.stringifies the envelope **before** `print()` redaction. **Fix:** redact before `appendTelemetry`.

## Improve process

`kxm improve --target cli|project` writes `kxm.improvement-report.v1` with `reviewDecision: proposed`.

That is the right *shape* (same as retrospectives). The *content* is counts, not critiques. Next step: feed the report + FINDINGS.md to the four critics (when workers exist), don’t replace critics with the histogram.
