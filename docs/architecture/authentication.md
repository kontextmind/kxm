# Authentication

Read from `plugins/kxm/src/harness.ts` and `plugins/kxm/src/cli.ts`.

`kxm harness list` runs `probeHarnesses` (`cmdHarnessList` in
`plugins/kxm/src/cli/project.ts`). For each detected harness that has
`authArgs`, `probeEntry` runs that command and `interpretAuth` reads the
output. KXM does not store provider credentials. The probe only classifies
the harness command's own stdout.

| Harness | Probe command | Logged-in signal in this file |
| --- | --- | --- |
| Pi | no `authArgs` on the catalog entry | `authenticated` stays null with `auth_context_required`. A separate assignment probe can run `pi auth check`. |
| Claude | `auth status` | JSON `loggedIn: true`, method `claude.ai` or `api-key` |
| Codex | `login status` | `Logged in using ChatGPT` or `Logged in using an API key` |
| Grok | `models` | exact line `You are logged in with grok.com.` |
| Kimi | `provider list` | a line containing `managed:kimi`, `type=kimi`, or `Default model:` |
| agy | `models` | a model row matched by `AGY_MODEL_ROW`, method `antigravity-oauth` |
| omp | `models --json` | success, and a non-empty `models` array when JSON parses |
| deepseek | no `authArgs` | `authenticated` stays null with `auth_unknown` |

`kxm auth` in `plugins/kxm/src/cli.ts` is `kxm auth token`. It inspects,
issues, or clears the local session token file. That token is a KXM session
token, not a provider key. Provider logins stay in each harness.

## Related

- [Access](access.md)
- [Harness routing](../reference/harness-routing.md)
