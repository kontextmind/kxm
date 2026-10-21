# October 2026 gap audit

This page records the gap audit of this repository on 2026-10-21, against `main` at `19ec8a5`. It is for the operator who still has to decide runner placement, route admission, and the witnesses already listed in Tracking. The four code fixes from this pass are separate pull requests.

The pass compared the CLI, routing, and CI workflows with the docs, the tests, and `.kxm/knowledge`. It left `.kxm/prices.yaml` and `.github/workflows/refresh-models.yml` untouched because [pull request #410](https://github.com/kontextmind/kxm/pull/410) owns those files. Playwright stays on Obscura. [Playwright e2e](https://github.com/kontextmind/kxm/blob/main/.github/workflows/e2e.yml) already runs `npm run e2e` on `ubuntu-latest`.

## What this pass fixed

Each fix is a small pull request with squash auto-merge. None of them needs a secret, a repository setting, DNS, or a runner change.

| Pull request | Fix |
|---|---|
| [#411](https://github.com/kontextmind/kxm/pull/411) | Whole-word workflow keywords in `kxm suggest` |
| [#412](https://github.com/kontextmind/kxm/pull/412) | `kxm vision assert --route` follows the admitted Pi model |
| [#413](https://github.com/kontextmind/kxm/pull/413) | Next step when Git or the hub is missing |
| [#414](https://github.com/kontextmind/kxm/pull/414) | A rate-limit abort still walks the fallback chain |

`kxm suggest` used to treat a keyword as a substring. "guide" and "build" took the feature workflow because they contain `ui`, "author" took vulnerability remediation because it contains `auth`, and "change" took bug-fix because it contains `hang`. Hyphenated keywords such as `circuit-breaker` still match as one token. A prompt with no keyword still selects `feature-implementation` at score 0.

`kxm vision assert` accepted `--route` and then ignored it. The flag now selects that Pi model after admission. An unknown route names `kxm routes admit`. A native-vendor id is refused before `pi` starts. The CLI reference documents the command. The built-in default route is unchanged. See decision 2.

`kxm init` outside any Git worktree now says to run `git init` and then `kxm init` again. A directory that is not the worktree root still says to run from that root. `kxm hub view` says to start the hub when nothing is listening on a loopback URL, and names the tunnel and `kxm hub bind` for any other URL. An auth proxy or redirect keeps its existing probe note.

A provider HTTP 429 whose body says the request was aborted used to classify as `cancelled`, which does not walk. It now stays `rate_limit` and walks. `AbortError`, a process abort, and a user cancel stay `cancelled`. `tool_policy` is its own class. Both non-walkable classes still stop the chain.

## What was checked and left

Product TypeScript and Python sources have no `TODO` or `FIXME` markers outside generated bundles and narrative plan text. The CLI reference already covers the registered commands. `kxm vision assert` was the missing heading, and pull request #412 adds it.

Phase pages under `docs/roadmap/phases/` are symlinks to `plans/kxm-roadmap/phases/`. Plan links such as `../../plan-lane-cli.md` resolve from the real file. A scan that does not follow the symlink reports nine missing targets under `docs/roadmap/phases/`. The generator was not changed.

`.kxm/knowledge` has ten pages, last indexed 2026-10-17. It has no first-run page, and [CI conventions](../../.kxm/knowledge/patterns/ci.md) does not describe the runner queue below. Those notes should wait until the runner decision lands, so the wiki does not record a queue that the operator is about to move.

## Decisions for the operator

Ranked by how often they block a pull request or a first run. Each one needs a setting, a host, a secret, or an admission the code must not guess.

### 1. Where pull-request Linux jobs run

Pull-request jobs that select the ARC scale set `kontextmind-doks` are Classify changes, Docs lint, both Linux engine shards, the Linux unit lanes (`serial`, `light-1`, `light-2`), Python MG1, Plugin validation, and `required`. Windows unit lanes already use `windows-latest`, and only when the classifier marks the change platform-sensitive. The Validate matrix does not run on a pull request. On `main` its Linux cells use `kontextmind-doks` with a three-minute timeout, and its Windows cells use `windows-latest` with a fifteen-minute timeout.

[CI and release](../contributing/ci-and-release.md) records the capacity policy: one warm runner, a burst to four, three CPUs each. `test/core/ci-contract.test.ts` refuses `ubuntu-latest` inside `ci.yml`, `release.yml`, `smoke.yml`, and `nightly.yml`. The same page says the Python lane stays on `kontextmind-doks` because that scale set has no container-engine socket. `scripts/ci-postgres-17.sh` installs a pinned PostgreSQL 17.11.0 linux/x86_64 archive and maps ICU 74 to the `libicu74` apt package.

Observed on 2026-10-21:

- Workflow [39513962307](https://github.com/kontextmind/kxm/actions/runs/39513962307) (pull request #410, platform-sensitive) was created at 2026-10-20T23:16:53Z. Docs lint started at 2026-10-21T00:02:27Z, about 46 minutes later. Windows lanes started at 00:03:51Z, within seconds of Classify. Linux lanes then ran mostly one at a time through about 00:20Z.
- Workflow [39510255392](https://github.com/kontextmind/kxm/actions/runs/39510255392) (planner fallback, code pull request) was created at 2026-10-20T22:44:14Z and completed at 2026-10-20T23:08:16Z, about 24 minutes, while the scale set was less busy.

Classify, Docs lint, the Node unit lanes, Plugin validation, and `required` do not need the cluster. Moving those jobs to `ubuntu-latest` would drop the queue and would also edit the contract test, spend GitHub-hosted minutes, and reverse the pinned-runner rule. Python can stay on the scale set, or move to a GitHub-hosted service container, which is a different script than the pinned archive. A newer image that no longer ships `libicu74` fails that archive until the pin moves. Linux Validate on `main` has a three-minute timeout that is tight for a cold `npm ci` on a GitHub-hosted runner. Do not relabel `km-gh-rn01`. That bypasses ARC and serializes the queue.

### 2. The built-in vision route

`kxm vision assert` still defaults to `zai-coding-cn/glm-5.3-flash` and, for that id only, still runs `pi --provider zai-coding-cn --model glm-5.3-flash`. `.kxm/routes.yaml` removed `zai-coding-cn/*` on 2026-09-27 because that provider is not allowlisted. The admitted replacement in this checkout is `openrouter/z-ai/glm-5.3-flash`. A vision call here with no `--route` still fail-closes, and pull request #412 names `kxm routes admit` in that message. `kxm init` does not admit a vision route.

Changing the default needs a vision accuracy witness on the admitted id. This pass kept the verified default argv.

### 3. The starter writer model

`kxm init` still admits `xai/grok-4.6`, writes `.kxm/models/grok-grok-4-6.yaml`, and puts that route on the writer roster. This repository admits `xai/grok-4.7`. `modes.ts`, `subagent-control.ts`, and the Pi producer default still name grok-4.6. Glossary and catalog examples that show grok-4.6 are selector shapes. Replacing the starter is an admission decision, with the tests and docs that pin 4.6 updated in the same change.

### 4. Confirm or reverse the defaults already in Tracking

These are already implemented. They wait on a yes, a change, or a decline. A decline is its own revert. The queue is [Still open](../../plans/implementation-plan.md#tracking-working-tree-not-a-release).

- Q-B, Q-C, and Q-E through Q-K on pull request #298: promotion policy, schema identity, evidence on repro and implementer roles, task ranking, pass semantics, coded-repeat candidacy, direct readers, log sizes, and dispatch context. Each shipped with the recommended default and is not a Decided entry.
- D-1: keep the nine KontextMind knowledge-plane skills, rescoped so they trigger when the user names KontextMind, or delete them. The current tree keeps them.
- D-2: leave `plugin.json` and `marketplace.json` at 0.7.1, so `claude plugin update` does not refresh an existing install, or bump the plugin version.
- A0: the live Claude Code witness for `kxm_hook_tool_failure` in an isolated `CLAUDE_CONFIG_DIR`. The tool stays unpublished until that witness passes.

### 5. Witnesses that need a host or a secret

Still open already names the owners. This pass did not schedule them.

- S5 interactive login, logout, and refresh on the deployed edge, plus the deployed restore witness that is still tied to that window.
- P0 cross-box `kxm peer`: box B binds hub A over an operator-owned forward and completes send, await, reply, checkpoint, and signal.
- Backup restore does not remap absolute paths stored under `$S`.
- The hub context pool reads `.kxm/memory` and skills from the hub checkout and relabels them as the caller's project.
- Runtime runs have no journal. `kxm workflow record` looks the id up among hub webhook runs, so a `kxm run` id returns `workflow_not_found`. A journal needs a new store, and the S0–S5 queue forbids that schema change while S5 is open.
- Routing and cost questions in the same Still open list: the Google route still wired as `agy` while Decided says `antigravity`, two Pi allowlists, `limits.maxModelCost` never tripping because no producer writes metered cost, and `qwen-token-plan/deepseek-v4.1-flash` admitted beside the native-vendor brake.

## Related

- [CI and release](../contributing/ci-and-release.md)
- [Decisions](../contributing/decisions.md)
- [KXM CLI reference](../reference/cli-reference.md)
- [Troubleshoot KXM](../operations/troubleshooting.md)
- [Project knowledge wiki](../../.kxm/knowledge/index.md)
