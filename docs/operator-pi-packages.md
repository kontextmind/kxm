# This host's Pi packages

Snapshot of the operator Pi user packages and file extensions on this KXM
development host (2026-09-10). It is **not** a KXM install requirement and is
**not** copied by `kxm init`. `pi list` is authoritative; this page is a
checked-in copy for agents working in this repository.

## User packages (`pi list`)

| Source | Version | What it loads |
|---|---|---|
| `npm:pi-antigravity` | 0.7.2 | Antigravity / Cloud Code Assist provider (`./src/index.ts`) |
| `git:git@github.com:kontextmind/kxm.git@main` | 0.6.0 (`10a1b77` at snapshot) | KXM Pi extension and Agent Skills |
| `npm:@xynogen/pix-core` | 0.5.38 | pix UI/tool aggregator (`src/extension.ts`); activates bundled pix members, not separate `pi list` sources |
| `npm:@tian.zuo/pi-antigravity` | 0.10.3 | Antigravity via `agy` stream-json (`./index.ts`) |
| `npm:@latentminds/pi-quotas` | 0.5.0 | Quota and usage status commands |
| `npm:pi-provider-kimi-code` | 0.6.12 | Kimi Code provider (`./index.ts`) |

Install roots on this host:

- npm: `%USERPROFILE%\.pi\agent\npm\node_modules\`
- git KXM: `%USERPROFILE%\.pi\agent\git\github.com\kontextmind\kxm`

Project-local Pi extension (gitignored `.pi/`): `.pi/extensions/rtk.ts` from
`rtk init --agent pi`. User-level `~/.pi/agent/extensions/rtk.ts` is also
installed.

## File extensions

Loaded from `%USERPROFILE%\.pi\agent\extensions\` (not shown by `pi list`):

| File | Role |
|---|---|
| `rtk.ts` | RTK bash rewrite via `rtk rewrite`; needs `rtk` 0.23 or newer on `PATH` |
| `quotas.json` | Config for `@latentminds/pi-quotas`, not an extension factory |

`rtk` 0.48.0 is installed as winget `rtk-ai.rtk`. New shells pick up the User
`PATH` entry. `pix-core` also activates `pix-optimizer`, which can rewrite
commands for RTK independently of `rtk.ts`.

## Notes

- The antigravity provider is bundled inside `plugins/kxm` (vendored from
  pi-antigravity, MIT); remove any standalone pi-antigravity Pi extension to
  avoid the double-registration warning. `pi-antigravity` and
  `@tian.zuo/pi-antigravity` are different Pi providers. For Google, this bundled
  provider **is** the admitted route (Tracking → Decided, 2026-09-15); `agy` stays a
  catalog/helper entry rather than the admission path.
- For KXM development loads, prefer the working tree:
  `pi --no-extensions -e ./plugins/kxm/src/extension.ts`. Add every required
  provider extension with another `-e`; otherwise Pi discovery is disabled.
  See [Troubleshooting](troubleshooting.md#pi-shows-huboff).
- Refresh this page when `pi list` or
  `%USERPROFILE%\.pi\agent\extensions\` changes.

## Project-scoped RTK (this checkout)

`rtk init` in this repository (2026-09-10). Not copied by `kxm init`.

| Path | Role |
|---|---|
| `RTK.md` | Slim RTK instructions for Codex and `@RTK.md` includes |
| `AGENTS.md` | `@RTK.md` reference (Codex / Kimi) |
| `CLAUDE.md` | `@RTK.md` reference (Claude Code) |
| `.rtk/filters.toml` | Project filter template |
| `.agents/rules/antigravity-rtk-rules.md` | Antigravity rules |
| `.pi/extensions/rtk.ts` | Project Pi rewrite extension (gitignored) |
