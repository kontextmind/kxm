---
schema: "kxm.doc.v1"
id: "HANDOFF-2026-09-24"
type: "handoff"
title: "Session handoff 2026-09-24: CI pause, grok-4.7, Mesh cutover, runner grouping, public tenant hub edge, learning cycle, tenant architecture"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-24"
updated: "2026-09-24"
authority: "instruction"
confidence: "medium"
summary: "State at handoff plus the full session execution plan (CI pause/local pipeline, grok-4.7 writer, Mesh cutover, SQLite concurrency witness, public tenant hub edge, learning cycle, tenant architecture records) for a fresh agent to continue on kxm-dev-svr."
tags: ["handoff", "session-continuity", "tenant-hub", "cross-host", "mesh-cutover", "grok-4.7"]
related:
  - ../implementation-plan.md
  - ../plan-per-tenant-hosting.md
  - 2026-09-24-unified-plan-fable.md
depends_on: []
blocked_by: []
---

# Session handoff 2026-09-24

## State at handoff

- `main` = `origin/main` = `7561b5b` (Opus admitted as planner/reviewer-arch). No open PRs or issues. The working tree was clean before this branch.
- No phase of the session plan below has been executed. CI is still active, the writer is still `grok-4.6`, and Mesh names are still present.
- Scouts ran on omp `modelRoles.smol` = `xai-oauth/grok-4.7`; the planning session ran on `claude-opus-5-5`.
- Hub: local hub down. kxm-dev-svr hub is healthy on `127.0.0.1:7331` (host, not a tenant VM), `kxm-hub`/`kxm-runtime`/`kxm-studio` services are active, and the remote `hub-env.json` has an admin token and empty `projectTokens`.
- Edge map:
  - Caddy VM 230 `dvp-caddy` @ `10.30.40.10`, sites in `/etc/caddy/workspaces/*.caddy`, `admin off`;
  - Authentik @ `10.30.30.20:9000` / `id.kxmd.dev`;
  - Studio `https://studio.kxmd.dev` → `10.31.0.2:4242`, gate `kxm-tenant-admin`;
  - public SSH gateway `*.kxmd.sh` (99.62.5.214) reaches workspace VMs only.
- Proxmox guests of note: `dvp-ws-kxm` (302, stopped), `dvp-ws-kxmdev` (301, stopped), `dvp-ws-pilot` (300), `kxm-dev-build` (310).
- Omp MCP route `kxm:kxm` is broken: `${user_config.server_url}` is not expanded by omp.
- `kxm improve report --dry-run --json` over this checkout: 0 records. `kxm routing report --json`: 0 attempts. `kxm suggest` recommends `software-engineering/feature-implementation`, which is not defined (only `default` exists).
- Real runner history exists at `C:/projects/kxm-tasks/omp-host-harness/{u6-omp-host,u7-omp-harness,u8-omp-oneshot,replan-1}` on the Windows machine only. The Phase 6 export needs it. On kxm-dev-svr, copy it first with `scp -r` from Windows, or run Phase 6 from Windows.
- **Security action open:** during edge discovery, the `app.kxmd.io` TLS private key (`/etc/caddy/domains/app.kxmd.io.key` in VM 230) was printed into the planning transcript. Re-issue that certificate and key.
- Pending operator inputs, needed before Phase 2 step 2: create Authentik service account `kxm-provisioner` with the scoped role and export `AUTHENTIK_TOKEN`; confirm or create DNS for `hub-onesm.kxmd.dev`.
- How to continue on kxm-dev-svr: use a **separate** clone, never `/home/sysadmin/source/kxm` (it backs the live services):

  ```bash
  git clone https://github.com/kontextmind/kxm ~/work/kxm
  cd ~/work/kxm
  git switch handoff/2026-09-24
  ```

  Then open the handoff doc and execute from Phase 0. On kxm-dev-svr, Phase 0's pipeline host is that Linux box itself, not WSL: run the Phase 0 step 3 script with `SRC=~/work/kxm`, in a second clone `~/src/kxm-pipeline`. `kxm-dev-svr` has Node 22.23.2 under `/home/sysadmin/.local/share/pi-node`. Install Node 24 via nvm for the Nightly leg.

## Local pipeline + CI pause, grok-4.7 writer, Mesh cutover, runner grouping, SQLite concurrency witness, kxm-dev-svr hub link, learning cycle, tenant architecture records

### Context

The operator asked, in order, for these, all in the KXM repo at `C:/projects/kxm`:

- continue the recorded gap "developer assignment-runner records do not group", using KXM workflows;
- move the writer to `grok-4.7`;
- run the self-improvement learning cycle;
- a permanent connection to the `kxm-dev-svr` hub;
- wipe every leftover Mesh name;
- run all pipeline tests locally and disable the GitHub test pipelines (single user);
- write down a revised tenant architecture.

When this plan is done:

- every code change has landed through the repo's gates;
- CI test workflows are paused and replaced by a local WSL pipeline;
- this Windows machine is bound to the kxm-dev-svr hub across reboots;
- the learning cycle has run over all developer-runner history;
- the tenant architecture decisions sit in reviewable ADR, plan and Tracking records.

Building the tenant edge, migrations, the auth/usage broker, failover and Studio management comes in later plans. Phase 7 names them.

### Decisions (operator, 2026-09-24): record each in Tracking → Decided (`plans/implementation-plan.md`, under `### Decided`, newest first, same bullet style as the 2026-09-20 "Single operator" entry)

1. **CI test pause.** GitHub workflows `CI`, `Nightly` and `Real Pi smoke` are disabled server-side, and required status checks are removed from ruleset `protect-main`. `Auto-Release` and `Release` stay on, because tenant VMs will upgrade from releases and `Release` still runs `validate:ci`. Before any merge, the local WSL pipeline (Phase 0) is the gate. Workflow files stay unchanged, so re-enabling is a single `gh workflow enable` plus restoring the saved ruleset.
2. **Writer route.** The Grok writer moves from `grok-4.6` to `grok-4.7`. This covers this repo's developer runner and this repo's own `.kxm` config. Product defaults stay `grok-4.6`: the `kxm init` template, the engine implementer fallback, guide candidates, role/modes/subagent defaults, `.kxm/prices.yaml` and the inventory.
3. **Mesh names.** Every live-code Mesh identifier is renamed with a clean cutover and no aliases. The four `pi-mesh.*` schema ids become `kxm.*`, and the old ids are refused. `plans/history/**`, `CHANGELOG.md` and `.kxm/assets/workflows/*/outputs/**` stay archival. A source-level brake test holds the cutover.
4. **Storage.** SQLite stays the store, one set per tenant VM (ADR-0003). Operator condition: users and agents must not cause lock problems. The Phase 4 concurrency witness enforces it. Postgres is used only per tenant, never shared, and only on these triggers: an HA or multi-process hub, measured sustained write contention within one tenant, or retained cross-hub history (served by a disposable projection).
5. **Tenancy.** A tenant is a kxmd-portal account, personal or organizational, with three roles:
   - `owner`: the plan subscriber;
   - `admin`;
   - `standard`: no settings access.

   Each tenant gets one KXM VM in its plan. It is not counted as a plan VM, only as CPU and disk. It runs the hub, the Runtime, Studio and the wiki. Everything is reached through Authentik, with groups per tenant.
6. **Public tenant hub.** Amends ADR-0004 for hosted tenants only. Off-VM clients (remote agents, MCP/Claude Code, peers, remote Runtimes) send `Authorization: Basic <per-machine Authentik service account>:<app password>` to the edge, and send the hub bearer in `X-Kxm-Hub-Authorization`. After auth, Caddy relays that bearer into `Authorization` (header relay; see Phase 2). On-VM clients stay on loopback. The Runtime supervisor listener stays loopback-only. Laptop `kxm hub start` does not change.
7. **Upgrades.** The 2026-09-20 "no migrations" rule is superseded for hosted tenants:
   - Stores get forward-only startup migrations inside `BEGIN IMMEDIATE`.
   - An automatic verified `kxm backup` runs before each migration, and a failed migration triggers a restore.
   - Rollout is staged: a per-tenant version pin, canary `kxm-dev-svr` first, then the rest.
   - A daily per-VM timer runs `kxm update --self --extensions --models --json`. `--kxm` runs only during a staged rollout.
8. **Central config and provider auth.** Tenant configuration (roles, gates, models, providers) and provider OAuth sessions live centrally per tenant on the tenant VM, managed in Studio. After one tenant login, a new machine or project using Pi, the kxm CLI, Claude Code or omp pulls them. Chat-driven setup from Studio is backlog.
9. **Usage and budgets.** A per-tenant KXM auth broker modeled on omp's `@oh-my-pi/pi-ai` auth-broker (`GET /v1/usage`, observed 5h/7d windows, per-credential blocks until reset, reserve %) is the usage source. Declared `.kxm/budgets.yaml` limits are the enforced floor for providers without a usage API. The role roster becomes an executable failover chain on `quota`, `rate_limit` and `auth`, with a cooldown revert.

Decisions 5–9 become records in Phase 7. Their builds are later plans.

### Conventions used by every phase

- **Shell prefix:** repo rules require `rtk` before shell commands (`rtk git status`, `rtk npm run verify`).
- **Local pipeline** = `~/bin/kxm-pipeline <branch-or-sha>` in WSL (Phase 0). A merge needs a green pipeline run on the exact head SHA. The log path goes in the PR body.
- **PR loop:** push branch → `gh pr create` → run local pipeline → `gh pr merge <n> --rebase --delete-branch` (ruleset `default-rebase`; no checks remain to wait for) → `rtk git pull` on `main` → `just worktree-drop <unit>` if a worktree was used. PRs that change no shipped code get label `no-release`, which `auto-release.yml` honors: Phase 0 docs, Phase 7.
- **Runner slices** (Phases 3, 4, 5) use the repo's issue-127 developer runner exactly as `docs/contributing/assignment-runner.md` describes: `just plan-current` → `just assign` writer → stage → `just witness` → two critic assignments → commit → `just accept` → PR loop. Roster (`.kxm/roster.yaml`):
  - writer `grok-native`: `grok`/`grok-4.7` after Phase 1, effort `medium`, permission `edit`;
  - `review-arch`: `claude`/`opus`, effort `medium`, `read-only`;
  - `review-cli`: `codex`/`gpt-5.6-sol`, effort `low`, `read-only`.

  If the writer fails, retry once as `repair` with `rework_of`. If it fails again, switch to relief writer `qwen-openrouter-pi` (`pi`/`openrouter/qwen/qwen3-coder-plus`) only after `pi auth check --provider openrouter` passes. A critic BLOCK → `repair` + fresh critics (with `rework_of` back to the BLOCK review if the tree is unchanged).
- **Runner layout:** every task dir is `C:/projects/kxm-tasks/<task-id>` (final segment = task id), and its plan file is `C:/projects/kxm-tasks/plan-<task-id>.md`. The plan file contents are the matching "Slice spec" section of this plan, copied verbatim. Get its sha256 with `node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" <plan>`. Worktree: `just worktree <task-id>` → `C:/projects/kxm-<task-id>`.
- **Manifests:** writer manifest `<task_dir>/asg-writer-1.json` is shaped exactly like the example in `docs/contributing/assignment-runner.md` §2:
  - `kind: "implement"`, `base: {"kind":"clean","commit":"<HEAD of worktree>"}`;
  - `plan_ref: {"kind":"current","path":<plan>,"sha256":<sha>}`, `inputs: []`;
  - `contract.witness.id: "verify"`, `contract.deferred: []`;
  - `output_dir` = `<task_dir>/asg-writer-1`;
  - `contract.boundary` and `contract.deliverables` come from the slice.

  Critic manifests `asg-review-arch-1.json` / `asg-review-cli-1.json` use `kind: "review-arch"` / `"review-cli"`, `base: {"kind":"staged","commit":"<HEAD>","index_tree":"<git write-tree>"}` (validated by `validateBase`, `scripts/assignment-run.mjs:626`), the same boundary, `deliverables: []` and `witness.id: "verify"`.
- **KXM task record:** for each runner slice, run `kxm task create "<slice title>" --workflow default --objective "<one line>" --json` for tracking only. `kxm suggest` proposes `software-engineering/feature-implementation`, which `kxm workflow definitions` does not list; `default` is the only defined workflow. Never run `kxm task run`: it drives the Runtime with live spend and bypasses the runner.
- **Secrets:** never read, print or store hub tokens. The only token movement is the operator-run command in Phase 2.

### Approach

#### Phase 0 — Local pipeline in WSL, then pause CI tests (root; ops + one docs PR)

Independent of the other phases. Runs first so every later PR has a gate.

1. **Start WSL and check tools:** `wsl -d Ubuntu -- bash -lc 'node -v; git --version; command -v gh; nproc'`.
   - If `~/.nvm` is missing: `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`.
   - Then `source ~/.nvm/nvm.sh && nvm install 24 && nvm install 22.19.0`. These match the CI legs (Node 22.19.0, 24) and Nightly (24).
2. **Clone:** `git clone /mnt/c/projects/kxm ~/src/kxm`. It's a local clone, so no network auth is needed. Always run on the WSL filesystem, never `/mnt/c`.
3. **Write `~/bin/kxm-pipeline`** (WSL home, not in the repo; mode 755). It takes one arg, a ref reachable from `/mnt/c/projects/kxm` or a worktree path plus branch:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   REF="$1"; SRC="${2:-/mnt/c/projects/kxm}"
   cd ~/src/kxm
   git fetch --force "$SRC" "$REF:refs/remotes/local/pipeline"
   git checkout --force --detach refs/remotes/local/pipeline
   git clean -fdx -e node_modules
   SHA=$(git rev-parse HEAD); LOG=~/kxm-pipeline-logs/$SHA-$(date -u +%Y%m%dT%H%M%SZ).log
   mkdir -p ~/kxm-pipeline-logs
   {
     source ~/.nvm/nvm.sh
     nvm use 24
     npm ci
     npm run verify
     npm run test:coverage:complete
     npm pack --dry-run
     npm install --no-save --ignore-scripts @anthropic-ai/claude-code@2.1.261
     node node_modules/@anthropic-ai/claude-code/install.cjs
     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ./node_modules/.bin/claude plugin validate . --strict
     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ./node_modules/.bin/claude plugin validate plugins/kxm --strict
     nvm use 22.19.0
     npm ci
     npm run validate:pr
   } 2>&1 | tee "$LOG"
   echo "PIPELINE PASS $SHA $LOG"
   ```

   These are the exact commands of `ci.yml` (Validate on both Node legs, Plugin validation) and `nightly.yml` (coverage floors, check, generated, pack), with no new npm script. `Real Pi smoke` is live spend and dispatch-only, so it stays manual and out of the pipeline.
4. **Baseline:** `~/bin/kxm-pipeline main`. If it is red, record the failing test names and commands in Tracking → Still open as "WSL baseline failures (2026-09-24)". From then on, a candidate passes when it adds **no new** failure versus that list. Do not fix baseline failures in this plan.
5. **Pause CI:**
   - `gh workflow disable CI -R kontextmind/kxm`, `gh workflow disable Nightly -R kontextmind/kxm`, `gh workflow disable "Real Pi smoke" -R kontextmind/kxm`.
   - Save the ruleset: `gh api repos/kontextmind/kxm/rulesets/22251971 > C:/projects/kxm-tasks/ci-pause/protect-main-2026-09-24.json`.
   - PUT back a body with `name`, `target`, `enforcement`, `conditions`, `bypass_actors`, and `rules` minus the element whose `type` is `"required_status_checks"`: `gh api -X PUT repos/kontextmind/kxm/rulesets/22251971 --input <body.json>`.
   - Keep the `deletion`, `non_fast_forward` and `pull_request` rules.
6. **Docs PR** (branch `ci-pause-local-pipeline`, label `no-release`):
   - `AGENTS.md` "Verify and ship": in the **PR/MR and main** row, replace the CI text with: CI test workflows paused 2026-09-24 (single operator); `CI`, `Nightly` and `Real Pi smoke` are disabled; the gate before merge is the local WSL pipeline `~/bin/kxm-pipeline`, which runs the same `validate:pr`, Plugin validation and nightly commands; `Release` still runs `validate:ci`.
   - "PR loop" paragraph: replace "enable auto-merge, watch CI on a background worker" with "run the local pipeline on the PR head, then `gh pr merge --rebase`".
   - Add Decided entry 1.
   - If a test fails only because it pins AGENTS.md CI prose, delete that assertion; it is a wording test.

#### Phase 1 — Writer route → grok-4.7 (root PR `writer-grok-4-7`)

Independent of Phase 0 content. Must merge before Phases 3–5, because the runner loads `.kxm/roster.yaml` only from a checkout whose HEAD is an ancestor of `origin/main`.

- `.kxm/roster.yaml`: `routes.grok-native.model` → `grok-4.7`.
- `scripts/harness-run.mjs` `ROUTES.grok.models` (≈line 140) → `Object.freeze(["grok-4.7"])`, a clean cutover: 4.6 is no longer admitted for the runner.
- `justfile` `impl` recipe (≈line 45): `model:"grok-4.7"`.
- `test/core/harness-run.test.ts`:
  - line ≈1501 regex → `/role:"writer",harness:"grok",model:"grok-4\.7",effort:"medium"/`;
  - every request-model literal `"grok-4.6"` in grok request objects and argv (≈lines 123, 126, 134, 408, 415 `"-m", "grok-4.6"`, 581, 769, 936, 967, 991, 1116) → `"grok-4.7"`;
  - leave `"grok-4.6-build"` usage keys, line ≈590 `effectiveModel`, line ≈922, and `openrouter/x-ai/grok-4.6` / `xai/grok-4.6` Pi-brake cases unchanged. They are observed-output fixtures and vendor brakes, not admission.
- This repo's product config, changed together so the loader check `role_roster_conflicts_with_agent` holds:
  - `.kxm/agents/implementer.yaml` `model: grok-4.7`;
  - `.kxm/roles/writer.yaml` first entry `model: xai/grok-4.7`;
  - `.kxm/routes.yaml`: replace `xai/grok-4.6` with `xai/grok-4.7` in `admitted` and in `roles.implementer`, and set `updatedAt: '2026-09-24T00:00:00.000Z'`.
- Operator docs that name the dev writer: `AGENTS.md:38`, `CLAUDE.md:7`, `.claude/harness-cli.md:32,68`, `.claude/commands/headless-impl.md:17,33`, `docs/contributing/assignment-runner.md:36,118` → `grok-4.7`.
- Tracking → Decided entry 2.
- Check: `node --input-type=module -e "import('./scripts/harness-run.mjs').then(m=>{m.preflightRequest({schema:'kxm.harness-request.v1',role:'writer',harness:'grok',model:'grok-4.7',effort:'medium',permission:'edit',prompt_file:'C:/projects/kxm/README.md'});try{m.preflightRequest({schema:'kxm.harness-request.v1',role:'writer',harness:'grok',model:'grok-4.6',effort:'medium',permission:'edit',prompt_file:'C:/projects/kxm/README.md'});console.log('FAIL 4.6 admitted')}catch(e){console.log('ok 4.6 refused:',e.runnerCode??e.message)}})"` must print `ok 4.6 refused`. Then run `rtk npm run verify`, the local pipeline, and merge.

#### Phase 2 — Public tenant hub edge for `kxm-dev-svr` (supersedes the earlier SSH-tunnel draft; the operator rejected Tailscale/LAN-only access)

Operator decisions (2026-09-24), recorded as Decided entries 10–13:

- **10. kxmd domains only.** No new KXM surface uses `*.theneuro.me`. Tracking's S5 row says `kxm-admin.host.theneuro.me`, but the live Studio edge is `https://studio.kxmd.dev` (`/etc/caddy/workspaces/kxm-admin.caddy`). Correct the row. Moving the other workspace sites off `*.host.theneuro.me` is dev-vm-platform backlog.
- **11. Hub hostname** `https://hub-<tenant>.kxmd.dev`, covered by the existing `*.kxmd.dev` cert. The first tenant slug is `onesm`. Backlog for kxmd-portal: the tenant slug is editable from the portal, and a rename updates the Caddy site, the Authentik provider external host, and the clients' bound URL. The portal also gets a tenant switcher for users who belong to several tenants.
- **12. Transport:** the HTTPS edge is primary. SSH (`ssh <workspace>.kxmd.sh`, the public gateway at 99.62.5.214, user `akadmin`, ed25519) stays backlog. Its trigger is a measured edge-latency problem or the hub moving onto its tenant VM. Today the gateway reaches workspace VMs, not the Proxmox host, and this machine has no `id_ed25519`.
- **13. Authentik objects are created by the agent** using a **scoped** Authentik token. The operator creates a service account `kxm-provisioner` with a role that has add/view/change on proxy providers, applications, groups, users and outposts, plus add policy bindings, and exports `AUTHENTIK_TOKEN` in the agent shell. App passwords go straight into the credential store and are never printed.

Edge facts, read 2026-09-24 through `ssh kxm-dev-svr` + `sudo -n qm guest exec`:

- Proxmox host `kxm-dev-svr`: vlan50 `10.31.0.2`, vmbr0 `192.168.68.54`, tailscale0 `100.123.122.113`.
- The hub runs **on the host** (`kxm-hub.service`, `127.0.0.1:7331`, user `sysadmin`, `KXM_STATE_HOME=/home/sysadmin/.local/state/kxm`), next to `kxm-runtime.service` and `kxm-studio.service`. Studio binds `10.31.0.2:4242`.
- Edge Caddy is VM 230 `dvp-caddy`, binding `10.30.40.10`; WAN 80/443 forward to it. Sites live in `/etc/caddy/workspaces/*.caddy` and are imported by `/etc/caddy/Caddyfile`. The global options set `admin off`.
- The Authentik outpost and server are at `10.30.30.20:9000`, with `id.kxmd.dev` → the same address.
- Studio gate: `@not_tenant_admin not header_regexp X-Authentik-Groups (^|,)kxm-tenant-admin(,|$)`, strip-then-proxy.
- Remote hub `hub-env.json` holds an admin token and an empty `projectTokens`, so the admin token authorizes any project (`hub.ts:595`). The local project name is `@kontextmind/kxm`.
- Authentik behaviour, from the docs: after accepting header auth it removes `Authorization`. Caddy `forward_auth` copies only the listed auth-response headers onto the **request**. The outpost's Set-Cookie therefore does not reach a headless client, and cookie + bearer (the earlier Decision 6 wording) cannot work.
- **Revised Decision 6 (header relay):** the client sends `Authorization: Basic base64(<service-account>:<app-password>)` for Authentik, and the hub bearer in `X-Kxm-Hub-Authorization: Bearer <project token>`. After auth, Caddy sets upstream `Authorization` from `X-Kxm-Hub-Authorization` and deletes that header. Caddy relays the client's own bearer and never injects a token.

Steps:

1. **Hub listen (host):**
   - add the systemd drop-in `/etc/systemd/system/kxm-hub.service.d/listen.conf` with `[Service]` / `Environment=KXM_HOST=0.0.0.0`;
   - list the Caddy VM's IPv4s with `sudo qm guest cmd 230 network-get-interfaces`;
   - write `/etc/kxm/hub-allow.nft`: table `inet kxm_hub`, chain `input { type filter hook input priority -10; tcp dport 7331 ip saddr { 127.0.0.0/8, <caddy IPv4s> } accept; tcp dport 7331 ip6 saddr ::1 accept; tcp dport 7331 drop; }`;
   - add oneshot unit `kxm-hub-nft.service` (`ExecStart=/usr/sbin/nft -f /etc/kxm/hub-allow.nft`, `Before=kxm-hub.service`, `WantedBy=multi-user.target`);
   - `sudo systemctl daemon-reload && sudo systemctl enable --now kxm-hub-nft && sudo systemctl restart kxm-hub`.

   Check: `curl -s http://127.0.0.1:7331/health` passes on the host. From the Caddy VM, `qm guest exec 230 -- curl -s -m 5 http://10.31.0.2:7331/health` passes. From the tailnet or LAN, `curl -m 5 http://192.168.68.54:7331/health` times out or is refused.
2. **Authentik (agent, scoped token, base `https://id.kxmd.dev/api/v3`).** First `GET /api/v3/schema/` and confirm the field names used here; they are unverified. Then:
   - list outposts (`/outposts/instances/`) and pick the one serving `10.30.30.20:9000`;
   - create groups `onesm-owners`, `onesm-admins`, `onesm-users`, and add the current members of `kxm-tenant-admin` to `onesm-owners`;
   - create proxy provider `kxm-hub-onesm`: `mode: forward_single`, `external_host: https://hub-onesm.kxmd.dev`, `intercept_header_auth: true` (there is no header conflict any more; invalid Basic → 401 instead of a login redirect), authorization flow = the one the Studio provider uses;
   - create application `kxm-hub-onesm` (slug `kxm-hub-onesm`) on that provider, with policy bindings to the three `onesm-*` groups;
   - add the provider to the outpost;
   - create service account `agent-ilo-asus`, not expiring, in `onesm-users`, with an app password.
3. **Caddy site (VM 230):** write `/etc/caddy/workspaces/kxm-hub-onesm.caddy`:

   ```caddy
   https://hub-onesm.kxmd.dev {
    bind 10.30.40.10
    tls /etc/caddy/kxmd.dev.crt /etc/caddy/kxmd.dev.key
    request_header -X-Authentik-*
    handle /outpost.goauthentik.io/* {
     reverse_proxy 10.30.30.20:9000
    }
    handle /v1/webhooks/* {
     request_header -Authorization
     request_header -X-Kxm-Hub-Authorization
     reverse_proxy 10.31.0.2:7331
    }
    handle {
     forward_auth 10.30.30.20:9000 {
      uri /outpost.goauthentik.io/auth/caddy?original_url={http.request.uri}
      copy_headers X-Authentik-Groups
     }
     @not_tenant not header_regexp X-Authentik-Groups (^|,)(onesm-owners|onesm-admins|onesm-users)(,|$)
     respond @not_tenant "forbidden" 403
     request_header Authorization {http.request.header.X-Kxm-Hub-Authorization}
     request_header -X-Kxm-Hub-Authorization
     request_header -X-Authentik-*
     request_header -X-Kxm-Caller-Id
     reverse_proxy 10.31.0.2:7331 {
      flush_interval -1
      transport http {
       read_timeout 3600s
      }
     }
    }
   }
   ```

   Validate with `caddy validate --config /etc/caddy/Caddyfile`, then `systemctl restart caddy`. `admin off` makes reload impossible; the restart blips every edge site for about 1 s. Webhook routes skip Authentik because GitHub/Jira calls carry HMAC, not Authentik credentials. DNS: `hub-onesm.kxmd.dev` must resolve to the WAN IP. Check `Resolve-DnsName hub-onesm.kxmd.dev`; if it has no record, add an A/CNAME matching `studio.kxmd.dev` at the kxmd.dev DNS provider (operator step, unverified provider).
4. **Edge witness, all over the public URL:**
   - no auth → 401;
   - wrong Basic → 401;
   - a valid service account outside the `onesm-*` groups → 403;
   - valid Basic + `X-Kxm-Hub-Authorization: Bearer <project token>` → `GET /v1/agents` 200;
   - valid Basic + a wrong bearer → hub 401 `invalid_auth`;
   - a forged `X-Authentik-Groups` from the client does not change the result;
   - an SSE stream `GET /v1/events` stays open more than 60 s.
5. **Client support:** runner slice T4 `hub-edge-client` (below) must merge before the laptop can bind the public URL.
6. **Laptop bind (after T4):**
   - the operator copies the remote token into local `hub-env.json` `projectTokens["@kontextmind/kxm"]` with `ssh kxm-dev-svr cat /home/sysadmin/.local/state/kxm/hub-env.json | node -e "<merge r.authToken into %LOCALAPPDATA%/KXM/hub-env.json projectTokens['@kontextmind/kxm'] atomically>"`, run in their own terminal;
   - then `KXM_EDGE_APP_PASSWORD=<from the step-2 API response, piped by the agent, never printed> kxm hub bind https://hub-onesm.kxmd.dev --edge-username agent-ilo-asus --json`.

   Ends when `kxm hub view --json` has health ok and scope remote, `kxm peer list --json` has `ok: true`, and both work with Tailscale down.

##### Slice spec T4 `hub-edge-client` (runner; boundary `plugins/kxm/src/{client.ts,hub-env.ts,hub-binding.ts,cli/hub.ts,cli.ts,mcp-server.ts,extension.ts,tui.ts,tenant-status.ts,cli/context-skills.ts,cli/workflows.ts,runtime-supervisor.ts}, test/core/{client,cli}.test.ts, plugins/kxm/dist/**, docs/operations/deploy.md, plans/implementation-plan.md`)

1. `hub-env.ts`:
   - add the optional record field `edgeCredentials?: Record<string, { username: string; appPassword: string }>`, keyed by the hub URL origin and validated like `projectTokens`;
   - add `resolveHubEdgeCredential(env, serverUrl): { username: string; appPassword: string } | undefined`: env `KXM_EDGE_USERNAME` + `KXM_EDGE_APP_PASSWORD` when both are set, else `record.edgeCredentials[new URL(serverUrl).origin]`, else undefined.
2. `client.ts`:
   - `HubClient` and `RuntimeHubClient` options gain `edgeCredential?`;
   - when it is set, `headers()` sends `authorization: "Basic " + base64(username + ":" + appPassword)` and moves the hub bearer to `x-kxm-hub-authorization: Bearer <token>`;
   - when it is unset, behaviour is unchanged;
   - export `hubRequestHeaders(token, edgeCredential)` for one-shot callers.
3. Every hub-facing call site uses it and resolves `resolveHubEdgeCredential(env, url)`:
   - `cli/hub.ts` `hubGet`; `hub-binding.ts` `probeHubHealth` (edge Basic only);
   - `cli/context-skills.ts:28`, `cli/workflows.ts:116`, `tui.ts:816`, `tenant-status.ts:188`;
   - every `new HubClient(` / `new RuntimeHubClient(` site: `cli.ts` `ensureCliClient`, `mcp-server.ts`, `extension.ts`, `runtime-supervisor.ts`.
   - The supervisor's own listener (`runtime-supervisor.ts:1330`) and Studio `/api/mutate` are not hub calls; leave them.
4. `extension.ts:679` and `mcp-server.ts:49` resolve the server URL as `KXM_SERVER_URL || readHubBinding(env)?.url || "http://127.0.0.1:7331"`. That fixes the known gap where they ignore the binding.
5. `kxm hub bind <url> --edge-username <name>`:
   - requires `KXM_EDGE_APP_PASSWORD` in env, else exit 2 `hub_edge_password_missing`;
   - stores `edgeCredentials[origin]` atomically;
   - probes health with edge Basic;
   - the remote-scope credential check is unchanged.
6. Tests:
   - `test/core/client.test.ts`: `a hub client behind the edge sends Basic edge credentials and relays the hub bearer in x-kxm-hub-authorization`. Use an injected fetch that captures request and SSE headers.
   - `test/core/cli.test.ts`: `hub bind stores an edge credential for the hub origin and refuses without KXM_EDGE_APP_PASSWORD`.
7. `docs/operations/deploy.md`: in the reverse-proxy contract, replace "proxy strips client Authorization" with the relay rule for hub sites.
8. Rebuild `dist`, and add a Tracking Landed entry.

#### Phase 3 — Runner slice T1 `runner-routing-export` (after Phase 1)

Runs in parallel with Phase 4. Boundary: `scripts/assignment-run.mjs, scripts/assignment-run.d.mts, test/core/improve.test.ts, docs/contributing/assignment-runner.md, plans/implementation-plan.md`. Deliverables:

- "`routing-export` CLI and `exportAssignmentRoutingRecords` per Slice spec T1";
- "named test in test/core/improve.test.ts";
- "Tracking gap moved to landed; assignment-runner.md routing-record line corrected".

##### Slice spec T1 (copy verbatim to `C:/projects/kxm-tasks/plan-runner-routing-export.md`)

Problem: `kxm improve` groups by `providerMetadata.workflowId`, `stepId`/`stageId`, `agentRole`, and `providerMetadata.askSha256` (falling back to `rolePromptSha256`). It counts repeats by `providerMetadata.objectiveSha256` and decides only non-`pending` records (`plugins/kxm/src/improve.ts:243-374`). Runner routing records (`buildRoutingRecord`, `scripts/assignment-run.mjs:1396`) are write-once v1 files with `finalOutcome: "pending"`, `workflowRunId` = assignment id, and a per-assignment prompt hash. No loader reads them: `loadRoutingSources` reads only the Runtime event store and `.kxm/logs/telemetry.jsonl`, or `--file`. Fix it as a read-side export. **Do not change `buildRoutingRecord`, the on-disk `routing-record.json`, `completion.json` or `accepted.json`.** `observe` rebuilds records and compares them with `sameStableFacts`, and both JSON records have closed schemas.

1. Add `export const ROUTING_EXPORT_SCHEMA = "kxm.assignment-routing-export.v1";` and `export function exportAssignmentRoutingRecords(request, deps = {})` next to `changeReport` in `scripts/assignment-run.mjs`. Reuse `ioDeps`, `observationTask`, `listDirectAssignmentDirs`, `privateRecord`, `lstatOrNull`, `sha256Bytes`, `parseRoutingRecord` (already imported), `ACCEPTED_FILENAME`, `ACCEPTED_SCHEMA` and `WRITER_KINDS`. Algorithm:
   - `taskDir = observationTask(request.taskDir, io)`; `taskId = basename(taskDir)`; `skipped = []`.
   - **Acceptance:** if `lstatOrNull(join(taskDir, ACCEPTED_FILENAME))`, read it with `privateRecord`. It is valid iff `value.schema === ACCEPTED_SCHEMA && value.task_id === taskId && typeof value.writer?.assignment_id === "string" && Array.isArray(value.critics)`. Then `acceptedIds = new Set([value.writer.assignment_id, ...value.critics.map((c) => c.assignment_id).filter((id) => typeof id === "string")])`. If it is invalid or unreadable, use `acceptedIds = new Set()` and push `{ assignment_id: null, reason: "acceptance_record_invalid" }`.
   - **Per assignment dir** (from `listDirectAssignmentDirs`, sorted by `assignment_id`):
     - no `routing-record.json` → push `{assignment_id, reason: "no_routing_record"}`;
     - `privateRecord`, then `parseRoutingRecord` throws, or `value.workflowRunId !== assignment_id` → `"routing_record_invalid"`;
     - `manifest.json` missing, or unparseable, or `contract` lacking string `boundary`, array `deliverables`, string `witness.id` or array `deferred` → `"manifest_invalid"`.
     - Otherwise collect `{ id, record, contract }`.
   - `supersededBy = new Map()`: for each collected entry, in sorted order, whose `record.providerMetadata.rework_of` is a string, `if (!supersededBy.has(rework_of)) supersededBy.set(rework_of, id)`.
   - For each collected entry, with `kind = record.stageId`, `role = record.agentRole`:
     - `askSha256 = sha256Bytes(Buffer.from(JSON.stringify(["kxm.assignment-ask.v1", kind, role])))`;
     - `objectiveSha256 = sha256Bytes(Buffer.from(JSON.stringify(["kxm.assignment-brief.v1", kind, contract.boundary, contract.deliverables, contract.witness.id, contract.deferred])))`;
     - `finalOutcome = acceptedIds.has(id) ? "accepted" : supersededBy.has(id) ? "failed" : "pending"`.
     - Output `parseRoutingRecord({ ...record, workflowRunId: taskId, finalOutcome, providerMetadata: { ...record.providerMetadata, workflowId: "assignment-runner", askSha256, objectiveSha256, stepWrites: WRITER_KINDS.includes(kind), assignmentId: id, ...(finalOutcome === "failed" ? { supersededBy: supersededBy.get(id) } : {}) } })`. If it throws, push `"routing_record_invalid"`.
   - Return `{ schema: ROUTING_EXPORT_SCHEMA, task_id: taskId, records, skipped }`.
   - These are the semantics: the ask is the kind plus role, the brief (objective) is kind plus contract, the run is the task, and the pass signal is `accepted.json`. A reworked attempt counts as `failed` in v1 vocabulary. `failed` never touches the file on disk.
2. In `main()`, before the `change-report` branch, add `if (args[0] === "routing-export")`. Parse exactly one `--task-dir <abs>` with the same flag loop and `manifest_invalid` refusals as `change-report`. Then:
   - write each record as `JSON.stringify(record) + "\n"` to `io.stdout`;
   - write `JSON.stringify({ schema, task_id, records: records.length, skipped }) + "\n"` to `io.stderr`;
   - `exitCode = 0`.
   - On error: `failure = observationFailure(error)`; stderr `${failure.runnerCode}: assignment routing export refused\n`; `exitCode = 1`; `throw failure`.
   - Append `| routing-export --task-dir <absolute-path>` to `CLI_USAGE`.
   - No `just` recipe: `harness-run.test.ts` pins the recipe set.
3. In `scripts/assignment-run.d.mts`, declare `ROUTING_EXPORT_SCHEMA` and `exportAssignmentRoutingRecords(request: { taskDir: string }, deps?: …)` in the same style as the `changeReport` declaration. The return type has `skipped[].reason` as the union `"acceptance_record_invalid" | "no_routing_record" | "routing_record_invalid" | "manifest_invalid"`.
4. **Test** in `test/core/improve.test.ts`: `assignment routing export resolves outcomes from accepted.json and groups repeated briefs for kxm improve`. Import `exportAssignmentRoutingRecords` the same way `test/core/harness-run.test.ts` imports script modules.
   - Build two temp task dirs `task-a` and `task-b` under one `mkdtempSync` root. Each assignment dir holds a `manifest.json` (`kind`, `contract`) and a `routing-record.json`. That record is a minimal v1 object that passes `parseRoutingRecord` from `plugins/kxm/src/routing.ts`: `schema`, `behavioralHashVersion` 1, 64-hex `behavioralSha256`, `workflowRunId` = dir name, `stageId`, `attempt` 1, `requestedModel`, `effectiveModel`, `reasoningEffort`, `agentRole`, 64-hex `rolePromptSha256`, `skills` [], `retries`, `transitions` 0, `humanInterventions` 0, `finalOutcome` `"pending"`, `providerMetadata` `{ harness }` (+ `rework_of`).
   - **task-a:**
     - `asg-writer-1` implement, contract W1;
     - `asg-writer-2` repair, `rework_of` `asg-writer-1`, contract W1;
     - `asg-review-cli-1` review-cli, contract R;
     - `asg-writer-3` with a `manifest.json` only;
     - `accepted.json` `{schema:"kxm.task-accepted.v1", task_id:"task-a", writer:{assignment_id:"asg-writer-2"}, critics:[{assignment_id:"asg-review-cli-1"}]}`.
   - **task-b:**
     - `asg-writer-1` implement, contract W2;
     - `asg-review-cli-1` review-cli, contract R (identical to task-a's);
     - accepted with writer `asg-writer-1` and critic `asg-review-cli-1`.
   - **Assert:**
     - a/`asg-writer-1` is `failed` with `supersededBy` `asg-writer-2`; a/`asg-writer-2` and both reviews are `accepted`;
     - every a record has `workflowRunId` `task-a`;
     - writers have `stepWrites` true and reviews false;
     - the review records in a and b have equal `askSha256` and equal `objectiveSha256`; the a and b writers have different `objectiveSha256`;
     - a `skipped` deep-equals `[{assignment_id:"asg-writer-3", reason:"no_routing_record"}]`;
     - `groupRoutingRecords([...a.records, ...b.records])` returns a review-cli group with `askRecurrence` 2 and a pass rate of 1 that appears as a proposed candidate. Read `ImprovementGroupRow` and candidate fields in `improve.ts` before writing these assertions.
     - No writer group is a candidate.
5. `docs/contributing/assignment-runner.md` line ≈250: replace "read by kxm routing report" with "export with `node scripts/assignment-run.mjs routing-export --task-dir <abs>` and pass the JSONL to `kxm improve report --file` / `kxm routing report --file`".
6. `plans/implementation-plan.md`: move the Still-open bullet "developer assignment-runner records do not group" to "Landed in this tree", naming the test and stating that the pass signal is `accepted.json`, the ask is `kind+role`, and the brief is `kind+contract`.

#### Phase 4 — Runner slice T3 `mesh-cutover` (after Phase 1)

Runs in parallel with Phase 3. Boundary: `plugins/kxm/src/**, packages/core/tui/src/**, test/**, examples/**, scripts/smoke-multi-pi.mjs, docs/contributing/development.md, docs/guides/provenance-gates.md, .kxm/assets/run-provenance-workflow.ps1, AGENTS.md, plugins/kxm/dist/**, plans/implementation-plan.md`. Deliverables:

- "identifier rename map applied with no aliases";
- "four schema ids moved to kxm.* with old ids refused and one refusal test";
- "prose and temp prefixes cleaned";
- "source brake test";
- "dist rebuilt".

##### Slice spec T3 (copy verbatim to `C:/projects/kxm-tasks/plan-mesh-cutover.md`)

1. **Rename** each identifier everywhere it appears in `plugins/kxm/src`, `packages/core/tui/src`, `test`, `examples` and `scripts`. Use LSP rename or `ast_edit` for exports. No aliases, no re-exports of old names.

   | Old | New |
   |---|---|
   | `createMeshHub` | `createKxmHub` |
   | `MeshHub` | `KxmHub` |
   | `MeshHubOptions` | `KxmHubOptions` |
   | `MeshStore` | `KxmHubStore` |
   | `MeshWaitError` | `KxmWaitError` (and its `this.name`) |
   | `piMeshExtension` | `piKxmExtension` |
   | `meshClient` | `hubClient` |
   | `createTestMesh` | `createTestHub` |
   | `TestMesh` | `TestHub` |
   | `startProvenanceMesh` | `startProvenanceHub` |
   | `ProvenanceMesh` | `ProvenanceHub` |
   | `expectMeshError` | `expectHubError` |
   | `meshOptions` | `hubOptions` |
   | `loadLocalMeshSnapshot` | `loadLocalKxmSnapshot` |
   | `LocalMeshSnapshot` | `LocalKxmSnapshot` |
   | `LocalMeshSnapshotScope` | `LocalKxmSnapshotScope` |
   | `LocalMeshSnapshotOptions` | `LocalKxmSnapshotOptions` |
   | `summarizeMeshRun` | `summarizeKxmRun` |
   | `summarizeMeshPlan` | `summarizeKxmPlan` |
   | `MeshTuiTheme` | delete the alias; use the existing `KxmTuiTheme` |
   | `renderMeshTui` | `renderKxmDash` |
   | `runMeshTui` | `runKxmDash` |
   | `applyMeshTuiKey` | `applyKxmDashKey` |
   | `defaultMeshTuiView` | `defaultKxmDashView` |
   | `meshTuiTheme` | `kxmDashTheme` |
   | `MESH_TUI_PANELS` | `KXM_DASH_PANELS` |
   | `MESH_TUI_TAB_LABELS` | `KXM_DASH_TAB_LABELS` |
   | `MeshTuiPanel` | `KxmDashPanel` |
   | `MeshTuiView` | `KxmDashView` |
   | `MeshTuiSnapshot` | `KxmDashSnapshot` |
   | `MeshTuiRun` | `KxmSnapshotRun` |
   | `MeshTuiPlan` | `KxmSnapshotPlan` |
   | `MeshTuiPidClaim` | `KxmSnapshotPidClaim` |
   | `MeshTuiRunStage` | `KxmSnapshotRunStage` |
   | `MeshTuiOpenMessage` | `KxmSnapshotOpenMessage` |

   Test locals `const mesh = await createTestMesh(...)` become `const hub = await createTestHub(...)`, and every later `mesh.` in that binding follows. `jsonMesh` in `test/core/cli.test.ts` becomes `jsonKxm`, keeping its `"mesh"` argv. Update the comments at `packages/core/tui/src/tui/panel.ts:6` and `render.ts:5` to the new names. Do **not** use `KxmTui*` for dash symbols: the `packages/core/tui` kit owns that prefix.
2. **Schema ids:** replace the literals everywhere they are written or compared, and `protocol.ts:132` types:
   - `pi-mesh.workflow-message-context.v1` → `kxm.workflow-message-context.v1` (`hub.ts`, `protocol.ts`, `workflow.ts`, `retrospective.ts`);
   - `pi-mesh.verified-peer-evidence.v1` → `kxm.verified-peer-evidence.v1`;
   - `pi-mesh.workflow-degradation-approval.v1` → `kxm.workflow-degradation-approval.v1`;
   - `pi-mesh.retrospective.v1` → `kxm.retrospective.v1`.

   The existing readers already reject any non-matching id, so the old ids are refused without naming them in source. Update the pins in `test/core/extension.test.ts`, `mcp.test.ts`, `retrospective.test.ts`, `store.test.ts` and `workflow-provenance.test.ts`. Add one test in `test/core/workflow-provenance.test.ts`, `workflow evidence stamped with a removed pi-mesh schema id is refused`. It stores or submits a message context with `schema: "pi-mesh.workflow-message-context.v1"` through the same path the existing context tests use and asserts that the path's existing rejection error fires. Rewrite `docs/guides/provenance-gates.md:83` so it says the old ids are refused.
3. **Prose and prefixes:**
   - the `pi-mesh-*` mkdtemp prefixes in `test/core/{cli,extension,hub-api,package-install,recovery,retrospective,store}.test.ts` and `scripts/smoke-multi-pi.mjs:303` → `kxm-*`;
   - `tui.ts:930` and `test/core/tui.test.ts:59,324` "Read-only mesh observer TUI" → "Read-only KXM observer TUI";
   - `project-config.ts:1639` "legacy KXM/Mesh configuration" → "legacy KXM configuration";
   - comments in `context.ts:5`, `state.ts:14`, `examples/reviewer-agent.ts:9`, `test/core/journal-evolution.test.ts:270` and `test/core/worker.test.ts:203`;
   - test names `mcp.test.ts:108` "mesh tool catalog" → "KXM tool catalog" and `tui.test.ts:317`;
   - fixtures `mcp.test.ts:109` `pi-mesh-test` → `kxm-test` and `worker.test.ts:750,753` `mesh skill`/`mesh-skill` → `kxm skill`/`kxm-skill`;
   - `docs/contributing/development.md:319`;
   - `AGENTS.md:186` "Mesh operator copy" → "old product-name copy".
   - Keep `AGENTS.md:9,11`: they state the naming rule.
   - Delete `.kxm/assets/run-provenance-workflow.ps1`. Nothing reads its `PI_MESH_*` variables, it calls the refused `kxm mesh`, and its paths do not exist.
4. **Keep the existing brakes unchanged:**
   - `cli.ts` `MESH_REMOVED_TEXT` / `removedMeshInvocation` / `arg === "mesh"` (the `const mesh =` local there stays);
   - the `cli.test.ts` mesh tests;
   - `package-install.test.ts` `unknownMesh`;
   - `extension.test.ts:205` `mesh-status`;
   - `docs-copy.test.ts` `FORBIDDEN`;
   - `commands-policy.test.ts` `mesh_`;
   - `skill-suite.test.ts` `'mesh'`;
   - `hub-api.test.ts` `/pi_mesh_/`.
5. **Source brake:** add a test in `test/core/docs-copy.test.ts`, `live source keeps no Mesh names outside the removal brakes`.
   - Scan every `.ts`/`.mjs`/`.js`/`.ps1` file under `plugins/kxm/src`, `packages` (skip `**/dist/**`, `**/node_modules/**`), `scripts`, `examples` and `test`, with `/[Mm]esh|pi-mesh|pi_mesh_|PI_MESH|kxm-mesh/`.
   - A hit is allowed only if its file is one of `plugins/kxm/src/cli.ts`, `test/core/cli.test.ts`, `test/core/package-install.test.ts`, `test/core/extension.test.ts`, `test/core/docs-copy.test.ts`, `test/core/commands-policy.test.ts`, `test/core/skill-suite.test.ts`, `test/core/hub-api.test.ts`, `test/core/workflow-provenance.test.ts`, **and** its line matches `/removedMeshInvocation|MESH_REMOVED_TEXT|kxm mesh|"mesh"|'mesh'|mesh-status|pi_mesh_|mesh_"|\\bmesh|FORBIDDEN|pi-mesh\.workflow-message-context\.v1|const mesh = removedMeshInvocation/`.
   - Assert that the list of other hits (`file:line: text`) is empty.
6. `rtk npm run build`, then commit the regenerated `plugins/kxm/dist`, which `check:generated` requires.
7. Tracking → Decided entry 3, and a Landed entry naming the source brake test and the refusal test.

#### Phase 5 — Runner slice T2 `hub-sqlite-concurrency` (after Phase 4 merges; it uses `createTestHub`)

Boundary: `test/core/hub-api.test.ts, plans/implementation-plan.md`. Deliverables: "named concurrency witness test", "Tracking Decided entry 4".

##### Slice spec T2 (copy verbatim to `C:/projects/kxm-tasks/plan-hub-sqlite-concurrency.md`)

Operator condition for staying on SQLite: users and agents must not cause lock errors. Add to `test/core/hub-api.test.ts` the test `a file-backed hub serves concurrent agents and a direct reader without a lock error`.

- `dir = mkdtempSync(join(tmpdir(), "kxm-hub-contention-"))`; `context.after(() => rmSync(dir, { recursive: true, force: true }))`; `hub = await createTestHub(context, { dataPath: join(dir, "kxm.db") })`.
- **Agents:** make 16 clients `agent-0`…`agent-15` with `hub.makeClient(name, { requestTimeoutMs: 10_000 })`. Start each with a handler that, on `event.type === "message"`, runs `await client.acknowledge(event.message.id); await client.reply(event.message.id, "ok " + event.message.id)`. This is the existing pattern at `hub-api.test.ts:418-422`.
- **Load:** `Promise.all` of 320 sends: agent `i` sends 20 messages `{ target: "agent-" + ((i + 1) % 16), content: "load " + i + "-" + n }`. Then `Promise.all` of `sender.awaitResponse(id, 10_000)` for every message.
- **Direct reader,** running concurrently from before the first send until all responses have resolved: `const reader = new DatabaseSync(join(dir, "kxm.db"), { readOnly: true })` (from `node:sqlite`). Loop `reader.prepare("SELECT count(*) AS n FROM messages").get()` with `await new Promise((r) => setTimeout(r, 2))` between iterations. Push any thrown error message into `readerErrors`. Close it in `finally`.
- **Assert:** every send and await fulfils (no `HubHttpError`); every awaited message has `status === "replied"`; `readerErrors` deep-equals `[]`; a final reader `count(*)` ≥ 320.
- No elapsed-time assertion and no widened global timeout. This follows the repo's barrier rule for timing tests.
- Tracking → Decided entry 4 names this test as the gate that holds the condition.

#### Phase 6 — Self-improvement learning cycle (root; after Phase 3 merges)

Follows `skill://kxm-routing-improve`. Everything here is a proposal; apply nothing.

1. **Export:** in `eval` (JS), collect task dirs: every directory under `C:/projects/kxm-tasks` (depth ≤ 2 below it) that has a child dir containing `routing-record.json`. For each, run `node scripts/assignment-run.mjs routing-export --task-dir <dir>` from `C:/projects/kxm`. Concatenate stdout into `C:/projects/kxm-tasks/learning/routing-export-2026-09-24.jsonl`, overwriting any previous file, and keep each stderr summary line in `…/routing-export-summary.jsonl`.
2. **Read repeats:**
   - `kxm improve report --file C:/projects/kxm-tasks/learning/routing-export-2026-09-24.jsonl --dry-run --json`;
   - `kxm improve report --dry-run --json` (Runtime and telemetry sources);
   - `kxm routing report --file <same> --json`;
   - `kxm routing report --file <same> --equivalent-list-cost --json`. `.kxm/prices.yaml` has no `grok-4.7` price, so its cost stays unknown; do not invent one.
3. **Journal report via the Phase 2 hub:** a throwaway `eval` script run with `node --experimental-strip-types`. It imports `HubClient` from `plugins/kxm/src/client.ts` and `resolveAgentHubAuthToken` from `plugins/kxm/src/hub-env.ts`, builds `new HubClient({ serverUrl: "http://127.0.0.1:17331", authToken: resolveAgentHubAuthToken(process.env, "@kontextmind/kxm"), name: "learning-reader", purpose: "read improvement report", project: "@kontextmind/kxm" })`, then runs `await client.start(() => {})`, `const r = await client.improvementReport()`, prints `JSON.stringify(r)`, and `await client.stop()`. It never prints the token. If the hub reports 0 entries, record that as the finding.
4. **Capture:** for each finding with evidence, add a private note through `just attribute <task_dir> <record_dir> <class> <note.txt>` on the relevant new task (`runner-routing-export`, `mesh-cutover`, `hub-sqlite-concurrency`). Findings include rework counts, relief-writer use, critic BLOCK rate, unknown cost share, and candidates with `excludedReason`. Then open one docs PR (`learning-cycle-2026-09-24`, label `no-release`). It adds a Tracking → Still open bullet "Learning cycle 2026-09-24", listing groups, candidates (status `proposed`, none applied), and these recorded gaps:
   - (a) no CLI reads hub `/v1/improvements`;
   - (b) omp's MCP route `kxm:kxm` fails with `Failed to parse URL from ${user_config.server_url}` because omp does not expand Claude `user_config` placeholders in `plugins/kxm/.mcp.json`;
   - (c) `kxm routing report --file` bypasses `loadRoutingSources` and omits `sources`;
   - (d) `kxm improve report --json` printed no `sources` field on 2026-09-24.
   - Owner: current writer route. Trigger: the next Studio/MCP slice.

#### Phase 7 — Tenant architecture records (root docs PR `tenant-architecture-records`, label `no-release`; any time after Phase 0)

1. **Create `docs/adr/ADR-0005-hosted-tenant-hub.md`.** Front matter mirrors `ADR-0004-edge-identity-authentik.md` (`schema: "kxm.doc.v1"`, `id: "ADR-0005"`, `type: "adr"`, `status: "accepted"`, `authority: "decision"`, `supersedes: null`, related ADR-0003/0004). Content = Decisions 5, 6 and 7, plus:
   - **Retained invariants:** the proxy strips client `X-Authentik-*`, `x-kxm-agent-*` and `x-kxm-caller-id`; the proxy never injects a hub token; the hub never interprets identity headers; the supervisor stays loopback; laptop defaults are unchanged.
   - **Tenant groups:** `<tenant>-owners`, `<tenant>-admins`, `<tenant>-users`. Studio settings routes (`/api/mutate` and any config write) are gated at Caddy to owners+admins, because the outpost forward-auth path does not evaluate application policies (S5 finding). Read routes are allowed to all three.
   - **Service accounts:** one per remote machine, named `runtime-<host>` / `agent-<host>`, in `<tenant>-users`, each with an app password.
   - **Edge witness checklist,** required before any tenant goes public:
     - unauthenticated → 401/redirect;
     - wrong-tenant account → denied;
     - forged `X-Authentik-*` and `x-kxm-*` stripped;
     - `Authorization: Bearer` reaches the hub with intercept disabled;
     - SSE `/v1/events` survives >15 s (proxy read timeout > heartbeat);
     - revoking one service account denies only that machine;
     - Authentik outage denies browsers without dropping on-VM clients.
2. **ADR-0004:** set `updated: "2026-09-24"` and add a Status line: "Amended by ADR-0005 for hosted tenants (public hub route through Authentik); unchanged for local and laptop use." Add ADR-0005 to `docs/adr/README.md`. **ADR-0003:** add a "Tenancy" paragraph with Decision 4 and its triggers, naming the Phase 5 test.
3. **`plans/plan-per-tenant-hosting.md`:**
   - Rewrite decision 3 to match ADR-0005.
   - In "Explicitly not in this plan", delete "a public hub listener". Everything else there stays.
   - Replace the "The two decisions, settled" §2 sentence about split-box `bind` with the edge client flow.
   - Add sections "Tenant model", "Tenant VM", "Upgrades", "Central config and provider auth", and "Usage broker, budgets and failover". The last one holds the `.kxm/budgets.yaml` (`kxm.budgets.v1`) and role `failover:` shapes below as **proposed schema, not live**.
   - `failover: { enabled: true, on: [quota, rate_limit, auth], revert: cooldown-expiry }` on `kxm.role.v1`, with a per-entry `harness`; the chain is the roster order, skipping `enabled: false`.
   - `budgets.yaml`: `providers.<id>.windows[] {id, unit: requests|input_tokens|output_tokens|credits, limit, window, hard}`, `providers.<id>.maxUsd` + `window` for metered providers, and `cooldown.defaultSeconds`. Its consumers are `engine.ts resolveProducerRoute`, `routes.ts listRoleBindings`, the producers' structured quota class, and pre-dispatch budget enforcement.
   - Note that `schemas/role.schema.json` must first be aligned with the live string-selector roster.
4. **Tracking:**
   - Decided entries 5–9. Mark the 2026-09-20 "Single operator: no migrations…" entry "superseded for hosted tenants by the 2026-09-24 Upgrades decision; still true for local installs".
   - Still open queue: add rows H1–H6 in the existing table style, each with a trigger and one named test:
     - **H1** Store migration framework + pre-migrate backup/restore. Test: `a hub store one version behind migrates forward after a verified backup and restores on failure`.
     - **H2** Tenant edge: client Authentik Basic login + cookie jar in `client.ts`/`RuntimeHubClient`, and `extension.ts`/`mcp-server.ts` read the hub binding. Test: `a remote client behind the edge sends the session cookie and the hub bearer` (plus the ADR-0005 deployed witness).
     - **H3** Per-VM update timer + staged `--kxm` rollout. Test: deployed witness on the canary.
     - **H4** Tenant auth broker: central provider OAuth, `GET /v1/usage` modeled on omp. Test: `broker usage report blocks a credential until its reported reset`.
     - **H5** Executable roster failover + `budgets.yaml` enforcement. Test: `a quota failure on the primary route runs the next enabled roster entry and reverts after cooldown`.
     - **H6** Studio management of roles/gates/models/providers/provider auth, with the wiki on the tenant VM; chat setup stays backlog. Test: named at pickup.
   - Trigger for H1–H6: the first tenant beyond `kxm-dev-svr`, or the operator's explicit pick.

### Critical files & anchors

- `scripts/assignment-run.mjs`: `buildRoutingRecord` ≈1396 (must stay unchanged), `changeReport` ≈4173 and `main` ≈4296 (pattern for the new verb), `validateBase` ≈626 (critic base shape).
- `plugins/kxm/src/improve.ts`: `groupRoutingRecords` ≈243–374. Group key, `objectiveSha256` recurrence, `stepWrites`, the pending rule.
- `plugins/kxm/src/workflow.ts`, `hub.ts`, `retrospective.ts`, `protocol.ts`: the four `pi-mesh.*` schema literals (writers and `schema ===` readers).
- `plugins/kxm/src/hub-env.ts`: `resolveClientHubAuthToken`/`resolveAgentHubAuthToken` ≈231–253. Project token precedence, which Phase 2 relies on.
- `test/core/docs-copy.test.ts`: existing `FORBIDDEN` brake; the new source brake sits beside it and must not reuse the `includes()` list.

### Verification

- **Phase 0:** `~/bin/kxm-pipeline main` prints `PIPELINE PASS <sha>` or produces the recorded baseline failure list. `gh workflow list --all -R kontextmind/kxm` shows CI, Nightly and Real Pi smoke as `disabled_manually`, and Auto-Release and Release as `active`. `gh api repos/kontextmind/kxm/rulesets/22251971 --jq '[.rules[].type]'` returns `["deletion","non_fast_forward","pull_request"]`. The Phase 0 PR merges with no pending checks.
- **Phase 1:** the preflight one-liner prints `ok 4.6 refused`. `grok models` lists `grok-4.7`. `kxm routes list --json` shows `xai/grok-4.7` admitted and no `xai/grok-4.6`. `rtk npm run verify` and the pipeline are green.
- **Phase 2:** `/health` through `127.0.0.1:17331` is ok; `kxm hub view --json` shows the 17331 loopback URL; `kxm peer list --json` has `ok: true`; all three still hold after sign-out/sign-in, with task `KxmHubTunnel-kxmDevSvr` Running.
- **Phase 3:** the named improve test passes. Then `node scripts/assignment-run.mjs routing-export --task-dir C:/projects/kxm-tasks/omp-host-harness/u7-omp-harness`:
  - stdout: one JSON line per assignment dir that has a `routing-record.json`, including `asg-writer-3` with `finalOutcome:"accepted"` (its `accepted.json` names it) and `asg-writer-1`/`asg-writer-2` with `"failed"` if superseded;
  - stderr summary: `records` = the count of those lines;
  - `kxm improve report --file <that output> --dry-run --json` shows `recordsCount` > 0 and fewer groups than records.
  - The runner `accepted.json` for `runner-routing-export` exists.
- **Phase 4:** `rtk git grep -n -I -E "[Mm]esh|pi-mesh|pi_mesh_|PI_MESH" -- plugins/kxm/src packages scripts examples test` shows only the allowlisted brake lines. The new brake and refusal tests pass. `kxm mesh` still exits 2 with `removed_command`. `check:generated` is green.
- **Phase 5:** the concurrency test passes in both `rtk npm run verify` (Windows witness) and the WSL pipeline (Node 24 and 22.19.0 legs).
- **Phase 6:** the files `learning/routing-export-2026-09-24.jsonl` and `…-summary.jsonl` exist; the four report commands exit 0 with JSON; the hub improvement report prints JSON (or a recorded 0-entry finding); the learning PR merges with the Still-open bullet.
- **Phase 7:** `rtk npm run check` (lint:docs) is green, ADR-0005 is listed in `docs/adr/README.md`, and the Tracking rows H1–H6 are present.

### Assumptions & contingencies

- If WSL has no internet for nvm or npm, run the pipeline on kxm-dev-svr instead, in a separate clone `~/src/kxm-pipeline` with the same script, never `/home/sysadmin/source/kxm`, and state the host in each PR body.
- If `claude plugin validate` in WSL needs a login, the step fails closed. Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` as CI does. If it still asks for auth, run Plugin validation on Windows with the globally installed `claude` via `rtk npm run validate:claude` and note it in the PR.
- If `grok-4.7` fails auth or model checks at `just assign`, the next writer is `qwen-openrouter-pi` after `pi auth check --provider openrouter`. Never bill Grok through Pi.
- If the Phase 1 merge breaks the product `.kxm` loader (a test loads this repo's `.kxm` and pins `xai/grok-4.6`), update that fixture to `xai/grok-4.7`. Do not re-admit 4.6.
- If an allowlisted brake line in Phase 4 needs a token outside the given regex, extend the per-file line regex for that file only. Never allowlist a whole file.
- The operator may pull H1–H6 (Phase 7) into execution later. This plan only records them.
