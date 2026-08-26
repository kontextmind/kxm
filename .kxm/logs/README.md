# Workspace logs

The hub writes structured JSON Lines to `pi-mesh-hub.jsonl`. Long-lived workers write structured lifecycle events to `pi-mesh-worker-<agent>.jsonl` and captured Pi process output to `pi-agent-<agent>.log`.

Runtime log files are ignored by Git. Protect them as potentially sensitive operational data even though hub structured logs omit prompt and reply bodies. Use an external collector and retention policy for unattended deployments.
