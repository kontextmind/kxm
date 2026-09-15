---
schema: "kxm.doc.v1"
id: "GUIDE-BROWSER-001"
type: "guide"
title: "KXM Browser Automation Guide"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-15"
authority: "instruction"
confidence: "verified"
summary: "Comprehensive guide to browser automation in KXM using self-hosted Steel on DOKS, agent-browser, Playwright, pass-cli, and human takeover."
tags: ["browser", "automation", "steel", "playwright", "agent-browser", "doks"]
related: ["docs/adr/ADR-0002-browser-automation-steel-doks.md", "docs/agent-skills.md"]
---

# KXM Browser Automation Guide

This guide describes how to use KXM's browser automation capability powered by self-hosted Steel on DigitalOcean Kubernetes (DOKS), `agent-browser` for exploratory inspection, `Playwright` for automated regression testing, and `pass-cli` for credential security.

---

## 1. Architecture & Trust Boundaries

```text
Herdr / Pi / Agent Harness
  │
  ├──► KXM Browser Skills & Prompts (kxm-browser-*)
  │
  ├──► pass-cli (Authoritative Vault: "AI Provider Keys")
  │
  ├──► agent-browser (Exploratory CLI) ──┐
  │                                      │ (CDP WebSocket)
  ├──► Playwright (E2E Test Suites) ────┼──► DOKS Steel Browser Cluster
  │                                      │   (https://steel.kontextmind.com)
  └──► Human Operator (Takeover UI) ─────┘   (https://steel.kontextmind.com/ui)
```

### Key Components

1. **Steel on DOKS (`https://steel.kontextmind.com`)**:
   - Primary browser execution environment.
   - Isolated Chromium containers with dedicated shared memory (`/dev/shm`).
   - Exposed endpoints: REST API (port 443 / 3000), CDP WebSocket proxy (port 443 / 9223), Web UI (`/ui`), OpenAPI docs (`/documentation`).
2. **`pass-cli`**:
   - The authoritative store for all long-lived passwords, session tokens, and the `STEEL_API_KEY`.
   - Never write credentials to tracked git files.
3. **`agent-browser`**:
   - Fast, token-efficient terminal CLI for accessibility snapshots, interactive navigation, and exploratory testing.
4. **`Playwright`**:
   - High-fidelity assertion engine for bug reproduction, visual proofs, and permanent regression suites.

---

## 2. Getting Started: The First Browser Workflow

### Step 1: Verify Prerequisites

Check that `pass-cli` can access the Steel configuration:

```bash
pass-cli item view --vault-name "AI Provider Keys" --item-title "Steel Browser (KontextMind DOKS)"
```

### Step 2: Launch a Steel Browser Session

```bash
STEEL_KEY=$(pass-cli item view --vault-name "AI Provider Keys" --item-title "Steel Browser (KontextMind DOKS)" --field STEEL_API_KEY)

# Create a 5-minute session
SESSION_RESP=$(curl -s -X POST https://steel.kontextmind.com/v1/sessions \
  -H "Content-Type: application/json" \
  -H "x-steel-api-key: $STEEL_KEY" \
  -d '{"timeout": 300000}')

SESSION_ID=$(echo "$SESSION_RESP" | jq -r .id)
echo "Session created: $SESSION_ID"
```

### Step 3: Run Exploratory Automation or Scrapes

To run a fast scrape without managing sessions:

```bash
curl -s -X POST https://steel.kontextmind.com/v1/scrape \
  -H "Content-Type: application/json" \
  -H "x-steel-api-key: $STEEL_KEY" \
  -d '{"url": "https://example.com"}'
```

### Step 4: Release the Session

```bash
curl -s -X POST https://steel.kontextmind.com/v1/sessions/$SESSION_ID/release \
  -H "x-steel-api-key: $STEEL_KEY"
```

---

## 3. Human Takeover Protocol

When authentication challenges (MFA, CAPTCHA, SSO) are encountered:

1. **Agent Pauses**: The agent stops automated actions and sets state to `HUMAN_CONTROL`.
2. **Emits Link**: Emits the protected URL: `https://steel.kontextmind.com/ui?sessionId=<SESSION_ID>`.
3. **Human Interacts**: The operator opens the session viewer, completes the login/MFA action, and confirms in the terminal (`auth complete`).
4. **Agent Verifies**: The agent inspects the resulting page, confirms dashboard/user state, refreshes DOM observations, and returns to `AGENT_CONTROL`.

---

## 4. Resource Controls & Cost Safety

- **Session Timeouts**: Default 300s (5m), max 1800s (30m). Sessions terminate automatically on expiry.
- **Orphan Sweeping**: Periodically sweep untracked sessions via `GET /v1/sessions` and release idle processes.
- **Memory Protection**: Kubernetes mounts a 2Gi `emptyDir` memory volume at `/dev/shm` to prevent Chromium tab crashes without exhausting node memory.

---

## Knowledge base

- [How are credentials retrieved without exposing them to the model?](kb/how-credentials-retrieved-safely.md)
- [How do I capture a UI section and annotate changes for an agent?](kb/how-to-capture-and-annotate-section.md)
- [How do I connect Playwright to the existing Steel session?](kb/how-to-connect-playwright-to-steel.md)
- [How do I recover an expired session or remove an orphaned browser?](kb/how-to-recover-expired-session-or-orphan.md)
- [How does an agent resume after MFA?](kb/how-to-resume-after-mfa.md)
- [How do I take over a browser session to log in?](kb/how-to-take-over-session.md)
- [Why did authentication disappear?](kb/why-authentication-disappeared.md)
- [Why did automation open a different browser?](kb/why-automation-opened-different-browser.md)
- [Why can I view a session but not control it?](kb/why-session-viewer-cannot-control.md)

## Prompt templates

- [Starting browser work](prompts/browser-start.md)
- [Exploring an application](prompts/browser-explore.md)
- [Requesting human takeover](prompts/browser-takeover.md)
- [Diagnosing and recovering a failed session](prompts/browser-diagnose-recover.md)
- [Reproducing a UI bug and writing a Playwright test](prompts/browser-repro-fix.md)
- [Capturing UI section annotations](prompts/browser-annotate-feedback.md)
