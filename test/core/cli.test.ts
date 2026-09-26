import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCli as runCliImplementation, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { writeHubEnvRecord } from "../../plugins/kxm/src/hub-env.ts";
import { kxmAssignCliSeams } from "../../plugins/kxm/src/cli/assign.ts";
import { cmdKxmRunStatus, kxmDriveCliSeams } from "../../plugins/kxm/src/cli/project.ts";
import type { Runtime } from "../../plugins/kxm/src/cli/types.ts";
import { kxmLocalBindingFile } from "../../plugins/kxm/src/bindings.ts";
import { hubBindingScope } from "../../plugins/kxm/src/hub-binding.ts";
import { initializeKxmProject } from "../../plugins/kxm/src/init.ts";
import { parse, stringify } from "yaml";
import { createTask, getTask, taskFilePath } from "../../plugins/kxm/src/task-manager.ts";
import { createTestMesh } from "../helpers.ts";

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd = process.cwd()): Promise<number> {
  const isolatedLogs = mkdtempSync(join(tmpdir(), "kxm-cli-telemetry-"));
  try {
    return await runCliImplementation(argv, { KXM_LOGS_DIR: isolatedLogs, KXM_STATE_HOME: isolatedLogs, ...env }, io, cwd);
  } finally {
    rmSync(isolatedLogs, { recursive: true, force: true });
  }
}

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
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

test("kxm routes agent, session, workflow, and gate tooling", async () => {
  const help = capture();
  assert.equal(await runCli(["help"], {}, help), 0);
  assert.match(help.read().stdout, /Usage: kxm/);
  assert.match(help.read().stdout, /\bagent\b/);
  assert.match(help.read().stdout, /\bsession\b/);
  assert.match(help.read().stdout, /\bworkflow\b/);
  assert.match(help.read().stdout, /\bgate\b/);
  assert.match(help.read().stdout, /\brole\b/);
  assert.match(help.read().stdout, /\bexplain\b/);
  const agentHelp = capture();
  assert.equal(await runCli(["agent", "help"], {}, agentHelp), 0);
  assert.match(agentHelp.read().stdout, /Usage: kxm agent/);
  const sessionHelp = capture();
  assert.equal(await runCli(["session", "help"], {}, sessionHelp), 0);
  assert.match(sessionHelp.read().stdout, /Usage: kxm session/);
  assert.match(sessionHelp.read().stdout, /brief/);
  const roleHelp = capture();
  assert.equal(await runCli(["role", "help"], {}, roleHelp), 0);
  assert.match(roleHelp.read().stdout, /Usage: kxm role/);

  const unknownTool = capture();
  assert.equal(await runCli(["nope"], {}, unknownTool), 2);
  const unknownCommand = capture();
  assert.equal(await runCli(["agent", "nope"], {}, unknownCommand), 2);
});

test("kxm mesh fails closed without side effects, including JSON and subcommands", async () => {
  const help = capture();
  assert.equal(await runCli(["help"], {}, help), 0);
  assert.doesNotMatch(help.read().stdout, /\bmesh\b/);
  assert.doesNotMatch(help.read().stderr, /\bmesh\b/);

  const cwd = mkdtempSync(join(tmpdir(), "kxm-mesh-brake-"));
  try {
    const cases = [
      ["mesh"],
      ["mesh", "init"],
      ["mesh", "smoke"],
      ["--json", "mesh"],
      ["mesh", "--json"],
      ["--json", "mesh", "init"],
      ["--workspace", cwd, "mesh", "init"],
      ["--json", "--workspace", cwd, "mesh", "smoke"],
      ["--dry-run", "mesh"],
      ["--json", "--dry-run", "mesh", "init"],
    ];
    for (const argv of cases) {
      const io = capture();
      assert.equal(await runCli(argv, {}, io, cwd), 2, argv.join(" "));
      assert.equal(io.read().stdout, "", argv.join(" "));
      if (argv.includes("--json")) {
        const payload = JSON.parse(io.read().stderr) as { ok: boolean; command: string; error: string; schema: string };
        assert.equal(payload.ok, false);
        assert.equal(payload.command, "mesh");
        assert.equal(payload.error, "removed_command");
        assert.equal(payload.schema, "kxm.cli-result.v1");
      } else {
        assert.match(io.read().stderr, /kxm mesh was removed/);
        assert.match(io.read().stderr, /kxm init/);
        assert.match(io.read().stderr, /kxm hub/);
        assert.match(io.read().stderr, /scripts\/smoke-multi-pi\.mjs/);
      }
    }
    assert.equal(existsSync(join(cwd, ".kxm")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kxm mesh brake defers to Commander for version, help, and invalid options", async () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };

  const version = capture();
  assert.equal(await runCli(["--version", "mesh"], {}, version), 0);
  assert.equal(version.read().stdout.trim(), pkg.version);
  assert.equal(version.read().stderr, "");
  assert.doesNotMatch(version.read().stdout, /removed/);

  const help = capture();
  assert.equal(await runCli(["--help", "mesh"], {}, help), 0);
  assert.match(help.read().stdout, /Usage: kxm/);
  assert.doesNotMatch(help.read().stdout + help.read().stderr, /kxm mesh was removed/);

  const bogus = capture();
  assert.equal(await runCli(["--bogus", "mesh"], {}, bogus), 2);
  assert.match(bogus.read().stderr, /unknown option '--bogus'/);
  assert.doesNotMatch(bogus.read().stderr, /kxm mesh was removed/);

  const jsonMesh = capture();
  assert.equal(await runCli(["--json", "mesh"], {}, jsonMesh), 2);
  assert.equal(jsonMesh.read().stdout, "");
  const payload = JSON.parse(jsonMesh.read().stderr) as { ok: boolean; command: string; error: string; schema: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "mesh");
  assert.equal(payload.error, "removed_command");
  assert.equal(payload.schema, "kxm.cli-result.v1");

  const subcommand = capture();
  assert.equal(await runCli(["mesh", "init"], {}, subcommand), 2);
  assert.match(subcommand.read().stderr, /kxm mesh was removed/);
});

test("kxm --version prints the package version", async () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };
  const io = capture();
  await runCli(["--version"], {}, io);
  assert.equal(io.read().stdout.trim(), pkg.version);
  assert.equal(io.read().stderr, "");
});

test("error payloads carry a schema and land on stderr in JSON and text modes", async () => {
  const json = capture();
  assert.equal(await runCli(["run", "--json"], {}, json), 2);
  assert.equal(json.read().stdout, "");
  const payload = JSON.parse(json.read().stderr) as { schema: string; ok: boolean; command: string; error: string };
  assert.equal(payload.schema, "kxm.cli-result.v1");
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "run");
  assert.equal(payload.error, "workflow_required");

  const text = capture();
  assert.equal(await runCli(["run"], {}, text), 2);
  assert.equal(text.read().stdout, "");
  assert.match(text.read().stderr, /usage: kxm run <workflow>/);

  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-envelope-"));
  try {
    const ok = capture();
    assert.equal(await runCli(["harness", "list", "--json"], { PATH: cwd, APPDATA: cwd, USERPROFILE: cwd }, ok, cwd), 0);
    assert.equal(ok.read().stderr, "");
    assert.equal(JSON.parse(ok.read().stdout).schema, "kxm.cli-result.v1");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kxm docs build and serve dry-run print the command", async () => {
  const build = capture();
  assert.equal(await runCli(["docs", "build", "--dry-run", "--json"], {}, build), 0);
  const buildPayload = JSON.parse(build.read().stdout) as { ok: boolean; command: string; dryRun: boolean; detail: string };
  assert.equal(buildPayload.ok, true);
  assert.equal(buildPayload.command, "docs build");
  assert.equal(buildPayload.dryRun, true);
  assert.equal(buildPayload.detail, "node plans/kxm-roadmap/update-dashboard.mjs");
  assert.equal(build.read().stderr, "");

  const serve = capture();
  assert.equal(await runCli(["docs", "serve", "--dry-run", "--json"], {}, serve), 0);
  const servePayload = JSON.parse(serve.read().stdout) as { ok: boolean; command: string; dryRun: boolean; detail: string };
  assert.equal(servePayload.ok, true);
  assert.equal(servePayload.command, "docs serve");
  assert.equal(servePayload.dryRun, true);
  assert.equal(servePayload.detail, "python3 ops/docs-site/serve.py");
  assert.equal(serve.read().stderr, "");
});

test("agent and gate CLI results share the worker envelope", async () => {
  const agentIo = capture();
  assert.equal(await runCli([
    "agent", "--json", "--dry-run", "worker", "--name", "coordinator", "--project", "demo",
  ], {}, agentIo), 0);
  const agent = JSON.parse(agentIo.read().stdout) as {
    schema: string;
    worker: { schema: string; kind: string; driver: string; name: string };
    command: string;
    outcome: string;
  };
  assert.equal(agent.schema, "kxm.worker-result.v1");
  assert.equal(agent.worker.schema, "kxm.worker.v1");
  assert.equal(agent.worker.kind, "agent");
  assert.equal(agent.worker.driver, "ai");
  assert.equal(agent.command, "worker");
  assert.equal(agent.outcome, "passed");

  const gateIo = capture();
  assert.equal(await runCli([
    "gate", "--json", "validate", "--file", join(tmpdir(), "kxm-missing-workflow.json"),
  ], {}, gateIo), 1);
  const gate = JSON.parse(gateIo.read().stderr) as {
    schema: string;
    worker: { schema: string; kind: string; driver: string; name: string };
    command: string;
    outcome: string;
  };
  assert.equal(gate.schema, "kxm.worker-result.v1");
  assert.equal(gate.worker.schema, "kxm.worker.v1");
  assert.equal(gate.worker.kind, "gate");
  assert.equal(gate.worker.driver, "code");
  assert.equal(gate.command, "validate");
  assert.equal(gate.outcome, "failed");
});

test("init rejects --hub and --hub-url as unknown options", async () => {
  const hub = capture();
  assert.equal(await runCli(["init", "--json", "--hub", "new"], {}, hub), 2);
  const parsed = JSON.parse(hub.read().stdout) as { error?: string; detail?: string };
  assert.equal(parsed.error, "usage_error");
  assert.match(parsed.detail ?? "", /unknown option '--hub'/);
  assert.equal(hub.read().stderr, "");
  const hubUrl = capture();
  assert.equal(await runCli(["init", "--hub-url", "http://127.0.0.1:7331"], {}, hubUrl), 2);
  assert.match(hubUrl.read().stderr, /unknown option '--hub-url'/);
  const help = capture();
  await runCli(["init", "--help"], {}, help);
  assert.doesNotMatch(`${help.read().stdout}${help.read().stderr}`, /--hub/);
});

test("hub bind writes the host binding and reports unknown for a blackholed URL within a second", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kxm-hub-bind-"));
  // This URL is beyond loopback, and a remote binding now requires a resolvable
  // credential (see the refusal test below), so the probe behaviour under test here is
  // exercised with one present rather than by loosening the rule.
  const env = { KXM_STATE_HOME: tmp, KXM_AUTH_TOKEN: "bind-probe-token" };
  const url = "http://10.255.255.1:7331";
  const bindingPath = join(tmp, "hub-binding.json");
  const abortingFetch: NonNullable<CliIo["fetchImpl"]> = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
  try {
    const unknown = capture();
    const started = Date.now();
    assert.equal(await runCli(["hub", "bind", url], env, { ...unknown, fetchImpl: abortingFetch }), 0);
    assert.ok(Date.now() - started < 1000);
    assert.match(unknown.read().stdout, /health=unknown \(no reply within 300 ms\)/);
    assert.match(unknown.read().stdout, /remote/);
    const record = JSON.parse(readFileSync(bindingPath, "utf8")) as { schema: string; url: string; boundAt: string };
    assert.equal(record.schema, "kxm.hub-binding.v1");
    assert.equal(record.url, url);
    assert.equal(record.boundAt, new Date(record.boundAt).toISOString());
    assert.deepEqual(Object.keys(record).sort(), ["boundAt", "schema", "url"]);

    const on = capture();
    assert.equal(await runCli(["hub", "bind", url], env, {
      ...on,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }), 0);
    assert.match(on.read().stdout, /health=on/);

    const off = capture();
    assert.equal(await runCli(["hub", "bind", url], env, {
      ...off,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }), 0);
    assert.match(off.read().stdout, /health=off/);

    const seen: string[] = [];
    const view = capture();
    assert.equal(await runCli(["hub", "--json", "view"], env, {
      ...view,
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }), 0);
    assert.equal(seen.includes(`${url}/health`), true);

    const unbind = capture();
    assert.equal(await runCli(["hub", "unbind"], env, unbind), 0);
    assert.equal(existsSync(bindingPath), false);

    const missing = capture();
    assert.equal(await runCli(["hub", "--json", "unbind"], env, missing), 1);
    assert.match(missing.read().stderr, /hub_not_bound/);

    const invalid = capture();
    assert.equal(await runCli(["hub", "--json", "bind", "ftp://x"], env, invalid), 2);
    assert.match(invalid.read().stderr, /hub_url_invalid/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hub bind refuses a remote hub with no credential and labels the binding scope", async () => {
  // Each case gets its own machine state root: a shared one makes the assertions about
  // "was anything written" depend on the case that ran before it.
  const fresh = () => ({ dir: mkdtempSync(join(tmpdir(), "kxm-hub-bind-")), env: {} as NodeJS.ProcessEnv });
  const replyingFetch: NonNullable<CliIo["fetchImpl"]> = async (input) => {
    if (String(input).endsWith("/ready")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, agents: [], inbox: [] }), { status: 200 });
  };
  const cleanup: string[] = [];
  try {
    // 0. Scope is asserted on the literals themselves before anything consumes it: a
    //    version of this test that only exercised 127.0.0.1 passed while `localhost`
    //    and the IPv6 form were treated as remote.
    assert.equal(hubBindingScope("http://localhost:7331"), "loopback");
    assert.equal(hubBindingScope("http://[::1]:7331"), "loopback");
    assert.equal(hubBindingScope("http://0.0.0.0:7331"), "remote");
    assert.equal(hubBindingScope("http://192.168.1.20:7331"), "remote");

    // 0b. A damaged host credential record is a remote concern **for bind**. A loopback
    //     URL puts no bearer on a wire, so it must keep binding — the first cut of the
    //     guard read the record before checking scope and cost local operators their start.
    const brokenLocal = mkdtempSync(join(tmpdir(), "kxm-hub-bind-broken-local-"));
    cleanup.push(brokenLocal);
    writeFileSync(join(brokenLocal, "hub-env.json"), "{malformed");
    const brokenLocalIo = capture();
    assert.equal(await runCli(["hub", "bind", "http://127.0.0.1:7331"],
      { KXM_STATE_HOME: brokenLocal }, { ...brokenLocalIo, fetchImpl: replyingFetch }), 0);
    assert.match(brokenLocalIo.read().stdout, /loopback · health=on/);
    assert.equal(existsSync(join(brokenLocal, "hub-binding.json")), true);

    // 1. Remote, no credential: refused, payload carries the code, the fix and the
    //    project that needs a token, and nothing is persisted.
    const refused = fresh();
    cleanup.push(refused.dir);
    refused.env = { KXM_STATE_HOME: refused.dir };
    const refusedIo = capture();
    assert.equal(await runCli(["hub", "--json", "bind", "http://10.255.255.1:7331"], refused.env,
      { ...refusedIo, fetchImpl: replyingFetch }), 2);
    const refusedText = `${refusedIo.read().stderr}${refusedIo.read().stdout}`;
    assert.match(refusedText, /hub_bind_unauthenticated/);
    assert.match(refusedText, /"nextAction":"export_kxm_auth_token"/);
    assert.match(refusedText, /KXM_AUTH_TOKEN/);
    assert.match(refusedText, /"project":/);
    assert.equal(existsSync(join(refused.dir, "hub-binding.json")), false);

    // 2. Loopback is not a network path, so the rule must not reach it.
    const local = fresh();
    cleanup.push(local.dir);
    const localIo = capture();
    assert.equal(await runCli(["hub", "bind", "http://127.0.0.1:7331"], { KXM_STATE_HOME: local.dir },
      { ...localIo, fetchImpl: replyingFetch }), 0);
    assert.match(localIo.read().stdout, /loopback · health=on/);
    assert.doesNotMatch(localIo.read().stdout, /token leaves this machine/);

    // 3. Credential present for the *active* project: allowed, and it says what changed.
    const credentialed = fresh();
    cleanup.push(credentialed.dir);
    const credIo = capture();
    assert.equal(await runCli(["hub", "bind", "http://10.255.255.1:7331"],
      { KXM_STATE_HOME: credentialed.dir, KXM_PROJECT: "acme", KXM_AUTH_TOKEN: "tenant-token" },
      { ...credIo, fetchImpl: replyingFetch }), 0);
    assert.match(credIo.read().stdout, /remote · health=on · token leaves this machine/);

    // 4. A record holding only another project's token cannot authorise this one.
    const wrongProject = fresh();
    cleanup.push(wrongProject.dir);
    writeFileSync(join(wrongProject.dir, "hub-env.json"), JSON.stringify({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-20T00:00:00.000Z",
      projectTokens: { other: "test-project-secret" },
    }));
    const wrongIo = capture();
    assert.equal(await runCli(["hub", "--json", "bind", "http://10.255.255.1:7331"],
      { KXM_STATE_HOME: wrongProject.dir, KXM_PROJECT: "acme" },
      { ...wrongIo, fetchImpl: replyingFetch }), 2);
    assert.match(`${wrongIo.read().stderr}${wrongIo.read().stdout}`, /hub_bind_unauthenticated/);
    assert.equal(existsSync(join(wrongProject.dir, "hub-binding.json")), false);

    // 5. A malformed record is a readable configuration failure, not an uncaught throw.
    const broken = fresh();
    cleanup.push(broken.dir);
    writeFileSync(join(broken.dir, "hub-env.json"), "{malformed");
    const brokenIo = capture();
    assert.equal(await runCli(["hub", "--json", "bind", "http://10.255.255.1:7331"],
      { KXM_STATE_HOME: broken.dir }, { ...brokenIo, fetchImpl: replyingFetch }), 2);
    const brokenText = `${brokenIo.read().stderr}${brokenIo.read().stdout}`;
    assert.match(brokenText, /hub_credential_unreadable/);
    assert.match(brokenText, /no binding was written/);

    // 6. Scope is the URL actually contacted. `KXM_SERVER_URL` overrides the stored
    //    binding, so a loopback binding plus a remote override reports `remote`.
    const override = fresh();
    cleanup.push(override.dir);
    const bindIo = capture();
    assert.equal(await runCli(["hub", "bind", "http://127.0.0.1:7331"], { KXM_STATE_HOME: override.dir },
      { ...bindIo, fetchImpl: replyingFetch }), 0);
    const viewIo = capture();
    assert.equal(await runCli(["hub", "--json", "view"],
      { KXM_STATE_HOME: override.dir, KXM_SERVER_URL: "http://10.255.255.1:7331" },
      { ...viewIo, fetchImpl: replyingFetch }), 0);
    const target = (JSON.parse(viewIo.read().stdout) as {
      target?: { url?: string; scope?: string; source?: string };
    }).target;
    assert.equal(target?.scope, "remote");
    assert.equal(target?.url, "http://10.255.255.1:7331");
    assert.equal(target?.source, "env");

    // 7. The text surfaces carry it too; a distinction that only exists in JSON is a
    //    distinction nobody reads.
    const remoteBrief = capture();
    assert.equal(await runCli(["session", "brief", "--status"],
      { KXM_STATE_HOME: override.dir, KXM_SERVER_URL: "http://10.255.255.1:7331" },
      { ...remoteBrief, fetchImpl: replyingFetch }), 0);
    assert.match(remoteBrief.read().stdout, /hub:on\/remote/);
    const localBrief = capture();
    assert.equal(await runCli(["session", "brief", "--status"], { KXM_STATE_HOME: override.dir },
      { ...localBrief, fetchImpl: replyingFetch }), 0);
    assert.match(localBrief.read().stdout, /hub:on(?!\/remote)/);
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
});

test("hub unbind removes a binding whose boundAt is not an ISO timestamp", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kxm-hub-unbind-garbage-"));
  const env = { KXM_STATE_HOME: tmp };
  const bindingPath = join(tmp, "hub-binding.json");
  writeFileSync(bindingPath, `${JSON.stringify({
    schema: "kxm.hub-binding.v1",
    url: "http://127.0.0.1:7331",
    boundAt: "garbage",
  }, null, 2)}\n`);
  try {
    const unbind = capture();
    assert.equal(await runCli(["hub", "unbind"], env, unbind), 0);
    assert.equal(existsSync(bindingPath), false);
    assert.match(unbind.read().stdout, /unbound hub \(record was malformed\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("KXM init creates and revalidates project configuration without legacy environment overrides", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-init-"));
  const dryCwd = mkdtempSync(join(tmpdir(), "kxm-cli-dry-"));
  const legacyCwd = mkdtempSync(join(tmpdir(), "kxm-cli-legacy-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-cli-init-state-"));
  const stateEnv = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    makeGitRoot(dryCwd);
    const unsupportedWorkspace = capture();
    assert.equal(await runCli(["--workspace", join(cwd, "wrong"), "init", "--json"], {}, unsupportedWorkspace, cwd), 2);
    assert.match(unsupportedWorkspace.read().stderr, /"error":"workspace_option_unsupported"/);
    assert.equal(existsSync(join(cwd, ".kxm")), false);

    const createdIo = capture();
    assert.equal(await runCli([
      "init", "--json", "--name", "CLI Project", "--project-id", "prj_01JCLIPROJECT0000000000000",
    ], {
      ...stateEnv,
      KXM_WORKDIR: join(cwd, "must-not-use"),
      KXM_CONFIG_DIR: join(cwd, "also-must-not-use"),
    }, createdIo, cwd), 0);
    const created = JSON.parse(createdIo.read().stdout) as { action: string; mode: string; configRevision: string; files: string[] };
    assert.equal(created.action, "created");
    assert.equal(created.mode, "ready");
    assert.match(created.configRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(created.files.length, 12);
    assert(created.files.includes(".kxm/gates.yaml"));
    assert(created.files.includes(".kxm/routes.yaml"));
    assert.equal(existsSync(join(cwd, ".kxm", "project.yaml")), true);
    assert.equal(existsSync(join(cwd, "must-not-use")), false);

    const repeatedIo = capture();
    assert.equal(await runCli(["init", "--json"], stateEnv, repeatedIo, cwd), 0);
    const repeated = JSON.parse(repeatedIo.read().stdout) as { action: string; configRevision: string };
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.configRevision, created.configRevision);

    const dryIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run"], stateEnv, dryIo, dryCwd), 0);
    assert.match(dryIo.read().stdout, /"action":"planned"/);
    assert.equal(existsSync(join(dryCwd, ".kxm")), false);
    const invalidIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run", "--project-id", "not-a-project-id"], stateEnv, invalidIo, dryCwd), 1);
    assert.match(invalidIo.read().stderr, /"error":"initialization_failed"/);
    assert.equal(existsSync(join(dryCwd, ".kxm")), false);

    const noGitIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run"], stateEnv, noGitIo, legacyCwd), 1);
    assert.match(noGitIo.read().stderr, /git_root_required/);

    makeGitRoot(legacyCwd);
    mkdirSync(join(legacyCwd, ".kxm", "config"), { recursive: true });
    writeFileSync(join(legacyCwd, ".kxm", "config", "agents.json"), "[]\n");
    const invalidMigrationIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run", "--project-id", "invalid"], stateEnv, invalidMigrationIo, legacyCwd), 1);
    assert.match(invalidMigrationIo.read().stderr, /project_id_invalid/);
    const legacyIo = capture();
    assert.equal(await runCli(["init", "--json"], stateEnv, legacyIo, legacyCwd), 1);
    assert.match(legacyIo.read().stderr, /"mode":"legacy"/);
    assert.match(legacyIo.read().stderr, /legacy_state_unsupported/);
    assert.match(legacyIo.read().stderr, /\.kxm\/config\/agents\.json/);
    assert.match(legacyIo.read().stderr, /"plannedOnly":true/);
  } finally {
    for (const root of [cwd, dryCwd, legacyCwd, stateRoot]) rmSync(root, { recursive: true, force: true });
  }
});

test("KXM init CLI resumes a pinned interrupted create", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-resume-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-cli-resume-state-"));
  try {
    makeGitRoot(cwd);
    assert.throws(
      () => initializeKxmProject(cwd, {
        projectId: "prj_01JCLIRESUME0000000000000",
        projectName: "CLI Resume",
        localStateRoot: stateRoot,
        testFaultAt: "prepared",
      }),
      /injected init fault/,
    );
    const output = capture();
    assert.equal(await runCli(["init", "--json"], { KXM_STATE_HOME: stateRoot }, output, cwd), 0);
    const resumed = JSON.parse(output.read().stdout) as { action: string; transactionKind: string; plannedOnly: boolean };
    assert.equal(resumed.action, "resumed");
    assert.equal(resumed.transactionKind, "create");
    assert.equal(resumed.plannedOnly, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("KXM init joins with repeated CLI member bindings stored outside Git", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-join-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-cli-state-"));
  try {
    cpSync(resolve("examples/project"), cwd, { recursive: true });
    makeGitRoot(cwd);
    makeGitRoot(join(cwd, "repositories", "api"));
    makeGitRoot(join(cwd, "repositories", "web"));
    const projectFile = join(cwd, ".kxm", "project.yaml");
    const project = readFileSync(projectFile, "utf8").replace("    pathHint: repositories/api\n", "");
    writeFileSync(projectFile, project);
    const api = join(cwd, "repositories", "api");
    const env = { KXM_STATE_HOME: stateRoot };

    const malformed = capture();
    assert.equal(await runCli(["init", "--json", "--repository", "api"], env, malformed, cwd), 1);
    assert.match(malformed.read().stderr, /repository_binding_argument_invalid/);
    const duplicate = capture();
    assert.equal(await runCli([
      "init", "--json", "--repository", `api=${api}`, "--repository", `api=${api}`,
    ], env, duplicate, cwd), 1);
    assert.match(duplicate.read().stderr, /repository_binding_argument_duplicate/);

    const joinedIo = capture();
    assert.equal(await runCli(["init", "--json", "--repository", `api=${api}`], env, joinedIo, cwd), 0);
    const joined = JSON.parse(joinedIo.read().stdout) as {
      action: string;
      localBindingFile: string;
      bindingsChanged: boolean;
    };
    assert.equal(joined.action, "joined");
    assert.equal(joined.bindingsChanged, true);
    assert.match(joined.localBindingFile, /repository-bindings\.json$/);
    assert.equal(existsSync(kxmLocalBindingFile(cwd, { stateRoot })), true);
    assert.equal(readFileSync(projectFile, "utf8"), project, "join must not rewrite Git configuration");

    const repeatedIo = capture();
    assert.equal(await runCli(["init", "--json"], env, repeatedIo, cwd), 0);
    const repeated = JSON.parse(repeatedIo.read().stdout) as { action: string; localBindingFile: string };
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.localBindingFile, joined.localBindingFile);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("kxm role add --file refuses a roster route that is not a file under .kxm/models", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "kxm-role-add-file-route-")));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-role-add-file-route-state-"));
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JROLEADDFILE000000000000", projectName: "Role file route" });
    const userConfig = join(stateRoot, "user-config");
    const env = { KXM_STATE_HOME: stateRoot, KXM_USER_CONFIG_DIR: userConfig };
    const file = join(cwd, "unknown-role.yaml");
    writeFileSync(file, [
      "schema: kxm.role.v2",
      "id: reviewer",
      "purpose: experiment",
      "permission: read-only",
      "description: From a file",
      "roster:",
      "  - route: missing-route",
      "",
    ].join("\n"));
    for (const scope of ["local", "global"] as const) {
      const io = capture();
      const code = await runCli(["role", "add", "reviewer", "--file", file, "--scope", scope], env, io, cwd);
      assert.equal(code, 1, scope);
      assert.match(io.read().stderr, /kxm: route 'missing-route' is not a file under \.kxm\/models\//);
    }
    assert.equal(existsSync(join(cwd, ".kxm", "roles", "reviewer.yaml")), false);
    assert.equal(existsSync(join(userConfig, "roles", "reviewer.yaml")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("kxm role add refuses a --route that is not a file under .kxm/models", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "kxm-role-add-route-")));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-role-add-route-state-"));
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JROLEADDROUTE000000000", projectName: "Role route" });
    const env = { KXM_STATE_HOME: stateRoot, KXM_USER_CONFIG_DIR: join(stateRoot, "user-config") };
    const io = capture();
    const code = await runCli(["role", "add", "reviewer", "--route", "missing-route", "--description", "Reviewer"], env, io, cwd);
    assert.equal(code, 1);
    assert.match(io.read().stderr, /kxm: route 'missing-route' is not a file under \.kxm\/models\//);
    assert.equal(existsSync(join(cwd, ".kxm", "roles", "reviewer.yaml")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the deleted kxm migrate surface stays deleted: unknown command, not a silent no-op", async () => {
  const io = capture();
  const code = await runCli(["migrate", "plan", "--json"], {}, io, process.cwd());
  const out = io.read();
  assert.notEqual(code, 0, "kxm migrate must not succeed now that the conversion path is gone");
  assert.match(`${out.stdout}${out.stderr}`, /unknown command/i);
  assert.doesNotMatch(`${out.stdout}${out.stderr}`, /"action":"applied"|migration-plan/, "no migration payload may still be produced");
});

test("kxm tenant status reports each source independently and never starts a supervisor", async () => {
  // CLI-level matrix for the portal read: the module test proves composition; this one
  // proves the command itself — its exit codes, its reasons through the real credential and
  // attach paths, and that the labelling is applied by the CLI mapping rather than supplied
  // by a fixture. The supervisor assertion is the attach-only rule: `runtime_supervisor_not_running`
  // can only come from attach refusing, because the ensure path would have started one.
  const cwd = mkdtempSync(join(tmpdir(), "kxm-tenant-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-tenant-cli-state-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "kxm-tenant-elsewhere-"));
  let credRoot: string | undefined;
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JTENANTCLITEST000000000", projectName: "Tenant CLI" });

    const noProjectIo = capture();
    assert.equal(await runCli(["tenant", "status", "--json"], {}, noProjectIo, elsewhere), 1);
    assert.match(noProjectIo.read().stderr, /project_required/);

    const env = { KXM_STATE_HOME: stateRoot, KXM_SERVER_URL: "http://127.0.0.1:9" };
    const downIo = capture();
    assert.equal(await runCli(["tenant", "status", "--json"], env, downIo, cwd), 1, "neither source readable must exit non-zero");
    const down = JSON.parse(downIo.read().stderr) as {
      error: string;
      payload: { hub: { reason: string }; runtime: { reason: string }; degraded: boolean };
    };
    assert.equal(down.error, "tenant_status_no_source");
    assert.equal(down.payload.hub.reason, "hub_unreachable");
    assert.equal(down.payload.runtime.reason, "runtime_supervisor_not_running", "a read attaches; it never conjures a supervisor");
    assert.equal(down.payload.degraded, true);

    // Admin-only resolution, pinned: a persisted record holds both an admin and a project
    // token, and the snapshot route is admin-scoped — the request must carry the admin
    // token. Restoring project-first resolution fails the assertion below.
    credRoot = mkdtempSync(join(tmpdir(), "kxm-tenant-cred-"));
    writeHubEnvRecord(
      { schema: "kxm.hub-env.v1", createdAt: "2026-09-20T00:00:00.000Z", authToken: "kxm_admin_test", projectTokens: { prj_01JTENANTCLITEST000000000: "kxm_proj_test" } },
      { KXM_STATE_HOME: credRoot },
    );
    let sentAuthorization: string | undefined;
    const adminEnv = { KXM_STATE_HOME: credRoot, KXM_SERVER_URL: "http://127.0.0.1:7331" };

    const snapshot = {
      project: "prj_01JTENANTCLITEST000000000",
      fetchedAt: "2026-09-20T12:00:00.000Z",
      agents: [{ id: "a1", name: "coordinator", online: true }],
      openMessageTotal: 0,
      runTotal: 1,
      runs: [{ id: "run_x", status: "running", definitionId: "default" }],
      plans: [],
    };
    const partialIo = capture();
    assert.equal(
      await runCli(["tenant", "status", "--json"], adminEnv, {
        ...partialIo,
        fetchImpl: (async (_input: unknown, init?: RequestInit) => {
          sentAuthorization = (init?.headers as Record<string, string> | undefined)?.authorization;
          return new Response(JSON.stringify(snapshot), { status: 200 });
        }) as unknown as NonNullable<CliIo["fetchImpl"]>,
      }, cwd),
      0,
      "a partial read is a successful read of what was seen",
    );
    assert.equal(sentAuthorization, "Bearer kxm_admin_test", "the snapshot read carries the admin token, never the project token");
    const partial = JSON.parse(partialIo.read().stdout) as {
      ok: boolean;
      hub: { state: string; value: { runs: Array<{ source: string }> } };
      runtime: { state: string; reason: string };
      degraded: boolean;
    };
    assert.equal(partial.ok, true);
    assert.equal(partial.hub.state, "ok");
    assert.equal(partial.hub.value.runs[0]?.source, "hub-projection", "the label comes from the CLI mapping, not a fixture");
    assert.equal(partial.runtime.state, "unavailable");
    assert.equal(partial.runtime.reason, "runtime_supervisor_not_running");
    assert.equal(partial.degraded, true);
  } finally {
    for (const dir of [cwd, stateRoot, elsewhere, ...(credRoot !== undefined ? [credRoot] : [])]) rmSync(dir, { recursive: true, force: true });
  }
});

test("kxm run creates, lists, shows, and cancels a run offline with an auto-started supervisor", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-run-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-run-cli-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JRUNCLI000000000000000", projectName: "Run CLI" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });

    const dryIo = capture();
    assert.equal(await runCli(["run", "default", "--json", "--dry-run", "fix it"], env, dryIo, cwd), 0);
    assert.match(dryIo.read().stdout, /"dryRun":true/);

    const noWorkflowIo = capture();
    assert.equal(await runCli(["run", "missing", "--json"], env, noWorkflowIo, cwd), 1);
    assert.match(noWorkflowIo.read().stderr, /run_workflow_unknown/);

    const runIo = capture();
    assert.equal(await runCli(["run", "default", "--json", "fix the flaky gate"], env, runIo, cwd), 0);
    const created = JSON.parse(runIo.read().stdout) as {
      run: { runId: string; status: string; homeRuntimeId: string; configRevision: string };
      idempotent: boolean;
      supervisor: { runtimeId: string; port: number; started: boolean };
      execution: { status: string; defaultHarness: string; prerequisites: Array<{ field?: string; detail: string }>; nextSteps: { drive: string; status: string; receipt: string } };
    };
    assert.equal(created.run.status, "created");
    assert.equal(created.supervisor.started, true);
    assert.equal(created.execution.status, "not_started");
    assert(created.execution.prerequisites.some((item) => item.field === "gates.test.argv"));
    assert.equal(created.execution.nextSteps.drive, `kxm runs drive ${created.run.runId} --wait`);
    assert.equal(created.execution.nextSteps.receipt, `kxm runs receipt ${created.run.runId} --json`);
    assert(!runIo.read().stdout.includes("flaky gate"), "prompt content never appears in output");

    const listIo = capture();
    assert.equal(await runCli(["runs", "list", "--json"], env, listIo, cwd), 0);
    const list = JSON.parse(listIo.read().stdout) as { runs: Array<{ runId: string; status: string }> };
    assert.equal(list.runs.length, 1);
    assert.equal(list.runs[0]!.runId, created.run.runId);

    const statusIo = capture();
    assert.equal(await runCli(created.execution.nextSteps.status.split(" ").slice(1), env, statusIo, cwd), 0);
    const status = JSON.parse(statusIo.read().stdout) as { run: { status: string; updatedAt: string } };
    assert.equal(status.run.status, "created");

    const cancelDryIo = capture();
    assert.equal(await runCli(["runs", "cancel", created.run.runId, "--json", "--dry-run"], env, cancelDryIo, cwd), 0);
    const stillCreatedIo = capture();
    assert.equal(await runCli(["runs", "status", created.run.runId, "--json"], env, stillCreatedIo, cwd), 0);
    assert.equal((JSON.parse(stillCreatedIo.read().stdout) as { run: { status: string } }).run.status, "created", "dry-run cancel writes nothing");

    const cancelIo = capture();
    assert.equal(await runCli(["runs", "cancel", created.run.runId, "--json"], env, cancelIo, cwd), 0);
    const cancelled = JSON.parse(cancelIo.read().stdout) as { run: { status: string }; idempotent: boolean };
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.idempotent, false);

    const againIo = capture();
    assert.equal(await runCli(["runs", "cancel", created.run.runId, "--json"], env, againIo, cwd), 0);
    assert.equal((JSON.parse(againIo.read().stdout) as { idempotent: boolean }).idempotent, true, "repeated cancel on a terminal run is idempotent");

    const runtimeStatusIo = capture();
    assert.equal(await runCli(["runtime", "status", "--json"], env, runtimeStatusIo, cwd), 0);
    assert.match(runtimeStatusIo.read().stdout, /"running":true/);
    // A running supervisor must answer the sync question too: "is my outbox
    // draining?" is the reason that block exists.
    assert.match(runtimeStatusIo.read().stdout, /"sync":/, "runtime status carries the sync block");

    const stopIo = capture();
    assert.equal(await runCli(["runtime", "stop", "--json"], env, stopIo, cwd), 0);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const stoppedIo = capture();
    assert.equal(await runCli(["runtime", "status", "--json"], env, stoppedIo, cwd), 1);
  } finally {
    try { await runCli(["runtime", "stop", "--json"], env, capture(), cwd); } catch { /* best effort */ }
    await waitForSupervisorExit(env);
    rmWithRetry(cwd);
    rmWithRetry(stateRoot);
  }
});

test("kxm runs drive requires driveId, poll, and accepted before printing success", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-run-drive-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-run-drive-cli-state-"));
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JDRIVECLi0000000000000", projectName: "Drive CLI" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });

    const handle = { runtimeId: "rtm_drivecli", port: 9, token: "tok", started: true as const };
    kxmDriveCliSeams.ensureSupervisor = async () => handle;
    const env = { KXM_STATE_HOME: stateRoot };
    const accepted = {
      ok: true,
      status: "accepted",
      runId: "run_drivecli",
      driveId: "drv_0123456789abcdef01234567",
      poll: "/v1/runs/run_drivecli",
      mode: "simulated",
    };

    const help = capture();
    assert.equal(await runCli(["runs", "drive", "--help"], env, help, cwd), 0);
    assert.match(help.read().stdout, /--simulated/);
    assert.match(help.read().stdout, /exits 0 only for a\s+VERIFIED COMPLETED settlement/);
    assert.match(help.read().stdout, /max 600000/);

    kxmDriveCliSeams.runtimeRequest = async () => accepted;
    const jsonOk = capture();
    assert.equal(await runCli(["runs", "drive", "run_drivecli", "--simulated", "--json"], env, jsonOk, cwd), 0);
    const jsonPayload = JSON.parse(jsonOk.read().stdout) as { ok: boolean; driveId: string; poll: string; status: string };
    assert.equal(jsonPayload.ok, true);
    assert.equal(jsonPayload.driveId, accepted.driveId);
    assert.equal(jsonPayload.poll, accepted.poll);
    assert.equal(jsonPayload.status, "accepted");

    const textOk = capture();
    assert.equal(await runCli(["runs", "drive", "run_drivecli", "--simulated"], env, textOk, cwd), 0);
    assert.match(textOk.read().stdout, /drive drv_0123456789abcdef01234567: accepted \(poll \/v1\/runs\/run_drivecli\)/);

    const malformedBodies: Record<string, unknown>[] = [
      { ...accepted, driveId: "" },
      { ...accepted, driveId: 12 },
      { ok: true, status: "accepted", poll: accepted.poll },
      { ...accepted, poll: "" },
      { ...accepted, poll: 7 },
      { ...accepted, status: "driven" },
      { ...accepted, status: undefined },
    ];
    for (const body of malformedBodies) {
      kxmDriveCliSeams.runtimeRequest = async () => body;
      const jsonBad = capture();
      assert.equal(await runCli(["runs", "drive", "run_drivecli", "--simulated", "--json"], env, jsonBad, cwd), 1);
      const jsonError = JSON.parse(jsonBad.read().stderr) as { ok: boolean; error: string };
      assert.equal(jsonError.ok, false);
      assert.equal(jsonError.error, "run_drive_io_failed");
      const textBad = capture();
      assert.equal(await runCli(["runs", "drive", "run_drivecli", "--simulated"], env, textBad, cwd), 1);
      assert.match(textBad.read().stderr, /run drive failed because a local operation did not complete/);
    }
  } finally {
    delete kxmDriveCliSeams.ensureSupervisor;
    delete kxmDriveCliSeams.runtimeRequest;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});


test("kxm top-level help names the product KXM", async () => {
  const help = capture();
  assert.equal(await runCli(["--help"], {}, help), 0);
  assert.match(help.read().stdout, /KXM local-first orchestration CLI/);
  assert.doesNotMatch(help.read().stdout, /KontextMind/);
});

test("task run refuses unavailable live work before mutation and honors an executable project default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-task-prerequisites-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-task-prerequisites-state-"));
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JTASKRUN0000000000000", projectName: "Task route" });
    const projectFile = join(cwd, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace("defaultHarness: pi", "defaultHarness: claude"));
    for (const agentId of ["coordinator", "implementer"]) {
      const agentPath = join(cwd, ".kxm", "agents", `${agentId}.yaml`);
      const agent = parse(readFileSync(agentPath, "utf8"));
      delete agent.harness;
      writeFileSync(agentPath, stringify(agent));
    }
    const task = createTask(cwd, { title: "Inspect the bug", objective: "Inspect the bug without changing files" });
    const taskBefore = readFileSync(taskFilePath(cwd, task.id), "utf8");
    const env = { KXM_STATE_HOME: stateRoot };
    let supervisorStarts = 0;
    kxmDriveCliSeams.ensureSupervisor = async () => {
      supervisorStarts += 1;
      return { runtimeId: "rtm_taskroute", port: 9, token: "tok", started: true };
    };
    for (const extra of [[], ["--dry-run"]]) {
      const refused = capture();
      assert.equal(await runCli(["task", "run", task.id, "--json", ...extra], env, refused, cwd), 1);
      const failure = JSON.parse(refused.read().stderr) as {
        error: string; defaultHarness: string; execution: { status: string; prerequisites: Array<{ field: string; detail: string }> };
      };
      assert.equal(failure.error, "run_execution_unavailable");
      assert.equal(failure.defaultHarness, "claude");
      assert.equal(failure.execution.status, "not_started");
      assert(failure.execution.prerequisites.some((item) => item.field === "harness" && item.detail.includes("claude") && item.detail.includes("edit")));
      assert(failure.execution.prerequisites.some((item) => item.field === "gates.test.argv" && item.detail.includes(".kxm/gates.yaml")));
      assert.equal(readFileSync(taskFilePath(cwd, task.id), "utf8"), taskBefore);
    }
    assert.equal(supervisorStarts, 0);

    // An unassigned task uses the configured project default, not a hard-coded "default".
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace("defaultWorkflow: default", "defaultWorkflow: inspect"));
    writeFileSync(join(cwd, ".kxm", "workflows", "inspect.yaml"), stringify({
      schema: "kxm.workflow.v1", coordinator: "coordinator",
      steps: [{
        id: "inspect", kind: "agent", agent: "implementer", repositories: { control: "read" },
        on: { passed: { target: "$terminal", terminalStatus: "completed" }, failed: { target: "$terminal", terminalStatus: "failed" } },
      }],
    }));
    rmSync(join(cwd, ".kxm", "roles", "writer.yaml"), { force: true });
    writeFileSync(join(cwd, ".kxm", "agents", "implementer.yaml"), stringify({
      schema: "kxm.agent.v1", purpose: "Inspect the issue", repositories: { control: "write" },
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }));
    writeFileSync(join(cwd, ".kxm", "routes.yaml"), stringify({
      schema: "kxm.routes.v2", admitted: ["anthropic/claude-sonnet-4-6"], disabled: [], roles: {},
    }));
    const dryRun = capture();
    assert.equal(await runCli(["task", "run", task.id, "--json", "--dry-run"], env, dryRun, cwd), 0);
    assert.equal(supervisorStarts, 0);
    assert.equal(readFileSync(taskFilePath(cwd, task.id), "utf8"), taskBefore);
    const requests: string[] = [];
    kxmDriveCliSeams.runtimeRequest = async (_handle, method, path, body) => {
      requests.push(`${method} ${path}`);
      assert(body && typeof body === "object" && "workflowId" in body);
      assert.equal(body.workflowId, "inspect");
      return { ok: true, run: { runId: "run_taskroute", homeRuntimeId: "rtm_taskroute", status: "created", configRevision: `sha256:${"a".repeat(64)}` } };
    };
    const created = capture();
    assert.equal(await runCli(["task", "run", task.id, "--json"], env, created, cwd), 0);
    const result = JSON.parse(created.read().stdout) as { phase?: string; execution: { status: string; defaultHarness: string; prerequisites: unknown[]; nextSteps: { drive: string } } };
    assert.equal(result.phase, undefined);
    assert.equal(result.execution.status, "not_started");
    assert.equal(result.execution.defaultHarness, "claude");
    assert.deepEqual(result.execution.prerequisites, []);
    assert.equal(result.execution.nextSteps.drive, "kxm runs drive run_taskroute --wait");
    assert.deepEqual(requests, ["POST /v1/runs"], "creation does not silently launch a paid harness");
    assert.equal(getTask(cwd, task.id)?.status, "todo", "created is not in progress");
  } finally {
    delete kxmDriveCliSeams.ensureSupervisor;
    delete kxmDriveCliSeams.runtimeRequest;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("harness list reports the current project default rather than the global fallback", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-harness-project-default-"));
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JHARNESSDEFAULT0000000", projectName: "Harness default" });
    const projectFile = join(cwd, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace("defaultHarness: pi", "defaultHarness: claude"));
    const output = capture();
    assert.equal(await runCli(["harness", "list", "--json"], { PATH: cwd, APPDATA: cwd, USERPROFILE: cwd }, output, cwd), 0);
    const inventory = JSON.parse(output.read().stdout) as { defaultHarness: string; harnesses: Array<{ id: string; default: boolean }> };
    assert.equal(inventory.defaultHarness, "claude");
    assert.deepEqual(inventory.harnesses.filter((entry) => entry.default).map((entry) => entry.id), ["claude"]);
    writeFileSync(projectFile, "schema: invalid\n");
    const refused = capture();
    assert.equal(await runCli(["harness", "list", "--json"], {}, refused, cwd), 1);
    assert.equal(refused.read().stdout, "");
    const failure = JSON.parse(refused.read().stderr);
    assert.equal(failure.error, "harness_list_failed");
    assert(failure.issues.some((issue: { file: string }) => issue.file === ".kxm/project.yaml"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kxm runs status prints a drive line and passes the receipt through JSON", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-run-status-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-run-status-cli-state-"));
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JSTATUSCLI000000000000", projectName: "Status CLI" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });

    const handle = { runtimeId: "rtm_statuscli", port: 9, token: "tok", started: true as const };
    kxmDriveCliSeams.ensureSupervisor = async () => handle;
    const receipt = {
      schema: "kxm.drive-receipt.v1",
      driveId: "drv_0123456789abcdef01234567",
      runId: "run_statuscli",
      settlement: { kind: "terminal", status: "completed", reason: "" },
      budget: null,
    };
    const body = {
      ok: true,
      run: {
        runId: "run_statuscli",
        status: "completed",
        workflowId: "one-step",
        configRevision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      drive: {
        driveId: "drv_0123456789abcdef01234567",
        mode: "simulated",
        openedAt: "2026-09-16T00:00:00.000Z",
        receipt,
        verified: true,
      },
    };
    kxmDriveCliSeams.runtimeRequest = async () => body;
    const driveRuntime = (json: boolean, io: CliIo): Runtime => ({
      env: { ...process.env, KXM_STATE_HOME: stateRoot },
      io,
      cwd,
      json,
      dryRun: false,
      dirs: {
        workdir: cwd,
        workspace: cwd,
        config: join(cwd, ".kxm"),
        logs: join(cwd, ".kxm", "logs"),
        assets: join(cwd, ".kxm", "assets"),
        state: stateRoot,
      },
      serverUrl: "http://127.0.0.1",
      fetchImpl: fetch,
    });
    const jsonOk = capture();
    assert.equal(await cmdKxmRunStatus(driveRuntime(true, jsonOk), "run_statuscli"), 0);
    const jsonPayload = JSON.parse(jsonOk.read().stdout) as { ok: boolean; drive: { receipt: unknown; verified: boolean } };
    assert.equal(jsonPayload.ok, true);
    assert.deepEqual(jsonPayload.drive.receipt, receipt);
    assert.equal(jsonPayload.drive.verified, true);
    const textOk = capture();
    assert.equal(await cmdKxmRunStatus(driveRuntime(false, textOk), "run_statuscli"), 0);
    assert.match(textOk.read().stdout, /drive drv_0123456789abcdef01234567: completed \(receipt verified\)/);

    const cancelledReasons = ["budget_run_duration", "operator_cancel", "runtime_shutdown"] as const;
    for (const reason of cancelledReasons) {
      const cancelledReceipt = {
        schema: "kxm.drive-receipt.v1",
        driveId: "drv_0123456789abcdef01234567",
        runId: "run_statuscli",
        settlement: { kind: "terminal", status: "cancelled", reason },
        budget: reason === "budget_run_duration"
          ? { budgetMs: 25, source: "workflow", elapsedMs: 40, overrun: true }
          : null,
      };
      const cancelledBody = {
        ok: true,
        run: { ...body.run, status: "cancelled" },
        drive: { ...body.drive, receipt: cancelledReceipt, verified: true },
      };
      kxmDriveCliSeams.runtimeRequest = async () => cancelledBody;
      const jsonCancelled = capture();
      assert.equal(await cmdKxmRunStatus(driveRuntime(true, jsonCancelled), "run_statuscli"), 0);
      const jsonCancelledPayload = JSON.parse(jsonCancelled.read().stdout) as { ok: boolean; drive: { receipt: unknown } };
      assert.equal(jsonCancelledPayload.ok, true);
      assert.deepEqual(jsonCancelledPayload.drive.receipt, cancelledReceipt);
      const textCancelled = capture();
      assert.equal(await cmdKxmRunStatus(driveRuntime(false, textCancelled), "run_statuscli"), 0);
      const cancelledText = textCancelled.read().stdout;
      assert.match(cancelledText, new RegExp(`run run_statuscli: cancelled \\(${reason}\\)`));
      assert.match(cancelledText, new RegExp(`drive drv_0123456789abcdef01234567: cancelled \\(${reason}\\)`));
      assert.equal(cancelledText.includes("completed"), false, reason);
    }

    const cancellingBody = {
      ok: true,
      run: { ...body.run, status: "cancelling" },
      drive: {
        ...body.drive,
        receipt: {
          ...receipt,
          settlement: {
            kind: "handoff",
            status: "cancelling",
            reason: "attempt_unreconciled",
            handoff: { reason: "attempt_unreconciled", attemptId: "att_0123456789abcdef0123456789abcdef", detail: "issued attempt is not held by this process" },
          },
        },
        verified: true,
      },
    };
    kxmDriveCliSeams.runtimeRequest = async () => cancellingBody;
    const textCancelling = capture();
    assert.equal(await cmdKxmRunStatus(driveRuntime(false, textCancelling), "run_statuscli"), 0);
    assert.match(textCancelling.read().stdout, /run run_statuscli: cancelling \(attempt att_0123456789abcdef0123456789abcdef, attempt_unreconciled\)/);
  } finally {
    delete kxmDriveCliSeams.ensureSupervisor;
    delete kxmDriveCliSeams.runtimeRequest;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("kxm runs receipt prints the newest settlement and lists with --all", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-run-receipt-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-run-receipt-cli-state-"));
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JRECEIPTCLI00000000000", projectName: "Receipt CLI" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });

    const handle = { runtimeId: "rtm_receiptcli", port: 9, token: "tok", started: true as const };
    kxmDriveCliSeams.ensureSupervisor = async () => handle;
    const env = { KXM_STATE_HOME: stateRoot };
    const newest = {
      driveId: "drv_bbbbbbbbbbbbbbbbbbbbbbbb",
      settlement: { kind: "terminal", status: "completed", reason: "" },
    };
    const older = {
      driveId: "drv_aaaaaaaaaaaaaaaaaaaaaaaa",
      settlement: { kind: "unsettled", status: "running", reason: "runtime_shutdown_grace_expired" },
    };

    const help = capture();
    assert.equal(await runCli(["runs", "receipt", "--help"], env, help, cwd), 0);
    assert.match(help.read().stdout, /--all/);

    kxmDriveCliSeams.runtimeRequest = async () => ({ ok: true, session: null, receipts: [newest, older] });
    const jsonOk = capture();
    assert.equal(await runCli(["runs", "receipt", "run_receiptcli", "--json"], env, jsonOk, cwd), 0);
    const jsonPayload = JSON.parse(jsonOk.read().stdout) as { ok: boolean; receipt: { driveId: string } };
    assert.equal(jsonPayload.ok, true);
    assert.equal(jsonPayload.receipt.driveId, newest.driveId);
    const textOk = capture();
    assert.equal(await runCli(["runs", "receipt", "run_receiptcli"], env, textOk, cwd), 0);
    assert.match(textOk.read().stdout, /"kind":"terminal"/);
    assert.match(textOk.read().stdout, /"status":"completed"/);

    const jsonAll = capture();
    assert.equal(await runCli(["runs", "receipt", "run_receiptcli", "--all", "--json"], env, jsonAll, cwd), 0);
    const allPayload = JSON.parse(jsonAll.read().stdout) as { receipts: Array<{ driveId: string }> };
    assert.equal(allPayload.receipts.length, 2);
    assert.equal(allPayload.receipts[0]?.driveId, newest.driveId);
    assert.equal(allPayload.receipts[1]?.driveId, older.driveId);

    kxmDriveCliSeams.runtimeRequest = async () => ({ ok: true, session: null, receipts: [] });
    const jsonNone = capture();
    assert.equal(await runCli(["runs", "receipt", "run_receiptcli", "--json"], env, jsonNone, cwd), 1);
    const nonePayload = JSON.parse(jsonNone.read().stderr) as { ok: boolean; error: string };
    assert.equal(nonePayload.ok, false);
    assert.equal(nonePayload.error, "no_receipts");
    const textNone = capture();
    assert.equal(await runCli(["runs", "receipt", "run_receiptcli"], env, textNone, cwd), 1);
    assert.match(textNone.read().stderr, /has no drive receipts/);
  } finally {
    delete kxmDriveCliSeams.ensureSupervisor;
    delete kxmDriveCliSeams.runtimeRequest;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("kxm runs drive --wait exits 0 only for a verified completed receipt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-run-drive-wait-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-run-drive-wait-cli-state-"));
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JDRIVEWAITCLI000000000", projectName: "Drive Wait CLI" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });

    const handle = { runtimeId: "rtm_drivewaitcli", port: 9, token: "tok", started: true as const };
    kxmDriveCliSeams.ensureSupervisor = async () => handle;
    const env = { KXM_STATE_HOME: stateRoot };
    const accepted = {
      ok: true,
      status: "accepted",
      runId: "run_drivewaitcli",
      driveId: "drv_0123456789abcdef01234567",
      poll: "/v1/runs/run_drivewaitcli",
      mode: "simulated",
    };
    const completedReceipt = {
      driveId: accepted.driveId,
      settlement: { kind: "terminal", status: "completed", reason: "" },
    };
    const cancelledReceipt = {
      driveId: accepted.driveId,
      settlement: { kind: "terminal", status: "cancelled", reason: "operator_cancel" },
    };

    kxmDriveCliSeams.runtimeRequest = async (_supervisor, method) => {
      if (method === "POST") return accepted;
      return { ok: true, run: { runId: accepted.runId, status: "completed" }, drive: { receipt: completedReceipt, verified: true } };
    };
    const jsonOk = capture();
    assert.equal(await runCli(["runs", "drive", "run_drivewaitcli", "--simulated", "--wait", "--timeout-ms", "200", "--json"], env, jsonOk, cwd), 0);
    const jsonPayload = JSON.parse(jsonOk.read().stdout) as { ok: boolean; receipt: { driveId: string }; verified: boolean };
    assert.equal(jsonPayload.ok, true);
    assert.equal(jsonPayload.verified, true);
    assert.equal(jsonPayload.receipt.driveId, accepted.driveId);

    kxmDriveCliSeams.runtimeRequest = async (_supervisor, method) => {
      if (method === "POST") return accepted;
      return { ok: true, run: { runId: accepted.runId, status: "cancelled" }, drive: { receipt: cancelledReceipt, verified: true } };
    };
    const jsonCancelled = capture();
    assert.equal(await runCli(["runs", "drive", "run_drivewaitcli", "--simulated", "--wait", "--timeout-ms", "200", "--json"], env, jsonCancelled, cwd), 1);
    const cancelledPayload = JSON.parse(jsonCancelled.read().stderr) as { ok: boolean; receipt: { settlement: { status: string } } };
    assert.equal(cancelledPayload.ok, false);
    assert.equal(cancelledPayload.receipt.settlement.status, "cancelled");

    kxmDriveCliSeams.runtimeRequest = async (_supervisor, method) => {
      if (method === "POST") return accepted;
      return { ok: true, run: { runId: accepted.runId, status: "running" } };
    };
    const jsonTimeout = capture();
    assert.equal(await runCli(["runs", "drive", "run_drivewaitcli", "--simulated", "--wait", "--timeout-ms", "40", "--json"], env, jsonTimeout, cwd), 1);
    const timeoutPayload = JSON.parse(jsonTimeout.read().stderr) as { ok: boolean; error: string };
    assert.equal(timeoutPayload.ok, false);
    assert.equal(timeoutPayload.error, "timeout");

    const jsonInvalid = capture();
    assert.equal(await runCli(["runs", "drive", "run_drivewaitcli", "--simulated", "--wait", "--timeout-ms", "0", "--json"], env, jsonInvalid, cwd), 1);
    const invalidPayload = JSON.parse(jsonInvalid.read().stderr) as { ok: boolean; error: string };
    assert.equal(invalidPayload.ok, false);
    assert.equal(invalidPayload.error, "run_drive_timeout_invalid");
  } finally {
    delete kxmDriveCliSeams.ensureSupervisor;
    delete kxmDriveCliSeams.runtimeRequest;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("kxm run and runtime commands cover workspace, project, and dry-run branches", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-run-cli-branches-"));
  const noProject = mkdtempSync(join(tmpdir(), "kxm-run-cli-noproject-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-run-cli-branches-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(noProject);
    const workspaceIo = capture();
    assert.equal(await runCli(["--workspace", cwd, "run", "default", "--json"], env, workspaceIo, cwd), 2);
    assert.match(workspaceIo.read().stderr, /workspace_option_unsupported/);

    for (const [args, command] of [
      [["run", "default", "--json"], "run"],
      [["runs", "status", "run_x", "--json"], "run status"],
      [["runs", "cancel", "run_x", "--json"], "run cancel"],
      [["runs", "list", "--json"], "run list"],
    ] as const) {
      const io = capture();
      assert.equal(await runCli([...args], env, io, noProject), 1, command);
      assert.match(io.read().stderr, /project_required/, command);
    }

    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JRUNBRANCH000000000000", projectName: "Run Branches" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });

    const startDryIo = capture();
    assert.equal(await runCli(["runtime", "start", "--json", "--dry-run"], env, startDryIo, cwd), 0);
    assert.match(startDryIo.read().stdout, /"dryRun":true/);

    const stopDryIo = capture();
    assert.equal(await runCli(["runtime", "stop", "--json", "--dry-run"], env, stopDryIo, cwd), 0);

    const stoppedStatusIo = capture();
    assert.equal(await runCli(["runtime", "status", "--json"], env, stoppedStatusIo, cwd), 1);

    // Liveness and sync are different questions, and the stopped case must not
    // answer the second one with a failure it never had.
    const stoppedTextIo = capture();
    assert.equal(await runCli(["runtime", "status"], env, stoppedTextIo, cwd), 1);
    assert.match(stoppedTextIo.read().stdout, /runtime supervisor is not running/);
    assert.doesNotMatch(stoppedTextIo.read().stdout, /sync:/,
      "a supervisor that was never up is not one that failed to answer");

    const stopNotRunningIo = capture();
    assert.equal(await runCli(["runtime", "stop", "--json"], env, stopNotRunningIo, cwd), 0);
    assert.match(stopNotRunningIo.read().stdout, /"stopped":false/);

    // Exercise the KxmConfigError catch branches on each run command.
    const missingRunIo = capture();
    assert.equal(await runCli(["runs", "cancel", "run_00000000000000000000000000000000", "--json"], env, missingRunIo, cwd), 1);
    assert.match(missingRunIo.read().stderr, /run_unknown|run_cancel_failed/);

    const missingStatusIo = capture();
    assert.equal(await runCli(["runs", "status", "run_00000000000000000000000000000000", "--json"], env, missingStatusIo, cwd), 1);
    assert.match(missingStatusIo.read().stderr, /run_unknown|run_status_failed/);

    const projectFile = join(cwd, ".kxm", "project.yaml");
    const projectYaml = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, "schema: kxm.project.v1\n", "utf8");
    const brokenRunIo = capture();
    assert.equal(await runCli(["run", "default", "--json"], env, brokenRunIo, cwd), 1);
    assert.match(brokenRunIo.read().stderr, /run_failed|schema_/);
    const brokenListIo = capture();
    assert.equal(await runCli(["runs", "list", "--json"], env, brokenListIo, cwd), 1);
    assert.match(brokenListIo.read().stderr, /run_list_failed|schema_/);
    writeFileSync(projectFile, projectYaml, "utf8");
  } finally {
    try { await runCli(["runtime", "stop", "--json"], env, capture(), cwd); } catch { /* best effort */ }
    await waitForSupervisorExit(env);
    rmWithRetry(cwd);
    rmWithRetry(noProject);
    rmWithRetry(stateRoot);
  }
});

import { kxmSupervisorStatus } from "../../plugins/kxm/src/runtime-supervisor.ts";
import { kxmRuntimePaths } from "../../plugins/kxm/src/runtime-store.ts";

async function waitForSupervisorExit(env: NodeJS.ProcessEnv): Promise<void> {
  const paths = kxmRuntimePaths({ env });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = kxmSupervisorStatus(paths);
    const pid = status.pid;
    const pidAlive = pid !== undefined && (() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    })();
    if (!status.running && !pidAlive) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

function rmWithRetry(path: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 9) throw error;
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) { /* busy-wait briefly */ }
    }
  }
}

test("kxm trust diff and check classify expansions against HEAD", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-trust-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-trust-cli-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JTRUSTCLI00000000000000", projectName: "Trust CLI" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    const commit = spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });
    assert.equal(commit.status, 0, commit.stderr as unknown as string);

    const workspaceIo = capture();
    assert.equal(await runCli(["--workspace", cwd, "trust", "check", "--json"], env, workspaceIo, cwd), 2);

    const cleanIo = capture();
    assert.equal(await runCli(["trust", "check", "--json"], env, cleanIo, cwd), 0);
    const clean = JSON.parse(cleanIo.read().stdout) as { ok: boolean; requiresReview: boolean; expansions: number };
    assert.equal(clean.ok, true);
    assert.equal(clean.requiresReview, false);
    assert.equal(clean.expansions, 0);

    const cleanDiffIo = capture();
    assert.equal(await runCli(["trust", "diff", "--json"], env, cleanDiffIo, cwd), 0);
    assert.equal((JSON.parse(cleanDiffIo.read().stdout) as { changes: unknown[] }).changes.length, 0);

    const agentFile = join(cwd, ".kxm", "agents", "coordinator.yaml");
    writeFileSync(agentFile, readFileSync(agentFile, "utf8").replace("network: provider-only", "network: host"), "utf8");
    const expandedIo = capture();
    assert.equal(await runCli(["trust", "check", "--json"], env, expandedIo, cwd), 1);
    const expanded = JSON.parse(expandedIo.read().stderr) as {
      ok: boolean;
      requiresReview: boolean;
      changes: Array<{ field: string; direction: string; resource: string }>;
    };
    assert.equal(expanded.ok, false);
    assert.equal(expanded.requiresReview, true);
    assert(expanded.changes.some((change) => change.field === "network" && change.direction === "expansion" && change.resource === ".kxm/agents/coordinator.yaml"));

    const expandedTextIo = capture();
    assert.equal(await runCli(["trust", "check"], env, expandedTextIo, cwd), 1);
    assert.match(expandedTextIo.read().stderr, /EXPANSION/);
    assert.match(expandedTextIo.read().stderr, /trust check failed/);

    const invalidBaseIo = capture();
    assert.equal(await runCli(["trust", "check", "--json", "--base", "nope; rm -rf /"], env, invalidBaseIo, cwd), 1);
    assert.match(invalidBaseIo.read().stderr, /git_revision_invalid/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("init and validate work in an isolated workspace", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-"));
  try {
    const isolated = join(cwd, "ws");
    mkdirSync(join(isolated, "config"), { recursive: true });
    mkdirSync(join(isolated, "assets"), { recursive: true });
    mkdirSync(join(isolated, "state"), { recursive: true });
    assert.equal(existsSync(join(isolated, "config", "agents.json")), false, "consumer workspace must not copy the package dogfood roster");

    writeFileSync(join(isolated, "config", "agents.json"), JSON.stringify({
      schema: "kxm.agents.v1",
      agents: [{ name: "planner", kind: "agent", driver: "ai", purpose: "plans" }],
    }));
    writeFileSync(join(isolated, "config", "gates.json"), JSON.stringify({
      schema: "kxm.gates.v1",
      gates: [{ name: "validate", kind: "gate", driver: "code", purpose: "validates" }],
    }));
    mkdirSync(join(isolated, "state"), { recursive: true });
    const database = new DatabaseSync(join(isolated, "state", "kxm.db"));
    try {
      database.exec("CREATE TABLE agents (record TEXT NOT NULL); CREATE TABLE messages (record TEXT NOT NULL); CREATE TABLE workflow_runs (record TEXT NOT NULL); CREATE TABLE workflow_journal (category TEXT, record TEXT NOT NULL);");
      database.prepare("INSERT INTO workflow_runs(record) VALUES (?)").run(JSON.stringify({
        id: "run_brief1",
        status: "running",
        definitionId: "default",
        project: "demo",
        currentStage: "implement",
        stages: [
          { id: "plan", status: "passed" },
          { id: "implement", status: "in_progress" },
        ],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }));
      database.prepare("INSERT INTO workflow_journal(category, record) VALUES (?, ?)").run("plan", JSON.stringify({
        id: "plan_brief1",
        runId: "run_brief1",
        category: "plan",
        summary: "Hub local session brief",
        createdAt: "2026-09-01T00:00:00.000Z",
      }));
      database.prepare("INSERT INTO messages(record) VALUES (?)").run(JSON.stringify({
        id: "msg_brief",
        status: "delivered",
        from: "agt_1",
        fromName: "sender",
        to: "agt_2",
        toName: "recipient",
        delivery: "followUp",
        content: "SECRET BODY MUST NOT LOAD",
        createdAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-09-02T00:00:00.000Z",
        hops: 0,
        maxHops: 5,
      }));
    } finally {
      database.close();
    }
    const briefIo = capture();
    assert.equal(await runCli(["session", "--json", "--workspace", isolated, "brief"], {}, briefIo, cwd), 0);
    const briefOut = briefIo.read().stdout;
    assert.match(briefOut, /"schema":"kxm\.session-brief\.v1"/);
    assert.match(briefOut, /run_brief1/);
    assert.match(briefOut, /Hub local session brief/);
    assert.doesNotMatch(briefOut, /SECRET BODY MUST NOT LOAD/);

    const briefStatus = capture();
    assert.equal(await runCli(["session", "--json", "--workspace", isolated, "brief", "--status"], {}, briefStatus, cwd), 0);
    assert.match(briefStatus.read().stdout, /statusLine/);

    const briefTextStatus = capture();
    assert.equal(await runCli(["session", "--workspace", isolated, "brief", "--status"], {}, briefTextStatus, cwd), 0);
    const statusText = briefTextStatus.read().stdout.trim();
    assert.match(statusText, /^kxm hub:off/);
    assert.ok(statusText.length <= 80);

    const tokenIo = capture();
    assert.equal(await runCli(["session", "--workspace", isolated, "brief", "--token"], {}, tokenIo, cwd), 0);
    const tokenRaw = tokenIo.read().stdout.trim();
    const tokenPayload = JSON.parse(Buffer.from(tokenRaw, "base64url").toString("utf8")) as {
      schema: string;
      toolPolicy?: { preset?: string };
    };
    assert.equal(tokenPayload.schema, "kxm.session-token.v1");
    assert.equal(tokenPayload.toolPolicy?.preset, "operator");

    const sessionIo = capture();
    assert.equal(await runCli([
      "session", "--json", "--workspace", isolated, "start", "--id", "review-1", "--mix", "planner,validate",
    ], {}, sessionIo, cwd), 0);
    assert.match(sessionIo.read().stdout, /"schema":"kxm.session.v1"/);
    assert.equal(existsSync(join(isolated, "assets", "sessions", "review-1", "session.json")), true);

  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hub and worker dry-run do not spawn, and live hub uses the injected spawner", async () => {
  const dry = capture();
  assert.equal(await runCli(["hub", "--json", "--dry-run", "start"], {}, dry), 0);
  assert.match(dry.read().stdout, /"dryRun":true/);
  const live = capture();
  let spawned = false;
  const code = await runCli(["hub", "--json", "start"], {}, {
    ...live,
    spawnHub: () => {
      spawned = true;
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(spawned, true);

  const worker = capture();
  let workerEnv: NodeJS.ProcessEnv | undefined;
  assert.equal(await runCli([
    "agent",
    "--json",
    "worker",
    "--name",
    "coordinator",
    "--project",
    "product",
    "--model",
    "vendor/primary",
    "--fallback-models",
    "vendor/secondary,vendor/tertiary",
    "--fresh-start",
    "--tools",
    "read,grep,kxm_fanout",
    "--session-isolation",
    "workflow",
  ], {}, {
    ...worker,
    spawnWorker: (environment) => {
      workerEnv = environment;
      return 0;
    },
  }), 0);
  assert.equal(workerEnv?.KXM_WORKER_MODEL, "vendor/primary");
  assert.equal(workerEnv?.KXM_WORKER_FALLBACK_MODELS, "vendor/secondary,vendor/tertiary");
  assert.equal(workerEnv?.KXM_WORKER_INITIAL_CONTINUE, "false");
  assert.equal(workerEnv?.KXM_WORKER_TOOLS, "read,grep,kxm_fanout");
  assert.equal(workerEnv?.KXM_WORKER_SESSION_ISOLATION, "workflow");

  let compatibilityEnv: NodeJS.ProcessEnv | undefined;
  assert.equal(await runCli([
    "agent", "worker", "--name", "legacy", "--project", "product",
  ], { KXM_WORKER_SESSION_ISOLATION: "off" }, {
    ...capture(),
    spawnWorker: (environment) => {
      compatibilityEnv = environment;
      return 0;
    },
  }), 0);
  assert.equal(compatibilityEnv?.KXM_WORKER_SESSION_ISOLATION, "off");

  let defaultEnv: NodeJS.ProcessEnv | undefined;
  assert.equal(await runCli([
    "agent", "worker", "--name", "default-mode", "--project", "product",
  ], {}, {
    ...capture(),
    spawnWorker: (environment) => {
      defaultEnv = environment;
      return 0;
    },
  }), 0);
  assert.equal(defaultEnv?.KXM_WORKER_SESSION_ISOLATION, "off");

  const invalidIsolation = capture();
  assert.equal(await runCli([
    "agent", "worker", "--name", "coordinator", "--project", "product", "--session-isolation", "shared",
  ], {}, invalidIsolation), 2);
  assert.match(invalidIsolation.read().stderr, /must be workflow or off/);
});

test("kxm dash defaults to the current project instead of a vendor-specific project", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "generic-product-"));
  const requested: string[] = [];
  try {
    const io = capture();
    assert.equal(await runCli(["dash"], {}, {
      ...io,
      fetchImpl: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true, agents: 0 }));
        if (url.endsWith("/ready")) return new Response(JSON.stringify({ ok: true, storage: "sqlite" }));
        if (url.includes("/v1/ops/snapshot")) return new Response(JSON.stringify({
          project: cwd.split(/[\\/]/).at(-1),
          fetchedAt: "2026-08-28T00:00:00.000Z",
          agents: [], openMessages: [], openMessageTotal: 0, runs: [], runTotal: 0,
        }));
        throw new Error(`unexpected URL ${url}`);
      },
    }, cwd), 0);
    assert.ok(requested.some((url) => url.includes(`project=${encodeURIComponent(cwd.split(/[\\/]/).at(-1)!)}`)));
    assert.ok(requested.every((url) => !url.includes("project=payk12")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stop, signal, status, and help cover the remaining command contract", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-more-"));
  try {
    const help = capture();
    assert.equal(await runCli(["help"], {}, help, cwd), 0);
    const unknown = capture();
    assert.equal(await runCli(["nope"], {}, unknown, cwd), 2);
    const missing = capture();
    assert.equal(await runCli(["gate", "--json", "validate", "--file", join(cwd, "missing.json")], {}, missing, cwd), 1);
    const stopDry = capture();
    assert.equal(await runCli(["hub", "--json", "--dry-run", "stop"], {}, stopDry, cwd), 0);
    const improve = capture();
    assert.equal(await runCli(["improve", "--json", "--workspace", cwd], { KXM_USER_CONFIG_DIR: cwd, KXM_STATE_HOME: cwd }, improve, cwd), 0);
    const improveResult = JSON.parse(improve.read().stdout) as { command: string; path: string; events: number };
    assert.equal(improveResult.command, "improve");
    assert.equal(improveResult.events, 0);
    assert.equal(existsSync(improveResult.path), true);
    mkdirSync(join(cwd, "state"), { recursive: true });
    const startedAt = "2026-08-26T00:00:00.000Z";
    const pidPath = join(cwd, "state", "hub.pid");
    writeFileSync(pidPath, JSON.stringify({ version: 1, pid: process.pid, role: "hub", startedAt, controlFile: "hub.stop" }));
    writeFileSync(join(cwd, "state", "worker-recovery-demo.json"), JSON.stringify({
      version: 1,
      reason: "provider_error",
      agentName: "coordinator",
      project: "product",
      createdAt: startedAt,
      previousContinue: true,
      freshSession: false,
    }));
    const sessionStatus = capture();
    assert.equal(await runCli(["session", "--json", "--workspace", cwd, "status"], {}, sessionStatus, cwd), 0);
    assert.match(sessionStatus.read().stdout, /"command":"session status"/);
    assert.match(sessionStatus.read().stdout, /hub.pid/);
    assert.match(sessionStatus.read().stdout, /provider_error/);
    const sessionStopDry = capture();
    assert.equal(await runCli(["session", "--json", "--dry-run", "--workspace", cwd, "stop"], {}, sessionStopDry, cwd), 0);
    assert.match(sessionStopDry.read().stdout, /"dryRun":true/);
    const stop = capture();
    assert.equal(await runCli(["hub", "--json", "--workspace", cwd, "stop"], {}, {
      ...stop,
      sleep: async () => { rmSync(pidPath, { force: true }); },
    }, cwd), 0);
    assert.match(stop.read().stdout, /"stopped":\["hub.pid"\]/);
    const status = capture();
    assert.equal(await runCli(["hub", "--json", "view"], {}, {
      ...status,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }, cwd), 0);
    const signalDry = capture();
    assert.equal(await runCli(
      ["gate", "--json", "--dry-run", "signal", "run_1", "key", "passed", "ok"],
      { KXM_WORKFLOW_ID: "wf", KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      signalDry,
      cwd,
    ), 0);
    const signalLive = capture();
    let signalBody = "";
    const signalDeliveryIds: string[] = [];
    assert.equal(await runCli(
      ["gate", "--json", "signal", "run_1", "key", "passed", "ok", " Local   Review =artifact.md", "GitHub.Check:CI=https://ci.example/1"],
      { KXM_WORKFLOW_ID: "wf", KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      {
        ...signalLive,
        fetchImpl: async (_input, init) => {
          signalBody = String(init?.body ?? "");
          signalDeliveryIds.push(new Headers(init?.headers).get("x-kxm-delivery-id") ?? "");
          return new Response(JSON.stringify({ duplicate: false }), { status: 202 });
        },
      },
      cwd,
    ), 0);
    assert.deepEqual(JSON.parse(signalBody).evidence, {
      "local review": "artifact.md",
      "github.check:ci": "https://ci.example/1",
    });
    assert.equal(await runCli(
      ["gate", "--json", "signal", "run_1", "key", "failed", "retry required"],
      { KXM_WORKFLOW_ID: "wf", KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      {
        ...capture(),
        fetchImpl: async (_input, init) => {
          signalDeliveryIds.push(new Headers(init?.headers).get("x-kxm-delivery-id") ?? "");
          return new Response(JSON.stringify({ duplicate: false }), { status: 202 });
        },
      },
      cwd,
    ), 0);
    assert.equal(new Set(signalDeliveryIds).size, 2);
    assert.ok(signalDeliveryIds.every((deliveryId) => /^cli-signal:[0-9a-f-]{36}$/.test(deliveryId)));
    const list = capture();
    assert.equal(await runCli(["workflow", "--json", "list"], {}, list, cwd), 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("live workflow start is signed and smoke skips without opt-in", async () => {
  const start = capture();
  let signature = "";
  assert.equal(await runCli(["workflow", "--json", "start", "wf", "--payload", "{\"task\":\"TASK-1\"}", "--delivery-id", "cli-1"], {
    KXM_WORKFLOW_SECRET: "workflow-secret-16chars",
  }, {
    ...start,
    fetchImpl: async (_input, init) => {
      signature = new Headers(init?.headers).get("x-kxm-signature") ?? "";
      return new Response(JSON.stringify({ run: { id: "run_cli" }, runId: "run_cli", duplicate: false }), { status: 202 });
    },
  }), 0);
  assert.match(start.read().stdout, /"runId":"run_cli"/);
  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
});

test("release workflow retries reuse one explicit delivery identifier", () => {
  const launcher = readFileSync(resolve(".kxm/assets/run-provenance-workflow.ps1"), "utf8");
  assert.match(launcher, /\$startDeliveryId\s*=\s*"provenance-release-\$\(\[Guid\]::NewGuid\(\)\.ToString\('N'\)\)"/);
  assert.match(launcher, /workflow start provenance-review[\s\S]*?--delivery-id \$startDeliveryId/);
  assert.equal((launcher.match(/--delivery-id \$startDeliveryId/g) ?? []).length, 1);

  const definitions = JSON.parse(readFileSync(resolve("examples/provenance-workflow.json"), "utf8")) as Array<{
    stages: Array<{ id: string; instructions: string }>;
  }>;
  const review = definitions[0]?.stages.find((stage) => stage.id === "review");
  assert.ok(review);
  assert.match(review.instructions, /timeoutMs to 120000/);
  assert.match(review.instructions, /provenance-review:<runId>:review:<attempt>/);
  assert.match(review.instructions, /Treat every returned messageId as the durable handle/);
  assert.match(review.instructions, /kxm_get to verify each stored message has the exact run, stage, requirement, and attempt binding/);
  assert.match(review.instructions, /kxm_await with that messageId and timeoutMs 60000 \(its maximum\)/);
  assert.match(review.instructions, /repeat the exact fanout parameters/);
  assert.match(launcher, /toolTimeoutMs = 180000/);
  assert.match(launcher, /fanoutTimeoutMs = 120000/);
});

test("cli hub commands fall back to the persisted hub env project token", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-cli-auth-project-"));
  try {
    writeFileSync(join(stateHome, "hub-env.json"), JSON.stringify({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-16T00:00:00.000Z",
      authToken: "persisted-admin-token",
      projectTokens: { kxm: "persisted-project-token" },
    }));
    const io = capture();
    const authorizations: string[] = [];
    const code = await runCli(["peer", "inbox", "--json"], {
      KXM_PROJECT: "kxm",
      KXM_STATE_HOME: stateHome,
      KXM_SERVER_URL: "http://127.0.0.1:7331",
    }, {
      ...io,
      fetchImpl: async (input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        if (String(input).endsWith("/v1/agents/register")) {
          return new Response(JSON.stringify({ agent: { id: "agent_1" }, agentKey: "key_1" }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    const out = io.read();
    assert.equal(code, 0, `${out.stderr}\n${out.stdout}`);
    const seen = authorizations.filter(Boolean);
    assert.ok(seen.length > 0, "expected at least one authenticated request");
    assert.ok(seen.every((a) => a === "Bearer persisted-project-token"), seen.join(","));
  } finally {
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("kxm peer inbox lists a request queued for a durable CLI agent name", async (context) => {
  const mesh = await createTestMesh(context);
  const env = {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "codex",
  };
  const inbox = async () => {
    const io = capture();
    const code = await runCli(["peer", "inbox", "--json"], env, io);
    const out = io.read();
    assert.equal(code, 0, `${out.stderr}\n${out.stdout}`);
    return (JSON.parse(out.stdout) as { messages: Array<Record<string, unknown>> }).messages;
  };

  // The first call registers the name; a one-shot call leaves it offline when it exits.
  assert.deepEqual(await inbox(), []);
  const sender = mesh.makeClient("sender");
  await sender.start(() => {});
  const request = await sender.send({ target: "codex", content: "Review the retry loop", allowOffline: true });
  assert.equal(request.status, "queued");

  // The next call resumes the same agent and reads what was queued for it meanwhile.
  const listed = await inbox();
  assert.deepEqual(
    listed.map((message) => [message.id, message.fromName, message.content, message.status]),
    [[request.id, "sender", "Review the retry loop", "queued"]],
  );
  // Listing acknowledges nothing: the request is still queued for push delivery.
  assert.equal((await sender.getMessage(request.id)).status, "queued");
});

test("cli agent commands never register with the persisted admin token", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-cli-auth-admin-"));
  try {
    writeFileSync(join(stateHome, "hub-env.json"), JSON.stringify({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-16T00:00:00.000Z",
      authToken: "persisted-admin-token",
      projectTokens: { "other-project": "other-project-token" },
    }));
    const io = capture();
    const requests: string[] = [];
    const code = await runCli(["peer", "list", "--json"], {
      KXM_PROJECT: "kxm",
      KXM_STATE_HOME: stateHome,
      KXM_SERVER_URL: "http://127.0.0.1:7331",
    }, {
      ...io,
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });
    const out = io.read();
    assert.equal(code, 2, `${out.stderr}\n${out.stdout}`);
    const refusal = JSON.parse(out.stderr) as Record<string, unknown>;
    assert.equal(refusal.error, "project_token_missing");
    assert.equal(refusal.project, "kxm");
    assert.equal(refusal.nextAction, "export_kxm_auth_token");
    assert.match(String(refusal.detail), /no project token for project kxm/);
    assert.doesNotMatch(`${out.stdout}${out.stderr}`, /persisted-admin-token|other-project-token/);
    assert.deepEqual(requests, [], "no hub request may carry a borrowed credential");
  } finally {
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("workflow degradation approval is an explicit admin command", async () => {
  const io = capture();
  let requestedUrl = "";
  let authorization = "";
  let body = "";
  const code = await runCli([
    "gate",
    "--json",
    "degrade",
    "run_1",
    "review",
    "--requirement",
    "Independent Review",
    "--reason",
    "one configured peer is unavailable",
  ], {
    KXM_AUTH_TOKEN: "admin-secret-token",
    KXM_SERVER_URL: "http://127.0.0.1:7331",
  }, {
    ...io,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({
        duplicate: false,
        approval: { id: "approval_1" },
      }), { status: 201 });
    },
  });
  assert.equal(code, 0, io.read().stdout);
  assert.match(requestedUrl, /\/v1\/workflows\/run_1\/degradations$/);
  assert.equal(authorization, "Bearer admin-secret-token");
  assert.deepEqual(JSON.parse(body), {
    stageId: "review",
    requirementKey: "Independent Review",
    reason: "one configured peer is unavailable",
  });
  assert.match(io.read().stdout, /"approvalId":"approval_1"/);
  assert.doesNotMatch(io.read().stdout, /admin-secret-token/);
});

test("github watch dry-run does not leak tokens", async () => {
  const io = capture();
  const code = await runCli(
    ["gate", "--json", "--dry-run", "github", "watch", "--run-id", "run_1", "--stage-id", "review", "--signal-key", "k", "--repo", "acme/app", "--pr", "1"],
    {
      KXM_WORKFLOW_ID: "wf",
      KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars",
      GITHUB_TOKEN: "ghs_should_not_appear",
    },
    {
      ...io,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/pulls/1")) return new Response(JSON.stringify({ head: { sha: "abc" } }), { status: 200 });
        return new Response(JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }), { status: 200 });
      },
    },
  );
  assert.equal(code, 0);
  assert.doesNotMatch(io.read().stdout, /ghs_should_not_appear/);
  assert.doesNotMatch(io.read().stdout, /signal-secret-16chars/);
});

test("retrospective export writes proposed artifacts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-export-"));
  try {
    const snapshot = {
      run: {
        id: "run_cli",
        definitionId: "demo",
        source: "generic",
        deliveryId: "d",
        payloadHash: "h",
        project: "p",
        targetAgentId: "a",
        targetAgentName: "coordinator",
        messageId: "m",
        status: "failed",
        stages: [{
          id: "research",
          label: "Research",
          instructions: "x",
          requiredEvidence: ["a"],
          maxAttempts: 1,
          status: "in_progress",
          attempts: 0,
          evidence: [],
        }],
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
      journal: [],
    };
    const input = join(cwd, "snapshot.json");
    writeFileSync(input, JSON.stringify(snapshot));
    const io = capture();
    const workspace = join(cwd, ".kxm");
    const code = await runCli(["workflow", "--json", "--workspace", workspace, "export", "run_cli", "--input", input, "--out-dir", join(workspace, "assets", "retrospectives")], {}, io, cwd);
    assert.equal(code, 0, io.read().stdout);
    assert.match(io.read().stdout, /"reviewDecision":"proposed"/);
    const outside = capture();
    assert.equal(await runCli(["workflow", "--json", "--workspace", workspace, "export", "run_cli", "--input", input, "--out-dir", join(cwd, "outside")], {}, outside, cwd), 2);
    assert.match(outside.read().stderr, /output_outside_workspace_assets/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow list/get use local SQLite state and redact configured secret values", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-state-"));
  const stateDir = join(cwd, ".kxm", "state");
  const dataPath = join(stateDir, "kxm.db");
  try {
    mkdirSync(stateDir, { recursive: true });
    const database = new DatabaseSync(dataPath);
    database.exec("CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE workflow_journal (run_id TEXT NOT NULL, record TEXT NOT NULL);");
    const requestSha256 = "a".repeat(64);
    const replySha256 = "b".repeat(64);
    database.prepare("INSERT INTO workflow_runs (id, record) VALUES (?, ?)").run("run_local", JSON.stringify({
      id: "run_local",
      status: "running",
      summary: "exact-secret-value",
      untrustedDigest: "c".repeat(64),
      stages: [{
        verifiedEvidence: {
          review: [{ requestSha256, replySha256 }],
        },
      }],
    }));
    database.prepare("INSERT INTO workflow_journal (run_id, record) VALUES (?, ?)").run("run_local", JSON.stringify({ id: "journal_1", runId: "run_local", summary: "safe evidence" }));
    database.close();
    const env = { KXM_DATA_PATH: dataPath, KXM_TEST_SECRET: "exact-secret-value" };
    const list = capture();
    assert.equal(await runCli(["workflow", "--json", "list"], env, list, cwd), 0);
    assert.match(list.read().stdout, /run_local/);
    assert.doesNotMatch(list.read().stdout, /exact-secret-value/);
    assert.match(list.read().stdout, /\[redacted\]/);
    const get = capture();
    assert.equal(await runCli(["workflow", "--json", "get", "run_local"], env, get, cwd), 0);
    assert.match(get.read().stdout, /journal_1/);
    assert.match(get.read().stdout, new RegExp(requestSha256));
    assert.match(get.read().stdout, new RegExp(replySha256));
    assert.doesNotMatch(get.read().stdout, /c{64}/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("invalid and unavailable operator commands fail safely with stable exit codes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-errors-"));
  try {
    assert.equal(await runCli([], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "validate", "--file", join(cwd, "missing.json")], {}, capture(), cwd), 1);
    const invalidWorkflow = join(cwd, "invalid-workflow.json");
    writeFileSync(invalidWorkflow, "{");
    assert.equal(await runCli(["gate", "--json", "validate", "--file", invalidWorkflow], {}, capture(), cwd), 1);
    assert.equal(await runCli(["agent", "--json", "worker"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["hub", "--json", "stop"], {}, capture(), cwd), 1);
    assert.equal(await runCli(["workflow", "--json", "get"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "degrade", "run_1", "review"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "start", "wf", "--payload", "[]"], { KXM_WORKFLOW_SECRET: "workflow-secret-16chars" }, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "--dry-run", "start", "wf", "--payload", "{}"], { KXM_WORKFLOW_SECRET: "workflow-secret-16chars" }, capture(), cwd), 0);
    assert.equal(await runCli(["gate", "--json", "signal"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "signal", "run_1", "key", "invalid", "summary"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "signal", "run_1", "key", "passed", "summary"], {}, capture(), cwd), 2);
    assert.equal(await runCli(
      ["gate", "--json", "signal", "run_1", "key", "passed", "summary", "Review=one", " review =two"],
      { KXM_WORKFLOW_ID: "wf", KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      capture(),
      cwd,
    ), 2);
    assert.equal(await runCli(["gate", "--json", "github", "nope"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "github", "watch"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "nope"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "export"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "export", "run_missing", "--input", join(cwd, "missing.json")], {}, capture(), cwd), 1);
    assert.equal(await runCli(["mesh"], {}, capture(), cwd), 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hub stop recovers an orphaned hub server whose wrapper died", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-orphan-stop-"));
  const stateDir = join(cwd, "state");
  mkdirSync(stateDir, { recursive: true });
  // A real long-lived process stands in for the orphaned hub server child.
  const fixture = join(cwd, "hold.cjs");
  writeFileSync(fixture, "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0)); process.on('SIGKILL', () => process.exit(0));\n");
  const orphan = spawn(process.execPath, [fixture], { stdio: "ignore" });
  if (typeof orphan.pid !== "number") throw new Error("orphan spawn did not assign a pid");
  try {
    // Claim shape written by the wrapper: wrapper pid points at a dead pid,
    // serverPid at the still-running orphan.
    const deadWrapperPid = 2_147_483_000;
    const pidPath = join(stateDir, "hub.pid");
    writeFileSync(pidPath, `${JSON.stringify({
      version: 1,
      pid: deadWrapperPid,
      serverPid: orphan.pid,
      role: "hub",
      startedAt: "2026-09-11T00:00:00.000Z",
      controlFile: "hub.stop",
    })}\n`);
    const stopped = capture();
    assert.equal(await runCli(["hub", "--json", "--workspace", cwd, "stop"], {}, stopped, cwd), 0);
    const result = JSON.parse(stopped.read().stdout) as { ok: boolean; orphans?: string[]; stopped?: string[] };
    assert.equal(result.ok, true);
    assert.deepEqual(result.orphans, ["hub.pid"]);
    assert.ok(result.stopped?.includes("hub.pid"));
    // The orphan was signaled and the stale claim removed.
    const exited = await new Promise<boolean>((resolveExit) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        try { process.kill(orphan.pid!, 0); if (Date.now() > deadline) { resolveExit(false); return; } } catch { resolveExit(true); return; }
        setTimeout(check, 50);
      };
      check();
    });
    assert.equal(exited, true, "orphaned server was stopped");
    assert.equal(existsSync(pidPath), false, "stale claim removed after orphan cleanup");
  } finally {
    try { orphan.kill("SIGKILL"); } catch { /* already exited */ }
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kxm explain inspects prompt context footprint and projected cost", async () => {
  const io = capture();
  assert.equal(await runCli(["explain", "--mode", "coder", "--domains", "git,database", "--model", "grok/grok-4.6"], {}, io), 0);
  assert.match(io.read().stdout, /KXM PRE-FLIGHT CONTEXT EXPLAIN/);
  assert.match(io.read().stdout, /Major Mode:\s+coder/);
  assert.match(io.read().stdout, /git, database/);

  const jsonIo = capture();
  assert.equal(await runCli(["explain", "--mode", "planner", "--json"], {}, jsonIo), 0);
  const parsed = JSON.parse(jsonIo.read().stdout) as { ok: boolean; command: string; majorMode: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "explain");
  assert.equal(parsed.majorMode, "planner");
});

/** Probe-visible stub. Release runners have no omp/claude/pi, so this test must not read the host PATH. */
function installPluginHarnessStub(bin: string, name: string): void {
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(bin, `${name}.cmd`), "@echo off\r\necho fixture-1.0.0\r\nexit /b 0\r\n");
    return;
  }
  const command = join(bin, name);
  writeFileSync(command, "#!/bin/sh\necho fixture-1.0.0\nexit 0\n", { mode: 0o755 });
  chmodSync(command, 0o755);
}

function pluginInstallProbeEnv(bin: string): NodeJS.ProcessEnv {
  return { PATH: bin };
}

function isPluginHarnessCommand(command: string | undefined, id: string): boolean {
  return command === id || command?.toLowerCase() === `${id}.cmd` || command?.toLowerCase() === `${id}.exe`;
}

test("kxm plugin install installs for discovered harnesses and honors flags in dry-run and live modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-plugin-install-"));
  const allBin = join(root, "all");
  const partialBin = join(root, "partial");
  const emptyBin = join(root, "empty");
  try {
    mkdirSync(emptyBin, { recursive: true });
    for (const name of ["pi", "omp", "claude"]) installPluginHarnessStub(allBin, name);
    for (const name of ["pi", "claude"]) installPluginHarnessStub(partialBin, name);
    const allEnv = pluginInstallProbeEnv(allBin);

    const dryRunAll = capture();
    assert.equal(await runCli(["plugin", "install", "--dry-run", "--json"], allEnv, dryRunAll), 0);
    const allParsed = JSON.parse(dryRunAll.read().stdout) as {
      ok: boolean;
      command: string;
      dryRun?: boolean;
      results: Array<{ harness: string; status: string; command: string; args: string[] }>;
    };
    assert.equal(allParsed.ok, true);
    assert.equal(allParsed.command, "plugin install");
    assert.equal(allParsed.dryRun, true);
    assert.deepEqual(allParsed.results.map((r) => r.harness), ["pi", "omp", "claude"]);
    assert.ok(allParsed.results.every((r) => r.status === "would" && isPluginHarnessCommand(r.command, r.harness)));

    const dryRunOmp = capture();
    assert.equal(await runCli(["plugin", "install", "--omp", "--dry-run", "--json"], allEnv, dryRunOmp), 0);
    const ompParsed = JSON.parse(dryRunOmp.read().stdout) as {
      ok: boolean;
      results: Array<{ harness: string; status: string; command?: string; args?: string[] }>;
    };
    assert.equal(ompParsed.ok, true);
    assert.equal(ompParsed.results.length, 1);
    assert.equal(ompParsed.results[0]?.harness, "omp");
    assert.equal(ompParsed.results[0]?.status, "would");
    assert.equal(isPluginHarnessCommand(ompParsed.results[0]?.command, "omp"), true);
    assert.deepEqual(ompParsed.results[0]?.args?.slice(0, 2), ["plugin", "install"]);

    const dryRunClaude = capture();
    assert.equal(await runCli(["plugin", "install", "--claude", "--dry-run"], allEnv, dryRunClaude), 0);
    assert.match(dryRunClaude.read().stdout, /claude: would/);

    const dryRunPi = capture();
    assert.equal(await runCli(["plugin", "install", "--pi", "--dry-run"], allEnv, dryRunPi), 0);
    assert.match(dryRunPi.read().stdout, /pi: would/);

    // A flag for a harness that is not on this PATH is a failure, including --dry-run.
    const missingOmp = capture();
    assert.equal(await runCli(["plugin", "install", "--omp", "--dry-run", "--json"], pluginInstallProbeEnv(partialBin), missingOmp), 1);
    assert.equal(missingOmp.read().stdout, "");
    const missingParsed = JSON.parse(missingOmp.read().stderr) as {
      ok: boolean;
      results: Array<{ harness: string; status: string; error?: string }>;
    };
    assert.equal(missingParsed.ok, false);
    assert.equal(missingParsed.results.length, 1);
    assert.equal(missingParsed.results[0]?.harness, "omp");
    assert.equal(missingParsed.results[0]?.status, "failed");
    assert.equal(missingParsed.results[0]?.error, "harness_not_detected");

    const none = capture();
    assert.equal(await runCli(["plugin", "install", "--dry-run", "--json"], pluginInstallProbeEnv(emptyBin), none), 1);
    const noneParsed = JSON.parse(none.read().stderr) as { ok: boolean; error: string; results: unknown[] };
    assert.equal(noneParsed.ok, false);
    assert.equal(noneParsed.error, "no_harnesses_detected");
    assert.deepEqual(noneParsed.results, []);

    // Mock spawnSync to test execution paths. Detection still uses the stub PATH.
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const mockIo: CliIo = {
      stdout: () => {},
      stderr: () => {},
      spawnSync: (command, args) => {
        spawned.push({ command, args });
        return { status: 0, stdout: "ok", stderr: "" };
      },
    };
    const executed = await runCli(["plugin", "install", "--omp"], allEnv, mockIo);
    assert.equal(executed, 0);
    assert.ok(spawned.some((s) => isPluginHarnessCommand(s.command, "omp") && s.args[0] === "plugin" && s.args[1] === "install"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeLaneCheckout(): { root: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-lane-"));
  const origin = mkdtempSync(join(tmpdir(), "kxm-lane-origin-"));
  makeGitRoot(root);
  initializeKxmProject(root, { projectId: "prj_01JLANECLI00000000000000", projectName: "Lane CLI" });
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  };
  git(["add", "-A"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "init"]);
  const bare = spawnSync("git", ["init", "--bare", "--quiet", origin], { encoding: "utf8", windowsHide: true });
  assert.equal(bare.status, 0, bare.stderr);
  git(["remote", "add", "origin", origin]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return { root, origin };
}

function removeLaneCheckout(root: string, origin: string, units: readonly string[]): void {
  for (const unit of units) {
    rmSync(resolve(dirname(root), `${basename(root)}-${unit}`), { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
}

test("lane create records the resolved base sha and a project worktree", async () => {
  const { root, origin } = makeLaneCheckout();
  const unit = "slice";
  try {
    const io = capture();
    assert.equal(await runCli(["lane", "create", unit, "--json"], {}, io, root), 0, io.read().stderr);
    const payload = JSON.parse(io.read().stdout) as { lane: { path: string; branch: string; baseRef: string; baseSha: string; createdAt: string } };
    const expectedSha = spawnSync("git", ["-C", root, "rev-parse", "origin/main"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    assert.equal(payload.lane.baseSha, expectedSha);
    assert.equal(payload.lane.baseRef, "origin/main");
    assert.equal(payload.lane.branch, unit);
    assert.equal(realpathSync(payload.lane.path), realpathSync(resolve(dirname(root), `${basename(root)}-${unit}`)));
    assert.equal(existsSync(join(payload.lane.path, ".kxm", "project.yaml")), true);
    const recordPath = join(root, ".kxm", "state", "lanes.json");
    assert.equal(statSync(recordPath).mode & 0o777, 0o600);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { schema: string; lanes: Record<string, { baseSha: string }> };
    assert.equal(record.schema, "kxm.lanes.v1");
    assert.equal(record.lanes[unit]?.baseSha, expectedSha);
    assert.match(payload.lane.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    removeLaneCheckout(root, origin, [unit]);
  }
});

test("lane create twice refuses lane_exists", async () => {
  const { root, origin } = makeLaneCheckout();
  const unit = "slice";
  try {
    assert.equal(await runCli(["lane", "create", unit, "--json"], {}, capture(), root), 0);
    const again = capture();
    assert.equal(await runCli(["lane", "create", unit, "--json"], {}, again, root), 1);
    const payload = JSON.parse(again.read().stderr) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "lane_exists");
  } finally {
    removeLaneCheckout(root, origin, [unit]);
  }
});

test("lane create refuses an unresolved base", async () => {
  const { root, origin } = makeLaneCheckout();
  const unit = "slice";
  try {
    const io = capture();
    assert.equal(await runCli(["lane", "create", unit, "--base", "nope", "--json"], {}, io, root), 1);
    const payload = JSON.parse(io.read().stderr) as { ok: boolean; error: string; hint?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "lane_base_unresolved");
    assert.match(io.read().stderr, /git fetch origin/);
    assert.equal(existsSync(resolve(dirname(root), `${basename(root)}-${unit}`)), false);
  } finally {
    removeLaneCheckout(root, origin, [unit]);
  }
});

test("lane drop refuses a dirty worktree unless forced, and keeps the branch", async () => {
  const { root, origin } = makeLaneCheckout();
  const unit = "slice";
  try {
    const created = capture();
    assert.equal(await runCli(["lane", "create", unit, "--json"], {}, created, root), 0, created.read().stderr);
    const lanePath = (JSON.parse(created.read().stdout) as { lane: { path: string } }).lane.path;
    writeFileSync(join(lanePath, "dirty.txt"), "x\n");
    const dirty = capture();
    assert.equal(await runCli(["lane", "drop", unit, "--json"], {}, dirty, root), 1);
    assert.equal((JSON.parse(dirty.read().stderr) as { error: string }).error, "lane_dirty");
    assert.equal(existsSync(join(lanePath, ".kxm", "project.yaml")), true);
    const forced = capture();
    assert.equal(await runCli(["lane", "drop", unit, "--force", "--json"], {}, forced, root), 0, forced.read().stderr);
    const payload = JSON.parse(forced.read().stdout) as { branchDeleted: boolean; branch: string };
    assert.equal(payload.branchDeleted, false);
    assert.equal(payload.branch, unit);
    assert.equal(existsSync(lanePath), false);
    assert.equal(existsSync(join(root, ".kxm", "state", "lanes.json")), true);
    const record = JSON.parse(readFileSync(join(root, ".kxm", "state", "lanes.json"), "utf8")) as { lanes: Record<string, unknown> };
    assert.equal(record.lanes[unit], undefined);
    const branch = spawnSync("git", ["-C", root, "rev-parse", "--verify", `refs/heads/${unit}`], { encoding: "utf8", windowsHide: true });
    assert.equal(branch.status, 0, branch.stderr);
  } finally {
    removeLaneCheckout(root, origin, [unit]);
  }
});

test("run --brief --lane posts the lane project root and the trimmed brief", async () => {
  const { root, origin } = makeLaneCheckout();
  const unit = "slice";
  try {
    const created = capture();
    assert.equal(await runCli(["lane", "create", unit, "--json"], {}, created, root), 0, created.read().stderr);
    const lanePath = (JSON.parse(created.read().stdout) as { lane: { path: string } }).lane.path;
    const brief = join(root, "brief.md");
    writeFileSync(brief, "  fix the lane gate\n\n");
    let posted: { projectRoot?: string; prompt?: string } | undefined;
    kxmDriveCliSeams.ensureSupervisor = async () => ({ runtimeId: "rtm_lanebrief", port: 9, token: "tok", started: true });
    kxmDriveCliSeams.runtimeRequest = async (_handle, method, path, body) => {
      assert.equal(method, "POST");
      assert.equal(path, "/v1/runs");
      posted = body as { projectRoot?: string; prompt?: string };
      return {
        ok: true,
        run: {
          runId: "run_lanebrief00000000000000000000",
          homeRuntimeId: "rtm_lanebrief",
          status: "created",
          configRevision: `sha256:${"a".repeat(64)}`,
        },
      };
    };
    const io = capture();
    assert.equal(await runCli(["run", "default", "--brief", "brief.md", "--lane", unit, "--json"], {}, io, root), 0, io.read().stderr);
    assert.equal(posted?.projectRoot, lanePath);
    assert.equal(posted?.prompt, "fix the lane gate");
    assert.equal((JSON.parse(io.read().stdout) as { brief?: string }).brief, "brief.md");
  } finally {
    delete kxmDriveCliSeams.ensureSupervisor;
    delete kxmDriveCliSeams.runtimeRequest;
    removeLaneCheckout(root, origin, [unit]);
  }
});

test("run refuses --brief together with a positional prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-brief-both-"));
  try {
    writeFileSync(join(root, "brief.md"), "from the file\n");
    const io = capture();
    assert.equal(await runCli(["run", "default", "--brief", "brief.md", "some", "words", "--json"], {}, io, root), 1);
    const payload = JSON.parse(io.read().stderr) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "brief_and_prompt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lane run records lastRunId and refuses a second call while that run is open", async () => {
  const { root, origin } = makeLaneCheckout();
  const unit = "slice";
  const runId = "run_laneopen00000000000000000000";
  let posts = 0;
  let gets = 0;
  try {
    writeFileSync(join(root, "brief.md"), "  do the work\n");
    kxmDriveCliSeams.ensureSupervisor = async () => ({ runtimeId: "rtm_laneopen", port: 9, token: "tok", started: true });
    kxmDriveCliSeams.runtimeRequest = async (_handle, method, path, body) => {
      if (method === "POST" && path === "/v1/runs") {
        posts += 1;
        assert.equal((body as { prompt?: string }).prompt, "do the work");
        return {
          ok: true,
          run: { runId, homeRuntimeId: "rtm_laneopen", status: "created", configRevision: `sha256:${"a".repeat(64)}` },
        };
      }
      if (method === "GET") {
        gets += 1;
        return {
          ok: true,
          run: { runId, status: "running", workflowId: "default", configRevision: `sha256:${"a".repeat(64)}`, updatedAt: "2026-09-25T00:00:00.000Z" },
        };
      }
      if (method === "POST" && path.includes("/drive")) {
        return { ok: true, status: "accepted", runId, driveId: "drv_0123456789abcdef01234567", poll: `/v1/runs/${runId}`, mode: "live" };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const first = capture();
    assert.equal(await runCli(["lane", "run", unit, "--brief", "brief.md", "--json"], {}, first, root), 0, `${first.read().stderr}\n${first.read().stdout}`);
    const record = JSON.parse(readFileSync(join(root, ".kxm", "state", "lanes.json"), "utf8")) as { lanes: Record<string, { lastRunId?: string }> };
    assert.equal(record.lanes[unit]?.lastRunId, runId);
    assert.equal(posts, 1);
    const second = capture();
    assert.equal(await runCli(["lane", "run", unit, "--brief", "brief.md", "--json"], {}, second, root), 1);
    assert.equal((JSON.parse(second.read().stderr) as { error: string }).error, "lane_run_open");
    assert.equal(posts, 1);
    assert.equal(gets, 1);
  } finally {
    delete kxmDriveCliSeams.ensureSupervisor;
    delete kxmDriveCliSeams.runtimeRequest;
    removeLaneCheckout(root, origin, [unit]);
  }
});

test("lane run --json without --brief prints a usage_error envelope and exits 2", async () => {
  const io = capture();
  assert.equal(await runCli(["lane", "run", "probe", "--json"], {}, io), 2);
  const parsed = JSON.parse(io.read().stdout) as { schema?: string; ok?: boolean; command?: string; error?: string; detail?: string };
  assert.equal(parsed.schema, "kxm.cli-result.v1");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "lane run");
  assert.equal(parsed.error, "usage_error");
  assert.equal(parsed.detail, "error: required option '--brief <file>' not specified");
  assert.equal(io.read().stderr, "");
  const text = capture();
  assert.equal(await runCli(["lane", "run", "probe"], {}, text), 2);
  assert.equal(text.read().stdout, "");
  assert.equal(text.read().stderr, "error: required option '--brief <file>' not specified\n");
});

test("kxm land dry-run prints the verify plan", async () => {
  const io = capture();
  const code = await runCli(["land", "--stage", "verify", "--dry-run", "--json"], {}, io);
  assert.equal(code, 0, `${io.read().stderr}\n${io.read().stdout}`);
  const stdout = io.read().stdout;
  assert.match(stdout, /"stage":"verify"/);
  assert.match(stdout, /"dryRun":true/);
  assert.match(stdout, /npm run verify/);
});

test("kxm assign help lists the seven runner verbs", async () => {
  const help = capture();
  assert.equal(await runCli(["assign", "--help"], {}, help), 0);
  const text = help.read().stdout;
  for (const verb of ["run", "witness", "plan-current", "attribute", "observe-cost", "accept", "change-report"]) {
    assert.match(text, new RegExp(`\\b${verb}\\b`));
  }
});

test("kxm assign accept --dry-run --json prints the runner argv and exits 0", async () => {
  kxmAssignCliSeams.spawn = () => {
    throw new Error("dry-run spawned");
  };
  try {
    const io = capture();
    const code = await runCli([
      "assign", "accept",
      "--task-dir", "/t",
      "--commit", "abc",
      "--record-dir", "/r",
      "--critic", "/a",
      "--critic", "/b",
      "--dry-run", "--json",
    ], {}, io);
    assert.equal(code, 0);
    const payload = JSON.parse(io.read().stdout) as { ok: boolean; dryRun: boolean; argv: string[] };
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.deepEqual(payload.argv, [
      "node",
      "scripts/assignment-run.mjs",
      "accept",
      "--task-dir", "/t",
      "--commit", "abc",
      "--record-dir", "/r",
      "--critic", "/a",
      "--critic", "/b",
    ]);
  } finally {
    delete kxmAssignCliSeams.spawn;
  }
});

test("kxm assign run spawns the runner and returns the child exit code", async () => {
  let seen: { command: string; args: readonly string[]; cwd: string; stdio: string; env: NodeJS.ProcessEnv } | undefined;
  kxmAssignCliSeams.spawn = (command, args, options) => {
    seen = { command, args, cwd: options.cwd, stdio: options.stdio, env: options.env };
    return { status: 7 };
  };
  try {
    const io = capture();
    const code = await runCli(["assign", "run", "--manifest", "/m"], { KXM_ASSIGN_SENTINEL: "kept" }, io);
    assert.equal(code, 7);
    assert.equal(io.read().stdout, "");
    assert.ok(seen);
    assert.equal(seen.command, "node");
    assert.deepEqual(seen.args, ["scripts/assignment-run.mjs", "run", "--manifest", "/m"]);
    assert.equal(seen.stdio, "inherit");
    assert.equal(seen.cwd, process.cwd());
    assert.equal(seen.env.KXM_ASSIGN_SENTINEL, "kept");
  } finally {
    delete kxmAssignCliSeams.spawn;
  }
});

test("kxm assign accept forwards observed ids after the two critics", async () => {
  kxmAssignCliSeams.spawn = () => {
    throw new Error("dry-run spawned");
  };
  try {
    const io = capture();
    const code = await runCli([
      "assign", "accept",
      "--observed-ci", "ci-1",
      "--task-dir", "/t",
      "--commit", "abc",
      "--critic", "/a",
      "--record-dir", "/r",
      "--critic", "/b",
      "--observed-pr", "pr-9",
      "--dry-run", "--json",
    ], {}, io);
    assert.equal(code, 0);
    const payload = JSON.parse(io.read().stdout) as { argv: string[] };
    assert.deepEqual(payload.argv, [
      "node",
      "scripts/assignment-run.mjs",
      "accept",
      "--task-dir", "/t",
      "--commit", "abc",
      "--record-dir", "/r",
      "--critic", "/a",
      "--critic", "/b",
      "--observed-pr", "pr-9",
      "--observed-ci", "ci-1",
    ]);
  } finally {
    delete kxmAssignCliSeams.spawn;
  }
});

test("kxm assign witness without --record-dir exits 2 with a usage error", async () => {
  const io = capture();
  assert.equal(await runCli(["assign", "witness"], {}, io), 2);
  assert.match(`${io.read().stdout}${io.read().stderr}`, /record-dir|usage|required option/i);
});

test("kxm assign outside a project refuses project_required", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-assign-noproject-"));
  try {
    const io = capture();
    assert.equal(await runCli(["assign", "run", "--manifest", "/m", "--json"], {}, io, cwd), 1);
    const payload = JSON.parse(io.read().stderr) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "project_required");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kxm assign refuses assign_runner_missing when the runner script is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-assign-norunner-"));
  try {
    makeGitRoot(root);
    mkdirSync(join(root, ".kxm"), { recursive: true });
    writeFileSync(join(root, ".kxm", "project.yaml"), "schema: kxm.project.v1\n");
    const io = capture();
    assert.equal(await runCli(["assign", "change-report", "--task-dir", "/t", "--json"], {}, io, root), 1);
    const payload = JSON.parse(io.read().stderr) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "assign_runner_missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kxm run implement-only --dry-run plans with no prerequisites", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-impl-only-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-impl-only-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JIMPLONLY0000000000000", projectName: "Implement Only" });
    const source = join(dirname(fileURLToPath(import.meta.url)), "../../.kxm/workflows/implement-only.yaml");
    cpSync(source, join(cwd, ".kxm", "workflows", "implement-only.yaml"));
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });
    const dryIo = capture();
    assert.equal(await runCli(["run", "implement-only", "--dry-run", "--json"], env, dryIo, cwd), 0, dryIo.read().stderr);
    const planned = JSON.parse(dryIo.read().stdout) as { dryRun: boolean; prerequisites: Array<{ field?: string }> };
    assert.equal(planned.dryRun, true);
    assert.deepEqual(planned.prerequisites, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("a second runs drive after a handoff receipt is admitted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-drive-again-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-drive-again-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    initializeKxmProject(cwd, { projectId: "prj_01JDRIVEAGAIN00000000000", projectName: "Drive Again" });
    cpSync(
      join(dirname(fileURLToPath(import.meta.url)), "../fixtures/engine/unsupported-gate.yaml"),
      join(cwd, ".kxm", "workflows", "unsupported-gate.yaml"),
    );
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });
    const createdIo = capture();
    assert.equal(await runCli(["run", "unsupported-gate", "--json", "handoff"], env, createdIo, cwd), 0, createdIo.read().stderr);
    const runId = (JSON.parse(createdIo.read().stdout) as { run: { runId: string } }).run.runId;
    const firstIo = capture();
    assert.equal(await runCli(["runs", "drive", runId, "--json", "--simulated"], env, firstIo, cwd), 0, firstIo.read().stderr);
    const deadline = Date.now() + 10_000;
    let kind = "";
    while (Date.now() < deadline) {
      const statusIo = capture();
      assert.equal(await runCli(["runs", "status", runId, "--json"], env, statusIo, cwd), 0, statusIo.read().stderr);
      const status = JSON.parse(statusIo.read().stdout) as { drive?: { receipt?: { settlement?: { kind?: string } } | null } };
      kind = status.drive?.receipt?.settlement?.kind ?? "";
      if (kind === "handoff") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(kind, "handoff");
    const secondIo = capture();
    assert.equal(await runCli(["runs", "drive", runId, "--json", "--simulated"], env, secondIo, cwd), 0, secondIo.read().stderr);
    const second = JSON.parse(secondIo.read().stdout) as { ok: boolean; status?: string; error?: string };
    assert.equal(second.ok, true);
    assert.equal(second.status, "accepted");
    assert.notEqual(second.error, "run_busy");
  } finally {
    try { await runCli(["runtime", "stop", "--json"], env, capture(), cwd); } catch { /* best effort */ }
    await waitForSupervisorExit(env);
    rmWithRetry(cwd);
    rmWithRetry(stateRoot);
  }
});
