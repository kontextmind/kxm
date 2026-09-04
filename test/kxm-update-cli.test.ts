import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli as runCliImplementation, type CliIo } from "../plugins/kxm/src/cli.ts";
import { noticeFromVersions, writeUpdateCache } from "../plugins/kxm/src/kxm-update.ts";

const currentVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd: string): Promise<number> {
  const isolatedLogs = mkdtempSync(join(tmpdir(), "kxm-update-cli-logs-"));
  try {
    return await runCliImplementation(argv, { KXM_LOGS_DIR: isolatedLogs, KXM_STATE_HOME: isolatedLogs, ...env }, io, cwd);
  } finally {
    rmSync(isolatedLogs, { recursive: true, force: true });
  }
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    read: () => ({ stdout, stderr }),
  };
}

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "kxm-update-cli-"));
  mkdirSync(join(root, ".kxm"), { recursive: true });
  return root;
}

function writeUpdateYaml(root: string, body: string): void {
  writeFileSync(join(root, ".kxm", "update.yaml"), body);
}

function githubFetch(tag = "v99.0.0", status = 200): NonNullable<CliIo["fetchImpl"]> {
  return async (input) => {
    const url = String(input);
    if (url.includes("api.github.com/repos/kontextmind/kxm/releases/latest")) {
      return new Response(JSON.stringify({ tag_name: tag }), { status });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

function npmFetch(version = "99.0.0", status = 200): NonNullable<CliIo["fetchImpl"]> {
  return async (input) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org/@kontextmind/kxm/latest")) {
      return new Response(JSON.stringify({ version }), { status });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test("update --check reports a newer GitHub release", async () => {
  const cwd = tempProject();
  try {
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, { ...io, fetchImpl: githubFetch("v99.0.0") }, cwd), 0);
    const payload = JSON.parse(io.read().stdout) as {
      command: string;
      available: boolean;
      current: string;
      latest: string;
      source: string;
    };
    assert.equal(payload.command, "update check");
    assert.equal(payload.current, currentVersion);
    assert.equal(payload.latest, "99.0.0");
    assert.equal(payload.available, true);
    assert.equal(payload.source, "github");
    assert.match(io.read().stdout, /kxm update --kxm/);
    assert.equal(existsUpdateCache(cwd), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update --check stays quiet when already current or the check fails", async () => {
  const cwd = tempProject();
  try {
    const current = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, {
      ...current,
      fetchImpl: githubFetch(`v${currentVersion}`),
    }, cwd), 0);
    const currentPayload = JSON.parse(current.read().stdout) as { available: boolean; message: string };
    assert.equal(currentPayload.available, false);
    assert.equal(currentPayload.message, `kxm ${currentVersion}`);

    const failed = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, {
      ...failed,
      fetchImpl: githubFetch("v99.0.0", 503),
    }, cwd), 0);
    assert.match(failed.read().stdout, /kxm update check unavailable \(github_http_503\)/);

    const nonSemver = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, {
      ...nonSemver,
      fetchImpl: githubFetch("not-a-version"),
    }, cwd), 0);
    assert.match(nonSemver.read().stdout, /kxm update check unavailable/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update --check uses npm when update.yaml selects it", async () => {
  const cwd = tempProject();
  try {
    writeUpdateYaml(cwd, "schema: kxm.update.v1\nauto: false\nsource: npm\n");
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, { ...io, fetchImpl: npmFetch("99.1.0") }, cwd), 0);
    const payload = JSON.parse(io.read().stdout) as { source: string; latest: string; available: boolean };
    assert.equal(payload.source, "npm");
    assert.equal(payload.latest, "99.1.0");
    assert.equal(payload.available, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update rejects conflicting flags and invalid update.yaml", async () => {
  const cwd = tempProject();
  try {
    const checkKxm = capture();
    assert.equal(await runCli(["update", "--json", "--check", "--kxm"], {}, { ...checkKxm, fetchImpl: githubFetch() }, cwd), 2);
    assert.match(checkKxm.read().stderr, /scope_conflict/);

    const twoScopes = capture();
    assert.equal(await runCli(["update", "--json", "--self", "--models"], {}, { ...twoScopes, fetchImpl: githubFetch() }, cwd), 2);
    assert.match(twoScopes.read().stderr, /scope_conflict/);

    writeUpdateYaml(cwd, "schema: kxm.update.v1\nauto: maybe\n");
    const invalid = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, { ...invalid, fetchImpl: githubFetch() }, cwd), 2);
    assert.match(invalid.read().stderr, /kxm_update_config_invalid/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update --kxm dry-run plans a GitHub tarball install and skips harnesses", async () => {
  const cwd = tempProject();
  try {
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "--kxm"], {}, { ...io, fetchImpl: githubFetch("v99.0.0") }, cwd), 0);
    const payload = JSON.parse(io.read().stdout) as {
      command: string;
      dryRun: boolean;
      notice: { available: boolean; latest: string };
      kxm: { ok: boolean; detail: string };
      steps?: unknown;
    };
    assert.equal(payload.command, "update");
    assert.equal(payload.dryRun, true);
    assert.equal(payload.notice.available, true);
    assert.equal(payload.kxm.ok, true);
    assert.match(payload.kxm.detail, /gh release download v99\.0\.0/);
    assert.match(payload.kxm.detail, /kxm-99\.0\.0\.tgz/);
    assert.equal(payload.steps, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update --kxm dry-run is a no-op when no package update is available", async () => {
  const cwd = tempProject();
  try {
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "--kxm"], {}, {
      ...io,
      fetchImpl: githubFetch(`v${currentVersion}`),
    }, cwd), 0);
    const payload = JSON.parse(io.read().stdout) as { kxm?: unknown; notice: { available: boolean; message: string } };
    assert.equal(payload.notice.available, false);
    assert.equal(payload.kxm, undefined);
    assert.equal(payload.notice.message, `kxm ${currentVersion}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update dry-run with auto applies kxm then still plans harness updates", async () => {
  const cwd = tempProject();
  try {
    writeUpdateYaml(cwd, "schema: kxm.update.v1\nauto: true\nsource: github\n");
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run"], {}, { ...io, fetchImpl: githubFetch("v99.0.0") }, cwd), 0);
    const payload = JSON.parse(io.read().stdout) as {
      notice: { auto: boolean; available: boolean };
      kxm: { ok: boolean; detail: string };
      steps: unknown[];
      scope: string;
    };
    assert.equal(payload.notice.auto, true);
    assert.equal(payload.notice.available, true);
    assert.match(payload.kxm.detail, /gh release download/);
    assert.equal(payload.scope, "all");
    assert.ok(Array.isArray(payload.steps));
    assert.match(io.read().stdout, /kxm update --kxm \(auto\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update dry-run unknown harness is fail-closed", async () => {
  const cwd = tempProject();
  try {
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "not-a-harness"], {}, {
      ...io,
      fetchImpl: githubFetch(`v${currentVersion}`),
    }, cwd), 2);
    const payload = JSON.parse(io.read().stderr) as { ok: boolean; steps: Array<{ detail?: string }> };
    assert.equal(payload.ok, false);
    assert.ok(payload.steps.some((step) => step.detail === "unknown_harness"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update --kxm reports installer failure without applying harness updates", async () => {
  const cwd = tempProject();
  const previousPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "kxm-empty-path-"));
  try {
    const io = capture();
    const code = await runCli(["update", "--json", "--kxm"], {}, { ...io, fetchImpl: githubFetch("v99.0.0") }, cwd);
    assert.equal(code, 1);
    const payload = JSON.parse(io.read().stderr) as { ok: boolean; kxm?: { ok: boolean; detail: string } };
    assert.equal(payload.ok, false);
    assert.equal(payload.kxm?.ok, false);
    assert.ok((payload.kxm?.detail ?? "").length > 0);
  } finally {
    process.env.PATH = previousPath;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update --kxm dry-run plans npm install when source is npm", async () => {
  const cwd = tempProject();
  try {
    writeUpdateYaml(cwd, "schema: kxm.update.v1\nauto: false\nsource: npm\n");
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "--kxm"], {}, { ...io, fetchImpl: npmFetch("99.0.0") }, cwd), 0);
    const payload = JSON.parse(io.read().stdout) as { kxm: { detail: string }; notice: { source: string } };
    assert.equal(payload.notice.source, "npm");
    assert.match(payload.kxm.detail, /@kontextmind\/kxm@99\.0\.0/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("harness list, runtime dry-run, and dash screens cover adjacent CLI branches", async () => {
  const cwd = tempProject();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-cli-state-"));
  try {
    const harness = capture();
    assert.equal(await runCli(["harness", "--json", "list"], {}, { ...harness, fetchImpl: githubFetch() }, cwd), 0);
    assert.match(harness.read().stdout, /"command":"harness list"/);

    const self = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "--self"], {}, { ...self, fetchImpl: githubFetch(`v${currentVersion}`) }, cwd), 0);
    assert.match(self.read().stdout, /"scope":"self"/);

    const runtimeEnv = { KXM_STATE_HOME: stateHome };
    const runtimeStart = capture();
    assert.equal(await runCli(["runtime", "--json", "--dry-run", "start"], runtimeEnv, runtimeStart, cwd), 0);
    assert.match(runtimeStart.read().stdout, /"command":"runtime start"/);

    const runtimeStatus = capture();
    assert.equal(await runCli(["runtime", "--json", "status"], runtimeEnv, runtimeStatus, cwd), 1);
    assert.match(runtimeStatus.read().stdout, /"running":false/);

    const runtimeStop = capture();
    assert.equal(await runCli(["runtime", "--json", "stop"], runtimeEnv, runtimeStop, cwd), 0);
    assert.match(runtimeStop.read().stdout, /"stopped":false/);

    const dashUnknown = capture();
    assert.equal(await runCli(["dash", "--json", "--screen", "nope"], {}, dashUnknown, cwd), 2);
    assert.match(dashUnknown.read().stderr, /unknown_screen/);

    const dashJson = capture();
    assert.equal(await runCli(["dash", "--json"], {}, {
      ...dashJson,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }, cwd), 2);
    assert.match(dashJson.read().stderr, /does not support --json/);

    const skills = capture();
    assert.equal(await runCli([
      "skills", "--json", "--dry-run", "create",
      "--file", join(cwd, "missing.md"),
      "--name", "demo",
      "--created-by", "tester",
      "--harness", "pi",
      "--models", "xai/grok-4.6",
    ], {}, skills, cwd), 0);
    assert.match(skills.read().stdout, /"dryRun":true/);

    const skillsFail = capture();
    assert.equal(await runCli([
      "skills", "create",
      "--file", join(cwd, "missing.md"),
      "--name", "demo",
      "--created-by", "tester",
      "--harness", "pi",
      "--models", "xai/grok-4.6",
    ], {}, skillsFail, cwd), 1);
    assert.match(skillsFail.read().stderr, /skills create failed/);

    const view = capture();
    assert.equal(await runCli(["hub", "--json", "view"], {}, {
      ...view,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }, cwd), 1);
    assert.match(view.read().stderr, /hub_unreachable/);

    const sessionBoth = capture();
    assert.equal(await runCli(["session", "start", "--workflow", "wf", "--mix", "coordinator"], {}, sessionBoth, cwd), 2);
    assert.match(sessionBoth.read().stderr, /not both/);
    const sessionNone = capture();
    assert.equal(await runCli(["session", "start"], {}, sessionNone, cwd), 2);
    assert.match(sessionNone.read().stderr, /requires --workflow/);

    const skillsState = capture();
    assert.equal(await runCli(["skills", "--json", "list", "--state", "nope"], {}, skillsState, cwd), 1);
    assert.match(skillsState.read().stderr, /skills list failed|invalid skill state/);

    const skillsEval = capture();
    assert.equal(await runCli([
      "skills", "evaluate", "skill_missing",
      "--kind", "static-review",
      "--evaluator", "v1",
    ], {}, skillsEval, cwd), 1);
    assert.match(skillsEval.read().stderr, /skills evaluate failed/);

    const skillsPromote = capture();
    assert.equal(await runCli([
      "skills", "promote", "skill_missing",
      "--decided-by", "reviewer",
      "--evidence", "ev-1",
    ], {}, skillsPromote, cwd), 1);
    assert.match(skillsPromote.read().stderr, /skills promote failed/);

    const skillsReject = capture();
    assert.equal(await runCli([
      "skills", "reject", "skill_missing",
      "--decided-by", "reviewer",
    ], {}, skillsReject, cwd), 1);
    assert.match(skillsReject.read().stderr, /skills reject failed/);

    const skillsVerify = capture();
    assert.equal(await runCli(["skills", "verify", "skill_missing"], {}, skillsVerify, cwd), 1);
    assert.match(skillsVerify.read().stderr, /skills verify failed/);

    const routing = capture();
    assert.equal(await runCli(["routing", "--json", "report"], {}, routing, cwd), 0);
    assert.match(routing.read().stdout, /"configurations":\[\]/);

    const wfMissing = capture();
    assert.equal(await runCli(["workflow", "start"], {}, wfMissing, cwd), 2);
    assert.match(wfMissing.read().stderr, /requires <definitionId>/);

    const wfPayload = capture();
    assert.equal(await runCli([
      "workflow", "--json", "start", "wf",
      "--payload", "[1]",
    ], { KXM_WORKFLOW_SECRET: "workflow-secret-16chars" }, wfPayload, cwd), 2);
    assert.match(wfPayload.read().stderr, /invalid_payload/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("hub start prints an available update notice", async () => {
  const cwd = tempProject();
  try {
    const io = capture();
    let spawned = 0;
    assert.equal(await runCli(["hub", "start"], {}, {
      ...io,
      fetchImpl: githubFetch("v99.0.0"),
      spawnHub: () => {
        spawned += 1;
        return 0;
      },
    }, cwd), 0);
    assert.equal(spawned, 1);
    assert.match(io.read().stderr, /99\.0\.0 available/);

    rmSync(join(cwd, ".kxm", "state", "update-check.json"), { force: true });
    const current = capture();
    assert.equal(await runCli(["hub", "start"], {}, {
      ...current,
      fetchImpl: githubFetch(`v${currentVersion}`),
      spawnHub: () => 0,
    }, cwd), 0);
    assert.doesNotMatch(current.read().stderr, /available/);

    const dry = capture();
    let dryFetch = 0;
    assert.equal(await runCli(["hub", "--dry-run", "--json", "start"], {}, {
      ...dry,
      fetchImpl: async () => {
        dryFetch += 1;
        throw new Error("dry-run must not check updates");
      },
    }, cwd), 0);
    assert.equal(dryFetch, 0);
    assert.match(dry.read().stdout, /"dryRun":true/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hub start warns on malformed update.yaml and still spawns", async () => {
  const cwd = tempProject();
  try {
    writeUpdateYaml(cwd, "schema: no\nauto: false\n");
    const io = capture();
    let spawned = 0;
    assert.equal(await runCli(["hub", "start"], {}, {
      ...io,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
      spawnHub: () => {
        spawned += 1;
        return 0;
      },
    }, cwd), 0);
    assert.equal(spawned, 1);
    assert.match(io.read().stderr, /kxm: \.kxm\/update\.yaml schema must be kxm\.update\.v1; update check skipped/);
    assert.equal(existsUpdateCache(cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hub start prints the cached notice before spawning and refreshes in the background", async () => {
  const cwd = tempProject();
  try {
    const availableNotice = noticeFromVersions(currentVersion, "99.0.0", {
      schema: "kxm.update.v1",
      auto: false,
      source: "github",
    });
    writeUpdateCache(join(cwd, ".kxm", "state"), availableNotice);
    const io = capture();
    let spawnedAt = 0;
    let fetchResolvedAt = 0;
    assert.equal(await runCli(["hub", "start"], {}, {
      ...io,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        fetchResolvedAt = Date.now();
        return new Response(JSON.stringify({ tag_name: "v99.0.0" }), { status: 200 });
      },
      spawnHub: () => {
        spawnedAt = Date.now();
        return 0;
      },
    }, cwd), 0);
    assert.ok(spawnedAt > 0 && fetchResolvedAt > 0);
    assert.ok(spawnedAt < fetchResolvedAt);
    assert.equal(io.read().stderr, `${availableNotice.message}\n`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function existsUpdateCache(cwd: string): boolean {
  try {
    readFileSync(join(cwd, ".kxm", "state", "update-check.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}
