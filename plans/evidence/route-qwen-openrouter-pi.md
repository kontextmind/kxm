---
schema: "kxm.doc.v1"
id: "RES-QWEN-OPENROUTER-PI"
type: "research"
title: "Research: qwen-openrouter-pi writer admission"
project: "kxm"
status: "approved"
owner: "@operator"
created: "2026-09-07"
updated: "2026-09-07"
authority: "evidence"
confidence: "verified"
summary: "OpenRouter Qwen is admitted as a Pi writer because it has no native harness here, with exact-model auth and edit permission."
tags: ["routing", "qwen", "pi"]
related: []
details:
  research_status: "complete"
  target_decision_date: "2026-09-07"
---

# qwen-openrouter-pi

Dated 2026-09-07. Route id `qwen-openrouter-pi`. Harness `pi`. Model id `openrouter/qwen/qwen3-coder-plus`. Vendor `alibaba` (billed through OpenRouter). Admitted as a writer because Qwen has no supported native harness on this runner, and the operator admitted that exact model with edit permission. Auth was proved with `pi auth check --provider openrouter`.
