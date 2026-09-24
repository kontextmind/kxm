import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const checker = resolve("scripts/check-generated.mjs");
const emitter = resolve("scripts/emit-codex-artifacts.mjs");
const {
  GENERATED_ARTIFACTS: artifacts,
  STATIC_GENERATED_ARTIFACTS: staticArtifacts,
  computeGeneratedArtifacts,
  findLockfileDrift,
} = await import(pathToFileURL(checker).href) as {
  GENERATED_ARTIFACTS: readonly string[];
  STATIC_GENERATED_ARTIFACTS: readonly string[];
  computeGeneratedArtifacts: (root?: string) => readonly string[];
  findLockfileDrift: (root?: string) => string[];
};
const { emitCodexArtifacts, CODEX_COMMANDS_BLOCK } = await import(pathToFileURL(emitter).href) as {
  emitCodexArtifacts: (root?: string) => {
    ownedSkills: string[];
    preservedSkills: string[];
    artifacts: string[];
  };
  CODEX_COMMANDS_BLOCK: string;
};

function contextPromoteGeneratorRow(block: string): { command: string; purpose: string; options: string; raw: string } {
  const rows = block.split("\n").filter((line) => /kxm context promote/.test(line));
  assert.equal(rows.length, 1, "generator must emit exactly one context promote row");
  const raw = rows[0]!;
  const cells = [...raw.matchAll(/\|([^|]+)/g)].map((match) => match[1]!.replace(/\\`/g, "`").trim());
  assert.ok(cells.length >= 3, `context promote row must have command, purpose, and options: ${raw}`);
  return { command: cells[0]!, purpose: cells[1]!, options: cells[2]!, raw };
}

function run(cwd: string, command: string, args: string[]) {
  return spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
}

function git(cwd: string, args: string[]): void {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function write(root: string, path: string, body: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, "utf8");
}

function suiteManifest(skills: Array<{ name: string; commands?: string[] }>): string {
  return `${JSON.stringify({
    id: "fixture-suite",
    version: "1.0.0",
    name: "Fixture suite",
    description: "Manifest-backed generated artifact fixture",
    skills: skills.map((skill) => ({
      name: skill.name,
      path: `./skills/${skill.name}`,
      ownedCommands: skill.commands ?? [],
      intent: `Fixture skill ${skill.name} for generated checks`,
    })),
  }, null, 2)}\n`;
}

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "kxm-generated-check-"));
  git(root, ["init", "--quiet"]);
  for (const [index, path] of staticArtifacts.entries()) {
    write(root, path, `artifact-${index}\n`);
  }
  write(root, "plugins/kxm/skill-suite.json", suiteManifest([
    { name: "alpha", commands: ["init"] },
  ]));
  write(root, "plugins/kxm/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha fixture skill\n---\n\n# Alpha\n");
  write(root, "plugins/kxm/skills/alpha/references/note.md", "note\n");
  write(root, ".agents/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha fixture skill\n---\n\n# Alpha\n");
  write(root, ".agents/skills/alpha/references/note.md", "note\n");
  write(root, ".agents/skills/unrelated/SKILL.md", "foreign\n");
  const expected = computeGeneratedArtifacts(root);
  git(root, ["add", "--", ...expected, ".agents/skills/unrelated/SKILL.md", "plugins/kxm/skill-suite.json", "plugins/kxm/skills/alpha/SKILL.md", "plugins/kxm/skills/alpha/references/note.md"]);
  git(root, [
    "-c",
    "user.name=Generated Artifact Test",
    "-c",
    "user.email=generated-artifact-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  return root;
}

test("generated context promote row matches control-plane CLI positionals and required evidence", () => {
  const row = contextPromoteGeneratorRow(CODEX_COMMANDS_BLOCK);
  assert.match(row.command, /kxm context promote <project> <proposalId>/);
  assert.doesNotMatch(row.command, /<key>/);
  assert.match(row.purpose, /approved state proposal/i);
  assert.match(row.purpose, /control plane/i);
  assert.match(row.options, /required/i);
  assert.match(row.options, /--evidence <refs>/);
  assert.doesNotMatch(row.options, /--summary/);
  assert.doesNotMatch(row.options, /--authority/);
  assert.doesNotMatch(row.options, /--confidence/);

  const source = readFileSync(resolve("plugins/kxm/src/cli.ts"), "utf8");
  const promoteStart = source.indexOf('context.command("promote")');
  assert.ok(promoteStart >= 0, "cli.ts must register context promote");
  const promoteEnd = source.indexOf(".action(async function contextPromoteAction", promoteStart);
  assert.ok(promoteEnd > promoteStart, "cli.ts promote registration must include its action");
  const registration = source.slice(promoteStart, promoteEnd);
  assert.match(registration, /\.argument\("<project>"/);
  assert.match(registration, /\.argument\("<proposalId>"/);
  assert.match(registration, /\.requiredOption\("--evidence <refs>"/);
  assert.doesNotMatch(registration, /\.argument\("<key>"/);
  assert.doesNotMatch(registration, /--summary/);
  assert.doesNotMatch(registration, /--authority/);
  assert.doesNotMatch(registration, /--confidence/);
});

test("host generated artifact list is manifest-backed and includes owned mirrors", () => {
  assert.deepEqual(staticArtifacts.slice(0, 8), [
    "plugins/kxm/dist/cli.js",
    "plugins/kxm/dist/server.js",
    "plugins/kxm/dist/mcp-server.js",
    "plugins/kxm/dist/runtime-supervisor.js",
    "plugins/kxm/dist/core.js",
    "plugins/kxm/dist/runtime.js",
    "plugins/kxm/dist/client.js",
    "plugins/kxm/dist/extension.js",
  ]);
  assert.ok(artifacts.includes(".agents/skills/kxm/SKILL.md"));
  assert.ok(artifacts.includes(".agents/skills/kxm/references/protocol.md"));
  assert.ok(artifacts.includes(".agents/skills/kxm-session/SKILL.md"));
  assert.ok(artifacts.includes(".agents/skills/kxm-peer/SKILL.md"));
  assert.equal(artifacts.length, computeGeneratedArtifacts().length);
  assert.ok(artifacts.length > staticArtifacts.length);
});

test("generated artifact check requires every bundle to exist and be tracked and unchanged", () => {
  const roots: string[] = [];
  try {
    const clean = fixtureRepo();
    roots.push(clean);
    const expected = computeGeneratedArtifacts(clean);
    assert.ok(expected.includes(".agents/skills/alpha/SKILL.md"));
    assert.ok(expected.includes(".agents/skills/alpha/references/note.md"));
    assert.equal(expected.includes(".agents/skills/unrelated/SKILL.md"), false);
    const accepted = run(clean, process.execPath, [checker]);
    assert.equal(accepted.status, 0, `${accepted.stderr}\n${accepted.stdout}`);
    assert.match(accepted.stdout, new RegExp(`tracked and current \\(${expected.length}\\)`));

    const missing = fixtureRepo();
    roots.push(missing);
    unlinkSync(join(missing, expected.find((path) => path.endsWith("dist/server.js"))!));
    const missingResult = run(missing, process.execPath, [checker]);
    assert.equal(missingResult.status, 1);
    assert.match(missingResult.stderr, /generated artifacts are missing: .*dist\/server\.js/);

    const untracked = fixtureRepo();
    roots.push(untracked);
    git(untracked, ["rm", "--quiet", "--cached", "--", expected.find((path) => path.endsWith("dist/cli.js"))!]);
    const untrackedResult = run(untracked, process.execPath, [checker]);
    assert.equal(untrackedResult.status, 1);
    assert.match(untrackedResult.stderr, /generated artifacts are not tracked by git: .*dist\/cli\.js/);

    const changed = fixtureRepo();
    roots.push(changed);
    writeFileSync(join(changed, expected.find((path) => path.endsWith("dist/mcp-server.js"))!), "changed-after-build\n", "utf8");
    const changedResult = run(changed, process.execPath, [checker]);
    assert.equal(changedResult.status, 1);
    assert.match(changedResult.stderr, /generated artifacts changed after build:[\s\S]*dist\/mcp-server\.js/);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("missing or malformed skill suite manifest fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-generated-manifest-"));
  try {
    git(root, ["init", "--quiet"]);
    for (const path of staticArtifacts) write(root, path, "x\n");
    const missing = run(root, process.execPath, [checker]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /path is missing: plugins\/kxm\/skill-suite.json|skill suite manifest/);

    write(root, "plugins/kxm/skill-suite.json", "{not-json");
    const malformed = run(root, process.execPath, [checker]);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /malformed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emit copies owned skills, preserves unrelated skills, and refuses symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-emit-"));
  try {
    write(root, "plugins/kxm/skill-suite.json", suiteManifest([
      { name: "alpha" },
    ]));
    write(root, "plugins/kxm/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha\n---\n\nowned\n");
    write(root, "plugins/kxm/skills/alpha/nested/extra.md", "nested\n");
    write(root, ".agents/skills/unrelated/SKILL.md", "keep-me\n");
    write(root, "AGENTS.md", "# Agents\n\n## Do not\n\n- skip\n");
    const emitted = emitCodexArtifacts(root);
    assert.deepEqual(emitted.ownedSkills, ["alpha"]);
    assert.deepEqual(emitted.preservedSkills, ["unrelated"]);
    assert.ok(emitted.artifacts.includes(".agents/skills/alpha/SKILL.md"));
    assert.ok(emitted.artifacts.includes(".agents/skills/alpha/nested/extra.md"));

    write(root, "plugins/kxm/skills/link-skill/SKILL.md", "nope\n");
    const suitePath = join(root, "plugins/kxm/skill-suite.json");
    writeFileSync(suitePath, suiteManifest([
      { name: "alpha" },
      { name: "escaped" },
    ]));
    assert.throws(
      () => emitCodexArtifacts(root),
      /path is missing: plugins\/kxm\/skills\/escaped|invalid skill name|skill path/,
    );

    write(root, "plugins/kxm/skill-suite.json", suiteManifest([{ name: "alpha" }]));
    rmSync(join(root, "plugins/kxm/skills/alpha"), { recursive: true, force: true });
    mkdirSync(join(root, "plugins/kxm/skills"), { recursive: true });
    symlinkSync(join(root, "outside"), join(root, "plugins/kxm/skills/alpha"));
    assert.throws(() => emitCodexArtifacts(root), /symlinks are not allowed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshotTree(dir: string): { names: string[]; files: Record<string, string> } {
  const names = readdirSync(dir, { recursive: true }).map(String).sort();
  const files: Record<string, string> = {};
  for (const rel of names) {
    try {
      files[rel] = readFileSync(join(dir, rel), "utf8");
    } catch {
      // directories are listed but not files
    }
  }
  return { names, files };
}

function emitFixtureWithExternal(linkKind: ".agents" | ".agents/skills"): { root: string; external: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-emit-ancestor-"));
  const external = mkdtempSync(join(tmpdir(), "kxm-emit-external-"));
  write(root, "plugins/kxm/skill-suite.json", suiteManifest([{ name: "alpha" }]));
  write(root, "plugins/kxm/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha\n---\n\nowned\n");
  write(external, "sentinel.txt", "authored fixture\n");
  write(external, "foreign-skill/SKILL.md", "do-not-touch\n");
  if (linkKind === ".agents") {
    symlinkSync(external, join(root, ".agents"));
  } else {
    mkdirSync(join(root, ".agents"), { recursive: true });
    symlinkSync(external, join(root, ".agents", "skills"));
  }
  return { root, external };
}

test("emit refuses .agents ancestor symlink before mutating the external destination", () => {
  const { root, external } = emitFixtureWithExternal(".agents");
  try {
    const before = snapshotTree(external);
    assert.equal(before.files["sentinel.txt"], "authored fixture\n");
    assert.throws(() => emitCodexArtifacts(root), /symlinks are not allowed: \.agents/);
    const after = snapshotTree(external);
    assert.deepEqual(after, before);
    assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "authored fixture\n");
    assert.equal(readFileSync(join(external, "foreign-skill/SKILL.md"), "utf8"), "do-not-touch\n");
    assert.equal(readdirSync(external).includes("alpha"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("emit refuses .agents/skills ancestor symlink before mutating the external destination", () => {
  const { root, external } = emitFixtureWithExternal(".agents/skills");
  try {
    const before = snapshotTree(external);
    assert.equal(before.files["sentinel.txt"], "authored fixture\n");
    assert.throws(() => emitCodexArtifacts(root), /symlinks are not allowed: \.agents\/skills/);
    const after = snapshotTree(external);
    assert.deepEqual(after, before);
    assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "authored fixture\n");
    assert.equal(readFileSync(join(external, "foreign-skill/SKILL.md"), "utf8"), "do-not-touch\n");
    assert.equal(readdirSync(external).includes("alpha"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("check:generated refuses a node_modules that drifted from package-lock.json", () => {
  // The bundles embed dependency bytes and paths. A tree that drifted from the
  // lock therefore builds artifacts that pass on that machine and fail in CI,
  // which installs from the lock on every leg — so the local gate would be
  // certifying a bundle nobody else can reproduce. Exactly this happened: a
  // drifted `node_modules` shipped a `cli.js` through a green `npm run verify`
  // and CI rejected it with an unactionable one-line diff.
  const fixture = mkdtempSync(join(tmpdir(), "kxm-lock-drift-"));
  try {
    mkdirSync(join(fixture, "node_modules", "kept"), { recursive: true });
    writeFileSync(join(fixture, "node_modules", "kept", "package.json"), JSON.stringify({ name: "kept", version: "1.4.0" }));
    mkdirSync(join(fixture, "node_modules", "drifted"), { recursive: true });
    writeFileSync(join(fixture, "node_modules", "drifted", "package.json"), JSON.stringify({ name: "drifted", version: "9.9.9" }));
    writeFileSync(join(fixture, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "0.0.0" },
        "node_modules/kept": { version: "1.4.0" },
        "node_modules/drifted": { version: "1.0.0" },
        "node_modules/not-installed": { version: "3.1.0" },
        "node_modules/platform-optional": { version: "5.0.0", optional: true },
        "plugins/kxm": { version: "0.0.0", link: true },
      },
    }));
    assert.deepEqual(findLockfileDrift(fixture), [
      "drifted: lock 1.0.0, installed 9.9.9",
      "not-installed@3.1.0 is not installed",
    ], "version drift and a missing non-optional package; optional and linked entries are not drift");

    // And this repository, because that is the rule the gate exists to hold.
    assert.deepEqual(findLockfileDrift(process.cwd()), [], "installed tree differs from package-lock.json — run npm ci");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
