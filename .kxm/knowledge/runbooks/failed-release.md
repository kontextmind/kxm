---
title: Cut and diagnose a failed release
summary: Where a merged pull request stops between Auto-Release, the GitHub release, and npm.
tags: [runbook, release]
updated: "2026-10-17"
sources:
  - .github/workflows/auto-release.yml
  - .github/workflows/release.yml
  - docs/contributing/ci-and-release.md
  - scripts/kxm-release-github.mjs
  - scripts/kxm-publish-npm.mjs
---

# Cut and diagnose a failed release

Use this when a merged pull request did not become `@kontextmind/kxm` on npm. The normal path is [Release flow](../patterns/release-flow.md). Do not edit version fields to force a release. `npm run check:versions` fails when any surface differs from the root `package.json`.

## 1. Confirm the merge was eligible

Auto-Release runs on `pull_request` `closed` for `main`, and only when `merged` is true.

- A closed pull request that was not merged does not tag.
- The label `no-release` sets `skip=true`.
- A head branch matching `chore/release-` sets `skip=true`.
- The job reads `github.event.pull_request.merge_commit_sha`. A squash merge supplies that commit. The workflow tags that SHA, not the branch tip from before the merge.

Read the Auto-Release run named "Tag and dispatch release".

## 2. Tag conflicts

The job computes the next patch from the newest `vX.Y.Z` tag. If that tag already points at the merge commit, it continues. If the tag points at a different commit, it prints `Tag <tag> already points to <sha>, expected <merge sha>` and exits 1. Do not move the tag by hand. Fix the tag identity, then rerun.

A `GITHUB_TOKEN` tag push does not start `release.yml`. Auto-Release dispatches it in the same job. If the tag exists and the Release workflow never started, dispatch `release.yml` with the tag input (`workflow_dispatch`). `release.yml` also runs on a `v*` tag push made outside that token path.

## 3. Release job failures

`release.yml` job "Publish GitHub release" checks out the tag and takes the helper scripts from `main`. Failures land in order:

1. The tag must match `v<major>.<minor>.<patch>`. Anything else exits with `invalid release tag`.
2. `npm run check:generated` fails when the tagged tree's bundles do not match the generator.
3. `npm run validate:ci` fails on coverage, typecheck, docs lint, versions, or the pack dry-run.
4. The pack step records sha256. `scripts/kxm-release-github.mjs` refuses a digest mismatch between the local tarball and the GitHub asset.
5. Publishing the draft is a separate step. "GitHub release is public" is not npm.

The version stamp is not committed back.

## 4. npm did not show the version

`publish-npm` needs the `release` job and the `npm-publish` environment (`NPM_TOKEN`). It looks up `https://registry.npmjs.org/@kontextmind/kxm/<version>`.

- HTTP 200 skips publish and prints that the version is already published.
- HTTP 404 continues to `scripts/kxm-publish-npm.mjs`, which requires a published GitHub release, downloads the asset, checks sha256, and publishes that file.
- Any other HTTP status fails the lookup.

The job then polls `npm view @kontextmind/kxm@<version> version` for up to 20 minutes. The registry can lag the GitHub release by many minutes. A green GitHub release with a still-running or failed `publish-npm` job means npm has not confirmed the version.

## 5. Rerun

Rerunning Release for a tag that already has a GitHub release, or a version already on npm, reports the existing artifact and does not publish a second copy. Fix the failing step first. A `no-release` merge will not tag on rerun of Auto-Release either, because the skip is on the event payload.
