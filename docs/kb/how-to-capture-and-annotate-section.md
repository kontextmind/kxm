---
schema: "kxm.doc.v1"
id: "KB-BROWSER-009"
type: "kb"
title: "How do I capture a UI section and annotate changes for an agent?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "Capture one DOM element, attach annotations, and send structured change feedback to an agent."
tags: ["browser", "annotation", "screenshot", "feedback", "ui"]
related: ["docs/guides/browser-automation.md", "docs/prompts/browser-annotate-feedback.md"]
---

# How do I capture a UI section and annotate changes for an agent?

When you review a web interface in a Steel session, you can isolate one
component, annotate it, and send a structured change request back to an agent.

## Workflow

1. **Capture the component.** Use a Playwright element screenshot to crop only
   the affected container:

   ```typescript
   await page.locator(".billing-card").screenshot({ path: ".kxm/artifacts/browser/billing-card.png" });
   ```

2. **Write the annotation feedback.** Record the target selector, the observed
   issues and the required fixes:

   ```typescript
   import { createAnnotationFeedback, formatAnnotationFeedbackPrompt } from "@kontextmind/kxm/runtime";

   const feedback = createAnnotationFeedback({
     url: "https://app.example.com/settings/billing",
     sectionSelector: ".billing-card",
     screenshotPath: ".kxm/artifacts/browser/billing-card.png",
     overallSummary: "Billing tier layout breaks on mobile viewport",
     annotations: [
       {
         label: "Tier name overflow",
         selector: ".tier-title",
         note: "Truncate or wrap long tier titles with an ellipsis",
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

3. **Send it to the agent.** Put the rendered prompt into the agent session or
   the workflow run. The agent reads the screenshot, finds the source, applies
   the changes, and verifies the result with Playwright.
