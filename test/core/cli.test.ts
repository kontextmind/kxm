import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCli as runCliImplementation, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { writeHubEnvRecord } from "../../plugins/kxm/src/hub-env.ts";
import { cmdKxmRunStatus, kxmDriveCliSeams } from "../../plugins/kxm/src/cli/project.ts";
import type { Runtime } from "../../plugins/kxm/src/cli/types.ts";
import { kxmLocalBindingFile } from "../../plugins/kxm/src/bindings.ts";
import { hubBindingScope } from "../../plugins/kxm/src/hub-binding.ts";
import { initializeKxmProject } from "../../plugins/kxm/src/init.ts";
import { stringify } from "yaml";

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

  const ok = capture();
  assert.equal(await runCli(["harness", "list", "--json"], {}, ok), 0);
  assert.equal(ok.read().stderr, "");
  assert.equal((JSON.parse(ok.read().stdout) as { schema: string }).schema, "kxm.cli-result.v1");
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
  assert.match(hub.read().stderr, /unknown option '--hub'/);
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
    assert.equal(created.files.length, 7);
    assert(created.files.includes(".kxm/gates.yaml"));
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
    };
    assert.equal(created.run.status, "created");
    assert.equal(created.supervisor.started, true);
    assert(!runIo.read().stdout.includes("flaky gate"), "prompt content never appears in output");

    const listIo = capture();
    assert.equal(await runCli(["runs", "list", "--json"], env, listIo, cwd), 0);
    const list = JSON.parse(listIo.read().stdout) as { runs: Array<{ runId: string; status: string }> };
    assert.equal(list.runs.length, 1);
    assert.equal(list.runs[0]!.runId, created.run.runId);

    const statusIo = capture();
    assert.equal(await runCli(["runs", "status", created.run.runId, "--json"], env, statusIo, cwd), 0);
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
    assert.equal(await runCli(["improve", "--json", "--workspace", cwd, "--target", "project"], {}, improve, cwd), 0);
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
      signature = new Headers(init?.headers).get("x-hub-signature-256") ?? "";
      return new Response(JSON.stringify({ run: { id: "run_cli" }, duplicate: false }), { status: 202 });
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
  assert.match(review.instructions, /kxm_await with that messageId and timeoutMs 120000/);
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

test("cli hub commands fall back to the persisted hub env admin token", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-cli-auth-admin-"));
  try {
    writeFileSync(join(stateHome, "hub-env.json"), JSON.stringify({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-16T00:00:00.000Z",
      authToken: "persisted-admin-token",
    }));
    const io = capture();
    const authorizations: string[] = [];
    const code = await runCli(["peer", "inbox", "--json"], {
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
    assert.ok(seen.every((a) => a === "Bearer persisted-admin-token"), seen.join(","));
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
