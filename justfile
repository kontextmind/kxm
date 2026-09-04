# KXM headless harness recipes.
#
# One common envelope in, one common envelope out, whichever provider CLI runs.
# Role routing comes from AGENTS.md; CLI mechanics from .claude/harness-cli.md.
# Conventions here follow the SSSF factory justfile in payk12-win.

set dotenv-load
set positional-arguments
# Recipes are sh syntax. On Windows that is Git Bash's sh; plain -c (not just's
# default -cu) because Git's /etc/bash.bashrc trips over `set -u`.
set windows-shell := ["sh", "-c"]

run := "node scripts/harness-run.mjs"
briefs := env_var_or_default("KXM_BRIEF_DIR", ".kxm/briefs")

# list every recipe
default:
    @just --list

# ── dispatch ────────────────────────────────────────────────────────────────
# Each recipe builds a kxm.harness-request.v1 envelope and prints a
# kxm.harness-result.v1 envelope. BRIEF is a path to a Markdown brief; never an
# inline prompt, which is how the shell-quoting bugs get in.

# (`just --list` shows only the LAST comment line, so that one is the summary.)

# implement a unit with the designated writer: just impl brief.md [worktree]
impl BRIEF CWD=".":
    @{{run}} - <<< '{"schema":"kxm.harness-request.v1","role":"writer","harness":"grok","model":"grok-4.6","effort":"high","permission":"edit","prompt_file":"{{BRIEF}}","cwd":"{{CWD}}"}'

# fallback writer, only when `grok` is logged out: just impl-pi brief.md
impl-pi BRIEF CWD=".":
    @{{run}} - <<< '{"schema":"kxm.harness-request.v1","role":"writer","harness":"pi","model":"xai/grok-4.6","effort":"medium","permission":"edit","prompt_file":"{{BRIEF}}","cwd":"{{CWD}}"}'

# plan a unit, read-only, independent of the writer: just plan brief.md
plan BRIEF CWD=".":
    @{{run}} - <<< '{"schema":"kxm.harness-request.v1","role":"planner","harness":"claude","model":"fable","effort":"high","permission":"read-only","prompt_file":"{{BRIEF}}","cwd":"{{CWD}}"}'

# review architecture and permissions, read-only: just review-arch brief.md
review-arch BRIEF CWD=".":
    @{{run}} - <<< '{"schema":"kxm.harness-request.v1","role":"reviewer-arch","harness":"claude","model":"fable","effort":"high","permission":"read-only","prompt_file":"{{BRIEF}}","cwd":"{{CWD}}"}'

# review CLI surface and docs, read-only, different provider: just review-cli brief.md
review-cli BRIEF CWD=".":
    @{{run}} - <<< '{"schema":"kxm.harness-request.v1","role":"reviewer-cli","harness":"codex","model":"gpt-5.6-sol","effort":"high","permission":"read-only","prompt_file":"{{BRIEF}}","cwd":"{{CWD}}"}'

# any harness by hand from a full envelope file: just dispatch request.json
dispatch REQUEST:
    @{{run}} "{{REQUEST}}"

# detached, survives Ctrl+C and dropped SSH: just impl-bg brief.md [worktree]
impl-bg BRIEF CWD=".":
    @mkdir -p .kxm/logs
    @nohup just impl "{{BRIEF}}" "{{CWD}}" > ".kxm/logs/impl-$(date +%Y%m%d-%H%M%S).json" 2>&1 &
    @echo "detached — follow with: just runs"

# ── isolation ───────────────────────────────────────────────────────────────

# one worktree per concurrent lane; two writers in one tree clobber each other
worktree UNIT:
    git worktree add "../kxm-{{UNIT}}" -b "{{UNIT}}" origin/main
    @echo "lane ready at ../kxm-{{UNIT}}"

# drop a finished lane: just worktree-drop a3-hub-bind
worktree-drop UNIT:
    git worktree remove "../kxm-{{UNIT}}"

# ── inspect ─────────────────────────────────────────────────────────────────

# which harnesses are installed and authenticated right now
harnesses:
    @for c in pi claude codex grok kimi gemini agy; do \
        p=$(command -v $c 2>/dev/null); \
        printf '%-8s %s\n' "$c" "$${p:-NOT INSTALLED}"; \
    done
    @echo "--- pi providers ---"
    @for p in xai anthropic openai google moonshot openrouter deepseek; do \
        printf '%-12s ' "$p"; pi auth check --provider $p 2>&1 | head -1; \
    done

# the last dispatch results: just runs
runs:
    @ls -t .kxm/logs/*.json 2>/dev/null | head -10 | while read f; do \
        printf '%s  ' "$f"; \
        node -e 'const r=require("fs").readFileSync(0,"utf8");const j=JSON.parse(r);console.log(j.ok?"ok":"FAIL",j.harness,j.effectiveModel??"",j.latencyMs+"ms","$"+(j.costUsd??0).toFixed(4))' < "$f" 2>/dev/null || echo "(unparsed)"; \
    done

# ── gates ───────────────────────────────────────────────────────────────────
# An envelope is a manifest of claims. These verify the claims after the fact.

# the commit gate
verify:
    npm run verify

# the PR gate
check-generated:
    npm run check:generated
