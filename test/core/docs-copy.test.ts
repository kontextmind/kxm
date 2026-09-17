import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const FORBIDDEN = [
  "mesh:offline",
  "`kxm mesh`",
  "/mesh-status",
  "MeshClient",
  "MeshDashboard",
  "Mesh tools",
  "Pi Mesh",
  "`mesh`",
  "openrouter-model-workforce-guide",
  "docs/contracts/implementation-plan.md",
  "docs/v05-context-os.md",
  ".kxm/assets/reviews/",
  "your-mesh-host",
];

const BINARY_NAME_RE = /(^|[^A-Za-z0-9._/-])(kxm-hub|kxm-worker)(?![A-Za-z0-9._-])/;

/**
 * Other registered git worktrees of this repository.
 *
 * The brake polices the copy an operator reads in *this* checkout. A nested
 * worktree (`.claude/worktrees/<session>`, `.kxm/worktrees/<run>`) is a separate
 * checkout on its own branch, so its files are another tree's business: judging
 * them here would make the gate depend on which old sessions happen to be on
 * disk. This is a scope correction, not an exemption: the same tokens are still
 * refused everywhere in this worktree.
 */
function otherWorktrees(): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const root = resolve(".");
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length).trim()))
    .filter((path) => path !== root);
}

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) files.push(...markdownFiles(path));
    else if (name.endsWith(".md")) files.push(path);
  }
  return files;
}

function pluginReadmes(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) files.push(...pluginReadmes(path));
    else if (name === "README.md") files.push(path);
  }
  return files;
}

function skillFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) files.push(...skillFiles(path));
    else if (name === "SKILL.md") files.push(path);
  }
  return files;
}

test("operator docs do not keep removed Mesh product names", () => {
  const outside = otherWorktrees();
  const separator = process.platform === "win32" ? "\\" : "/";
  const inAnotherWorktree = (file: string): boolean => {
    const absolute = resolve(file);
    return outside.some((worktree) => absolute.startsWith(`${worktree}${separator}`));
  };
  const files = [
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    ...markdownFiles("docs"),
    ...markdownFiles(".claude"),
    ...pluginReadmes("plugins"),
    ...skillFiles(join("plugins", "kxm", "skills")),
  ].filter((file) => !inAnotherWorktree(file));
  assert.ok(files.length > 20, "the docs brake found almost nothing to scan; its scope is broken");
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const token of FORBIDDEN) {
      if (text.includes(token)) hits.push(`${file}: ${token}`);
    }
    if (BINARY_NAME_RE.test(text)) hits.push(`${file}: kxm-hub|kxm-worker`);
  }
  assert.equal(hits.length, 0, hits.join("\n"));
});
