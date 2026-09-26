---
description: Rebuild the docs site from the roadmap state without reanalyzing
---

From the repository root, run `kxm docs build` (`node plans/kxm-roadmap/update-dashboard.mjs` is the fallback).

Do not edit `plans/kxm-roadmap/state.json`. Do not reanalyze the roadmap.

When the command finishes, show the Next section of `docs/roadmap/dashboard.md`.
