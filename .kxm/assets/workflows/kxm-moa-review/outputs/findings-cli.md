# Findings: kxm CLI

## Shape (keep)

```text
kxm agent worker
kxm session start|status|stop
kxm workflow list|get|start|export
kxm gate validate|degrade|signal|github watch
kxm improve [--target cli|project]
kxm mesh init|hub|status|stop|smoke
```

This is clearer than SSSF’s `just sdlc` + 15 `adw_*.py` entrypoints.

## Criticisms

**Operator vs protocol.** Humans should never need `kxm_send`. Agents should never need `kxm mesh hub`. The skill still mixes them. Split:

- Operator skill / README: `kxm …`
- Agent skill: `mesh_*` + envelopes

**Stop duplication.** `kxm session stop` and `kxm mesh stop` both drain PID files. Recommend:

- `kxm session stop` — workers
- `kxm mesh stop` — hub only  
or one `kxm stop` with `--role hub|worker`.

**Session start is a file writer, not a supervisor.** SSSF `adw_simple_sdlc.py` *spawns* planner then builder. `kxm session start --workflow factory-simple-sdlc` only mkdirs and writes `session.json`. That will confuse anyone coming from the factory.

**Improve is a histogram.** `buildImprovementReport` buckets `kind+command+outcome`. Useful as a smoke of the loop; not a critic. Do not advertise it as “uses logs to improve the CLI” until it emits actionable diffs or at least cites files.

**JSON flag on every command** is good. Dry-run on session start / improve must not create files — verify tests.

**Init directory list grew** (`standardAssetDirs`). `test/package-install.test.ts` still expects five paths. That test will fail until updated.

## Simplify

- Hide `mesh smoke` behind `KXM_SMOKE=1` only (already env-gated).
- Default `--json` when stdout is not a TTY.
- `kxm help` should list one example per tool, not Commander’s full option dump as the first thing an operator sees (add a `kxm` README card in repo root).
