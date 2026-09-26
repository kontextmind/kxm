import { BUILTIN_HARNESS_IDS, oneShotWriterArgs, type HarnessStatus } from "./harness.ts";
import { WORKFLOW_TEMPLATES } from "./workflow-manager.ts";

export interface RoleSpec {
  agent: string;
  harness: string;
  role: string;
}

export type SuggestionExecution = {
  supported: true;
  prerequisites: string[];
  shell: "powershell" | "posix";
  createCommand: string;
  driveCommand: string;
  statusCommand: string;
  receiptCommand: string;
} | {
  supported: false;
  error: "harness_unavailable" | "live_write_unsupported" | "workflow_already_exists";
  reason: string;
  nextSteps: string[];
};

export interface SuggestionResult {
  workflowId: string;
  template: string;
  area: string;
  confidence: number;
  reasons: string[];
  suggestedSkills: string[];
  roles: RoleSpec[];
  /** Installs a definition; it does not create or execute a run. */
  suggestedCommand: string;
  execution: SuggestionExecution;
}

interface WorkflowPattern {
  id: string;
  template: string;
  area: string;
  keywords: string[];
  skills: string[];
}

const WORKFLOW_PATTERNS: WorkflowPattern[] = [
  {
    id: "bug-fix",
    template: "implement-and-verify",
    area: "software-engineering",
    keywords: ["fix", "bug", "flaky", "failure", "timeout", "error", "repro", "crash", "broken", "hang"],
    skills: ["kxm-workflow", "kxm-runs", "kxm-context-memory"],
  },
  {
    id: "feature-implementation",
    template: "implement-and-verify",
    area: "software-engineering",
    keywords: ["feature", "implement", "add", "build", "create", "develop", "support", "endpoint", "ui", "tui"],
    skills: ["kxm-workflow", "kxm-peer", "kxm-context-memory"],
  },
  {
    id: "refactoring",
    template: "dual-critic-review",
    area: "software-engineering",
    keywords: ["refactor", "cleanup", "reorganize", "modularize", "deduplicate", "split", "simplify", "deprecate"],
    skills: ["kxm-workflow", "kxm-runs"],
  },
  {
    id: "vulnerability-remediation",
    template: "dual-critic-review",
    area: "security-reliability",
    keywords: ["cve", "vulnerability", "security", "exploit", "sanitize", "leak", "secret", "injection", "redact", "auth"],
    skills: ["kxm-workflow", "kxm-definitions"],
  },
  {
    id: "reliability-hardening",
    template: "dual-critic-review",
    area: "security-reliability",
    keywords: ["idempotency", "retry", "circuit-breaker", "cas", "lock", "concurrency", "deadlock", "race", "crash-recovery"],
    skills: ["kxm-workflow", "kxm-peer"],
  },
  {
    id: "pipeline-migration",
    template: "implement-and-verify",
    area: "data-analytics",
    keywords: ["database", "sqlite", "migration", "pipeline", "schema", "transform", "table", "wal", "foreign", "cascading"],
    skills: ["kxm-runs", "kxm-context-memory"],
  },
  {
    id: "architecture-spike",
    template: "spec-and-plan",
    area: "research-strategy",
    keywords: ["spike", "investigate", "prototype", "research", "feasibility", "benchmark", "explore", "evaluate"],
    skills: ["kxm-session", "kxm-context-memory", "kxm-routing-improve"],
  },
];

type TemplateStep = { id: string; kind: string; agent?: string; repositories?: Record<string, string> };
type SuggestionHarness = Pick<HarnessStatus, "id" | "detected" | "authenticated" | "dispatch">;

export function suggestWorkflowAndRoles(
  prompt: string,
  options: { availableHarnesses?: readonly SuggestionHarness[] | undefined } = {},
): SuggestionResult {
  const normalized = prompt.toLowerCase();
  const words = normalized.split(/\W+/).filter(Boolean);
  const claudeOnly = /\bclaude(?:\s+code)?(?:[\s-]+only|\s+exclusively)\b|\b(?:only|exclusively)(?:\s+(?:use|using|with|via))?\s+claude(?:\s+code)?\b/i.test(prompt);
  let bestPattern: WorkflowPattern = WORKFLOW_PATTERNS[1]!;
  let bestScore = 0;
  const reasons: string[] = [];

  for (const pattern of WORKFLOW_PATTERNS) {
    const matchedWords = pattern.keywords.filter((keyword) => words.includes(keyword) || normalized.includes(keyword));
    if (matchedWords.length > bestScore) {
      bestScore = matchedWords.length;
      bestPattern = pattern;
      reasons.length = 0;
      reasons.push(`Matched keywords: ${matchedWords.join(", ")}`);
    }
  }
  if (bestScore === 0) reasons.push("Default fallback: general feature implementation workflow");
  if (claudeOnly) reasons.push("Explicit Claude-only constraint; other harnesses are excluded");

  const template = WORKFLOW_TEMPLATES[bestPattern.template]!;
  const steps = template.steps as TemplateStep[];
  const base = {
    workflowId: bestPattern.id,
    template: bestPattern.template,
    area: bestPattern.area,
    confidence: bestScore > 0 ? Math.min(1, 0.5 + bestScore * 0.15) : 0.5,
    reasons,
    suggestedSkills: bestPattern.skills,
    suggestedCommand: `kxm workflow add ${bestPattern.id} --template ${bestPattern.template}`,
  };
  const writeStep = steps.find((step) => step.kind === "agent" && Object.values(step.repositories ?? {}).includes("write"));

  const available = (options.availableHarnesses ?? []).filter((entry) =>
    BUILTIN_HARNESS_IDS.includes(entry.id) && entry.detected && entry.authenticated === true
    && entry.dispatch?.supported === true && entry.dispatch.status === "yes"
    && (!claudeOnly || entry.id === "claude"));
  const selected = available.find((entry) => entry.id === "claude") ?? available[0];
  if (!selected) {
    const relevant = (options.availableHarnesses ?? []).filter((entry) => !claudeOnly || entry.id === "claude");
    const detail = relevant.map((entry) => `${entry.id}: ${entry.dispatch?.reason ?? (!entry.detected ? "not_detected" : entry.authenticated !== true ? "authentication_unverified" : "dispatch_unavailable")}`).join("; ");
    return {
      ...base,
      roles: [],
      execution: {
        supported: false,
        error: "harness_unavailable",
        reason: `${claudeOnly ? "Claude-only execution requires Claude Code" : "Execution requires a supported harness"} detected, authenticated, and ready for dispatch. ${detail || "No verified harness inventory is available."}`,
        nextSteps: claudeOnly
          ? ["Install Claude Code if missing, authenticate with claude auth login, then confirm claude auth status and kxm harness list. Other harnesses will not be substituted."]
          : ["Install and authenticate a supported harness, then run kxm harness list to check detection, authentication, and dispatch readiness. Pi requires a configured model/provider auth context."],
      },
    };
  }

  if (writeStep && !oneShotWriterArgs(selected.id)) {
    return {
      ...base,
      roles: [],
      execution: {
        supported: false,
        error: "live_write_unsupported",
        reason: `${bestPattern.template} requires repository writes at step ${writeStep.id}, but the selected ${selected.id} harness has no audited live writer profile. No other harness will be substituted.`,
        nextSteps: [
          `Run the implementation directly in ${claudeOnly ? "Claude Code" : selected.id} in the target worktree, and run the repository's actual verification command.`,
          `For read-only KXM planning, try kxm suggest "Investigate an architecture spike${claudeOnly ? " using Claude only" : ""}"; the shipped spec-and-plan template does not implement changes.`,
          "Installing a definition or creating a run does not execute it. Simulation is not evidence of a bug fix or workflow completion.",
        ],
      },
    };
  }

  const roles: RoleSpec[] = [];
  for (const step of steps) {
    if (!step.agent) continue;
    const role = roles.find((entry) => entry.agent === step.agent);
    if (role) role.role += `, ${step.id}`;
    else roles.push({ agent: step.agent, harness: selected.id, role: step.id });
  }
  const shell = process.platform === "win32" ? "powershell" : "posix";
  const quotedPrompt = shell === "powershell"
    ? `'${prompt.replace(/['\u2018-\u201b]/g, "$&$&")}'`
    : `'${prompt.replace(/'/g, "'\\''")}'`;
  return {
    ...base,
    roles,
    execution: {
      supported: true,
      prerequisites: [
        "Run kxm init in the target repository if needed, then install the exact template with the suggested command. If that workflow ID already exists, stop and review it; the commands below apply only to a newly installed template, not an existing definition with potentially different agents or permissions.",
        ...roles.map((role) => `Set role on .kxm/agents/${role.agent}.yaml to a role whose roster names an admitted route for harness ${role.harness}. Admit that route's selector in .kxm/routes.yaml and ensure it is not disabled; this recommendation does not choose a model or change routing.`),
        ...(writeStep ? [
          `Keep each writer step at assignments.maximum: 1 and set limits.maxConcurrentRuns: 1 in .kxm/project.yaml; the live ${selected.id} writer profile requires a lone writer in the checkout.`,
          `The writer role roster must name a route whose harness is ${selected.id}, whose status is admitted, and whose permissions contain edit.`,
          "Configure the test gate in .kxm/gates.yaml with kind: command and argv for this repository's actual verification command. A scaffold/example command or simulation is not evidence that the implementation works.",
        ] : []),
        `Validate the installed workflow with kxm gate validate --file .kxm/workflows/${bestPattern.id}.yaml and the project configuration with kxm init --dry-run before creating a run.`,
      ],
      shell,
      createCommand: `kxm run ${bestPattern.id} -- ${quotedPrompt}`,
      driveCommand: "kxm runs drive <runId> --wait",
      statusCommand: "kxm runs status <runId>",
      receiptCommand: "kxm runs receipt <runId>",
    },
  };
}
