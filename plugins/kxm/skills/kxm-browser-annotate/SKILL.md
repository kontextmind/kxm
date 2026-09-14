---
name: kxm-browser-annotate
description: Capture a visual DOM section or element, attach structured annotations and change requests, and send them back to the agent.
---

# KXM Browser Section Capture & Visual Annotation Feedback

Use this skill to capture visual screenshots of specific UI sections or elements from a Steel browser session, record structured design/code annotations, and feed actionable change requests directly back to an AI coding agent.

## Purpose & Scope

- Enable human operators and critic agents to visually review web interfaces.
- Crop or capture specific DOM elements, cards, modals, or viewport bounding boxes.
- Attach structured notes (e.g. alignment issues, color contrast, missing data, layout bugs) with severity ratings.
- Provide a standardized Markdown/JSON feedback payload that an agent can parse and implement immediately.

## Workflow

```text
1. CAPTURE SECTION
   └─ Use Playwright element.screenshot() or agent-browser screenshot to isolate the target component.

2. ATTACH ANNOTATIONS
   └─ Record bounding box / element selector, defect note, and severity rating.

3. ASSEMBLE FEEDBACK PACKAGE
   └─ Package screenshot artifact, element selectors, notes, and concrete change list.

4. HANDOFF TO AGENT
   └─ Inject formatted visual feedback into agent context or KXM workflow run.

5. AGENT IMPLEMENTS FIX
   └─ Agent modifies code, re-captures the section, and verifies the change visually and with Playwright.
```

## Capturing a Specific Section with Playwright

```typescript
import { chromium } from "playwright";
import { resolveSteelConfig, formatCDPEndpoint } from "@kontextmind/kxm/runtime";

async function captureSection(sessionId: string, selector: string, outputPath: string) {
  const config = resolveSteelConfig();
  const cdpUrl = formatCDPEndpoint({ id: sessionId, websocketUrl: "" }, config);

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  const element = page.locator(selector);
  await element.screenshot({ path: outputPath });

  await browser.close();
}
```

## Structured Feedback Schema

```json
{
  "sessionId": "sess_12345",
  "url": "https://app.example.com/settings/billing",
  "sectionSelector": "[data-testid='subscription-card']",
  "screenshotPath": ".kxm/artifacts/browser/billing-card.png",
  "overallSummary": "Pricing tier badge overflows card boundary on narrow screens",
  "annotations": [
    {
      "label": "Badge Overflow",
      "selector": ".badge-tier",
      "note": "Text overflows container when tier name is 'Enterprise Plus'",
      "severity": "fix"
    },
    {
      "label": "Button Padding",
      "selector": "button.upgrade-btn",
      "note": "Increase vertical padding from 8px to 12px for touch target compliance",
      "severity": "suggestion"
    }
  ],
  "requestedChanges": [
    "Add `overflow: hidden` or `flex-wrap: wrap` to the subscription header container",
    "Update `.badge-tier` CSS to support dynamic text wrapping",
    "Adjust `button.upgrade-btn` padding to `py-3 px-4`"
  ]
}
```

## Formatting for the Agent

Use `formatAnnotationFeedbackPrompt()` from `@kontextmind/kxm/runtime` to render a clean, checklist-driven prompt that the agent executes step-by-step.
