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
# These four recipes are low-level harness transport. They do not mint
# assignment, witness, or acceptance proof. Prefer just assign for that.

# implement a unit with the current writer: just impl brief.md [worktree]
# Native grok only. There is no Pi writer fallback. Effort default: medium.
impl BRIEF CWD=".":
    @node -e 'const [prompt_file, cwd] = process.argv.slice(-2); process.stdout.write(JSON.stringify({schema:"kxm.harness-request.v1",role:"writer",harness:"grok",model:"grok-4.6",effort:"medium",permission:"edit",prompt_file,cwd}))' -- "$1" "$2" | {{run}} -

# plan a unit, read-only, independent of the writer: just plan brief.md
plan BRIEF CWD=".":
    @node -e 'const [prompt_file, cwd] = process.argv.slice(-2); process.stdout.write(JSON.stringify({schema:"kxm.harness-request.v1",role:"planner",harness:"claude",model:"fable",effort:"medium",permission:"read-only",prompt_file,cwd}))' -- "$1" "$2" | {{run}} -

# review architecture and permissions, read-only: just review-arch brief.md
review-arch BRIEF CWD=".":
    @node -e 'const [prompt_file, cwd] = process.argv.slice(-2); process.stdout.write(JSON.stringify({schema:"kxm.harness-request.v1",role:"reviewer-arch",harness:"claude",model:"fable",effort:"medium",permission:"read-only",prompt_file,cwd}))' -- "$1" "$2" | {{run}} -

# review CLI surface and docs, read-only, different provider: just review-cli brief.md
review-cli BRIEF CWD=".":
    @node -e 'const [prompt_file, cwd] = process.argv.slice(-2); process.stdout.write(JSON.stringify({schema:"kxm.harness-request.v1",role:"reviewer-cli",harness:"codex",model:"gpt-5.6-sol",effort:"low",permission:"read-only",prompt_file,cwd}))' -- "$1" "$2" | {{run}} -

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

# ── assignment runner ───────────────────────────────────────────────────────
# The normal dev entry: a closed kxm.assignment.v1 manifest plus the current
# plan. These recipes mint assignment, witness and acceptance proof; the
# impl/plan/review-* recipes above are transport only and never do. Every path
# is absolute — the runner refuses a relative one, so no quoting is needed.

# dispatch a bound assignment: just assign /abs/manifest.json
assign MANIFEST:
    @node scripts/assignment-run.mjs run --manifest "$1"

# run the fixed verification witness for an existing assignment: just witness /abs/record-dir
witness RECORD:
    @node scripts/assignment-run.mjs witness --record-dir "$1"

# stamp or advance the current-plan pointer with a generation check
plan-current TASK PLAN SHA COMMIT GENERATION:
    @node scripts/assignment-run.mjs plan-current --task-dir "$1" --plan "$2" --sha256 "$3" --base-commit "$4" --expected-generation "$5"

# attach a private attribution note (never proof): just attribute /abs/task /abs/record <class> /abs/note.txt
attribute TASK RECORD CLASS EXPLANATION:
    @node scripts/assignment-run.mjs attribute --task-dir "$1" --record-dir "$2" --class "$3" --explanation-file "$4"

# import one historical cost observation as cost-only, no native proof
observe-cost TASK INPUT:
    @node scripts/assignment-run.mjs observe-cost --task-dir "$1" --input "$2"

# bind an exact witnessed commit with both critic PASS records
accept TASK COMMIT WRITER ARCH CLI:
    @node scripts/assignment-run.mjs accept --task-dir "$1" --commit "$2" --record-dir "$3" --critic "$4" --critic "$5"

# report attempts, rework, costs and retained verification history
change-report TASK:
    @node scripts/assignment-run.mjs change-report --task-dir "$1"

# ── release hygiene ─────────────────────────────────────────────────────────
# Clean-container install smoke of the packed tarball: fresh pi + fresh hub +
# first-run flow. Needs a running docker daemon, a pass-cli session, and the
# local pi models store; secrets stay inside a mode-600 temp env file.
docker-install-smoke:
    @node scripts/docker-install-smoke.mjs
