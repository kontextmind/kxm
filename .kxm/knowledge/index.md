---
title: KXM project knowledge wiki
summary: Authored maintainer notes for this repository. The hub-compiled view is a different tree.
tags: [index, wiki, kxm]
updated: "2026-10-17"
sources:
  - plugins/kxm/src/wiki.ts
  - docs/guides/context-and-memory.md
  - plans/history/v05-context-os.md
---

# KXM project knowledge wiki

These pages are the checked-in project wiki for kontextmind/kxm. They give the daily maintenance pass a tree to read and update. Each page records facts that already appear in this repository and lists those files under `sources`.

`kxm context wiki-compile` and `kxm context wiki-lint` compile hub context records. They do not read this tree. With `--out`, compile writes `.kxm/knowledge/wiki/`. That output is a generated view, not these notes. There is no `kxm knowledge` or `kxm wiki` command.

## Page format

Every page starts with YAML front matter:

| Field | Contents |
|---|---|
| `title` | Sentence-case page title |
| `summary` | One sentence |
| `tags` | Short labels |
| `updated` | ISO date of the last fact change |
| `sources` | Repo-relative paths the page was read from |

Keep claims tied to a source path. When a fact changes, edit the page, refresh `updated`, and adjust `sources`.

## Pages

| Page | What it holds |
|---|---|
| [Architecture overview](architecture/overview.md) | Hub, harnesses, MCP plugin, Runtime engine, and how they connect |
| [Harness routing and rosters](decisions/harness-routing.md) | Current writer and reviewer rosters and the pull requests that set them |
| [Model catalog refresh](decisions/model-catalog-refresh.md) | Monday OpenRouter price and inventory refresh, manual run, and the guard |
| [Release flow](patterns/release-flow.md) | Squash auto-merge, `CI / required`, Auto-Release, GitHub release, and npm |
| [CI conventions](patterns/ci.md) | Fast pull-request lane, full matrix after merge, Windows lanes |
| [Failed release](runbooks/failed-release.md) | How to tell a skipped tag, a failed Release, and a lagging npm publish apart |
| [Model routes](runbooks/model-routes.md) | Add or retire a route without leaving a roster or alias behind |
| [Playwright via Obscura](runbooks/playwright-obscura.md) | Run the Obscura Playwright smoke |
| [Glossary](glossary.md) | Terms used in this wiki |
