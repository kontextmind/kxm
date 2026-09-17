import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { KxmConfigError, parseRestrictedYaml as parseViaKxm } from "../../plugins/kxm/src/project-config.ts";
import {
  RestrictedYamlError,
  KXM_YAML_LIMITS,
  parseRestrictedYaml as parseDirect,
} from "../../plugins/kxm/src/restricted-yaml.mjs";

function capture(run: () => unknown): { ok: true; value: unknown } | { ok: false; name: string; issues: Array<{ code: string; file: string; message: string; phase: string }> } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    assert.ok(error instanceof RestrictedYamlError || error instanceof KxmConfigError);
    return { ok: false, name: error.name, issues: [...error.issues] };
  }
}

function parity(input: string | Uint8Array, label: string, limits?: typeof KXM_YAML_LIMITS) {
  const direct = capture(() => (limits ? parseDirect(input, label, limits) : parseDirect(input, label)));
  const wrapped = capture(() => (limits ? parseViaKxm(input, label, limits) : parseViaKxm(input, label)));
  assert.equal(direct.ok, wrapped.ok, label);
  if (direct.ok && wrapped.ok) {
    assert.deepEqual(direct.value, wrapped.value);
    return;
  }
  assert.equal(direct.ok, false);
  assert.equal(wrapped.ok, false);
  if (!direct.ok && !wrapped.ok) {
    assert.equal(direct.name, "RestrictedYamlError");
    assert.equal(wrapped.name, "KxmConfigError");
    assert.deepEqual(direct.issues, wrapped.issues);
  }
}

test("direct restricted YAML parser and project-config wrapper share success and structured failure", () => {
  parity("a: 1\nb: two\n", "map");
  parity("nested:\n  list:\n    - 1\n    - true\n", "nested");
  parity(Buffer.from("plain: value\n", "utf8"), "bytes");
  parity("", "empty");
  parity("   \n", "spaces");
  parity("# only\n", "comment");
  parity("null\n", "null");
  parity("[]\n", "array");
  parity("42\n", "scalar");
  parity("hello\n", "string");
  parity("---\n", "document-start");
  parity("---\na: 1\n---\nb: 2\n", "documents");
  parity("a: 1\na: 2\n", "duplicate");
  parity("root: &root {value: 1}\ncopy: *root\n", "alias");
  parity("value: !execute command\n", "tag");
  parity("1: value\n", "key");
  parity(new Uint8Array([0xff, 0xfe]), "utf8");
  parity(`value: ${"x".repeat(70_000)}\n`, "scalar-limit");
  parity("a: 1\n", "tiny-document", { ...KXM_YAML_LIMITS, maxDocumentBytes: 1 });
});

test("restricted YAML parser rejects aliases, tags, duplicates, multi-docs, and size without relaxing limits", () => {
  const empty = capture(() => parseDirect("", "empty"));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.issues[0]?.code, "root_not_object");

  for (const [input, label, code] of [
    ["a: 1\na: 2\n", "duplicate", "invalid_yaml"],
    ["root: &root {value: 1}\ncopy: *root\n", "alias", "anchor_forbidden"],
    ["value: !execute command\n", "tag", "yaml_warning"],
    ["---\na: 1\n---\nb: 2\n", "documents", "invalid_yaml"],
    [`value: ${"x".repeat(70_000)}\n`, "scalar", "scalar_limit"],
  ] as const) {
    const result = capture(() => parseDirect(input, label));
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.issues.some((issue) => issue.code === code), true, `${label} ${JSON.stringify(result.issues)}`);
  }
});

test("shared parser is importable as plain JavaScript without TypeScript stripping", () => {
  const script = `
    import { parseRestrictedYaml, RestrictedYamlError } from ${JSON.stringify(pathToFileURL(resolve("plugins/kxm/src/restricted-yaml.mjs")).href)};
    const value = parseRestrictedYaml("ok: true\\n", "plain-js");
    if (value.ok !== true) throw new Error("parse failed");
    try { parseRestrictedYaml("a: 1\\na: 2\\n", "dup"); throw new Error("expected throw"); }
    catch (error) {
      if (!(error instanceof RestrictedYamlError)) throw error;
      if (!error.issues.some((issue) => issue.code === "invalid_yaml")) throw new Error("missing issue");
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("plugin source parser does not import repo-only scripts", () => {
  const source = readFileSync("plugins/kxm/src/restricted-yaml.mjs", "utf8");
  assert.doesNotMatch(source, /scripts\//);
  assert.doesNotMatch(source, /roster-policy/);
});
