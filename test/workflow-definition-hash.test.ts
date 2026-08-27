import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  workflowDefinitionHash,
  type WebhookWorkflowDefinition,
} from "../plugins/kxm-mesh/src/workflow.ts";
import { createTestMesh, responseJson } from "./helpers.ts";

test("webhook run creation stamps the canonical definition hash and keeps it durable", async (context) => {
  const secret = "definition-hash-secret-value";
  const definition: WebhookWorkflowDefinition = {
    id: "hash-stamped",
    source: "generic",
    project: "test-project",
    target: "coordinator",
    secret,
    delivery: "followUp",
    promptTemplate: "Handle {{task}}",
    stages: [
      { id: "work", label: "Work", instructions: "Do the work", requiredEvidence: ["report"], maxAttempts: 2 },
    ],
  };
  const mesh = await createTestMesh(context, { webhookWorkflows: [definition] });
  const coordinator = mesh.makeClient("coordinator");
  await coordinator.start(async (event) => {
    if (event.type === "message") await coordinator.acknowledge(event.message.id);
  });

  const payload = JSON.stringify({ task: "stamp the hash" });
  const post = (deliveryId: string) => fetch(`${mesh.address.url}/v1/webhooks/hash-stamped`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": deliveryId,
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });

  const expected = workflowDefinitionHash(definition);
  assert.match(expected, /^[a-f0-9]{64}$/);

  const accepted = await post("hash-delivery-1");
  assert.equal(accepted.status, 202);
  const acceptedBody = await responseJson(accepted) as unknown as {
    run: { id: string; definitionHash?: string };
  };
  assert.equal(acceptedBody.run.definitionHash, expected);

  // Duplicate retry returns the same stamped run.
  const duplicate = await post("hash-delivery-1");
  assert.equal(duplicate.status, 200);
  const duplicateBody = await responseJson(duplicate) as unknown as {
    duplicate: boolean;
    run: { definitionHash?: string };
  };
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.run.definitionHash, expected);

  // The hash survives the store round trip (read path).
  const fetched = await coordinator.getWorkflow(acceptedBody.run.id);
  assert.equal(fetched.run.definitionHash, expected);
});
