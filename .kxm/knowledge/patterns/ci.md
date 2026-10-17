---
title: CI conventions
summary: What runs on a pull request, what runs after merge, and when Windows lanes run.
tags: [ci, tests, windows]
updated: "2026-10-17"
sources:
  - .github/workflows/ci.yml
  - .github/workflows/e2e.yml
  - .github/workflows/nightly.yml
  - scripts/ci-classify.mjs
  - docs/contributing/ci-and-release.md
---

# CI conventions

Workflows live in `.github/workflows/`. Linux jobs use the ARC scale set `kontextmind-doks`. Windows jobs use GitHub-hosted `windows-latest`. `test/core/ci-contract.test.ts` pins runner selectors, job names, and release triggers. The aggregate status check to require is `CI / required`.

## Fast pull-request lane

Classify changes (`scripts/ci-classify.mjs`) sets `code=false` when every path is markdown, a path under `docs/`, `.kxm/assets/`, `LICENSE`, an issue or pull-request template, or `dependabot.yml`. Docs lint still runs. Unit lanes, Python, plugin validation, and the validate matrix are skipped. `CI / required` passes.

A code pull request runs:

| Lane | What |
|---|---|
| Docs lint | `npm run lint:docs` and `npm run check:versions` |
| Engine | `engine.test.ts` in two shards, Linux Node 24 |
| Unit | `serial`, `light-1`, and `light-2` on Linux Node 24 |
| Python | Python 3.13 contracts against PostgreSQL 17 |
| Plugin | `claude plugin validate --strict` |

`light-1` also typechecks and runs `node scripts/check-generated.mjs`. The serial lane is `permission.test.ts`, then `runtime.test.ts`, then `package-install.test.ts`. The other unit files are round-robin split across `light-1` and `light-2`.

These do not run on a pull request:

- `validate:pr` on the OS × Node matrix (Linux and Windows, Node 22.19.0 and Node 24).
- Coverage floors, simulations, and `npm pack --dry-run` (nightly).
- Playwright. `.github/workflows/e2e.yml` is a separate workflow. See [Playwright via Obscura](../runbooks/playwright-obscura.md).

A newer push cancels an older pull-request run. Runs on `main` are not cancelled.

## Full matrix after merge

A push to `main`, and `workflow_dispatch`, also run `validate:pr` on Linux and Windows for Node 22.19.0 and Node 24 when the push is classified as code. `validate:pr` is `build`, `typecheck`, nine `test/core` files, `check:versions`, workforce lint, and the generated-`dist` check. Linux validate jobs time out at three minutes on `kontextmind-doks`. Windows validate jobs time out at fifteen minutes.

Code pushes also run the Linux Node 24 unit lanes, the Python lane, and plugin validation. Node 22.19.0 does not run the full unit suite. It runs `validate:pr`.

Nightly (`.github/workflows/nightly.yml`, 04:00 UTC) runs the complete suite with coverage floors. A nightly failure is a release blocker because it is the only place the simulation suite and coverage floors run.

## Windows lanes

Windows unit lanes run on a pull request only when the classifier sets `platform=true`: a package manifest, the lockfile, a file under `scripts/` or `.github/workflows/`, a filename that names path, process, shell, spawn, worker, supervisor, repo-root, or ssh-remote behavior, or `test/core/studio-layout.test.ts`.

The Windows matrix is the same lane names as Linux, including `light-1` and `light-2`, plus the two engine shards, on Node 24 and `windows-latest`, with a twenty-minute job timeout. `package-install.test.ts` stays on the serial lane because it dominated the light pool on Windows (pull requests #361, #362, and #363, recorded in `docs/contributing/ci-and-release.md`). Windows restores an `node_modules` cache. Linux does not.

Every push to `main` that changes code still runs the compact `validate:pr` gate on Windows, even when the pull request did not run the Windows unit lanes.
