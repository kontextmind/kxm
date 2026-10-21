# October 2026 gap audit

This page records the gap audit of this repository on 2026-10-21, against `main` at `19ec8a5`. Eddie approved decision 1, runner placement, on 2026-10-21. Route admission and the witnesses already listed in Tracking still need the operator. The four code fixes from this pass are separate pull requests.

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

`kxm vision assert` accepted `--route` and then ignored it. The flag now selects that Pi model after admission. An unknown route names `kxm routes admit`. A native-vendor id is refused before `pi` starts. The CLI reference documents the command. That pull request left the built-in default route unchanged. Decision 2 changes it.

`kxm init` outside any Git worktree now says to run `git init` and then `kxm init` again. A directory that is not the worktree root still says to run from that root. `kxm hub view` says to start the hub when nothing is listening on a loopback URL, and names the tunnel and `kxm hub bind` for any other URL. An auth proxy or redirect keeps its existing probe note.

A provider HTTP 429 whose body says the request was aborted used to classify as `cancelled`, which does not walk. It now stays `rate_limit` and walks. `AbortError`, a process abort, and a user cancel stay `cancelled`. `tool_policy` is its own class. Both non-walkable classes still stop the chain.

## What was checked and left

Product TypeScript and Python sources have no `TODO` or `FIXME` markers outside generated bundles and narrative plan text. The CLI reference already covers the registered commands. `kxm vision assert` was the missing heading, and pull request #412 adds it.

Phase pages under `docs/roadmap/phases/` are symlinks to `plans/kxm-roadmap/phases/`. Plan links such as `../../plan-lane-cli.md` resolve from the real file. A scan that does not follow the symlink reports nine missing targets under `docs/roadmap/phases/`. The generator was not changed.

`.kxm/knowledge` has ten pages, last indexed 2026-10-17. It has no first-run page. [CI conventions](../../.kxm/knowledge/patterns/ci.md) now records the runner split from decision 1.

## Decisions for the operator

Ranked by how often they block a pull request or a first run. Each one needs a setting, a host, a secret, or an admission the code must not guess.

### 1. Where pull-request Linux jobs run

**Approved by Eddie on 2026-10-21.** On a pull request, these jobs use GitHub-hosted `ubuntu-latest`:

- Classify changes
- Docs lint
- Linux Node 24 unit lanes `serial`, `light-1`, and `light-2`
- Plugin validation
- `required`

The same five jobs stay on `kontextmind-doks` for a push to `main` and for `workflow_dispatch`. Release, nightly, and smoke stay on `kontextmind-doks`. Windows unit lanes stay on `windows-latest`. `km-gh-rn01` was not given the `kontextmind-doks` label.

Python MG1 stays on `kontextmind-doks`. `scripts/ci-postgres-17.sh` installs a pinned PostgreSQL 17.11.0 linux/x86_64 archive and maps ICU 74 to the `libicu74` apt package. A newer `ubuntu-latest` image that drops `libicu74` fails that archive until the pin moves. A GitHub-hosted service container would be a different script, so this change does not move Python.

The Linux engine shards stay on `kontextmind-doks`. They are the CPU-bound split of `engine.test.ts`. The scale set requests three CPUs so those jobs are not packed onto busy nodes. They do not use a container socket, and they were not in the set that can leave the cluster without a capacity question.

Linux Validate on `main` stays on `kontextmind-doks` with the three-minute timeout. On the push for `e63907a` ([run 39547915383](https://github.com/kontextmind/kxm/actions/runs/39547915383)), Validate (linux, Node 22.19.0) ran from 2026-10-21T05:16:57Z to 05:18:06Z and Validate (linux, Node 24) ran from 05:25:47Z to 05:26:56Z, about 69 seconds each after a runner started. That budget is tight for a cold `npm ci` on a GitHub-hosted runner. This job does not use one, so the timeout stays at three minutes. Windows Validate stays at fifteen minutes.

`test/core/ci-contract.test.ts` allows `ubuntu-latest` only for the five pull-request jobs above, and only inside the `pull_request` arm of the `runs-on` expression. It still refuses `ubuntu-latest` in `release.yml`, `smoke.yml`, and `nightly.yml`, and it still refuses a bare `ubuntu-latest` selector on any other `ci.yml` job.

Before this move, every pull-request Linux job selected `kontextmind-doks`. Windows unit lanes already used `windows-latest`, and only when the classifier marked the change platform-sensitive. The Validate matrix did not run on a pull request.

[CI and release](../contributing/ci-and-release.md) records the capacity policy: one warm runner, a burst to four, three CPUs each. The Python lane stays on `kontextmind-doks` because that scale set has no container-engine socket.

Observed on 2026-10-21, before the runner split:

- Workflow [39513962307](https://github.com/kontextmind/kxm/actions/runs/39513962307) (pull request #410, platform-sensitive) was created at 2026-10-20T23:16:53Z. Docs lint started at 2026-10-21T00:02:27Z, about 46 minutes later. Windows lanes started at 00:03:51Z, within seconds of Classify. Linux lanes then ran mostly one at a time through about 00:20Z.
- Workflow [39510255392](https://github.com/kontextmind/kxm/actions/runs/39510255392) (planner fallback, code pull request) was created at 2026-10-20T22:44:14Z and completed at 2026-10-20T23:08:16Z, about 24 minutes, while the scale set was less busy.

### 2. The built-in vision route

Approved 2026-10-21 in [pull request #419](https://github.com/kontextmind/kxm/pull/419). `kxm vision assert` defaults to `openrouter/z-ai/glm-5.3-flash` and runs `pi --model <id>` for every route, including that default. `zai-coding-cn/glm-5.3-flash` no longer has a special argv. `kxm init` admits the vision selector and does not write a model file for it. The accuracy witness is `test/fixtures/vision/` and `test/core/vision-accuracy.test.ts`. That test calls Pi only when `OPENROUTER_API_KEY` is set.

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
