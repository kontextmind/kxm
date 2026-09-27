---
schema: "kxm.doc.v1"
id: "RES-PI-QWEN3-8-FLASH-OPENROUTER"
type: "research"
title: "Research: pi-qwen3-8-flash-openrouter fallback admission"
project: "kxm"
status: "approved"
owner: "@operator"
created: "2026-09-27"
updated: "2026-09-27"
authority: "evidence"
confidence: "verified"
summary: "OpenRouter Qwen3.8 Flash is a read-only Pi fallback for planner and reviewer-cli because Qwen has no native harness here."
tags: ["routing", "qwen", "pi"]
related: []
details:
  research_status: "complete"
  target_decision_date: "2026-09-27"
---

# pi-qwen3-8-flash-openrouter

Dated 2026-09-27. Route id `pi-qwen3-8-flash-openrouter`. Harness `pi`. Model id `openrouter/qwen/qwen3.8-flash`. Vendor `alibaba` (billed through OpenRouter). Read-only fallback for `planner` and `reviewer-cli`. Qwen has no supported native harness on this runner. The selector was already on the admitted list. It is not a writer: the only admitted Pi writer remains `openrouter/qwen/qwen3-coder-plus` with edit permission.
