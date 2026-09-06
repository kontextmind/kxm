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
# kxm.harness-result.v2 envelope. BRIEF is a path to a Markdown brief; never an
# inline prompt, which is how the shell-quoting bugs get in.
# User paths are "$1"/"$2" (positional-arguments) and JSON.stringify in Node.
# Recipe literals (role/harness/model) are not taken from user strings.

# (`just --list` shows only the LAST comment line, so that one is the summary.)

# implement a unit with the designated writer: just impl brief.md [worktree]
# Native grok only. There is no Pi writer fallback.
impl BRIEF CWD=".":
    @node -e 'const [prompt_file, cwd] = process.argv.slice(-2); process.stdout.write(JSON.stringify({schema:"kxm.harness-request.v1",role:"writer",harness:"grok",model:"grok-4.6",effort:"high",permission:"edit",prompt_file,cwd}))' -- "$1" "$2" | {{run}} -

# plan a unit, read-only, independent of the writer: just plan brief.md
plan BRIEF CWD=".":
    @node -e 'const [prompt_file, cwd] = process.argv.slice(-2); process.stdout.write(JSON.stringify({schema:"kxm.harness-request.v1",role:"planner",harness:"claude",model:"fable",effort:"high",permission:"read-only",prompt_file,cwd}))' -- "$1" "$2" | {{run}} -

# review architecture and permissions, read-only: just review-arch brief.md
review-arch BRIEF CWD=".":
    @node -e 'const [prompt_file, cwd] = process.argv.slice(-2); process.stdout.write(JSON.stringify({schema:"kxm.harness-request.v1",role:"reviewer-arch",harness:"claude",model:"fable",effort:"high",permission:"read-only",prompt_file,cwd}))' -- "$1" "$2" | {{run}} -

# review CLI surface and docs, read-only, different provider: just review-cli brief.md
review-cli BRIEF CWD=".":
    @node -e 'const [prompt_file, cwd] = process.argv.slice(-2); process.stdout.write(JSON.stringify({schema:"kxm.harness-request.v1",role:"reviewer-cli",harness:"codex",model:"gpt-5.6-sol",effort:"high",permission:"read-only",prompt_file,cwd}))' -- "$1" "$2" | {{run}} -

# any harness by hand from a full envelope file: just dispatch request.json
dispatch REQUEST:
    @{{run}} -- "$1"

# detached, survives Ctrl+C and dropped SSH: just impl-bg brief.md [worktree]
impl-bg BRIEF CWD=".":
    @mkdir -p .kxm/logs
    @nohup just impl "$1" "$2" > ".kxm/logs/impl-$(date +%Y%m%d-%H%M%S).json" 2>&1 &
    @echo "detached — follow with: just runs"

# ── isolation ───────────────────────────────────────────────────────────────

# one worktree per concurrent lane; two writers in one tree clobber each other
worktree UNIT:
    git worktree add -b "$1" -- "../kxm-$1" origin/main
    @echo "lane ready at ../kxm-$1"

# drop a finished lane: just worktree-drop a3-hub-bind
worktree-drop UNIT:
    git worktree remove -- "../kxm-$1"

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
    @ls -t .kxm/logs/*.json 2>/dev/null | head -10 | while read -r f; do \
        printf '%s  ' "$f"; \
        KXM_RESULT_FILE="$f" \
        node -e 'const fs=require("fs"); const file=process.env.KXM_RESULT_FILE||"-"; let j; try { j=JSON.parse(fs.readFileSync(0,"utf8")); } catch { console.log("(unparsed)"); process.exit(0); } const expected="kxm.harness-result.v2"; const observed=(j&&j.schema)||"none"; if (observed!==expected) { console.log(file+": observed schema "+observed+"; obsolete result schema kxm.harness-result.v1; expected "+expected); process.exit(0); } const b=j.costBasis; let cost="unknown"; if (b==="unmetered") cost="unmetered"; else { const n=typeof j.costUsd==="number"&&Number.isFinite(j.costUsd)?j.costUsd:undefined; const est=typeof j.providerReportedCostUsd==="number"&&Number.isFinite(j.providerReportedCostUsd)?j.providerReportedCostUsd:undefined; const amount=n??est; if (b==="unknown"||b==null||amount===undefined) cost="unknown"; else if (b==="list") cost="list $"+amount.toFixed(4); else if (b==="billed") cost="billed $"+amount.toFixed(4); else cost=String(b)+" $"+amount.toFixed(4); } console.log(j.ok?"ok":"FAIL", j.harness??"", j.effectiveModel??"", (j.latencyMs??"?")+"ms", cost);' < "$f" 2>/dev/null || echo "(unparsed)"; \
    done

# ── gates ───────────────────────────────────────────────────────────────────
# An envelope is a manifest of claims. These verify the claims after the fact.

# the commit gate
verify:
    npm run verify

# the PR gate
check-generated:
    npm run check:generated
