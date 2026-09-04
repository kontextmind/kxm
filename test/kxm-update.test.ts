import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import {
  compareSemver,
  noticeFromVersions,
  planKxmPackageUpdate,
  KxmUpdateConfigError,
} from "../plugins/kxm/src/kxm-update.ts";
import { loadKxmUpdateConfig } from "../plugins/kxm/src/kxm-update-config.ts";

test("semver compare rejects non-semver and orders releases", () => {
  assert.equal(compareSemver("0.5.1", "0.5.2"), -1);
  assert.equal(compareSemver("0.5.1", "0.5.1"), 0);
  assert.equal(compareSemver("1.0.0", "0.9.9"), 1);
  assert.equal(compareSemver("0.5.1-dev", "0.5.2"), undefined);
});

test("missing update.yaml defaults to github notice-only", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-update-missing-"));
  try {
    const config = loadKxmUpdateConfig(root);
    assert.equal(config.auto, false);
    assert.equal(config.source, "github");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update.yaml auto github is valid; unknown fields fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-update-yaml-"));
  try {
    mkdirSync(join(root, ".kxm"), { recursive: true });
    writeFileSync(join(root, ".kxm", "update.yaml"), "schema: kxm.update.v1\nauto: true\nsource: github\n");
    const config = loadKxmUpdateConfig(root);
    assert.equal(config.auto, true);
    assert.equal(config.source, "github");
    writeFileSync(join(root, ".kxm", "update.yaml"), "schema: kxm.update.v1\nauto: false\nextra: 1\n");
    assert.throws(() => loadKxmUpdateConfig(root), KxmUpdateConfigError);
    writeFileSync(join(root, ".kxm", "update.yaml"), "schema: kxm.update.v1\nauto: false\n");
    assert.equal(loadKxmUpdateConfig(root).source, "github");
    writeFileSync(join(root, ".kxm", "update.yaml"), "[]\n");
    assert.throws(() => loadKxmUpdateConfig(root), /must be a mapping/);
    writeFileSync(join(root, ".kxm", "update.yaml"), "foo: [unterminated\n");
    assert.throws(() => loadKxmUpdateConfig(root), /not valid YAML/);
    writeFileSync(join(root, ".kxm", "update.yaml"), "schema: other\nauto: false\n");
    assert.throws(() => loadKxmUpdateConfig(root), /schema must be/);
    writeFileSync(join(root, ".kxm", "update.yaml"), "schema: kxm.update.v1\nauto: yes\n");
    assert.throws(() => loadKxmUpdateConfig(root), /auto must be a boolean/);
    writeFileSync(join(root, ".kxm", "update.yaml"), "schema: kxm.update.v1\nauto: false\nsource: pypi\n");
    assert.throws(() => loadKxmUpdateConfig(root), /source must be npm or github/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("notice and github release install plan", () => {
  const config = { schema: "kxm.update.v1" as const, auto: false, source: "github" as const };
  const available = noticeFromVersions("0.5.1", "0.5.2", config);
  assert.equal(available.available, true);
  assert.match(available.message, /0\.5\.2/);
  const current = noticeFromVersions("0.5.1", "0.5.1", config);
  assert.equal(current.available, false);
  const missing = noticeFromVersions("0.5.1", undefined, config);
  assert.equal(missing.message, "kxm 0.5.1");
  const failed = noticeFromVersions("0.5.1", undefined, config, "timeout");
  assert.match(failed.message, /timeout/);
  const nonSemver = noticeFromVersions("0.5.1", "1.0.0-rc.1", config);
  assert.match(nonSemver.message, /non-semver/);
  const auto = noticeFromVersions("0.5.1", "0.5.2", { ...config, auto: true });
  assert.match(auto.message, /\(auto\)/);
  const steps = planKxmPackageUpdate("github", "0.5.2", "/tmp/rel");
  assert.equal(steps[0]?.command, "gh");
  assert.ok(steps[0]?.args.includes("kxm-0.5.2.tgz"));
  assert.equal(steps[1]?.command, "npm");
  const npmSteps = planKxmPackageUpdate("npm", "0.5.2", "/tmp/rel");
  assert.equal(npmSteps.length, 1);
  assert.match(npmSteps[0]?.args.join(" ") ?? "", /@kontextmind\/kxm@0\.5\.2/);
});

test("Pi extension load graph only uses declared runtime modules", () => {
  const srcRoot = resolve("plugins/kxm/src");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const runtime = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const seen = new Set<string>();
  const queue = ["extension.ts"];
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  while (queue.length > 0) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const path = join(srcRoot, rel);
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(fromRe)) {
      const spec = match[1]!;
      if (spec.startsWith(".")) {
        const resolved = resolve(dirname(path), spec);
        const withTs = resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
        queue.push(relative(srcRoot, withTs).replaceAll("\\", "/"));
        continue;
      }
      if (spec.startsWith("node:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      assert.ok(
        runtime.has(name),
        `Pi extension imports ${spec} but ${name} is not a dependency or peerDependency`,
      );
    }
  }
  assert.ok(seen.has("kxm-update.ts"));
  assert.equal(seen.has("kxm-update-config.ts"), false);
});
