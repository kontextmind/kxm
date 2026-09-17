/**
 * Interactive post-init setup for workflow-guide agents and workflows.
 *
 * Source of truth: `docs/workflow-guide.md`. The catalog below transcribes the
 * software-engineering area (workflows, stages, role slugs, and the guide's
 * ordered candidate lists). Guide candidates are dated research; each role's
 * first candidate whose harness is installed AND authenticated wins. No
 * candidate is admitted without an authenticated harness (fail closed).
 *
 * This module writes only current KXM project resources:
 *   - `.kxm/agents/<role-slug>.yaml`   (kxm.agent.v1)
 *   - `.kxm/workflows/<slug>.yaml`     (kxm.workflow.v1)
 * It never writes retired legacy authority (`.kxm/config`, retired
 * `.kxm/roster.json`) or the trusted `.kxm/roster.yaml` policy
 * and does not use the kxm.role.v1 subsystem.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { NATIVE_HARNESS_PROVIDERS, type HarnessInventory } from "./harness.ts";

export interface GuideCandidate {
  readonly vendor: string;
  readonly model: string;
}

export interface GuideStage {
  readonly slug: string;
  readonly title: string;
  readonly role: string;
  readonly domain: string;
  readonly candidates: readonly GuideCandidate[];
}

export interface GuideWorkflow {
  readonly slug: string;
  readonly area: string;
  readonly name: string;
  readonly summary: string;
  readonly stages: readonly GuideStage[];
}

/** Vendor prefix → native harness, using the guide's vendor spellings.
 * Everything else routes via Pi/OpenRouter. Native-vendor candidates never
 * fall back to OpenRouter when their native harness is unavailable: fail
 * closed instead of billing the same vendor through a second provider. */
const NATIVE_VENDOR_HARNESS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "claude",
  openai: "codex",
  "x-ai": "grok",
  xai: "grok",
  google: "agy",
  moonshotai: "kimi",
  moonshot: "kimi",
  deepseek: "deepseek",
});

/** Guide candidates are ordered by preference; the first eligible wins. */
export const GUIDE_WORKFLOWS: readonly GuideWorkflow[] = [
  {
    slug: "build-feature",
    area: "software-engineering",
    name: "Build Feature",
    summary: "PRD ingestion → system planning → spec/contract → scaffold → backend → frontend → SDK integration",
    stages: [
      {
        slug: "system-planning",
        title: "System planning",
        role: "lead-systems-planner",
        domain: "Decomposes requirements into an executable, dependency-ordered DAG of modules, tasks, and verification gates.",
        candidates: [
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "openai", model: "gpt-6-astra-pro" },
          { vendor: "x-ai", model: "grok-4.6" },
          { vendor: "qwen", model: "qwen3.8-max-0902" },
        ],
      },
      {
        slug: "spec-contract",
        title: "Spec and contract",
        role: "spec-contract-generator",
        domain: "Authors zero-ambiguity API contracts, type definitions, and schema validation rules before implementation begins.",
        candidates: [
          { vendor: "openai", model: "gpt-5.6-sol" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "google", model: "gemini-3.8-flash" },
          { vendor: "qwen", model: "qwen3-coder-plus" },
          { vendor: "anthropic", model: "claude-fable-5.1" },
        ],
      },
      {
        slug: "scaffold",
        title: "Scaffold",
        role: "scaffold-build-specialist",
        domain: "Provisions monorepo workspace topologies, linters, Docker multi-stage builds, and CI pipelines.",
        candidates: [
          { vendor: "x-ai", model: "grok-4.6" },
          { vendor: "mistralai", model: "devstral-2512" },
          { vendor: "qwen", model: "qwen3-coder-plus" },
          { vendor: "openai", model: "gpt-5.3-codex" },
          { vendor: "kwaipilot", model: "kat-coder-pro-v2.5" },
        ],
      },
      {
        slug: "backend-data",
        title: "Backend and data",
        role: "backend-data-implementer",
        domain: "Implements domain entities, SQL queries/migrations, ORM persistence, concurrency primitives, and transactional boundaries.",
        candidates: [
          { vendor: "x-ai", model: "grok-4.6" },
          { vendor: "qwen", model: "qwen3-coder-plus" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "openai", model: "gpt-5.3-codex" },
          { vendor: "kwaipilot", model: "kat-coder-pro-v2.5" },
        ],
      },
      {
        slug: "frontend",
        title: "Frontend",
        role: "frontend-fullstack-implementer",
        domain: "Constructs stateful UI components, routing, client cache management, responsive styles, and accessible interactions.",
        candidates: [
          { vendor: "anthropic", model: "claude-sonnet-5" },
          { vendor: "google", model: "gemini-3.8-flash" },
          { vendor: "x-ai", model: "grok-4.6" },
          { vendor: "bytedance-seed", model: "seed-2.0-code" },
          { vendor: "openai", model: "gpt-5.3-codex" },
        ],
      },
      {
        slug: "sdk-integration",
        title: "SDK integration",
        role: "sdk-integration-specialist",
        domain: "Wires external APIs, authentication flows (OAuth2/OIDC), webhook validation, cloud SDKs, and async worker queues.",
        candidates: [
          { vendor: "openai", model: "gpt-5.6-sol" },
          { vendor: "x-ai", model: "grok-4.6" },
          { vendor: "qwen", model: "qwen3-coder-plus" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "google", model: "gemini-3.8-flash" },
        ],
      },
    ],
  },
  {
    slug: "refactor-repair-regressions",
    area: "software-engineering",
    name: "Refactor and Repair Regressions",
    summary: "Codebase smell analysis → modular decomposition → surgical multi-file transforms → equivalence verification",
    stages: [
      {
        slug: "refactor-architecture",
        title: "Refactor architecture",
        role: "refactoring-architect",
        domain: "Analyzes code coupling, designs clean modular boundaries, and authors step-by-step non-breaking migration plans.",
        candidates: [
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "z-ai", model: "glm-5.3" },
          { vendor: "anthropic", model: "claude-opus-5" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "moonshotai", model: "kimi-k3" },
        ],
      },
      {
        slug: "code-transform",
        title: "Code transform",
        role: "code-transform-implementer",
        domain: "Executes surgical multi-file edits, applying design patterns while preserving comments and formatting.",
        candidates: [
          { vendor: "x-ai", model: "grok-4.6" },
          { vendor: "relace", model: "relace-apply-3" },
          { vendor: "openai", model: "gpt-5.3-codex" },
          { vendor: "morph", model: "morph-v3-large" },
          { vendor: "anthropic", model: "claude-sonnet-5" },
        ],
      },
      {
        slug: "equivalence-verification",
        title: "Equivalence verification",
        role: "semantic-equivalence-verifier",
        domain: "Critic-with-gate: reviews public contract compliance and behavioral equivalence; deterministic checks remain the fixed witness gate and are never delegated to an LLM.",
        candidates: [
          { vendor: "openai", model: "gpt-5.6-sol" },
          { vendor: "openai", model: "o3-mini-high" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "anthropic", model: "claude-opus-5" },
          { vendor: "mistralai", model: "devstral-2512" },
        ],
      },
    ],
  },
  {
    slug: "stabilize-flaky-tests",
    area: "software-engineering",
    name: "Stabilize Flaky Tests",
    summary: "Flakiness root-cause extraction → deterministic mock/async hardening",
    stages: [
      {
        slug: "flakiness-diagnosis",
        title: "Flakiness diagnosis",
        role: "concurrency-flakiness-detective",
        domain: "Untangles timing hazards, async wait conditions, shared state pollution, and unhandled promise rejections.",
        candidates: [
          { vendor: "openai", model: "o3" },
          { vendor: "deepseek", model: "deepseek-r1-0528" },
          { vendor: "google", model: "gemini-3.8-flash" },
          { vendor: "anthropic", model: "claude-opus-5" },
          { vendor: "openai", model: "gpt-6-astra" },
        ],
      },
    ],
  },
  {
    slug: "design-software-system",
    area: "software-engineering",
    name: "Design Software System",
    summary: "Architecture → database topology → threat modeling → IaC → reliability review → protocol audit",
    stages: [
      {
        slug: "distributed-architecture",
        title: "Distributed architecture",
        role: "principal-distributed-architect",
        domain: "Evaluates CAP/PACELC trade-offs, consensus protocols (Raft, Sagas), partition boundaries, and authors primary RFCs.",
        candidates: [
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "openai", model: "o3" },
          { vendor: "openai", model: "gpt-6-astra-pro" },
          { vendor: "anthropic", model: "claude-opus-5" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
        ],
      },
      {
        slug: "database-topology",
        title: "Database topology",
        role: "scalability-database-topologist",
        domain: "Designs relational/NoSQL schemas, horizontal sharding keys, caching topologies, and zero-downtime migration plans.",
        candidates: [
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "openai", model: "gpt-6-astra-pro" },
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "qwen", model: "qwen3.8-2.4t-a95b" },
          { vendor: "x-ai", model: "grok-4.6" },
        ],
      },
      {
        slug: "threat-modeling",
        title: "Threat modeling",
        role: "security-architect-threat-modeler",
        domain: "Conducts STRIDE threat assessments, reviews IAM least-privilege policies, mTLS boundaries, and zero-trust architectures.",
        candidates: [
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "openai", model: "gpt-5.6-sol" },
          { vendor: "openai", model: "gpt-6-astra-pro" },
          { vendor: "anthropic", model: "claude-opus-5" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
        ],
      },
      {
        slug: "iac-topology",
        title: "IaC topology",
        role: "iac-cloud-topology-engineer",
        domain: "Generates declarative Terraform/OpenTofu, Pulumi, Kubernetes CRDs, and VPC networking definitions.",
        candidates: [
          { vendor: "x-ai", model: "grok-4.6" },
          { vendor: "qwen", model: "qwen3-coder-plus" },
          { vendor: "openai", model: "gpt-5.3-codex" },
          { vendor: "google", model: "gemini-3.8-flash" },
          { vendor: "mistralai", model: "devstral-2512" },
        ],
      },
      {
        slug: "reliability-review",
        title: "Reliability review",
        role: "reliability-chaos-reviewer",
        domain: "Evaluates single points of failure, RPO/RTO metrics, cascading timeouts, circuit breakers, and active-active failovers.",
        candidates: [
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "openai", model: "o3" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "openai", model: "gpt-6-astra-pro" },
          { vendor: "moonshotai", model: "kimi-k3" },
        ],
      },
      {
        slug: "protocol-audit",
        title: "Protocol audit",
        role: "architecture-critic-protocol-auditor",
        domain: "Independent peer-review; challenges unvalidated assumptions, prevents architectural drift, and verifies contracts.",
        candidates: [
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "openai", model: "gpt-5.6-sol" },
          { vendor: "z-ai", model: "glm-5.3" },
          { vendor: "openai", model: "gpt-6-astra-pro" },
          { vendor: "qwen", model: "qwen3.8-max-0902" },
        ],
      },
    ],
  },
  {
    slug: "maintain-documentation",
    area: "software-engineering",
    name: "Maintain Documentation",
    summary: "Accuracy audit → documentation write → review",
    stages: [
      {
        slug: "accuracy-audit",
        title: "Accuracy audit",
        role: "documentation-accuracy-auditor",
        domain: "Read-only audit of developer and operator documentation against CLI --help outputs, source environment variables, tool schemas, and repository configuration.",
        candidates: [
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "openai", model: "gpt-5.6-sol" },
          { vendor: "qwen", model: "qwen3.8-max-0902" },
          { vendor: "z-ai", model: "glm-5.3" },
        ],
      },
      {
        slug: "documentation-write",
        title: "Documentation write",
        role: "documentation-writer",
        domain: "Authors concise, accurate developer and operator documentation with clear terminology, correct command flags, and consistent formatting without marketing drift.",
        candidates: [
          { vendor: "x-ai", model: "grok-4.6" },
          { vendor: "qwen", model: "qwen3-coder-plus" },
          { vendor: "anthropic", model: "claude-sonnet-5" },
          { vendor: "openai", model: "gpt-5.3-codex" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
        ],
      },
      {
        slug: "review",
        title: "Review",
        role: "documentation-reviewer",
        domain: "Critic-with-gate: the architecture critic verifies authority and permission wording; the CLI critic verifies command/flag accuracy; deterministic docs lint remains the fixed witness gate.",
        candidates: [
          { vendor: "anthropic", model: "claude-fable-5.1" },
          { vendor: "openai", model: "gpt-5.6-sol" },
          { vendor: "anthropic", model: "claude-opus-5" },
          { vendor: "deepseek", model: "deepseek-v4-pro-0813" },
          { vendor: "mistralai", model: "devstral-2512" },
        ],
      },
    ],
  },
];

export interface AgentBinding {
  readonly harness: string;
  readonly provider: string;
  readonly model: string;
}

export interface SkippedStage {
  readonly workflow: string;
  readonly stage: string;
  readonly role: string;
  readonly reason: string;
}

export interface GuideSetupPlan {
  readonly agents: ReadonlyMap<string, AgentBinding>;
  readonly workflows: GuideWorkflow[];
  readonly skipped: SkippedStage[];
}

export interface GuideSetupFile {
  readonly path: string;
  readonly content: string;
}

function authenticatedHarnesses(inventory: HarnessInventory): ReadonlySet<string> {
  return new Set(
    inventory.harnesses
      .filter((entry) => entry.detected && entry.authenticated === true)
      .map((entry) => entry.id),
  );
}

/**
 * Resolve a guide candidate to a dispatch binding, or undefined when no
 * candidate's harness is authenticated. Non-native vendors route through the
 * Pi OpenRouter provider (guide ids are already OpenRouter-style slugs).
 */
export function resolveCandidate(
  candidates: readonly GuideCandidate[],
  eligible: ReadonlySet<string>,
): AgentBinding | undefined {
  for (const candidate of candidates) {
    const nativeHarness = NATIVE_VENDOR_HARNESS[candidate.vendor];
    if (nativeHarness) {
      if (eligible.has(nativeHarness)) {
        return { harness: nativeHarness, provider: NATIVE_HARNESS_PROVIDERS[nativeHarness]!, model: candidate.model };
      }
      continue;
    }
    if (eligible.has("pi")) {
      return { harness: "pi", provider: "openrouter", model: `${candidate.vendor}/${candidate.model}` };
    }
  }
  return undefined;
}

/** Plan agents/workflows for the selected guide slugs without touching disk. */
export function planGuideSetup(options: {
  inventory: HarnessInventory;
  selected: readonly string[];
}): GuideSetupPlan {
  const eligible = authenticatedHarnesses(options.inventory);
  const agents = new Map<string, AgentBinding>();
  const workflows: GuideWorkflow[] = [];
  const skipped: SkippedStage[] = [];
  const wanted = new Set(options.selected);
  for (const workflow of GUIDE_WORKFLOWS) {
    if (!wanted.has(workflow.slug)) continue;
    let covered = true;
    for (const stage of workflow.stages) {
      if (agents.has(stage.role)) continue;
      const binding = resolveCandidate(stage.candidates, eligible);
      if (!binding) {
        skipped.push({
          workflow: workflow.slug,
          stage: stage.slug,
          role: stage.role,
          reason: "no guide candidate has an authenticated harness (see `kxm harness list`)",
        });
        covered = false;
        continue;
      }
      agents.set(stage.role, binding);
    }
    if (covered) workflows.push(workflow);
    else skipped.push({ workflow: workflow.slug, stage: "*", role: "-", reason: "workflow skipped: at least one stage has no eligible agent" });
  }
  return { agents, workflows, skipped };
}

const WRITER_ROLE_PATTERN = /(writer|implementer|scaffold|backend|frontend|sdk-integration|iac-cloud|code-transform|build-specialist)/;

function isWriterRole(roleSlug: string): boolean {
  return WRITER_ROLE_PATTERN.test(roleSlug);
}

function agentDocument(roleSlug: string, stage: GuideStage, binding: AgentBinding): Record<string, unknown> {
  const writer = isWriterRole(roleSlug);
  return {
    schema: "kxm.agent.v1",
    purpose: `${stage.domain} (workflow-guide ${stage.title}; candidate verification is the operator's responsibility)`,
    harness: binding.harness,
    model: { provider: binding.provider, model: binding.model },
    tools: { preset: writer ? "workspace-writer" : "read-only" },
    defaultRepositoryAccess: writer ? "none" : "read",
    repositories: { control: writer ? "write" : "read" },
    network: "provider-only",
    resultSchema: "kxm.assignment-result.v1",
  };
}

function workflowDocument(workflow: GuideWorkflow): Record<string, unknown> {
  const steps = workflow.stages.map((stage, index) => {
    const last = index === workflow.stages.length - 1;
    return {
      id: stage.slug,
      kind: "agent",
      agent: stage.role,
      maxAttempts: 2,
      on: {
        passed: last ? { target: "$terminal", terminalStatus: "completed" } : workflow.stages[index + 1]!.slug,
        failed: { target: "$terminal", terminalStatus: "failed" },
      },
    };
  });
  return {
    schema: "kxm.workflow.v1",
    description: `${workflow.name} (${workflow.area}, workflow-guide): ${workflow.summary}`,
    coordinator: "coordinator",
    limits: { maxTransitions: Math.max(4, workflow.stages.length * 4) },
    steps,
  };
}

/**
 * Render the planned KXM resource files (`.kxm/agents/*.yaml`,
 * `.kxm/workflows/*.yaml`). Pure: no disk access.
 */
export function renderGuideSetupFiles(projectRoot: string, plan: GuideSetupPlan): GuideSetupFile[] {
  const files: GuideSetupFile[] = [];
  const roleStages = new Map<string, GuideStage>();
  for (const workflow of plan.workflows) {
    for (const stage of workflow.stages) roleStages.set(stage.role, stage);
  }
  for (const [role, binding] of [...plan.agents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const stage = roleStages.get(role);
    if (!stage) continue;
    files.push({
      path: join(projectRoot, ".kxm", "agents", `${role}.yaml`),
      content: stringify(agentDocument(role, stage, binding)),
    });
  }
  for (const workflow of plan.workflows) {
    files.push({
      path: join(projectRoot, ".kxm", "workflows", `${workflow.slug}.yaml`),
      content: stringify(workflowDocument(workflow)),
    });
  }
  return files;
}

export interface WriteReport {
  readonly written: string[];
  readonly existed: string[];
}

/** Write rendered files, creating directories as needed; never overwrites. */
export function writeGuideSetupFiles(files: readonly GuideSetupFile[]): WriteReport {
  const written: string[] = [];
  const existed: string[] = [];
  for (const file of files) {
    if (existsSync(file.path)) {
      existed.push(file.path);
      continue;
    }
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, "utf8");
    written.push(file.path);
  }
  return { written, existed };
}

/** Parse a prompt answer like "1,3", "build-feature, all", or "none". */
export function parseGuideSelection(input: string, catalog: readonly GuideWorkflow[] = GUIDE_WORKFLOWS): string[] {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed === "none" || trimmed === "n" || trimmed === "no") return [];
  if (trimmed === "all") return catalog.map((workflow) => workflow.slug);
  const selected = new Set<string>();
  for (const token of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const index = Number.parseInt(token, 10);
    if (Number.isFinite(index) && index >= 1 && index <= catalog.length) {
      selected.add(catalog[index - 1]!.slug);
      continue;
    }
    const match = catalog.find((workflow) => workflow.slug === token);
    if (match) selected.add(match.slug);
  }
  return [...selected];
}
