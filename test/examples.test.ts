import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseWorkflowDefinitions } from "../plugins/kxm/src/workflow.ts";

const execFileAsync = promisify(execFile);

test("self-contained roundtrip example executes successfully", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    "examples/roundtrip.ts",
  ], { cwd: process.cwd(), timeout: 20_000 });
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

test("repository provenance quorum workflow parses with its declared peer policies", () => {
  const raw = readFileSync(".kxm/config/workflows/provenance-quorum.json", "utf8");
  const [workflow] = parseWorkflowDefinitions(raw, {
    KXM_V04_WORKFLOW_SECRET: "repository-provenance-start-secret",
    KXM_V04_SIGNAL_SECRET: "repository-provenance-signal-secret",
  });
  assert.equal(workflow!.id, "kxm-provenance");
  assert.equal(workflow!.target, "provenance-coordinator");
  assert.equal(workflow!.stages.find((stage) => stage.id === "plan")!
    .evidencePolicies?.["independent plan message ids"]?.minProducers, 2);
  assert.deepEqual(workflow!.stages.find((stage) => stage.id === "plan")!
    .evidencePolicies?.["independent plan message ids"]?.eligibleAgents, ["provenance-grok", "provenance-gemini"]);
});

test("provenance example and command-first guide share one runnable topology", () => {
  const raw = readFileSync("examples/provenance-workflow.json", "utf8");
  const [workflow] = parseWorkflowDefinitions(raw, {
    KXM_WORKFLOW_SECRET: "example-provenance-secret-value",
  });
  assert.equal(workflow!.id, "provenance-review");
  assert.equal(workflow!.project, "provenance-demo");
  assert.equal(workflow!.target, "coordinator");

  const policy = workflow!.stages[0]!.evidencePolicies?.["independent peer reviews"];
  assert.equal(policy?.kind, "peer-reply");
  assert.equal(policy?.minProducers, 2);
  assert.deepEqual(policy?.eligibleAgents, ["reviewer-claude", "reviewer-grok"]);
  assert.equal(policy?.degradation?.minProducers, 1);

  const guide = readFileSync("docs/provenance-gates.md", "utf8");
  assert.match(guide, /\{"provenance-demo":"replace-with-the-project-token"\}/);
  assert.match(guide, /--name coordinator --project provenance-demo/);
  assert.match(guide, /--name reviewer-claude --project provenance-demo/);
  assert.match(guide, /--name reviewer-grok --project provenance-demo/);

  const launcher = readFileSync(join(process.cwd(), ".kxm", "assets", "run-provenance-workflow.ps1"), "utf8");
  assert.match(launcher, /\$projectName = "provenance-demo"/);
  assert.match(launcher, /Name = "coordinator"/);
  assert.match(launcher, /Name = "reviewer-claude"/);
  assert.match(launcher, /Name = "reviewer-grok"/);
  assert.doesNotMatch(launcher, /Name = "reviewer-gemini"/);
});
