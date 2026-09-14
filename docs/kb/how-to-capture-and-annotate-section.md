---
schema: "kxm.doc.v1"
id: "KB-BROWSER-009"
type: "kb"
title: "How do I capture a UI section and annotate changes for an agent?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Guide to capturing specific DOM elements, attaching visual annotations, and submitting structured change feedback to the agent."
tags: ["browser", "annotation", "screenshot", "feedback", "ui"]
related: ["docs/browser-automation.md", "docs/prompts/browser-annotate-feedback.md"]
---

# How do I capture a UI section and annotate changes for an agent?

When reviewing a web interface in a Steel session, you can isolate a specific component, attach annotations, and deliver structured change requests directly back to an agent.

## Workflow

1. **Capture the Component**:
   Use Playwright element screenshotting to crop only the affected container:

   ```typescript
   await page.locator('.billing-card').screenshot({ path: '.kxm/artifacts/browser/billing-card.png' });
   ```

2. **Draft the Annotation Feedback**:
   Record the target selector, observed issues, and required fixes:

   ```typescript
   import { createAnnotationFeedback, formatAnnotationFeedbackPrompt } from "@kontextmind/kxm/runtime";

   const feedback = createAnnotationFeedback({
     url: "https://app.example.com/settings/billing",
     sectionSelector: ".billing-card",
     screenshotPath: ".kxm/artifacts/browser/billing-card.png",
     overallSummary: "Billing tier layout breaks on mobile viewport",
     annotations: [
       {
         label: "Tier Name Overflow",
         selector: ".tier-title",
         note: "Truncate or wrap long tier titles with ellipsis",
         severity: "fix"
       }
     ],
     requestedChanges: [
       "Update `.tier-title` CSS to include `truncate` or `break-words`",
       "Adjust padding on small viewports to `px-4`"
     ]
   });

   const prompt = formatAnnotationFeedbackPrompt(feedback);
   ```

3. **Send to the Agent**:
   Feed the rendered prompt into the agent session or KXM workflow run. The agent reads the screenshot, navigates to the source code, applies the changes, and verifies the result with Playwright.
