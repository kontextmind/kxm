import { createHash } from "node:crypto";
import { stringify } from "yaml";
import type { JsonObject, JsonValue } from "./vnext-config.ts";

export const VNEXT_TEMPLATE_ID = "builtin-minimal";
export const VNEXT_TEMPLATE_PROVENANCE_PATH = ".kxm/template-provenance.yaml";
export const CURRENT_VNEXT_TEMPLATE_VARIANT: VnextTemplateVariant = "v4-registry";
export const SUPPORTED_VNEXT_TEMPLATE_VARIANTS = ["v1", "v2", "v3-policy", "v4-registry"] as const;

export type VnextTemplateVariant = typeof SUPPORTED_VNEXT_TEMPLATE_VARIANTS[number];

export interface VnextTemplateFileRecord {
  path: string;
  sha256: string;
  authoritySha256: string;
  bytes: number;
}

export interface VnextTemplateProvenance {
  schema: "kxm.template-provenance.v1";
  templateId: typeof VNEXT_TEMPLATE_ID;
  templateRevision: string;
  inputs: {
    projectId: string;
    projectName: string;
  };
  files: readonly VnextTemplateFileRecord[];
}

export interface VnextRenderedTemplate {
  projectId: string;
  projectName: string;
  templateRevision: string;
  provenance: VnextTemplateProvenance;
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

export function vnextContentSha256(input: string | Uint8Array): string {
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

export function vnextAuthoritySha256(value: JsonObject): string {
  return vnextContentSha256(canonicalJson(authorityProjection(value)));
}

function coreTemplate(projectId: string, projectName: string, variant: VnextTemplateVariant): ReadonlyMap<string, JsonObject> {
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
    files.set(".kxm/gates.yaml", {
      schema: "kxm.gate-registry.v1",
      gates: { test: { kind: "command", argv: ["npm", "test"], timeoutMs: 3_600_000 } },
    });
  }
  return files;
}

function provenanceRevision(files: readonly VnextTemplateFileRecord[]): string {
  return vnextContentSha256(canonicalJson(files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    authoritySha256: file.authoritySha256,
    bytes: file.bytes,
  }))));
}

export function renderVnextTemplate(
  projectId: string,
  projectName: string,
  variant: VnextTemplateVariant = CURRENT_VNEXT_TEMPLATE_VARIANT,
): VnextRenderedTemplate {
  const values = coreTemplate(projectId, projectName, variant);
  const coreFiles = new Map<string, Buffer>();
  const records = [...values.entries()].map(([path, value]) => {
    const bytes = Buffer.from(stringify(value, { lineWidth: 0 }), "utf8");
    coreFiles.set(path, bytes);
    return {
      path,
      sha256: vnextContentSha256(bytes),
      authoritySha256: vnextAuthoritySha256(value),
      bytes: bytes.byteLength,
    } satisfies VnextTemplateFileRecord;
  }).sort((left, right) => compareCodeUnits(left.path, right.path));
  const templateRevision = provenanceRevision(records);
  const provenance: VnextTemplateProvenance = {
    schema: "kxm.template-provenance.v1",
    templateId: VNEXT_TEMPLATE_ID,
    templateRevision,
    inputs: { projectId, projectName },
    files: records,
  };
  const fileEntries: [string, Buffer][] = [...coreFiles.entries()];
  fileEntries.push([
    VNEXT_TEMPLATE_PROVENANCE_PATH,
    Buffer.from(stringify(provenance as unknown as JsonObject, { lineWidth: 0 }), "utf8"),
  ]);
  fileEntries.sort(([left], [right]) => compareCodeUnits(left, right));
  const files = new Map<string, Buffer>(fileEntries);
  return { projectId, projectName, templateRevision, provenance, files, values };
}

export function validatedTemplateProvenance(value: JsonObject): VnextTemplateProvenance | undefined {
  if (value.schema !== "kxm.template-provenance.v1" || value.templateId !== VNEXT_TEMPLATE_ID) return undefined;
  const candidate = value as unknown as VnextTemplateProvenance;
  return provenanceRevision(candidate.files) === candidate.templateRevision ? candidate : undefined;
}

/** Resolve provenance only when its complete manifest equals a built-in baseline. */
export function resolveVnextTemplateBaseline(value: JsonObject): VnextTemplateProvenance | undefined {
  const candidate = validatedTemplateProvenance(value);
  if (!candidate) return undefined;
  for (const variant of SUPPORTED_VNEXT_TEMPLATE_VARIANTS) {
    const known = renderVnextTemplate(candidate.inputs.projectId, candidate.inputs.projectName, variant).provenance;
    if (known.templateRevision === candidate.templateRevision
      && canonicalJson(known as unknown as JsonObject) === canonicalJson(candidate as unknown as JsonObject)) {
      return candidate;
    }
  }
  return undefined;
}
