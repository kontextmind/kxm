import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { redactSecrets } from "./redact.ts";

/**
 * Governed skill candidate lifecycle (v0.5, issue #39).
 *
 * Runtime experience becomes a *candidate*; candidates never become promoted
 * skills without passing static/provenance review, sandbox execution, and
 * protected functional + safety evaluation. Promoted skills are version
 * controlled and immutable to run-time agents: behavior changes require a
 * new candidate/eval cycle. Skill text may inform behavior but never grants
 * tool or permission authority.
 *
 * Storage layout under the workspace root (default `.kxm/skills`):
 *   candidates/<id>/SKILL.md + metadata.json
 *   promoted/<id>/SKILL.md + metadata.json
 *   quarantined/<id>/SKILL.md + metadata.json
 *   history/<id>.jsonl   — append-only audit trail per skill lineage
 */

export const SKILL_CANDIDATE_SCHEMA = "kxm.skill-candidate.v1";
export const SKILL_EVALUATION_SCHEMA = "kxm.skill-evaluation.v1";
export const SKILL_DECISION_SCHEMA = "kxm.skill-decision.v1";

export const MAX_SKILL_NAME_CHARS = 64;
export const MAX_SKILL_CONTENT_CHARS = 32_000;
export const MAX_SKILL_EVIDENCE_REFS = 32;
export const MAX_SKILL_MODELS = 16;

export type SkillState = "candidate" | "promoted" | "quarantined" | "rejected";
export type SkillDecision = "promoted" | "quarantined" | "rejected";
export type SkillEvaluationKind = "static-review" | "sandbox" | "functional" | "safety" | "optimization";

/** Evaluation kinds that must pass before promotion. */
export const PROMOTION_REQUIRED_EVALUATIONS: readonly SkillEvaluationKind[] = [
  "static-review",
  "sandbox",
  "functional",
  "safety",
];

export interface SkillSources {
  runIds: string[];
  journalEntryIds: string[];
  evidenceReceipts: string[];
}

export interface SkillCandidateMetadata {
  schema: typeof SKILL_CANDIDATE_SCHEMA;
  id: string;
  name: string;
  description: string;
  contentSha256: string;
  version: number;
  sources: SkillSources;
  /** Explicit cross-model/cross-harness compatibility record. */
  compatibility: {
    harness: string;
    models: string[];
  };
  createdBy: string;
  createdAt: string;
  /** Prior candidate or promoted skill this candidate supersedes. */
  supersedes?: string;
}

export interface SkillEvaluationRecord {
  schema: typeof SKILL_EVALUATION_SCHEMA;
  candidateId: string;
  kind: SkillEvaluationKind;
  evaluatorVersion: string;
  passed: boolean;
  score?: number;
  details?: string;
  evaluatedAt: string;
}

export interface SkillDecisionRecord {
  schema: typeof SKILL_DECISION_SCHEMA;
  candidateId: string;
  decision: SkillDecision;
  decidedBy: string;
  reason: string;
  evidenceRefs: string[];
  decidedAt: string;
}

export interface SkillHistoryEvent {
  schema: "kxm.skill-history-event.v1";
  event: string;
  by?: string;
  supersedes?: string;
  at: string;
}

export type SkillHistoryRecord = SkillEvaluationRecord | SkillDecisionRecord | SkillHistoryEvent;

export class SkillLifecycleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillLifecycleError";
    this.code = code;
  }
}

export function skillContentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Deterministic skill ID: slug + content hash prefix. Changed content means
 * a new candidate; identical content is idempotent. */
export function skillIdFor(name: string, contentSha256: string): string {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!slug) throw new SkillLifecycleError("invalid_skill_name", "skill name must contain alphanumeric characters");
  return `${slug}.${contentSha256.slice(0, 12)}`;
}

export function parseSkillFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content };
  }
  const rawFm = match[1];
  const rawBody = match[2];
  if (rawFm === undefined || rawBody === undefined) {
    return { frontmatter: null, body: content };
  }
  try {
    const parsed = parse(rawFm);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body: rawBody };
    }
  } catch {
    // Malformed yaml frontmatter
  }
  return { frontmatter: null, body: content };
}

export function ensureSkillFrontmatter(content: string, name: string, description: string): string {
  const parsed = parseSkillFrontmatter(content);
  if (parsed.frontmatter) {
    const fmName = typeof parsed.frontmatter.name === "string" && parsed.frontmatter.name.trim()
      ? parsed.frontmatter.name.trim()
      : name;
    const fmDesc = typeof parsed.frontmatter.description === "string" && parsed.frontmatter.description.trim()
      ? parsed.frontmatter.description.trim()
      : (description || `Governed skill for ${fmName}`);
    const rest = parsed.body.replace(/^(\r?\n)+/, "");
    return `---\nname: ${fmName}\ndescription: ${fmDesc}\n---\n\n${rest}`;
  }
  const desc = description || `Governed skill for ${name}`;
  const rest = content.replace(/^(\r?\n)+/, "");
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${rest}`;
}

export function createUnifiedPatch(relativePath: string, content: string): string {
  const lines = content.split("\n");
  const count = lines.length;
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${count} @@`,
  ];
  const body = lines.map((l) => `+${l}`);
  return [...header, ...body, ""].join("\n");
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  content: string;
  sources: Partial<SkillSources>;
  compatibility: { harness: string; models: string[] };
  createdBy: string;
  supersedes?: string;
  version?: number;
}

export interface SkillLifecycleOptions {
  /** Opt-in hook for skillopt/WikiSkill-style optimization behind protected
   * evals. When unset, `optimization` evaluations are rejected. */
  allowOptimizationEvals?: boolean;
  now?: () => string;
  /** Validate and record every change in `planned` without touching disk. */
  dryRun?: boolean;
}

export class SkillLifecycle {
  private readonly root: string;
  private readonly now: () => string;
  private readonly allowOptimizationEvals: boolean;
  private readonly dryRun: boolean;
  /** What a `dryRun` lifecycle would have written or moved, in order. */
  readonly planned: Array<{ action: "write" | "move"; target: string }> = [];

  constructor(root: string, options: SkillLifecycleOptions = {}) {
    this.root = root;
    this.now = options.now ?? (() => new Date().toISOString());
    this.allowOptimizationEvals = options.allowOptimizationEvals === true;
    this.dryRun = options.dryRun === true;
  }

  private write(file: string, content: string): void {
    if (this.dryRun) {
      this.planned.push({ action: "write", target: file });
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  private dir(state: SkillState): string {
    return join(this.root, state === "candidate" ? "candidates" : `${state}s`.replace("rejecteds", "rejected").replace("promoteds", "promoted"));
  }

  private historyFile(id: string): string {
    return join(this.root, "history", `${id}.jsonl`);
  }

  private paths(state: SkillState, id: string): { dir: string; metadata: string; skill: string } {
    const dir = join(this.dir(state), id);
    return { dir, metadata: join(dir, "metadata.json"), skill: join(dir, "SKILL.md") };
  }

  private appendHistory(id: string, record: unknown): void {
    const line = `${JSON.stringify(record)}\n`;
    if (existsSync(this.historyFile(id))) {
      // Bound the history file: append within the audit limit.
      const existing = readFileSync(this.historyFile(id), "utf8");
      const lines = existing.split("\n").filter((entry) => entry.trim());
      this.write(this.historyFile(id), [...lines.slice(-499), line.trim()].join("\n") + "\n");
    } else {
      this.write(this.historyFile(id), line);
    }
  }

  history(id: string): SkillHistoryRecord[] {
    const file = this.historyFile(id);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SkillHistoryRecord);
  }

  private readMetadata(state: SkillState, id: string): SkillCandidateMetadata {
    const { metadata } = this.paths(state, id);
    if (!existsSync(metadata)) {
      throw new SkillLifecycleError("skill_not_found", `skill ${id} not found in ${state}`);
    }
    return JSON.parse(readFileSync(metadata, "utf8")) as SkillCandidateMetadata;
  }

  private move(from: SkillState, to: SkillState, id: string): void {
    const fromDir = join(this.dir(from), id);
    const toDir = join(this.dir(to), id);
    if (!existsSync(fromDir)) {
      throw new SkillLifecycleError("skill_not_found", `skill ${id} not found in ${from}`);
    }
    if (this.dryRun) {
      this.planned.push({ action: "move", target: `${fromDir} -> ${toDir}` });
      return;
    }
    mkdirSync(this.dir(to), { recursive: true });
    if (existsSync(toDir)) rmSync(toDir, { recursive: true, force: true });
    renameSync(fromDir, toDir);
  }

  /** Submit a new skill candidate. Content is redacted of secret material at
   * creation; the ID is derived from name + content hash. */
  create(input: CreateSkillInput): SkillCandidateMetadata {
    const name = input.name?.trim();
    if (!name || name.length > MAX_SKILL_NAME_CHARS) {
      throw new SkillLifecycleError("invalid_skill_name", `skill name must be 1-${MAX_SKILL_NAME_CHARS} characters`);
    }
    const rawContent = redactSecrets(input.content ?? "");
    if (!rawContent.trim() || rawContent.length > MAX_SKILL_CONTENT_CHARS) {
      throw new SkillLifecycleError("invalid_skill_content", `skill content must be 1-${MAX_SKILL_CONTENT_CHARS} characters`);
    }
    const rawDesc = redactSecrets(input.description?.trim() ?? "");
    const content = ensureSkillFrontmatter(rawContent, name, rawDesc);
    if (content.length > MAX_SKILL_CONTENT_CHARS) {
      throw new SkillLifecycleError("invalid_skill_content", `skill content must be 1-${MAX_SKILL_CONTENT_CHARS} characters`);
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    const description = (typeof frontmatter?.description === "string" && frontmatter.description.trim())
      ? frontmatter.description.trim()
      : (rawDesc || `Governed skill for ${name}`);
    const sources: SkillSources = {
      runIds: boundedList(input.sources?.runIds, "runIds"),
      journalEntryIds: boundedList(input.sources?.journalEntryIds, "journalEntryIds"),
      evidenceReceipts: boundedList(input.sources?.evidenceReceipts, "evidenceReceipts"),
    };
    if (sources.runIds.length === 0 && sources.journalEntryIds.length === 0 && sources.evidenceReceipts.length === 0) {
      throw new SkillLifecycleError(
        "skill_sources_required",
        "a skill candidate must reference at least one source run, journal entry, or evidence receipt",
      );
    }
    const createdBy = input.createdBy?.trim();
    if (!createdBy) throw new SkillLifecycleError("invalid_skill_author", "createdBy is required");
    const models = boundedList(input.compatibility?.models, "compatibility.models");
    if (models.length === 0 || models.length > MAX_SKILL_MODELS) {
      throw new SkillLifecycleError("invalid_skill_compatibility", `compatibility.models must list 1-${MAX_SKILL_MODELS} models`);
    }
    const harness = input.compatibility?.harness?.trim();
    if (!harness) throw new SkillLifecycleError("invalid_skill_compatibility", "compatibility.harness is required");

    const contentSha256 = skillContentSha256(content);
    const id = skillIdFor(name, contentSha256);
    const { metadata, skill } = this.paths("candidate", id);
    if (existsSync(metadata)) {
      throw new SkillLifecycleError(
        "skill_candidate_exists",
        `identical candidate ${id} already exists; changed behavior requires changed content`,
      );
    }
    const record: SkillCandidateMetadata = {
      schema: SKILL_CANDIDATE_SCHEMA,
      id,
      name,
      description,
      contentSha256,
      version: input.version ?? 1,
      sources,
      compatibility: { harness, models },
      createdBy,
      createdAt: this.now(),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    this.write(skill, content);
    this.write(metadata, `${JSON.stringify(record, null, 2)}\n`);
    this.appendHistory(id, { schema: "kxm.skill-history-event.v1", event: "candidate_created", by: createdBy, supersedes: input.supersedes, at: record.createdAt });
    return record;
  }

  /** Record a protected evaluation. A failed functional or safety evaluation
   * deterministically quarantines the candidate. */
  evaluate(candidateId: string, input: {
    kind: SkillEvaluationKind;
    evaluatorVersion: string;
    passed: boolean;
    score?: number;
    details?: string;
    evaluatedBy?: string;
  }): { evaluation: SkillEvaluationRecord; quarantined: boolean } {
    if (input.kind === "optimization" && !this.allowOptimizationEvals) {
      throw new SkillLifecycleError(
        "skill_optimization_disabled",
        "optimization evaluations are disabled; enable them explicitly behind protected evals",
      );
    }
    const metadata = this.readMetadata("candidate", candidateId);
    const evaluatorVersion = input.evaluatorVersion?.trim();
    if (!evaluatorVersion) throw new SkillLifecycleError("invalid_skill_evaluation", "evaluatorVersion is required");
    const evaluation: SkillEvaluationRecord = {
      schema: SKILL_EVALUATION_SCHEMA,
      candidateId,
      kind: input.kind,
      evaluatorVersion,
      passed: input.passed === true,
      ...(input.score !== undefined ? { score: input.score } : {}),
      ...(input.details ? { details: redactSecrets(input.details.slice(0, 2_000)) } : {}),
      evaluatedAt: this.now(),
    };
    this.appendHistory(candidateId, evaluation);
    let quarantined = false;
    if (!evaluation.passed && (input.kind === "functional" || input.kind === "safety")) {
      // A functional regression or safety failure quarantines automatically:
      // the evaluator records the decision, a human may later reject fully.
      const decision: SkillDecisionRecord = {
        schema: SKILL_DECISION_SCHEMA,
        candidateId,
        decision: "quarantined",
        decidedBy: input.evaluatedBy?.trim() || `evaluator:${evaluatorVersion}`,
        reason: `automatic quarantine: ${input.kind} evaluation failed (${evaluatorVersion})`,
        evidenceRefs: [`evaluation:${input.kind}:${evaluatorVersion}`],
        decidedAt: this.now(),
      };
      this.move("candidate", "quarantined", candidateId);
      this.appendHistory(candidateId, decision);
      quarantined = true;
    }
    return { evaluation, quarantined };
  }

  private evaluationsFor(candidateId: string): SkillEvaluationRecord[] {
    return this.history(candidateId).filter(
      (record): record is SkillEvaluationRecord =>
        (record as SkillEvaluationRecord).schema === SKILL_EVALUATION_SCHEMA,
    );
  }

  /** Promote a candidate that passed every protected evaluation. The
   * promoter must differ from the author, cite durable evidence, and the
   * promoted content is hash-pinned and immutable. Emits a unified diff patch
   * instead of moving the candidate directory. */
  promote(candidateId: string, decision: {
    decidedBy: string;
    reason: string;
    evidenceRefs: string[];
  }): SkillCandidateMetadata & { patch: string; patchPath: string } {
    const metadata = this.readMetadata("candidate", candidateId);
    const decidedBy = decision.decidedBy?.trim();
    if (!decidedBy) throw new SkillLifecycleError("invalid_skill_decision", "decidedBy is required");
    if (decidedBy === metadata.createdBy) {
      throw new SkillLifecycleError("skill_promotion_invalid", "the author of a skill candidate cannot promote it");
    }
    const evidenceRefs = boundedList(decision.evidenceRefs, "evidenceRefs");
    if (evidenceRefs.length === 0) {
      throw new SkillLifecycleError("skill_promotion_invalid", "promotion requires durable evidence references");
    }
    const evaluations = this.evaluationsFor(candidateId);
    const missing: string[] = [];
    for (const kind of PROMOTION_REQUIRED_EVALUATIONS) {
      const latest = [...evaluations].reverse().find((record) => record.kind === kind);
      if (!latest || !latest.passed) missing.push(kind);
    }
    if (missing.length > 0) {
      throw new SkillLifecycleError(
        "skill_evaluations_incomplete",
        `promotion requires passing ${missing.join(", ")} evaluations`,
      );
    }
    // Integrity check before promotion: content on disk matches the hash.
    this.verify("candidate", candidateId);
    const record: SkillDecisionRecord = {
      schema: SKILL_DECISION_SCHEMA,
      candidateId,
      decision: "promoted",
      decidedBy,
      reason: decision.reason?.trim() || "passed protected evaluation",
      evidenceRefs,
      decidedAt: this.now(),
    };

    // Instead of moving directory, write promoted directory and generate patch
    const candidatePaths = this.paths("candidate", candidateId);
    const promotedPaths = this.paths("promoted", candidateId);

    const skillContent = readFileSync(candidatePaths.skill, "utf8");
    const metadataContent = readFileSync(candidatePaths.metadata, "utf8");
    this.write(promotedPaths.skill, skillContent);
    this.write(promotedPaths.metadata, metadataContent);

    const patchPath = join(this.root, "patches", `${candidateId}.patch`);
    const relSkillPath = `.kxm/skills/promoted/${candidateId}/SKILL.md`;
    const relMetaPath = `.kxm/skills/promoted/${candidateId}/metadata.json`;
    const patch = `${createUnifiedPatch(relSkillPath, skillContent)}${createUnifiedPatch(relMetaPath, metadataContent)}`;
    this.write(patchPath, patch);

    this.appendHistory(candidateId, record);
    return { ...metadata, patch, patchPath };
  }

  reject(candidateId: string, decision: { decidedBy: string; reason: string }): SkillCandidateMetadata {
    const metadata = this.readMetadata("candidate", candidateId);
    const record: SkillDecisionRecord = {
      schema: SKILL_DECISION_SCHEMA,
      candidateId,
      decision: "rejected",
      decidedBy: decision.decidedBy?.trim() || "kxm-admin",
      reason: decision.reason?.trim() || "rejected",
      evidenceRefs: [],
      decidedAt: this.now(),
    };
    // Rejected candidates remain in history for future learning; the
    // candidate directory is removed and its full lineage stays queryable.
    this.move("candidate", "rejected", candidateId);
    this.appendHistory(candidateId, record);
    return metadata;
  }

  /** Verify content integrity of a stored skill (any state). Detects
   * out-of-band edits to promoted skills and verifies standard YAML frontmatter. */
  verify(state: SkillState, id: string): SkillCandidateMetadata {
    const metadata = this.readMetadata(state, id);
    const { skill } = this.paths(state, id);
    const content = readFileSync(skill, "utf8");
    if (skillContentSha256(content) !== metadata.contentSha256) {
      throw new SkillLifecycleError(
        "skill_integrity_violation",
        `skill ${id} content does not match its pinned hash; promoted skills are immutable and require a new candidate/eval cycle`,
      );
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    if (
      !frontmatter ||
      typeof frontmatter.name !== "string" ||
      !frontmatter.name.trim() ||
      typeof frontmatter.description !== "string" ||
      !frontmatter.description.trim()
    ) {
      throw new SkillLifecycleError(
        "invalid_skill_frontmatter",
        `skill ${id} must contain valid YAML frontmatter with 'name' and 'description'`,
      );
    }
    return metadata;
  }

  list(state: SkillState): SkillCandidateMetadata[] {
    const dir = this.dir(state);
    if (!existsSync(dir)) return [];
    const ids = readdirSorted(dir);
    return ids
      .map((id) => {
        try {
          return this.readMetadata(state, id);
        } catch {
          return undefined;
        }
      })
      .filter((metadata): metadata is SkillCandidateMetadata => metadata !== undefined);
  }

  read(state: SkillState, id: string): { metadata: SkillCandidateMetadata; content: string } {
    const metadata = this.readMetadata(state, id);
    const { skill } = this.paths(state, id);
    return { metadata, content: readFileSync(skill, "utf8") };
  }
}

function boundedList(value: string[] | undefined, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SkillLifecycleError("invalid_skill_input", `${field} must be an array of strings`);
  }
  const refs = value.map((ref) => String(ref).trim()).filter((ref) => ref.length > 0);
  if (refs.length > MAX_SKILL_EVIDENCE_REFS) {
    throw new SkillLifecycleError("invalid_skill_input", `${field} exceeds ${MAX_SKILL_EVIDENCE_REFS} references`);
  }
  return [...new Set(refs)];
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => statSync(join(dir, entry)).isDirectory())
    .sort();
}
