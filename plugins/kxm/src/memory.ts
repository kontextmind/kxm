import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { redactSecrets } from "./redact.ts";

export const MEMORY_SCHEMA = "kxm.memory.v1" as const;
export const MEMORY_BRIEF_SCHEMA = "kxm.memory-brief.v1" as const;
export const MEMORY_MARKER_START = "<!-- kxm:memory:start -->";
export const MEMORY_MARKER_END = "<!-- kxm:memory:end -->";

export type MemoryScope = "agent" | "project" | "run" | "operator";
export type MemoryAuthority = "instruction" | "evidence" | "promoted";
export type MemoryConfidence = "verified" | "probable" | "uncertain";
export type MemoryLifecycle = "active" | "deprecated" | "superseded";

const VALID_SCOPES = new Set<MemoryScope>(["agent", "project", "run", "operator"]);
const VALID_AUTHORITIES = new Set<MemoryAuthority>(["instruction", "evidence", "promoted"]);
const VALID_CONFIDENCES = new Set<MemoryConfidence>(["verified", "probable", "uncertain"]);
const VALID_LIFECYCLES = new Set<MemoryLifecycle>(["active", "deprecated", "superseded"]);

const BANNED_CONTROL_PLANE_FIELDS = new Set([
  "permissions",
  "tools",
  "allow",
  "deny",
  "grants",
  "approval",
  "policy",
  "scopes",
  "credentials",
  "secrets",
  "token",
  "apiKey",
  "password",
]);

export interface MemoryProvenance {
  sourceType: string;
  sourceRef?: string;
  runId?: string;
  timestamp?: string;
}

export interface MemoryRecord {
  schema: typeof MEMORY_SCHEMA;
  id: string;
  scope: MemoryScope;
  kind: string;
  summary: string;
  provenance: MemoryProvenance;
  authority: MemoryAuthority;
  confidence: MemoryConfidence;
  lifecycle: MemoryLifecycle;
  evidenceRefs: string[];
  body?: string;
}

export interface MemoryBrief {
  schema: typeof MEMORY_BRIEF_SCHEMA;
  generatedAt: string;
  count: number;
  facts: MemoryRecord[];
}

function parseFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("memory file must contain YAML frontmatter enclosed in '---'");
  }
  return { frontmatter: match[1] ?? "", body: match[2]?.trim() ?? "" };
}

export function parseMemoryRecord(raw: string, filename = "memory.md"): MemoryRecord {
  const { frontmatter, body } = parseFrontmatter(raw);
  const data = parse(frontmatter) as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`invalid YAML frontmatter in ${filename}`);
  }

  // 1. Control-plane rejection
  for (const field of BANNED_CONTROL_PLANE_FIELDS) {
    if (field in data) {
      throw new Error(`memory record ${filename} may not carry control-plane field '${field}'`);
    }
  }

  // 2. Schema check
  if (data.schema !== MEMORY_SCHEMA) {
    throw new Error(`memory record ${filename} has unsupported schema: expected ${MEMORY_SCHEMA}, got ${String(data.schema)}`);
  }

  // 3. ID validation
  const id = typeof data.id === "string" ? data.id.trim() : "";
  if (!id || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i.test(id)) {
    throw new Error(`memory record ${filename} has invalid id: ${String(data.id)}`);
  }

  // 4. Scope validation
  const scope = data.scope as MemoryScope;
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`memory record ${filename} has invalid scope: must be one of agent, project, run, operator`);
  }

  // 5. Kind validation
  const kind = typeof data.kind === "string" ? data.kind.trim() : "";
  if (!kind) {
    throw new Error(`memory record ${filename} is missing kind`);
  }

  // 6. Summary validation & secret redaction
  const rawSummary = typeof data.summary === "string" ? data.summary.trim() : "";
  if (!rawSummary) {
    throw new Error(`memory record ${filename} is missing summary`);
  }
  const summary = redactSecrets(rawSummary);

  // 7. Provenance validation & secret redaction
  const rawProv = data.provenance as Record<string, unknown> | undefined;
  if (!rawProv || typeof rawProv !== "object" || typeof rawProv.sourceType !== "string" || !rawProv.sourceType.trim()) {
    throw new Error(`memory record ${filename} is missing provenance.sourceType`);
  }
  const provenance: MemoryProvenance = {
    sourceType: rawProv.sourceType.trim(),
    ...(typeof rawProv.sourceRef === "string" ? { sourceRef: redactSecrets(rawProv.sourceRef.trim()) } : {}),
    ...(typeof rawProv.runId === "string" ? { runId: rawProv.runId.trim() } : {}),
    ...(typeof rawProv.timestamp === "string" ? { timestamp: rawProv.timestamp.trim() } : {}),
  };

  // 8. Authority validation
  const authority = data.authority as MemoryAuthority;
  if (!VALID_AUTHORITIES.has(authority)) {
    throw new Error(`memory record ${filename} has invalid authority: ${String(data.authority)}`);
  }

  // 9. Confidence validation
  const confidence = data.confidence as MemoryConfidence;
  if (!VALID_CONFIDENCES.has(confidence)) {
    throw new Error(`memory record ${filename} has invalid confidence: ${String(data.confidence)}`);
  }

  // 10. Lifecycle validation
  const lifecycle = data.lifecycle as MemoryLifecycle;
  if (!VALID_LIFECYCLES.has(lifecycle)) {
    throw new Error(`memory record ${filename} has invalid lifecycle: ${String(data.lifecycle)}`);
  }

  // 11. EvidenceRefs validation
  const rawRefs = Array.isArray(data.evidenceRefs) ? data.evidenceRefs : [];
  const evidenceRefs = rawRefs.map(String);

  return {
    schema: MEMORY_SCHEMA,
    id,
    scope,
    kind,
    summary,
    provenance,
    authority,
    confidence,
    lifecycle,
    evidenceRefs,
    ...(body ? { body } : {}),
  };
}

export function formatMemoryRecord(record: MemoryRecord): string {
  const frontmatter: Record<string, unknown> = {
    schema: record.schema,
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    summary: record.summary,
    provenance: record.provenance,
    authority: record.authority,
    confidence: record.confidence,
    lifecycle: record.lifecycle,
    evidenceRefs: record.evidenceRefs,
  };
  const yamlText = stringify(frontmatter).trim();
  const bodyText = record.body?.trim() ?? "";
  return bodyText ? `---\n${yamlText}\n---\n\n${bodyText}\n` : `---\n${yamlText}\n---\n`;
}

export function memoryDirectories(repoRoot: string): { memoryDir: string; candidatesDir: string } {
  const root = resolve(repoRoot);
  const memoryDir = join(root, ".kxm", "memory");
  const candidatesDir = join(memoryDir, "candidates");
  return { memoryDir, candidatesDir };
}

export function loadAuthoredMemory(repoRoot: string): MemoryRecord[] {
  const { memoryDir } = memoryDirectories(repoRoot);
  if (!existsSync(memoryDir)) return [];

  const records: MemoryRecord[] = [];
  const entries = readdirSync(memoryDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name) === ".md") {
      const fullPath = join(memoryDir, entry.name);
      try {
        const text = readFileSync(fullPath, "utf8");
        const record = parseMemoryRecord(text, entry.name);
        if (record.lifecycle === "active") {
          records.push(record);
        }
      } catch (error) {
        // Log or rethrow depending on strictness
        throw new Error(`failed to parse authored memory file ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return records.sort((left, right) => left.id.localeCompare(right.id));
}

export function loadCandidateMemory(repoRoot: string): MemoryRecord[] {
  const { candidatesDir } = memoryDirectories(repoRoot);
  if (!existsSync(candidatesDir)) return [];

  const records: MemoryRecord[] = [];
  const entries = readdirSync(candidatesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name) === ".md") {
      const fullPath = join(candidatesDir, entry.name);
      try {
        const text = readFileSync(fullPath, "utf8");
        const record = parseMemoryRecord(text, entry.name);
        records.push(record);
      } catch (error) {
        throw new Error(`failed to parse candidate memory file ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return records.sort((left, right) => left.id.localeCompare(right.id));
}

export function createMemoryNote(
  repoRoot: string,
  summary: string,
  options: {
    scope?: MemoryScope | undefined;
    kind?: string | undefined;
    body?: string | undefined;
    sourceRef?: string | undefined;
    runId?: string | undefined;
  } = {},
): { record: MemoryRecord; path: string } {
  const { candidatesDir } = memoryDirectories(repoRoot);
  mkdirSync(candidatesDir, { recursive: true });

  const scope: MemoryScope = options.scope ?? "project";
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`invalid memory note scope: ${scope}; must be one of agent, project, run, operator`);
  }

  const hex = randomUUID().replaceAll("-", "").slice(0, 12);
  const id = `cand_${scope}_${hex}`;
  const record: MemoryRecord = {
    schema: MEMORY_SCHEMA,
    id,
    scope,
    kind: options.kind ?? "learning",
    summary: redactSecrets(summary.trim()),
    provenance: {
      sourceType: "command",
      sourceRef: options.sourceRef ? redactSecrets(options.sourceRef) : "kxm memory note",
      ...(options.runId ? { runId: options.runId } : {}),
      timestamp: new Date().toISOString(),
    },
    authority: "evidence",
    confidence: "probable",
    lifecycle: "active",
    evidenceRefs: [],
    ...(options.body ? { body: options.body.trim() } : {}),
  };

  const targetPath = join(candidatesDir, `${id}.md`);
  writeFileSync(targetPath, formatMemoryRecord(record), "utf8");
  return { record, path: targetPath };
}

export function generateMemoryBrief(repoRoot: string): MemoryBrief {
  const facts = loadAuthoredMemory(repoRoot);
  return {
    schema: MEMORY_BRIEF_SCHEMA,
    generatedAt: new Date().toISOString(),
    count: facts.length,
    facts,
  };
}

export function formatMemoryBriefText(brief: MemoryBrief): string {
  if (brief.facts.length === 0) {
    return "No active project memory facts.";
  }

  const lines: string[] = [`Project memory (${brief.facts.length} active fact${brief.facts.length === 1 ? "" : "s"}):`, ""];
  for (const fact of brief.facts) {
    lines.push(`• [${fact.scope}] [${fact.kind}] ${fact.summary} (${fact.id})`);
  }
  return lines.join("\n");
}

export function formatHarnessMemoryBlock(records: MemoryRecord[]): string {
  const contentLines: string[] = [MEMORY_MARKER_START, "## Project memory (read-only projection)", ""];
  if (records.length === 0) {
    contentLines.push("*No active project memory.*");
  } else {
    for (const record of records) {
      contentLines.push(`- **[${record.scope}]** [${record.kind}] ${record.summary} (\`${record.id}\`)`);
    }
  }
  contentLines.push(MEMORY_MARKER_END);
  return contentLines.join("\n");
}

/** Instruction files `kxm memory sync` projects memory into. Sync never creates one:
 * which harness a project uses is the project's choice, and a file KXM wrote would
 * carry KXM's words instead of the project's. */
const HARNESS_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;

/** Replace the marker-delimited block, or append one when the file has none. Nothing
 * outside the markers is rewritten. */
export function updateHarnessDocument(filePath: string, block: string): boolean {
  const original = readFileSync(filePath, "utf8");
  let updated: string;
  if (original.includes(MEMORY_MARKER_START) && original.includes(MEMORY_MARKER_END)) {
    const startIdx = original.indexOf(MEMORY_MARKER_START);
    const endIdx = original.indexOf(MEMORY_MARKER_END) + MEMORY_MARKER_END.length;
    updated = original.slice(0, startIdx) + block + original.slice(endIdx);
  } else {
    const head = original.trimEnd();
    updated = head ? `${head}\n\n${block}\n` : `${block}\n`;
  }

  if (updated !== original) {
    writeFileSync(filePath, updated, "utf8");
    return true;
  }
  return false;
}

export function syncHarnessMemory(repoRoot: string): { updated: string[]; unchanged: string[]; missing: string[] } {
  const root = resolve(repoRoot);
  const present = HARNESS_INSTRUCTION_FILES.filter((name) => existsSync(join(root, name)));
  const missing = HARNESS_INSTRUCTION_FILES.filter((name) => !present.includes(name));
  if (present.length === 0) {
    throw new Error(
      `none of ${HARNESS_INSTRUCTION_FILES.join(", ")} exists in ${root}; sync updates the instruction files a project already has and does not create them`,
    );
  }

  const block = formatHarnessMemoryBlock(loadAuthoredMemory(root));
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const name of present) {
    (updateHarnessDocument(join(root, name), block) ? updated : unchanged).push(name);
  }
  return { updated, unchanged, missing };
}
