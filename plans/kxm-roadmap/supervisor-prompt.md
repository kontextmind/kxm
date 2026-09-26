# Roadmap supervisor prompt

The prompt the five-minute supervisor schedule runs. The schedule lives in
the chat session that created it, so a tick that finds it missing, expired,
or about to expire recreates it in that same session with the same cadence
(`*/5 * * * *`) and the prompt below. The loop continues under the same task
and the same chat; it never starts a second session. Edit this file to
change what the supervisor does; the next recreation picks it up.

Recreate by hand with: `CronCreate` cron `*/5 * * * *`, recurring, prompt =
the block below. Session-only jobs auto-expire after seven days, so a
long-lived session recreates the job about once a week.

```text
Supervise roadmap progress. Follow docs/contributing/operating-rules.md and docs/contributing/learnings.md (checked-in copies of the operator's standing instructions) plus the memories pr-landing-autonomy, no-just-prefer-kxm-cli, pipeline-docs-then-merge, monitor-progress-events, keep-kxm-plugin-updated. Each tick: (0) Keep this schedule alive in this same chat session: run CronList; if no recurring job carries this prompt, or the one that does expires within 24 hours, recreate it here with CronCreate from plans/kxm-roadmap/supervisor-prompt.md (cron */5 * * * *, recurring) and delete the expiring one; never hand the loop to a new session. (1) check every lane worktree under ../kxm-* for a finished writer (result envelope in .kxm/logs/impl-*.json), a green or failed verify (.kxm/logs/verify-critic.log), and an open PR; act on any "Review needed" item: review, dispatch a repair brief, rebase, run kxm land, or follow the release. (2) After any PUBLISHED release line, run in the main checkout: kxm update --kxm, then kxm update --extensions, then kxm plugin install --all; then tell the user once to run /reload-plugins. (3) Keep at most two npm run verify processes running at once; do not start a third. (4) After any merge to main, regenerate the roadmap and docs (node plans/kxm-roadmap/update-dashboard.mjs once the docs-site branch has landed, otherwise note it as pending) and update plans/backlog-shortcuts.md for any shortcut taken; append a dated lesson to docs/contributing/learnings.md when a tick teaches something durable. (5) Every sixth tick (about 30 minutes), run the improvement loop: kxm improve report --json and kxm routing report --json in the main checkout, and note whether the roadmap deep review (/reanalyze-roadmap) is due because a phase flipped to done or a milestone landed. (6) Append one line per tick to /Users/eddieflores/source/clients/kxm/.kxm/logs/supervisor.log in the form "[supervisor]: <what changed or 'no change'>. <No action|Acted: ...>. - (<HH:MM>)". Report to the user only when something changed or an action was taken; otherwise mark the tick as no change.
```
