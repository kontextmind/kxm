import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { loadSupervisorState, supervisorStatePath } from "../../plugins/kxm/src/supervise-state.ts";

const moduleHref = pathToFileURL(join(process.cwd(), "plugins/kxm/src/supervise-state.ts")).href;
const now = "2026-09-28T21:00:00.000Z";
const duringBackoff = "2026-09-28T21:10:00.000Z";
const afterBackoff = "2026-09-28T21:30:00.000Z";

function capture(): CliIo & { read: () => { stdout: string; stderr: string } } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => { stdout += text; },
    stderr: (text: string) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "kxm-supervise-"));
  const git = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", dir], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  mkdirSync(join(dir, ".kxm"), { recursive: true });
  writeFileSync(join(dir, ".kxm", "project.yaml"), "schema: kxm.project.v1\nname: supervise-fixture\n");
  return dir;
}

function spawnState(op: string, stateDir: string, clock: string, payload = ""): { status: number | null; stdout: string; stderr: string } {
  const code = `
    import { applyObservation, loadSupervisorState, resumeTick, saveSupervisorState } from ${JSON.stringify(moduleHref)};
    const argv = process.argv.slice(1);
    const [op, stateDir, now, payload] = argv;
    const loaded = loadSupervisorState(stateDir, now);
    if (typeof loaded === "string") {
      process.stderr.write(loaded);
      process.exit(1);
    }
    if (op === "record") {
      const next = applyObservation(loaded, JSON.parse(payload), now);
      if (typeof next === "string") {
        process.stderr.write(next);
        process.exit(1);
      }
      saveSupervisorState(stateDir, next);
      process.stdout.write(JSON.stringify(next));
      process.exit(0);
    }
    if (op === "load") {
      process.stdout.write(JSON.stringify(loaded));
      process.exit(0);
    }
    if (op === "tick") {
      const tick = resumeTick(loaded, now);
      saveSupervisorState(stateDir, tick.state);
      process.stdout.write(JSON.stringify(tick));
      process.exit(0);
    }
    process.stderr.write("unknown op");
    process.exit(2);
  `;
  return spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    code,
    "--",
    op,
    stateDir,
    clock,
    payload,
  ], { encoding: "utf8" });
}

test("a restarted process resumes the same lanes, pull request, CI, and backoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-supervise-state-"));
  const observation = JSON.stringify({
    unit: "writer-a",
    inFlight: true,
    pr: { number: 12, mergeState: "BLOCKED" },
    ci: { status: "completed", conclusion: "failure" },
    backoffMs: 1_800_000,
  });
  try {
    const recorded = spawnState("record", dir, now, observation);
    assert.equal(recorded.status, 0, `${recorded.stdout}\n${recorded.stderr}`);
    const reloaded = spawnState("load", dir, now);
    assert.equal(reloaded.status, 0, reloaded.stderr);
    const loaded = JSON.parse(reloaded.stdout) as {
      lanes: Record<string, { inFlight: boolean; pr: { number: number; mergeState: string }; ci: { status: string; conclusion: string }; backoffUntil?: string }>;
    };
    assert.equal(loaded.lanes["writer-a"]?.inFlight, true);
    assert.equal(loaded.lanes["writer-a"]?.pr.number, 12);
    assert.equal(loaded.lanes["writer-a"]?.pr.mergeState, "BLOCKED");
    assert.equal(loaded.lanes["writer-a"]?.ci.status, "completed");
    assert.equal(loaded.lanes["writer-a"]?.ci.conclusion, "failure");
    assert.equal(loaded.lanes["writer-a"]?.backoffUntil, afterBackoff);

    const waiting = spawnState("tick", dir, duringBackoff);
    assert.equal(waiting.status, 0, waiting.stderr);
    const waitingTick = JSON.parse(waiting.stdout) as { resumed: string[]; waiting: string[]; state: { lanes: Record<string, { backoffUntil?: string; inFlight: boolean }> } };
    assert.deepEqual(waitingTick.waiting, ["writer-a"]);
    assert.deepEqual(waitingTick.resumed, []);
    assert.equal(waitingTick.state.lanes["writer-a"]?.backoffUntil, afterBackoff);
    assert.equal(waitingTick.state.lanes["writer-a"]?.inFlight, true);

    const stillWaiting = spawnState("load", dir, duringBackoff);
    assert.equal(JSON.parse(stillWaiting.stdout).lanes["writer-a"].backoffUntil, afterBackoff);

    const resumed = spawnState("tick", dir, afterBackoff);
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedTick = JSON.parse(resumed.stdout) as {
      resumed: string[];
      state: { lanes: Record<string, { inFlight: boolean; backoffUntil?: string; pr: { mergeState: string }; ci: { conclusion: string } }> };
    };
    assert.deepEqual(resumedTick.resumed, ["writer-a"]);
    assert.equal(resumedTick.state.lanes["writer-a"]?.inFlight, true);
    assert.equal(resumedTick.state.lanes["writer-a"]?.backoffUntil, undefined);
    assert.equal(resumedTick.state.lanes["writer-a"]?.pr.mergeState, "BLOCKED");
    assert.equal(resumedTick.state.lanes["writer-a"]?.ci.conclusion, "failure");

    const afterRestart = spawnState("load", dir, afterBackoff);
    const finalState = JSON.parse(afterRestart.stdout) as { lanes: Record<string, { backoffUntil?: string; pr: { number: number } }> };
    assert.equal(finalState.lanes["writer-a"]?.backoffUntil, undefined);
    assert.equal(finalState.lanes["writer-a"]?.pr.number, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown supervisor schema is refused and left on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-supervise-schema-"));
  const path = supervisorStatePath(dir);
  mkdirSync(dir, { recursive: true });
  const original = `${JSON.stringify({ schema: "kxm.supervisor.v0", lanes: {} })}\n`;
  writeFileSync(path, original);
  try {
    assert.equal(loadSupervisorState(dir, now), "supervisor_schema_unsupported");
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kxm supervise records state, resumes after backoff, and refuses a missing project", async () => {
  const outside = mkdtempSync(join(tmpdir(), "kxm-supervise-outside-"));
  const project = makeProject();
  try {
    const missing = capture();
    assert.equal(await runCli(["supervise", "status", "--json"], {}, missing, outside), 1);
    assert.match(missing.read().stderr, /project_required/);

    const recorded = capture();
    const recordCode = await runCli([
      "supervise", "record", "--json",
      "--lane", "writer-a",
      "--pr", "12",
      "--merge-state", "blocked",
      "--ci-status", "completed",
      "--ci-conclusion", "failure",
      "--backoff-ms", "1800000",
    ], { KXM_SUPERVISE_NOW: now }, recorded, project);
    assert.equal(recordCode, 0, `${recorded.read().stdout}\n${recorded.read().stderr}`);
    const recordPayload = JSON.parse(recorded.read().stdout) as { ok: boolean; state: { lanes: Record<string, { pr: { mergeState: string }; backoffUntil: string }> } };
    assert.equal(recordPayload.ok, true);
    assert.equal(recordPayload.state.lanes["writer-a"]?.pr.mergeState, "BLOCKED");
    assert.equal(recordPayload.state.lanes["writer-a"]?.backoffUntil, afterBackoff);

    const dry = capture();
    assert.equal(await runCli([
      "supervise", "tick", "--json", "--dry-run",
    ], { KXM_SUPERVISE_NOW: afterBackoff }, dry, project), 0);
    assert.equal(existsLog(project), false);
    const still = JSON.parse(readFileSync(supervisorStatePath(join(project, ".kxm", "state")), "utf8")) as { lanes: Record<string, { backoffUntil?: string }> };
    assert.equal(still.lanes["writer-a"]?.backoffUntil, afterBackoff);

    const ticked = capture();
    assert.equal(await runCli(["supervise", "tick", "--json"], { KXM_SUPERVISE_NOW: afterBackoff }, ticked, project), 0);
    const tickPayload = JSON.parse(ticked.read().stdout) as { resumed: string[]; state: { lanes: Record<string, { backoffUntil?: string; inFlight: boolean; ci: { conclusion: string } }> } };
    assert.deepEqual(tickPayload.resumed, ["writer-a"]);
    assert.equal(tickPayload.state.lanes["writer-a"]?.backoffUntil, undefined);
    assert.equal(tickPayload.state.lanes["writer-a"]?.inFlight, true);
    assert.equal(tickPayload.state.lanes["writer-a"]?.ci.conclusion, "failure");
    const log = readFileSync(join(project, ".kxm", "logs", "supervisor.log"), "utf8");
    assert.match(log, /\[supervisor\]: resumed writer-a\. Acted: resume writer-a\. - \(21:30\)/);

    const status = capture();
    assert.equal(await runCli(["supervise", "status", "--json"], { KXM_SUPERVISE_NOW: afterBackoff }, status, project), 0);
    const statusPayload = JSON.parse(status.read().stdout) as { state: { lanes: Record<string, { pr: { number: number } }> } };
    assert.equal(statusPayload.state.lanes["writer-a"]?.pr.number, 12);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

function existsLog(project: string): boolean {
  try {
    readFileSync(join(project, ".kxm", "logs", "supervisor.log"), "utf8");
    return true;
  } catch {
    return false;
  }
}
