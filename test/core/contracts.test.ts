import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { Ajv2020, type AnySchemaObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isAlias, isCollection, isScalar, parseDocument, visit } from "yaml";

const root = process.cwd();
const schemaDir = resolve(root, "schemas");
const exampleDir = resolve(root, "examples/project");

type JsonObject = Record<string, unknown>;

interface LoadedResource {
  file: string;
  value: JsonObject;
}

function filesUnder(directory: string, extension: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(path, extension));
    else if (entry.isFile() && extname(entry.name) === extension) result.push(path);
  }
  return result.sort();
}

function asObject(value: unknown, label: string): JsonObject {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as JsonObject;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") assert.fail(`${label} must be a string`);
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
}

function schemaIdentity(schema: AnySchemaObject): string {
  return stringValue(schema.$id, "schema.$id");
}

function createValidator(): {
  ajv: Ajv2020;
  schemas: AnySchemaObject[];
  validators: Map<string, ValidateFunction>;
} {
  const schemaFiles = filesUnder(schemaDir, ".json");
  const schemas = schemaFiles.map((file) => JSON.parse(readFileSync(file, "utf8")) as AnySchemaObject);
  schemas.sort((left, right) => Number(schemaIdentity(right).endsWith("/common.schema.json"))
    - Number(schemaIdentity(left).endsWith("/common.schema.json")));

  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  for (const schema of schemas) ajv.addSchema(schema);

  const validators = new Map<string, ValidateFunction>();
  for (const schema of schemas) {
    const id = schemaIdentity(schema);
    const validate = ajv.getSchema(id);
    assert(validate, `schema did not compile: ${id}`);
    validators.set(id, validate);
  }
  return { ajv, schemas, validators };
}

function parseRestrictedYaml(text: string, label: string): JsonObject {
  assert(Buffer.byteLength(text, "utf8") <= 256 * 1024, `${label} exceeds the document byte limit`);
  const document = parseDocument(text, {
    customTags: [],
    strict: true,
    uniqueKeys: true,
  });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    `invalid YAML in ${label}`,
  );
  visit(document, (_key, node, path) => {
    assert(path.length <= 32, `${label} exceeds the nesting depth limit`);
    assert.equal(isAlias(node), false, `${label} contains a forbidden alias`);
    if (isCollection(node)) assert(node.items.length <= 4096, `${label} contains an oversized collection`);
    if (isScalar(node) && typeof node.value === "string") {
      assert(Buffer.byteLength(node.value, "utf8") <= 65_536, `${label} contains an oversized scalar`);
    }
    if (node && typeof node === "object" && "tag" in node && typeof node.tag === "string") {
      assert(node.tag.startsWith("tag:yaml.org,2002:"), `${label} contains a forbidden custom tag`);
    }
  });
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  return asObject(value, label);
}

function parseYamlResource(file: string): LoadedResource {
  return {
    file,
    value: parseRestrictedYaml(readFileSync(file, "utf8"), relative(root, file)),
  };
}

function validateResource(
  ajv: Ajv2020,
  resource: LoadedResource,
): void {
  const identity = stringValue(resource.value.schema, `${resource.file}.schema`);
  const schemaName: Record<string, string> = {
    "kxm.project.v1": "project",
    "kxm.repository.v1": "repository",
    "kxm.agent.v1": "agent",
    "kxm.model.v1": "model",
    "kxm.environment.v1": "environment",
    "kxm.workflow.v1": "workflow",
    "kxm.gate-registry.v1": "gate-registry",
    "kxm.prices.v1": "prices",
  };
  const name = schemaName[identity];
  assert(name, `unknown resource schema ${identity} in ${relative(root, resource.file)}`);
  const validate = ajv.getSchema(`https://schemas.kxm.dev/${name}.schema.json`);
  assert(validate, `missing validator for ${identity}`);
  assert(
    validate(resource.value),
    `${relative(root, resource.file)} failed ${identity}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`,
  );
}

function pathIdentity(resource: LoadedResource): string {
  return basename(resource.file, extname(resource.file));
}

function transitionTarget(value: unknown): { target: string; maxTransitions?: number; terminalStatus?: string } {
  if (typeof value === "string") return { target: value };
  const object = asObject(value, "transition");
  const result: { target: string; maxTransitions?: number; terminalStatus?: string } = {
    target: stringValue(object.target, "transition.target"),
  };
  if (typeof object.maxTransitions === "number") result.maxTransitions = object.maxTransitions;
  if (typeof object.terminalStatus === "string") result.terminalStatus = object.terminalStatus;
  return result;
}

function validateExampleSemantics(resources: LoadedResource[]): void {
  const project = resources.find((resource) => resource.value.schema === "kxm.project.v1");
  assert(project, "example must contain one project");

  const repositoryEntries = arrayValue(project.value.repositories, "project.repositories").map((value) => asObject(value, "repository"));
  const repositoryIds = repositoryEntries.map((entry) => stringValue(entry.id, "repository.id"));
  assert.equal(new Set(repositoryIds).size, repositoryIds.length, "repository IDs must be unique");
  assert.equal(repositoryEntries.filter((entry) => entry.role === "control").length, 1, "exactly one control repository is required");

  const repositoryResources = resources.filter((resource) => resource.value.schema === "kxm.repository.v1");
  for (const resource of repositoryResources) {
    assert(repositoryIds.includes(stringValue(resource.value.repositoryId, "repository.repositoryId")));
    assert.equal(resource.value.projectId, project.value.id);
  }
  assert.deepEqual(
    new Set(repositoryResources.map((resource) => stringValue(resource.value.repositoryId, "repository.repositoryId"))),
    new Set(repositoryIds),
    "complete fixture must include one repository-scoped definition per bound repository",
  );

  const agents = new Set(resources
    .filter((resource) => resource.value.schema === "kxm.agent.v1")
    .map(pathIdentity));
  const workflows = new Map(resources
    .filter((resource) => resource.value.schema === "kxm.workflow.v1")
    .map((resource) => [pathIdentity(resource), resource]));
  const agentResources = resources.filter((resource) => resource.value.schema === "kxm.agent.v1");
  const models = resources
    .filter((resource) => resource.value.schema === "kxm.model.v1")
    .map((resource) => ({ id: pathIdentity(resource), value: resource.value }));
  const modelProfiles = new Set(models.map((model) => model.id));
  const modelTags = new Set(models.flatMap((model) => arrayValue(model.value.tags ?? [], "model.tags").map(String)));

  for (const resource of agentResources) {
    if (resource.value.model === undefined) continue;
    const selector = asObject(resource.value.model, "agent.model");
    if (typeof selector.profile === "string") assert(modelProfiles.has(selector.profile), `unknown model profile ${selector.profile}`);
    if (typeof selector.tag === "string") assert(modelTags.has(selector.tag), `unknown model tag ${selector.tag}`);
  }

  assert(workflows.has(stringValue(project.value.defaultWorkflow, "project.defaultWorkflow")));

  for (const resource of workflows.values()) {
    const coordinator = stringValue(resource.value.coordinator, "workflow.coordinator");
    assert(agents.has(coordinator), `unknown coordinator ${coordinator}`);
    const steps = arrayValue(resource.value.steps, "workflow.steps").map((value) => asObject(value, "step"));
    const stepIds = steps.map((step) => stringValue(step.id, "step.id"));
    assert.equal(new Set(stepIds).size, stepIds.length, "step IDs must be unique");
    const indexById = new Map(stepIds.map((id, index) => [id, index]));

    for (const field of ["reproOracle", "planHash"] as const) {
      if (resource.value[field] === undefined) continue;
      const oracle = asObject(resource.value[field], `workflow.${field}`);
      const stageId = stringValue(oracle.stageId, `${field}.stageId`);
      const evidenceKey = stringValue(oracle.evidenceKey, `${field}.evidenceKey`);
      const stage = steps.find((candidate) => candidate.id === stageId);
      assert(stage, `${field} references unknown stage ${stageId}`);
      const keys = arrayValue(stage.requiredEvidence ?? [], `${stageId}.requiredEvidence`)
        .map((entry) => stringValue(asObject(entry, "evidence").key, "evidence.key"));
      assert(keys.includes(evidenceKey), `${field} references undeclared evidence ${evidenceKey}`);
    }
    for (const stageId of arrayValue(resource.value.requirePlanHash ?? [], "workflow.requirePlanHash")) {
      assert(indexById.has(stringValue(stageId, "requirePlanHash[]")), `requirePlanHash references unknown stage ${String(stageId)}`);
    }

    for (const [index, step] of steps.entries()) {
      const kind = stringValue(step.kind, "step.kind");
      if (kind === "agent" || kind === "moa") {
        const agent = stringValue(step.agent, "step.agent");
        assert(agents.has(agent), `unknown agent ${agent}`);
      }

      if (step.repositories !== undefined) {
        for (const repositoryId of Object.keys(asObject(step.repositories, "step.repositories"))) {
          assert(repositoryIds.includes(repositoryId), `unknown repository ${repositoryId}`);
        }
      }

      if (step.assignments !== undefined) {
        const assignments = asObject(step.assignments, "step.assignments");
        const minimum = Number(assignments.minimum ?? 1);
        const target = Number(assignments.target ?? minimum);
        const maximum = Number(assignments.maximum ?? target);
        const maxParallel = Number(assignments.maxParallel ?? maximum);
        assert(minimum <= target && target <= maximum, "assignment bounds must satisfy minimum <= target <= maximum");
        assert(maxParallel <= maximum, "maxParallel cannot exceed maximum");
        if (assignments.maxWriteRepositories !== undefined) {
          const writable = Object.values(asObject(step.repositories ?? {}, "step.repositories"))
            .filter((access) => access === "write").length;
          assert(Number(assignments.maxWriteRepositories) <= writable, "maxWriteRepositories exceeds writable repository scope");
        }

        if (kind === "moa" && arrayValue(assignments.distinctBy ?? [], "assignments.distinctBy").includes("provider")) {
          const selector = asObject(step.model, "moa.model");
          const tag = stringValue(selector.tag, "moa.model.tag");
          const providers = new Set(models
            .filter((model) => arrayValue(model.value.tags ?? [], "model.tags").includes(tag))
            .map((model) => stringValue(model.value.provider, "model.provider")));
          assert(providers.size >= target, `MOA tag ${tag} cannot satisfy provider-distinct target ${target}`);
        }
      }

      if (step.requiredEvidence !== undefined) {
        for (const rawRequirement of arrayValue(step.requiredEvidence, "step.requiredEvidence")) {
          const requirement = asObject(rawRequirement, "evidence requirement");
          if (requirement.producerPolicy === undefined) continue;
          assert.equal(requirement.kind, "assignment-result", "producer policies require assignment-result evidence");
          const policy = asObject(requirement.producerPolicy, "producerPolicy");
          const eligible = arrayValue(policy.eligibleAgents, "producerPolicy.eligibleAgents").map(String);
          for (const agent of eligible) assert(agents.has(agent), `producer policy references unknown agent ${agent}`);
          const target = Number(asObject(step.assignments ?? {}, "step.assignments").target ?? 1);
          assert(Number(policy.minimumProducers) <= target, "producer minimum exceeds assignment target");
        }
      }

      if (step.join !== undefined && asObject(step.join, "step.join").strategy === "first-success") {
        assert.equal(step.safeSpeculation, true, "first-success requires safeSpeculation");
      }

      if (step.on === undefined) continue;
      for (const value of Object.values(asObject(step.on, "step.on"))) {
        const transition = transitionTarget(value);
        if (transition.target === "$terminal") {
          assert(transition.terminalStatus, "terminal transitions require terminalStatus");
          continue;
        }
        const targetIndex = indexById.get(transition.target);
        assert.notEqual(targetIndex, undefined, `unknown transition target ${transition.target}`);
        if ((targetIndex as number) <= index) {
          assert(resource.value.limits, "workflows with back-edges require global limits");
          assert(transition.maxTransitions, `back-edge to ${transition.target} requires maxTransitions`);
        }
      }
    }
  }
}

test("KXM JSON Schemas compile with unique identities", () => {
  const { schemas } = createValidator();
  const ids = schemas.map(schemaIdentity);
  assert.equal(new Set(ids).size, ids.length);
  assert(ids.some((id) => id.endsWith("/common.schema.json")));
  assert(ids.length >= 12);
});

test("restricted YAML profile rejects aliases, custom tags, duplicates, depth, and large scalars", () => {
  assert.throws(() => parseRestrictedYaml("a: 1\na: 2\n", "duplicate"));
  assert.throws(() => parseRestrictedYaml("root: &root { value: 1 }\ncopy: *root\n", "alias"));
  assert.throws(() => parseRestrictedYaml("value: !execute command\n", "custom-tag"));
  assert.throws(() => parseRestrictedYaml(`value: ${"x".repeat(70_000)}\n`, "large-scalar"));
  let nested = "value: true";
  for (let index = 0; index < 40; index += 1) nested = `level-${index}:\n${nested.split("\n").map((line) => `  ${line}`).join("\n")}`;
  assert.throws(() => parseRestrictedYaml(`${nested}\n`, "deep-document"));
});

test("KXM YAML project fixture validates and resolves semantically", () => {
  const { ajv } = createValidator();
  const resources = filesUnder(exampleDir, ".yaml").map(parseYamlResource);
  assert(resources.length >= 10);
  for (const resource of resources) validateResource(ajv, resource);
  validateExampleSemantics(resources);
});

test("KXM fix fixture preserves current oracle, plan-hash, and producer controls", () => {
  const target = parseYamlResource(resolve(exampleDir, ".kxm/workflows/fix.yaml")).value;
  assert.equal(typeof target.reproOracle, "object");
  assert.equal(typeof target.planHash, "object");
  assert(Array.isArray(target.requirePlanHash));
  assert(target.requirePlanHash.length > 0);
  const limits = asObject(target.limits, "target.limits");
  assert.equal(typeof limits.maxTransitions, "number");
  const stages = arrayValue(target.steps, "target.steps").map((step) => asObject(step, "target step"));
  assert(stages.some((step) => step.kind === "agent"));
  assert(stages.some((step) => step.kind === "gate"));
});
test("KXM representative durable records validate", () => {
  const { ajv } = createValidator();
  const recordFiles = filesUnder(resolve(exampleDir, "records"), ".json");
  const schemaByIdentity: Record<string, string> = {
    "kxm.run-event.v1": "run-event",
    "kxm.sync-event.v1": "sync-event",
    "kxm.assignment-result.v1": "assignment-result",
    "kxm.delivery-manifest.v1": "delivery-manifest",
    "kxm.context-candidate.v1": "context-candidate",
  };

  assert(recordFiles.length >= Object.keys(schemaByIdentity).length);
  const seenIdentities = new Set<string>();
  for (const file of recordFiles) {
    const value = asObject(JSON.parse(readFileSync(file, "utf8")), file);
    const identity = stringValue(value.schema, `${file}.schema`);
    seenIdentities.add(identity);
    const schemaName = schemaByIdentity[identity];
    assert(schemaName, `unknown record schema ${identity}`);
    const validate = ajv.getSchema(`https://schemas.kxm.dev/${schemaName}.schema.json`);
    assert(validate);
    assert(validate(value), `${relative(root, file)}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
  assert.deepEqual([...seenIdentities].sort(), Object.keys(schemaByIdentity).sort());
});

test("KXM records preserve source-event identity and complete repository pins", () => {
  const localEvents = filesUnder(resolve(exampleDir, "records"), ".json")
    .map((file) => asObject(JSON.parse(readFileSync(file, "utf8")), file))
    .filter((value) => value.schema === "kxm.run-event.v1");
  const byId = new Map(localEvents.map((event) => [stringValue(event.eventId, "eventId"), event]));
  const syncEvents = filesUnder(resolve(exampleDir, "records"), ".json")
    .map((file) => asObject(JSON.parse(readFileSync(file, "utf8")), file))
    .filter((value) => value.schema === "kxm.sync-event.v1");
  for (const sync of syncEvents) {
    const source = byId.get(stringValue(sync.sourceEventId, "sync.sourceEventId"));
    assert(source, "sync event must reference a committed local event");
    for (const field of [
      "eventType",
      "projectId",
      "runId",
      "homeRuntimeId",
      "sequence",
      "configRevision",
      "memoryRevision",
      "executorPolicyRevision",
      "toolPolicyRevision",
    ]) assert.equal(sync[field], source[field], `sync field ${field} must match its source event`);
  }

  const project = parseYamlResource(resolve(exampleDir, ".kxm/project.yaml")).value;
  const projectRepositories = new Set(arrayValue(project.repositories, "project.repositories")
    .map((entry) => stringValue(asObject(entry, "repository").id, "repository.id")));
  const created = localEvents.find((event) => event.eventType === "run.created");
  assert(created);
  const payload = asObject(created.payload, "run.created.payload");
  const pinnedRepositories = new Set(arrayValue(payload.repositoryIds, "run.created.repositoryIds")
    .map((entry) => stringValue(entry, "repositoryId")));
  assert.deepEqual(pinnedRepositories, projectRepositories, "run.created must pin every bound repository id");
  assert(Array.isArray(payload.executorIds), "run.created must declare executor inventory ids");
});

test("schemas reject unsafe effects, inconsistent delivery, unbounded snapshots, and ambiguous terminals", () => {
  const { ajv } = createValidator();
  const validateEffect = ajv.compile({ $ref: "https://schemas.kxm.dev/common.schema.json#/$defs/effectPolicy" });
  assert.equal(validateEffect({ class: "external-idempotent", sharedMutable: false }), false);
  assert.equal(validateEffect({ class: "receipt-queryable", sharedMutable: false }), false);
  assert.equal(validateEffect({ class: "read-only", sharedMutable: true }), false);
  assert.equal(validateEffect({ class: "unknown", sharedMutable: false, receiptQuery: "guess" }), false);

  const delivery = JSON.parse(readFileSync(resolve(exampleDir, "records/delivery-manifest.json"), "utf8")) as JsonObject;
  const validateDelivery = ajv.getSchema("https://schemas.kxm.dev/delivery-manifest.schema.json");
  assert(validateDelivery);
  const inconsistent = structuredClone(delivery);
  asObject(arrayValue(inconsistent.repositories, "repositories")[0], "repository").status = "failed";
  assert.equal(validateDelivery(inconsistent), false, "completed delivery cannot contain a failed repository");
  const missingReceipt = structuredClone(delivery);
  delete asObject(arrayValue(missingReceipt.repositories, "repositories")[0], "repository").receipts;
  assert.equal(validateDelivery(missingReceipt), false, "delivered repository requires a receipt");
  for (const status of ["cancelled", "failed", "blocked_uncertain"]) {
    const hiddenSuccess = structuredClone(delivery);
    hiddenSuccess.status = status;
    assert.equal(validateDelivery(hiddenSuccess), false, `${status} delivery cannot hide delivered repositories`);
  }

  const project = parseYamlResource(resolve(exampleDir, ".kxm/project.yaml")).value;
  const dirtySnapshot = asObject(asObject(project.workspace, "workspace").dirtySnapshot, "dirtySnapshot");
  delete dirtySnapshot.maxUntrackedFileBytes;
  const validateProject = ajv.getSchema("https://schemas.kxm.dev/project.schema.json");
  assert(validateProject);
  assert.equal(validateProject(project), false, "bounded untracked policy requires explicit limits");

  const workflow = parseYamlResource(resolve(exampleDir, ".kxm/workflows/fix.yaml")).value;
  const ready = arrayValue(workflow.steps, "steps").map((step) => asObject(step, "step"))
    .find((step) => step.id === "ready-for-human-acceptance");
  assert(ready);
  asObject(ready.on, "ready.on").passed = "$terminal";
  const validateWorkflow = ajv.getSchema("https://schemas.kxm.dev/workflow.schema.json");
  assert(validateWorkflow);
  assert.equal(validateWorkflow(workflow), false, "terminal transition requires an explicit terminal status");
  const undefinedQuorum = parseYamlResource(resolve(exampleDir, ".kxm/workflows/default.yaml")).value;
  const plan = asObject(arrayValue(undefinedQuorum.steps, "steps")[0], "plan");
  plan.join = { strategy: "quorum" };
  assert.equal(validateWorkflow(undefinedQuorum), false, "quorum requires minimumPassed");
  const unsafeSpeculation = parseYamlResource(resolve(exampleDir, ".kxm/workflows/default.yaml")).value;
  asObject(arrayValue(unsafeSpeculation.steps, "steps")[0], "plan").join = { strategy: "first-success" };
  assert.equal(validateWorkflow(unsafeSpeculation), false, "first-success requires safeSpeculation");

  const environment = parseYamlResource(resolve(exampleDir, ".kxm/project/env.yaml")).value;
  asObject(environment.values, "environment.values").API_TOKEN = "not-allowed-inline";
  const validateEnvironment = ajv.getSchema("https://schemas.kxm.dev/environment.schema.json");
  assert(validateEnvironment);
  assert.equal(validateEnvironment(environment), false, "secret-bearing environment names require secret refs");

  const localEvent = JSON.parse(readFileSync(resolve(exampleDir, "records/run-created.json"), "utf8")) as JsonObject;
  asObject(localEvent.payload, "payload").status = "takeover-complete";
  const validateRunEvent = ajv.getSchema("https://schemas.kxm.dev/run-event.schema.json");
  assert(validateRunEvent);
  assert.equal(validateRunEvent(localEvent), false, "lifecycle status must be closed");

  const unfenced = JSON.parse(readFileSync(resolve(exampleDir, "records/run-created.json"), "utf8")) as JsonObject;
  unfenced.eventType = "effect.intent_recorded";
  const unfencedPayload = asObject(unfenced.payload, "payload");
  unfencedPayload.status = "intent_recorded";
  unfencedPayload.effect = {
    id: "effect_01JEFFECT000000000000000",
    policy: { class: "external-non-idempotent", sharedMutable: true },
  };
  assert.equal(validateRunEvent(unfenced), false, "shared mutable dispatch intent requires a lease");
  unfencedPayload.lease = {
    id: "lease_01JLEASE0000000000000000",
    fencingToken: "fence-42",
    acquiredAt: "2026-09-01T22:00:00.000Z",
    expiresAt: "2026-09-01T22:05:00.000Z",
    operation: "deployment",
  };
  assert.equal(validateRunEvent(unfenced), true, ajv.errorsText(validateRunEvent.errors));

  const assignmentResult = JSON.parse(readFileSync(resolve(exampleDir, "records/assignment-result.json"), "utf8")) as JsonObject;
  assignmentResult.status = "partial";
  const validateResult = ajv.getSchema("https://schemas.kxm.dev/assignment-result.schema.json");
  assert(validateResult);
  assert.equal(validateResult(assignmentResult), false, "partial is a panel/delivery state, not an assignment result state");

  const created = JSON.parse(readFileSync(resolve(exampleDir, "records/run-created.json"), "utf8")) as JsonObject;
  created.memoryRevision = "ctxrev_absent";
  asObject(created.payload, "payload").executorIds = [];
  assert.equal(validateRunEvent(created), true, ajv.errorsText(validateRunEvent.errors));
  const recorded = JSON.parse(readFileSync(resolve(exampleDir, "records/assignment-result-recorded.json"), "utf8")) as JsonObject;
  asObject(recorded.payload, "payload").resultClass = "outcome";
  assert.equal(validateRunEvent(recorded), true, ajv.errorsText(validateRunEvent.errors));
  const cancel = JSON.parse(readFileSync(resolve(exampleDir, "records/run-created.json"), "utf8")) as JsonObject;
  cancel.eventType = "run.cancel_requested";
  cancel.payload = {
    actor: { kind: "runtime", id: stringValue(cancel.homeRuntimeId, "homeRuntimeId") },
    reason: "operator_cancel",
  };
  assert.equal(validateRunEvent(cancel), true, ajv.errorsText(validateRunEvent.errors));

  const resultRecorded = JSON.parse(readFileSync(resolve(exampleDir, "records/assignment-result-recorded.json"), "utf8")) as JsonObject;
  delete asObject(resultRecorded.payload, "payload").resultClass;
  assert.equal(validateRunEvent(resultRecorded), false, "assignment.result_recorded requires resultClass");
  const outcomeMissing = JSON.parse(readFileSync(resolve(exampleDir, "records/assignment-result-recorded.json"), "utf8")) as JsonObject;
  delete asObject(outcomeMissing.payload, "payload").outcome;
  assert.equal(validateRunEvent(outcomeMissing), false, "outcome class requires outcome");
  const cancelledWithOutcome = JSON.parse(readFileSync(resolve(exampleDir, "records/assignment-result-recorded.json"), "utf8")) as JsonObject;
  asObject(cancelledWithOutcome.payload, "payload").resultClass = "cancelled";
  assert.equal(validateRunEvent(cancelledWithOutcome), false, "non-outcome resultClass forbids outcome");
  const dispatched = JSON.parse(readFileSync(resolve(exampleDir, "records/run-created.json"), "utf8")) as JsonObject;
  dispatched.eventType = "assignment.dispatched";
  dispatched.payload = { assignmentId: "assignment_01JASSIGNMENT00000000000", status: "dispatched" };
  assert.equal(validateRunEvent(dispatched), false, "assignment.dispatched requires capabilityHash");
  const entered = JSON.parse(readFileSync(resolve(exampleDir, "records/run-created.json"), "utf8")) as JsonObject;
  entered.eventType = "step.entered";
  entered.payload = { stepAttempt: 1, status: "pending" };
  assert.equal(validateRunEvent(entered), false, "step.entered requires stepId");
  const statusChanged = JSON.parse(readFileSync(resolve(exampleDir, "records/run-created.json"), "utf8")) as JsonObject;
  statusChanged.eventType = "run.status_changed";
  statusChanged.payload = { reason: "operator_cancel" };
  assert.equal(validateRunEvent(statusChanged), false, "run.status_changed requires status");
});

test("portable path schema rejects traversal and destination-incompatible names", () => {
  const { ajv } = createValidator();
  const validate = ajv.compile({ $ref: "https://schemas.kxm.dev/common.schema.json#/$defs/relativePath" });
  for (const candidate of ["tools", "repositories/api", ".", ".well-known/config"]) assert.equal(validate(candidate), true, candidate);
  for (const candidate of [
    "../outside",
    "a/../outside",
    "dir\\\\file",
    "dir\\\\..\\\\outside",
    "C:/absolute",
    "/absolute",
    "CON",
    "con.txt",
    "CON .txt",
    "dir/LPT1.log",
    "COM¹",
    "dir/LPT².txt",
    "CONIN$",
    "CONOUT$",
    "CLOCK$",
    "foo*bar",
    "./file",
    "a//b",
    "a/trailing.",
    "a/trailing ",
  ]) assert.equal(validate(candidate), false, candidate);
});

test("sync-safe schema rejects raw or host-sensitive escape fields", () => {
  const { ajv } = createValidator();
  const source = JSON.parse(readFileSync(resolve(exampleDir, "records/sync-event.json"), "utf8")) as JsonObject;
  const validate = ajv.getSchema("https://schemas.kxm.dev/sync-event.schema.json");
  assert(validate);

  for (const mutate of [
    (value: JsonObject): void => { asObject(value.payload, "payload").prompt = "full private prompt"; },
    (value: JsonObject): void => { asObject(value.payload, "payload").rawLogs = ["secret output"]; },
    (value: JsonObject): void => {
      asObject(value.payload, "payload").environment = [{
        name: "TOKEN",
        scope: "repository:api",
        status: "resolved",
        source: "secret-ref",
        value: "secret",
      }];
    },
    (value: JsonObject): void => {
      asObject(value.payload, "payload").fileChanges = [{
        repositoryId: "api",
        modified: ["C:/Users/operator/.ssh/id_ed25519"],
      }];
    },
    (value: JsonObject): void => {
      asObject(value.payload, "payload").receipts = [{
        provider: "github",
        kind: "pull-request",
        id: "41",
        url: "https://user:token@example.test/pull/41",
      }];
    },
    (value: JsonObject): void => { value.eventType = "model.invented_event"; },
    (value: JsonObject): void => { asObject(value.payload, "payload").status = "blocked-uncertain"; },
    (value: JsonObject): void => {
      value.eventType = "effect.intent_recorded";
      asObject(value.payload, "payload").effect = {
        id: "effect_01JEFFECT000000000000000",
        policy: { class: "external-non-idempotent", sharedMutable: true },
      };
    },
  ]) {
    const unsafe = structuredClone(source);
    mutate(unsafe);
    assert.equal(validate(unsafe), false, "unsafe sync payload unexpectedly validated");
  }
});
