#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HubClient } from "../plugins/kxm/dist/client.js";
import { buildArgv } from "./harness-run.mjs";

// Launch intent only: these labels are not observed model identity or admission.
export function nativeCriticLaunch(harness) {
  if (!["fable", "astra", "opus"].includes(harness)) {
    throw new Error("usage: native-critic.mjs <fable|astra|opus> <prompt>");
  }
  const model = harness === "fable" ? "fable" : harness === "opus" ? "opus" : "gpt-6-astra";
  const command = harness === "fable" || harness === "opus" ? "claude" : "codex";
  const args = harness === "fable" || harness === "opus"
    ? ["-p", "--model", model, "--effort", "medium", "--output-format", "json", "--no-session-persistence", "--tools", "Read,Glob,Grep", "--setting-sources", "user"]
    : buildArgv({ harness: "codex", model, effort: "low", permission: "read-only", prompt_file: "-" });
  return { model, command, args };
}

async function main() {
  const [harness, ...promptParts] = process.argv.slice(2);
  let launch;
  try {
    launch = nativeCriticLaunch(harness);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const { model, command, args } = launch;
  const env = process.env;
  const serverUrl = env.KXM_SERVER_URL || "http://127.0.0.1:7331";
  const outDir = env.KXM_CRITIC_DIR || join(process.cwd(), ".kxm", "assets", "critic-reviews");
  mkdirSync(outDir, { recursive: true });
  const client = new HubClient({ serverUrl, authToken: env.KXM_AUTH_TOKEN, name: `${harness}-critic`, purpose: "independent CLI critic", project: env.KXM_PROJECT || ".kxm", model });
  const prompt = promptParts.join(" ");
  const agent = await client.start(() => { });
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(prompt);
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(outDir, `${harness}-${stamp}.json`);
  writeFileSync(path, JSON.stringify({ schema: "kxm.native-critic-review.v1", harness, model, agentId: agent.id, completedAt: new Date().toISOString(), ...result }, null, 2) + "\n", { mode: 0o600 });
  try { await client.send({ target: env.KXM_REVIEW_TARGET || agent.id, content: `${harness} review completed; artifact=${path}; exit=${String(result.code)}`, delivery: "followUp", idempotencyKey: `critic:${harness}:${stamp}` }); } catch { /* Transport artifact remains, not approval or hub peer-reply evidence. */ }
  await client.stop();
  if (result.code !== 0) process.exit(result.code ?? 1);
  console.log(path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
