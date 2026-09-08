export interface RoleSpec {
  harness: string;
  model: string;
  role: string;
}

export interface SuggestionResult {
  workflowId: string;
  area: string;
  confidence: number;
  reasons: string[];
  suggestedSkills: string[];
  roles: {
    planner: RoleSpec;
    writer: RoleSpec;
    critics: RoleSpec[];
    verifier: { kind: "witness"; command: string };
  };
  suggestedCommand: string;
}

interface WorkflowPattern {
  id: string;
  area: string;
  keywords: string[];
  skills: string[];
  defaultCommand: (prompt: string) => string;
}

const WORKFLOW_PATTERNS: WorkflowPattern[] = [
  {
    id: "software-engineering/bug-fix",
    area: "software-engineering",
    keywords: ["fix", "bug", "flaky", "failure", "timeout", "error", "repro", "crash", "broken", "hang"],
    skills: ["troubleshooting", "memory-leak-debugging"],
    defaultCommand: (p) => `kxm run software-engineering/bug-fix "${p}"`,
  },
  {
    id: "software-engineering/feature-implementation",
    area: "software-engineering",
    keywords: ["feature", "implement", "add", "build", "create", "develop", "support", "endpoint", "ui", "tui"],
    skills: ["modern-web-guidance", "kxm"],
    defaultCommand: (p) => `kxm run software-engineering/feature-implementation "${p}"`,
  },
  {
    id: "software-engineering/refactoring",
    area: "software-engineering",
    keywords: ["refactor", "cleanup", "reorganize", "modularize", "deduplicate", "split", "simplify", "deprecate"],
    skills: ["kxm"],
    defaultCommand: (p) => `kxm run software-engineering/refactoring "${p}"`,
  },
  {
    id: "security-reliability/vulnerability-remediation",
    area: "security-reliability",
    keywords: ["cve", "vulnerability", "security", "exploit", "sanitize", "leak", "secret", "injection", "redact", "auth"],
    skills: ["kxm"],
    defaultCommand: (p) => `kxm run security-reliability/vulnerability-remediation "${p}"`,
  },
  {
    id: "security-reliability/reliability-hardening",
    area: "security-reliability",
    keywords: ["idempotency", "retry", "circuit-breaker", "cas", "lock", "concurrency", "deadlock", "race", "crash-recovery"],
    skills: ["kxm"],
    defaultCommand: (p) => `kxm run security-reliability/reliability-hardening "${p}"`,
  },
  {
    id: "data-analytics/pipeline-migration",
    area: "data-analytics",
    keywords: ["database", "sqlite", "migration", "pipeline", "schema", "transform", "table", "wal", "foreign", "cascading"],
    skills: ["kxm"],
    defaultCommand: (p) => `kxm run data-analytics/pipeline-migration "${p}"`,
  },
  {
    id: "research-strategy/architecture-spike",
    area: "research-strategy",
    keywords: ["spike", "investigate", "prototype", "research", "feasibility", "benchmark", "explore", "evaluate"],
    skills: ["kxm-session"],
    defaultCommand: (p) => `kxm run research-strategy/architecture-spike "${p}"`,
  },
];

export function suggestWorkflowAndRoles(
  prompt: string,
  options: {
    availableHarnesses?: Array<{ harness: string; auth?: string | undefined }> | undefined;
  } = {},
): SuggestionResult {
  const normalized = prompt.toLowerCase();
  const words = normalized.split(/\W+/).filter(Boolean);

  let bestPattern: WorkflowPattern = WORKFLOW_PATTERNS[0]!;
  let bestScore = -1;
  const matchedReasons: string[] = [];

  for (const pattern of WORKFLOW_PATTERNS) {
    let score = 0;
    const matchedWords: string[] = [];
    for (const keyword of pattern.keywords) {
      if (words.includes(keyword) || normalized.includes(keyword)) {
        score += 1;
        matchedWords.push(keyword);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestPattern = pattern;
      matchedReasons.length = 0;
      matchedReasons.push(`Matched keywords: ${matchedWords.join(", ")}`);
    }
  }

  if (bestScore <= 0) {
    // Default fallback to feature-implementation
    bestPattern = WORKFLOW_PATTERNS[1]!;
    matchedReasons.push("Default fallback: general feature implementation workflow");
  }

  // Determine active harnesses
  const activeHarnesses = new Set(
    (options.availableHarnesses ?? [])
      .filter((h) => h.auth === "active" || h.auth === "ready" || h.auth === "configured")
      .map((h) => h.harness.toLowerCase()),
  );

  // If none specified or active, assume standard default rotation
  const hasClaude = activeHarnesses.size === 0 || activeHarnesses.has("claude");
  const hasGrok = activeHarnesses.size === 0 || activeHarnesses.has("grok");
  const hasCodex = activeHarnesses.size === 0 || activeHarnesses.has("codex");

  // Planner
  const planner: RoleSpec = hasClaude
    ? { harness: "claude", model: "fable", role: "planner" }
    : { harness: "codex", model: "gpt-5.6-sol", role: "planner" };

  // Writer (Starting rotation: Grok 4.6 headless)
  const writer: RoleSpec = hasGrok
    ? { harness: "grok", model: "grok-4.6", role: "writer" }
    : (activeHarnesses.has("agy")
      ? { harness: "agy", model: "gemini-2.5-pro", role: "writer" }
      : { harness: "pi", model: "qwen/qwen3-coder-plus", role: "writer" });

  // Critics (Vendor independent: Fable Arch + Codex CLI)
  const critics: RoleSpec[] = [
    { harness: "claude", model: "fable", role: "reviewer-arch" },
    { harness: "codex", model: "gpt-5.6-sol", role: "reviewer-cli" },
  ];

  return {
    workflowId: bestPattern.id,
    area: bestPattern.area,
    confidence: bestScore > 0 ? Math.min(1, 0.5 + bestScore * 0.15) : 0.5,
    reasons: matchedReasons,
    suggestedSkills: bestPattern.skills,
    roles: {
      planner,
      writer,
      critics,
      verifier: { kind: "witness", command: "npm run verify" },
    },
    suggestedCommand: bestPattern.defaultCommand(prompt.replace(/"/g, '\\"')),
  };
}
