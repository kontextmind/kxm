import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkFile, githubSlug } from "../../scripts/check-plan-links.mjs";

test("plan link slugs match GitHub heading anchors", () => {
  assert.equal(githubSlug("Tracking (working tree, not a release)"), "tracking-working-tree-not-a-release");
  assert.equal(githubSlug("4. Found during the first dispatch (2026-09-25)"), "4-found-during-the-first-dispatch-2026-09-25");
  assert.equal(githubSlug("Summary Execution Checklist"), "summary-execution-checklist");
});

test("plan link check accepts a relative file and heading and reports the misses", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-plan-links-"));
  try {
    mkdirSync(join(root, "plans"));
    writeFileSync(join(root, "plans", "other.md"), "---\ntitle: other\n---\n\n## Real heading\n\n## Real heading\n");
    writeFileSync(join(root, "plans", "note.md"), [
      "---",
      "related:",
      "  - other.md",
      "  - missing.md",
      "---",
      "",
      "# Note",
      "",
      "See [other](other.md#real-heading) and [second](other.md#real-heading-1).",
      "Broken [file](gone.md) and [anchor](other.md#nope).",
      "Same file [here](#note).",
      "Absolute [path](/Users/example/kxm/plans/other.md).",
      "Web [page](https://example.com/docs).",
      "",
      "```md",
      "[ignored](not-a-file.md)",
      "```",
      "",
    ].join("\n"));
    const problems = checkFile(join(root, "plans", "note.md"));
    assert.deepEqual(problems.map((problem) => problem.split(": ").slice(1).join(": ")), [
      "missing related missing.md",
      "missing gone.md",
      "missing anchor other.md#nope",
      "absolute path is not a repository link: /Users/example/kxm/plans/other.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
