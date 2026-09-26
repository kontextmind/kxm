---
schema: "kxm.doc.v1"
id: "REVIEW-DOCS-SITE-ARCH"
type: "architecture"
title: "Architecture review of the docs-site lane, commits e3d6329 to d57bcd0 (2026-09-26)"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-26"
updated: "2026-09-26"
authority: "hypothesis"
confidence: "verified"
summary: "PASS with three notes, pending the follow-up commits. The four commits implement the adapted specification: MkDocs Material config as specified, tailnet-only serve script that refuses wildcard and non-tailnet binds and returns 403 to listed crawlers, a deterministic roadmap generator over plans/kxm-roadmap/state.json (kxm.roadmap.v1) with seven phases seeded from the plans and the tracker, no done task without evidence, five drift rows that match the uncommitted planner files in main, an access schema that marks only the two permission claims and the read-only preset as enforced, and a hosted-direction page labeled as a target. All eight acceptance checks were run with evidence. Notes: the serve script's missing-site message still names a just recipe, the just recipes and their test pin are being removed by the follow-up, and the lane is one merge behind main. Planner record, not assignment, witness or acceptance proof."
tags: ["review", "docs", "roadmap", "site"]
related:
  - ../plan-lane-cli.md
  - ../plan-landing-gates.md
  - ../backlog-shortcuts.md
depends_on: []
blocked_by: []
details:
  reviewed_commits: "e3d6329, 687015e, 82ed448, d57bcd0"
  base_commit: "1d0de97"
  lane: "../kxm-docs-site"
  writer: "grok-4.7 via just impl-bg, ~28 min"
  follow_up: ".kxm/briefs/docs-site-logo.md (portal mark, palette, kxm docs build|serve, recipe removal)"
---

# Architecture review of the docs-site lane

**Verdict: PASS**, with three notes that the queued follow-up either fixes
or must fix before landing. Re-review after the follow-up lands on the lane.

## What was checked

- `mkdocs.yml` against the specification: theme, features, extensions,
  snippets base path, mermaid fence, search plugin, nav validation. All
  present. Nav: Home, Roadmap (dashboard, master, seven phases),
  Architecture, then the existing sections.
- `ops/docs-site/serve.py`: tailnet address discovered from `tailscale ip`,
  the Tailscale app binary, or an interface in `100.64.0.0/10`; `bind`
  refuses `0.0.0.0`, `::`, and any non-tailnet address; port 80 first then
  8765 to 8780; the three headers on every response; 403 for user agents
  listed in `docs/robots.txt`. Verified live from this session: home 200,
  GPTBot 403, headers present, loopback refused.
- `plans/kxm-roadmap/state.json`: `kxm.roadmap.v1`, seven phases, sources
  named, two `later` phases, `architecture.verified` null, five drift rows,
  zero contacts, and no task marked done without an `evidence` field.
- `plans/kxm-roadmap/update-dashboard.mjs`: Node only, deterministic, does
  not write `state.json`, tries `mkdocs` on `PATH` then
  `uv tool run --from mkdocs-material mkdocs build`. The writer found that
  `uv tool install mkdocs-material` cannot work because the package
  exposes no executable of its own; the fallback is the working path.
- `docs/roadmap/dashboard.md`: leads with Next (Python migration), its
  seven open tasks, blockers, questions; `later` phases are excluded from
  Next and from the active counts.
- `docs/architecture/access-schema.yaml`: `enforced: true` only on the
  `edit` and `read-only` claims and the `read-only` grant; principals,
  groups, and the writer presets are `false` with a note. That matches the
  code: agent presets and permissions are enforced, role-level tools are
  only counted.
- `docs/architecture/hosted-direction.md` opens with "Target. This page is
  a direction, not a live deployment." and says which plan is absent from
  the checkout rather than inventing it.
- `docs/architecture/inventory.md`: sixteen rows, each with a defining
  file; listeners are `127.0.0.1` or stdio or none; no address outside the
  repo's own defaults.
- The writer's result file records all eight acceptance checks with the
  command or observation behind each, including a headless-browser check
  of the Full screen control on three diagram pages, and a second generator
  run with an unchanged state hash.

## Notes

1. **`ops/docs-site/serve.py` line 160 still says "Run: just docs-build".**
   The follow-up removes the `docs-build` recipe and adds `kxm docs build`;
   that message must change with it. Not in the follow-up brief by name;
   the CLI critic's brief will ask for it, and it is a one-line fix if the
   writer misses it.
2. **The just recipes and their test pin** (`82ed448`) contradict the
   migration rule that arrived after the brief was written. The follow-up
   brief removes both and adds the `kxm docs` group with skill ownership.
3. **The lane is one merge behind `main`** (#330 landed while it was
   written). Landing needs a rebase; the conflict surface is `CHANGELOG.md`
   Unreleased and `justfile`, both small.

## Drift the writer recorded, and what it means

Four of the five drift rows point at files that exist only uncommitted in
the main checkout: the greenfield plan, the python evidence, and the
`python/` tree. That is backlog item S6 seen from the other side. The
docs-only PR that lands the planner artifacts should go in before the
roadmap's first deep review, or the review will revert those rows again.

## Follow-ups already recorded

- S15 in `plans/backlog-shortcuts.md`: the first `/reanalyze-roadmap` pass
  with its critic is the real baseline.
- The `docs` and `milestone` stages in `plans/plan-landing-gates.md` are
  what will keep these pages current without hand runs.
