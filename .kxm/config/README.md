# Workspace configuration

Store reviewable, repository-specific harness and workflow configuration here. `env.example` documents supported environment settings. `workflows/` contains the complete Jira development lifecycle, the v0.4 dogfood workflow, and the provenance/quorum workflow used by parser and evidence-policy tests.

Configuration files may reference secret environment-variable names such as `JIRA_WEBHOOK_SECRET`; they must never contain the secret values. Set `KXM_WEBHOOK_WORKFLOWS_FILE` to the chosen workflow file.
