import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { request as httpRequest, type ClientRequest } from "node:http";
import test, { type TestContext } from "node:test";
import type { MeshClient } from "../plugins/pi-mesh-comms/src/client.ts";
import { MeshHttpError } from "../plugins/pi-mesh-comms/src/client.ts";
import type { MeshHubOptions } from "../plugins/pi-mesh-comms/src/hub.ts";
import type { MessageRecord, WorkflowMessageContext } from "../plugins/pi-mesh-comms/src/protocol.ts";
import {
  checkpointRun,
  parseWorkflowDefinitions,
  verifyWorkflowEvidenceReferences,
  type WebhookWorkflowDefinition,
  type WorkflowRun,
  type WorkflowStageState,
  type WorkflowVerifiedEvidence,
} from "../plugins/pi-mesh-comms/src/workflow.ts";
import { createTestMesh, responseJson, waitFor, type TestMesh } from "./helpers.ts";

const START_SECRET = "provenance-start-secret-with-entropy";
const SIGNAL_SECRET = "provenance-signal-secret-with-entropy";

interface PendingJsonPost {
  request: ClientRequest;
  response: Promise<{ status: number; body: Record<string, unknown> }>;
}

function beginJsonPost(
  url: string,
  token: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): PendingJsonPost {
  let request!: ClientRequest;
  const response = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    request = httpRequest(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        ...extraHeaders,
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: incoming.statusCode ?? 0,
          body: text ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    request.on("error", reject);
  });
  request.flushHeaders();
  return { request, response };
}

function expectMeshError(code: string, statusCode?: number): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MeshHttpError);
    assert.equal(error.code, code);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    return true;
  };
}

function resolvedPeerStage(overrides: Partial<WorkflowStageState> = {}): WorkflowStageState {
  return {
    id: "review",
    label: "Peer review",
    instructions: "Obtain independent peer review",
    requiredEvidence: ["peer review", "local report"],
    maxAttempts: 3,
    status: "in_progress",
    attempts: 0,
    evidence: {},
    resolvedEvidencePolicies: {
      "peer review": {
        kind: "peer-reply",
        minProducers: 2,
        eligibleProducers: [
          { id: "peer-a-id", name: "peer-a" },
          { id: "peer-b-id", name: "peer-b" },
        ],
        acceptedStatuses: ["replied"],
      },
    },
    ...overrides,
  };
}

function provenanceRun(stage = resolvedPeerStage()): WorkflowRun {
  return {
    id: "run-provenance",
    definitionId: "provenance",
    source: "generic",
    deliveryId: "delivery-provenance",
    payloadHash: "payload-hash",
    project: "test-project",
    targetAgentId: "coordinator-id",
    targetAgentName: "coordinator",
    messageId: "workflow-prompt",
    status: "running",
    currentStage: stage.id,
    stages: [stage],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function workflowContext(overrides: Partial<WorkflowMessageContext> = {}): WorkflowMessageContext {
  return {
    schema: "pi-mesh.workflow-message-context.v1",
    runId: "run-provenance",
    stageId: "review",
    requirementKey: "peer review",
    attempt: 1,
    ...overrides,
  };
}

function repliedPeerMessage(
  id: string,
  peerId: string,
  peerName: string,
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    id,
    project: "test-project",
    from: "coordinator-id",
    fromName: "coordinator",
    to: peerId,
    toName: peerName,
    content: `Review request for ${peerName}`,
    delivery: "followUp",
    hops: 0,
    maxHops: 5,
    correlationId: "run-provenance",
    workflowContext: workflowContext(),
    createdAt: "2026-01-01T00:01:00.000Z",
    deliveredAt: "2026-01-01T00:01:01.000Z",
    expiresAt: "2026-01-02T00:01:00.000Z",
    status: "replied",
    reply: { content: `Review response from ${peerName}`, createdAt: "2026-01-01T00:01:02.000Z" },
    repliedAt: "2026-01-01T00:01:03.000Z",
    ...overrides,
  };
}

function verify(
  run: WorkflowRun,
  messages: MessageRecord[],
  messageIds = messages.map((message) => message.id),
): WorkflowVerifiedEvidence {
  const stage = run.stages[0]!;
  const byId = new Map(messages.map((message) => [message.id, message]));
  return verifyWorkflowEvidenceReferences(
    run,
    stage,
    { "peer review": { messageIds } },
    { getMessage: (messageId) => byId.get(messageId) },
    "2026-01-01T00:02:00.000Z",
  );
}

function peerPolicy(
  minProducers: number,
  eligibleAgents: string[],
): NonNullable<WebhookWorkflowDefinition["stages"][number]["evidencePolicies"]>[string] {
  return {
    kind: "peer-reply",
    minProducers,
    eligibleAgents,
    acceptedStatuses: ["replied"],
  };
}

function workflowDefinition(options: {
  id?: string;
  requiredEvidence?: string[];
  evidencePolicies?: NonNullable<WebhookWorkflowDefinition["stages"][number]["evidencePolicies"]>;
  signalSecret?: string;
} = {}): WebhookWorkflowDefinition {
  return {
    id: options.id ?? "provenance",
    source: "generic",
    project: "test-project",
    target: "coordinator",
    secret: START_SECRET,
    ...(options.signalSecret ? { signalSecret: options.signalSecret } : {}),
    delivery: "followUp",
    promptTemplate: "Review {{task}}",
    stages: [{
      id: "review",
      label: "Peer review",
      instructions: "Obtain independent peer review",
      requiredEvidence: options.requiredEvidence ?? ["peer review", "local report"],
      maxAttempts: 3,
      ...(options.evidencePolicies ? { evidencePolicies: options.evidencePolicies } : {
        evidencePolicies: { "peer review": peerPolicy(2, ["peer-a", "peer-b"]) },
      }),
    }],
  };
}

interface ProvenanceMesh {
  mesh: TestMesh;
  coordinator: MeshClient;
  peerA: MeshClient;
  peerB: MeshClient;
  outsider: MeshClient;
  run: WorkflowRun;
}

async function startProvenanceMesh(
  context: TestContext,
  definition = workflowDefinition(),
  meshOptions: MeshHubOptions & { clientToken?: string } = {},
): Promise<ProvenanceMesh> {
  const { clientToken, ...hubOptions } = meshOptions;
  const mesh = await createTestMesh(context, { ...hubOptions, webhookWorkflows: [definition] });
  const clientOptions = clientToken === undefined ? undefined : { token: clientToken };
  const coordinator = mesh.makeClient("coordinator", clientOptions);
  const peerA = mesh.makeClient("peer-a", clientOptions);
  const peerB = mesh.makeClient("peer-b", clientOptions);
  const outsider = mesh.makeClient("outsider", clientOptions);
  await Promise.all([
    coordinator.start(() => undefined),
    peerA.start(() => undefined),
    peerB.start(() => undefined),
    outsider.start(() => undefined),
  ]);
  const payload = JSON.stringify({ task: "provenance" });
  const response = await fetch(`${mesh.address.url}/v1/webhooks/${definition.id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": `${definition.id}-delivery`,
      "x-hub-signature": `sha256=${createHmac("sha256", definition.secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  assert.equal(response.status, 202, JSON.stringify(await responseJson(response.clone())));
  const accepted = await response.json() as { run: WorkflowRun };
  return { mesh, coordinator, peerA, peerB, outsider, run: accepted.run };
}

async function obtainPeerReply(
  coordinator: MeshClient,
  peer: MeshClient,
  runId: string,
  requirementKey = "peer review",
  attempt = 1,
): Promise<MessageRecord> {
  const message = await coordinator.send({
    target: peer.agent!.name,
    content: `Review ${requirementKey}`,
    workflowContext: { runId, stageId: "review", requirementKey, attempt },
  });
  await peer.acknowledge(message.id);
  return await peer.reply(message.id, `${peer.agent!.name} approves`);
}

test("workflow definitions parse bounded per-requirement peer policies without a schema-version field", () => {
  const [definition] = parseWorkflowDefinitions(JSON.stringify([{
    id: "policy",
    source: "generic",
    project: "test-project",
    target: "coordinator",
    secret: START_SECRET,
    delivery: "followUp",
    promptTemplate: "Run policy",
    stages: [{
      id: "review",
      instructions: "Review",
      requiredEvidence: [" Peer   Review ", "local report"],
      evidencePolicies: {
        "peer review": {
          kind: "peer-reply",
          minProducers: 2,
          eligibleAgents: ["peer-a", "peer-b"],
          degradation: { minProducers: 1 },
        },
      },
    }],
  }]));
  const stage = definition!.stages[0]!;
  assert.deepEqual(stage.requiredEvidence, ["peer review", "local report"]);
  assert.deepEqual(stage.evidencePolicies?.["peer review"], {
    kind: "peer-reply",
    minProducers: 2,
    eligibleAgents: ["peer-a", "peer-b"],
    acceptedStatuses: ["replied"],
    degradation: { minProducers: 1 },
  });
  assert.equal("schemaVersion" in definition!, false);

  const invalidPolicies = [
    { key: "missing requirement", policy: peerPolicy(1, ["peer-a"]), error: /must match requiredEvidence/ },
    {
      key: "peer review",
      policy: { ...peerPolicy(1, ["peer-a"]), acceptedStatuses: ["delivered"] },
      error: /acceptedStatuses must be \["replied"\]/,
    },
    {
      key: "peer review",
      policy: { ...peerPolicy(2, ["peer-a", "PEER-A"]) },
      error: /eligibleAgents must be unique/,
    },
    {
      key: "peer review",
      policy: { ...peerPolicy(2, ["peer-a"]) },
      error: /minProducers exceeds eligibleAgents/,
    },
    {
      key: "peer review",
      policy: { ...peerPolicy(2, ["peer-a", "peer-b"]), degradation: { minProducers: 0 } },
      error: /degradation.minProducers must be at least 1 and lower than minProducers/,
    },
    {
      key: "peer review",
      policy: { ...peerPolicy(2, ["peer-a", "peer-b"]), degradation: { minProducers: 2 } },
      error: /degradation.minProducers must be at least 1 and lower than minProducers/,
    },
    {
      key: "peer review",
      policy: { ...peerPolicy(1, ["peer-a"]), requiresHumanApproval: true },
      error: /contains unsupported fields: requiresHumanApproval/,
    },
    {
      key: "peer review",
      policy: {
        ...peerPolicy(2, ["peer-a", "peer-b"]),
        degradation: { minProducers: 1, requiresHumanApproval: true },
      },
      error: /degradation contains unsupported fields: requiresHumanApproval/,
    },
  ];
  for (const candidate of invalidPolicies) {
    const raw = [{
      id: "invalid",
      project: "test-project",
      target: "coordinator",
      secret: START_SECRET,
      promptTemplate: "Invalid",
      stages: [{
        id: "review",
        instructions: "Review",
        requiredEvidence: ["peer review"],
        evidencePolicies: { [candidate.key]: candidate.policy },
      }],
    }];
    assert.throws(() => parseWorkflowDefinitions(JSON.stringify(raw)), candidate.error);
  }
});

test("typed workflow definitions may omit the replied-only status default", async (context) => {
  const policy = {
    kind: "peer-reply",
    minProducers: 1,
    eligibleAgents: ["peer-a"],
  } satisfies NonNullable<WebhookWorkflowDefinition["stages"][number]["evidencePolicies"]>[string];
  const definition = workflowDefinition({
    id: "typed-status-default",
    evidencePolicies: { "peer review": policy },
  });
  const { run } = await startProvenanceMesh(context, definition);
  assert.deepEqual(run.stages[0]!.resolvedEvidencePolicies?.["peer review"]?.acceptedStatuses, ["replied"]);
});

test("verified peer snapshots are hub-derived, scoped, hashed, and counted by unique producer", () => {
  const run = provenanceRun();
  const peerA = repliedPeerMessage("message-a", "peer-a-id", "peer-a");
  const peerB = repliedPeerMessage("message-b", "peer-b-id", "peer-b");
  const verifiedEvidence = verify(run, [peerA, peerB]);
  const snapshots = verifiedEvidence["peer review"]!;
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.producerId), ["peer-a-id", "peer-b-id"]);
  assert.deepEqual(snapshots[0]!.context, workflowContext());
  assert.equal(snapshots[0]!.requestSha256, createHash("sha256").update(peerA.content).digest("hex"));
  assert.equal(snapshots[0]!.replySha256, createHash("sha256").update(peerA.reply!.content).digest("hex"));
  assert.equal("content" in snapshots[0]!, false);
  assert.equal("reply" in snapshots[0]!, false);

  const completed = checkpointRun(
    run,
    "review",
    "passed",
    "quorum complete",
    { "local report": "review.md" },
    "2026-01-01T00:03:00.000Z",
    verifiedEvidence,
  );
  assert.equal(completed.completed, true);
  assert.equal(run.status, "completed");

  const duplicateProducerRun = provenanceRun();
  const sameProducerAgain = repliedPeerMessage("message-a-2", "peer-a-id", "peer-a", {
    content: "A second request to the same peer",
    reply: { content: "A second response from the same peer", createdAt: "2026-01-01T00:01:02.000Z" },
  });
  const duplicateProducerEvidence = verify(duplicateProducerRun, [peerA, sameProducerAgain]);
  assert.throws(
    () => checkpointRun(
      duplicateProducerRun,
      "review",
      "passed",
      "two messages but one producer",
      { "local report": "review.md" },
      "2026-01-01T00:03:00.000Z",
      duplicateProducerEvidence,
    ),
    /missing required evidence: peer review/,
  );
  assert.equal(duplicateProducerRun.stages[0]!.attempts, 0);
  assert.throws(
    () => verify(duplicateProducerRun, [peerA], [peerA.id, peerA.id]),
    /duplicate message ID/,
  );
});

test("peer provenance rejects wrong project, direction, scope, attempt, recipient, and correlation", () => {
  const variants: Array<{ name: string; message: MessageRecord; error: RegExp }> = [
    {
      name: "project",
      message: repliedPeerMessage("wrong-project", "peer-a-id", "peer-a", { project: "other-project" }),
      error: /invalid project or direction/,
    },
    {
      name: "sender direction",
      message: repliedPeerMessage("wrong-sender", "peer-a-id", "peer-a", { from: "peer-a-id" }),
      error: /invalid project or direction/,
    },
    {
      name: "recipient direction",
      message: repliedPeerMessage("wrong-direction", "coordinator-id", "coordinator"),
      error: /invalid project or direction/,
    },
    {
      name: "eligible recipient",
      message: repliedPeerMessage("wrong-recipient", "outsider-id", "outsider"),
      error: /not eligible/,
    },
    {
      name: "run",
      message: repliedPeerMessage("wrong-run", "peer-a-id", "peer-a", {
        workflowContext: workflowContext({ runId: "run-other" }),
      }),
      error: /not bound/,
    },
    {
      name: "stage",
      message: repliedPeerMessage("wrong-stage", "peer-a-id", "peer-a", {
        workflowContext: workflowContext({ stageId: "implementation" }),
      }),
      error: /not bound/,
    },
    {
      name: "requirement",
      message: repliedPeerMessage("wrong-requirement", "peer-a-id", "peer-a", {
        workflowContext: workflowContext({ requirementKey: "other review" }),
      }),
      error: /not bound/,
    },
    {
      name: "attempt",
      message: repliedPeerMessage("wrong-attempt", "peer-a-id", "peer-a", {
        workflowContext: workflowContext({ attempt: 2 }),
      }),
      error: /attempt-1/,
    },
    {
      name: "correlation",
      message: repliedPeerMessage("wrong-correlation", "peer-a-id", "peer-a", { correlationId: "run-other" }),
      error: /not a replied message for run/,
    },
  ];
  for (const candidate of variants) {
    const run = provenanceRun();
    assert.throws(
      () => verify(run, [candidate.message]),
      candidate.error,
      candidate.name,
    );
    assert.equal(run.stages[0]!.attempts, 0, candidate.name);
  }
});

test("only coherent replied messages can be cited as peer evidence", () => {
  const base = repliedPeerMessage("terminal", "peer-a-id", "peer-a");
  const variants: Array<{ name: string; changes: Record<string, unknown>; error: RegExp }> = [
    { name: "queued", changes: { status: "queued", reply: undefined, repliedAt: undefined }, error: /not a replied message/ },
    { name: "delivered", changes: { status: "delivered", reply: undefined, repliedAt: undefined }, error: /not a replied message/ },
    { name: "cancelled", changes: { status: "cancelled", reply: undefined, repliedAt: undefined }, error: /not a replied message/ },
    { name: "expired", changes: { status: "expired", reply: undefined, repliedAt: undefined }, error: /not a replied message/ },
    { name: "error", changes: { status: "error", reply: undefined, repliedAt: undefined }, error: /not a replied message/ },
    { name: "missing reply", changes: { reply: undefined }, error: /not a replied message/ },
    {
      name: "blank reply",
      changes: { reply: { content: "   ", createdAt: "2026-01-01T00:01:02.000Z" } },
      error: /not a replied message/,
    },
    {
      name: "invalid request timestamp",
      changes: { createdAt: "not-a-time" },
      error: /incoherent reply timestamps/,
    },
    {
      name: "reply predates request",
      changes: { reply: { content: "review", createdAt: "2025-12-31T23:59:00.000Z" } },
      error: /incoherent reply timestamps/,
    },
    {
      name: "repliedAt predates reply",
      changes: { repliedAt: "2026-01-01T00:01:01.000Z" },
      error: /incoherent reply timestamps/,
    },
  ];
  for (const candidate of variants) {
    const message = { ...base, id: `terminal-${candidate.name}`, ...candidate.changes } as MessageRecord;
    assert.throws(() => verify(provenanceRun(), [message]), candidate.error, candidate.name);
  }
});

test("legacy strings and unrelated keyed claims cannot satisfy a structured peer policy", () => {
  const stage = resolvedPeerStage({ evidence: ["peer review: two peers approved", "local report: review.md"] });
  const run = provenanceRun(stage);
  assert.throws(
    () => checkpointRun(
      run,
      "review",
      "passed",
      "claimed review",
      {
        "peer review": "caller claims a quorum",
        "local report": "review.md",
        "review one": "approved",
        "review two": "approved",
      },
      "2026-01-01T00:03:00.000Z",
    ),
    /missing required evidence: peer review/,
  );
  assert.equal(stage.attempts, 0);
  assert.deepEqual(stage.evidence, ["peer review: two peers approved", "local report: review.md"]);
});

test("the hub authorizes and canonically binds workflow context before durable send", async (context) => {
  const { mesh, coordinator, peerA, outsider, run } = await startProvenanceMesh(context);
  const baseContext = { runId: run.id, stageId: "review", requirementKey: " Peer   Review ", attempt: 1 };

  await assert.rejects(
    () => coordinator.send({ target: outsider.agent!.name, content: "launder through outsider", workflowContext: baseContext }),
    expectMeshError("workflow_evidence_producer_forbidden", 403),
  );
  await assert.rejects(
    () => outsider.send({ target: peerA.agent!.name, content: "not coordinator", workflowContext: baseContext }),
    expectMeshError("workflow_context_forbidden", 403),
  );
  const otherProject = mesh.makeClient("other-project-coordinator", { project: "other-project" });
  await otherProject.start(() => undefined);
  await assert.rejects(
    () => otherProject.send({ target: "missing", content: "cross project", workflowContext: baseContext }),
    expectMeshError("workflow_context_forbidden", 403),
  );
  await assert.rejects(
    () => coordinator.send({ target: peerA.agent!.name, content: "wrong run", workflowContext: { ...baseContext, runId: "run-missing" } }),
    expectMeshError("workflow_context_forbidden", 403),
  );
  await assert.rejects(
    () => coordinator.send({ target: peerA.agent!.name, content: "wrong stage", workflowContext: { ...baseContext, stageId: "implement" } }),
    expectMeshError("workflow_context_inactive", 409),
  );
  await assert.rejects(
    () => coordinator.send({ target: peerA.agent!.name, content: "wrong requirement", workflowContext: { ...baseContext, requirementKey: "other" } }),
    expectMeshError("workflow_evidence_policy_missing", 400),
  );
  await assert.rejects(
    () => coordinator.send({ target: peerA.agent!.name, content: "wrong attempt", workflowContext: { ...baseContext, attempt: 2 } }),
    expectMeshError("workflow_context_attempt_mismatch", 409),
  );
  await assert.rejects(
    () => coordinator.send({
      target: peerA.agent!.name,
      content: "wrong correlation",
      correlationId: "caller-controlled-scope",
      workflowContext: baseContext,
    }),
    expectMeshError("workflow_context_correlation_mismatch", 409),
  );

  const sent = await coordinator.send({
    target: peerA.agent!.name,
    content: "bound review",
    idempotencyKey: "bound-review-attempt-one",
    workflowContext: baseContext,
  });
  assert.deepEqual(sent.workflowContext, {
    schema: "pi-mesh.workflow-message-context.v1",
    runId: run.id,
    stageId: "review",
    requirementKey: "peer review",
    attempt: 1,
  });
  assert.equal(sent.correlationId, run.id);
  const storedMessage = mesh.hub.state.messages.get(sent.id)!;
  storedMessage.workflowContext = {
    attempt: 1,
    requirementKey: "peer review",
    stageId: "review",
    runId: run.id,
    schema: "pi-mesh.workflow-message-context.v1",
  };
  const retried = await coordinator.send({
    target: peerA.agent!.name,
    content: "bound review",
    idempotencyKey: "bound-review-attempt-one",
    workflowContext: baseContext,
  });
  assert.equal(retried.id, sent.id);
  await assert.rejects(
    () => coordinator.send({
      target: peerA.agent!.name,
      content: "changed request",
      idempotencyKey: "bound-review-attempt-one",
      workflowContext: baseContext,
    }),
    expectMeshError("idempotency_conflict", 409),
  );
  sent.workflowContext!.stageId = "mutated-client-copy";
  assert.equal((await coordinator.getMessage(sent.id)).workflowContext!.stageId, "review");
});

test("fanout retries canonicalize workflow context property order", async (context) => {
  const { mesh, coordinator, peerA, run } = await startProvenanceMesh(context);
  const before = mesh.hub.state.messages.size;
  const firstContext = {
    runId: run.id,
    stageId: "review",
    requirementKey: " Peer   Review ",
    attempt: 1,
  };
  const reorderedContext = {
    attempt: 1,
    requirementKey: "peer review",
    stageId: "review",
    runId: run.id,
  };
  const options = {
    targets: [peerA.agent!.name],
    content: "Review this exact workflow attempt",
    idempotencyKeyPrefix: "canonical-workflow-context",
    timeoutMs: 25,
  };
  const [first] = await coordinator.fanout({ ...options, workflowContext: firstContext });
  const [retried] = await coordinator.fanout({ ...options, workflowContext: reorderedContext });
  assert.ok(first?.messageId);
  assert.equal(first.status, "pending");
  assert.equal(retried?.messageId, first.messageId);
  assert.equal(retried?.status, "pending");
  assert.equal(mesh.hub.state.messages.size, before + 1);
});

test("a genuine two-peer hub quorum passes while caller text and duplicate producers do not", async (context) => {
  const { coordinator, peerA, peerB, run } = await startProvenanceMesh(context);
  await assert.rejects(
    () => coordinator.checkpointWorkflow(run.id, {
      stageId: "review",
      status: "passed",
      summary: "caller claims two reviews",
      evidence: {
        "peer review": "peer-a and peer-b approved",
        "local report": "review.md",
        "unrelated review": "also approved",
      },
    }),
    expectMeshError("workflow_evidence_incomplete", 400),
  );
  assert.equal((await coordinator.getWorkflow(run.id)).run.stages[0]!.attempts, 0);

  const peerAFirst = await obtainPeerReply(coordinator, peerA, run.id);
  const peerASecond = await obtainPeerReply(coordinator, peerA, run.id);
  await assert.rejects(
    () => coordinator.checkpointWorkflow(run.id, {
      stageId: "review",
      status: "passed",
      summary: "two messages from one peer",
      evidence: { "local report": "review.md" },
      evidenceRefs: { "peer review": { messageIds: [peerAFirst.id, peerASecond.id] } },
    }),
    expectMeshError("workflow_evidence_incomplete", 400),
  );
  assert.equal((await coordinator.getWorkflow(run.id)).run.stages[0]!.attempts, 0);

  const peerBReply = await obtainPeerReply(coordinator, peerB, run.id);
  const completed = await coordinator.checkpointWorkflow(run.id, {
    stageId: "review",
    status: "passed",
    summary: "two unique peers replied",
    evidence: { "local report": "review.md" },
    evidenceRefs: { "peer review": { messageIds: [peerAFirst.id, peerBReply.id] } },
  });
  assert.equal(completed.completed, true);
  const stage = completed.run.stages[0]!;
  assert.equal(stage.status, "passed");
  assert.deepEqual(
    new Set(stage.verifiedEvidence?.["peer review"]?.map((snapshot) => snapshot.producerId)),
    new Set([peerA.agent!.id, peerB.agent!.id]),
  );
  assert.equal(stage.verifiedEvidence?.["peer review"]?.every((snapshot) => snapshot.context.runId === run.id), true);
});

test("non-passing checkpoints reject peer references without mutating the run", async (context) => {
  const { coordinator, peerA, run } = await startProvenanceMesh(context);
  const peerReply = await obtainPeerReply(coordinator, peerA, run.id);
  for (const status of ["warning", "failed"] as const) {
    await assert.rejects(
      () => coordinator.checkpointWorkflow(run.id, {
        stageId: "review",
        status,
        summary: `${status} must not retain peer proof`,
        evidenceRefs: { "peer review": { messageIds: [peerReply.id] } },
      }),
      expectMeshError("invalid_workflow_evidence_refs", 400),
    );
  }
  const current = await coordinator.getWorkflow(run.id);
  assert.equal(current.run.stages[0]!.attempts, 0);
  assert.equal(current.run.stages[0]!.verifiedEvidence, undefined);
  assert.equal(current.journal.length, 0);
});

test("admin degradation is authenticated, concurrent-idempotent, isolated across three attempts, and visibly used", async (context) => {
  const definition = workflowDefinition({
    id: "degraded-provenance",
    requiredEvidence: ["peer review"],
    evidencePolicies: {
      "peer review": {
        ...peerPolicy(2, ["peer-a", "peer-b"]),
        degradation: { minProducers: 1 },
      },
    },
  });
  const { coordinator, peerA, run, mesh } = await startProvenanceMesh(context, definition);
  const endpoint = `${mesh.address.url}/v1/workflows/${run.id}/degradations`;
  const approvalBody = JSON.stringify({
    stageId: "review",
    requirementKey: "peer review",
    reason: "peer-b provider outage",
  });

  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: approvalBody,
  });
  assert.equal(unauthorized.status, 401);

  // Hold two identical bodies back after sending their headers. Both handlers
  // must resolve the authoritative run only after body I/O completes.
  const first = beginJsonPost(endpoint, mesh.token, approvalBody);
  const second = beginJsonPost(endpoint, mesh.token, approvalBody);
  await new Promise((resolve) => setTimeout(resolve, 75));
  first.request.end(approvalBody);
  second.request.end(approvalBody);
  const concurrent = await Promise.all([first.response, second.response]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 201]);
  const approvalIds = concurrent.map((result) => (
    result.body.approval as { id: string }
  ).id);
  assert.equal(new Set(approvalIds).size, 1);
  assert.deepEqual(concurrent.map((result) => result.body.duplicate).sort(), [false, true]);

  let current = await coordinator.getWorkflow(run.id);
  assert.equal(current.run.stages[0]!.degradationApprovals?.length, 1);
  assert.equal(current.journal.filter((entry) => entry.evidence.includes("class:workflow_quorum_degradation_approved")).length, 1);

  const conflicting = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mesh.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      stageId: "review",
      requirementKey: "peer review",
      reason: "a different justification",
    }),
  });
  assert.equal(conflicting.status, 409);

  const warning = await coordinator.checkpointWorkflow(run.id, {
    stageId: "review",
    status: "warning",
    summary: "retry after an inconclusive review",
  });
  assert.equal(warning.retry, true);
  assert.equal(warning.run.stages[0]!.attempts, 1);

  const attemptTwoReply = await obtainPeerReply(coordinator, peerA, run.id, "peer review", 2);
  await assert.rejects(
    () => coordinator.checkpointWorkflow(run.id, {
      stageId: "review",
      status: "passed",
      summary: "old approval must not carry forward",
      evidenceRefs: { "peer review": { messageIds: [attemptTwoReply.id] } },
    }),
    expectMeshError("workflow_evidence_incomplete", 400),
  );

  const attemptTwoApproval = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mesh.token}`,
      "content-type": "application/json",
    },
    body: approvalBody,
  });
  assert.equal(attemptTwoApproval.status, 201);
  const attemptTwoWarning = await coordinator.checkpointWorkflow(run.id, {
    stageId: "review",
    status: "warning",
    summary: "second attempt remains inconclusive",
  });
  assert.equal(attemptTwoWarning.retry, true);
  assert.equal(attemptTwoWarning.run.stages[0]!.attempts, 2);

  const attemptThreeReply = await obtainPeerReply(coordinator, peerA, run.id, "peer review", 3);
  await assert.rejects(
    () => coordinator.checkpointWorkflow(run.id, {
      stageId: "review",
      status: "passed",
      summary: "neither earlier approval may carry into attempt three",
      evidenceRefs: { "peer review": { messageIds: [attemptThreeReply.id] } },
    }),
    expectMeshError("workflow_evidence_incomplete", 400),
  );
  assert.equal((await coordinator.getWorkflow(run.id)).run.stages[0]!.attempts, 2);

  const attemptThreeApproval = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mesh.token}`,
      "content-type": "application/json",
    },
    body: approvalBody,
  });
  assert.equal(attemptThreeApproval.status, 201);
  const completed = await coordinator.checkpointWorkflow(run.id, {
    stageId: "review",
    status: "passed",
    summary: "one explicitly approved peer replied",
    evidenceRefs: { "peer review": { messageIds: [attemptThreeReply.id] } },
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.run.stages[0]!.degraded, true);
  assert.deepEqual(completed.run.stages[0]!.degradedRequirements, ["peer review"]);
  current = await coordinator.getWorkflow(run.id);
  assert.equal(current.run.stages[0]!.degradationApprovals?.length, 3);
  assert.deepEqual(
    current.run.stages[0]!.degradationApprovals?.map((approval) => approval.attempt),
    [1, 2, 3],
  );
  assert.equal(current.journal.filter((entry) => entry.evidence.includes("class:workflow_quorum_degradation_approved")).length, 3);
  assert.equal(current.journal.filter((entry) => entry.evidence.includes("class:workflow_quorum_degradation_used")).length, 1);
});

test("degradation is forbidden when a peer policy does not configure it", async (context) => {
  const { coordinator, run, mesh } = await startProvenanceMesh(context);
  const response = await fetch(`${mesh.address.url}/v1/workflows/${run.id}/degradations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mesh.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      stageId: "review",
      requirementKey: "peer review",
      reason: "must remain strict",
    }),
  });
  assert.equal(response.status, 400);
  const body = await responseJson(response);
  assert.equal(body.code, "workflow_degradation_forbidden");
  assert.equal((await coordinator.getWorkflow(run.id)).journal.length, 0);
});

test("degradation fails closed when no administrative token is configured", async (context) => {
  const definition = workflowDefinition({
    id: "degradation-without-admin",
    requiredEvidence: ["peer review"],
    evidencePolicies: {
      "peer review": {
        ...peerPolicy(2, ["peer-a", "peer-b"]),
        degradation: { minProducers: 1 },
      },
    },
  });
  const { coordinator, run, mesh } = await startProvenanceMesh(context, definition, { authToken: "" });
  const response = await fetch(`${mesh.address.url}/v1/workflows/${run.id}/degradations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stageId: "review",
      requirementKey: "peer review",
      reason: "must not degrade without an administrator",
    }),
  });
  assert.equal(response.status, 503);
  assert.equal((await responseJson(response)).code, "admin_auth_not_configured");
  assert.equal((await coordinator.getWorkflow(run.id)).run.stages[0]!.degradationApprovals, undefined);
});

test("a project worker token cannot approve degradation but the split admin token can", async (context) => {
  const adminToken = "split-admin-token";
  const projectToken = "split-project-token";
  const definition = workflowDefinition({
    id: "split-degradation-auth",
    requiredEvidence: ["peer review"],
    evidencePolicies: {
      "peer review": {
        ...peerPolicy(2, ["peer-a", "peer-b"]),
        degradation: { minProducers: 1 },
      },
    },
  });
  const { coordinator, run, mesh } = await startProvenanceMesh(context, definition, {
    authToken: adminToken,
    projectTokens: { "test-project": projectToken },
    clientToken: projectToken,
  });
  const endpoint = `${mesh.address.url}/v1/workflows/${run.id}/degradations`;
  const body = JSON.stringify({
    stageId: "review",
    requirementKey: "peer review",
    reason: "administrator-authorized provider outage",
  });
  const workerAttempt = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${projectToken}`, "content-type": "application/json" },
    body,
  });
  assert.equal(workerAttempt.status, 401);
  assert.equal((await responseJson(workerAttempt)).code, "invalid_auth");

  const adminApproval = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body,
  });
  assert.equal(adminApproval.status, 201);
  const current = await coordinator.getWorkflow(run.id);
  assert.equal(current.run.stages[0]!.degradationApprovals?.length, 1);
});

test("mixed valid and invalid reference batches reject atomically", async (context) => {
  const definition = workflowDefinition({
    id: "atomic-provenance",
    requiredEvidence: ["architecture review", "security review"],
    evidencePolicies: {
      "architecture review": peerPolicy(1, ["peer-a"]),
      "security review": peerPolicy(1, ["peer-b"]),
    },
  });
  const { coordinator, peerA, peerB, run } = await startProvenanceMesh(context, definition);
  const architecture = await obtainPeerReply(coordinator, peerA, run.id, "architecture review");
  const pendingSecurity = await coordinator.send({
    target: peerB.agent!.name,
    content: "Review security",
    workflowContext: {
      runId: run.id,
      stageId: "review",
      requirementKey: "security review",
      attempt: 1,
    },
  });
  await peerB.acknowledge(pendingSecurity.id);

  await assert.rejects(
    () => coordinator.checkpointWorkflow(run.id, {
      stageId: "review",
      status: "passed",
      summary: "mixed batch",
      evidence: { "unrelated key": "must not persist" },
      evidenceRefs: {
        "architecture review": { messageIds: [architecture.id] },
        "security review": { messageIds: [pendingSecurity.id] },
      },
    }),
    expectMeshError("workflow_provenance_invalid", 400),
  );
  let current = await coordinator.getWorkflow(run.id);
  assert.equal(current.run.status, "running");
  assert.equal(current.run.stages[0]!.status, "in_progress");
  assert.equal(current.run.stages[0]!.attempts, 0);
  assert.deepEqual(current.run.stages[0]!.evidence, {});
  assert.equal(current.run.stages[0]!.verifiedEvidence, undefined);
  assert.equal(current.journal.length, 0);

  const security = await peerB.reply(pendingSecurity.id, "security approved");
  const completed = await coordinator.checkpointWorkflow(run.id, {
    stageId: "review",
    status: "passed",
    summary: "both batches valid",
    evidenceRefs: {
      "architecture review": { messageIds: [architecture.id] },
      "security review": { messageIds: [security.id] },
    },
  });
  assert.equal(completed.completed, true);
  const finalRun = await coordinator.getWorkflow(run.id);
  assert.equal(finalRun.run.stages[0]!.verifiedEvidence?.["architecture review"]?.length, 1);
  assert.equal(finalRun.run.stages[0]!.verifiedEvidence?.["security review"]?.length, 1);
});

test("peer evidence captured before a wait survives a signed callback checkpoint", async (context) => {
  const definition = workflowDefinition({
    id: "wait-provenance",
    signalSecret: SIGNAL_SECRET,
    requiredEvidence: ["peer review", "github.check:ci"],
    evidencePolicies: { "peer review": peerPolicy(1, ["peer-a"]) },
  });
  const { coordinator, peerA, run, mesh } = await startProvenanceMesh(context, definition);
  const peerReply = await obtainPeerReply(coordinator, peerA, run.id);
  const waiting = await coordinator.waitForWorkflowSignal(run.id, {
    stageId: "review",
    signalKey: "ci-main",
    summary: "CI is running",
    evidenceRefs: { "peer review": { messageIds: [peerReply.id] } },
    timeoutMs: 60_000,
  });
  assert.equal(waiting.run.status, "waiting");
  assert.equal(waiting.run.stages[0]!.verifiedEvidence?.["peer review"]?.[0]?.messageId, peerReply.id);

  const signalBody = JSON.stringify({
    status: "passed",
    summary: "CI passed",
    evidence: { "github.check:ci": "https://ci.example/run/1" },
  });
  const signal = await fetch(
    `${mesh.address.url}/v1/webhooks/${definition.id}/runs/${run.id}/signals/ci-main`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mesh-delivery-id": "ci-main-passed",
        "x-hub-signature-256": `sha256=${createHmac("sha256", SIGNAL_SECRET).update(signalBody).digest("hex")}`,
      },
      body: signalBody,
    },
  );
  assert.equal(signal.status, 200, JSON.stringify(await responseJson(signal.clone())));
  const result = await coordinator.getWorkflow(run.id);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.stages[0]!.attempts, 1);
  assert.equal(result.run.stages[0]!.verifiedEvidence?.["peer review"]?.[0]?.messageId, peerReply.id);
  assert.deepEqual(result.run.stages[0]!.evidence, {
    "github.check:ci": ["https://ci.example/run/1"],
  });
});

test("an in-flight checkpoint cannot resurrect a concurrently expired wait", async (context) => {
  const definition = workflowDefinition({
    id: "checkpoint-expiry-race",
    requiredEvidence: [],
    evidencePolicies: {},
  });
  const { coordinator, run, mesh } = await startProvenanceMesh(context, definition, {
    cleanupIntervalMs: 20,
  });
  await coordinator.waitForWorkflowSignal(run.id, {
    stageId: "review",
    signalKey: "slow-gate",
    summary: "wait until the bounded deadline",
    timeoutMs: 1_000,
  });
  const body = JSON.stringify({
    stageId: "review",
    status: "passed",
    summary: "late checkpoint must not win",
  });
  const agentKey = (coordinator as unknown as { agentKey: string }).agentKey;
  const pending = beginJsonPost(
    `${mesh.address.url}/v1/workflows/${run.id}/checkpoints`,
    mesh.token,
    body,
    {
      "x-mesh-agent-id": coordinator.agent!.id,
      "x-mesh-agent-key": agentKey,
    },
  );
  await waitFor(() => mesh.hub.state.workflowRuns.get(run.id)?.status === "failed", 2_500);
  pending.request.end(body);
  const late = await pending.response;
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "workflow_terminal");
  const current = await coordinator.getWorkflow(run.id);
  assert.equal(current.run.status, "failed");
  assert.equal(current.run.stages[0]!.status, "failed");
  assert.equal(current.run.stages[0]!.verifiedEvidence, undefined);
});

test("a signed callback can use prior admin approval but cannot approve degradation itself", async (context) => {
  const definition = workflowDefinition({
    id: "wait-degraded-provenance",
    signalSecret: SIGNAL_SECRET,
    requiredEvidence: ["peer review", "github.check:ci"],
    evidencePolicies: {
      "peer review": {
        ...peerPolicy(2, ["peer-a", "peer-b"]),
        degradation: { minProducers: 1 },
      },
    },
  });
  const { coordinator, peerA, run, mesh } = await startProvenanceMesh(context, definition);
  const peerReply = await obtainPeerReply(coordinator, peerA, run.id);
  await coordinator.waitForWorkflowSignal(run.id, {
    stageId: "review",
    signalKey: "ci-degraded",
    summary: "CI is running after one peer review",
    evidenceRefs: { "peer review": { messageIds: [peerReply.id] } },
    timeoutMs: 60_000,
  });

  const signalBody = JSON.stringify({
    status: "passed",
    summary: "CI passed",
    evidence: { "github.check:ci": "https://ci.example/run/degraded" },
    degradation: { requirementKey: "peer review", reason: "callback cannot approve" },
  });
  const signalUrl = `${mesh.address.url}/v1/webhooks/${definition.id}/runs/${run.id}/signals/ci-degraded`;
  const sendSignal = async (): Promise<Response> => await fetch(signalUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesh-delivery-id": "ci-degraded-passed",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SIGNAL_SECRET).update(signalBody).digest("hex")}`,
    },
    body: signalBody,
  });

  const unapproved = await sendSignal();
  assert.equal(unapproved.status, 400);
  assert.equal((await responseJson(unapproved)).code, "workflow_evidence_incomplete");
  let current = await coordinator.getWorkflow(run.id);
  assert.equal(current.run.status, "waiting");
  assert.equal(current.run.signalReceipts?.length ?? 0, 0);

  const approval = await fetch(`${mesh.address.url}/v1/workflows/${run.id}/degradations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mesh.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      stageId: "review",
      requirementKey: "peer review",
      reason: "peer-b provider outage during CI",
    }),
  });
  assert.equal(approval.status, 201);

  const approvedSignal = await sendSignal();
  assert.equal(approvedSignal.status, 200, JSON.stringify(await responseJson(approvedSignal.clone())));
  const approvedResponse = await responseJson(approvedSignal);
  assert.equal(approvedResponse.degraded, true);
  assert.deepEqual(approvedResponse.degradedRequirements, ["peer review"]);
  const duplicateSignal = await sendSignal();
  assert.equal(duplicateSignal.status, 200);
  const duplicateResponse = await responseJson(duplicateSignal);
  assert.equal(duplicateResponse.duplicate, true);
  assert.equal(duplicateResponse.degraded, true);
  assert.deepEqual(duplicateResponse.degradedRequirements, ["peer review"]);
  current = await coordinator.getWorkflow(run.id);
  assert.equal(current.run.status, "completed");
  assert.equal(current.run.stages[0]!.degraded, true);
  assert.equal(current.run.signalReceipts?.length, 1);
  assert.equal(current.journal.filter((entry) => entry.evidence.includes("class:workflow_quorum_degradation_approved")).length, 1);
  assert.equal(current.journal.filter((entry) => entry.evidence.includes("class:workflow_quorum_degradation_used")).length, 1);
});

test("verified peer snapshots remain durable after source-message retention purge", async (context) => {
  const definition = workflowDefinition({
    id: "retained-provenance",
    requiredEvidence: ["peer review"],
    evidencePolicies: { "peer review": peerPolicy(1, ["peer-a"]) },
  });
  const { coordinator, peerA, run, mesh } = await startProvenanceMesh(context, definition, {
    messageRetentionMs: 1_000,
    cleanupIntervalMs: 25,
  });
  const peerReply = await obtainPeerReply(coordinator, peerA, run.id);
  const completed = await coordinator.checkpointWorkflow(run.id, {
    stageId: "review",
    status: "passed",
    summary: "peer approved",
    evidenceRefs: { "peer review": { messageIds: [peerReply.id] } },
  });
  assert.equal(completed.completed, true);
  await waitFor(() => !mesh.hub.state.messages.has(peerReply.id), 2_500);
  const retained = await coordinator.getWorkflow(run.id);
  assert.equal(retained.run.status, "completed");
  assert.equal(retained.run.stages[0]!.verifiedEvidence?.["peer review"]?.[0]?.messageId, peerReply.id);
  assert.equal(retained.run.stages[0]!.verifiedEvidence?.["peer review"]?.[0]?.replySha256.length, 64);
});

test("one shared project-token holder can reclaim multiple producer IDs, so quorum proves routing provenance only", async (context) => {
  const adminToken = "identity-boundary-admin-token";
  const sharedProjectToken = "identity-boundary-project-token";
  const { mesh, coordinator, peerA, peerB, run } = await startProvenanceMesh(
    context,
    workflowDefinition(),
    {
      authToken: adminToken,
      projectTokens: { "test-project": sharedProjectToken },
      clientToken: sharedProjectToken,
    },
  );
  const requestA = await coordinator.send({
    target: peerA.agent!.name,
    content: "Review before an identity restart",
    workflowContext: { runId: run.id, stageId: "review", requirementKey: "peer review", attempt: 1 },
  });
  const requestB = await coordinator.send({
    target: peerB.agent!.name,
    content: "Review before an identity restart",
    workflowContext: { runId: run.id, stageId: "review", requirementKey: "peer review", attempt: 1 },
  });
  const peerAId = peerA.agent!.id;
  const peerBId = peerB.agent!.id;
  await Promise.all([peerA.stop(), peerB.stop()]);

  // Name recovery intentionally uses the project credential boundary. A
  // holder of that shared token can resume offline names and stable IDs, so a
  // unique-ID quorum must never be described as proof of distinct models,
  // people, non-collusion, or factual correctness.
  const resumedA = mesh.makeClient("peer-a", { token: sharedProjectToken });
  const resumedB = mesh.makeClient("peer-b", { token: sharedProjectToken });
  await Promise.all([resumedA.start(() => undefined), resumedB.start(() => undefined)]);
  assert.equal(resumedA.agent!.id, peerAId);
  assert.equal(resumedB.agent!.id, peerBId);
  const replyA = await resumedA.reply(requestA.id, "resumed A response");
  const replyB = await resumedB.reply(requestB.id, "resumed B response");
  const completed = await coordinator.checkpointWorkflow(run.id, {
    stageId: "review",
    status: "passed",
    summary: "routing provenance only; not truth, model independence, or non-collusion",
    evidence: { "local report": "trust-boundary.md" },
    evidenceRefs: { "peer review": { messageIds: [replyA.id, replyB.id] } },
  });
  assert.equal(completed.completed, true);
  assert.deepEqual(
    new Set(completed.run.stages[0]!.verifiedEvidence?.["peer review"]?.map((snapshot) => snapshot.producerId)),
    new Set([peerAId, peerBId]),
  );
});
