import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { kxmReleaseAssetName } from "../plugins/kxm/src/kxm-update.ts";

const releaseText = readFileSync(".github/workflows/release.yml", "utf8");
const ciText = readFileSync(".github/workflows/ci.yml", "utf8");
const template = readFileSync(".github/pull_request_template.md", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

test("npm pack asset name in release.yml is kxmReleaseAssetName", () => {
  assert.match(releaseText, /KXM_ASSET=kxm-\$\{version\}\.tgz/);
  const version = "0.5.2";
  const fromTemplate = `kxm-${version}.tgz`;
  assert.equal(fromTemplate, kxmReleaseAssetName(version));
  assert.match(releaseText, /kontextmind-kxm-\$\{VERSION\}\.tgz/);
  assert.match(releaseText, /mv "\$RUNNER_TEMP\/kontextmind-kxm-\$\{VERSION\}\.tgz" "\$RUNNER_TEMP\/\$\{KXM_ASSET\}"/);
  assert.doesNotMatch(releaseText, /--clobber/);
});

test("release workflow is tag-triggered, fail-closed drafts, and npm publish stays if: false", () => {
  const doc = parse(releaseText) as {
    on?: { push?: { tags?: string[] } };
    permissions?: { contents?: string };
    jobs?: Record<string, { if?: unknown; permissions?: { contents?: string } }>;
  };
  assert.deepEqual(doc.on?.push?.tags, ["v*"]);
  assert.equal(doc.permissions?.contents, "read");
  assert.equal(doc.jobs?.release?.permissions?.contents, "write");
  assert.equal(doc.jobs?.["publish-npm"]?.if, false);
  assert.match(releaseText, /draft: false/);
  assert.match(releaseText, /npm-publish/);
});

test("CI keeps four Validate names, generated job is gone, plugin pin and PR-only cancel stay", () => {
  const doc = parse(ciText) as {
    concurrency?: { "cancel-in-progress"?: string };
    jobs?: Record<string, { name?: string; steps?: Array<{ run?: string }> }>;
  };
  assert.equal(doc.jobs?.generated, undefined);
  assert.equal(doc.jobs?.validate?.name, "Validate (${{ matrix.runner.name }}, Node ${{ matrix.node }})");
  assert.equal(doc.concurrency?.["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  const validateRuns = (doc.jobs?.validate?.steps ?? []).map((step) => step.run).join("\n");
  assert.match(validateRuns, /npm run validate:ci/);
  assert.match(validateRuns, /npm run check:generated/);
  assert.match(ciText, /name: Plugin validation/);
  assert.match(ciText, /@anthropic-ai\/claude-code@2\.1\.261/);
  assert.match(ciText, /npm install --no-save --ignore-scripts @anthropic-ai\/claude-code@2\.1\.261/);
  assert.match(ciText, /node node_modules\/@anthropic-ai\/claude-code\/install\.cjs/);
  assert.match(ciText, /claude plugin validate/);
  assert.match(ciText, /\.github\/pull_request_template\.md/);
  assert.doesNotMatch(ciText, /\.github\/PULL_REQUEST_TEMPLATE\.md/);
});

test("coverage floors stay 93/80/93 and there is no third npm gate script", () => {
  const coverage = pkg.scripts?.["test:coverage"] ?? "";
  assert.match(coverage, /--test-coverage-lines=93/);
  assert.match(coverage, /--test-coverage-branches=80/);
  assert.match(coverage, /--test-coverage-functions=93/);
  assert.equal(pkg.scripts?.verify?.includes("test") && pkg.scripts?.["validate:ci"]?.includes("test:coverage"), true);
  assert.equal(pkg.scripts?.release, undefined);
  assert.equal(pkg.scripts?.["publish-npm"], undefined);
});

test("PR template asks for slice issue and verify, not a local plugin checkbox", () => {
  assert.match(template, /Slice issue: #N/);
  assert.match(template, /Which code change aged the plan \(or none\):/);
  assert.match(template, /npm run verify/);
  assert.doesNotMatch(template, /validate:claude/);
  assert.doesNotMatch(template, /npm pack --dry-run/);
});
