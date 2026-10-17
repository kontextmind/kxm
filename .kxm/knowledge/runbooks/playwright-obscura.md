---
title: Playwright tests via Obscura
summary: Run the repository Playwright smoke against pinned Obscura over CDP.
tags: [runbook, playwright, obscura, test]
updated: "2026-10-17"
sources:
  - package.json
  - playwright.config.ts
  - test/e2e/fixtures.ts
  - test/e2e/obscura-smoke.spec.ts
  - .github/workflows/e2e.yml
  - docs/kb/how-to-connect-playwright-to-obscura.md
  - docs/adr/ADR-0005-obscura-default-playwright.md
  - plugins/kxm/src/browser.ts
  - scripts/obscura.mjs
---

# Playwright tests via Obscura

Obscura is the default browser for Playwright testing. Steel stays the browser for human takeover, MFA, and the live session viewer (`KXM_BROWSER=steel`). ADR-0005 records that split (`docs/adr/ADR-0005-obscura-default-playwright.md`).

## Run the smoke

From the repository root:

```bash
npm run e2e
```

`package.json` defines that script as `node scripts/obscura.mjs --ensure && playwright test`.

`scripts/obscura.mjs --ensure` downloads pinned Obscura v0.2.3 for this OS and architecture into `.kxm/bin/` (gitignored) and starts `obscura serve --port ${OBSCURA_PORT:-9222} --allow-private-network`. `--allow-private-network` is required. Without it, `page.goto("http://127.0.0.1/...")` fails with `Access to private/internal IP address`. Readiness is HTTP GET `http://127.0.0.1:${OBSCURA_PORT:-9222}/json/version`. The Linux build needs glibc 2.35 or newer (`docs/kb/how-to-connect-playwright-to-obscura.md`).

Do not run `playwright install`. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so Playwright's postinstall does not download its own browsers. `.github/workflows/e2e.yml` sets that variable.

## What the test attaches to

`playwright.config.ts` sets `testDir` to `test/e2e`, one worker, the list reporter, traces retained on failure, and video off.

`test/e2e/fixtures.ts` overrides the worker-scoped `browser` fixture. It calls `connectBrowserOverCdp` in `plugins/kxm/src/browser.ts`, which uses `chromium.connectOverCDP()`. Playwright's own transport (`chromium.connect`, `use.connectOptions`) does not work against Obscura. `resolveObscuraCdpEndpoint()` returns `OBSCURA_CDP_URL`, or `http://127.0.0.1:${OBSCURA_PORT:-9222}` when that variable is unset. `ws://127.0.0.1:9222`, `ws://127.0.0.1:9222/devtools/browser`, and `http://127.0.0.1:9222` all connect.

`test/e2e/obscura-smoke.spec.ts` serves a page on `127.0.0.1` with an ephemeral port and expects the title `KXM Obscura smoke` and the heading `obscura-local-ok`.

## CI

`.github/workflows/e2e.yml` runs `npm run e2e` on `ubuntu-latest` for pull requests and `workflow_dispatch`. It caches `.kxm/bin` under `obscura-v0.2.3`. It is not a job in `.github/workflows/ci.yml`, so it is not part of `CI / required`. Nightly and Real Pi smoke stay disabled in that workflow's header comment.

## Steel

The fixture builds a session object when `STEEL_SESSION_ID` is set. `connectBrowserOverCdp` still uses Obscura unless `KXM_BROWSER=steel`. That setting requires a Steel session id and sends Steel headers on the handshake. The default is Obscura with empty headers (`plugins/kxm/src/browser.ts`). The Steel connection steps are `docs/kb/how-to-connect-playwright-to-steel.md`.
