import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { runHarness } from "../../scripts/harness-run.mjs";

const authFixtures = JSON.parse(
  readFileSync(resolve("test/fixtures/harness/auth-fixtures.json"), "utf8"),
) as Record<string, Record<string, unknown>>;

export function authFixture(name: string): Record<string, unknown> {
  const fixture = authFixtures[name];
  assert(fixture, `missing auth fixture ${name}`);
  return fixture;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kxm-harness-"));
}

export function promptFile(dir: string, body = "brief"): string {
  const path = join(dir, "brief.md");
  writeFileSync(path, body);
  return path;
}

export function fakeChild(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
  hang?: boolean;
  ignoreKill?: boolean;
  keepPipesOpen?: boolean;
} = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: (signal?: string) => boolean;
    killed?: boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let completed = false;
  const complete = (code: number | null, signal: string | null = null) => {
    if (completed) return;
    completed = true;
    child.emit("exit", code, signal);
    if (!options.keepPipesOpen) {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code, signal);
    }
  };
  child.kill = (signal?: string) => {
    child.killed = true;
    if (options.ignoreKill) return true;
    complete(null, signal ?? "SIGTERM");
    return true;
  };
  queueMicrotask(() => {
    if (options.hang) return;
    if (options.stdout) child.stdout.write(options.stdout);
    if (options.stderr) child.stderr.write(options.stderr);
    complete(options.exitCode ?? 0, options.signal ?? null);
  });
  return child;
}

export function grokAuth() {
  const fixture = authFixture("grok");
  return { status: 0, stdout: String(fixture.stdout), stderr: "", error: undefined };
}

export function claudeAuth() {
  const fixture = authFixture("claude");
  return {
    status: 0,
    stdout: `${JSON.stringify({
      loggedIn: fixture.loggedIn,
      authMethod: fixture.authMethod,
      apiProvider: fixture.apiProvider,
      subscriptionType: fixture.subscriptionType,
    })}\n`,
    stderr: "",
    error: undefined,
  };
}

export function codexAuth() {
  const fixture = authFixture("codex");
  return { status: 0, stdout: String(fixture.stdout), stderr: String(fixture.stderr), error: undefined };
}

export function piAuth(provider = "openrouter") {
  return { status: 0, stdout: `${provider}  ready\n`, stderr: "", error: undefined };
}

export async function dispatch(request: Record<string, unknown>, assignment: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  hang?: boolean;
}, auth = grokAuth(), extras: Record<string, unknown> = {}) {
  const spawns: Array<{ command: string; argv: string[]; options: { shell?: boolean } }> = [];
  const result = await runHarness(request as never, {
    platform: extras.platform ?? process.platform,
    env: { PATH: extras.pathEnv ?? "/tmp/kxm-harness-bin", ...(extras.env as object ?? {}) },
    existsSync: extras.existsSync ?? ((path: string) => String(path).includes(String(request.harness))),
    spawnSync: () => auth,
    spawn: (command: string, argv: string[], options: { shell?: boolean }) => {
      spawns.push({ command, argv, options });
      return fakeChild(assignment);
    },
    observedAt: "2026-09-05",
    now: () => 1_000,
    ...extras,
  });
  return { result, spawns };
}
