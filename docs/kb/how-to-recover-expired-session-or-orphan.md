---
schema: "kxm.doc.v1"
id: "KB-BROWSER-008"
type: "kb"
title: "How do I recover an expired session or remove an orphaned browser?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Procedures for detecting and releasing stale or orphaned browser sessions on Steel."
tags: ["browser", "cleanup", "orphans", "troubleshooting"]
related: ["docs/browser-automation.md", "docs/kb/why-authentication-disappeared.md"]
---

# How do I recover an expired session or remove an orphaned browser?

If an automation run crashed or disconnected without calling `/release`, a browser container may remain idling on DOKS.

## 1. List Active Remote Sessions

```bash
STEEL_KEY=$(pass-cli item view --vault-name "AI Provider Keys" --item-title "Steel Browser (KontextMind DOKS)" --field STEEL_API_KEY)

curl -s https://steel.kontextmind.com/v1/sessions \
  -H "x-steel-api-key: $STEEL_KEY" | jq .
```

## 2. Release Orphaned Sessions

To terminate a specific stale session:

```bash
curl -s -X POST https://steel.kontextmind.com/v1/sessions/<SESSION_ID>/release \
  -H "x-steel-api-key: $STEEL_KEY"
```

## 3. Automatic Orphan Sweeping via KXM Client

The KXM client provides `checkOrphanedSessions(maxIdleMs)` to automate this:

```typescript
import { SteelClient } from "@kontextmind/kxm/runtime";

const client = new SteelClient();
const orphans = await client.checkOrphanedSessions(600000); // > 10 min idle

for (const sessionId of orphans) {
  console.log(`Releasing orphaned session: ${sessionId}`);
  await client.releaseSession(sessionId);
}
```
