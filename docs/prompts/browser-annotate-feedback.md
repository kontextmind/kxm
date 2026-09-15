---
schema: "kxm.doc.v1"
id: "PROMPT-BROWSER-006"
type: "prompt"
title: "Capturing UI Section Annotations and Sending Changes to Agent"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-15"
authority: "instruction"
confidence: "verified"
summary: "Turn annotated Steel UI-section feedback into source changes and recapture verified proof."
tags: ["browser", "annotation", "feedback", "prompt"]
related: ["docs/browser-automation.md", "docs/kb/how-to-capture-and-annotate-section.md"]
---

# Task Template: Capturing UI Section Annotations and Sending Changes to Agent

## Purpose

Use this prompt when a human operator or design critic has reviewed a UI section in a Steel browser session and wants to send annotated visual change requests back to the agent for remediation.

## Canonical Skill References

- `kxm-browser-annotate`
- `kxm-browser-verify`
- `kxm-browser-session`

## Parameters & Placeholders

- **PROJECT_ID**: `{{PROJECT_ID}}`
- **TASK_ID**: `{{TASK_ID}}`
- **TARGET_URL**: `{{TARGET_URL}}`
- **SECTION_SELECTOR**: `{{SECTION_SELECTOR}}` (e.g. `.pricing-grid` or `[data-testid="navbar"]`)
- **SCREENSHOT_ARTIFACT**: `{{SCREENSHOT_ARTIFACT}}` (e.g. `.kxm/artifacts/browser/nav-review.png`)
- **SUMMARY_OF_DEFECT**: `{{SUMMARY_OF_DEFECT}}`
- **ANNOTATION_LIST**: `{{ANNOTATION_LIST}}` (List of element notes and bounding boxes)
- **ACTIONABLE_CHANGES**: `{{ACTIONABLE_CHANGES}}` (Checklist of required code modifications)

---

## Instructions for Agent

1. **Review Visual Feedback**:
   - Inspect the section screenshot at `{{SCREENSHOT_ARTIFACT}}`.
   - Read the annotations: `{{ANNOTATION_LIST}}`.

2. **Locate Target Source Code**:
   - Identify the component / styles responsible for `{{SECTION_SELECTOR}}`.

3. **Implement Requested Changes**:
   - Apply the fixes defined in `{{ACTIONABLE_CHANGES}}`.

4. **Verify and Re-Capture**:
   - Re-run the local build / dev server or test suite.
   - Using Playwright or Steel, re-capture `{{SECTION_SELECTOR}}` into `.kxm/artifacts/browser/{{TASK_ID}}-verified.png`.
   - Confirm all annotated issues are resolved.
