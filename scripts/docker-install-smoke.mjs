#!/usr/bin/env node
// Fresh-container install smoke: proves the packed kxm tarball installs into a
// clean Docker container with a brand-new Pi installation, that every runtime
// dependency lands, and that two configured plan providers complete a live
// turn. Secrets come from pass-cli and are injected through a mode-600 env
// file inside a temp directory that is removed afterwards; they never touch
// argv, the image, or the repository.
//
// Usage: just docker-install-smoke
// Requires: docker daemon, pass-cli session, ~/.pi/agent/models-store.json.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

const vault = process.env.KXM_SMOKE_VAULT ?? "AI Provider Keys";
const image = process.env.KXM_SMOKE_IMAGE ?? "node:24-slim";
const modelsStorePath = process.env.KXM_SMOKE_MODELS_STORE ?? join(homedir(), ".pi/agent/models-store.json");

// provider id -> { env, item, field, model }. The zai key is stored in the
// SshKey public_key slot of its pass item (upstream quirk); the qwen key is an
// extra Hidden field named "API Key".
const providers = [
  {
    id: "zai-coding-cn",
    env: "ZAI_CODING_CN_API_KEY",
    item: process.env.KXM_SMOKE_ZAI_ITEM ?? "Z.ai",
    field: process.env.KXM_SMOKE_ZAI_FIELD ?? "public_key",
    model: process.env.KXM_SMOKE_ZAI_MODEL ?? "glm-5.3-flash",
  },
  {
    id: "qwen-token-plan",
    env: "QWEN_TOKEN_PLAN_API_KEY",
    item: process.env.KXM_SMOKE_QWEN_ITEM ?? "Alibaba Cloud Personal Plan",
    field: process.env.KXM_SMOKE_QWEN_FIELD ?? "API Key",
    model: process.env.KXM_SMOKE_QWEN_MODEL ?? "qwen3.8-flash",
  },
];

function die(message) {
  process.stderr.write(`docker-install-smoke: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    die(`\`${command} ${args.join(" ")}\` failed (${result.status})\n${result.stderr || result.stdout}`);
  }
  return result;
}

function passItem(title) {
  const result = spawnSync(
    "pass-cli",
    ["item", "view", "--vault-name", vault, "--item-title", title, "--output", "json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    die(`pass-cli could not read item ${JSON.stringify(title)} in vault ${JSON.stringify(vault)}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout)?.item?.content;
}

// Field values hide in either extra_fields (by name) or the SshKey section.
function extractField(content, field) {
  const extra = content.extra_fields?.find((candidate) => candidate.name === field);
  if (extra) {
    const values = extra.content ?? {};
    return values.Hidden ?? values.Text;
  }
  return content.content?.SshKey?.[field];
}

function main() {
  for (const tool of ["docker", "pass-cli", "npm"]) {
    if (spawnSync(tool, ["--version"], { encoding: "utf8" }).status !== 0) {
      die(`${tool} is required but not on PATH`);
    }
  }
  const daemon = spawnSync("docker", ["info", "--format", "ok"], { encoding: "utf8" });
  if (daemon.status !== 0) {
    die("docker daemon is not reachable; start Docker and retry");
  }

  const scratch = mkdtempSync(join(tmpdir(), "kxm-install-smoke-"));
  try {
    // 1. Pack the working tree. The committed dist must be current; the
    //    commit gate (`npm run verify` -> check:generated) enforces that.
    process.stdout.write("==> npm pack\n");
    const packed = run("npm", ["pack", "--pack-destination", scratch, "--json"], { cwd: repoRoot });
    const filename = JSON.parse(packed.stdout)[0]?.filename;
    if (!filename) die("npm pack produced no tarball");
    const tarball = join(scratch, filename);

    // 2. Provider models from the local pi catalog (no secrets in this file).
    const store = JSON.parse(readFileSync(modelsStorePath, "utf8"));
    const configured = {};
    const envLines = [];
    for (const provider of providers) {
      const entry = store[provider.id];
      if (!entry) {
        die(`provider ${provider.id} is missing from ${modelsStorePath}`);
      }
      const models = entry.models.map((model) => {
        const copy = { ...model };
        delete copy.checkedAt;
        delete copy.lastModified;
        delete copy.etag;
        return copy;
      });
      if (models.length === 0) die(`provider ${provider.id} has no models in ${modelsStorePath}`);
      configured[provider.id] = {
        baseUrl: models[0].baseUrl,
        api: models[0].api ?? "openai-completions",
        apiKey: `$${provider.env}`,
        models,
      };
      const key = extractField(passItem(provider.item), provider.field);
      if (!key) {
        die(`no value found for ${provider.item} / ${provider.field} in vault ${vault}`);
      }
      process.stdout.write(`==> key for ${provider.id}: item=${JSON.stringify(provider.item)} field=${provider.field} len=${key.length}\n`);
      envLines.push(`${provider.env}=${key}`);
    }
    const modelsJson = join(scratch, "models.json");
    writeFileSync(modelsJson, `${JSON.stringify({ providers: configured }, null, 2)}\n`);

    // 3. Keys go into a mode-600 env file only; docker --env-file injects them
    //    into the container environment without ever appearing in argv.
    const envFile = join(scratch, "providers.env");
    writeFileSync(envFile, `${envLines.join("\n")}\n`, { mode: 0o600 });
    chmodSync(envFile, 0o600);

    // 4. The in-container flow: fresh pi, both providers live, kxm operator
    //    install with the documented --omit=peer path, pi package install,
    //    then the README first-run flow.
    const smokeModels = providers.map((provider) => ({
      id: provider.id,
      env: provider.env,
      model: provider.model,
      token: `${provider.id.toUpperCase().replaceAll(/[^A-Z]/g, "")}_SMOKE_OK`,
    }));
    const container = join(scratch, "container.sh");
    writeFileSync(container, containerScript(smokeModels, filename));

    process.stdout.write(`==> docker run ${image}\n`);
    const result = spawnSync("docker", [
      "run", "--rm",
      "-v", `${scratch}:/mnt:ro`,
      "--env-file", envFile,
      image, "bash", "/mnt/container.sh",
    ], { stdio: "inherit" });
    if (result.status !== 0) {
      die(`container smoke failed with ${result.status}`);
    }
    process.stdout.write("==> install smoke passed\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function containerScript(smokeModels, filename) {
  const [first, second] = smokeModels;
  return `#!/bin/bash
# Generated by scripts/docker-install-smoke.mjs. Runs inside a clean container.
set -uo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== toolchain versions =="
node --version
npm --version
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1
git --version

echo
echo "== [1/7] fresh pi installation (npm global, --ignore-scripts) =="
npm install -g --ignore-scripts @earendil-works/pi-coding-agent --no-audit --no-fund >/tmp/pi-install.log 2>&1 \\
  || { tail -20 /tmp/pi-install.log; fail "pi global install failed"; }
pi --version || fail "pi not on PATH after global install"

echo
echo "== [2/7] custom providers load with env-var auth =="
mkdir -p ~/.pi/agent
cp /mnt/models.json ~/.pi/agent/models.json
${smokeModels.map((provider) => `env | grep -q '^${provider.env}=.' || fail "${provider.env} env missing"`).join("\n")}
LM=$(pi --list-models 2>&1) || fail "pi --list-models failed: $LM"
${smokeModels.map((provider) => `echo "$LM" | grep -qi "${provider.id}" || fail "${provider.id} models not available: $LM"`).join("\n")}
${smokeModels.map((provider) => `echo "  ${provider.id}: $(echo "$LM" | grep -ci '${provider.id}') models listed"`).join("\n")}

echo
echo "== [3/7] live completion: ${first.id} / ${first.model} =="
Z=$(pi --provider ${first.id} --model ${first.model} -p "Reply with exactly this token and nothing else: ${first.token}") \\
  || fail "${first.id} completion failed"
echo "  reply: $Z"
echo "$Z" | grep -q "${first.token}" || fail "${first.id} reply missing expected token"

echo
echo "== [4/7] live completion: ${second.id} / ${second.model} =="
Q=$(pi --provider ${second.id} --model ${second.model} -p "Reply with exactly this token and nothing else: ${second.token}") \\
  || fail "${second.id} completion failed"
echo "  reply: $Q"
echo "$Q" | grep -q "${second.token}" || fail "${second.id} reply missing expected token"

echo
echo "== [5/7] kxm operator CLI: documented global --omit=peer tarball install =="
GROOT_BEFORE=$(ls "$(npm root -g)")
npm install --global --omit=peer --no-audit --no-fund /mnt/${filename} >/tmp/kxm-install.log 2>&1 \\
  || { tail -20 /tmp/kxm-install.log; fail "kxm global install failed"; }
kxm hub help 2>&1 | grep -q "Usage: kxm hub" || fail "kxm hub help did not run (runtime deps missing?)"
echo "  kxm bin runs: OK"
GROOT=$(npm root -g)
for d in @anthropic-ai/claude-agent-sdk @earendil-works/pi-tui @modelcontextprotocol/sdk yaml; do
  if [ -d "$GROOT/@kontextmind/kxm/node_modules/$d" ] || [ -d "$GROOT/$d" ]; then
    echo "  dependency installed: $d"
  else
    fail "dependency NOT installed: $d"
  fi
done
if [ -d "$GROOT/typebox" ] && ! echo "$GROOT_BEFORE" | grep -q "^typebox$"; then
  fail "peer typebox was installed despite --omit=peer"
fi
echo "  peers correctly omitted (--omit=peer); CLI still runs"

echo
echo "== [6/7] pi package surface (extension + skills) =="
mkdir -p /opt/kxm-pkg
tar -xzf /mnt/${filename} -C /opt/kxm-pkg --strip-components=1
cd /opt/kxm-pkg
npm install --omit=dev --no-audit --no-fund >/tmp/pkg-install.log 2>&1 \\
  || { tail -20 /tmp/pkg-install.log; fail "package npm install failed (pi git-install step)"; }
pi install /opt/kxm-pkg >/tmp/pi-install-pkg.log 2>&1 || { tail -20 /tmp/pi-install-pkg.log; fail "pi install of kxm package failed"; }
pi list 2>&1 | grep -qi "kxm" || fail "pi list does not show kxm"
echo "  pi list shows kxm package: OK"

echo
echo "== [7/7] first-run flow: kxm init + hub + bind + session brief =="
mkdir -p /testproj && cd /testproj && git init -q .
kxm init --json --name docker-smoke --project-id prj_01JDOCKERTESTSMOKE000000000 || fail "kxm init failed"
export KXM_AUTH_TOKEN="docker-admin-token"
export KXM_PROJECT_TOKENS='{"docker-smoke":"proj-token"}'
nohup kxm hub start >/tmp/hub.log 2>&1 &
for i in $(seq 1 30); do grep -q "listening at" /tmp/hub.log 2>/dev/null && break; sleep 1; done
grep "listening at" /tmp/hub.log || { cat /tmp/hub.log; fail "hub did not start"; }
kxm hub bind http://127.0.0.1:7331 || fail "hub bind failed"
kxm session brief >/dev/null || fail "session brief failed"
echo "  first-run flow: OK"

echo
echo "== final: pi print-mode run with kxm extension loaded =="
OUT=$(pi --provider ${first.id} --model ${first.model} -p "Reply with exactly: FINAL_OK" 2>/tmp/pi-ext.err) \\
  || { cat /tmp/pi-ext.err; fail "final pi run failed"; }
if grep -iE "failed to load|extension error|cannot find" /tmp/pi-ext.err >/dev/null; then
  cat /tmp/pi-ext.err; fail "kxm extension load errors in pi"
fi
echo "  no extension load errors"
echo "  final reply: $OUT"
echo "$OUT" | grep -q "FINAL_OK" || fail "final reply missing expected token"

echo
echo "ALL CHECKS PASSED"
`;
}

main();
