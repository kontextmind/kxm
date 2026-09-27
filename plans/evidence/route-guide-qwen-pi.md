---
schema: "kxm.doc.v1"
id: "RES-GUIDE-QWEN-PI"
type: "research"
title: "Research: guided setup Pi Qwen origin"
project: "kxm"
status: "approved"
owner: "@operator"
created: "2026-09-26"
updated: "2026-09-26"
authority: "evidence"
confidence: "verified"
summary: "Guided setup pins every Pi model origin to this note so a later project.yaml edit cannot change the hash."
tags: ["routing", "qwen", "pi", "init-guide"]
related: []
details:
  research_status: "complete"
  target_decision_date: "2026-09-26"
---

# route-guide-qwen-pi

Dated 2026-09-26. Route ids are the guided role slugs. Harness `pi`. Model id `qwen/qwen3-coder-plus`. Vendor `openrouter`. Admitted because Qwen has no supported native harness on this runner, and the operator admitted that exact model for guided setup. Auth was proved with `pi auth check --provider openrouter`.
