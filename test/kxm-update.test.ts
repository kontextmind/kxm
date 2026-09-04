import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareSemver,
  loadKxmUpdateConfig,
  noticeFromVersions,
  planKxmPackageUpdate,
  KxmUpdateConfigError,
} from "../plugins/kxm/src/kxm-update.ts";

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
  const steps = planKxmPackageUpdate("github", "0.5.2", "/tmp/rel");
  assert.equal(steps[0]?.command, "gh");
  assert.ok(steps[0]?.args.includes("kxm-0.5.2.tgz"));
  assert.equal(steps[1]?.command, "npm");
  const npmSteps = planKxmPackageUpdate("npm", "0.5.2", "/tmp/rel");
  assert.equal(npmSteps.length, 1);
  assert.match(npmSteps[0]?.args.join(" ") ?? "", /@kontextmind\/kxm@0\.5\.2/);
});
