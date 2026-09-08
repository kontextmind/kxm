import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface WorkflowStep {
  id: string;
  on?: Record<string, string | { target?: string }>;
}

function targetsOf(step: WorkflowStep): string[] {
  const targets: string[] = [];
  for (const value of Object.values(step.on ?? {})) {
    if (typeof value === "string") targets.push(value);
    else if (value && typeof value.target === "string") targets.push(value.target);
  }
  return targets;
}

test("default.yaml declared graph routes ready only through verify", () => {
  const workflow = parse(readFileSync(join(repoRoot, "examples/vnext/.kxm/workflows/default.yaml"), "utf8")) as {
    steps: WorkflowStep[];
  };
  const steps = workflow.steps;
  assert.equal(steps[0]?.id, "plan");
  const verify = steps.find((step) => step.id === "verify");
  const ready = steps.find((step) => step.id === "ready");
  assert(verify, "default.yaml must declare verify");
  assert(ready, "default.yaml must declare ready");
  assert(targetsOf(verify).includes("ready"), "verify must have an edge into ready");
  const incoming = steps.filter((step) => targetsOf(step).includes("ready")).map((step) => step.id);
  assert.deepEqual(incoming, ["verify"]);
  assert(!incoming.includes("plan"));
  assert(!incoming.includes("implement"));
});
