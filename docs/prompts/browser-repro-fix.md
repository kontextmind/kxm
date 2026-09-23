---
schema: "kxm.doc.v1"
id: "PROMPT-BROWSER-005"
type: "prompt"
title: "Reproduce a UI bug and produce a Playwright regression test"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "Reproduce a UI defect on Steel, collect evidence, write a Playwright regression, and prove RED then GREEN."
tags: ["browser", "playwright", "repro", "prompt"]
related: ["docs/guides/browser-automation.md", "docs/kb/how-to-connect-playwright-to-steel.md"]
---

# Task template: reproduce a UI bug and produce a Playwright regression test

## Purpose

Use this prompt to execute the full UI defect lifecycle: reproducing reported symptoms on self-hosted Steel, collecting diagnostic evidence, writing a durable Playwright test, demonstrating failure before fix (RED), applying the code fix, and demonstrating success afterward (GREEN).

## Canonical skill references

- `kxm-browser-verify`
- `kxm-browser-session`
- `kxm-browser-diagnostics`

## Parameters and placeholders

- **PROJECT_ID**: `{{PROJECT_ID}}`
- **BUG_ID**: `{{BUG_ID}}` (e.g. `BUG-402-DROPDOWN-CLIPPING`)
- **TARGET_URL**: `{{TARGET_URL}}`
- **EXPECTED_BEHAVIOR**: `{{EXPECTED_BEHAVIOR}}`
- **ACTUAL_BEHAVIOR**: `{{ACTUAL_BEHAVIOR}}`
- **TEST_FILE_PATH**: `{{TEST_FILE_PATH}}` (e.g. `test/e2e/{{BUG_ID}}.spec.ts`)
- **ARTIFACT_DIR**: `{{ARTIFACT_DIR}}` (e.g. `.kxm/artifacts/browser/{{BUG_ID}}`)

---

## Instructions for the agent

1. **Step 1: Reproduce**:
   - Connect to a Steel browser session and manually or scriptedly walk the repro steps.
   - Confirm that actual behavior matches `{{ACTUAL_BEHAVIOR}}`.

2. **Step 2: Collect Diagnostic Evidence**:
   - Capture console error logs, network failure traces, and a screenshot of the broken UI into `{{ARTIFACT_DIR}}/before.png`.

3. **Step 3: Write Durable Playwright Test**:
   - Author a Playwright test at `{{TEST_FILE_PATH}}` asserting `{{EXPECTED_BEHAVIOR}}`.
   - Use semantic locators (`getByRole`, `getByText`, `getByLabel`) rather than brittle XPath or dynamic classes.

4. **Step 4: Demonstrate Failure (RED)**:
   - Run the test: `npx playwright test {{TEST_FILE_PATH}}`.
   - Verify the test fails cleanly with an assertion error that directly explains the defect.

5. **Step 5: Implement Code Fix**:
   - Modify the source code to resolve the defect.

6. **Step 6: Demonstrate Success (GREEN)**:
   - Re-run the Playwright test: `npx playwright test {{TEST_FILE_PATH}}`.
   - Capture clean verification output and screenshot `{{ARTIFACT_DIR}}/after.png`.
   - Release the Steel session upon completion.
