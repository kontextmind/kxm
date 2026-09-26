import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { unionChangelogUnreleased, unionLandedTracker } from "../../scripts/pr-land.mjs";

const script = join(process.cwd(), "scripts", "pr-land.mjs");

function writeShim(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function stageEnv(bin: string, captures: { git?: string; gh?: string; npm?: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    ...(captures.git ? { KXM_GIT_CAPTURE: captures.git } : {}),
    ...(captures.gh ? { KXM_GH_CAPTURE: captures.gh } : {}),
    ...(captures.npm ? { KXM_NPM_CAPTURE: captures.npm } : {}),
  };
}

function runStage(stage: string, cwd: string, bin: string, extra: string[] = [], captures: { git?: string; gh?: string; npm?: string } = {}) {
  return spawnSync(process.execPath, [script, "--stage", stage, "--json", ...extra], {
    cwd,
    encoding: "utf8",
    env: stageEnv(bin, captures),
  });
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("CHANGELOG union keeps both sides, ours first, with no duplicates", () => {
  const ours = `# Changelog

## Unreleased

### Added

- **kxm land** lands the branch.

- shared bullet

### Fixed

- ours fix only

## 0.7.1

- previous
`;
  const theirs = `# Changelog

## Unreleased

### Added

- shared bullet

- **theirs item** from main.

### Changed

- theirs change

## 0.7.0

- older on main
`;
  const merged = unionChangelogUnreleased(ours, theirs);
  const added = merged.indexOf("**kxm land**");
  const shared = merged.indexOf("shared bullet");
  const theirsItem = merged.indexOf("**theirs item**");
  assert.ok(added >= 0 && shared > added && theirsItem > shared);
  assert.equal(merged.split("shared bullet").length - 1, 1);
  assert.match(merged, /ours fix only/);
  assert.match(merged, /theirs change/);
  assert.match(merged, /## 0\.7\.1/);
  assert.doesNotMatch(merged, /## 0\.7\.0/);
});

test("tracker union lists landed bullets newest first", () => {
  const ours = `intro

### Landed in this tree (unreleased)

- **Older note (2026-09-01).** from the branch.

- **Shared (2026-09-20).** same text.

### Next heading

tail
`;
  const theirs = `other intro

### Landed in this tree (unreleased)

- **Newest note (2026-09-26).** from main.

- **Shared (2026-09-20).** same text.

### Elsewhere

other tail
`;
  const merged = unionLandedTracker(ours, theirs);
  const newest = merged.indexOf("2026-09-26");
  const shared = merged.indexOf("2026-09-20");
  const older = merged.indexOf("2026-09-01");
  assert.ok(newest >= 0 && shared > newest && older > shared);
  assert.equal(merged.split("2026-09-20").length - 1, 1);
  assert.match(merged, /^intro/m);
  assert.match(merged, /### Next heading/);
});

test("verify refuses land_dirty_tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-verify-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const gitCapture = join(dir, "git.txt");
  const npmCapture = join(dir, "npm.txt");
  writeShim(bin, "git", `#!/bin/sh
printf '%s\\n' "$*" >> "$KXM_GIT_CAPTURE"
if [ "$1" = "status" ]; then
  printf '%s\\n' " M README.md"
  exit 0
fi
exit 0
`);
  writeShim(bin, "gh", "#!/bin/sh\nexit 0\n");
  writeShim(bin, "npm", `#!/bin/sh
printf '%s\\n' "$*" >> "$KXM_NPM_CAPTURE"
exit 0
`);
  try {
    const result = runStage("verify", dir, bin, [], { git: gitCapture, npm: npmCapture });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const [row] = jsonLines(result.stdout);
    assert.equal(row?.stage, "verify");
    assert.equal(row?.ok, false);
    assert.equal(row?.code, "land_dirty_tree");
    assert.equal(existsSync(npmCapture), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs passes with skipped when the generator is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-docs-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeShim(bin, "git", "#!/bin/sh\nexit 0\n");
  writeShim(bin, "gh", "#!/bin/sh\nexit 0\n");
  writeShim(bin, "npm", "#!/bin/sh\nexit 1\n");
  try {
    const result = runStage("docs", dir, bin);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const [row] = jsonLines(result.stdout);
    assert.equal(row?.ok, true);
    assert.equal(row?.detail, "docs: skipped (generator absent)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unblock refuses land_blocked on REVIEW_REQUIRED", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-unblock-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const ghCapture = join(dir, "gh.txt");
  writeShim(bin, "git", `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "feature"
  exit 0
fi
exit 0
`);
  writeShim(bin, "gh", `#!/bin/sh
printf '%s\\n' "$*" >> "$KXM_GH_CAPTURE"
printf '%s\\n' '{"reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[],"number":4,"title":"T"}'
exit 0
`);
  writeShim(bin, "npm", "#!/bin/sh\nexit 0\n");
  try {
    const result = runStage("unblock", dir, bin, ["--pr", "4"], { gh: ghCapture });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const [row] = jsonLines(result.stdout);
    assert.equal(row?.code, "land_blocked");
    assert.match(String(row?.detail), /REVIEW_REQUIRED/);
    assert.doesNotMatch(readFileSync(ghCapture, "utf8"), /run rerun/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge falls back to the REST squash when auto-merge reports clean status", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-merge-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const ghCapture = join(dir, "gh.txt");
  writeShim(bin, "git", `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  printf '%s\\n' "abc\\trefs/tags/v0.7.1"
  exit 0
fi
exit 0
`);
  writeShim(bin, "gh", `#!/bin/sh
printf '%s\\n' "$*" >> "$KXM_GH_CAPTURE"
case "$*" in
  *graphql*)
    printf '%s\\n' '{"errors":[{"message":"Pull request is in clean status"}]}' >&2
    exit 1
    ;;
  *nameWithOwner*)
    printf '%s\\n' '{"nameWithOwner":"kontextmind/kxm"}'
    ;;
  *merge_method=squash*)
    printf '%s\\n' '{"merged":true}'
    ;;
  *'--json state'*)
    printf '%s\\n' '{"state":"MERGED"}'
    ;;
  *)
    printf '%s\\n' '{"id":"PR_kwDO","title":"Land it","number":7,"body":""}'
    ;;
esac
exit 0
`);
  writeShim(bin, "npm", "#!/bin/sh\nexit 0\n");
  try {
    const result = runStage("merge", dir, bin, ["--pr", "7"], { gh: ghCapture });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const rows = jsonLines(result.stdout);
    assert.equal(rows.at(-1)?.stage, "merge");
    assert.equal(rows.at(-1)?.ok, true);
    const captured = readFileSync(ghCapture, "utf8");
    assert.match(captured, /merge_method=squash/);
    assert.match(captured, /commit_title=Land it \(#7\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebase stops with land_conflict_manual after five rounds while status stays BEHIND", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-rebase-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const gitCapture = join(dir, "git.txt");
  const ghCapture = join(dir, "gh.txt");
  writeShim(bin, "git", `#!/bin/sh
printf '%s\\n' "$*" >> "$KXM_GIT_CAPTURE"
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "feature"
  exit 0
fi
if [ "$1" = "merge-tree" ]; then
  exit 0
fi
exit 0
`);
  writeShim(bin, "gh", `#!/bin/sh
printf '%s\\n' "$*" >> "$KXM_GH_CAPTURE"
case "$*" in
  *'pr list'*)
    printf '%s\\n' '[{"number":1,"title":"T"}]'
    ;;
  *)
    printf '%s\\n' '{"mergeStateStatus":"BEHIND","number":1,"title":"T","id":"PR_node","state":"OPEN"}'
    ;;
esac
exit 0
`);
  writeShim(bin, "npm", "#!/bin/sh\nexit 1\n");
  try {
    const result = runStage("rebase", dir, bin, [], { git: gitCapture, gh: ghCapture });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const rows = jsonLines(result.stdout);
    assert.ok(rows.some((row) => row.stage === "rebase" && row.code === "land_conflict_manual"));
    const rebases = readFileSync(gitCapture, "utf8").split("\n").filter((line) => line.startsWith("rebase origin/main"));
    assert.equal(rebases.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("milestone reports deep_review_required when a phase flips to all done", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-milestone-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "plans", "kxm-roadmap"), { recursive: true });
  mkdirSync(join(dir, ".kxm", "logs"), { recursive: true });
  writeFileSync(join(dir, "plans", "kxm-roadmap", "state.json"), `${JSON.stringify({
    phases: [{ id: "s2", tasks: [{ id: "a", status: "done" }, { id: "b", status: "done" }] }],
  })}\n`);
  writeFileSync(join(dir, ".kxm", "logs", "land-phases-before.json"), `${JSON.stringify({
    phases: [{ id: "s2", tasks: [{ id: "a", status: "done" }, { id: "b", status: "open" }] }],
  })}\n`);
  writeShim(bin, "git", `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "feature"
  exit 0
fi
exit 0
`);
  writeShim(bin, "gh", `#!/bin/sh
printf '%s\\n' '[]'
exit 0
`);
  writeShim(bin, "npm", "#!/bin/sh\nexit 0\n");
  try {
    const result = runStage("milestone", dir, bin);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const [row] = jsonLines(result.stdout);
    assert.equal(row?.stage, "milestone");
    assert.equal(row?.ok, true);
    assert.equal(row?.deep_review_required, true);
    assert.equal(row?.phase, "s2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function prGitShim(): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$KXM_GIT_CAPTURE"
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "landing-gates"
  exit 0
fi
if [ "$1" = "log" ]; then
  printf '%s\\n' "Fix the land title"
  printf '%s\\n' "second subject"
  exit 0
fi
exit 0
`;
}

function prGhShim(): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$KXM_GH_CAPTURE"
case "$*" in
  *'pr create'*)
    printf '%s\\n' created > "$KXM_GH_CAPTURE.created"
    exit 0
    ;;
  *'pr list'*)
    if [ -f "$KXM_GH_CAPTURE.created" ]; then
      printf '%s\\n' '[{"number":9,"title":"ignored"}]'
    else
      printf '%s\\n' '[]'
    fi
    ;;
  *'pr view'*)
    printf '%s\\n' '{"number":9,"title":"ignored","id":"PR_node","body":""}'
    ;;
esac
exit 0
`;
}

test("pr uses the first commit subject as the title and honors --title", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-pr-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const gitCapture = join(dir, "git.txt");
  const ghCapture = join(dir, "gh.txt");
  writeFileSync(join(dir, "body.md"), "Body\n");
  writeShim(bin, "git", prGitShim());
  writeShim(bin, "gh", prGhShim());
  writeShim(bin, "npm", "#!/bin/sh\nexit 0\n");
  try {
    const created = runStage("pr", dir, bin, ["--body-file", "body.md"], { git: gitCapture, gh: ghCapture });
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    const createdRows = jsonLines(created.stdout);
    assert.equal(createdRows.at(-1)?.detail, "created #9");
    const captured = readFileSync(ghCapture, "utf8");
    assert.match(captured, /pr create --head landing-gates --title Fix the land title --body-file body\.md/);
    assert.doesNotMatch(captured, /--title landing-gates/);

    const dry = runStage("pr", dir, bin, ["--dry-run"], { git: gitCapture, gh: ghCapture });
    assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
    const [dryRow] = jsonLines(dry.stdout);
    assert.equal(dryRow?.detail, "Fix the land title");
    assert.match(JSON.stringify(dryRow?.plan), /--title Fix the land title/);

    writeFileSync(ghCapture, "");
    rmSync(`${ghCapture}.created`, { force: true });
    const titled = runStage("pr", dir, bin, ["--body-file", "body.md", "--title", "Chosen title"], { git: gitCapture, gh: ghCapture });
    assert.equal(titled.status, 0, `${titled.stdout}\n${titled.stderr}`);
    assert.match(readFileSync(ghCapture, "utf8"), /--title Chosen title --body-file body\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr refuses land_pr_title_missing when the branch has no commit subject", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-pr-title-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeShim(bin, "git", `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "landing-gates"
  exit 0
fi
if [ "$1" = "log" ]; then
  exit 0
fi
exit 0
`);
  writeShim(bin, "gh", `#!/bin/sh
printf '%s\\n' '[]'
exit 0
`);
  writeShim(bin, "npm", "#!/bin/sh\nexit 0\n");
  try {
    const result = runStage("pr", dir, bin, ["--body-file", "body.md"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const [row] = jsonLines(result.stdout);
    assert.equal(row?.code, "land_pr_title_missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release matches the Release run by time when its title is Release", { timeout: 20_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-land-release-"));
  const bin = join(dir, "bin");
  mkdirSync(join(dir, ".kxm", "logs"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(dir, ".kxm", "logs", "land-release-context.json"), `${JSON.stringify({
    tag: "v0.7.1",
    title: "Fix the gates",
    mergedAt: "2026-09-26T12:00:00.000Z",
  })}\n`);
  writeShim(bin, "git", `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "landing-gates"
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  printf '%s\\t%s\\n' "aaa" "refs/tags/v0.7.1"
  printf '%s\\t%s\\n' "bbb" "refs/tags/v0.7.2"
  exit 0
fi
exit 0
`);
  writeShim(bin, "gh", `#!/bin/sh
case "$*" in
  *auto-release.yml*)
    printf '%s\\n' '[{"databaseId":111,"status":"completed","conclusion":"success","displayTitle":"Fix the gates","createdAt":"2026-09-26T12:01:00.000Z"}]'
    ;;
  *release.yml*)
    printf '%s\\n' '[{"databaseId":1,"status":"completed","conclusion":"success","displayTitle":"Release","createdAt":"2026-09-26T11:00:00.000Z"},{"databaseId":333,"status":"completed","conclusion":"success","displayTitle":"Release","createdAt":"2026-09-26T13:00:00.000Z"},{"databaseId":222,"status":"completed","conclusion":"success","displayTitle":"Release","createdAt":"2026-09-26T12:02:00.000Z"}]'
    ;;
  *)
    printf '%s\\n' '[]'
    ;;
esac
exit 0
`);
  writeShim(bin, "npm", `#!/bin/sh
printf '%s\\n' "0.7.2"
exit 0
`);
  const previous = process.env.KXM_LAND_POLL_MS;
  process.env.KXM_LAND_POLL_MS = "1";
  try {
    const result = runStage("release", dir, bin);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const row = jsonLines(result.stdout).at(-1);
    assert.equal(row?.stage, "release");
    assert.equal(row?.ok, true);
    assert.equal(row?.detail, "PUBLISHED 0.7.2 auto-release 111 release 222");
    const context = JSON.parse(readFileSync(join(dir, ".kxm", "logs", "land-release-context.json"), "utf8")) as { autoReleaseRunId?: string; releaseRunId?: string };
    assert.equal(context.autoReleaseRunId, "111");
    assert.equal(context.releaseRunId, "222");
  } finally {
    if (previous === undefined) delete process.env.KXM_LAND_POLL_MS;
    else process.env.KXM_LAND_POLL_MS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
