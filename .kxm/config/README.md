# Workspace configuration

Store reviewable, repository-specific harness and workflow configuration here. `env.example` documents supported environment settings, and `workflows/` contains the complete Jira development example.

Configuration files may reference secret environment-variable names such as `JIRA_WEBHOOK_SECRET`; they must never contain the secret values. Set `PI_MESH_WEBHOOK_WORKFLOWS_FILE` to the chosen workflow file.
