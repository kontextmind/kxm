---
schema: "kxm.doc.v1"
id: "REVIEW-AUTHENTIK-HOSTING-DESIGN-ASTRA"
type: "architecture"
title: "Codex gpt-6-astra design pass: hub + Studio auth for per-tenant hosting"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-20"
updated: "2026-09-20"
authority: "hypothesis"
confidence: "medium"
summary: "Independent design pass behind plan-per-tenant-hosting.md: architecture A (Authentik at the edge; the hub stays a bearer-token resource server with an optional proxy-asserted browser boundary), verified baseline with eight corrections, two-mode behaviour, threat model, credential lifecycle, CLI grammar, UI/UX states, six slices, footprint budget. Design input and critic opinion, not assignment, witness or acceptance proof."
tags: ["review", "hub", "studio", "auth", "hosting"]
related:
  - ../plan-per-tenant-hosting.md
  - ../implementation-plan.md
depends_on: []
blocked_by: []
details:
  transport: "codex exec -s read-only -m gpt-6-astra -c model_reasoning_effort=high"
  reviewed_commit: "6d9aa5f"
  model: "gpt-6-astra (ChatGPT auth, unmetered)"
---

# Codex gpt-6-astra design pass — per-tenant hosting auth

Transcript preserved as produced. Where it and
[`plan-per-tenant-hosting.md`](../plan-per-tenant-hosting.md) differ, the plan wins only where it
records a later operator decision — one tenant per box, hosting strictly optional, no PostgreSQL
write path, two MVP slices instead of six. The record keeps the detail the plan deliberately cut:
the verified-baseline corrections, the CLI transcripts, the UI/UX state list, the footprint
measurements. Nothing here was accepted because it was written down.

The most load-bearing content in this record is not the architecture. It is the correction list:
`kxm auth token` manages a **local session token**, not `KXM_AUTH_TOKEN`; Studio is a
**separate server** today; `kxm dash` is a **terminal UI** that rejects `--json`; the hub store
is **v3** while the Runtime event store is **v5**; and the Studio mutation fallback answers
`ok: true, mappedToCli: true` **without executing anything**. Four of those five were my
assumptions in the brief below. The plan's MVP gate exists because of the last one.

## The brief it was given

```markdown
# Planning brief — hub + Studio auth for per-tenant hosting (Authentik at the edge)

You are the architect here, not a code critic. Produce a design I can hand to a writer.
Read the repository first — every "current state" claim below is mine and must be checked;
correct me where I am wrong, citing file:line.

Repository: KXM (`/Users/eddieflores/source/clients/kxm`), branch `fix/intake-review-round2`.
Read-only: do not edit files, do not run the suite.

## The requirement, as the operator stated it

- KXM will be **hosted per tenant**. Each tenant gets **its own hub process and its own
  `.kxm/state/kxm.db`**. The portal (`kontextmind/kxmd-portal`) is the multi-tenant,
  multi-user surface; the hub is not.
- Therefore the hub itself **does not need a user system**. It needs *admin* access for the
  operator, and it must be usable from a browser (Studio, the live `kxm dash` screens) behind
  **Authentik**, which is an OIDC identity provider that will sit in front as the
  authentication proxy.
- This must be **optional**: an unconfigured local hub behaves exactly as today.
- Setup must be possible **from the CLI**, including non-interactively, for both hub and
  Studio.
- **Deployment, settled by the operator:** the hub and the portal live **together on that
  tenant's own VM**. So the portal reaches the hub over loopback, the hub never needs a public
  listener, and Authentik terminates the browser session at the reverse proxy on (or in front
  of) that VM. Per-tenant VM **is** the tenancy boundary — the hub holds one tenant's state,
  one `.kxm/state/kxm.db`, one admin.
- **Capacity framing:** the tenant VM is already provisioned for the portal, so the hub must
  **not** be counted as another VM in the plan. It is an **incremental** cost, and the only
  incremental costs that matter are **disk** and **bandwidth**. Treat any design that implies
  a new always-on service, container, or VM as out of scope.
- **Hosting is OPTIONAL and additive. This is the constraint I most want designed well.** The
  existing static-token model (`KXM_AUTH_TOKEN` admin bearer + `KXM_PROJECT_TOKENS`, plus the
  generated-and-persisted token in the hub env record) is the **default and must keep working
  unmodified** for anyone who does not deploy the kxmd VM. Concretely: `kxm hub start` with no
  hosting config must behave byte-for-byte as it does today — same env precedence, same
  loopback no-auth convenience, same `kxm hub bind` flow, same `kxm auth token` verbs, same
  Studio session-token input. Nothing may *require* Authentik, a proxy, a header, a browser
  login, or a new config file. If hosting config is present but wrong or half-configured, the
  hub must fail closed **with the fix named** — and it must never silently downgrade a hosted
  hub to token-only, nor silently upgrade a local hub to proxy-trusting. Design the mode
  detection as an explicit, inspectable state (one command must answer "which mode am I in and
  why"), not as an inference from which env vars happen to be set.
- **Do not over-architect.** Spend the design effort on **UI/UX and CLI support** — the
  states a human sees, the commands they type, the errors that tell them what to do — plus the
  footprint budget in section 8.

## What I believe exists today (verify all of it)

- `plugins/kxm/src/hub-env.ts`: `resolveHubCredentials()` — precedence env `KXM_AUTH_TOKEN`
  → persisted record → **freshly generated and persisted**; `projectTokens` from
  `KXM_PROJECT_TOKENS` (env or file); `resolveClientHubAuthToken(env, project)` for
  one-shot clients; a `HubEnvError` on a malformed record.
- `plugins/kxm/src/hub.ts`: `expectedProjectToken(project)` = `projectTokens[project] ||
  authToken`; `requireProjectAuth` (401 `invalid_auth`, `nextAction: check_project_token`);
  `requireAdminAuth` — **loopback with no configured token returns** (no auth);
  `requireConfiguredAdminAuth` (503 `admin_auth_not_configured`) for control-plane
  operations; `requireAgent` (`x-kxm-agent-id` + `x-kxm-agent-key`, 401
  `invalid_agent_identity`); `contextCallerProject` (agent-scoped or admin-scoped, 403
  `context_isolation_violation`); constant-time compare in `safeTokenEqual`.
- `plugins/kxm/src/hub.ts:470` — "KXM_AUTH_TOKEN is required when binding beyond localhost".
- `plugins/kxm/src/cli/hub.ts:438` — `cmdAuthToken({status|clear|issue})`, surfaced as
  `kxm auth token …` and near `kxm session …`.
- `plugins/kxm/src/cli.ts` — `kxm hub start|view|stop|bind|unbind`, `kxm studio
  serve --port 4242 --host --token <session token>`.
- `plugins/kxm/src/studio-layout.ts` — the browser reads a `sessionTokenInput` field and
  sends `Authorization: Bearer <token>` itself (around line 835–850).
- `plugins/kxm/src/redact.ts` already redacts `KXM_AUTH_TOKEN=…` in logs.
- `plugins/kxm/src/server.ts` reads `KXM_HOST`, `KXM_PORT`, `KXM_AUTH_TOKEN`,
  `KXM_PROJECT_TOKENS`, state/data paths, rate-limit knobs.

## What I want from you

### 1. The architecture, decided — with one cut recommendation

Choose and defend **one** primary model, and show the alternative you rejected in at most a
short paragraph. The candidates, as I see them:

- **A. IdP at the edge, hub stays a bearer-token resource server.** Authentik (or its proxy
  — outpost/forward-auth) terminates the browser session and gates the route. The hub keeps
  its existing token model for *machine* clients and optionally **trusts an upstream
  identity assertion** (e.g. `X-Authentik-Username` plus a shared secret header) so audit
  lines and Studio chrome can say *who* did it without the hub owning users, sessions, or a
  cookie jar. Hub binds loopback/unix-socket only; nothing about its auth model changes when
  the proxy is absent.
- **B. Hub as OIDC relying party.** The hub implements the auth code flow with Authentik,
  issues its own session cookie for Studio, and keeps bearer tokens for agents/CLI. Real
  login/logout/refresh/expiry states live inside the hub.
- **C. Something smaller I have not thought of.**

Bias hard toward the option that (i) adds no user table, no session store, and no cookie
crypto to a codebase whose event-store schema is already at v5 with a v6 slice pending,
(ii) cannot be bypassed by forgetting to configure it, and (iii) leaves `kxm hub start` on a
laptop identical to today. If you recommend B, you must justify the session store and say
what breaks without it; if you recommend A, say exactly what the hub still validates itself
and where the fail-closed boundary is when someone puts the hub on a public interface with no
proxy in front.

### 1b. The two modes, spelled out

Name them, and state for each: what authenticates a browser, what authenticates a CLI or agent,
where the secret lives, what `kxm hub view`/`kxm dash`/`kxm session brief` report, and what
`kxm doctor` refuses. Then answer these directly:

- **Local/token mode (today).** What stays literally untouched? Which of your new commands are
  usable here (`status`, `rotate`, `issue` viewer token?) and which must refuse with a message
  that says hosting config is absent — without implying anything is broken?
- **Hosted mode (opt-in).** What becomes required, and at what moment does the hub decide it is
  in this mode: config file present, a specific env var, an explicit `kxm hub auth setup`, or a
  flag at start? Pick one, justify it, and specify what happens to a hub that was in local mode,
  gets `setup` run, and then has its proxy removed.
- **The transition.** One operator runs `setup`, restarts, and their existing agents, `kxm
  session brief`, MCP server, Pi extension and CI steps must keep working. Enumerate each client
  and say whether it needs a change, and if so what the migration command is. A silent breakage
  here is the worst outcome available.
- **Rollback.** How do you get back to token-only in one command, and what residue must be
  cleaned (persisted config, cookies the browser still holds, proxy secrets, issued viewer
  tokens) for the hub to be honestly back in local mode?

### 2. Threat model, four bullets maximum

What A/B actually protect against in a **per-tenant hosted** deployment, and the one thing
they do **not** protect against. Include: header forgery if the secret is missing or the port
is exposed; token-in-URL leakage through logs and `Referer`; cross-tenant exposure if a portal
misroutes to the wrong hub; and the loopback no-auth default in `requireAdminAuth` becoming
reachable through a proxy that rewrites `Host`/`X-Forwarded-For`.

### 3. Configuration surface, and where it lives

Per-tenant hub config today is env + a persisted hub record + `.kxm/` files. Say precisely:
- what the new config is called, where it lives, what is allowed in Git and what is never
  written to Git (this repo has a hard rule that tokens must not be copied into Git — see
  `docs/contracts/migration.md:21`);
- how a **generated** secret is surfaced once and then never logged, and how rotation and
  revocation work with zero-downtime for already-running agents;
- how `kxm hub bind <url>` and the client-side credential resolution change, if at all;
- what happens on `kxm hub start` when config exists but the proxy is not there, and the
  reverse. Both directions must fail closed with a message that says what to run.

### 4. CLI grammar — this is where I want real effort

Give the full command surface with flags, defaults, exit codes, `--json` shapes, and the
exact copy for each failure. Cover at minimum:

- setup for a hosted hub (one command, idempotent, non-interactive-capable, and an
  interactive path that never puts a secret in argv or shell history — note this repo's
  `--token-stdin`-style conventions if they exist, otherwise specify one),
- status: "is auth on, is the proxy asserted identity arriving, which tenant am I, what is
  reachable from where",
- rotate / revoke,
- viewer vs admin credential issuing for portal embedding,
- Studio: a browser session that a human can obtain **without pasting a token into a DOM
  field**, including the SSH/headless case where `localhost:4242` is not reachable,
- doctor checks and what `kxm hub view` and `kxm dash` add.

Rules: every command `--json`-able; secrets never echoed twice; every refusal names the
command that fixes it; no new noun where an existing verb fits (`kxm auth token` already
exists — say whether these hang off `kxm auth`, `kxm hub`, or a new `kxm hub auth`).
Give a `--help` transcript for the new group, in this repo's voice.

### 5. UI/UX states — also real effort, and the part I will get wrong if you do not

For Studio and the live dash screens, enumerate the states a human can be in and what each
one shows: signed-out, just-authenticated, proxied-with-identity, proxied-anonymously,
read-only-viewer, session-expired-mid-mutation, wrong-tenant-hub, hub-unreachable,
auth-disabled-but-loopback, and "configured but the proxy secret does not match". For each:
the visible copy, whether an action is offered, and what the CLI says when the same condition
is hit in a terminal. Call out: where the tenant name appears so an operator never wonders
which hub they are mutating; how a mutation is blocked-but-explained for a viewer instead of
failing with a raw 403; and how the UI avoids putting the bearer in `localStorage` if it
currently does.

### 6. Slices

Split into independently shippable slices, smallest first, each with: files touched, the
deterministic gate that proves it (`npm run verify`, plus any new named test), and whether it
touches the event-store schema (**aim for zero schema change**; if a slice needs one, say
why and put it in the pending v6 slice instead of inventing a v7 here). Mark which slices are
hub-only, CLI-only, UI-only.

### 8. Footprint budget, because that is the actual cost question

Give numbers with the measurement that produces them, not vibes:

- **Disk:** the hub's own state on that VM — `kxm.db` plus WAL, the JSONL hub log, retained
  messages, artifacts and improvements, and what a `VACUUM INTO` backup adds at peak. Name
  which existing knobs bound each one (`KXM_MESSAGE_TTL_MS`, `KXM_MESSAGE_RETENTION_MS`,
  `KXM_DATA_PATH`, `KXM_STATE_DIR`, `KXM_LOG_PATH`, the rate-limit knobs), what their
  defaults imply after 30 days of a busy tenant, and what a hosted deployment should set.
  Include the growth driver this repo actually has: event-sourced runs and intake rows
  accumulate, and `intake_messages.content` stores plaintext unless classified.
- **Bandwidth:** Studio and `kxm dash` polling versus streaming, the peer-traffic path between
  the portal and the hub on the same box (loopback, so cost is syscalls, not egress), what
  leaves the VM at all, and a cheap ceiling per tenant that does not require a new
  rate-limit engine.
- **Process/RAM:** what one hub process costs, and confirmation that a per-tenant hub does not
  add a second service on the VM beyond what already runs there.
- Then: a **one-command measurement** an operator can run on a live tenant VM to report actual
  bytes and requests, so the next capacity plan is measured rather than argued. Design its
  output shape (`--json`) and where its numbers are wrong or misleading.

### 7. Explicit non-goals

Name what you are cutting and why — user accounts in the hub, per-user RBAC, tenant table,
SCIM, hub-side token introspection endpoint, multi-process hub, session store, cookie
framework, OIDC provider inside the hub, per-tenant rate-limit engine. If you keep any of
these, defend it in one sentence.

## Output

Markdown, no preamble, sections in numeric order (1, 1b, 2, … 8). Bias every choice toward
the token-only path staying exactly as it is today; if a design only works by making hosting
config mandatory, it is the wrong design. Where you disagree with my "current
state", quote the file:line that says so. Where a decision depends on a fact you could not
read, say what you checked and what you assumed. Prefer boring and reversible; I would rather
have a smaller surface that cannot be misconfigured than a complete design.

```

## The design it produced

## 1. Architecture: choose A, with a separate browser boundary

**Keep the existing machine-token API. Add an explicitly enabled, proxy-authenticated browser surface inside the existing hub process.** Authentik owns login and browser sessions. KXM owns tenant matching, validation of the proxy credential, browser read/write permissions, and existing command authorization.

Use the tenant’s existing reverse proxy and Authentik deployment. Add no outpost, container, Studio daemon, or VM as part of this feature. Authentik’s single-application forward-auth mode supports this arrangement and application-specific authorization. [Authentik proxy documentation](https://docs.goauthentik.io/add-secure-apps/providers/proxy/)

```text
Browser
  → existing HTTPS reverse proxy + Authentik authentication
  → 127.0.0.1:7331/kxm/…          hosted browser routes

Portal backend / CLI / agents
  → 127.0.0.1:7331/v1/…          existing machine routes and credentials

Same tenant VM; same hub; same hub database.
```

### Verified baseline and corrections

References describe the working tree on `fix/intake-review-round2`, including its existing staged changes. No files were edited and no suite was run.

| Brief claim | Verified finding |
|---|---|
| Hub credential precedence and persistence | Correct: environment → persisted record → generated admin token; project tokens use environment or record. Malformed records throw. See [hub-env.ts:140](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub-env.ts:140). **The launcher also independently implements this resolution**, so changing only that TypeScript function would miss `kxm hub start`: [kxm-hub.mjs:122](/Users/eddieflores/source/clients/kxm/scripts/kxm-hub.mjs:122). |
| One-shot client resolution | Correct, with a qualification: explicit `KXM_AUTH_TOKEN` → persisted project token → persisted admin token. This function does **not** read `KXM_PROJECT_TOKENS` directly: [hub-env.ts:203](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub-env.ts:203). |
| Hub auth guards | The stated project, admin, configured-admin, agent, and context-isolation guards are present: [hub.ts:495](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:495). `safeTokenEqual` delegates to the timing-safe helper: [hub.ts:126](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:126). |
| Non-loopback requires a token | Correct: [hub.ts:468](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:468). The no-auth admin shortcut depends on the **configured listening host**, not request `Host`, source address, or forwarded headers: [hub.ts:533](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:533). |
| Fresh local start can mean no auth | The lower-level server supports that convenience, but ordinary `kxm hub start` normally generates and persists an admin token first: [kxm-hub.mjs:129](/Users/eddieflores/source/clients/kxm/scripts/kxm-hub.mjs:129). Preserve both behaviors. |
| `kxm auth token` manages hub bearer credentials | **Correction:** it manages a separate **local session token**, including `KXM_SESSION_TOKEN`; it does not rotate `KXM_AUTH_TOKEN`. See [cli/hub.ts:438](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/hub.ts:438). Existing flags are `--status`, `--clear`, `--issue`, rather than positional verbs: [cli.ts:439](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli.ts:439). |
| Studio behavior | Correct about the DOM input and bearer header: [studio-layout.ts:835](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/studio-layout.ts:835). **Studio is a separate server today.** `--host` takes a value. Token precedence is flag → session-token environment → session-token disk file: [cli/tasks.ts:281](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/tasks.ts:281). No `localStorage` or `sessionStorage` use was found in this implementation. |
| Studio already executes audited mutations | **Correction:** the CLI supplies no `onMutation` callback, while the server’s fallback returns `ok: true` and `mappedToCli: true` without execution. See [cli/tasks.ts:302](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/tasks.ts:302) and [studio-layout.ts:410](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/studio-layout.ts:410). Hosted Studio must not inherit that success path. |
| Live dash is a browser surface | **Correction:** `kxm dash` is a terminal UI. It uses SSE and snapshots, and currently rejects `--json`: [cli/hub.ts:112](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/hub.ts:112). Browser equivalents would be new views. |
| Redaction and server configuration | Correct for `KXM_AUTH_TOKEN=…`: [redact.ts:13](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/redact.ts:13). Server environment inputs match the brief: [server.ts:13](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/server.ts:13). |
| Hub database is v5 with v6 pending | **Correction:** the hub store is v3: [store.ts:13](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/store.ts:13). The **Runtime event store** is v5: [runtime-store.ts:553](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:553), with v6 follow-ups in [implementation-plan.md:1403](/Users/eddieflores/source/clients/kxm/plans/implementation-plan.md:1403). |

I found no general `kxm doctor` command or `--token-stdin` convention in the KXM CLI sources searched. Both below are explicitly proposed additions.

### The cut

Reserve `/kxm/` for hosted browser routes:

- `/kxm/studio/`: Studio.
- `/kxm/dash/`: browser versions of the existing operator read models.
- `/kxm/api/…`: a closed set of browser operations.
- No generic “forward this URL” or “execute this CLI string” endpoint.

Mount these handlers on the hub’s existing listener. Extract reusable Studio rendering without changing standalone local Studio behavior.

Every browser data request must validate:

1. Hosted mode is active and its configuration is valid.
2. The actual listening address and connection peer are loopback. Use numeric `127.0.0.1` or `::1`; do not trust forwarded addresses.
3. A tenant-specific random proxy credential is present, valid, unexpired, and unrevoked.
4. The asserted tenant matches the configured tenant.
5. Authentik supplies a nonempty stable subject and display username. Admin requests must match the configured single admin subject.
6. The credential permits the requested operation: `viewer` or `admin`.
7. Mutations pass same-origin checks and the existing command/policy/evidence checks.

Use `X-KXM-Proxy-Credential` for the credential and `X-KXM-Tenant-ID` for tenancy. Use Authentik’s `X-Authentik-Uid` and `X-Authentik-Username` for attribution. These are upstream assertions, not independently verified OIDC tokens. Authentik documents both identity headers. [Authentik headers](https://docs.goauthentik.io/add-secure-apps/providers/proxy/)

The proxy must **remove client-supplied identity, tenant, credential, agent, caller, and Authorization headers**, then supply validated values after successful authentication. It must never inject the legacy hub admin token.

A browser credential authenticates only `/kxm/`; it grants no agent identity and cannot satisfy `/v1/` authentication. Invalid browser assertions never fall back to machine bearer authentication.

**Reject B.** Implementing an OIDC callback, refresh lifecycle, cookie protection, and session revocation duplicates the existing edge session owner. It adds no necessary capability for this deployment.

## 1b. The two modes

Name the modes **`local-token`** and **`hosted-proxy`**. Treat invalid configuration as an error state, never a third operating mode.

| Property | `local-token` | `hosted-proxy` |
|---|---|---|
| Browser authentication | Existing standalone Studio session-token behavior, including today’s optional-token behavior | Authentik session at the edge; hub independently validates every browser assertion |
| CLI/agent authentication | Existing admin/project bearer and agent identity checks | Exactly those same credentials and checks over loopback |
| Secrets | Existing environment, hub-env record, and separate session-token file | Existing secrets plus dedicated proxy/browser credentials |
| Tenant identity | No hosted tenant configured | Required immutable tenant ID, display name, canonical HTTPS URL |
| Browser route availability | `/kxm/` is unavailable | `/kxm/` requires the complete hosted assertion |
| `hub view`, dash, session brief | Existing default output preserved; explicit auth inspection reports local mode | Add tenant, mode, browser readiness, and last valid assertion time |
| Doctor | Does not demand hosting configuration | Refuses a hosted-ready result for invalid config, public listener, incorrect tenant, absent identity, bad credential, or unverified edge |

### Local behavior stays untouched

Preserve the existing:

- Environment precedence, token generation, persisted record format and contents.
- Loopback no-auth shortcut and configured-admin requirements.
- `hub start`, `bind`, `unbind`, client resolution, and machine routes.
- `auth token` and `session token` behavior without new flags.
- Standalone Studio token input and token precedence.
- Terminal dash transport and local snapshot behavior.

New `auth status`, `doctor`, and footprint inspection work locally. Proxy rotation and scoped browser-token issuance refuse with:

> Hosting config is absent; local-token mode is working normally. To enable browser access through Authentik, run `kxm auth setup --mode hosted-proxy`.

The existing unscoped `kxm auth token --issue` remains usable.

### Explicit activation

**`kxm auth setup --mode hosted-proxy` is the activation operation.** It writes a versioned record containing an explicit `mode` value. No environment variable or incoming header activates hosting.

The record is loaded before listening by all launch paths: wrapper, direct server, and extension autostart. Its path is fixed relative to the existing user-state root.

Resolution is inspectable:

```text
No record                    → local-token; reason=config_absent
Record says local-token      → local-token; reason=explicit_rollback
Valid hosted-proxy record    → hosted-proxy; reason=explicit_setup
Unreadable/malformed record  → refuse startup; reason=config_invalid
```

Running setup against a live local hub stages the next-start configuration. It reports:

> Hosted configuration saved. Running hub is still local-token. Run `kxm hub stop`, then `kxm hub start`.

The supported proxy configuration targets only the new `/kxm/` routes, so an old or unconfigured hub cannot accidentally serve the browser application.

Removing the proxy after activation leaves the hub in hosted mode. Browser access fails; machine clients continue. Restarting never converts it to token-only.

**Necessary limit:** an unchanged local hub cannot detect an arbitrary proxy that forwards requests indistinguishably from a local client. It is impossible to preserve that behavior byte-for-byte while also detecting every unannounced proxy. The enforceable guarantee is that the **supported hosted routes never fall back**, and hosted mode never permits a public listener. Doctor must not claim that an unseen firewall or proxy is safe.

### Client transition

| Client | Migration |
|---|---|
| Existing agents/workers | None. Preserve tokens, project names, agent IDs and reconnect behavior. Setup never rotates their credentials. |
| One-shot CLI | None. Existing resolver and loopback binding remain. |
| `kxm session brief` | None for access. It reads local hub snapshots and probes health, rather than obtaining its work through a browser session: [session-work.ts:438](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/session-work.ts:438). Add hosted status separately from cached work data. |
| MCP server | None. Its existing resolver remains: [mcp-server.ts:84](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/mcp-server.ts:84). |
| Pi extension | None. It currently uses environment → autostart token → persisted admin token, not the one-shot project-token resolver: [extension.ts:707](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/extension.ts:707). Preserve that distinction. |
| CI running on the VM | None. Keep existing machine credentials and URL. |
| CI/agents outside the VM | No automatic migration. If they currently use a public hub listener, setup must flag that deployment conflict. Use an existing SSH tunnel, then `kxm hub bind http://127.0.0.1:<forwarded-port>`; credentials stay unchanged. |
| Portal backend | Keep its existing machine integration if present. New embedded browser access uses the scoped credentials below. Never deliver the hub admin bearer to JavaScript. |
| Human browser | `kxm studio open`; authenticate at the canonical HTTPS URL. No token paste. |

The ordinary hub restart still interrupts connections briefly. This design promises credential continuity, not zero interruption during restart.

### Rollback

```bash
kxm auth setup --mode local-token --apply --non-interactive --json
```

For a managed hub, this performs one controlled stop/start and:

- Replaces hosted configuration with a minimal explicit-local record.
- Deletes all hosted credential hashes and managed secret-export files.
- Removes managed proxy include content; reports whether the existing proxy reload succeeded.
- Makes all `/kxm/` routes unavailable.
- Preserves legacy hub and session credentials.

It must refuse `--apply` for an unmanaged process rather than kill an arbitrary PID.

Authentik cookies cannot be deleted by a terminal command on the VM. They are harmless to the local hub because it consumes no cookies and exposes no hosted routes. Report `externalSessionCleanup: pending`; link the operator to the provider’s sign-out URL. Logout belongs to Authentik. [Authentik logout](https://docs.goauthentik.io/add-secure-apps/providers/proxy/)

Externally copied proxy secrets cannot be recalled from disk, but rollback invalidates them all. Report those copies as external cleanup, never claim their deletion.

## 2. Threat model

- **Forged headers and exposed ports:** identity headers alone prove nothing. Hosted routes require the independent proxy credential, tenant match, validated subject, and loopback transport; hosted startup refuses public binds even with `KXM_AUTH_TOKEN`. Compromise of the VM, proxy, or its credential remains outside this boundary.
- **URL leakage:** never place bearer credentials in query strings, fragments, redirects, iframe URLs, or SSE URLs. Use same-origin edge sessions; redact headers and set `Referrer-Policy: no-referrer`. URL cleanup after navigation cannot undo proxy-log leakage.
- **Wrong-tenant routing:** each VM has a distinct browser credential and pinned tenant ID. A misrouted assertion fails before returning tenant data. The portal must derive expected tenant from its authenticated routing context, not from whatever hub answers; copying both another tenant’s credential and identity remains a portal/VM compromise.
- **Loopback proxy bypass:** today’s admin shortcut trusts the configured loopback listener, regardless of rewritten `Host` or `X-Forwarded-For`. Hosted browser routes never invoke that shortcut. The proxy exposes only `/kxm/`, never a catch-all to legacy `/v1/`, `/metrics`, `/health`, or standalone Studio.

## 3. Configuration and secret lifecycle

### Files

Use **`hub-auth.json`**, schema `kxm.hub-auth.v1`, beside the existing `hub-env.json`.

On Linux the default directory is `$XDG_STATE_HOME/kxm` or `~/.local/state/kxm`; existing `KXM_STATE_HOME` overrides it. These paths follow [hub-env.ts:23](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub-env.ts:23).

Example shape; placeholders below are not credentials:

```json
{
  "schema": "kxm.hub-auth.v1",
  "mode": "hosted-proxy",
  "revision": 1,
  "tenant": {"id": "tenant_123", "name": "Acme"},
  "publicUrl": "https://acme.example/kxm/",
  "adminSubject": "authentik-stable-uid",
  "upstream": "http://127.0.0.1:7331",
  "credentials": [
    {
      "id": "cred_123",
      "role": "admin",
      "audience": "kxm-browser",
      "sha256": "<digest>",
      "expiresAt": null,
      "revokedAt": null
    }
  ]
}
```

Keep both mode and credential metadata in one atomically replaced record. Reject unknown schema versions, incomplete hosted records, unsafe permissions, duplicate credential IDs, and invalid origins. Bound the credential list to 16 live/overlap entries.

Files and secret output directories must be outside Git, with directory mode `0700` and file mode `0600`. Reject generated-secret destinations inside a Git worktree, including ignored files. Secret-free deployment templates and examples may be committed. This implements the existing prohibition in [migration.md:21](/Users/eddieflores/source/clients/kxm/docs/contracts/migration.md:21).

Do not put hosting configuration in project YAML: it belongs to the tenant deployment, not a cloned repository.

### Generated credentials

Generate 32 random bytes per credential. The hub stores a digest; the proxy needs the plaintext credential.

Setup writes the plaintext **once** to the requested protected output file, or once to stdout if explicitly requested. Ordinary output contains only credential ID, role, path, and next steps. Repeating setup returns metadata without reprinting or regenerating the secret.

Interactive setup defaults to a protected file. It never asks the operator to type a secret as an argument. Imported credentials use `--token-stdin`; minimum entropy/length requirements apply, and the managed default remains generation.

There is one deliberate compatibility exception: existing unscoped `auth token` can re-echo its persisted session token today, at [cli/hub.ts:512](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/hub.ts:512). Leave that untouched. “Never echoed twice” applies to the new hosted credentials.

### Rotation and revocation

- Rotation creates a new credential with the same role and tenant. Old and new work for a default **10-minute overlap**.
- Hub validation reloads the small record on change and checks expiry on every browser request.
- Update and reload the existing proxy, confirm use of the new credential ID, then revoke the old one.
- Revocation takes effect on the next request. Proposed hosted polling avoids indefinitely authorized SSE connections.
- No machine token changes; already-running agents are unaffected.
- Expired/revoked entries are pruned while retaining a bounded, secret-free log event.

Do not present this as legacy admin-token rotation. That would require a separate compatibility design because today the hub expects one admin token.

### Binding and startup

`kxm hub bind <url>` remains a URL binding, with no credential import or new precedence. Today it persists the URL and probes health: [cli/hub.ts:194](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/hub.ts:194).

| Condition | Result |
|---|---|
| Hosted config malformed or partial | No listener. Name the field and the exact setup command that repairs it. |
| Hosted config requests public bind | No listener, even with a valid machine token. |
| Hosted config valid; proxy absent | Machine listener may run on loopback. Browser readiness is false; no browser authentication fallback. Print the proxy-install/reload instructions. |
| Proxy present; hosted config absent | Supported proxy requests to `/kxm/` receive `404 hosting_not_configured`; the proxy shows an operator error page. |
| Proxy sends bad credential or no subject | Reject before data access. Never use an accompanying legacy bearer as fallback. |

**Proxy presence is not knowable from configuration alone.** Status distinguishes configuration validation, an anonymous public-route probe, and the timestamp of the last valid identity-bearing request. A historical successful request is not proof that the proxy is currently healthy.

## 4. CLI grammar and operator workflow

Use the existing **`kxm auth`** group. Keep its current token flags. Do not introduce `kxm hub auth`.

All new commands support `--json`; JSON mode never prompts.

### Proposed help transcript

```text
Usage: kxm auth [options] [command]

Manage credentials, tokens, and authorization

Commands:
  token [options]     Inspect, issue, or clear local session tokens;
                      issue scoped credentials with --scope browser
  setup [options]    Configure optional hosted browser access or return to local mode
  status [options]   Show the configured and running auth mode
  rotate [options]   Replace a hosted browser credential with an overlap period
  revoke [options]   Revoke hosted browser credentials
  help [command]     Show auth help

Options:
  --json             Print machine-readable output
  -h, --help         Show help

Local hubs need no setup. Hosted setup preserves existing machine credentials.
```

### Commands, flags, defaults

| Command | Grammar and behavior |
|---|---|
| Setup | `kxm auth setup --mode hosted-proxy --tenant <id> --name <name> --public-url <https-url>/kxm/ --admin-subject <uid> --authentik-url <https-url> [--upstream http://127.0.0.1:7331] [--proxy nginx] [--proxy-include <absolute-file>] [--secret-out <absolute-file> \| --secret-stdout \| --token-stdin] [--non-interactive] [--apply] [--json]` |
| Local rollback | `kxm auth setup --mode local-token [--apply] [--non-interactive] [--json]` |
| Status | `kxm auth status [--probe] [--timeout-ms 3000] [--json]`; read-only, no token generation. |
| Rotate | `kxm auth rotate --credential <id> [--overlap 10m] (--secret-out <file> \| --secret-stdout) [--json]`; overlap range `0s–1h`, no implicit legacy-token target. |
| Revoke | `kxm auth revoke (--credential <id> \| --all --scope browser) [--json]`; immediate and idempotent. |
| Issue browser credential | `kxm auth token --issue --scope browser --role viewer\|admin [--ttl <duration>] (--secret-out <file> \| --secret-stdout) [--json]` |
| Scoped token inventory | `kxm auth token --status --scope browser [--json]`; IDs, roles, expirations, last-use timestamps; no secrets. |
| Studio launch | `kxm studio open [--screen studio\|agents\|tasks\|workflows\|plans\|inbox\|procs\|spend] [--no-open] [--json]`; default screen `studio`. |
| Existing Studio | Preserve `studio serve --port 4242 --host 127.0.0.1 --token …`; add optional `--token-stdin`. In hosted mode, refuse standalone serving and direct to `studio open`. |
| Doctor | `kxm doctor [--hosted] [--probe] [--timeout-ms 3000] [--json]`; no repairs or automatic login. |
| Hub status | Existing `kxm hub view`; add `--auth` for explicit inspection in either mode and `--footprint --sample <duration>` for §8. |
| Dash JSON | Define `kxm dash --json` as one snapshot using the current screen/read model. Interactive terminal behavior remains unchanged. |

For issued credentials, default viewer lifetime is **1 hour**, maximum **24 hours**. Explicit admin issuance requires `--role admin`, defaults to **15 minutes**, and is capped at **1 hour**. The deployment proxy credential created by setup is separately marked as nonexpiring and operator-rotated.

Viewer/admin credentials are **server-side credentials for the proxy or portal backend**, never iframe URL tokens. Admin credentials additionally require the pinned admin subject. The portal chooses a credential only after authorizing its current user. This is two fixed capability classes, not a user-role database.

### Setup flow

Noninteractive example:

```bash
kxm auth setup \
  --mode hosted-proxy \
  --tenant tenant_123 \
  --name Acme \
  --public-url https://acme.example/kxm/ \
  --admin-subject authentik-stable-uid \
  --authentik-url https://auth.example \
  --proxy nginx \
  --proxy-include /etc/nginx/kxm/acme.conf \
  --secret-out /etc/nginx/kxm/acme.secret.conf \
  --non-interactive \
  --json
```

Setup validates paths and configuration before writing. Same inputs are a no-op; changed tenant IDs require returning to local mode first. Updates to display name or deployment URL produce a new revision.

Interactive `kxm auth setup` asks for mode, tenant identity, public URL, admin subject, and output paths. It generates the secret, displays only the destination, and prints the precise commands for the existing proxy:

```text
Hosted configuration saved for Acme (tenant_123).
Proxy credential written to /etc/nginx/kxm/acme.secret.conf.
Install the generated include in this tenant's HTTPS server block.
Run nginx -t, then nginx -s reload.
Run kxm hub stop, then kxm hub start.
Open https://acme.example/kxm/studio/ to verify browser access.
```

The nginx include is an adapter for the **existing** proxy. It must use the authenticated subrequest result, strip incoming assertion headers, deny legacy hub routes, constrain the canonical host, and return JSON 401 responses for API calls instead of an HTML login redirect. Authentik supplies the base forward-auth integration pattern. [Authentik nginx configuration](https://docs.goauthentik.io/add-secure-apps/providers/proxy/server_nginx)

I did not inspect `kontextmind/kxmd-portal` or its proxy configuration. Nginx is the concrete proposed adapter, not a verified portal dependency. If that deployment uses another proxy, implement its equivalent template before claiming hosted support; do not install nginx alongside it.

### JSON contract

New commands use:

```json
{
  "ok": false,
  "command": "auth status",
  "error": "proxy_identity_unverified",
  "message": "Hosted auth is configured, but no authenticated browser request has been observed.",
  "nextAction": {
    "command": "kxm studio open",
    "detail": "Sign in, then run kxm auth status --probe."
  }
}
```

Successful status:

```json
{
  "ok": true,
  "command": "auth status",
  "configured": {
    "mode": "hosted-proxy",
    "reason": "explicit_setup",
    "revision": 4,
    "path": "/home/kxm/.local/state/kxm/hub-auth.json"
  },
  "running": {
    "mode": "hosted-proxy",
    "revision": 4,
    "restartRequired": false
  },
  "tenant": {"id": "tenant_123", "name": "Acme"},
  "machine": {"auth": "token", "source": "file"},
  "browser": {
    "configured": true,
    "anonymousProbe": "denied",
    "identity": "observed",
    "lastValidAssertionAt": "2026-09-19T12:00:00Z",
    "lastCredentialId": "cred_123"
  },
  "reachability": {
    "listener": "127.0.0.1:7331",
    "listenerScope": "loopback",
    "publicUrl": "https://acme.example/kxm/",
    "externalFirewall": "unknown"
  }
}
```

Setup, rotate, issue, and revoke return configuration revision, credential ID/role/expiry, `changed`, `restartRequired`, `secretDelivery`, and ordered `nextActions`. Only explicit `--secret-stdout` includes `secret`, once. Repeated setup never includes it.

`studio open --json` returns the canonical URL and `opened: false`. Doctor returns a `checks` array with `pass|fail|unknown`, evidence, and a repair command for each failure.

### Exit codes and exact failures

Preserve exit codes of existing invocations. New commands use:

- `0`: completed successfully; ordinary local mode is healthy.
- `1`: operational failure, failed verification, or unavailable hub.
- `2`: invalid arguments, incompatible mode, unsafe configuration, or missing required input.

| Condition | Code | Exact operator copy |
|---|---:|---|
| Hosting-only operation locally | 2 | “Hosting config is absent; local-token mode is working normally. Run `kxm auth setup --mode hosted-proxy` to use this command.” |
| Missing noninteractive inputs | 2 | “Hosted setup needs: `<missing flags>`. Run `kxm auth setup --help`, or rerun without `--non-interactive` in a terminal.” |
| Invalid record | 2 | “Hosted auth config is invalid at `<path>`: `<field reason>`. Run `kxm auth setup --mode hosted-proxy` with the required fields, or `kxm auth setup --mode local-token --apply` to roll back.” |
| Public bind | 2 | “Hosted auth requires a numeric loopback listener; configured host is `<host>`. Set `KXM_HOST=127.0.0.1`, then run `kxm hub start`.” |
| Proxy credential mismatch | 1 | “Proxy credential rejected. Run `kxm auth status`; install the current credential in the proxy, or run `kxm auth rotate --credential <id> --secret-out <file>`.” |
| Missing identity | 1 | “Proxy authentication supplied no identity. Restore the Authentik identity headers in the generated include, run `nginx -t`, then `nginx -s reload`.” |
| Wrong tenant | 1 | “Tenant mismatch. No tenant data was returned. Run `kxm auth status` and correct the portal route before retrying.” |
| No public-route response | 1 | “Hosted browser route is unreachable. Run `nginx -t`, then `nginx -s reload`; verify with `kxm doctor --hosted --probe`.” |
| Unknown credential ID | 2 | “Credential `<id>` was not found. Run `kxm auth token --status --scope browser`.” |
| Secret output exists | 2 | “Secret output `<path>` already exists and will not be overwritten. Choose a new `--secret-out` path.” |
| Secret output inside Git | 2 | “Secret output must be outside a Git worktree. Rerun with `--secret-out <absolute-private-path>`.” |
| Legacy token rotation requested | 2 | “This command rotates hosted browser credentials. Run `kxm auth token --status` to inspect the existing local session token.” |
| Hosted standalone Studio | 2 | “Hosted Studio runs inside the hub. Run `kxm studio open`; no separate Studio server is needed.” |
| Unmanaged process with `--apply` | 2 | “The running hub is not managed by this CLI. Stop it with its existing supervisor, then run `kxm hub start`.” |
| Hub unreachable | 1 | “Hub is unreachable at `<url>`. Run `kxm hub view`; start the tenant hub with `kxm hub start` if it is stopped.” |

HTTP codes are separate: 401 for missing/expired authentication, 403 for viewer mutation or disallowed subject, 409 for tenant mismatch, 503 for unusable hosted configuration, and 404 for unavailable hosted routes.

### SSH and headless use

On the VM:

```bash
kxm studio open --no-open
```

It prints the canonical HTTPS URL. Open that URL on the laptop and authenticate normally. The browser never needs to reach the VM’s `localhost:4242`.

Do not print a tokenized “magic link.” If the canonical public route is unavailable, fix it or use the existing local Studio workflow over an explicitly configured SSH tunnel; that does not constitute verified hosted access.

## 5. UI/UX states

Hosted Studio and browser dash share a shell. Every page, dialog, mutation review, and error banner shows:

> **Acme · tenant_123** Admin / Viewer Connected to `acme.example`

Fetch this identity from the validated browser bootstrap endpoint. Compare it with the portal’s independently expected tenant before displaying data or enabling actions. Escape identity strings as text.

| State | Visible copy and action | Terminal equivalent |
|---|---|---|
| Signed out | “Sign in to open Acme’s KXM workspace.” **Sign in** navigates to the protected canonical route. No tenant data renders. | `studio open` prints URL; CLI does not initiate a token exchange. |
| Just authenticated | “Signed in. Checking tenant and access…” Keep mutations disabled until bootstrap succeeds. | `auth status`: identity `unverified` until the request arrives. |
| Proxied with identity | “Signed in as Eddie · Admin.” Show tenant continuously. **Sign out** uses Authentik’s configured endpoint. | “hosted-proxy · Acme · identity observed `<time>`.” |
| Proxied anonymously | “Sign-in could not be verified. The proxy supplied no identity.” **Retry** and expandable operator instructions. No anonymous viewer fallback. | Missing-identity error from §4. |
| Read-only viewer | Persistent **Viewer — read only** badge. Disabled mutation controls explain: “This view cannot change Acme’s hub. Open the admin workspace to make changes.” | Browser credential receives `viewer_read_only`; machine CLI credentials retain their own permissions. |
| Session expired during mutation | “Your sign-in expired. Sign in again, then review this change.” Preserve the draft in memory. **Sign in**; never auto-resubmit. | Machine CLI is unaffected by browser expiry. If the edge rejected before dispatch, report `notApplied`; transport loss reports outcome unknown. |
| Wrong tenant | Full-page “Tenant mismatch. No data loaded and no changes sent.” Show expected tenant; reveal actual identity only after valid credential verification. **Return to portal**. | Tenant-mismatch error. |
| Hub unreachable | “Acme’s hub is unavailable. Last updated `<time>`.” Mark existing data stale; disable mutations. **Retry**. | Hub-unreachable error. |
| Auth disabled on loopback | Existing local Studio token field remains. Explicit status says “Local hub — loopback callers are trusted.” Do not show a hosted login button. | `auth status`: `local-token`, `machine.auth: none`, listener scope. |
| Proxy secret mismatch | “KXM could not verify this proxy. Ask the operator to check its credential.” No login loop. **Retry** and operator command. | Proxy-credential error. |

If a request loses its response after dispatch, say:

> The hub may have applied this change. Check its status before retrying.

Only safe, existing idempotent command contracts may support a deliberate retry. An auth feature must not invent mutation idempotency.

Hosted browser code holds **no bearer token**: none in a DOM field, local storage, session storage, URL, or generated HTML. The browser sends the edge-owned cookie; the proxy adds its credential upstream. Use same-origin JSON mutations, verify `Origin` against the configured HTTPS origin, require a non-simple application header, and omit wildcard CORS. Existing standalone Studio currently permits wildcard CORS at [studio-layout.ts:314](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/studio-layout.ts:314); do not reuse that policy for hosted requests.

`hub view` adds separate **machine ready** and **browser verified/unverified** indicators in hosted mode. Terminal dash adds tenant and auth status to its existing connection line. Session brief refreshes these indicators independently of cached task summaries.

Initial hosted Studio should expose only actually backed operations. Unsupported controls say:

> This action is not connected to a command handler in this build.

They must never display “Mutation applied” from today’s placeholder response.

## 6. Independently shippable slices

These are a proposed handoff order, not a second execution tracker. The writer records accepted work in Tracking and the affected Phase 10 note, following [implementation-plan.md:1755](/Users/eddieflores/source/clients/kxm/plans/implementation-plan.md:1755). Explicitly document that this per-tenant deployment does not implement Phase 11 multi-user RBAC.

Every slice runs the existing **`npm run verify`** gate. New tests below belong to the existing suite, not new npm gates.

| Slice | Scope and files | Named deterministic proof | Event-store schema |
|---|---|---|---|
| 1. Mode inspection | **CLI/config only.** New `hub-auth.ts`; `cli.ts`, new `cli/auth.ts`; docs. No activation yet. | `hub-auth-mode.test.ts`: absent, explicit local, malformed, unknown version; inspect never generates credentials. | None |
| 2. Hosted request boundary and setup | **Hub + CLI.** `hub.ts`, `server.ts`, `hub-autostart.ts`, `scripts/kxm-hub.mjs`, auth module, redaction, proxy template. `/kxm/` initially provides bootstrap/status only. | `hub-hosted-auth.test.ts`: public-bind refusal, forged headers, secret mismatch, wrong tenant, missing subject, no bearer fallback. `hub-local-auth-compat.test.ts`: unchanged local outputs, credential precedence and file bytes across launch paths. | None |
| 3. Credential lifecycle and rollback | **Hub + CLI.** Auth module and CLI, managed proxy output. | `hub-browser-credentials.test.ts`: one-time output, idempotent setup, overlap, expiry, revocation, rollback, interruption-safe file replacement; machine clients retain access. | None |
| 4. Hosted Studio and browser dash | **Hub + UI.** Extract Studio handler from `studio-layout.ts`; mount in `hub.ts`; shared read-model adapter; `cli/tasks.ts` for `studio open`. Start read-only. | `studio-hosted.test.ts`: one hub listener, no second server, no bearer in HTML/storage/URLs, tenant bootstrap, all listed failure states, bounded snapshots. | None |
| 5. Real admin actions | **Hub command adapter + UI.** Closed typed mapping to existing command services; shared principal/audit context. Add only operations with complete current contracts. | `studio-command-parity.test.ts`: viewer rejected before side effect, admin subject checked, actual command receipt required, no placeholder success, expired edge response never replayed. | None |
| 6. Status, doctor, measurement | **CLI + UI + small hub counters.** `cli/hub.ts`, `session-work.ts`, `tui.ts`, `hub.ts`; new footprint reader and doctor CLI. | `hub-footprint.test.ts`: distinct files counted once, unavailable numbers stay unknown, request reset detection. `hosted-client-continuity.test.ts`: CLI/MCP/Pi resolver behavior and hosted status without credential migration. | None |

Proxy-template acceptance also needs a bounded integration fixture proving unauthorized public requests cannot reach the hub application, and authenticated requests carry the required assertions. A unit test of header parsing alone is insufficient.

All slices have **zero event-store schema change**. Durable per-user audit history or new Runtime principal fields, if later required, belong in the already pending v6 discussion—not a new v7 auth migration. This cut records the validated subject, tenant, credential ID, command, result, and request ID in the existing structured logging path; it does not claim tamper-proof audit retention.

## 7. Explicit non-goals

Cut:

- Hub user accounts, user administration, tenant tables, and per-user RBAC: tenancy is the VM; admin is one pinned subject; viewer/admin are fixed credential capabilities.
- SCIM and account provisioning: portal/Authentik responsibility.
- Hub OIDC login callbacks, provider implementation, refresh tokens, token introspection, session store, cookie framework, and cookie cryptography: Authentik owns browser sessions.
- Public hub listeners and Unix-socket support in this slice: numeric loopback already satisfies deployment.
- A separate hosted Studio service, authentication sidecar, new outpost, container, or VM.
- A general reverse proxy, arbitrary CLI execution endpoint, and full web parity for unfinished command adapters.
- A new per-tenant rate-limit engine: use the existing proxy’s controls and current hub limiter.
- Automatic Runtime history deletion or artifact pruning: evidence retention needs its own policy.
- Rotating legacy machine credentials through the new browser-credential commands.
- A multi-process hub or HA design. Existing launcher/runtime processes are accounted for rather than redesigned.

## 8. Footprint budget and measurement

**Incremental VM count: zero. Incremental always-on service count for this auth/Studio design: zero.** Disk and external bandwidth are the cost dimensions. Process measurements are feasibility checks on the already provisioned VM.

No live tenant workload or memory sample was available, so the numbers below are explicit workload calculations and proposed acceptance budgets—not observed KXM benchmarks.

### Disk: what is bounded today

| Component | Existing control and verified behavior | Hosted setting / implication |
|---|---|---|
| Hub DB | `KXM_DATA_PATH`; default `.kxm/state/kxm.db`. `KXM_STATE_DIR` changes its default directory, not its size. [server.ts:20](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/server.ts:20) | Pin absolute paths under the tenant’s existing data allocation. Path knobs impose no byte quota. |
| Pending peer messages | Default TTL **24 hours**; requests may choose up to **7 days**. [protocol.ts:6](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/protocol.ts:6) | Keep `KXM_MESSAGE_TTL_MS=86400000` initially. Lowering it changes work-delivery semantics and needs workload evidence. |
| Terminal peer messages | Default retention **7 days**; purge uses terminal timestamps. [store.ts:438](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/store.ts:438) | Set `KXM_MESSAGE_RETENTION_MS=604800000` explicitly. This is not a hard maximum message lifetime or DB size. |
| Legacy hub runs/journal | Completed/failed runs have a **hardcoded seven-day** retention default; related journal entries are removed. [store.ts:483](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/store.ts:483) | No server environment knob for this retention was found. Active runs and live context can keep growing. |
| Runtime events and intake | Separate per-project stores, outside the hub v3 DB. Event insertions and intake records accumulate. [runtime-store.ts:1026](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:1026) | Include only Runtime stores actually colocated on this VM. Peer-message retention does not prune them. |
| Intake plaintext | **There is no `intake_messages.content` SQL column.** Content is inside the JSON `record`. Only classification `secret` omits it; `sensitive` still persists plaintext. Default is `project`, and classification is caller-supplied. [runtime-store.ts:761](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:761), [intake.ts:273](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/intake.ts:273) | Count these bytes and protect backups accordingly. Intake input is capped at **16 KiB**: [intake.ts:28](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/intake.ts:28). No 30-day retention guarantee. |
| WAL and shared memory | Database helper enables WAL. [database.ts:114](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:114) | Measure `-wal`/`-shm`; no existing hard WAL byte ceiling was found. Long readers can prevent reclamation. |
| Hub JSONL log | Default **10 MiB per file**, three rotated files plus active file: approximately **40 MiB**, allowing an oversized-entry overshoot. [logger.ts:14](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/logger.ts:14), [logger.ts:44](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/logger.ts:44) | Keep defaults. `KXM_LOG_PATH` sets location, not retention. Count supervisor stdout logs separately; the logger can also emit stdout. |
| Artifacts, retrospectives, improvements | Asset path controls location; terminal retrospectives export files, and improvement reports use timestamped filenames. [hub.ts:457](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:457), [improve.ts:339](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/improve.ts:339) | No general size/retention bound found. Preserve evidence; alert on growth rather than silently delete. |
| Backup | Checkpoint attempt, integrity check, then `VACUUM INTO` a separate file. [database.ts:478](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:478) | Reserve space for the new compact copies while originals, WAL, earlier backups, and ongoing writes remain. SQLite backup does not include artifact directories automatically. |

Deleting rows generally makes SQLite pages reusable; it does not promise that the main DB file shrinks.

### A reproducible 30-day busy-tenant example

Assume the following workload, then replace each assumption with measured values:

| Driver | Calculation | Payload bytes |
|---|---|---:|
| Peer messages | 10,000/day × 8-day resident window × 4 KiB combined request/reply payload | **312.5 MiB** |
| Runtime events | 1,000 runs/day × 50 events/run × 30 days × 2 KiB/event | **2.86 GiB** |
| Intake | 10,000/day × 30 days × 4 KiB/content | **1.14 GiB** |
| Artifacts/retrospectives | 1,000/day × 30 days × 16 KiB | **468.75 MiB** |
| Improvements | 100/day × 30 days × 8 KiB | **23.44 MiB** |

The eight-day message example assumes default one-day expiry followed by seven-day retention. It is not an upper bound: longer request TTLs, metadata, indexes, active work, and SQLite allocation increase it.

Combined example SQLite payload is about **4.31 GiB**. If a measured pilot shows physical DB bytes are twice those payload bytes, the planning estimate becomes:

- DB files: **8.62 GiB**.
- Artifacts and improvements: **0.48 GiB**.
- Rotating hub log: approximately **0.04 GiB**.
- Illustrative WAL reserve: **0.25 GiB**, explicitly not a bound.
- One additional compact backup assumed as large as those DB files: **8.62 GiB**.
- Estimated peak: approximately **18.0 GiB**, before other logs, earlier backups, and temporary workspace files.

**Proposed initial allocation: 24 GiB incremental disk, alert at 12 GiB steady usage, and require free space for a measured backup plus write-growth margin.** This is a pilot budget, not a claim that defaults cap usage at 24 GiB. Event/intake history and artifacts continue growing after day 30.

The measurement that replaces the assumed factor of two is physical database allocation divided by sampled logical row bytes, reported separately for the hub and each Runtime store.

### Bandwidth

Current behavior differs materially:

- Standalone Studio fetches layout every **3 seconds**: [studio-layout.ts:874](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/studio-layout.ts:874).
- Terminal dash uses SSE, with **15-second heartbeat** frames: [hub.ts:1419](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:1419).
- Each ops event can trigger a fresh snapshot cycle, including health, readiness, and metadata requests: [tui.ts:820](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/tui.ts:820), [tui.ts:1129](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/tui.ts:1129). “SSE” does not mean constant low bandwidth.

At **20 KiB per layout response**, a continuously open three-second polling tab transfers:

```text
30 × 86,400 ÷ 3 × 20 KiB = 16.48 GiB/month
```

For the first hosted cut, choose **one consolidated poll every 15 seconds while visible**, pause hidden tabs, and back off on errors. Keep terminal dash unchanged. At the same response size:

```text
30 × 86,400 ÷ 15 × 20 KiB = 3.30 GiB/month per visible tab
```

Use paginated metadata responses capped at **64 KiB**. Do not embed message bodies, artifacts, or unrestricted logs in the poll.

A cheap initial public-browser ceiling:

- Existing proxy limit: **12 application API requests/minute per tenant**, shared across users, with burst 4.
- Two visible tabs consume eight polls/minute, leaving room for mutations.
- Maximum 64 KiB response bodies yields approximately **31.64 GiB/month application-response egress** at sustained saturation.
- Budget **40 GiB/month browser egress** for this initial metadata-only surface, allowing static assets and protocol overhead.
- Exclude Authentik callbacks from that application limiter. Serve versioned assets with caching; no uncapped artifact downloads in this cut.

The **40 GiB is an operating budget, not an exact billing cap**. Retries, headers, TLS, downloads added later, and other portal routes must be measured separately.

Portal-to-hub peer traffic on the same VM is loopback traffic, not external egress. Browser responses, remote-agent traffic, external webhooks, off-VM backups, and any remote Authentik checks cross the VM boundary. Model-provider calls belong to their actual worker/runtime component and should not be silently attributed to hub HTTP traffic.

Keep the existing hub defaults explicit:

```text
KXM_RATE_LIMIT_MAX=600
KXM_RATE_LIMIT_WINDOW_MS=60000
```

These are per agent-header/address bucket, not a tenant-wide byte limit; bucket selection precedes authentication. [hub.ts:572](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:572) They cannot substantiate a global bandwidth ceiling. The existing proxy’s fixed tenant bucket supplies the public-browser ceiling.

### Process and RAM

There is one hub server process, but **the normal launcher is also a resident wrapper process**: [kxm-hub.mjs:247](/Users/eddieflores/source/clients/kxm/scripts/kxm-hub.mjs:247). Count both PIDs when measuring the managed hub.

The store loads agents, workflow runs, journal, and context records into memory: [store.ts:614](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/store.ts:614). Therefore a constant “RAM per hub” number cannot be established from source.

Proposed feasibility budgets:

- Managed wrapper + server: **≤256 MiB RSS at the agreed pilot workload**, measured over a busy hour.
- Added hosted auth/Studio code: **≤16 MiB RSS delta** against the same workload with browser access disabled.
- If those budgets fail, investigate before increasing the tenant’s provisioned resources.

These are acceptance targets, not measured consumption or additional VM cost. Hosted Studio adds no PID, listener, or persistent service beyond the existing hub.

### One-command live measurement

Propose:

```bash
kxm hub view --footprint --sample 60s --json
```

It should perform read-only file accounting and sample existing-process counters. It must not vacuum, checkpoint, create a backup, scan message contents into output, or start another service.

Example output shape, with deliberately unmeasured values:

```json
{
  "ok": true,
  "command": "hub view",
  "footprint": {
    "schema": "kxm.hub-footprint.v1",
    "tenantId": "tenant_123",
    "sampleSeconds": 60,
    "disk": {
      "hub": {
        "databaseBytes": null,
        "allocatedBytes": null,
        "walBytes": null,
        "shmBytes": null,
        "freelistBytes": null
      },
      "runtimeStores": [],
      "logsBytes": null,
      "artifactsBytes": null,
      "improvementsBytes": null,
      "existingBackupsBytes": null,
      "uniqueAllocatedBytes": null,
      "filesystemFreeBytes": null,
      "additionalBackupBytesEstimate": null
    },
    "http": {
      "counterEpoch": null,
      "requestsDuringSample": null,
      "requestsPerSecond": null,
      "requestBodyBytes": null,
      "responseBodyBytes": null,
      "browserResponseBodyBytes": null,
      "machineResponseBodyBytes": null,
      "activeStreams": null,
      "proxyWireEgressBytes": null,
      "billableEgressBytes": null
    },
    "process": {
      "pids": [],
      "rssBytes": null,
      "sampleMaxRssBytes": null
    },
    "coverage": {
      "complete": false,
      "missing": ["live measurement not performed"]
    }
  }
}
```

Implementation details that keep the numbers honest:

- Count distinct files/inodes once; report apparent size and allocated blocks separately.
- Include configured paths outside `.kxm/`; list inaccessible or undiscovered paths.
- Discover colocated Runtime stores separately from the hub DB.
- Add inexpensive in-memory byte counters at HTTP writes, including streaming writes. Current `kxm_requests_total` counts requests but is not a wire-byte metric: [hub.ts:1059](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:1059).
- Report counter resets using process-start identity. Do not extrapolate across a restart.
- Treat hub byte counts as application bytes before edge compression/TLS. Proxy and provider billing remain `unknown` unless their existing counters/logs are available.
- Backup-size estimates are estimates: free pages, checkpoint contention, concurrent writes, and multiple retained backups alter peak space.
- A 60-second sample captures current rate, not daily peaks or thirty-day history. Show any extrapolation as conditional on that rate continuing.
- Default measurement must not enumerate or emit plaintext intake/message content. Optional logical-byte accounting should return counts and lengths only.

This command makes the next allocation decision depend on actual resident bytes, backup headroom, and external response volume while leaving the local token path intact.
