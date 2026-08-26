import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";
import { parseWorkflowDefinitions } from "../plugins/pi-mesh-comms/src/workflow.ts";

const execFileAsync = promisify(execFile);

test("self-contained roundtrip example executes successfully", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    "examples/roundtrip.ts",
  ], { cwd: process.cwd(), timeout: 5_000 });
  const output = JSON.parse(stdout) as { peers: string[]; status: string; reply: string };
  assert.deepEqual(output.peers.sort(), ["example-planner", "example-reviewer"]);
  assert.equal(output.status, "replied");
  assert.equal(output.reply, "Reviewed: Check the rollout plan");
  assert.equal(stderr, "");
});

test("Jira development workflow example is valid and covers the complete lifecycle", () => {
  const raw = readFileSync(".kxm/config/workflows/jira-development.json", "utf8");
  const [workflow] = parseWorkflowDefinitions(raw, {
    JIRA_WEBHOOK_SECRET: "example-test-secret-value",
    WORKFLOW_SIGNAL_SECRET: "example-signal-secret-value",
  });
  assert.equal(workflow!.source, "jira");
  assert.equal(workflow!.signalSecret, "example-signal-secret-value");
  assert.deepEqual(workflow!.stages.map((stage) => stage.id), [
    "intake",
    "reproduce",
    "plan-moa",
    "plan-review",
    "implementation",
    "local-gates",
    "repository-gates",
    "documentation",
    "push-watch",
    "merge",
    "jira-update",
    "retrospective",
  ]);
  assert.equal(workflow!.stages.find((stage) => stage.id === "local-gates")?.area, "gates");
});
