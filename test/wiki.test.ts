import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProtocolError } from "../plugins/kxm/src/protocol.ts";
import { parseContextItem, type ContextItem } from "../plugins/kxm/src/context.ts";
import type { StateContradiction } from "../plugins/kxm/src/state.ts";
import {
  WIKI_ROOT,
  compileKnowledgeWiki,
  lintKnowledgeWiki,
  writeCompiledWiki,
  type WikiSourcePool,
} from "../plugins/kxm/src/wiki.ts";

function item(overrides: Record<string, unknown> = {}): ContextItem {
  return parseContextItem({
    id: "ctx_wiki1",
    kind: "knowledge",
    project: "kxm",
    summary: "the hub owns durable workflow state",
    provenance: { sourceType: "workflow", sourceRef: "journal:journal_1" },
    authority: "evidence",
    confidence: "probable",
    ...overrides,
  });
}

function pool(overrides: Partial<WikiSourcePool> = {}): WikiSourcePool {
  return {
    project: "kxm",
    stateItems: [
      item({ id: "ctx_state1", kind: "state", stateKey: "ci.pipeline", status: "current", summary: "CI runs on gitlab", validFrom: "2026-01-01T00:00:00.000Z" }),
    ],
    contextItems: [
      item({ id: "ctx_k1" }),
      item({ id: "ctx_ep1", kind: "episode", summary: "repro flaked on CI worker 2" }),
    ],
    contradictions: [],
    openContradictionItemIds: [],
    compiledAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

test("wiki compilation is deterministic and source-linked", () => {
  const first = compileKnowledgeWiki(pool());
  const second = compileKnowledgeWiki(pool());
  // Same inputs, same bytes (except the index timestamp).
  for (const [path, content] of first.pages) {
    if (path.endsWith("index.md")) continue;
    assert.equal(second.pages.get(path), content);
  }
  // Every claim line links back to its record ID and source.
  const architecture = first.pages.get(`${WIKI_ROOT}/architecture/kxm.md`)!;
  assert.match(architecture, /`ctx_k1`/);
  assert.match(architecture, /source: `journal:journal_1`/);
  // The index references each generated page.
  const index = first.index;
  assert.match(index, /architecture/);
  assert.match(index, /incidents/);
  assert.match(index, /contradictions/);
  assert.match(index, /temporal state/);
});

test("wiki preserves current/superseded distinctions across rebuilds", () => {
  const compiled = compileKnowledgeWiki(pool({
    stateItems: [
      item({ id: "ctx_state_old", kind: "state", stateKey: "ci.pipeline", status: "superseded", summary: "CI runs on jenkins", validFrom: "2025-01-01T00:00:00.000Z", validUntil: "2026-01-01T00:00:00.000Z" }),
      item({ id: "ctx_state_new", kind: "state", stateKey: "ci.pipeline", status: "current", summary: "CI runs on gitlab", validFrom: "2026-01-01T00:00:00.000Z" }),
    ],
    contextItems: [
      item({ id: "ctx_old_k", status: "superseded" }),
      item({ id: "ctx_new_k" }),
    ],
  }));
  const statePage = compiled.pages.get(`${WIKI_ROOT}/architecture/kxm-state.md`)!;
  // Current and superseded are separate, labeled sections.
  const currentSection = statePage.split("## Superseded")[0]!;
  const supersededSection = statePage.split("## Superseded")[1]!;
  assert.match(currentSection, /`ctx_state_new`/);
  assert.doesNotMatch(currentSection, /`ctx_state_old`/);
  assert.match(supersededSection, /`ctx_state_old`/);
  // Superseded knowledge lands in a dedicated history page.
  const history = compiled.pages.get(`${WIKI_ROOT}/incidents/kxm-history.md`)!;
  assert.match(history, /`ctx_old_k`/);
  assert.match(history, /Never presented as current truth/);
});

test("open contradictions stay visible and are never silently resolved", () => {
  const contradictions: StateContradiction[] = [{
    project: "kxm",
    stateKey: "ci.pipeline",
    competingCurrentIds: ["ctx_state_a", "ctx_state_b"],
    competingProposalIds: ["ctx_prop_c"],
  }];
  const compiled = compileKnowledgeWiki(pool({ contradictions, openContradictionItemIds: ["journal_journal_9"] }));
  const page = compiled.pages.get(`${WIKI_ROOT}/contradictions/kxm.md`)!;
  assert.match(page, /`ci.pipeline`/);
  assert.match(page, /`ctx_state_a`/);
  assert.match(page, /`ctx_state_b`/);
  assert.match(page, /`ctx_prop_c`/);
  assert.match(page, /`journal_journal_9`/);
  assert.match(page, /never/i);
  // Re-compiling changes nothing about the contradiction listing.
  assert.equal(compileKnowledgeWiki(pool({ contradictions, openContradictionItemIds: ["journal_journal_9"] })).pages.get(`${WIKI_ROOT}/contradictions/kxm.md`), page);
});

test("secrets never reach committed wiki content", () => {
  const compiled = compileKnowledgeWiki(pool({
    contextItems: [item({ id: "ctx_leak", summary: "token sk-abc12345defghij in test config" })],
  }));
  const rendered = [...compiled.pages.values()].join("\n");
  assert.equal(rendered.includes("sk-abc12345defghij"), false);
  assert.match(rendered, /\[redacted\]/);
});

test("lint detects broken refs, orphans, stale state, and missing contradiction surfacing", () => {
  const wikiPool = pool({
    contradictions: [{ project: "kxm", stateKey: "ci.pipeline", competingCurrentIds: ["ctx_state1"], competingProposalIds: [] }],
  });
  const compiled = compileKnowledgeWiki(wikiPool);
  assert.deepEqual(lintKnowledgeWiki(compiled.pages, wikiPool), []);

  // Broken ref: a hand-edited page referencing an unknown record.
  const tampered = new Map(compiled.pages);
  tampered.set(`${WIKI_ROOT}/patterns/kxm.md`, "- ghost claim — `ctx_ghost`\n");
  const issues = lintKnowledgeWiki(tampered, wikiPool);
  assert.equal(issues.some((issue) => issue.rule === "broken_ref" && issue.severity === "error"), true);

  // Orphan page: not linked from the index.
  const orphaned = new Map(compiled.pages);
  orphaned.set(`${WIKI_ROOT}/patterns/orphan.md`, "- orphan\n");
  assert.equal(
    lintKnowledgeWiki(orphaned, wikiPool).some((issue) => issue.rule === "orphan_page"),
    true,
  );

  // Stale state link: superseded item rendered under "Current".
  const stale = new Map(compiled.pages);
  stale.set(
    `${WIKI_ROOT}/architecture/kxm-state.md`,
    "## Current\n\n- old — `ctx_state_old`\n",
  );
  const stalePool = pool({
    stateItems: [item({ id: "ctx_state_old", kind: "state", stateKey: "ci.pipeline", status: "superseded", stateKey2: undefined })],
  });
  const staleIssues = lintKnowledgeWiki(stale, stalePool);
  assert.equal(staleIssues.some((issue) => issue.rule === "stale_state_link"), true);

  // Missing contradiction surfacing on the index is an error.
  const noSurfacing = new Map(compiled.pages);
  noSurfacing.set(`${WIKI_ROOT}/index.md`, "# index\n\n- [architecture](architecture/kxm.md)\n");
  assert.equal(
    lintKnowledgeWiki(noSurfacing, wikiPool).some((issue) => issue.rule === "unresolved_contradiction"),
    true,
  );
});

test("compiled wiki writes deterministically to disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "kxm-wiki-"));
  try {
    const compiled = compileKnowledgeWiki(pool());
    const written = writeCompiledWiki(directory, compiled);
    assert.equal(written.length, compiled.pages.size);
    const indexPath = join(directory, WIKI_ROOT, "index.md");
    assert.equal(readFileSync(indexPath, "utf8"), compiled.index);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wiki compile endpoint enforces project scoping", async (context) => {
  const { createTestMesh } = await import("./helpers.ts");
  const mesh = await createTestMesh(context);
  const denied = await fetch(`${mesh.address.url}/v1/context/wiki/compile`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ project: "test-project" }),
  });
  assert.equal(denied.status, 401);

  const compiled = await fetch(`${mesh.address.url}/v1/context/wiki/compile`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mesh.token}` },
    body: JSON.stringify({ project: "test-project" }),
  });
  assert.equal(compiled.status, 200);
  const body = await compiled.json() as { audit: { pages: string[] }; lint: unknown[] };
  assert.equal(body.audit.pages.some((path) => path.endsWith("index.md")), true);
  assert.deepEqual(body.lint, []);
});

test("state items without keys cannot enter the wiki pool", () => {
  assert.throws(() => item({ kind: "state", stateKey: undefined }), ProtocolError);
});
