import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { kxmReleaseAssetName } from "../../plugins/kxm/src/kxm-update.ts";

const releaseText = readFileSync(".github/workflows/release.yml", "utf8");
const autoReleaseText = readFileSync(".github/workflows/auto-release.yml", "utf8");
const ciText = readFileSync(".github/workflows/ci.yml", "utf8");
const smokeText = readFileSync(".github/workflows/smoke.yml", "utf8");
const nightlyText = readFileSync(".github/workflows/nightly.yml", "utf8");
const template = readFileSync(".github/pull_request_template.md", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
const ARC_RUNNER = "kontextmind-doks";
const SMOKE_IF = "${{ vars.KXM_SMOKE_RUNNER == 'kontextmind-doks' }}";

type WorkflowJobs = Record<
  string,
  {
    name?: string;
    if?: unknown;
    "runs-on"?: unknown;
    "timeout-minutes"?: unknown;
    steps?: Array<{ name?: string; if?: unknown; run?: string }>;
  }
>;

type WorkflowDoc = {
  on?: Record<string, { inputs?: { models?: { required?: unknown } } }>;
  jobs?: WorkflowJobs;
};

function runsOnValues(doc: WorkflowDoc): unknown[] {
  return Object.values(doc.jobs ?? {}).map((job) => job["runs-on"]);
}

function assertArcScaleSetSelectors(docs: WorkflowDoc[]): void {
  const values = docs.flatMap(runsOnValues);
  assert.ok(values.length > 0);
  assert.deepEqual(new Set(values), new Set([ARC_RUNNER]));
  for (const value of values) {
    assert.equal(typeof value, "string");
  }
}

function assertSmokeEqualityGate(doc: WorkflowDoc): void {
  assert.equal(doc.jobs?.smoke?.if, SMOKE_IF);
}

test("npm pack asset name in release.yml is kxmReleaseAssetName", () => {
  assert.match(releaseText, /KXM_ASSET=kxm-\$\{version\}\.tgz/);
  const version = "0.5.2";
  const fromTemplate = `kxm-${version}.tgz`;
  assert.equal(fromTemplate, kxmReleaseAssetName(version));
  assert.match(releaseText, /kontextmind-kxm-\$\{VERSION\}\.tgz/);
  assert.match(releaseText, /mv "\$RUNNER_TEMP\/kontextmind-kxm-\$\{VERSION\}\.tgz" "\$RUNNER_TEMP\/\$\{KXM_ASSET\}"/);
  assert.doesNotMatch(releaseText, /--clobber/);
});

test("release workflow is tag- and dispatch-triggered, fail-closed, and npm publish is unlatched", () => {
  const doc = parse(releaseText) as {
    on?: { push?: { tags?: string[] }; workflow_dispatch?: { inputs?: { tag?: { required?: unknown } } } };
    permissions?: { contents?: string };
    jobs?: Record<string, { if?: unknown; permissions?: { contents?: string }; "runs-on"?: unknown; environment?: string }>;
  };
  assert.deepEqual(doc.on?.push?.tags, ["v*"]);
  assert.equal(doc.on?.workflow_dispatch?.inputs?.tag?.required, true);
  assert.equal(doc.permissions?.contents, "read");
  assert.equal(doc.jobs?.release?.permissions?.contents, "write");
  assert.equal(doc.jobs?.release?.if, undefined);
  assert.equal(doc.jobs?.["publish-npm"]?.if, undefined);
  assert.equal(doc.jobs?.["publish-npm"]?.environment, "npm-publish");
  assert.equal(doc.jobs?.release?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.["publish-npm"]?.["runs-on"], ARC_RUNNER);
  assert.match(releaseText, /draft: false/);
  assert.match(releaseText, /npm-publish/);
  assert.match(releaseText, /scripts\/kxm-publish-npm\.mjs/);
  assert.match(releaseText, /KXM_RELEASE_TAG/);
  assert.match(releaseText, /path: \.kxm-release-tools/);
  assert.match(releaseText, /registry\.npmjs\.org/);
});

test("auto-release dispatches one explicit release workflow per merged PR", () => {
  const doc = parse(autoReleaseText) as {
    on?: { pull_request?: { types?: string[]; branches?: string[] } };
    permissions?: { contents?: string; actions?: string };
  };
  assert.deepEqual(doc.on?.pull_request?.types, ["closed"]);
  assert.deepEqual(doc.on?.pull_request?.branches, ["main"]);
  assert.equal(doc.permissions?.contents, "write");
  assert.equal(doc.permissions?.actions, "write");
  assert.match(autoReleaseText, /actions\/workflows\/release\.yml\/dispatches/);
  assert.match(autoReleaseText, /Create or verify tag/);
  assert.doesNotMatch(autoReleaseText, /gh (?:pr|release|api) /);
});

type CiJobs = Record<
  string,
  {
    name?: string;
    if?: unknown;
    "runs-on"?: unknown;
    "timeout-minutes"?: unknown;
    steps?: Array<{ name?: string; if?: unknown; run?: string }>;
    strategy?: {
      matrix?: {
        node?: unknown[];
        runner?: Array<{ name?: string; labels?: unknown; timeout?: unknown }>;
      };
    };
  }
>;

function assertApprovedCiJobDefinitions(jobs: CiJobs | undefined) {
  assert.ok(jobs);
  assert.deepEqual(Object.keys(jobs), ["changes", "docs", "validate", "plugin"]);
  for (const id of ["changes", "docs", "validate", "plugin"] as const) {
    assert.equal(jobs[id]?.if, undefined);
  }
  assert.equal(jobs.changes?.name, "Classify changes");
  assert.equal(jobs.docs?.name, "Docs lint");
}

test("CI required jobs stay named while expensive steps are skipped for docs-only changes", () => {
  const doc = parse(ciText) as {
    concurrency?: { "cancel-in-progress"?: string };
    jobs?: CiJobs;
  };
  assertApprovedCiJobDefinitions(doc.jobs);
  assert.equal(doc.jobs?.generated, undefined);
  const skippedDocs = structuredClone(doc.jobs) as CiJobs;
  assert.ok(skippedDocs.docs);
  skippedDocs.docs.if = "${{ needs.changes.outputs.code == 'true' }}";
  assert.throws(() => assertApprovedCiJobDefinitions(skippedDocs));
  const extraPlatform = structuredClone(doc.jobs) as CiJobs;
  extraPlatform.macos = { name: "Validate (macos, Node 24)" };
  assert.throws(() => assertApprovedCiJobDefinitions(extraPlatform));
  assert.equal(doc.jobs?.validate?.if, undefined);
  assert.equal(doc.jobs?.plugin?.if, undefined);
  const nameTemplate = doc.jobs?.validate?.name ?? "";
  assert.equal(nameTemplate, "Validate (${{ matrix.runner.name }}, Node ${{ matrix.node }})");
  const nodes = doc.jobs?.validate?.strategy?.matrix?.node ?? [];
  const runners = doc.jobs?.validate?.strategy?.matrix?.runner ?? [];
  assert.equal(doc.jobs?.changes?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.docs?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.validate?.["runs-on"], "${{ matrix.runner.labels }}");
  assert.equal(doc.jobs?.validate?.["timeout-minutes"], "${{ matrix.runner.timeout }}");
  assert.equal(doc.jobs?.plugin?.["runs-on"], ARC_RUNNER);
  assert.deepEqual(nodes.map(String), ["22.19.0", "24"]);
  assert.deepEqual(runners, [
    { name: "linux", labels: ARC_RUNNER, timeout: 3 },
    { name: "windows", labels: "windows-latest", timeout: 15 },
  ]);
  const expanded = runners.flatMap((runner) =>
    nodes.map((node) =>
      nameTemplate
        .replace("${{ matrix.runner.name }}", String(runner.name ?? ""))
        .replace("${{ matrix.node }}", String(node)),
    ),
  );
  assert.deepEqual(new Set(expanded), new Set([
    "Validate (linux, Node 22.19.0)",
    "Validate (linux, Node 24)",
    "Validate (windows, Node 22.19.0)",
    "Validate (windows, Node 24)",
  ]));
  assert.equal(expanded.length, 4);
  assert.equal(1 + 1 + expanded.length + 1, 7);
  assert.equal(doc.jobs?.plugin?.name, "Plugin validation");

  const validateSteps = doc.jobs?.validate?.steps ?? [];
  assert.equal(validateSteps[0]?.name, "Skip code validation for documentation-only changes");
  assert.equal(validateSteps[0]?.if, "needs.changes.outputs.code != 'true'");
  for (const step of validateSteps.slice(1)) {
    assert.match(String(step.if), /needs\.changes\.outputs\.code == 'true'/);
  }
  assert.equal(
    validateSteps.some((step) => step.name === "Verify generated runtime bundles are current"),
    false,
  );
  assert.equal(validateSteps.some((step) => step.name === "Inspect package (main only)"), false);

  const pluginSteps = doc.jobs?.plugin?.steps ?? [];
  assert.equal(pluginSteps[0]?.name, "Skip plugin validation for documentation-only changes");
  assert.equal(pluginSteps[0]?.if, "needs.changes.outputs.code != 'true'");
  for (const step of pluginSteps.slice(1)) {
    assert.match(String(step.if), /needs\.changes\.outputs\.code == 'true'/);
  }

  assert.equal(doc.concurrency?.["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  const validateRuns = (doc.jobs?.validate?.steps ?? []).map((step) => step.run).join("\n");
  assert.match(validateRuns, /npm run validate:pr/);
  assert.doesNotMatch(validateRuns, /npm run validate:ci/);
  assert.equal(doc.jobs?.validate?.["timeout-minutes"], "${{ matrix.runner.timeout }}");
  assert.match(ciText, /@anthropic-ai\/claude-code@2\.1\.261/);
  assert.match(ciText, /npm install --no-save --ignore-scripts @anthropic-ai\/claude-code@2\.1\.261/);
  assert.match(ciText, /node node_modules\/@anthropic-ai\/claude-code\/install\.cjs/);
  assert.match(ciText, /claude plugin validate/);
  assert.match(ciText, /\.github\/pull_request_template\.md/);
  assert.doesNotMatch(ciText, /\.github\/PULL_REQUEST_TEMPLATE\.md/);
});

test("the bounded merge gate stays focused while nightly owns exhaustive coverage", () => {
  const validatePr = pkg.scripts?.["validate:pr"] ?? "";
  assert.match(validatePr, /^npm run build && npm run typecheck && node /);
  assert.match(validatePr, /--test-concurrency=4 test\/core\/artifacts-exist\.test\.ts/);
  assert.match(validatePr, /test\/core\/ci-contract\.test\.ts/);
  assert.match(validatePr, /test\/core\/smoke\.test\.ts/);
  assert.match(validatePr, /test\/core\/version-surfaces\.test\.ts/);
  assert.doesNotMatch(validatePr, /test\/core\/\*\.test\.ts/);
  assert.match(validatePr, /npm run check:versions/);
  assert.match(validatePr, /node scripts\/check-generated\.mjs$/);
  assert.doesNotMatch(validatePr, /npm run (?:test:core|check:generated|lint:docs)(?:\s|$)/);
  assert.doesNotMatch(validatePr, /npm run check(?:\s|$)/);

  const coverageCore = pkg.scripts?.["test:coverage:core"] ?? "";
  const coverageComplete = pkg.scripts?.["test:coverage:complete"] ?? "";
  assert.match(coverageCore, /--test-coverage-lines=91/);
  assert.match(coverageCore, /--test-coverage-branches=80/);
  assert.match(coverageCore, /--test-coverage-functions=92/);
  assert.match(coverageComplete, /--test-coverage-lines=93/);
  assert.match(coverageComplete, /--test-coverage-branches=80/);
  assert.match(coverageComplete, /--test-coverage-functions=93/);
  assert.equal(pkg.scripts?.verify?.includes("test") && pkg.scripts?.["validate:ci"]?.includes("test:coverage"), true);
  assert.equal(pkg.scripts?.release, undefined);
  assert.equal(pkg.scripts?.["publish-npm"], undefined);
});

test("coverage excludes stay file-scoped and never hide the antigravity or claude-bridge provider trees", () => {
  const coverageCore = pkg.scripts?.["test:coverage:core"] ?? "";
  const coverageComplete = pkg.scripts?.["test:coverage:complete"] ?? "";
  // Spawned entrypoints: covered by process/install tests, not line-counted here.
  for (const script of [coverageCore, coverageComplete]) {
    assert.match(script, /--test-coverage-exclude=plugins\/kxm\/src\/server\.ts/);
    assert.match(script, /--test-coverage-exclude=plugins\/kxm\/src\/mcp-server\.ts/);
    assert.match(script, /--test-coverage-exclude=plugins\/kxm\/src\/runtime-supervisor\.ts/);
    assert.doesNotMatch(script, /providers\/antigravity\/\*\*/);
    assert.doesNotMatch(script, /providers\/claude-bridge\/\*\*/);
  }
});

test("PR template asks for slice issue and verify, not a local plugin checkbox", () => {
  assert.match(template, /Slice issue: #N/);
  assert.match(template, /Which code change aged the plan \(or none\):/);
  assert.match(template, /npm run verify/);
  assert.doesNotMatch(template, /validate:claude/);
  assert.doesNotMatch(template, /npm pack --dry-run/);
});

test("Linux workflow selectors are the ARC scale set and old labels fail closed", () => {
  const ci = parse(ciText) as WorkflowDoc;
  const release = parse(releaseText) as WorkflowDoc;
  const smoke = parse(smokeText) as WorkflowDoc;
  const nightly = parse(nightlyText) as WorkflowDoc;
  assert.equal(ci.jobs?.validate?.["runs-on"], "${{ matrix.runner.labels }}");
  const linuxCi = structuredClone(ci);
  assert.ok(linuxCi.jobs?.validate);
  delete linuxCi.jobs.validate;
  assertArcScaleSetSelectors([linuxCi, release, smoke, nightly]);
  assertSmokeEqualityGate(smoke);
  for (const text of [ciText, releaseText, smokeText, nightlyText]) {
    assert.doesNotMatch(text, /runs-on:[^\n]*self-hosted/);
    assert.doesNotMatch(text, /ubuntu-latest/);
    assert.doesNotMatch(text, /km-gh-rn01/);
    assert.doesNotMatch(text, /\[[^\]]*doks[^\]]*\]/);
    assert.doesNotMatch(text, /runs-on:\s*\$\{\{\s*vars\./);
  }
  assert.match(ciText, /labels: windows-latest/);
  assert.doesNotMatch(releaseText, /windows-latest/);
  assert.doesNotMatch(smokeText, /windows-latest/);
  assert.doesNotMatch(nightlyText, /windows-latest/);
  const mutatedCi = structuredClone(linuxCi);
  assert.ok(mutatedCi.jobs?.docs);
  mutatedCi.jobs.docs["runs-on"] = ["self-hosted", "Linux", "X64", "doks"];
  assert.throws(() => assertArcScaleSetSelectors([mutatedCi, release, smoke, nightly]));
  const mutatedSmoke = structuredClone(smoke);
  assert.ok(mutatedSmoke.jobs?.smoke);
  mutatedSmoke.jobs.smoke.if = "${{ vars.KXM_SMOKE_RUNNER != '' }}";
  assert.throws(() => assertSmokeEqualityGate(mutatedSmoke));
});

test("nightly workflow runs complete test coverage with 93/80/93 floors", () => {
  assert.match(nightlyText, /npm run test:coverage:complete/);
  assert.match(nightlyText, /npm run check:generated/);
  assert.match(nightlyText, /npm pack --dry-run/);
});

test("smoke workflow is manual, equality-gated, keeps model inputs", () => {
  const doc = parse(smokeText) as WorkflowDoc;
  assert.deepEqual(Object.keys(doc.on ?? {}), ["workflow_dispatch"]);
  assert.equal(doc.on?.workflow_dispatch?.inputs?.models?.required, false);
  assert.equal(doc.jobs?.smoke?.if, SMOKE_IF);
  assert.equal(doc.jobs?.smoke?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.smoke?.["timeout-minutes"], 20);
  const stepText = JSON.stringify(doc.jobs?.smoke?.steps ?? []);
  assert.match(stepText, /node scripts\/smoke-multi-pi\.mjs/);
  assert.match(smokeText, /KXM_SMOKE: "1"/);
  assert.match(smokeText, /inputs\.models \|\| vars\.KXM_SMOKE_MODELS/);
  assert.doesNotMatch(smokeText, /secrets\./);
});
