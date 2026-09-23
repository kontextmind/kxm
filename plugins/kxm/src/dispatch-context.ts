import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { arbitrate, memoryRecordToContextItem, rolePolicy, type ArbiterOutcome } from "./arbiter.ts";
import { CONTEXT_ROLES, MAX_CONTEXT_TASK_CHARS, type ContextItem } from "./context.ts";
import { loadAuthoredMemory, type MemoryRecord } from "./memory.ts";
import { computeKxmMemoryRevision } from "./runtime-service.ts";
import { SkillLifecycle, type SkillCandidateMetadata } from "./skills.ts";

/**
 * Runtime dispatch context (Q-K).
 *
 * A Runtime-dispatched agent receives the project's authored memory (active
 * records with project or operator scope; candidates are never read) and its
 * hash-verified promoted skills, selected by the same deterministic arbiter the
 * hub uses. Delivery happens only when those files are committed and clean at
 * HEAD and still match the run's pinned memory revision; otherwise the context
 * is withheld and a `dispatch_context_*` gap says why. Only local git and the
 * project tree are read: no hub source is fetched, so dispatch stays offline.
 *
 * Loading (git, hashing, file reads) happens outside the engine's IMMEDIATE
 * transaction; assembly is pure and runs at birth.
 */

export const DISPATCH_CONTEXT_BUDGET_TOKENS = 4_000;
/** The prompt formatter renders at most this many project knowledge items. */
export const DISPATCH_CONTEXT_MAX_PROJECT_ITEMS = 5;

const GAP_NOT_LOADED = "dispatch_context_not_loaded";
const GAP_FAILED = "dispatch_context_failed";
const GAP_GIT_UNAVAILABLE = "dispatch_context_withheld:git_unavailable";
const GAP_UNCOMMITTED = "dispatch_context_withheld:uncommitted";
const GAP_DRIFT = "dispatch_context_withheld:memory_revision_drift";
const GAP_MEMORY_UNREADABLE = "dispatch_context_memory_unreadable";
const GAP_SKILLS_UNREADABLE = "dispatch_context_skills_unreadable";

/** Only the files the memory and skill loaders read. */
const DISPATCH_CONTEXT_PATHSPEC = [
  ":(glob).kxm/memory/*.md",
  ":(glob).kxm/skills/promoted/*/SKILL.md",
  ":(glob).kxm/skills/promoted/*/metadata.json",
] as const;
const GIT_STATUS_TIMEOUT_MS = 5_000;

export interface DispatchContextSources {
  readonly present: boolean;
  readonly pool: readonly ContextItem[];
  readonly promoted: readonly SkillCandidateMetadata[];
  readonly gaps: readonly string[];
  /** Authored records with agent or run scope, which dispatch cannot bind. */
  readonly skippedUnboundScopes: number;
}

export const EMPTY_DISPATCH_SOURCES: DispatchContextSources = Object.freeze({
  present: false,
  pool: Object.freeze([]),
  promoted: Object.freeze([]),
  gaps: Object.freeze([]),
  skippedUnboundScopes: 0,
});

export const NOT_LOADED_DISPATCH_SOURCES: DispatchContextSources = Object.freeze({
  present: true,
  pool: Object.freeze([]),
  promoted: Object.freeze([]),
  gaps: Object.freeze([GAP_NOT_LOADED]),
  skippedUnboundScopes: 0,
});

export interface DispatchContextAssembly {
  /** Arbitrated items to deliver, in rank order. */
  readonly items: ContextItem[];
  readonly deliveredIds: string[];
  /** Selected project items the prompt formatter would not render. */
  readonly renderDeferred: number;
  readonly role: string;
  readonly unresolvedGaps: string[];
  readonly audit?: ArbiterOutcome["audit"];
}

/** Map an agent id to a context role: an exact role, else the first role the
 * id is prefixed by (`critic-arch` is a critic), else the id itself, which the
 * arbiter's role policy falls back on. */
export function contextRoleForAgent(agentId: string): string {
  if (CONTEXT_ROLES.includes(agentId)) return agentId;
  for (const role of CONTEXT_ROLES) {
    if (agentId.startsWith(`${role}-`)) return role;
  }
  return agentId;
}

/** Cheap presence probe: a top-level markdown file in `.kxm/memory` or any
 * entry in `.kxm/skills/promoted`. No git and no hashing; a missing directory
 * or a read error counts as absent. */
export function dispatchContextPresent(projectRoot: string): boolean {
  return hasTopLevelMarkdown(join(projectRoot, ".kxm", "memory"))
    || hasAnyEntry(join(projectRoot, ".kxm", "skills", "promoted"));
}

function hasTopLevelMarkdown(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && extname(entry.name) === ".md");
  } catch {
    return false;
  }
}

function hasAnyEntry(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
}

/** Invariant 12: only committed, clean content is delivered. `--no-optional-locks`
 * keeps `.git/index.lock` free for command gates running in the same root. */
function committedGateGap(projectRoot: string): string | undefined {
  const result = spawnSync("git", [
    "--no-optional-locks",
    "-C",
    projectRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
    "--",
    ...DISPATCH_CONTEXT_PATHSPEC,
  ], {
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: GIT_STATUS_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return GAP_GIT_UNAVAILABLE;
  if (typeof result.stdout !== "string" || result.stdout.length > 0) return GAP_UNCOMMITTED;
  return undefined;
}

/** A gap names ids only. An id that is not a plain identifier (skill metadata
 * is file content) is not echoed. */
function gapId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : "invalid";
}

function withheld(gaps: readonly string[]): DispatchContextSources {
  return { present: true, pool: [], promoted: [], gaps: [...gaps], skippedUnboundScopes: 0 };
}

/** Load the dispatch pool: every file read, git check and hash happens here, so
 * callers run it outside any SQLite transaction. Total: it never throws. */
export function loadDispatchContextSources(input: {
  projectRoot: string;
  projectId: string;
  pinnedMemoryRevision: string;
}): DispatchContextSources {
  try {
    const { projectRoot, projectId, pinnedMemoryRevision } = input;
    if (!dispatchContextPresent(projectRoot)) return EMPTY_DISPATCH_SOURCES;

    const gateGap = committedGateGap(projectRoot);
    if (gateGap !== undefined) return withheld([gateGap]);
    if (computeKxmMemoryRevision({ projectRoot }) !== pinnedMemoryRevision) return withheld([GAP_DRIFT]);

    const gaps: string[] = [];
    let records: MemoryRecord[];
    try {
      records = loadAuthoredMemory(projectRoot);
    } catch {
      gaps.push(GAP_MEMORY_UNREADABLE);
      records = [];
    }

    const pool: ContextItem[] = [];
    let skippedUnboundScopes = 0;
    for (const record of records) {
      if (record.scope !== "project" && record.scope !== "operator") {
        skippedUnboundScopes += 1;
        continue;
      }
      try {
        pool.push(memoryRecordToContextItem(record, projectId));
      } catch {
        gaps.push(`dispatch_context_memory_rejected:${gapId(record.id)}`);
      }
    }

    const promoted: SkillCandidateMetadata[] = [];
    try {
      const lifecycle = new SkillLifecycle(join(projectRoot, ".kxm", "skills"));
      for (const metadata of lifecycle.list("promoted")) {
        try {
          promoted.push(lifecycle.verify("promoted", metadata.id));
        } catch {
          gaps.push(`dispatch_context_skill_unverified:${gapId(metadata.id)}`);
        }
      }
    } catch {
      gaps.push(GAP_SKILLS_UNREADABLE);
    }

    // The tree may have moved while it was read: what was read is only
    // delivered when the revision still matches the pin.
    if (computeKxmMemoryRevision({ projectRoot }) !== pinnedMemoryRevision) return withheld([...gaps, GAP_DRIFT]);

    return { present: true, pool, promoted, gaps, skippedUnboundScopes };
  } catch {
    return withheld([GAP_FAILED]);
  }
}

/** Arbitrate the loaded sources for one dispatched agent. Pure: no file I/O,
 * never throws. Delivered project items are capped at what the prompt
 * formatter renders; the overflow is reported as a gap. */
export function assembleDispatchContext(
  sources: DispatchContextSources,
  input: { projectId: string; runId: string; stepId: string; agentId: string; task: string },
): DispatchContextAssembly {
  const role = contextRoleForAgent(input.agentId);
  try {
    if (sources.pool.length === 0 && sources.promoted.length === 0) {
      return { items: [], deliveredIds: [], renderDeferred: 0, role, unresolvedGaps: [...sources.gaps] };
    }
    const task = (input.task.trim() || input.stepId).slice(0, MAX_CONTEXT_TASK_CHARS);
    const promoted = sources.promoted;
    const snapshot: Pick<SkillLifecycle, "list" | "verify"> = {
      list: (state) => (state === "promoted" ? [...promoted] : []),
      verify: (state, id) => {
        const found = state === "promoted" ? promoted.find((metadata) => metadata.id === id) : undefined;
        if (!found) throw new Error("skill is not in the verified dispatch snapshot");
        return found;
      },
    };
    const { packet, audit } = arbitrate(
      {
        project: input.projectId,
        role,
        task,
        workflowRunId: input.runId,
        stageId: input.stepId,
        budgetTokens: Math.min(rolePolicy(role).budgetTokens, DISPATCH_CONTEXT_BUDGET_TOKENS),
      },
      [...sources.pool],
      promoted.length > 0 ? { skillLifecycle: snapshot } : {},
    );

    const byId = new Map<string, ContextItem>();
    for (const section of [packet.currentState, packet.knowledge, packet.evidence, packet.episodes, packet.skills, packet.contradictions]) {
      for (const item of section) byId.set(item.id, item);
    }
    const items: ContextItem[] = [];
    let projectItems = 0;
    let renderDeferred = 0;
    for (const id of audit.selectedIds) {
      const item = byId.get(id);
      if (!item) continue;
      const projectRouted = item.project !== "_shared" && item.kind !== "state" && item.kind !== "episode" && item.kind !== "skill";
      if (projectRouted) {
        if (projectItems >= DISPATCH_CONTEXT_MAX_PROJECT_ITEMS) {
          renderDeferred += 1;
          continue;
        }
        projectItems += 1;
      }
      items.push(item);
    }
    return {
      items,
      deliveredIds: items.map((item) => item.id),
      renderDeferred,
      role,
      unresolvedGaps: [
        ...sources.gaps,
        ...packet.unresolvedGaps,
        ...(renderDeferred > 0 ? [`dispatch_context_render_deferred:${renderDeferred}`] : []),
      ],
      audit,
    };
  } catch {
    return { items: [], deliveredIds: [], renderDeferred: 0, role, unresolvedGaps: [...sources.gaps, GAP_FAILED] };
  }
}
