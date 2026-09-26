import { createHash } from "node:crypto";
import { stringify } from "yaml";
import type { JsonObject, JsonValue } from "./project-config.ts";

export const KXM_TEMPLATE_ID = "builtin-minimal";
export const KXM_TEMPLATE_PROVENANCE_PATH = ".kxm/template-provenance.yaml";
export const CURRENT_KXM_TEMPLATE_VARIANT: KxmTemplateVariant = "v4-registry";
export const SUPPORTED_KXM_TEMPLATE_VARIANTS = ["v1", "v2", "v3-policy", "v4-registry"] as const;

export type KxmTemplateVariant = typeof SUPPORTED_KXM_TEMPLATE_VARIANTS[number];

export interface KxmTemplateFileRecord {
  path: string;
  sha256: string;
  authoritySha256: string;
  bytes: number;
}

export interface KxmTemplateProvenance {
  schema: "kxm.template-provenance.v1";
  templateId: typeof KXM_TEMPLATE_ID;
  templateRevision: string;
  inputs: {
    projectId: string;
    projectName: string;
  };
  files: readonly KxmTemplateFileRecord[];
}

export interface KxmRenderedTemplate {
  projectId: string;
  projectName: string;
  templateRevision: string;
  provenance: KxmTemplateProvenance;
  files: ReadonlyMap<string, Buffer>;
  values: ReadonlyMap<string, JsonObject>;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((candidate) => canonicalJson(candidate)).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
}

export function kxmContentSha256(input: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function authorityProjection(value: JsonObject): JsonObject {
  const projected = structuredClone(value);
  if (projected.schema === "kxm.project.v1") delete projected.name;
  if (projected.schema === "kxm.repository.v1") delete projected.description;
  if (projected.schema === "kxm.agent.v1") delete projected.purpose;
  if (projected.schema === "kxm.workflow.v1") delete projected.description;
  return projected;
}

export function kxmAuthoritySha256(value: JsonObject): string {
  return kxmContentSha256(canonicalJson(authorityProjection(value)));
}

function coreTemplate(projectId: string, projectName: string, variant: KxmTemplateVariant): ReadonlyMap<string, JsonObject> {
  const files = new Map<string, JsonObject>([
    [".kxm/project.yaml", {
      schema: "kxm.project.v1",
      id: projectId,
      name: projectName,
      defaultWorkflow: "default",
      defaultExecutor: "local",
      defaultHarness: "pi",
      repositories: [{ id: "control", role: "control", required: true, pathHint: "." }],
      workspace: {
        dirtySnapshot: {
          untracked: "ask",
          dirtySubmodules: "fail",
        },
      },
    }],
    [".kxm/repo/repo.yaml", {
      schema: "kxm.repository.v1",
      projectId,
      repositoryId: "control",
      description: "Authoritative project configuration and repository content.",
      defaultAccess: "write",
    }],
    [".kxm/agents/coordinator.yaml", {
      schema: "kxm.agent.v1",
      purpose: variant === "v1" || variant === "v4-registry"
        ? "Coordinate the pinned workflow and emit schema-validated commands."
        : "Coordinate the pinned workflow and emit validated, reviewable commands.",
      tools: { preset: "coordinator" },
      defaultRepositoryAccess: "read",
      repositories: { control: variant === "v3-policy" ? "write" : "read" },
      network: "provider-only",
      resultSchema: "kxm.assignment-result.v1",
    }],
    [".kxm/agents/implementer.yaml", {
      schema: "kxm.agent.v1",
      purpose: "Implement the approved change within the declared repository scope.",
      tools: { preset: "workspace-writer" },
      defaultRepositoryAccess: "none",
      repositories: { control: "write" },
      network: "provider-only",
      resultSchema: "kxm.assignment-result.v1",
    }],
    [".kxm/workflows/default.yaml", {
      schema: "kxm.workflow.v1",
      description: "Plan, implement, and verify a local change.",
      coordinator: "coordinator",
      limits: {
        maxTransitions: 8,
        maxRunDurationMs: 14_400_000,
        maxAgentTimeMs: 21_600_000,
      },
      steps: [
        {
          id: "plan",
          kind: "agent",
          agent: "coordinator",
          maxAttempts: 2,
          repositories: { control: "read" },
          requiredEvidence: [{ key: "plan", kind: "artifact" }],
          timeoutMs: 1_200_000,
          on: {
            passed: "implement",
            blocked: { target: "$terminal", terminalStatus: "failed" },
          },
        },
        {
          id: "implement",
          kind: "agent",
          agent: "implementer",
          maxAttempts: 3,
          repositories: { control: "write" },
          assignments: {
            allowedAgents: ["implementer"],
            minimum: 1,
            target: 1,
            maximum: 1,
            maxParallel: 1,
            maxAttemptsPerAssignment: 2,
            maxWriteRepositories: 1,
          },
          requiredEvidence: [{ key: "implementation-diff", kind: "artifact" }],
          timeoutMs: 3_600_000,
          on: {
            passed: "verify",
            failed: { target: "$terminal", terminalStatus: "failed" },
            blocked: { target: "$terminal", terminalStatus: "failed" },
          },
        },
        {
          id: "verify",
          kind: "gate",
          gate: "test",
          maxAttempts: 3,
          repositories: { control: "write" },
          requiredEvidence: [{ key: "local-gates", kind: "gate" }],
          timeoutMs: 3_600_000,
          on: {
            passed: { target: "$terminal", terminalStatus: "completed" },
            "implementation-failure": { target: "implement", maxTransitions: 3 },
            failed: { target: "$terminal", terminalStatus: "failed" },
          },
        },
      ],
    }],
  ]);
  if (variant === "v4-registry") {
    const coordinator = files.get(".kxm/agents/coordinator.yaml");
    if (coordinator) {
      files.set(".kxm/agents/coordinator.yaml", {
        ...coordinator,
        harness: "claude",
        model: { provider: "anthropic", model: "fable" },
      });
    }
    const implementer = files.get(".kxm/agents/implementer.yaml");
    if (implementer) {
      files.set(".kxm/agents/implementer.yaml", {
        ...implementer,
        harness: "grok",
        model: { provider: "xai", model: "grok-4.6" },
      });
    }
    const workflow = files.get(".kxm/workflows/default.yaml");
    if (workflow) {
      const limits = { ...(workflow.limits as JsonObject) };
      delete limits.maxAgentTimeMs;
      files.set(".kxm/workflows/default.yaml", { ...workflow, limits });
    }
    // The two models the template names, and nothing else. A fresh project can
    // be driven without falling through to an unadmitted default model.
    files.set(".kxm/routes.yaml", {
      schema: "kxm.routes.v2",
      updatedAt: "2026-09-23T00:00:00.000Z",
      admitted: ["anthropic/fable", "xai/grok-4.6"],
      disabled: [],
    });
    files.set(".kxm/models/grok-default.yaml", {
      schema: "kxm.model.v2",
      id: "grok-default",
      harness: "grok",
      model: "grok-4.6",
      vendor: "xai",
      status: "admitted",
      permissions: ["edit"],
    });
    files.set(".kxm/models/fable-default.yaml", {
      schema: "kxm.model.v2",
      id: "fable-default",
      harness: "claude",
      model: "fable",
      vendor: "anthropic",
      status: "admitted",
      permissions: ["read-only"],
    });
    files.set(".kxm/roles/writer.yaml", {
      schema: "kxm.role.v2",
      id: "writer",
      purpose: "writer",
      permission: "edit",
      description: "Primary implementation agent.",
      roster: [{ route: "grok-default" }],
    });
    files.set(".kxm/roles/planner.yaml", {
      schema: "kxm.role.v2",
      id: "planner",
      purpose: "planner",
      permission: "read-only",
      description: "Plans the change before implementation.",
      roster: [{ route: "fable-default" }],
    });
    files.set(".kxm/gates.yaml", {
      schema: "kxm.gate-registry.v1",
      gates: { test: { kind: "command", argv: ["npm", "test"], timeoutMs: 3_600_000 } },
    });
  }
  return files;
}

function provenanceRevision(files: readonly KxmTemplateFileRecord[]): string {
  return kxmContentSha256(canonicalJson(files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    authoritySha256: file.authoritySha256,
    bytes: file.bytes,
  }))));
}

export function renderKxmTemplate(
  projectId: string,
  projectName: string,
  variant: KxmTemplateVariant = CURRENT_KXM_TEMPLATE_VARIANT,
): KxmRenderedTemplate {
  const values = coreTemplate(projectId, projectName, variant);
  const coreFiles = new Map<string, Buffer>();
  const records = [...values.entries()].map(([path, value]) => {
    const bytes = Buffer.from(stringify(value, { lineWidth: 0 }), "utf8");
    coreFiles.set(path, bytes);
    return {
      path,
      sha256: kxmContentSha256(bytes),
      authoritySha256: kxmAuthoritySha256(value),
      bytes: bytes.byteLength,
    } satisfies KxmTemplateFileRecord;
  }).sort((left, right) => compareCodeUnits(left.path, right.path));
  const templateRevision = provenanceRevision(records);
  const provenance: KxmTemplateProvenance = {
    schema: "kxm.template-provenance.v1",
    templateId: KXM_TEMPLATE_ID,
    templateRevision,
    inputs: { projectId, projectName },
    files: records,
  };
  const fileEntries: [string, Buffer][] = [...coreFiles.entries()];
  fileEntries.push([
    KXM_TEMPLATE_PROVENANCE_PATH,
    Buffer.from(stringify(provenance as unknown as JsonObject, { lineWidth: 0 }), "utf8"),
  ]);
  fileEntries.sort(([left], [right]) => compareCodeUnits(left, right));
  const files = new Map<string, Buffer>(fileEntries);
  return { projectId, projectName, templateRevision, provenance, files, values };
}

export function validatedTemplateProvenance(value: JsonObject): KxmTemplateProvenance | undefined {
  if (value.schema !== "kxm.template-provenance.v1" || value.templateId !== KXM_TEMPLATE_ID) return undefined;
  const candidate = value as unknown as KxmTemplateProvenance;
  return provenanceRevision(candidate.files) === candidate.templateRevision ? candidate : undefined;
}

/** Resolve provenance only when its complete manifest equals a built-in baseline. */
export function resolveKxmTemplateBaseline(value: JsonObject): KxmTemplateProvenance | undefined {
  const candidate = validatedTemplateProvenance(value);
  if (!candidate) return undefined;
  for (const variant of SUPPORTED_KXM_TEMPLATE_VARIANTS) {
    const known = renderKxmTemplate(candidate.inputs.projectId, candidate.inputs.projectName, variant).provenance;
    if (known.templateRevision === candidate.templateRevision
      && canonicalJson(known as unknown as JsonObject) === canonicalJson(candidate as unknown as JsonObject)) {
      return candidate;
    }
  }
  return undefined;
}
