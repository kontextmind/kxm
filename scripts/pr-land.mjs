#!/usr/bin/env node
/**
 * Landing stages for one KXM branch. Each stage prints one JSON line
 * {stage, ok, code?, detail?} and the process exits 0, 1 (refused), or 2 (usage).
 * gh and git are argv arrays. GIT_* is stripped from every child.
 * Writes only inside the repo and .kxm/logs/.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STAGES = Object.freeze([
  "verify",
  "docs",
  "push",
  "pr",
  "rebase",
  "unblock",
  "merge",
  "release",
  "milestone",
]);

const VERIFY_FRESH_MS = 30 * 60 * 1000;
const REBASE_ROUNDS = 5;
const POLL_MS = positiveInt(process.env.KXM_LAND_POLL_MS, 30_000);
const MERGE_WAIT_MS = 20 * 60 * 1000;
const RELEASE_WAIT_MS = 20 * 60 * 1000;
const RELEASE_PROGRESS_MS = 2 * 60 * 1000;
const PUBLISH_WAIT_MS = 10 * 60 * 1000;
const DOCS_COMMIT = "docs(roadmap): regenerate after verify";
const GENERATOR = "plans/kxm-roadmap/update-dashboard.mjs";
const STATE_FILE = "plans/kxm-roadmap/state.json";
const PHASE_SNAPSHOT = ".kxm/logs/land-phases-before.json";
const RELEASE_CONTEXT = ".kxm/logs/land-release-context.json";
const LANDED_HEADING = "### Landed in this tree (unreleased)";
const UNRELEASED_HEADING = "## Unreleased";

const root = process.cwd();
let dryRun = false;
let bodyFile;
let requestedTitle;
let prNumber;
let forceLease = false;
let phasesSnapshotted = false;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function childEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.toUpperCase().startsWith("GIT_")) continue;
    env[name] = value;
  }
  return env;
}

function run(command, args, timeout = 120_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: childEnv(),
    timeout,
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? result.error.message : ""}`,
  };
}

function safeDetail(text) {
  return String(text ?? "")
    .replace(/ghp_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function pass(stage, extra = {}) {
  emit({ stage, ok: true, ...extra });
  return 0;
}

function refuse(stage, code, detail) {
  const payload = { stage, ok: false, code };
  if (detail) payload.detail = safeDetail(detail);
  emit(payload);
  return 1;
}

function usage(detail) {
  emit({ stage: "usage", ok: false, code: "usage", detail });
  return 2;
}

function plan(stage, commands, detail) {
  const payload = { stage, ok: true, dryRun: true, plan: commands };
  if (detail) payload.detail = detail;
  emit(payload);
  return 0;
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function gitText(args) {
  const result = run("git", args);
  return result.status === 0 ? result.stdout.trim() : "";
}

function branchName() {
  const name = gitText(["rev-parse", "--abbrev-ref", "HEAD"]);
  return name && name !== "HEAD" ? name : "";
}

function treeHash() {
  return gitText(["rev-parse", "HEAD^{tree}"]);
}

function porcelain() {
  const result = run("git", ["status", "--porcelain"]);
  if (result.status !== 0) return { ok: false, detail: result.stderr, paths: [] };
  const paths = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const renamed = rest.split(" -> ");
    let path = renamed[renamed.length - 1] ?? rest;
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    paths.push(path);
  }
  return { ok: true, paths };
}

function gh(args, timeout = 120_000) {
  return run("gh", args, timeout);
}

function ghJson(args) {
  const result = gh(args);
  if (result.status !== 0) return { ok: false, result };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, result };
  }
}

function logsDir() {
  const dir = join(root, ".kxm", "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeLog(name, value) {
  const path = join(logsDir(), name);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function parseArgs(argv) {
  const options = { json: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--pr" || arg === "--body-file" || arg === "--stage" || arg === "--title") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} requires a value` };
      index += 1;
      if (arg === "--pr") options.pr = value;
      if (arg === "--body-file") options.bodyFile = value;
      if (arg === "--stage") options.stage = value;
      if (arg === "--title") options.title = value;
      continue;
    }
    return { error: `unknown argument ${arg}` };
  }
  if (options.pr !== undefined && !/^[0-9]+$/.test(options.pr)) return { error: "--pr expects a pull request number" };
  if (options.stage !== undefined && !STAGES.includes(options.stage)) return { error: `unknown stage ${options.stage}` };
  return { options };
}

function ensurePr() {
  if (prNumber) {
    const viewed = ghJson(["pr", "view", prNumber, "--json", "number,title,id,body"]);
    if (!viewed.ok) return { ok: false, detail: viewed.result.stderr || viewed.result.stdout };
    return { ok: true, pr: viewed.value };
  }
  const branch = branchName();
  if (!branch) return { ok: false, detail: "cannot resolve the current branch" };
  const listed = ghJson(["pr", "list", "--head", branch, "--state", "open", "--json", "number,title"]);
  if (!listed.ok) return { ok: false, detail: listed.result.stderr || listed.result.stdout };
  const rows = Array.isArray(listed.value) ? listed.value : [];
  if (rows.length === 0) return { ok: true, pr: undefined, branch };
  const first = rows[0];
  prNumber = String(first.number);
  const viewed = ghJson(["pr", "view", prNumber, "--json", "number,title,id,body"]);
  if (!viewed.ok) return { ok: true, pr: { number: first.number, title: first.title }, branch };
  return { ok: true, pr: viewed.value, branch };
}

function verifyStage() {
  if (dryRun) {
    return plan("verify", [
      "git status --porcelain",
      "git rev-parse HEAD^{tree}",
      "npm run verify",
    ], "npm run verify is the first stage and is not replaced");
  }
  const status = porcelain();
  if (!status.ok) return refuse("verify", "land_verify_failed", status.detail);
  if (status.paths.length > 0) {
    return refuse("verify", "land_dirty_tree", `working tree is not clean: ${status.paths.join(", ")}`);
  }
  const tree = treeHash();
  if (!tree) return refuse("verify", "land_verify_failed", "git rev-parse HEAD^{tree} failed");
  const receiptName = `land-verify-${tree}.json`;
  const receiptPath = join(root, ".kxm", "logs", receiptName);
  if (existsSync(receiptPath)) {
    const age = Date.now() - statSync(receiptPath).mtimeMs;
    const prior = readJson(receiptPath);
    if (age >= 0 && age < VERIFY_FRESH_MS && prior && prior.ok === true && prior.tree === tree) {
      return pass("verify", { detail: "verify: skipped (receipt fresh)", tree });
    }
  }
  const verified = run("npm", ["run", "verify"], 3_600_000);
  if (verified.status !== 0) {
    return refuse("verify", "land_verify_failed", verified.stderr || verified.stdout);
  }
  writeLog(receiptName, { stage: "verify", ok: true, tree, finishedAt: new Date().toISOString() });
  return pass("verify", { detail: "verify: passed", tree });
}

function docsAllowed(path) {
  if (path === STATE_FILE) return false;
  return path.startsWith("docs/roadmap/")
    || path.startsWith("plans/kxm-roadmap/")
    || path.startsWith("docs/architecture/");
}

function snapshotPhases() {
  if (phasesSnapshotted) return;
  phasesSnapshotted = true;
  const statePath = join(root, STATE_FILE);
  if (!existsSync(statePath)) return;
  const raw = readFileSync(statePath, "utf8");
  mkdirSync(join(root, ".kxm", "logs"), { recursive: true });
  writeFileSync(join(root, PHASE_SNAPSHOT), raw.endsWith("\n") ? raw : `${raw}\n`, { encoding: "utf8", mode: 0o600 });
}

function docsStage() {
  if (dryRun) {
    return plan("docs", [
      `node ${GENERATOR}`,
      `git commit -m ${DOCS_COMMIT}`,
    ], "skipped when the generator is absent; never edits state.json");
  }
  snapshotPhases();
  const generator = join(root, GENERATOR);
  if (!existsSync(generator)) {
    return pass("docs", { detail: "docs: skipped (generator absent)" });
  }
  const generated = run(process.execPath, [generator], 600_000);
  if (generated.status !== 0) {
    return refuse("docs", "land_docs_failed", generated.stderr || generated.stdout);
  }
  const status = porcelain();
  if (!status.ok) return refuse("docs", "land_docs_failed", status.detail);
  if (status.paths.length === 0) return pass("docs", { detail: "docs: no generated changes" });
  const blocked = status.paths.filter((path) => !docsAllowed(path));
  if (blocked.length > 0) {
    return refuse("docs", "land_docs_failed", `unexpected path ${blocked.join(", ")}`);
  }
  const added = run("git", ["add", "--", ...status.paths]);
  if (added.status !== 0) return refuse("docs", "land_docs_failed", added.stderr);
  const committed = run("git", ["commit", "-m", DOCS_COMMIT]);
  if (committed.status !== 0) return refuse("docs", "land_docs_failed", committed.stderr || committed.stdout);
  return pass("docs", { detail: DOCS_COMMIT });
}

function pushStage() {
  const branch = branchName();
  const args = ["push"];
  if (forceLease) args.push("--force-with-lease");
  args.push("-u", "origin", branch || "<branch>");
  if (dryRun) return plan("push", [`git ${args.join(" ")}`]);
  if (!branch) return refuse("push", "land_push_rejected", "cannot resolve the current branch");
  const pushed = run("git", ["push", ...(forceLease ? ["--force-with-lease"] : []), "-u", "origin", branch]);
  if (pushed.status !== 0) return refuse("push", "land_push_rejected", pushed.stderr || pushed.stdout);
  return pass("push", { detail: forceLease ? "pushed with lease" : "pushed" });
}

function pullRequestTitle() {
  const explicit = String(requestedTitle ?? "").trim();
  if (explicit) return { ok: true, text: explicit };
  const logged = run("git", ["log", "--reverse", "--format=%s", "origin/main..HEAD"]);
  if (logged.status !== 0) return { ok: false, detail: "no commit subject on origin/main..HEAD" };
  const subject = logged.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (!subject) return { ok: false, detail: "no commit subject on origin/main..HEAD" };
  return { ok: true, text: subject };
}

function prStage() {
  const titled = pullRequestTitle();
  if (dryRun) {
    if (!titled.ok) return refuse("pr", "land_pr_title_missing", titled.detail);
    return plan("pr", [
      "gh pr list --head <branch> --state open --json number,title",
      `gh pr create --title ${titled.text} --body-file <path>`,
    ], titled.text);
  }
  const found = ensurePr();
  if (!found.ok) return refuse("pr", "land_pr_body_missing", found.detail);
  if (found.pr?.number) {
    prNumber = String(found.pr.number);
    return pass("pr", { detail: `reused #${prNumber}` });
  }
  if (!titled.ok) return refuse("pr", "land_pr_title_missing", titled.detail);
  if (!bodyFile) return refuse("pr", "land_pr_body_missing", "creating a pull request requires --body-file");
  if (!existsSync(bodyFile.startsWith("/") ? bodyFile : join(root, bodyFile))) {
    return refuse("pr", "land_pr_body_missing", `body file not found: ${bodyFile}`);
  }
  const branch = found.branch || branchName();
  const created = gh(["pr", "create", "--head", branch, "--title", titled.text, "--body-file", bodyFile]);
  if (created.status !== 0) return refuse("pr", "land_pr_body_missing", created.stderr || created.stdout);
  const again = ensurePr();
  if (!again.ok || !again.pr?.number) return refuse("pr", "land_pr_body_missing", "pull request was not created");
  prNumber = String(again.pr.number);
  return pass("pr", { detail: `created #${prNumber}` });
}

function bulletKey(bullet) {
  return bullet.replace(/\s+/g, " ").trim();
}

function parseGroups(body) {
  const groups = [];
  let heading = "";
  let bullets = [];
  let current = null;
  const flushBullet = () => {
    if (!current) return;
    bullets.push(current.join("\n").replace(/\n+$/g, ""));
    current = null;
  };
  const flushGroup = () => {
    flushBullet();
    if (heading || bullets.length > 0) groups.push({ heading, bullets });
    heading = "";
    bullets = [];
  };
  for (const line of body.split("\n")) {
    if (/^### /.test(line)) {
      flushGroup();
      heading = line.trim();
      continue;
    }
    if (/^- /.test(line)) {
      flushBullet();
      current = [line];
      continue;
    }
    if (current && (/^[ \t]/.test(line))) {
      current.push(line);
      continue;
    }
    flushBullet();
  }
  flushGroup();
  return groups;
}

function combineBullets(ours, theirs, newestFirst) {
  const seen = new Set();
  const ordered = [];
  for (const bullet of [...ours, ...theirs]) {
    const key = bulletKey(bullet);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ordered.push(bullet.trim());
  }
  if (!newestFirst) return ordered;
  return ordered
    .map((bullet, index) => ({ bullet, index, date: (bullet.match(/\d{4}-\d{2}-\d{2}/) ?? [""])[0] }))
    .sort((left, right) => {
      if (left.date === right.date) return left.index - right.index;
      if (!left.date) return 1;
      if (!right.date) return -1;
      return left.date < right.date ? 1 : -1;
    })
    .map((item) => item.bullet);
}

function renderGroups(groups) {
  const lines = [""];
  for (const group of groups) {
    if (group.bullets.length === 0 && !group.heading) continue;
    if (group.heading) lines.push(group.heading, "");
    for (const bullet of group.bullets) {
      lines.push(bullet, "");
    }
  }
  return `${lines.join("\n").replace(/\n+$/g, "\n")}`;
}

function sliceHeading(text, heading, endPattern) {
  const lines = String(text ?? "").split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (endPattern.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return {
    before: lines.slice(0, start).join("\n"),
    body: lines.slice(start + 1, end).join("\n"),
    after: lines.slice(end).join("\n"),
  };
}

function unionSection(ours, theirs, heading, newestFirst, endPattern) {
  const own = sliceHeading(ours, heading, endPattern);
  const other = sliceHeading(theirs, heading, endPattern);
  if (!own && !other) return ours;
  const base = own ?? { before: String(ours ?? "").replace(/\s*$/g, ""), body: "", after: "" };
  const theirsBody = other?.body ?? "";
  const ownGroups = parseGroups(base.body);
  const theirGroups = parseGroups(theirsBody);
  const seen = new Set();
  const merged = [];
  for (const group of ownGroups) {
    seen.add(group.heading);
    const match = theirGroups.find((item) => item.heading === group.heading);
    merged.push({
      heading: group.heading,
      bullets: combineBullets(group.bullets, match?.bullets ?? [], newestFirst),
    });
  }
  for (const group of theirGroups) {
    if (seen.has(group.heading)) continue;
    merged.push({ heading: group.heading, bullets: combineBullets([], group.bullets, newestFirst) });
  }
  const before = base.before.length > 0 ? `${base.before}\n` : "";
  const after = base.after.length > 0 ? `\n${base.after}` : "";
  const rendered = renderGroups(merged);
  return `${before}${heading}\n${rendered}${after}`;
}

/** Unreleased bullets per heading, ours first, duplicates dropped. */
export function unionChangelogUnreleased(ours, theirs) {
  return unionSection(ours, theirs, UNRELEASED_HEADING, false, /^## /);
}

/** "Landed in this tree (unreleased)" bullets, newest ISO date first. */
export function unionLandedTracker(ours, theirs) {
  return unionSection(ours, theirs, LANDED_HEADING, true, /^#{2,3} /);
}

function showFile(rev, path) {
  const result = run("git", ["show", `${rev}:${path}`]);
  return result.status === 0 ? result.stdout : undefined;
}

function unmergedPaths() {
  const result = run("git", ["diff", "--name-only", "--diff-filter=U"]);
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function abortRebase() {
  if (run("git", ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]).status === 0) {
    run("git", ["rebase", "--abort"]);
  }
}

function resolveConflicts() {
  const unresolved = [];
  let dist = false;
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const paths = unmergedPaths();
    if (paths.length === 0) {
      const continued = run("git", ["-c", "core.editor=true", "-c", "sequence.editor=true", "rebase", "--continue"]);
      if (continued.status === 0) return { ok: true, paths: [] };
      if (unmergedPaths().length === 0) return { ok: false, paths: unresolved, detail: continued.stderr };
    }
    const pending = unmergedPaths();
    dist = false;
    const manuals = [];
    for (const path of pending) {
      if (path === "plugins/kxm/dist" || path.startsWith("plugins/kxm/dist/")) {
        dist = true;
        continue;
      }
      if (path === "CHANGELOG.md" || path === "plans/implementation-plan.md") continue;
      manuals.push(path);
    }
    if (manuals.length > 0) return { ok: false, paths: manuals };
    if (dist) {
      const checked = run("git", ["checkout", "origin/main", "--", "plugins/kxm/dist"]);
      if (checked.status !== 0) return { ok: false, paths: ["plugins/kxm/dist"], detail: checked.stderr };
      const built = run("npm", ["run", "build"], 3_600_000);
      if (built.status !== 0) return { ok: false, paths: ["plugins/kxm/dist"], detail: built.stderr || built.stdout };
      const staged = run("git", ["add", "--", "plugins/kxm/dist"]);
      if (staged.status !== 0) return { ok: false, paths: ["plugins/kxm/dist"], detail: staged.stderr };
    }
    for (const path of pending) {
      if (path !== "CHANGELOG.md" && path !== "plans/implementation-plan.md") continue;
      const oursRev = run("git", ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]).status === 0 ? "REBASE_HEAD" : "HEAD";
      const ours = showFile(oursRev, path);
      const theirs = showFile("origin/main", path);
      if (ours === undefined || theirs === undefined) return { ok: false, paths: [path] };
      const merged = path === "CHANGELOG.md"
        ? unionChangelogUnreleased(ours, theirs)
        : unionLandedTracker(ours, theirs);
      writeFileSync(join(root, path), merged.endsWith("\n") ? merged : `${merged}\n`);
      const staged = run("git", ["add", "--", path]);
      if (staged.status !== 0) return { ok: false, paths: [path], detail: staged.stderr };
    }
    const continued = run("git", ["-c", "core.editor=true", "-c", "sequence.editor=true", "rebase", "--continue"]);
    if (continued.status === 0) return { ok: true, paths: [] };
    if (unmergedPaths().length === 0) return { ok: false, paths: pending, detail: continued.stderr };
  }
  return { ok: false, paths: unmergedPaths() };
}

function mergeState() {
  const found = ensurePr();
  if (!found.ok) return { ok: false, detail: found.detail };
  if (!found.pr?.number) return { ok: true, status: "ABSENT" };
  prNumber = String(found.pr.number);
  const viewed = ghJson(["pr", "view", prNumber, "--json", "mergeStateStatus,title,number"]);
  if (!viewed.ok) return { ok: false, detail: viewed.result.stderr || viewed.result.stdout };
  return { ok: true, status: String(viewed.value.mergeStateStatus ?? ""), title: viewed.value.title };
}

function rebaseStage() {
  if (dryRun) {
    return plan("rebase", [
      "gh pr view --json mergeStateStatus",
      "git fetch origin",
      "git rebase origin/main",
      "git merge-tree --write-tree origin/main HEAD",
      "git push --force-with-lease -u origin <branch>",
    ], `at most ${REBASE_ROUNDS} rounds`);
  }
  const branch = branchName();
  if (branch === "main") return refuse("rebase", "land_conflict_manual", "refusing to rebase branch main");
  const manual = [];
  for (let round = 1; round <= REBASE_ROUNDS; round += 1) {
    const state = mergeState();
    if (!state.ok) return refuse("rebase", "land_conflict_manual", state.detail);
    if (state.status !== "BEHIND" && state.status !== "DIRTY") {
      return pass("rebase", { detail: `mergeStateStatus ${state.status || "absent"}` });
    }
    const before = treeHash();
    const clean = run("git", ["merge-tree", "--write-tree", "origin/main", "HEAD"]).status === 0;
    const fetched = run("git", ["fetch", "origin"]);
    if (fetched.status !== 0) return refuse("rebase", "land_conflict_manual", fetched.stderr || fetched.stdout);
    const rebased = run("git", ["rebase", "origin/main"]);
    if (rebased.status !== 0) {
      const resolved = resolveConflicts();
      if (!resolved.ok) {
        for (const path of resolved.paths) manual.push(path);
        abortRebase();
        if (round === REBASE_ROUNDS) {
          return refuse("rebase", "land_conflict_manual", manual.join(", ") || resolved.detail || "unresolved conflict");
        }
        continue;
      }
    }
    const after = treeHash();
    if (before && after && before !== after) {
      const docsCode = docsStage();
      if (docsCode !== 0) return docsCode;
    }
    if (!clean) {
      const verifyCode = verifyStage();
      if (verifyCode !== 0) return verifyCode;
    }
    forceLease = true;
    const pushCode = pushStage();
    if (pushCode !== 0) return pushCode;
  }
  const state = mergeState();
  if (state.ok && state.status !== "BEHIND" && state.status !== "DIRTY") {
    return pass("rebase", { detail: `mergeStateStatus ${state.status}` });
  }
  const paths = [...new Set(manual)];
  const detail = paths.length > 0 ? paths.join(", ") : "still BEHIND or DIRTY after 5 rounds";
  return refuse("rebase", "land_conflict_manual", detail);
}

function failedRunId(rollup) {
  if (!Array.isArray(rollup)) return undefined;
  for (const item of rollup) {
    if (!item || typeof item !== "object") continue;
    const conclusion = String(item.conclusion ?? "").toUpperCase();
    const status = String(item.status ?? "").toUpperCase();
    const failed = conclusion === "FAILURE" || conclusion === "FAILED" || conclusion === "CANCELLED" || status === "FAILURE";
    if (!failed) continue;
    const url = String(item.detailsUrl ?? item.url ?? "");
    const match = url.match(/\/actions\/runs\/(\d+)/);
    if (match) return match[1];
    if (item.databaseId !== undefined) return String(item.databaseId);
    return "";
  }
  return undefined;
}

function readChecks() {
  const found = ensurePr();
  if (!found.ok) return { ok: false, detail: found.detail };
  if (!found.pr?.number) return { ok: false, detail: "no open pull request" };
  prNumber = String(found.pr.number);
  const viewed = ghJson(["pr", "view", prNumber, "--json", "statusCheckRollup,reviewDecision"]);
  if (!viewed.ok) return { ok: false, detail: viewed.result.stderr || viewed.result.stdout };
  return {
    ok: true,
    reviewDecision: String(viewed.value.reviewDecision ?? ""),
    rollup: viewed.value.statusCheckRollup,
  };
}

function unblockStage() {
  if (dryRun) {
    return plan("unblock", [
      "gh pr view --json statusCheckRollup,reviewDecision",
      "gh run rerun --failed <id>",
    ], "a required review is reported, not bypassed");
  }
  const first = readChecks();
  if (!first.ok) return refuse("unblock", "land_blocked", first.detail);
  if (first.reviewDecision === "REVIEW_REQUIRED" || first.reviewDecision === "CHANGES_REQUESTED") {
    return refuse("unblock", "land_blocked", `reviewDecision ${first.reviewDecision}`);
  }
  const runId = failedRunId(first.rollup);
  if (runId === undefined) return pass("unblock", { detail: "checks clear" });
  if (!runId) return refuse("unblock", "land_blocked", "failed check has no run id");
  const rerun = gh(["run", "rerun", "--failed", runId]);
  if (rerun.status !== 0) return refuse("unblock", "land_blocked", rerun.stderr || rerun.stdout);
  const second = readChecks();
  if (!second.ok) return refuse("unblock", "land_blocked", second.detail);
  if (second.reviewDecision === "REVIEW_REQUIRED" || second.reviewDecision === "CHANGES_REQUESTED") {
    return refuse("unblock", "land_blocked", `reviewDecision ${second.reviewDecision}`);
  }
  if (failedRunId(second.rollup) !== undefined) {
    return refuse("unblock", "land_blocked", "failed check remained after one rerun");
  }
  return pass("unblock", { detail: `reran ${runId}` });
}

function nameWithOwner() {
  const viewed = ghJson(["repo", "view", "--json", "nameWithOwner"]);
  if (!viewed.ok || typeof viewed.value.nameWithOwner !== "string" || !viewed.value.nameWithOwner.includes("/")) {
    return undefined;
  }
  return viewed.value.nameWithOwner;
}

function versionCompare(left, right) {
  const split = (value) => value.replace(/^v/, "").split(/(\d+)/).filter(Boolean);
  const a = split(left);
  const b = split(right);
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const x = a[index] ?? "";
    const y = b[index] ?? "";
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function newestTag() {
  const listed = run("git", ["ls-remote", "--tags", "origin"]);
  if (listed.status !== 0) return { ok: false, detail: listed.stderr || listed.stdout };
  const tags = [];
  for (const line of listed.stdout.split("\n")) {
    if (!line.trim() || line.includes("^{}")) continue;
    const ref = line.split("\t")[1] ?? "";
    const name = ref.replace(/^refs\/tags\//, "");
    if (name.startsWith("v")) tags.push(name);
  }
  tags.sort(versionCompare);
  return { ok: true, tag: tags.length > 0 ? tags[tags.length - 1] : "" };
}

function readReleaseContext() {
  return readJson(join(root, RELEASE_CONTEXT)) ?? {};
}

function writeReleaseContext(patch) {
  const next = { ...readReleaseContext(), ...patch };
  writeLog("land-release-context.json", next);
}

function poll(waitMs, read) {
  const attempts = Math.max(1, Math.ceil(waitMs / Math.max(POLL_MS, 1)));
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = read();
    if (last.done) return last;
    if (attempt < attempts - 1) sleep(POLL_MS);
  }
  return last ?? { done: false };
}

function mergeStage() {
  if (dryRun) {
    return plan("merge", [
      "gh api graphql enablePullRequestAutoMerge mergeMethod SQUASH",
      "gh api -X PUT repos/{owner}/{repo}/pulls/{n}/merge -f merge_method=squash",
      "gh pr view --json state",
    ], "squash only; poll up to 20 minutes");
  }
  const found = ensurePr();
  if (!found.ok || !found.pr?.number) return refuse("merge", "land_merge_failed", found.detail || "no open pull request");
  prNumber = String(found.pr.number);
  const title = String(found.pr.title ?? branchName());
  const nodeId = String(found.pr.id ?? "");
  const tags = newestTag();
  writeReleaseContext({ tag: tags.ok ? tags.tag : "", title, recordedAt: new Date().toISOString() });
  const ownerRepo = nameWithOwner();
  if (!ownerRepo) return refuse("merge", "land_merge_failed", "gh repo view did not return nameWithOwner");
  const query = "mutation($pullRequestId:ID!,$mergeMethod:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,mergeMethod:$mergeMethod}){pullRequest{number}}}";
  const auto = gh(["api", "graphql", "-f", `query=${query}`, "-f", `pullRequestId=${nodeId}`, "-f", "mergeMethod=SQUASH"]);
  const autoText = `${auto.stdout}\n${auto.stderr}`;
  if (auto.status !== 0 && /clean status/i.test(autoText)) {
    const merged = gh([
      "api",
      "-X",
      "PUT",
      `repos/${ownerRepo}/pulls/${prNumber}/merge`,
      "-f",
      "merge_method=squash",
      "-f",
      `commit_title=${title} (#${prNumber})`,
    ]);
    if (merged.status !== 0) return refuse("merge", "land_merge_failed", merged.stderr || merged.stdout);
  } else if (auto.status !== 0) {
    return refuse("merge", "land_merge_failed", auto.stderr || auto.stdout);
  }
  const polled = poll(MERGE_WAIT_MS, () => {
    const viewed = ghJson(["pr", "view", prNumber, "--json", "state"]);
    if (viewed.ok && viewed.value.state === "MERGED") return { done: true, merged: true };
    return { done: false };
  });
  if (!polled.merged) return refuse("merge", "land_merge_failed", "pull request was not MERGED within 20 minutes");
  writeReleaseContext({ mergedAt: new Date().toISOString(), title });
  return pass("merge", { detail: `squashed #${prNumber}` });
}

function selectRun(runs, title, after, earliest = false) {
  if (!Array.isArray(runs)) return undefined;
  const matches = runs.filter((runRow) => {
    if (!runRow || typeof runRow !== "object") return false;
    const display = String(runRow.displayTitle ?? "");
    if (!earliest && title && !display.includes(title)) return false;
    const created = Date.parse(String(runRow.createdAt ?? ""));
    if (earliest) {
      if (!Number.isFinite(after) || !Number.isFinite(created) || created <= after) return false;
    } else if (Number.isFinite(after) && Number.isFinite(created) && created < after) {
      return false;
    }
    return true;
  });
  matches.sort((left, right) => {
    const delta = Date.parse(String(left.createdAt ?? "")) - Date.parse(String(right.createdAt ?? ""));
    return earliest ? delta : -delta;
  });
  return matches[0];
}

function workflowRunId(run) {
  if (!run || typeof run !== "object" || run.databaseId === undefined || run.databaseId === null) return "";
  return String(run.databaseId);
}

function noteReleaseWait(workflow, started, logged) {
  const minutes = Math.floor((Date.now() - started) / RELEASE_PROGRESS_MS) * 2;
  if (minutes < 2 || minutes <= logged.minutes) return;
  logged.minutes = minutes;
  emit({ stage: "release", ok: true, detail: `waiting ${workflow} ${minutes}m` });
}

function waitForWorkflow(workflow, title, after, earliest = false) {
  const started = Date.now();
  const logged = { minutes: 0 };
  let failure = "";
  const polled = poll(RELEASE_WAIT_MS, () => {
    const listed = ghJson(["run", "list", `--workflow=${workflow}`, "--json", "databaseId,status,conclusion,displayTitle,createdAt"]);
    if (!listed.ok) {
      noteReleaseWait(workflow, started, logged);
      return { done: false, detail: listed.result.stderr || listed.result.stdout };
    }
    const match = selectRun(listed.value, title, after, earliest);
    if (!match) {
      noteReleaseWait(workflow, started, logged);
      return { done: false };
    }
    const conclusion = String(match.conclusion ?? "").toLowerCase();
    const status = String(match.status ?? "").toLowerCase();
    if (conclusion === "success") return { done: true, run: match };
    if (conclusion && conclusion !== "success" && status === "completed") {
      failure = `${workflow} concluded ${conclusion}`;
      return { done: true, failed: true };
    }
    noteReleaseWait(workflow, started, logged);
    return { done: false };
  });
  if (polled.failed) return { ok: false, detail: failure };
  if (!polled.run) return { ok: false, detail: `${workflow} did not succeed` };
  return { ok: true, run: polled.run };
}

function releaseStage() {
  if (dryRun) {
    return plan("release", [
      "gh run list --workflow=auto-release.yml --json databaseId,status,conclusion,displayTitle,createdAt",
      "git ls-remote --tags origin",
      "gh run list --workflow=release.yml --json databaseId,status,conclusion,displayTitle,createdAt",
      "npm view @kontextmind/kxm@<version> version",
    ], "npm poll is 10 minutes; Release is matched by time after Auto-Release");
  }
  const context = readReleaseContext();
  const found = ensurePr();
  const title = String(context.title ?? found.pr?.title ?? "");
  const after = Date.parse(String(context.mergedAt ?? ""));
  const auto = waitForWorkflow("auto-release.yml", title, after);
  if (!auto.ok) return refuse("release", "land_release_failed", auto.detail);
  const tags = newestTag();
  if (!tags.ok) return refuse("release", "land_release_failed", tags.detail);
  const previous = String(context.tag ?? "");
  if (!tags.tag || (previous && versionCompare(tags.tag, previous) <= 0)) {
    return refuse("release", "land_release_failed", `tag ${tags.tag || "(none)"} is not newer than ${previous || "(none)"}`);
  }
  const autoCreated = Date.parse(String(auto.run?.createdAt ?? ""));
  const release = waitForWorkflow("release.yml", "", autoCreated, true);
  if (!release.ok) return refuse("release", "land_release_failed", release.detail);
  const autoReleaseRunId = workflowRunId(auto.run);
  const releaseRunId = workflowRunId(release.run);
  writeReleaseContext({ autoReleaseRunId, releaseRunId });
  const version = tags.tag.replace(/^v/, "");
  const published = poll(PUBLISH_WAIT_MS, () => {
    const viewed = run("npm", ["view", `@kontextmind/kxm@${version}`, "version"]);
    if (viewed.status === 0 && viewed.stdout.trim() === version) return { done: true, version };
    return { done: false };
  });
  if (!published.version) return refuse("release", "land_publish_timeout", `npm view @kontextmind/kxm@${version} version`);
  return pass("release", { detail: `PUBLISHED ${published.version} auto-release ${autoReleaseRunId} release ${releaseRunId}` });
}

function taskStatuses(tasks) {
  if (Array.isArray(tasks)) {
    return tasks.map((task) => (task && typeof task === "object" && typeof task.status === "string" ? task.status : "open"));
  }
  if (tasks && typeof tasks === "object") {
    return Object.values(tasks).map((task) => (task && typeof task === "object" && typeof task.status === "string" ? task.status : "open"));
  }
  return [];
}

function phaseList(value) {
  const phases = value && typeof value === "object" ? value.phases : undefined;
  const listed = [];
  if (Array.isArray(phases)) {
    for (const phase of phases) {
      if (!phase || typeof phase !== "object") continue;
      listed.push({ id: typeof phase.id === "string" ? phase.id : "", statuses: taskStatuses(phase.tasks) });
    }
  } else if (phases && typeof phases === "object") {
    for (const [id, phase] of Object.entries(phases)) {
      const body = phase && typeof phase === "object" ? phase : {};
      listed.push({ id, statuses: taskStatuses(body.tasks) });
    }
  }
  return listed;
}

function flippedPhase(before, after) {
  const prior = new Map(before.map((phase) => [phase.id, phase]));
  for (const phase of after) {
    const previous = prior.get(phase.id);
    if (!previous) continue;
    const hadOpen = previous.statuses.some((status) => status !== "done");
    const allDone = phase.statuses.length > 0 && phase.statuses.every((status) => status === "done");
    if (hadOpen && allDone) return phase.id;
  }
  return undefined;
}

function milestoneText() {
  if (bodyFile && existsSync(bodyFile.startsWith("/") ? bodyFile : join(root, bodyFile))) {
    const text = readFileSync(bodyFile.startsWith("/") ? bodyFile : join(root, bodyFile), "utf8");
    return text.match(/^Milestone:\s*(.+)\s*$/m)?.[1]?.trim();
  }
  const found = ensurePr();
  const body = typeof found.pr?.body === "string" ? found.pr.body : "";
  return body.match(/^Milestone:\s*(.+)\s*$/m)?.[1]?.trim();
}

function milestoneStage() {
  if (dryRun) {
    return plan("milestone", [
      `read ${STATE_FILE}`,
      "compare phases before and after docs",
    ], "deep review is /reanalyze-roadmap, not this script");
  }
  const statePath = join(root, STATE_FILE);
  if (!existsSync(statePath)) {
    return pass("milestone", { detail: "milestone: skipped (state absent)", deep_review_required: false });
  }
  const afterValue = readJson(statePath);
  if (!afterValue) return refuse("milestone", "land_milestone_failed", `${STATE_FILE} is not readable JSON`);
  const beforePath = join(root, PHASE_SNAPSHOT);
  const beforeValue = existsSync(beforePath) ? readJson(beforePath) : undefined;
  const phase = beforeValue ? flippedPhase(phaseList(beforeValue), phaseList(afterValue)) : undefined;
  let named;
  try {
    named = milestoneText();
  } catch {
    named = undefined;
  }
  if (phase || named) {
    return pass("milestone", {
      deep_review_required: true,
      phase: phase || named,
      detail: "deep review is /reanalyze-roadmap and is not run here",
    });
  }
  return pass("milestone", { deep_review_required: false });
}

const STAGE_FN = {
  verify: verifyStage,
  docs: docsStage,
  push: pushStage,
  pr: prStage,
  rebase: rebaseStage,
  unblock: unblockStage,
  merge: mergeStage,
  release: releaseStage,
  milestone: milestoneStage,
};

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) return usage(parsed.error);
  if (parsed.options.help) {
    emit({
      stage: "usage",
      ok: true,
      detail: "node scripts/pr-land.mjs [--pr <n>] [--title <text>] [--body-file <path>] [--stage <name>] [--json] [--dry-run]",
    });
    return 0;
  }
  dryRun = parsed.options.dryRun;
  bodyFile = parsed.options.bodyFile;
  requestedTitle = parsed.options.title;
  prNumber = parsed.options.pr;
  const names = parsed.options.stage ? [parsed.options.stage] : STAGES;
  for (const name of names) {
    const code = STAGE_FN[name]();
    if (code !== 0) return code;
  }
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  process.exitCode = main();
}
