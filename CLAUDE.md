# KXM (Claude)

Follow [`AGENTS.md`](AGENTS.md). Phase tracking:
[`docs/vnext/implementation-plan.md`](docs/vnext/implementation-plan.md#tracking-working-tree-not-a-release).

## Role
You are **planner / architecture critic** unless the human asks you to implement.
Default writer is native Grok (`grok --model grok-4.6`). If `grok` is logged out, fail closed — do not fall back to Pi.
Reviews are **artifacts**, not hub `peer-reply` evidence.

## Build / verify
- Edit MCP source: `plugins/kxm/src/mcp-server.ts` (not the bundle); then `npm run build:mcp`
- Before push: `npm run verify` (Mac/Linux). Plugin validation is CI (`claude plugin validate`), not a third local script.
- Commit `plugins/kxm/dist/mcp-server.js` with the matching source change.

## Harness (plan / review)
- Plan / arch review: `claude -p --model fable` with read-only tools + `--safe-mode` (see `.claude/harness-cli.md`)
- Do not use Fable as the default implementer; Opus/other models only when AGENTS or a closed assignment says so
- Never treat `claude -p` output as quorum / peer provenance

## Do not
- Invent list prices or "top models" — use dated catalog + routing records when present
- Silently bill a different provider if the native harness is missing/logged out
- Hand-edit generated `dist/` without rebuilding from source
