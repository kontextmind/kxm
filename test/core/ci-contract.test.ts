import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { kxmReleaseAssetName } from "../../plugins/kxm/src/kxm-update.ts";
// @ts-expect-error Workflow scripts ship without a declaration file.
import { classifyPaths, isDocsPath, isPlatformPath, unboundedClassification } from "../../scripts/ci-classify.mjs";
// @ts-expect-error Workflow scripts ship without a declaration file.
import { ENGINE_FILE, SERIAL_FILES, SHARD_TOTAL, coverageOfShards, extractTestPatterns, planEngineShard, planUnitFiles } from "../../scripts/ci-unit-shard.mjs";

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
      "fail-fast"?: boolean;
      matrix?: {
        node?: unknown[];
        shard?: number[];
        lane?: string[];
        runner?: Array<{ name?: string; labels?: unknown; timeout?: unknown }>;
      };
    };
  }
>;

test("CI lanes keep one aggregate required check and the main validate matrix", () => {
  const doc = parse(ciText) as {
    concurrency?: { "cancel-in-progress"?: string };
    jobs?: CiJobs & {
      unit?: CiJobs[string] & { strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } } };
      "unit-windows"?: CiJobs[string] & { strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } } };
      required?: CiJobs[string];
    };
  };
  assert.deepEqual(Object.keys(doc.jobs ?? {}), [
    "changes", "docs", "engine", "unit", "unit-windows", "validate", "plugin", "required",
  ]);
  assert.equal(doc.jobs?.generated, undefined);
  assert.equal(doc.jobs?.changes?.if, undefined);
  assert.equal(doc.jobs?.docs?.if, undefined);
  assert.equal(doc.jobs?.changes?.name, "Classify changes");
  assert.equal(doc.jobs?.docs?.name, "Docs lint");
  assert.equal(doc.jobs?.required?.name, "required");
  assert.equal(doc.jobs?.required?.if, "${{ always() }}");
  assert.equal(doc.jobs?.changes?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.docs?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.plugin?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.required?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.engine?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.engine?.if, "${{ needs.changes.outputs.code == 'true' }}");
  assert.equal(doc.jobs?.engine?.strategy?.["fail-fast"], true);
  assert.deepEqual(doc.jobs?.engine?.strategy?.matrix?.shard, [1, 2]);
  assert.equal(doc.jobs?.unit?.["runs-on"], ARC_RUNNER);
  assert.equal(doc.jobs?.unit?.["timeout-minutes"], 10);
  assert.equal(doc.jobs?.unit?.if, "${{ needs.changes.outputs.code == 'true' }}");
  assert.equal(doc.jobs?.unit?.name, "Unit (linux, Node 24, ${{ matrix.lane }})");
  assert.equal(doc.jobs?.unit?.strategy?.["fail-fast"], true);
  assert.deepEqual(doc.jobs?.unit?.strategy?.matrix?.lane, ["serial", "light"]);
  assert.equal(doc.jobs?.["unit-windows"]?.["runs-on"], "windows-latest");
  assert.equal(doc.jobs?.["unit-windows"]?.["timeout-minutes"], 20);
  assert.equal(doc.jobs?.["unit-windows"]?.strategy?.["fail-fast"], true);
  assert.match(String(doc.jobs?.["unit-windows"]?.if), /pull_request/);
  assert.match(String(doc.jobs?.["unit-windows"]?.if), /needs\.changes\.outputs\.platform == 'true'/);
  assert.deepEqual(doc.jobs?.["unit-windows"]?.strategy?.matrix?.lane, ["engine-1", "engine-2", "serial", "light"]);
  assert.equal(doc.jobs?.plugin?.if, "${{ needs.changes.outputs.code == 'true' }}");
  assert.match(String(doc.jobs?.validate?.if), /github\.event_name != 'pull_request'/);
  assert.match(String(doc.jobs?.validate?.if), /needs\.changes\.outputs\.code == 'true'/);
  assert.equal(doc.jobs?.validate?.strategy?.["fail-fast"], true);

  const nameTemplate = doc.jobs?.validate?.name ?? "";
  assert.equal(nameTemplate, "Validate (${{ matrix.runner.name }}, Node ${{ matrix.node }})");
  const nodes = doc.jobs?.validate?.strategy?.matrix?.node ?? [];
  const runners = doc.jobs?.validate?.strategy?.matrix?.runner ?? [];
  assert.equal(doc.jobs?.validate?.["runs-on"], "${{ matrix.runner.labels }}");
  assert.equal(doc.jobs?.validate?.["timeout-minutes"], "${{ matrix.runner.timeout }}");
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
  assert.equal(doc.jobs?.plugin?.name, "Plugin validation");

  const validateSteps = doc.jobs?.validate?.steps ?? [];
  assert.equal(validateSteps.some((step) => step.name === "Inspect package (main only)"), false);
  const unitSteps = doc.jobs?.unit?.steps ?? [];
  assert.equal(unitSteps.some((step) => step.name === "Typecheck"), true);
  assert.equal(unitSteps.some((step) => step.name === "Verify generated runtime bundles are current"), true);
  const unitRuns = unitSteps.map((step) => step.run).join("\n");
  const engineRuns = (doc.jobs?.engine?.steps ?? []).map((step) => step.run).join("\n");
  assert.match(unitRuns, /npm run test:ci-shard -- \$\{\{ matrix\.lane \}\}/);
  assert.match(unitRuns, /npm run typecheck/);
  assert.match(engineRuns, /npm run test:ci-shard -- engine \$\{\{ matrix\.shard \}\} 2/);
  assert.equal(SHARD_TOTAL, 2);

  assert.equal(doc.concurrency?.["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  const validateRuns = validateSteps.map((step) => step.run).join("\n");
  assert.match(validateRuns, /npm run validate:pr/);
  assert.doesNotMatch(validateRuns, /npm run validate:ci/);
  assert.match(ciText, /@anthropic-ai\/claude-code@2\.1\.261/);
  assert.match(ciText, /npm install --no-save --ignore-scripts @anthropic-ai\/claude-code@2\.1\.261/);
  assert.match(ciText, /node node_modules\/@anthropic-ai\/claude-code\/install\.cjs/);
  assert.match(ciText, /claude plugin validate/);
  const classifyText = readFileSync("scripts/ci-classify.mjs", "utf8");
  assert.match(classifyText, /\.github\/pull_request_template\.md/);
  assert.doesNotMatch(classifyText, /\.github\/PULL_REQUEST_TEMPLATE\.md/);
  assert.match(ciText, /name: required/);
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
  assert.ok(linuxCi.jobs?.["unit-windows"]);
  delete linuxCi.jobs.validate;
  delete linuxCi.jobs["unit-windows"];
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

test("pull request classification skips docs and plans, and flags platform paths", () => {
  assert.equal(isDocsPath("README.md"), true);
  assert.equal(isDocsPath("plans/implementation-plan.md"), true);
  assert.equal(isDocsPath("docs/contributing/ci-and-release.md"), true);
  assert.equal(isDocsPath("plans/kxm-roadmap/update-dashboard.mjs"), false);
  assert.equal(classifyPaths(["README.md", "plans/implementation-plan.md"], "pull_request").code, false);
  assert.equal(classifyPaths(["plugins/kxm/src/store.ts"], "pull_request").code, true);
  assert.equal(classifyPaths(["plugins/kxm/src/store.ts"], "pull_request").platform, false);
  assert.equal(classifyPaths(["plugins/kxm/src/store.ts"], "pull_request").runValidate, false);
  assert.equal(classifyPaths(["plugins/kxm/src/store.ts"], "push").runValidate, true);
  assert.equal(classifyPaths(["README.md"], "push").runValidate, false);
  for (const file of [
    "package.json",
    "package-lock.json",
    "packages/core/tui/package.json",
    ".github/workflows/ci.yml",
    "scripts/kxm-worker.mjs",
    "plugins/kxm/src/oneshot-process.ts",
    "plugins/kxm/src/runtime-paths.ts",
    "plugins/kxm/src/runtime-supervisor.ts",
    "plugins/kxm/src/repo-root.ts",
    "test/core/worker.test.ts",
    "test/helpers/mcp-spawn.ts",
  ]) {
    assert.equal(isPlatformPath(file), true, file);
  }
  assert.equal(isPlatformPath("plugins/kxm/src/store.ts"), false);
  assert.deepEqual(unboundedClassification(), { code: true, platform: false, runValidate: true });
  assert.match(ciText, /node scripts\/ci-classify\.mjs/);
  const changes = JSON.stringify((parse(ciText) as { jobs?: CiJobs }).jobs?.changes?.steps ?? []);
  assert.match(changes, /actions\/setup-node@v7/);
});

test("unit shards cover every unit file and every engine test name once", () => {
  const { files, serial, light, heavy } = coverageOfShards(process.cwd(), SHARD_TOTAL);
  assert.deepEqual(serial, [...SERIAL_FILES]);
  assert.equal(files.includes(ENGINE_FILE), true);
  assert.equal(light.includes(ENGINE_FILE), false);
  for (const file of serial) assert.equal(light.includes(file), false, file);
  const covered = new Set([ENGINE_FILE, ...serial, ...light]);
  assert.equal(covered.size, files.length);
  for (const file of files) {
    assert.equal(covered.has(file), true, file);
    assert.equal(file.includes("\\"), false, file);
  }
  const patterns = extractTestPatterns(readFileSync(ENGINE_FILE, "utf8"));
  assert.ok(patterns.length > 20);
  for (const pattern of patterns) {
    assert.equal(heavy.get(pattern.source), 1, pattern.source);
  }
  const first = planEngineShard(process.cwd(), 1, SHARD_TOTAL);
  const second = planEngineShard(process.cwd(), 2, SHARD_TOTAL);
  assert.equal(first.file, ENGINE_FILE);
  assert.equal(second.file, ENGINE_FILE);
  assert.ok(first.patterns.length > 0);
  assert.ok(second.patterns.length > 0);
  assert.equal(pkg.scripts?.["test:ci-shard"], "node scripts/ci-unit-shard.mjs");
});

test("unit shard plans compare windows separators as posix paths", () => {
  const windows = [
    "test\\core\\runtime.test.ts",
    "packages\\core\\example\\tests\\unit\\sample.test.ts",
    "test\\core\\engine.test.ts",
    "test\\core/permission.test.ts",
    "test/core/already-posix.test.ts",
  ];
  const lanes = planUnitFiles(windows);
  assert.deepEqual(lanes.files, [
    "packages/core/example/tests/unit/sample.test.ts",
    "test/core/already-posix.test.ts",
    "test/core/engine.test.ts",
    "test/core/permission.test.ts",
    "test/core/runtime.test.ts",
  ]);
  assert.deepEqual(lanes.serial, [...SERIAL_FILES]);
  assert.deepEqual(lanes.light, [
    "packages/core/example/tests/unit/sample.test.ts",
    "test/core/already-posix.test.ts",
  ]);
  assert.equal(lanes.files.includes(ENGINE_FILE), true);
  assert.equal(lanes.light.includes(ENGINE_FILE), false);
  for (const file of lanes.files) assert.equal(file.includes("\\"), false, file);
  assert.throws(
    () => planUnitFiles(["test\\core\\permission.test.ts", "test\\core\\runtime.test.ts"]),
    /test\/core\/engine\.test\.ts is missing/,
  );
});

test("playwright e2e stays on Obscura outside node --test and outside ci.yml", () => {
  const e2eText = readFileSync(".github/workflows/e2e.yml", "utf8");
  const doc = parse(e2eText) as {
    on?: Record<string, unknown>;
    env?: Record<string, unknown>;
    jobs?: WorkflowJobs;
  };
  assert.deepEqual(Object.keys(doc.on ?? {}), ["pull_request", "workflow_dispatch"]);
  assert.equal(doc.jobs?.obscura?.["runs-on"], "ubuntu-latest");
  assert.equal(doc.jobs?.obscura?.["timeout-minutes"], 20);
  assert.equal(doc.env?.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1");
  const steps = JSON.stringify(doc.jobs?.obscura?.steps ?? []);
  assert.match(steps, /npm ci/);
  assert.match(steps, /npm run e2e/);
  assert.match(steps, /\.kxm\/bin/);
  assert.match(e2eText, /obscura-v0\.2\.3/);
  assert.doesNotMatch(e2eText, /playwright install/);
  assert.doesNotMatch(ciText, /npm run e2e/);
  assert.doesNotMatch(ciText, /ubuntu-latest/);
  assert.doesNotMatch(pkg.scripts?.test ?? "", /test\/e2e/);
  assert.equal(pkg.scripts?.e2e, "node scripts/obscura.mjs --ensure && playwright test");
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /playwright install/);
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
