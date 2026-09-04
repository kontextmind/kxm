import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCli } from "../plugins/kxm/src/cli.ts";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => { stdout += text; },
    stderr: (text: string) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

function workflowDefinition(input: { signal?: boolean } = {}) {
  return [{
    id: "configured-workflow",
    source: "generic",
    project: "demo",
    target: "coordinator",
    secretEnv: "CUSTOM_START_SECRET",
    ...(input.signal === false ? {} : { signalSecretEnv: "CUSTOM_SIGNAL_SECRET" }),
    promptTemplate: "do the work",
    stages: [{
      id: "build",
      label: "Build",
      instructions: "build",
      requiredEvidence: [],
      maxAttempts: 1,
    }],
  }];
}

test("workflow start, signal, and github watch resolve credentials from the active workflow file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-definition-secret-"));
  try {
    const definitionFile = join(cwd, "workflows.json");
    writeFileSync(definitionFile, JSON.stringify(workflowDefinition()));
    const startSecret = "definition-start-secret-123";
    const signalSecret = "definition-signal-secret-123";
    const env = {
      KXM_WEBHOOK_WORKFLOWS_FILE: definitionFile,
      KXM_WORKFLOW_ID: "configured-workflow",
      CUSTOM_START_SECRET: startSecret,
      CUSTOM_SIGNAL_SECRET: signalSecret,
      KXM_WORKFLOW_SECRET: "legacy-start-secret-must-not-win",
      KXM_WORKFLOW_SIGNAL_SECRET: "legacy-signal-secret-must-not-win",
      GITHUB_TOKEN: "github-test-token",
    };

    let startBody = "";
    let startSignature = "";
    const startIo = capture();
    const startCode = await runCli(
      ["workflow", "--json", "start", "configured-workflow", "--payload", "{\"task\":\"T-1\"}"],
      env,
      {
        ...startIo,
        fetchImpl: async (_input, init) => {
          startBody = String(init?.body ?? "");
          startSignature = new Headers(init?.headers).get("x-hub-signature-256") ?? "";
          return new Response(JSON.stringify({ run: { id: "run_1" } }), { status: 202 });
        },
      },
      cwd,
    );
    assert.equal(startCode, 0, startIo.read().stderr);
    assert.equal(
      startSignature,
      `sha256=${createHmac("sha256", startSecret).update(startBody).digest("hex")}`,
    );

    let signalBody = "";
    let signalSignature = "";
    const signalIo = capture();
    const signalCode = await runCli(
      ["gate", "--json", "signal", "run_1", "ready", "passed", "done"],
      env,
      {
        ...signalIo,
        fetchImpl: async (_input, init) => {
          signalBody = String(init?.body ?? "");
          signalSignature = new Headers(init?.headers).get("x-hub-signature-256") ?? "";
          return new Response(JSON.stringify({ duplicate: false }), { status: 202 });
        },
      },
      cwd,
    );
    assert.equal(signalCode, 0, signalIo.read().stderr);
    assert.equal(
      signalSignature,
      `sha256=${createHmac("sha256", signalSecret).update(signalBody).digest("hex")}`,
    );

    let watchBody = "";
    let watchSignature = "";
    const watchIo = capture();
    const watchCode = await runCli(
      [
        "gate", "--json", "github", "watch",
        "--run-id", "run_1",
        "--stage-id", "review",
        "--signal-key", "checks",
        "--repo", "acme/app",
        "--pr", "7",
        "--required", "ci",
        "--timeout-ms", "1000",
        "--interval-ms", "1",
      ],
      env,
      {
        ...watchIo,
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.includes("api.github.com") && url.includes("/pulls/7")) {
            return new Response(JSON.stringify({ head: { sha: "abc123" } }), { status: 200 });
          }
          if (url.includes("api.github.com") && url.includes("/check-runs")) {
            return new Response(JSON.stringify({
              total_count: 1,
              check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
            }), { status: 200 });
          }
          watchBody = String(init?.body ?? "");
          watchSignature = new Headers(init?.headers).get("x-hub-signature-256") ?? "";
          return new Response(JSON.stringify({ duplicate: false }), { status: 202 });
        },
      },
      cwd,
    );
    assert.equal(watchCode, 0, `${watchIo.read().stdout}\n${watchIo.read().stderr}`);
    assert.equal(
      watchSignature,
      `sha256=${createHmac("sha256", signalSecret).update(watchBody).digest("hex")}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an active workflow signal falls back to its start secret, never a generic env secret", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-definition-fail-closed-"));
  try {
    const definitionFile = join(cwd, "workflows.json");
    writeFileSync(definitionFile, JSON.stringify(workflowDefinition({ signal: false })));
    const startSecret = "definition-start-secret-123";
    let body = "";
    let signature = "";
    const io = capture();
    const code = await runCli(
      ["gate", "--json", "signal", "run_1", "ready", "passed", "done"],
      {
        KXM_WEBHOOK_WORKFLOWS_FILE: definitionFile,
        KXM_WORKFLOW_ID: "configured-workflow",
        CUSTOM_START_SECRET: startSecret,
        KXM_WORKFLOW_SIGNAL_SECRET: "legacy-signal-secret-must-not-win",
      },
      {
        ...io,
        fetchImpl: async (_input, init) => {
          body = String(init?.body ?? "");
          signature = new Headers(init?.headers).get("x-hub-signature-256") ?? "";
          return new Response(JSON.stringify({ duplicate: false }), { status: 202 });
        },
      },
      cwd,
    );
    assert.equal(code, 0, io.read().stderr);
    assert.equal(signature, `sha256=${createHmac("sha256", startSecret).update(body).digest("hex")}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an active workflow start never falls back to a generic secret", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-definition-start-fail-closed-"));
  try {
    const definitionFile = join(cwd, "workflows.json");
    writeFileSync(definitionFile, JSON.stringify(workflowDefinition({ signal: false })));
    const io = capture();
    const code = await runCli(
      ["workflow", "--json", "start", "configured-workflow", "--payload", "{}"],
      {
        KXM_WEBHOOK_WORKFLOWS_FILE: definitionFile,
        KXM_WORKFLOW_SECRET: "legacy-start-secret-must-not-win",
      },
      io,
      cwd,
    );
    assert.equal(code, 2);
    assert.match(io.read().stderr, /workflow\.secret must be a string|CUSTOM_START_SECRET.*required/);
    assert.doesNotMatch(`${io.read().stdout}\n${io.read().stderr}`, /legacy-start-secret-must-not-win/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("worker-envelope dry-runs leave telemetry unchanged", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-dry-telemetry-"));
  try {
    const workspace = join(cwd, ".kxm");
    const logs = join(workspace, "logs");
    const telemetry = join(logs, "telemetry.jsonl");
    mkdirSync(logs, { recursive: true });
    writeFileSync(telemetry, "existing-event\n");
    const before = readFileSync(telemetry, "utf8");
    const io = capture();
    const code = await runCli(
      [
        "gate", "--json", "--dry-run", "--workspace", workspace,
        "signal", "run_1", "ready", "passed", "done",
      ],
      {
        KXM_WORKFLOW_ID: "legacy-workflow",
        KXM_WORKFLOW_SIGNAL_SECRET: "legacy-signal-secret-123",
      },
      io,
      cwd,
    );
    assert.equal(code, 0, io.read().stderr);
    assert.equal(readFileSync(telemetry, "utf8"), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("artifacts-exist accepts only non-empty regular files contained by real workspace assets", async (context) => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-artifacts-"));
  try {
    const workspace = join(cwd, ".kxm");
    const assets = join(workspace, "assets");
    mkdirSync(join(assets, "outputs"), { recursive: true });
    const valid = join(assets, "outputs", "report.md");
    const empty = join(assets, "outputs", "empty.md");
    const directory = join(assets, "outputs");
    const missing = join(assets, "outputs", "missing.md");
    const outside = join(cwd, "outside.md");
    writeFileSync(valid, "verified\n");
    writeFileSync(empty, "");
    writeFileSync(outside, "outside\n");

    const invoke = async (path: string) => {
      const io = capture();
      const code = await runCli(
        ["gate", "--json", "--workspace", workspace, "artifacts-exist", "--path", path],
        {},
        io,
        cwd,
      );
      return { code, ...io.read() };
    };

    const accepted = await invoke(valid);
    assert.equal(accepted.code, 0, accepted.stdout);
    assert.match(accepted.stdout, /"name":"artifacts-exist"/);
    assert.match(accepted.stdout, /"bytes":9/);

    const emptyResult = await invoke(empty);
    assert.equal(emptyResult.code, 1);
    assert.match(emptyResult.stderr, /artifact_empty/);

    const directoryResult = await invoke(directory);
    assert.equal(directoryResult.code, 1);
    assert.match(directoryResult.stderr, /artifact_not_file/);

    const missingResult = await invoke(missing);
    assert.equal(missingResult.code, 1);
    assert.match(missingResult.stderr, /artifact_missing/);

    const outsideResult = await invoke(outside);
    assert.equal(outsideResult.code, 1);
    assert.match(outsideResult.stderr, /artifact_outside_workspace_assets/);

    const escaped = join(assets, "outputs", "escaped.md");
    try {
      symlinkSync(outside, escaped, "file");
      const escapedResult = await invoke(escaped);
      assert.equal(escapedResult.code, 1);
      assert.match(escapedResult.stderr, /artifact_outside_workspace_assets/);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
      context.diagnostic(`symlink escape assertion skipped on this host: ${code}`);
    }

    assert.equal(
      await runCli(["gate", "--json", "artifacts-exist"], {}, capture(), cwd),
      2,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session start maps SessionConfigError to exit 2 without creating assets", async (context) => {
  const sessionSource = readFileSync(resolve("plugins/kxm/src/session.ts"), "utf8");
  if (!sessionSource.includes("SessionConfigError")) {
    context.skip("WS2 SessionConfigError has not landed in this checkout");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-session-config-"));
  try {
    const workspace = join(cwd, ".kxm");
    const config = join(workspace, "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "agents.json"), JSON.stringify({ agents: [] }));
    writeFileSync(join(config, "gates.json"), JSON.stringify({ gates: [] }));
    const io = capture();
    const code = await runCli(
      ["session", "--json", "--workspace", workspace, "start", "--id", "bad", "--mix", "unknown-worker"],
      {},
      io,
      cwd,
    );
    assert.equal(code, 2, `${io.read().stdout}\n${io.read().stderr}`);
    assert.equal(existsSync(join(workspace, "assets", "sessions", "bad")), false);
    assert.match(io.read().stderr, /unknown-worker|unknown/i);

    writeFileSync(join(config, "agents.json"), "{not json");
    const workflowIo = capture();
    const workflowCode = await runCli(
      ["session", "--json", "--workspace", workspace, "start", "--id", "bad-workflow", "--workflow", "workflow-id"],
      {},
      workflowIo,
      cwd,
    );
    assert.equal(workflowCode, 2, `${workflowIo.read().stdout}\n${workflowIo.read().stderr}`);
    assert.equal(existsSync(join(workspace, "assets", "sessions", "bad-workflow")), false);
    assert.match(workflowIo.read().stderr, /not valid JSON/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
