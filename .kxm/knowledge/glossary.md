---
title: Glossary
summary: Short definitions for the terms this wiki uses, each tied to a repository source.
tags: [glossary]
updated: "2026-10-17"
sources:
  - docs/glossary.md
  - docs/contracts/architecture.md
  - docs/contracts/README.md
  - .kxm/README.md
  - plugins/kxm/src/wiki.ts
  - plugins/kxm/src/engine.ts
---

# Glossary

The normative vocabulary for published docs is `docs/glossary.md` and `docs/contracts/terminology.md`. This page only defines terms the wiki pages rely on.

## Admission

The decision that a route may run live. `kxm routes admit` lists the selector under `admitted` in `.kxm/routes.yaml`. `kxm routes disable` blocks it. A live drive refuses an unadmitted route with `producer_route_not_admitted` (`docs/glossary.md`).

## Auto-Release

The workflow `.github/workflows/auto-release.yml`. On a merged pull request to `main` it tags the next patch and dispatches the Release workflow.

## CI / required

The aggregate status check from the job `required` in `.github/workflows/ci.yml`. It fails when a lane fails or is cancelled, and it passes when a lane was skipped on purpose.

## Engine

The Runtime workflow engine in `plugins/kxm/src/engine.ts`. It compiles a workflow, dispatches harness attempts, and appends run, step, assignment, attempt, and effect events. The accepted contract calls the local Runtime the execution owner (`docs/contracts/architecture.md`). Plans name that target vNext.

## Harness

The CLI that runs a model: `claude`, `codex`, `grok`, `agy`, `kimi`, `deepseek`, or `pi`. A harness is not a model. Only Pi is treated as a long-lived worker (`docs/reference/harness-routing.md`).

## Hub

The Node process that serves HTTP and server-sent events, default `127.0.0.1:7331`, and stores coordination state in `.kxm/state/kxm.db`. It does not run a model (`docs/concepts/architecture.md`).

## MCP plugin

The Claude Code plugin in `plugins/kxm`. Its MCP server speaks stdio and calls the hub. The same directory builds the Pi extension.

## Obscura

The pinned headless Chromium (v0.2.3) that Playwright attaches to with `chromium.connectOverCDP()`. It is the default for tests. Steel remains the browser for human takeover (`docs/adr/ADR-0005-obscura-default-playwright.md`).

## Role

A `kxm.role.v2` file in `.kxm/roles/` that names a purpose (`writer`, `planner`, `reviewer-arch`, `reviewer-cli`) and a roster. When the file exists, a Runtime step for that role may run only routes in the roster (`docs/glossary.md`).

## Roster

The ordered `roster` list on a role file. Order is rotation priority. The first admitted route with a readable model file is the one dispatch uses.

## Route

Two ids are easy to mix. The file id, such as `grok-grok-4-7`, names `.kxm/models/<id>.yaml` and is what a roster stores. The selector, such as `xai/grok-4.7` or `openrouter/qwen/qwen3.7-plus`, is what `.kxm/routes.yaml` admits. The harness comes from the model file.

## Runtime

The local supervisor that owns workflow execution (`plugins/kxm/src/runtime-supervisor.ts`). Hub unavailability does not prevent local work (`docs/contracts/README.md`).

## Wiki

Two trees share `.kxm/knowledge/`:

- **Authored wiki.** These markdown pages. Maintainers edit them. They are not loaded as skills or policy.
- **Compiled wiki.** Pages `kxm context wiki-compile` writes under `.kxm/knowledge/wiki/` from hub context records. `kxm context wiki-lint` checks that generated view. The product docs say the compiled wiki ships and is not a selected feature (`docs/guides/context-and-memory.md`).
