# Findings: packages, extensions, skills

## Current surfaces (too many names)

| Surface | Name today | Should be |
|---|---|---|
| npm package | `@kontextmind/pi-extensions` | keep until a real 0.5 rename |
| bin | `kxm`, `pi-mesh-hub`, `pi-mesh-worker` | `kxm` only; hub/worker via `kxm mesh hub` / `kxm agent worker` |
| Claude plugin | `kxm-mesh` | `kxm` (core) + later `kxm-mesh` add-on for non-localhost |
| Pi extension path | `plugins/kxm-mesh/src/extension.ts` | same folder until split |
| Skill | `plugins/kxm-mesh/skills/kxm-mesh` | `kxm` operator skill + `kxm-mesh` peer-protocol skill |
| Env | `PI_MESH_*` | keep (compat); document as mesh transport, not CLI name |

## Local vs mesh

SSSF already had two backends (`claude_code` vs `pi`) per agent. kxm should have two **hosts**:

| Host | Hub | Skill load |
|---|---|---|
| `local` | `127.0.0.1:7331` | extension + operator skill |
| `mesh` | non-loopback + `NEURO_MESH=1` | same + mesh skill + auth |

`host.json` on PayK12 records this but nothing reads it yet. CLI `hostMode()` sniffs the hub URL instead. Pick one: file or URL, not both.

## Skill rewrite (owed)

The skill still starts “Call `mesh_list`”. Add a front-matter section:

1. If the user is an operator → `kxm …`
2. If you are a peer agent → `mesh_*`
3. Envelopes: always `kxm.worker-result.v1`

Until that lands, every Pi worker taught by the skill will ignore the CLI we just built.

## Dist / install

`scripts/kxm.mjs` runs `dist/cli.js`. Source `cli.ts` has Commander; **generated dist may be the old `pi-mesh` parser**. Release path is broken until `npm run build` and `check:generated`.

## Critic recommendation

Do not split neuro / neuro-mesh packages this week. Rename user-facing strings and skill first. Package split is a 0.5 that will churn Claude marketplace install instructions twice.
