import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createMemoryNote,
  formatHarnessMemoryBlock,
  formatMemoryBriefText,
  formatMemoryRecord,
  generateMemoryBrief,
  loadAuthoredMemory,
  loadCandidateMemory,
  MEMORY_MARKER_END,
  MEMORY_MARKER_START,
  MEMORY_SCHEMA,
  parseMemoryRecord,
  syncHarnessMemory,
  type MemoryRecord,
  type MemoryScope,
} from "../../plugins/kxm/src/memory.ts";
import { computeKxmMemoryRevision } from "../../plugins/kxm/src/runtime-service.ts";
import { loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
import { committedProject } from "../helpers/project.ts";
import { removeTempDir } from "../helpers.ts";

const repoRoot = resolve(process.cwd());

test("E5b: memory record YAML frontmatter parsing, validation, secret redaction, and control-plane rejection", () => {
  // 1. Valid record round-trip
  const validRecord: MemoryRecord = {
    schema: MEMORY_SCHEMA,
    id: "mem_sqlite_wal",
    scope: "project",
    kind: "architecture",
    summary: "SQLite database uses WAL journal mode for concurrent first-open safety",
    provenance: {
      sourceType: "human",
      sourceRef: "operator",
      timestamp: "2026-09-08T00:00:00.000Z",
    },
    authority: "instruction",
    confidence: "verified",
    lifecycle: "active",
    evidenceRefs: ["doc:sqlite"],
    body: "# Details\nConcurrency is achieved via WAL mode.",
  };

  const formatted = formatMemoryRecord(validRecord);
  assert.ok(formatted.startsWith("---\n"));
  assert.ok(formatted.includes("schema: kxm.memory.v1"));
  assert.ok(formatted.includes("# Details"));

  const parsed = parseMemoryRecord(formatted, "test.md");
  assert.equal(parsed.id, validRecord.id);
  assert.equal(parsed.scope, validRecord.scope);
  assert.equal(parsed.kind, validRecord.kind);
  assert.equal(parsed.summary, validRecord.summary);
  assert.equal(parsed.authority, validRecord.authority);
  assert.equal(parsed.confidence, validRecord.confidence);
  assert.equal(parsed.lifecycle, validRecord.lifecycle);
  assert.deepEqual(parsed.evidenceRefs, validRecord.evidenceRefs);
  assert.equal(parsed.body, validRecord.body);

  // 2. Control plane rejection
  for (const field of ["permissions", "tools", "allow", "deny", "grants", "approval", "policy", "scopes", "credentials", "secrets", "token", "apiKey", "password"]) {
    const maliciousYaml = `---\nschema: kxm.memory.v1\nid: mem_bad\nscope: project\nkind: test\nsummary: bad\nprovenance:\n  sourceType: human\nauthority: instruction\nconfidence: verified\nlifecycle: active\nevidenceRefs: []\n${field}: smuggled_grant\n---\n`;
    assert.throws(
      () => parseMemoryRecord(maliciousYaml, "bad.md"),
      /may not carry control-plane field/,
      `must reject control plane field ${field}`,
    );
  }

  // 3. Secret redaction on summary and provenance
  const rawWithSecrets = `---\nschema: kxm.memory.v1\nid: mem_secret\nscope: project\nkind: test\nsummary: Secret key is sk-1234567890abcdef and token is ghp_12345678901234567890\nprovenance:\n  sourceType: tool\n  sourceRef: Bearer sk-9876543210fedcba\nauthority: evidence\nconfidence: probable\nlifecycle: active\nevidenceRefs: []\n---\n`;
  const parsedSecret = parseMemoryRecord(rawWithSecrets, "secret.md");
  assert.equal(parsedSecret.summary.includes("sk-1234567890abcdef"), false);
  assert.equal(parsedSecret.summary.includes("ghp_12345678901234567890"), false);
  assert.equal(parsedSecret.summary.includes("[redacted]"), true);
  assert.equal(parsedSecret.provenance.sourceRef?.includes("sk-9876543210fedcba"), false);
  assert.equal(parsedSecret.provenance.sourceRef?.includes("[redacted]"), true);

  // 4. Invalid scope fails closed
  const badScopeYaml = `---\nschema: kxm.memory.v1\nid: mem_bad_scope\nscope: invalid\nkind: test\nsummary: bad\nprovenance:\n  sourceType: human\nauthority: instruction\nconfidence: verified\nlifecycle: active\nevidenceRefs: []\n---\n`;
  assert.throws(
    () => parseMemoryRecord(badScopeYaml, "bad_scope.md"),
    /invalid scope: must be one of agent, project, run, operator/,
  );
});

test("E5b: kxm memory note writes candidate to candidates/ with evidence authority; candidates excluded from authored set until promoted", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-e5b-note-"));
  try {
    // 1. Record a note via createMemoryNote
    const { record, path } = createMemoryNote(dir, "Discovered optimal timeout is 5000ms", {
      scope: "project",
      kind: "learning",
      body: "Observed under heavy concurrent load.",
    });

    assert.ok(existsSync(path));
    assert.ok(path.includes(join(".kxm", "memory", "candidates")));
    assert.equal(record.authority, "evidence");
    assert.equal(record.confidence, "probable");
    assert.equal(record.lifecycle, "active");
    assert.equal(record.scope, "project");

    // 2. Candidates are in loadCandidateMemory
    const candidates = loadCandidateMemory(dir);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.id, record.id);

    // 3. Candidates are NOT in loadAuthoredMemory
    const authored = loadAuthoredMemory(dir);
    assert.equal(authored.length, 0, "candidates must not appear in authored memory");

    // 4. Brief is empty
    const brief = generateMemoryBrief(dir);
    assert.equal(brief.count, 0);
    assert.equal(brief.facts.length, 0);

    // 5. Promote candidate by moving into .kxm/memory/ (simulating PR merge)
    const promotedPath = join(dir, ".kxm", "memory", `${record.id}.md`);
    writeFileSync(promotedPath, formatMemoryRecord({ ...record, authority: "promoted", confidence: "verified" }));

    const afterPromotion = loadAuthoredMemory(dir);
    assert.equal(afterPromotion.length, 1);
    assert.equal(afterPromotion[0]?.id, record.id);

    const promotedBrief = generateMemoryBrief(dir);
    assert.equal(promotedBrief.count, 1);
    assert.equal(promotedBrief.facts[0]?.id, record.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E5b: kxm memory sync generates marker-delimited blocks across AGENTS.md, CLAUDE.md, and GEMINI.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-e5b-sync-"));
  try {
    // Create initial harness files
    const agentsPath = join(dir, "AGENTS.md");
    writeFileSync(agentsPath, "# Agents\n\nSome guidelines.\n\n## Do not\n- Do not break rules\n");

    const claudePath = join(dir, "CLAUDE.md");
    writeFileSync(claudePath, "# Claude\n\nPlanner instructions.\n");

    // 1. Initial sync with no authored memory
    const syncRes1 = syncHarnessMemory(dir);
    assert.ok(syncRes1.updated.includes("AGENTS.md"));
    assert.ok(syncRes1.updated.includes("CLAUDE.md"));
    assert.ok(syncRes1.created.includes("GEMINI.md"));

    const agents1 = readFileSync(agentsPath, "utf8");
    assert.ok(agents1.includes(MEMORY_MARKER_START));
    assert.ok(agents1.includes(MEMORY_MARKER_END));
    assert.ok(agents1.includes("*No active project memory.*"));

    const claude1 = readFileSync(claudePath, "utf8");
    assert.ok(claude1.includes(MEMORY_MARKER_START));
    assert.ok(claude1.includes(MEMORY_MARKER_END));
    assert.ok(claude1.includes("*No active project memory.*"));

    const geminiPath = join(dir, "GEMINI.md");
    assert.ok(existsSync(geminiPath));
    const gemini1 = readFileSync(geminiPath, "utf8");
    assert.ok(gemini1.includes(MEMORY_MARKER_START));
    assert.ok(gemini1.includes("*No active project memory.*"));

    // 2. Add an authored memory file
    const memDir = join(dir, ".kxm", "memory");
    mkdirSync(memDir, { recursive: true });
    const fact: MemoryRecord = {
      schema: MEMORY_SCHEMA,
      id: "mem_wal_mode",
      scope: "project",
      kind: "architecture",
      summary: "Database operates exclusively in SQLite WAL mode",
      provenance: { sourceType: "human", sourceRef: "operator" },
      authority: "instruction",
      confidence: "verified",
      lifecycle: "active",
      evidenceRefs: [],
    };
    writeFileSync(join(memDir, "wal-mode.md"), formatMemoryRecord(fact));

    // 3. Sync updates all three files with the fact
    const syncRes2 = syncHarnessMemory(dir);
    assert.ok(syncRes2.updated.includes("AGENTS.md"));
    assert.ok(syncRes2.updated.includes("CLAUDE.md"));
    assert.ok(syncRes2.updated.includes("GEMINI.md"));

    for (const p of [agentsPath, claudePath, geminiPath]) {
      const content = readFileSync(p, "utf8");
      assert.ok(content.includes("Database operates exclusively in SQLite WAL mode"));
      assert.ok(content.includes("mem_wal_mode"));
      assert.equal(content.includes("*No active project memory.*"), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E5b: gate - no fact in any harness view is absent from the authored set", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-e5b-views-"));
  try {
    const memDir = join(dir, ".kxm", "memory");
    mkdirSync(memDir, { recursive: true });

    // 2 authored facts
    const fact1: MemoryRecord = {
      schema: MEMORY_SCHEMA,
      id: "mem_fact_1",
      scope: "project",
      kind: "architecture",
      summary: "Fact one is confirmed",
      provenance: { sourceType: "human" },
      authority: "instruction",
      confidence: "verified",
      lifecycle: "active",
      evidenceRefs: [],
    };
    const fact2: MemoryRecord = {
      schema: MEMORY_SCHEMA,
      id: "mem_fact_2",
      scope: "agent",
      kind: "convention",
      summary: "Fact two is confirmed",
      provenance: { sourceType: "human" },
      authority: "instruction",
      confidence: "verified",
      lifecycle: "active",
      evidenceRefs: [],
    };
    writeFileSync(join(memDir, "fact1.md"), formatMemoryRecord(fact1));
    writeFileSync(join(memDir, "fact2.md"), formatMemoryRecord(fact2));

    // Sync views
    syncHarnessMemory(dir);
    const authoredFacts = loadAuthoredMemory(dir);
    const authoredIds = new Set(authoredFacts.map((f) => f.id));

    // Check each harness view
    for (const viewFile of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      const content = readFileSync(join(dir, viewFile), "utf8");
      const markerBlockMatch = content.match(/<!-- kxm:memory:start -->([\s\S]*?)<!-- kxm:memory:end -->/);
      assert.ok(markerBlockMatch, `${viewFile} must contain memory block`);

      // Extract all fact IDs `(`mem_...`)` referenced in the block
      const blockContent = markerBlockMatch[1] ?? "";
      const idMatches = blockContent.match(/`mem_[a-z0-9_-]+`/g) ?? [];
      for (const rawId of idMatches) {
        const id = rawId.replaceAll("`", "");
        assert.ok(authoredIds.has(id), `Fact ${id} found in ${viewFile} is absent from authored memory set!`);
      }
    }

    // Check memory brief
    const brief = generateMemoryBrief(dir);
    for (const fact of brief.facts) {
      assert.ok(authoredIds.has(fact.id), `Fact ${fact.id} in brief is absent from authored memory set!`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E5b: gate - brief returns the exact same facts from CLI, Pi extension, and Claude hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-e5b-brief-same-"));
  try {
    const memDir = join(dir, ".kxm", "memory");
    mkdirSync(memDir, { recursive: true });

    const fact: MemoryRecord = {
      schema: MEMORY_SCHEMA,
      id: "mem_consistent",
      scope: "project",
      kind: "policy",
      summary: "Memory facts are consistent across all surfaces",
      provenance: { sourceType: "human" },
      authority: "instruction",
      confidence: "verified",
      lifecycle: "active",
      evidenceRefs: [],
    };
    writeFileSync(join(memDir, "fact.md"), formatMemoryRecord(fact));

    // 1. Core memory brief
    const coreBrief = generateMemoryBrief(dir);
    const expectedText = formatMemoryBriefText(coreBrief);

    // 2. CLI memory brief execution
    const cliScript = resolve(repoRoot, "scripts/kxm.mjs");
    const cliResult = spawnSync(process.execPath, [cliScript, "memory", "brief", "--workspace", dir], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(cliResult.status, 0, `CLI failed: ${cliResult.stderr}`);
    assert.equal(cliResult.stdout.trim(), expectedText.trim());

    // CLI --json returns identical facts
    const cliJsonResult = spawnSync(process.execPath, [cliScript, "memory", "brief", "--json", "--workspace", dir], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(cliJsonResult.status, 0);
    const parsedCli = JSON.parse(cliJsonResult.stdout) as { ok: boolean; brief: { facts: MemoryRecord[] } };
    assert.equal(parsedCli.ok, true);
    assert.deepEqual(parsedCli.brief.facts, coreBrief.facts);

    // 3. Claude hook command
    // From plugins/kxm/.claude-plugin/plugin.json: "kxm memory brief"
    // Executed in project cwd, stdout is expectedText
    const hookResult = spawnSync(process.execPath, [cliScript, "memory", "brief", "--workspace", dir], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(hookResult.status, 0);
    assert.equal(hookResult.stdout.trim(), expectedText.trim());

    // 4. Pi extension handler returns identical brief text
    // The Pi extension handler does:
    // const memBrief = generateMemoryBrief(cwd);
    // const memText = formatMemoryBriefText(memBrief);
    const piText = formatMemoryBriefText(generateMemoryBrief(dir));
    assert.equal(piText.trim(), expectedText.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E5b: computeKxmMemoryRevision pins revision from authored memory and ignores candidates", () => {
  const { root, stateRoot } = committedProject("kxm-e5b-memrev-");
  try {
    const bundle = loadKxmProject(root);
    const baseRevision = computeKxmMemoryRevision(bundle);

    const memDir = join(root, ".kxm", "memory");
    mkdirSync(memDir, { recursive: true });

    // Adding authored fact changes the pinned revision
    const fact: MemoryRecord = {
      schema: MEMORY_SCHEMA,
      id: "mem_pinned",
      scope: "project",
      kind: "architecture",
      summary: "Authored fact affecting revision",
      provenance: { sourceType: "human" },
      authority: "instruction",
      confidence: "verified",
      lifecycle: "active",
      evidenceRefs: [],
    };
    writeFileSync(join(memDir, "fact.md"), formatMemoryRecord(fact));
    const revisionWithFact = computeKxmMemoryRevision(bundle);
    assert.notEqual(revisionWithFact, baseRevision);
    assert.match(revisionWithFact, /^ctxrev_[a-f0-9]{64}$/);

    // Adding candidate note does NOT change the pinned revision
    createMemoryNote(root, "Unreviewed candidate fact");
    const revisionWithCandidate = computeKxmMemoryRevision(bundle);
    assert.equal(revisionWithCandidate, revisionWithFact, "candidates must not affect memoryRevision");
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("E5b: gate - generated-file check fails when a harness block drifts", () => {
  const checker = resolve(repoRoot, "scripts/check-generated.mjs");
  const { STATIC_GENERATED_ARTIFACTS: staticArtifacts } = JSON.parse(
    spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import { STATIC_GENERATED_ARTIFACTS } from './scripts/check-generated.mjs'; console.log(JSON.stringify({ STATIC_GENERATED_ARTIFACTS }))",
    ], { cwd: repoRoot, encoding: "utf8" }).stdout,
  ) as { STATIC_GENERATED_ARTIFACTS: string[] };

  const dir = mkdtempSync(join(tmpdir(), "kxm-e5b-drift-"));
  const write = (path: string, body: string): void => {
    const target = join(dir, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, body, "utf8");
  };
  try {
    spawnSync("git", ["init", "--quiet"], { cwd: dir });
    for (const [index, artifact] of staticArtifacts.entries()) {
      write(artifact, `# Baseline for ${artifact} ${index}\n`);
    }
    const skillBody = "---\nname: alpha\ndescription: Alpha fixture skill\n---\n\n# Alpha\n";
    const noteBody = "note\n";
    write("plugins/kxm/skill-suite.json", `${JSON.stringify({
      id: "fixture-suite",
      version: "1.0.0",
      name: "Fixture suite",
      description: "Manifest-backed generated artifact fixture",
      skills: [{
        name: "alpha",
        path: "./skills/alpha",
        ownedCommands: ["init"],
        intent: "Fixture skill alpha for generated checks",
      }],
    }, null, 2)}\n`);
    write("plugins/kxm/skills/alpha/SKILL.md", skillBody);
    write("plugins/kxm/skills/alpha/references/note.md", noteBody);
    write(".agents/skills/alpha/SKILL.md", skillBody);
    write(".agents/skills/alpha/references/note.md", noteBody);
    const tracked = [
      ...staticArtifacts,
      "plugins/kxm/skill-suite.json",
      "plugins/kxm/skills/alpha/SKILL.md",
      "plugins/kxm/skills/alpha/references/note.md",
      ".agents/skills/alpha/SKILL.md",
      ".agents/skills/alpha/references/note.md",
    ];
    spawnSync("git", ["add", "--", ...tracked], { cwd: dir });
    spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "init"], { cwd: dir });

    // Baseline check succeeds when the fixture supplies a valid suite
    const okRes = spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });
    assert.equal(okRes.status, 0, `baseline checker failed: ${okRes.stderr}`);

    // Drifting CLAUDE.md causes check-generated to fail
    writeFileSync(join(dir, "CLAUDE.md"), "# Hand-edited memory block drift\n", "utf8");
    const driftedClaude = spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });
    assert.equal(driftedClaude.status, 1);
    assert.match(driftedClaude.stderr, /generated artifacts changed after build:[\s\S]*CLAUDE\.md/);

    // Restoring CLAUDE.md and drifting GEMINI.md causes check-generated to fail
    spawnSync("git", ["checkout", "--", "CLAUDE.md"], { cwd: dir });
    writeFileSync(join(dir, "GEMINI.md"), "# Hand-edited GEMINI drift\n", "utf8");
    const driftedGemini = spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });
    assert.equal(driftedGemini.status, 1);
    assert.match(driftedGemini.stderr, /generated artifacts changed after build:[\s\S]*GEMINI\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

