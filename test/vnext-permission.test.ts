import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import {
  computeVnextPermissionDiff,
  computeVnextResourcePermissionDiff,
  diffVnextProjectAgainstRevision,
  formatVnextPermissionDiff,
  loadVnextProjectAtRevision,
  vnextAuthorityEntries,
  vnextProseEntries,
} from "../plugins/kxm-mesh/src/vnext-permission.ts";
import { VnextSchemaRegistry, loadVnextProject, type JsonObject } from "../plugins/kxm-mesh/src/vnext-config.ts";
import { initializeVnextProject } from "../plugins/kxm-mesh/src/vnext-init.ts";

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function committedProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  makeGitRoot(root);
  initializeVnextProject(root, { projectId: "prj_01JPERMISSIONTEST000000000", projectName: "Permission Test" });
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"]);
  return root;
}

function editProject(root: string, edit: (content: string) => string): void {
  const path = join(root, ".kxm", "agents", "coordinator.yaml");
  writeFileSync(path, edit(readFileSync(path, "utf8")), "utf8");
}

test("secret grants key by ref so removing the first of two reports a single narrowing", () => {
  const base: JsonObject = {
    schema: "kxm.agent.v1", purpose: "x",
    secrets: [{ ref: "alpha", as: "ALPHA" }, { ref: "beta", as: "BETA" }],
  };
  const removed = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, {
    ...base,
    secrets: [{ ref: "beta", as: "BETA" }],
  });
  assert.equal(removed.length, 1, JSON.stringify(removed));
  assert.equal(removed[0]!.direction, "narrowing");
  assert.equal(removed[0]!.path, "/secrets/by-ref/alpha");
});

test("authority projection excludes prose and covers every authority-bearing field", () => {
  const agent: JsonObject = {
    schema: "kxm.agent.v1",
    purpose: "Coordinate work.",
    instructions: "Do things.",
    model: { provider: "anthropic", model: "claude-fable-5-1" },
    executor: "local",
    tools: { preset: "workspace-writer" },
    defaultRepositoryAccess: "read",
    repositories: { control: "write" },
    secrets: [{ ref: "github-token", as: "GITHUB_TOKEN", required: true }],
    network: "provider-only",
    resultSchema: "kxm.assignment-result.v1",
    session: { reuse: "compatible-run-scope" },
  };
  const entries = vnextAuthorityEntries({ kind: "agent", id: "coordinator", value: agent });
  const paths = entries.map((entry) => entry.path);
  for (const expected of ["/model", "/executor", "/tools", "/defaultRepositoryAccess", "/repositories/control", "/secrets/by-ref/github-token", "/network", "/resultSchema", "/session"]) {
    assert(paths.includes(expected), `missing ${expected}`);
  }
  assert(!paths.includes("/purpose") && !paths.includes("/instructions"), "prose is not authority");
  const prose = vnextProseEntries({ kind: "agent", value: agent });
  assert(prose.has("/purpose") && prose.has("/instructions"), "prose tracked separately");
});

test("lattice orders: repository access, network, budgets, quorums, snapshots", () => {
  const base: JsonObject = { schema: "kxm.agent.v1", purpose: "x", defaultRepositoryAccess: "read", network: "provider-only" };
  const accessUp = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, defaultRepositoryAccess: "write" });
  assert.equal(accessUp[0]!.direction, "expansion");
  assert.equal(accessUp[0]!.field, "repository-access");
  const accessDown = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, defaultRepositoryAccess: "none" });
  assert.equal(accessDown[0]!.direction, "narrowing");
  const netUp = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, network: "host" });
  assert.equal(netUp[0]!.direction, "expansion");
  const netDown = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, network: "none" });
  assert.equal(netDown[0]!.direction, "narrowing");

  const budgetBase: JsonObject = { schema: "kxm.workflow.v1", coordinator: "c", limits: { maxTransitions: 10, maxRunDurationMs: 1000 }, steps: [] as never[] };
  const budgetUp = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", budgetBase, { ...budgetBase, limits: { maxTransitions: 20, maxRunDurationMs: 1000 } });
  assert.equal(budgetUp[0]!.direction, "expansion");
  const budgetDown = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", budgetBase, { ...budgetBase, limits: { maxTransitions: 5, maxRunDurationMs: 1000 } });
  assert.equal(budgetDown[0]!.direction, "narrowing");
  const budgetMixed = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", budgetBase, { ...budgetBase, limits: { maxTransitions: 5, maxRunDurationMs: 2000 } });
  assert.equal(budgetMixed[0]!.direction, "expansion", "mixed budget directions fail toward review");

  const quorumBase: JsonObject = { key: "review", kind: "assignment-result", producerPolicy: { minimumProducers: 2, eligibleAgents: ["a", "b"], acceptedStatuses: ["passed"] } };
  const workflowWithPolicy: JsonObject = {
    schema: "kxm.workflow.v1",
    coordinator: "c",
    steps: [{ id: "review", kind: "moa", agent: "a", requiredEvidence: [quorumBase], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const weakened = structuredClone(workflowWithPolicy);
  ((weakened.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.producerPolicy = { minimumProducers: 1, eligibleAgents: ["a", "b"], acceptedStatuses: ["passed"] };
  const weakDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", workflowWithPolicy, weakened);
  assert(weakDiff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"), "lowering the quorum floor expands");

  const degraded = structuredClone(workflowWithPolicy);
  ((degraded.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.producerPolicy = {
    minimumProducers: 2, eligibleAgents: ["a", "b"], acceptedStatuses: ["passed"], degradation: { minimumProducers: 1 },
  };
  const degradedDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", workflowWithPolicy, degraded);
  assert(degradedDiff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"), "introducing degradation expands");

  const strengthened = structuredClone(workflowWithPolicy);
  ((strengthened.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.producerPolicy = { minimumProducers: 3, eligibleAgents: ["a", "b", "c"], acceptedStatuses: ["passed"] };
  const strongDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", workflowWithPolicy, strengthened);
  assert(strongDiff.some((change) => change.field === "evidence-quorum" && change.direction === "narrowing"), "raising the quorum floor narrows");

  const snapshotBase: JsonObject = {
    schema: "kxm.project.v1", id: "prj_x", name: "x",
    repositories: [{ id: "control", role: "control", required: true, pathHint: "." }],
    workspace: { dirtySnapshot: { untracked: "ask", dirtySubmodules: "fail" } },
  };
  const snapshotUp = computeVnextResourcePermissionDiff("project", ".kxm/project.yaml", snapshotBase, {
    ...snapshotBase, workspace: { dirtySnapshot: { untracked: "bounded", maxUntrackedFileBytes: 100, maxUntrackedTotalBytes: 1000, dirtySubmodules: "fail" } },
  });
  assert(snapshotUp.some((change) => change.field === "snapshot-policy" && change.direction === "expansion"), "auto-including untracked content expands");
});

test("secret grants, executors, models, transitions, and shapes classify conservatively", () => {
  const base: JsonObject = {
    schema: "kxm.agent.v1", purpose: "x",
    executor: "local",
    model: { provider: "xai", model: "grok-4.6" },
    secrets: [{ ref: "a", as: "A_TOKEN" }],
  };
  const secretAdded = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, secrets: [...base.secrets as never[], { ref: "b", as: "B_TOKEN" }] });
  assert(secretAdded.some((change) => change.field === "secrets" && change.direction === "expansion"), "new secret grant expands");
  const secretRemoved = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, secrets: [] });
  assert(secretRemoved.some((change) => change.field === "secrets" && change.direction === "narrowing"), "removed grant narrows");
  const executorChanged = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, executor: "ssh" });
  assert.equal(executorChanged[0]!.direction, "expansion");
  const modelChanged = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, model: { provider: "xai", model: "grok-5" } });
  assert.equal(modelChanged[0]!.direction, "expansion", "model ceiling changes are review-required (no conservative order)");

  const transitionBase: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [
      { id: "a", kind: "agent", agent: "c", on: { passed: "b" } },
      { id: "b", kind: "gate", gate: "test", on: { passed: { target: "$terminal", terminalStatus: "completed" } } },
    ],
  };
  const bypassed = structuredClone(transitionBase);
  ((bypassed.steps as JsonObject[])[0]!).on = { passed: { target: "$terminal", terminalStatus: "completed" } };
  const bypassDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", transitionBase, bypassed);
  assert(bypassDiff.some((change) => change.field === "transition" && change.direction === "expansion"), "a completion path bypassing the gate expands");
});

test("prose-only changes are neutral; shape and transition changes are reviewed", () => {
  const base: JsonObject = { schema: "kxm.agent.v1", purpose: "old purpose", network: "none" };
  const prose = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, purpose: "new purpose" });
  assert.equal(prose.length, 1);
  assert.equal(prose[0]!.direction, "neutral");
  const unchanged = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, structuredClone(base));
  assert.equal(unchanged.length, 0, "identical values produce no changes");
});

test("trust diff against HEAD: clean tree is empty, expansions and narrowings classify", () => {
  const root = committedProject("kxm-permission-diff-");
  try {
    const clean = diffVnextProjectAgainstRevision(root, "HEAD");
    assert.equal(clean.changes.length, 0);
    assert.equal(clean.requiresReview, false);
    assert.match(formatVnextPermissionDiff(clean), /no authority-bearing or prose changes/);

    editProject(root, (content) => content.replace("network: provider-only", "network: host"));
    const expanded = diffVnextProjectAgainstRevision(root, "HEAD");
    assert.equal(expanded.requiresReview, true);
    assert(expanded.expansions.some((change) => change.field === "network" && change.direction === "expansion"), JSON.stringify(expanded.expansions));
    assert.match(formatVnextPermissionDiff(expanded), /EXPANSION.*network/);

    editProject(root, (content) => content.replace("network: host", "network: none"));
    const narrowed = diffVnextProjectAgainstRevision(root, "HEAD");
    assert.equal(narrowed.requiresReview, false, "pure narrowing requires no review");
    assert(narrowed.narrowings.some((change) => change.field === "network"));

    // Prose-only edit after restoring network: neutral, no review.
    editProject(root, (content) => content.replace("network: none", "network: provider-only"));
    editProject(root, (content) => content.replace("Coordinate the pinned workflow", "Coordinate the pinned workflow carefully"));
    const proseOnly = diffVnextProjectAgainstRevision(root, "HEAD");
    assert.equal(proseOnly.requiresReview, false);
    assert(proseOnly.neutralChanges.length > 0, "prose change surfaces as neutral");
    assert.equal(proseOnly.expansions.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trust diff requires a valid base revision and a loadable working tree", () => {
  const root = committedProject("kxm-permission-invalid-");
  try {
    assert.throws(() => diffVnextProjectAgainstRevision(root, "HEAD; rm -rf /"), /git_revision_invalid/);
    assert.throws(() => diffVnextProjectAgainstRevision(root, "nonexistent-ref"), /git_base_unavailable/);
    const projectFile = join(root, ".kxm", "project.yaml");
    const original = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, "schema: kxm.project.v1\n", "utf8");
    assert.throws(() => diffVnextProjectAgainstRevision(root, "HEAD"), (error: unknown) => {
      assert(error instanceof Error);
      return /required|schema/i.test((error as Error).message);
    });
    writeFileSync(projectFile, original, "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removing an override with a broader fallback expands (Fable: fallback semantics)", () => {
  const base: JsonObject = {
    schema: "kxm.agent.v1", purpose: "x",
    defaultRepositoryAccess: "write",
    repositories: { prod: "none" },
  };
  const removed = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", base, { ...base, repositories: {} });
  assert(removed.some((change) => change.field === "repository-access" && change.direction === "expansion"),
    "removing the prod:none override widens prod to write via the default fallback");

  // Removing a looser-than-fallback override narrows effective access.
  const baseNarrow: JsonObject = {
    schema: "kxm.agent.v1", purpose: "x",
    defaultRepositoryAccess: "read",
    repositories: { prod: "write" },
  };
  const narrow = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", baseNarrow, { ...baseNarrow, repositories: {} });
  assert(narrow.some((change) => change.field === "repository-access" && change.direction === "narrowing"),
    "removing a write override under a read default narrows prod to read");

  // tools/network removal is never a silent narrowing (runtime default unknown).
  const toolsBase: JsonObject = { schema: "kxm.agent.v1", purpose: "x", tools: { preset: "read-only" }, network: "none" };
  const toolsRemoved = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", toolsBase, { schema: "kxm.agent.v1", purpose: "x" });
  assert(toolsRemoved.some((change) => change.field === "tools" && change.direction === "expansion"));
  assert(toolsRemoved.some((change) => change.field === "network" && change.direction === "expansion"));
});

test("quorum gaps: join changes, oracle retargets, minimum lowering, reusable evidence all expand", () => {
  const joinBase: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "review", kind: "moa", agent: "a", join: { strategy: "all" }, on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const joinWeakened = structuredClone(joinBase);
  ((joinWeakened.steps as JsonObject[])[0]!).join = { strategy: "first-success", cancelRemaining: true };
  const joinDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", joinBase, joinWeakened);
  assert(joinDiff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"), "all → first-success weakens the join and expands");

  const oracleBase: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    reproOracle: { stageId: "verify", evidenceKey: "repro" },
    steps: [{ id: "verify", kind: "agent", agent: "c", requiredEvidence: [{ key: "repro", kind: "artifact" }], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const retargeted = structuredClone(oracleBase);
  retargeted.reproOracle = { stageId: "verify", evidenceKey: "other" };
  const oracleDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", oracleBase, retargeted);
  assert(oracleDiff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"), "oracle retarget expands");

  const reqBase: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "s", kind: "agent", agent: "c", requiredEvidence: [{ key: "x", kind: "artifact", minimum: 2 }], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const minLowered = structuredClone(reqBase);
  ((minLowered.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.minimum = 1;
  const minDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", reqBase, minLowered);
  assert(minDiff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"), "lowering evidence minimum expands");

  const reused = structuredClone(reqBase);
  ((reused.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0] = { key: "x", kind: "artifact", minimum: 2, reusableAcrossAttempts: true };
  const reuseDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", reqBase, reused);
  assert(reuseDiff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"), "reusable evidence expands");
});

test("model tags are authority: retagging retargets consumers and expands", () => {
  const base: JsonObject = { schema: "kxm.model.v1", provider: "anthropic", model: "claude-fable-5-1", tags: ["critic"] };
  const retagged = computeVnextResourcePermissionDiff("model", ".kxm/models/critic.yaml", base, { ...base, tags: ["implementation"] });
  assert(retagged.some((change) => change.field === "model" && change.direction === "expansion" && change.path === "/tags"));
  const prose = computeVnextResourcePermissionDiff("model", ".kxm/models/critic.yaml", base, structuredClone(base));
  assert.equal(prose.length, 0);
});

test("trust base revision: HEAD~1 accepted, tree pinned, member worktree projects diff", () => {
  const root = committedProject("kxm-permission-rev-");
  try {
    // Second commit changing nothing authority-bearing (prose-only).
    editProject(root, (content) => content.replace("Coordinate the pinned workflow", "Coordinate the pinned workflow carefully"));
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "prose"]);
    const diff = diffVnextProjectAgainstRevision(root, "HEAD~1");
    assert(diff.neutralChanges.length > 0, "HEAD~1 accepted and compares against the prose commit's parent");
    assert.equal(diff.requiresReview, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Member worktree project: nested member with its own Git root validates in
  // the shadow (shadow Git roots are initialized by the loader).
  const memberRoot = mkdtempSync(join(tmpdir(), "kxm-permission-member-"));
  try {
    cpFixture(memberRoot);
    const diff = diffVnextProjectAgainstRevision(memberRoot, "HEAD");
    assert.equal(diff.changes.length, 0, JSON.stringify(diff.changes.slice(0, 3)));
    const projectFile = join(memberRoot, ".kxm", "agents", "critic-1.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace("network: provider-only", "network: host"), "utf8");
    const expanded = diffVnextProjectAgainstRevision(memberRoot, "HEAD");
    assert(expanded.requiresReview);
    assert(expanded.expansions.some((change) => change.field === "network"));
  } finally {
    rmSync(memberRoot, { recursive: true, force: true });
  }
});

function cpFixture(root: string): void {
  cpSync("examples/vnext", root, { recursive: true });
  for (const nested of ["repositories/api", "repositories/web"]) {
    const nestedRoot = join(root, nested);
    makeGitRoot(nestedRoot);
    spawnSync("git", ["-C", nestedRoot, "add", "-A"], { windowsHide: true });
    const nestedCommit = spawnSync("git", ["-C", nestedRoot, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "fixture"], { windowsHide: true });
    assert.equal(nestedCommit.status, 0, nestedCommit.stderr as unknown as string);
  }
  makeGitRoot(root);
  spawnSync("git", ["-C", root, "add", "-A"], { windowsHide: true });
  const commit = spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "fixture"], { windowsHide: true });
  assert.equal(commit.status, 0, commit.stderr as unknown as string);
}

test("malicious Git tree entries are rejected, never written outside the shadow", () => {
  const root = committedProject("kxm-permission-traversal-");
  try {
    // Craft a nested tree whose subtree entry names ".." using plumbing.
    const blob = spawnSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "malicious\n", encoding: "utf8", windowsHide: true });
    assert.equal(blob.status, 0, blob.stderr);
    const blobSha = blob.stdout.trim();
    const inner = spawnSync("git", ["-C", root, "mktree"], { input: `100644 blob ${blobSha}\t..\n`, encoding: "utf8", windowsHide: true });
    assert.equal(inner.status, 0, inner.stderr);
    const outer = spawnSync("git", ["-C", root, "mktree"], { input: `040000 tree ${inner.stdout.trim()}\t.kxm\n`, encoding: "utf8", windowsHide: true });
    assert.equal(outer.status, 0, outer.stderr);
    assert.throws(
      () => loadVnextProjectAtRevision(root, outer.stdout.trim()),
      /git_tree_path_invalid|git_base_unavailable/,
    );
    assert.equal(existsSync(join(root, "escape.txt")), false, "no bytes escaped the shadow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment value hashes are never emitted in the report", () => {
  const envBase: JsonObject = { schema: "kxm.environment.v1", values: { REGION: "us-east", TIER: "prod" } };
  const envChanged = computeVnextResourcePermissionDiff("environment", ".kxm/project/env.yaml", envBase, { ...envBase, values: { REGION: "eu-west", TIER: "prod" } });
  const envChange = envChanged.find((change) => change.field === "environment");
  assert(envChange, "environment change is reported");
  assert.equal(envChange.baseValueSha256, undefined, "base value hash omitted for environment values");
  assert.equal(envChange.candidateValueSha256, undefined, "candidate value hash omitted for environment values");
});

test("quorum: reusable-evidence narrowing never masks a weakened producer policy", () => {
  const base: JsonObject = {
    key: "x", kind: "assignment-result", reusableAcrossAttempts: true,
    producerPolicy: { minimumProducers: 2, eligibleAgents: ["a", "b"], acceptedStatuses: ["passed"] },
  };
  const baseWorkflow: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "s", kind: "moa", agent: "a", requiredEvidence: [base], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const weakened = structuredClone(baseWorkflow);
  ((weakened.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0] = {
    key: "x", kind: "assignment-result",
    producerPolicy: { minimumProducers: 1, eligibleAgents: ["a"], acceptedStatuses: ["passed"] },
  };
  const diff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", baseWorkflow, weakened);
  assert(diff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"),
    "dropping reusableAcrossAttempts while weakening the policy must still expand (no narrowing mask)");

  const narrowed = structuredClone(baseWorkflow);
  ((narrowed.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0] = {
    key: "x", kind: "assignment-result",
    producerPolicy: { minimumProducers: 2, eligibleAgents: ["a", "b"], acceptedStatuses: ["passed"] },
  };
  const narrowDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", baseWorkflow, narrowed);
  assert(narrowDiff.some((change) => change.field === "evidence-quorum" && change.direction === "narrowing"),
    "dropping reusableAcrossAttempts alone narrows");
});

test("scalar budgets: lowering attempts or timeouts narrows, raising expands", () => {
  const base: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "s", kind: "agent", agent: "c", maxAttempts: 3, timeoutMs: 1000, on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const lowered = structuredClone(base);
  (lowered.steps as JsonObject[])[0]!.maxAttempts = 1;
  (lowered.steps as JsonObject[])[0]!.timeoutMs = 500;
  const down = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", base, lowered);
  assert(down.every((change) => change.direction === "narrowing"), JSON.stringify(down));
  const raised = structuredClone(base);
  (raised.steps as JsonObject[])[0]!.maxAttempts = 10;
  const up = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", base, raised);
  assert(up.some((change) => change.direction === "expansion" && change.path.endsWith("/maxAttempts")));
});

test("removing a model resource expands (tag retargeting), removing an agent narrows", () => {
  const root = committedProject("kxm-permission-modelrm-");
  try {
    // Add a second model profile, commit, then remove it.
    mkdirSync(join(root, ".kxm", "models"), { recursive: true });
    const modelFile = join(root, ".kxm", "models", "critic.yaml");
    writeFileSync(modelFile, "schema: kxm.model.v1\nprovider: anthropic\nmodel: claude-fable-5-1\ntags:\n  - critic\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "add model"]);
    rmSync(modelFile);
    const diff = diffVnextProjectAgainstRevision(root, "HEAD");
    assert(diff.expansions.some((change) => change.resource === ".kxm/models/critic.yaml" && change.direction === "expansion"),
      "removing a model profile expands (tag consumers can retarget)");

    const spareFile = join(root, ".kxm", "agents", "spare.yaml");
    writeFileSync(spareFile, "schema: kxm.agent.v1\npurpose: Unreferenced spare agent.\nnetwork: none\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "add spare"]);
    rmSync(spareFile);
    const agentDiff = diffVnextProjectAgainstRevision(root, "HEAD");
    assert(agentDiff.narrowings.some((change) => change.resource === ".kxm/agents/spare.yaml" && change.direction === "narrowing"),
      "removing an unreferenced agent narrows");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("member base content comes from the pinned gitlink, never a moved same-named ref", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-permission-gitlink-"));
  try {
    cpFixture(root);
    // Advance the api member past the pinned gitlink with an authority change.
    const apiRepoFile = join(root, "repositories", "api", ".kxm", "repo", "repo.yaml");
    writeFileSync(apiRepoFile, readFileSync(apiRepoFile, "utf8").replace("defaultAccess: read", "defaultAccess: write"), "utf8");
    const apiRoot = join(root, "repositories", "api");
    spawnSync("git", ["-C", apiRoot, "add", "-A"], { windowsHide: true });
    const advanced = spawnSync("git", ["-C", apiRoot, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "widen api access"], { windowsHide: true });
    assert.equal(advanced.status, 0, advanced.stderr as unknown as string);
    // Control HEAD still pins the older gitlink commit; the member worktree is ahead.
    const diff = diffVnextProjectAgainstRevision(root, "HEAD");
    assert(diff.expansions.some((change) => change.field === "repository-access" && change.direction === "expansion"),
      `member advanced past the pinned gitlink must show as expansion, got ${JSON.stringify(diff.changes.slice(0, 4))}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host-local bound members materialize under the shadow and fail closed on missing revisions", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-permission-bound-"));
  const member = mkdtempSync(join(tmpdir(), "kxm-permission-bound-api-"));
  try {
    // Build a control project declaring a member without a pathHint.
    makeGitRoot(root);
    initializeVnextProject(root, { projectId: "prj_01JBOUNDTEST0000000000000", projectName: "Bound Test" });
    const projectFile = join(root, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace(
      "  - id: control\n    role: control\n    required: true\n    pathHint: .\n",
      "  - id: control\n    role: control\n    required: true\n    pathHint: .\n  - id: api\n    role: member\n    required: true\n",
    ), "utf8");
    makeGitRoot(member);
    mkdirSync(join(member, ".kxm", "repo"), { recursive: true });
    writeFileSync(join(member, ".kxm", "repo", "repo.yaml"), [
      "schema: kxm.repository.v1",
      "projectId: prj_01JBOUNDTEST0000000000000",
      "repositoryId: api",
      "defaultAccess: read",
      "",
    ].join("\n"), "utf8");
    spawnSync("git", ["-C", member, "add", "-A"], { windowsHide: true });
    const memberCommit = spawnSync("git", ["-C", member, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "api"], { windowsHide: true });
    assert.equal(memberCommit.status, 0, memberCommit.stderr as unknown as string);
    spawnSync("git", ["-C", root, "add", "-A"], { windowsHide: true });
    const controlCommit = spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "control"], { windowsHide: true });
    assert.equal(controlCommit.status, 0, controlCommit.stderr as unknown as string);

    const bindings = { api: member };
    const clean = diffVnextProjectAgainstRevision(root, "HEAD", { repositoryBindings: bindings });
    assert.equal(clean.changes.length, 0, JSON.stringify(clean.changes.slice(0, 3)));

    // Advance the bound member with an authority change: visible as expansion.
    writeFileSync(join(member, ".kxm", "repo", "repo.yaml"), readFileSync(join(member, ".kxm", "repo", "repo.yaml"), "utf8").replace("defaultAccess: read", "defaultAccess: write"), "utf8");
    const expanded = diffVnextProjectAgainstRevision(root, "HEAD", { repositoryBindings: bindings });
    assert(expanded.expansions.some((change) => change.field === "repository-access" && change.direction === "expansion"),
      `bound member authority change must surface, got ${JSON.stringify(expanded.changes.slice(0, 4))}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(member, { recursive: true, force: true });
  }
});

test("candidate-added bound member reports as expansion, never a load failure", () => {
  const root = committedProject("kxm-permission-addmember-");
  const member = mkdtempSync(join(tmpdir(), "kxm-permission-addmember-api-"));
  try {
    // Add a bound member in the candidate that base does not declare.
    makeGitRoot(member);
    mkdirSync(join(member, ".kxm", "repo"), { recursive: true });
    writeFileSync(join(member, ".kxm", "repo", "repo.yaml"), [
      "schema: kxm.repository.v1",
      "projectId: prj_01JPERMISSIONTEST000000000",
      "repositoryId: api",
      "defaultAccess: write",
      "",
    ].join("\n"), "utf8");
    spawnSync("git", ["-C", member, "add", "-A"], { windowsHide: true });
    const memberCommit = spawnSync("git", ["-C", member, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "api"], { windowsHide: true });
    assert.equal(memberCommit.status, 0, memberCommit.stderr as unknown as string);
    const projectFile = join(root, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace(
      "  - id: control\n    role: control\n    required: true\n    pathHint: .\n",
      "  - id: control\n    role: control\n    required: true\n    pathHint: .\n  - id: api\n    role: member\n    required: true\n",
    ), "utf8");
    const diff = diffVnextProjectAgainstRevision(root, "HEAD", { repositoryBindings: { api: member } });
    assert(diff.expansions.some((change) => change.field === "resource-shape" && change.direction === "expansion"),
      `adding a bound member must surface as expansion, got ${JSON.stringify(diff.changes.slice(0, 4))}`);
    assert.equal(diff.requiresReview, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(member, { recursive: true, force: true });
  }
});

test("gitignored nested member (pathHint without gitlink) fails with trust_scope_unsupported", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-permission-gitignored-"));
  try {
    cpFixture(root);
    // Remove the gitlink from the control index (simulating a gitignored member).
    spawnSync("git", ["-C", root, "rm", "--cached", "repositories/api", "--quiet"], { windowsHide: true });
    const unlinked = spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "unlink api"], { windowsHide: true });
    assert.equal(unlinked.status, 0, unlinked.stderr as unknown as string);
    assert.throws(
      () => diffVnextProjectAgainstRevision(root, "HEAD"),
      (error: unknown) => {
        assert(error instanceof Error);
        return /trust_scope_unsupported|git_base_unavailable/.test((error as Error).message);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence minimum raise narrows; unknown residual policy fields expand", () => {
  const baseReq: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "s", kind: "agent", agent: "c", requiredEvidence: [{ key: "x", kind: "artifact", minimum: 1 }], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const raised = structuredClone(baseReq);
  ((raised.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.minimum = 3;
  const raiseDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", baseReq, raised);
  assert(raiseDiff.some((change) => change.field === "evidence-quorum" && change.direction === "narrowing"),
    "raising evidence minimum narrows");

  const basePolicy: JsonObject = {
    key: "x", kind: "assignment-result",
    producerPolicy: { minimumProducers: 1, eligibleAgents: ["a"], acceptedStatuses: ["passed"] },
  };
  const baseWf: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "s", kind: "moa", agent: "a", requiredEvidence: [basePolicy], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const futureField = structuredClone(baseWf);
  (((futureField.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.producerPolicy as JsonObject).futureField = true;
  const residualDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", baseWf, futureField);
  assert(residualDiff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"),
    "unclassified policy field additions expand (future-proof fail-closed)");
});

test("hostile base repository ids are rejected before any shadow write", () => {
  const root = committedProject("kxm-permission-hostile-");
  try {
    // Craft a base commit whose project.yaml declares a traversal member id
    // against an EXISTING gitlinked worktree so the id check is what fires.
    const projectFile = join(root, ".kxm", "project.yaml");
    const original = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, original.replace(
      "  - id: control\n    role: control\n    required: true\n    pathHint: .\n",
      "  - id: control\n    role: control\n    required: true\n    pathHint: .\n  - id: ../../../evil\n    role: member\n    required: true\n    pathHint: repositories\n",
    ), "utf8");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "hostile id"]);
    writeFileSync(projectFile, original, "utf8");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "restore"]);
    assert.throws(
      () => diffVnextProjectAgainstRevision(root, "HEAD~1"),
      (error: unknown) => {
        assert(error instanceof Error);
        return /git_tree_path_invalid|not a valid identifier/.test((error as Error).message);
      },
    );
    assert.equal(existsSync(resolve(tmpdir(), "..", "evil")), false, "no escape directory was created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const reserved = committedProject("kxm-permission-reserved-");
  try {
    const projectFile = join(reserved, ".kxm", "project.yaml");
    const original = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, original.replace(
      "  - id: control\n    role: control\n    required: true\n    pathHint: .\n",
      "  - id: control\n    role: control\n    required: true\n    pathHint: .\n  - id: con\n    role: member\n    pathHint: repositories\n",
    ), "utf8");
    git(reserved, ["add", "-A"]);
    git(reserved, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "device name id"]);
    writeFileSync(projectFile, original, "utf8");
    git(reserved, ["add", "-A"]);
    git(reserved, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "restore"]);
    assert.throws(
      () => diffVnextProjectAgainstRevision(reserved, "HEAD~1"),
      (error: unknown) => {
        assert(error instanceof Error);
        return /not a valid identifier|git_tree_path_invalid/.test((error as Error).message);
      },
      "Windows device-name ids are rejected by the loader's reserved-name rule",
    );
  } finally {
    rmSync(reserved, { recursive: true, force: true });
  }
});

test("narrowing early returns never bypass the residual expansion check", () => {
  const baseReq: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "s", kind: "agent", agent: "c", requiredEvidence: [{ key: "x", kind: "artifact", minimum: 1 }], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const raisedPlus = structuredClone(baseReq);
  ((raisedPlus.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0] = { key: "x", kind: "artifact", minimum: 2, futureTopLevel: true };
  const diff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", baseReq, raisedPlus);
  assert(diff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"),
    "raising minimum while adding an unknown field expands (residual check runs first)");

  const basePolicy: JsonObject = {
    key: "x", kind: "assignment-result",
    producerPolicy: { minimumProducers: 1, eligibleAgents: ["a"], acceptedStatuses: ["passed"] },
  };
  const baseWf: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "s", kind: "moa", agent: "a", requiredEvidence: [basePolicy], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const policyRaisedPlus = structuredClone(baseWf);
  (((policyRaisedPlus.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.producerPolicy as JsonObject).minimumProducers = 2;
  (((policyRaisedPlus.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.producerPolicy as JsonObject).futureField = true;
  const policyDiff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", baseWf, policyRaisedPlus);
  assert(policyDiff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"),
    "raising producer minimum while adding a policy field expands");
});

test("portable member in base, host-local bound in candidate: shadow binding wins and diffs", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-permission-rebind-"));
  const member = mkdtempSync(join(tmpdir(), "kxm-permission-rebind-api-"));
  try {
    cpFixture(root);
    // Rebind the portable api member to an external clone with an authority
    // change, and remove the PORTABLE worktree's .git so only the bound clone
    // (which keeps the full history) can serve the pinned tree.
    cpSync(join(root, "repositories", "api"), member, { recursive: true });
    const repoFile = join(member, ".kxm", "repo", "repo.yaml");
    writeFileSync(repoFile, readFileSync(repoFile, "utf8").replace("defaultAccess: read", "defaultAccess: write"), "utf8");
    rmSync(join(root, "repositories", "api", ".git"), { recursive: true, force: true });
    const diff = diffVnextProjectAgainstRevision(root, "HEAD", { repositoryBindings: { api: member } });
    assert(diff.expansions.some((change) => change.field === "repository-access" && change.direction === "expansion"),
      `rebound member authority change must surface, got ${JSON.stringify(diff.changes.slice(0, 4))}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(member, { recursive: true, force: true });
  }
});

test("optional base members with no worktree are skipped like the loader tolerates them", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-permission-optional-"));
  try {
    cpFixture(root);
    // Mark api optional in both base and candidate, then delete its worktree.
    const projectFile = join(root, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace(
      "    role: member\n    required: true\n    remoteIdentity: ssh://git.example.test/payments/api.git\n",
      "    role: member\n    required: false\n    remoteIdentity: ssh://git.example.test/payments/api.git\n",
    ), "utf8");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "api optional"]);
    rmSync(join(root, "repositories", "api"), { recursive: true, force: true });
    const diff = diffVnextProjectAgainstRevision(root, "HEAD");
    assert(diff, "optional missing member must not hard-fail the trust diff");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new eligible producer at the same quorum floor expands (more passing combinations)", () => {
  const base: JsonObject = {
    key: "x", kind: "assignment-result",
    producerPolicy: { minimumProducers: 2, eligibleAgents: ["a", "b"], acceptedStatuses: ["passed"] },
  };
  const baseWf: JsonObject = {
    schema: "kxm.workflow.v1", coordinator: "c",
    steps: [{ id: "s", kind: "moa", agent: "a", requiredEvidence: [base], on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  const widened = structuredClone(baseWf);
  (((widened.steps as JsonObject[])[0]!.requiredEvidence as JsonObject[])[0]!.producerPolicy as JsonObject).eligibleAgents = ["a", "b", "c"];
  const diff = computeVnextResourcePermissionDiff("workflow", ".kxm/workflows/w.yaml", baseWf, widened);
  assert(diff.some((change) => change.field === "evidence-quorum" && change.direction === "expansion"),
    "adding a producer at the same floor expands (a+c and b+c now pass)");
});

test("removed member with a missing worktree fails with a clear trust_scope_unsupported message", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-permission-missingwt-"));
  try {
    cpFixture(root);
    rmSync(join(root, "repositories", "api"), { recursive: true, force: true });
    assert.throws(
      () => diffVnextProjectAgainstRevision(root, "HEAD"),
      (error: unknown) => {
        assert(error instanceof Error);
        return /trust_scope_unsupported|no resolvable worktree/.test((error as Error).message);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret grants: required normalization and environment name renames classify correctly", () => {
  const baseAgent: JsonObject = {
    schema: "kxm.agent.v1", purpose: "x",
    secrets: [{ ref: "token", as: "TOKEN", required: false }],
  };
  const becameRequired = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", baseAgent, {
    ...baseAgent,
    secrets: [{ ref: "token", as: "TOKEN" }],
  });
  assert(becameRequired.some((change) => change.field === "secrets" && change.direction === "expansion"),
    "optional grant becoming mandatory (required omitted = schema default true) expands");
  const becameOptional = computeVnextResourcePermissionDiff("agent", ".kxm/agents/a.yaml", {
    ...baseAgent,
    secrets: [{ ref: "token", as: "TOKEN" }],
  }, baseAgent);
  assert(becameOptional.some((change) => change.field === "secrets" && change.direction === "narrowing"),
    "mandatory grant becoming optional narrows");

  // Environment secret grants use `name` for the exposed variable: renaming
  // the exposure is an expansion even with the same ref.
  const baseEnv: JsonObject = {
    schema: "kxm.environment.v1",
    secrets: [{ ref: "token", name: "OLD_TOKEN" }],
  };
  const renamed = computeVnextResourcePermissionDiff("environment", ".kxm/project/env.yaml", baseEnv, {
    ...baseEnv,
    secrets: [{ ref: "token", name: "NEW_TOKEN" }],
  });
  assert(renamed.some((change) => change.field === "secrets" && change.direction === "expansion"),
    "renaming the exposed environment variable expands");
});

test("whole-resource environment add/remove omits value hashes like field-level changes", () => {
  const root = committedProject("kxm-permission-envshape-");
  try {
    const envFile = join(root, ".kxm", "project", "env.yaml");
    mkdirSync(join(root, ".kxm", "project"), { recursive: true });
    writeFileSync(envFile, "schema: kxm.environment.v1\nvalues:\n  REGION: us-east\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "env"]);
    rmSync(envFile);
    const diff = diffVnextProjectAgainstRevision(root, "HEAD");
    const shape = diff.changes.find((change) => change.resource === ".kxm/project/env.yaml");
    assert(shape, "environment resource removal is reported");
    assert.equal(shape.baseValueSha256, undefined, "no content hash for environment resource shapes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission diff reports validate against the exact contract schema", () => {
  const root = committedProject("kxm-permission-schema-");
  try {
    editProject(root, (content) => content.replace("network: provider-only", "network: restricted"));
    const diff = diffVnextProjectAgainstRevision(root, "HEAD");
    // Round-trip through the production registry: the report must validate.
    const registry = new VnextSchemaRegistry();
    const issues = registry.validatePermissionDiff(diff as unknown as JsonObject, "kxm.permission-diff.v1");
    assert.deepEqual(issues, []);
    assert.deepEqual(registry.validatePermissionDiff(structuredClone(diff) as unknown as JsonObject, "kxm.permission-diff.v1"), [], "report survives JSON round trip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
