import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultProjectName } from "../../plugins/kxm/src/project-name.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "kxm-project-name-"));
}

test("KXM_PROJECT env wins over package.json and directory name", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pkg-name" }));
    assert.equal(defaultProjectName(dir, { KXM_PROJECT: "  env-name  " }), "env-name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json name is used when env is unset and never walks upward", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pkg-name" }));
    const sub = join(dir, "sub");
    mkdirSync(sub);
    assert.equal(defaultProjectName(dir, {}), "pkg-name");
    assert.equal(defaultProjectName(sub, {}), "sub");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scoped package names are kept verbatim and whitespace is trimmed", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "  @scope/pkg  " }));
    assert.equal(defaultProjectName(dir, {}), "@scope/pkg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to the directory name for missing, malformed, or name-less package.json", () => {
  const cases: (string | undefined)[] = [
    undefined,
    "{not json",
    "{}",
    JSON.stringify({ name: "" }),
    JSON.stringify({ name: "   " }),
    JSON.stringify({ name: 42 }),
    JSON.stringify({ name: null }),
    JSON.stringify({ name: { nested: true } }),
  ];
  for (const content of cases) {
    const dir = fixture();
    try {
      if (content !== undefined) writeFileSync(join(dir, "package.json"), content);
      assert.equal(defaultProjectName(dir, {}), join(dir).split("/").pop());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
