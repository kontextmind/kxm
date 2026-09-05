import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
];

test("operator docs do not keep removed Mesh product names", () => {
  const files = [
    "README.md",
    ...readdirSync("docs").filter((name) => name.endsWith(".md")).map((name) => join("docs", name)),
  ];
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const token of FORBIDDEN) {
      if (text.includes(token)) hits.push(`${file}: ${token}`);
    }
  }
  assert.equal(hits.length, 0, hits.join("\n"));
});
