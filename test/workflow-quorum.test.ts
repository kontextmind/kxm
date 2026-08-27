import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalWorkflowDefinitionJson,
  parseWorkflowDefinitions,
  workflowDefinitionHash,
} from "../plugins/kxm-mesh/src/workflow.ts";

function definitionWithPolicy(policy: Record<string, unknown>, target = "grok"): string {
  return JSON.stringify([{
    id: "quorum-test",
    source: "generic",
    project: "payk12",
    target,
    secret: "a-long-webhook-secret",
    promptTemplate: "Review {{task.summary}}",
    stages: [{
      id: "review",
      label: "Review",
      instructions: "Critics review.",
      requiredEvidence: ["independent critic reviews"],
      evidencePolicies: { "independent critic reviews": policy },
      maxAttempts: 3,
    }],
  }]);
}

test("parse rejects the workflow target inside eligibleAgents", () => {
  assert.throws(
    () => parseWorkflowDefinitions(definitionWithPolicy({
      kind: "peer-reply",
      minProducers: 3,
      eligibleAgents: ["fable", "gpt-sol", "kimi", "grok"],
    })),
    /must not include the workflow target grok/,
  );
  // Case-insensitive: a differently cased target is still the target.
  assert.throws(
    () => parseWorkflowDefinitions(definitionWithPolicy({
      kind: "peer-reply",
      minProducers: 1,
      eligibleAgents: ["GROK", "fable"],
    })),
    /must not include the workflow target/,
  );
});

test("parse rejects minProducers beyond the eligible pool", () => {
  assert.throws(
    () => parseWorkflowDefinitions(definitionWithPolicy({
      kind: "peer-reply",
      minProducers: 4,
      eligibleAgents: ["fable", "gpt-sol", "kimi"],
    })),
    /minProducers exceeds eligibleAgents/,
  );
});

test("degradation floor below 2 parses but emits a warning", () => {
  const warnings: string[] = [];
  const [definition] = parseWorkflowDefinitions(
    definitionWithPolicy({
      kind: "peer-reply",
      minProducers: 3,
      eligibleAgents: ["fable", "gpt-sol", "kimi"],
      degradation: { minProducers: 1 },
    }),
    process.env,
    (message) => warnings.push(message),
  );
  assert.equal(definition!.stages[0]!.evidencePolicies!["independent critic reviews"]!.degradation!.minProducers, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /degradation\.minProducers is 1 \(< 2\)/);
  assert.match(warnings[0]!, /quorum-test/);
});

test("degradation floor of 2 or more emits no warning; no callback still parses", () => {
  const warnings: string[] = [];
  parseWorkflowDefinitions(
    definitionWithPolicy({
      kind: "peer-reply",
      minProducers: 3,
      eligibleAgents: ["fable", "gpt-sol", "kimi"],
      degradation: { minProducers: 2 },
    }),
    process.env,
    (message) => warnings.push(message),
  );
  assert.equal(warnings.length, 0);

  // Callers that pass no callback keep working; the warning is dropped.
  const [silent] = parseWorkflowDefinitions(definitionWithPolicy({
    kind: "peer-reply",
    minProducers: 2,
    eligibleAgents: ["fable", "kimi"],
    degradation: { minProducers: 1 },
  }));
  assert.equal(silent!.stages[0]!.evidencePolicies!["independent critic reviews"]!.minProducers, 2);
});

test("workflowDefinitionHash is semantic: stable across key order, sensitive to content", () => {
  const first = parseWorkflowDefinitions(definitionWithPolicy({
    kind: "peer-reply",
    minProducers: 3,
    eligibleAgents: ["fable", "gpt-sol", "kimi"],
  }))[0]!;

  // Same definition, keys written in a different order in the source JSON.
  const reordered = JSON.stringify([{
    stages: [{
      evidencePolicies: { "independent critic reviews": {
        eligibleAgents: ["fable", "gpt-sol", "kimi"],
        minProducers: 3,
        kind: "peer-reply",
      } },
      maxAttempts: 3,
      requiredEvidence: ["independent critic reviews"],
      instructions: "Critics review.",
      label: "Review",
      id: "review",
    }],
    promptTemplate: "Review {{task.summary}}",
    secret: "a-long-webhook-secret",
    target: "grok",
    project: "payk12",
    source: "generic",
    id: "quorum-test",
  }]);
  const second = parseWorkflowDefinitions(reordered)[0]!;

  const hash = workflowDefinitionHash(first);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(workflowDefinitionHash(second), hash);

  const rotated = {
    ...first,
    secret: "rotated-webhook-secret-value",
    signalSecret: "rotated-signal-secret-value",
  };
  assert.equal(workflowDefinitionHash(rotated), hash, "credential rotation must not create definition drift");
  const canonical = canonicalWorkflowDefinitionJson(rotated);
  assert.doesNotMatch(canonical, /rotated-webhook-secret-value|rotated-signal-secret-value/);
  assert.doesNotMatch(canonical, /"secret"|"signalSecret"/);

  const changed = parseWorkflowDefinitions(definitionWithPolicy({
    kind: "peer-reply",
    minProducers: 2,
    eligibleAgents: ["fable", "gpt-sol", "kimi"],
  }))[0]!;
  assert.notEqual(workflowDefinitionHash(changed), hash);
});
