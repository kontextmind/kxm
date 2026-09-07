import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  "docs/vnext/implementation-plan.md",
  "docs/v05-context-os.md",
  ".kxm/assets/reviews/",
  "your-mesh-host",
];

const BINARY_NAME_RE = /(^|[^A-Za-z0-9._/-])(kxm-hub|kxm-worker)(?![A-Za-z0-9._-])/;

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
  const files = [
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    ...markdownFiles("docs"),
    ...markdownFiles(".claude"),
    ...pluginReadmes("plugins"),
    ...skillFiles(join("plugins", "kxm", "skills")),
  ];
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
