import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("resolveBoundPolicy loads a committed policy and returns that identity", () => {
  const runner = readFileSync("scripts/assignment-run.mjs", "utf8");
  assert.match(runner, /resolveBoundPolicy,\r?\n\} from "\.\/roster-policy\.mjs"/);
  const fixture = mkdtempSync(join(resolve("."), ".tmp-roster-bind-"));
  const root = spawnSync("realpath", [fixture], { encoding: "utf8" }).stdout.trim() || fixture;
  try {
    mkdirSync(join(root, ".kxm", "models"), { recursive: true });
    mkdirSync(join(root, ".kxm", "roles"), { recursive: true });
    mkdirSync(join(root, "docs", "reference"), { recursive: true });
    for (const name of ["fable-claude.yaml", "gemini-agy.yaml", "grok-native.yaml", "opus-claude.yaml", "qwen-openrouter-pi.yaml", "sol-codex.yaml"]) {
      cpSync(join(".kxm", "models", name), join(root, ".kxm", "models", name));
    }
    for (const name of ["planner.yaml", "reviewer-arch.yaml", "reviewer-cli.yaml", "writer.yaml"]) {
      cpSync(join(".kxm", "roles", name), join(root, ".kxm", "roles", name));
    }
    cpSync("docs/reference/harness-routing.md", join(root, "docs", "reference", "harness-routing.md"));
    const source = readFileSync("scripts/roster-policy.mjs", "utf8").replace(
      "const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
      `const ROOT = ${JSON.stringify(root)};`,
    );
    writeFileSync(join(root, "roster-policy.mjs"), source);
    cpSync("scripts/harness-run.mjs", join(root, "harness-run.mjs"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
    };
    git("-c", "init.defaultBranch=main", "init", "--quiet");
    git("add", "-A");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "policy");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { loadTrustedRosterPolicy, resolveBoundPolicy } from ${JSON.stringify(pathToFileURL(join(root, "roster-policy.mjs")).href)};
      const loaded = loadTrustedRosterPolicy();
      const resolved = resolveBoundPolicy(loaded.identity);
      if (resolved.identity.blob !== loaded.identity.blob) throw new Error("blob");
      if (resolved.identity.sha256 !== loaded.identity.sha256) throw new Error("sha256");
      if (resolved.identity.commit !== loaded.identity.commit) throw new Error("commit");
      if (!resolved.policy.lineup.writer.includes("grok-native")) throw new Error("writer lineup");
      if (resolved.policy.lineup["reviewer-arch"][0] !== "fable-claude") throw new Error("reviewer-arch");
    `], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: resolve("node_modules") },
    });
    assert.equal(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
