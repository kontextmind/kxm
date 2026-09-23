---
schema: "kxm.doc.v1"
id: "KB-BROWSER-008"
type: "kb"
title: "How do I recover an expired session or remove an orphaned browser?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "Find and release stale or orphaned browser sessions on Steel."
tags: ["browser", "cleanup", "orphans", "troubleshooting"]
related: ["docs/guides/browser-automation.md", "docs/kb/why-authentication-disappeared.md"]
---

# How do I recover an expired session or remove an orphaned browser?

If an automation run crashed or disconnected without releasing its session, the
browser can keep running on your Steel deployment until its timeout.

## 1. List active sessions

Load `STEEL_API_URL` and `STEEL_API_KEY` from your secret manager first. With
`pass-cli`, for example:

```bash
export STEEL_API_URL="https://<steel-host>"
STEEL_API_KEY=$(pass-cli item view --vault-name "<vault>" --item-title "<item>" --field STEEL_API_KEY)
export STEEL_API_KEY

curl -s "$STEEL_API_URL/v1/sessions" \
  -H "x-steel-api-key: $STEEL_API_KEY" | jq .
```

## 2. Release an orphaned session

```bash
curl -s -X POST "$STEEL_API_URL/v1/sessions/<session-id>/release" \
  -H "x-steel-api-key: $STEEL_API_KEY"
```

## 3. Sweep orphans with the KXM client

`checkOrphanedSessions(maxIdleMs)` returns two kinds of session: live or idle
sessions this client does not track that have run longer than the limit, and
tracked sessions idle longer than the limit, unless a person has taken over.
`releaseSession()` releases one:

```typescript
import { SteelClient } from "@kontextmind/kxm/runtime";

const client = new SteelClient();
const orphans = await client.checkOrphanedSessions(600000); // idle over 10 minutes

for (const sessionId of orphans) {
  console.log(`Releasing orphaned session: ${sessionId}`);
  await client.releaseSession(sessionId);
}
```

It returns an empty list when the Steel API request fails, so an empty result
does not prove there are no orphans. Check with the `curl` call above.
