#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_START = "<!-- kxm:codex:commands:start -->";
const MARKER_END = "<!-- kxm:codex:commands:end -->";
const SKILL_NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/u;
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/u;
const MANIFEST_REL = "plugins/kxm/skill-suite.json";

export const CODEX_COMMANDS_BLOCK = `${MARKER_START}
## KXM agent commands

The \`kxm\` CLI is the unified agent surface for peer collaboration and workflow stages. Every command supports \`--json\`.

### Peer messaging (\`kxm peer <verb> --json\`)

| Command | Purpose | Key options |
|---|---|---|
| \`kxm peer list\` | List online peer agents and purposes | \`--json\` |
| \`kxm peer send [target] [content]\` | Send a focused request to a peer | \`--target\`, \`--content\`, \`--delivery <steer\\|followUp\\|nextTurn>\`, \`--correlation-id\`, \`--idempotency-key\`, \`--workflow-context <json>\`, \`--ttl-ms\` |
| \`kxm peer get [messageId]\` | Check request status without blocking | \`--message-id\` |
| \`kxm peer await [messageId]\` | Wait for reply (capped at 60 seconds) | \`--message-id\`, \`--timeout-ms\` (max 60000) |
| \`kxm peer cancel [messageId]\` | Cancel a queued or delivered request | \`--message-id\` |
| \`kxm peer fanout\` | Send same request to 1–3 peers | \`--targets <t1,t2>\`, \`--content\`, \`--timeout-ms\`, \`--workflow-context <json>\` |
| \`kxm peer inbox\` | List inbound requests awaiting a reply | \`--json\` |
| \`kxm peer reply [messageId] [content]\` | Reply to an inbound request | \`--message-id\`, \`--content\` |

### Workflow lifecycle (\`kxm workflow <verb> --json\`)

| Command | Purpose | Key options |
|---|---|---|
| \`kxm workflow checkpoint [runId] [stageId] [status] [summary]\` | Record stage result with verified evidence | \`--run-id\`, \`--stage-id\`, \`--status <passed\\|warning\\|failed>\`, \`--summary\`, \`--evidence <json>\`, \`--evidence-refs <json>\` |
| \`kxm workflow record [runId] [category] [area] [summary]\` | Record plans, decisions, contradictions, errors, lessons | \`--run-id\`, \`--category <plan\\|decision\\|contradiction\\|error\\|lesson>\`, \`--area\`, \`--severity <info\\|warning\\|error>\`, \`--details\`, \`--evidence <items...>\` |
| \`kxm workflow wait [runId] [stageId] [signalKey] [summary]\` | Pause stage until an external signed signal arrives | \`--run-id\`, \`--stage-id\`, \`--signal-key\`, \`--summary\`, \`--evidence <json>\`, \`--evidence-refs <json>\`, \`--timeout-ms\` |
| \`kxm workflow signal <runId> <signalKey> <status> <summary>\` | Resume or unblock a waiting stage or KXM run | \`[evidence...]\`, \`--delivery-id\` |
| \`kxm workflow list\` | List local workflow runs | \`--json\` |
| \`kxm workflow get <runId>\` | Get stages and journal for a run | \`--json\` |

### Context operating system (\`kxm context <verb> --json\`)

| Command | Purpose | Key options |
|---|---|---|
| \`kxm context get <project>\` | Assemble role-aware context packet | \`--role\`, \`--task\`, \`--run\`, \`--stage\`, \`--budget\` |
| \`kxm context recall <project>\` | Search durable context metadata | \`--query\`, \`--kinds\`, \`--limit\` |
| \`kxm context state <project> <key>\` | Query authoritative temporal state | \`--as-of <timestamp>\` |
| \`kxm context episode <project>\` | Query workflow learning episodes | \`--run\` |
| \`kxm context promote <project> <proposalId>\` | Promote an approved state proposal (control plane) | required \`--evidence <refs>\` |
${MARKER_END}`;

function refuse(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function posixContained(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    refuse(`${label} must be a contained relative path`);
  }
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    refuse(`${label} must be a contained relative path`);
  }
  return value;
}

function containedRoot(root) {
  return existsSync(root) ? realpathSync(root) : resolve(root);
}

function assertPathStaysInRoot(resolvedRoot, current, relativePath) {
  const real = realpathSync(current);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (real !== resolvedRoot && !real.startsWith(prefix)) {
    refuse(`path escapes repository: ${relativePath}`);
  }
  return real;
}

function assertExistingAncestorsAreRegularContained(root, relativePath, { required = false } = {}) {
  const resolvedRoot = containedRoot(root);
  const parts = posixContained(relativePath, "path").split("/");
  let current = resolvedRoot;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const rel = parts.slice(0, i + 1).join("/");
    let info;
    try {
      info = lstatSync(current);
    } catch {
      if (required) refuse(`path is missing: ${rel}`);
      return;
    }
    if (info.isSymbolicLink()) refuse(`symlinks are not allowed: ${rel}`);
    if (!info.isDirectory()) {
      refuse(`path must be a regular contained directory: ${rel}`);
    }
    assertPathStaysInRoot(resolvedRoot, current, rel);
  }
}

function assertRegularContainedPath(root, relativePath, { directory = false } = {}) {
  const resolvedRoot = containedRoot(root);
  const parts = posixContained(relativePath, "path").split("/");
  let current = resolvedRoot;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      refuse(`path is missing: ${relativePath}`);
    }
    if (info.isSymbolicLink()) refuse(`symlinks are not allowed: ${relativePath}`);
    const last = i === parts.length - 1;
    if (last ? (directory ? !info.isDirectory() : !info.isFile()) : !info.isDirectory()) {
      refuse(`path must be a regular contained ${directory ? "directory" : "file"}: ${relativePath}`);
    }
  }
  assertPathStaysInRoot(resolvedRoot, current, relativePath);
  return current;
}

function validateSkillSuiteManifest(manifest) {
  if (!isPlainObject(manifest)) refuse("skill suite manifest must be an object");
  for (const key of ["id", "version", "name", "description"]) {
    if (typeof manifest[key] !== "string" || !manifest[key].trim()) {
      refuse(`skill suite manifest missing ${key}`);
    }
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    refuse("skill suite manifest skills must be a nonempty array");
  }
  const names = new Set();
  const commands = new Set();
  for (const skill of manifest.skills) {
    if (!isPlainObject(skill)) refuse("skill suite entry must be an object");
    const extra = Object.keys(skill).filter((key) => !["name", "path", "ownedCommands", "intent"].includes(key));
    if (extra.length > 0) refuse(`skill suite entry has unknown field(s): ${extra.join(", ")}`);
    if (typeof skill.name !== "string" || !SKILL_NAME.test(skill.name)) {
      refuse(`invalid skill name: ${skill.name ?? ""}`);
    }
    if (names.has(skill.name)) refuse(`duplicate skill name: ${skill.name}`);
    names.add(skill.name);
    posixContained(skill.path, `skill path for ${skill.name}`);
    if (!skill.path.startsWith("./skills/") || skill.path !== `./skills/${skill.name}`) {
      refuse(`skill path must be ./skills/${skill.name}`);
    }
    if (typeof skill.intent !== "string" || skill.intent.length < 10 || skill.intent.length > 200) {
      refuse(`skill ${skill.name} intent must be 10-200 characters`);
    }
    if (!Array.isArray(skill.ownedCommands) || skill.ownedCommands.some((cmd) => typeof cmd !== "string" || !COMMAND_NAME.test(cmd))) {
      refuse(`skill ${skill.name} ownedCommands must be command tokens`);
    }
    for (const command of skill.ownedCommands) {
      if (commands.has(command)) refuse(`command ${command} is owned by multiple skills`);
      commands.add(command);
    }
  }
  return manifest;
}

/**
 * Read and validate the committed skill-suite manifest. Missing, symlink,
 * malformed, or shape-invalid manifests fail closed.
 *
 * @param {string} repoRoot
 * @returns {{ id: string, version: string, name: string, description: string, skills: Array<{ name: string, path: string, ownedCommands: string[], intent: string }> }}
 */
export function loadSkillSuiteManifest(repoRoot) {
  const root = resolve(repoRoot);
  const fullPath = assertRegularContainedPath(root, MANIFEST_REL);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch {
    refuse("skill suite manifest is malformed");
  }
  return validateSkillSuiteManifest(parsed);
}

function listFilesRecursive(dir, relativeBase = "") {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink() || lstatSync(full).isSymbolicLink()) {
      refuse(`symlinks are not allowed: ${rel}`);
    }
    if (entry.isDirectory()) results.push(...listFilesRecursive(full, rel));
    else if (entry.isFile()) results.push(rel);
    else refuse(`unsupported skill artifact: ${rel}`);
  }
  return results.sort();
}

function ownedSkillDir(root, skillName) {
  return assertRegularContainedPath(root, `plugins/kxm/skills/${skillName}`, { directory: true });
}

/**
 * Return generated skill-mirror artifact paths relative to the repo root.
 *
 * @param {string} [repoRoot]
 * @returns {string[]}
 */
export function listSkillMirrorArtifacts(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const suiteManifest = loadSkillSuiteManifest(root);
  const artifacts = [];
  for (const skill of suiteManifest.skills) {
    const srcSkillDir = ownedSkillDir(root, skill.name);
    const files = listFilesRecursive(srcSkillDir);
    if (!files.includes("SKILL.md")) refuse(`SKILL.md missing for ${skill.name}`);
    for (const rel of files) artifacts.push(`.agents/skills/${skill.name}/${rel}`);
  }
  return artifacts;
}

/**
 * Emit the portable .agents/skills mirror from the authored plugin skills tree
 * and update the AGENTS.md command block. Owned skills are replaced; unrelated
 * skills are preserved. Missing or invalid manifests fail closed.
 *
 * @param {string} [repoRoot]
 */
export function emitCodexArtifacts(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const suiteManifest = loadSkillSuiteManifest(root);
  const destSkillsDir = join(root, ".agents", "skills");
  assertExistingAncestorsAreRegularContained(root, ".agents/skills");
  mkdirSync(destSkillsDir, { recursive: true });
  assertExistingAncestorsAreRegularContained(root, ".agents/skills", { required: true });
  const destRoot = realpathSync(destSkillsDir);
  const repoReal = containedRoot(root);
  const repoPrefix = repoReal.endsWith(sep) ? repoReal : `${repoReal}${sep}`;
  if (destRoot !== repoReal && !destRoot.startsWith(repoPrefix)) {
    refuse("path escapes repository: .agents/skills");
  }
  const ownedSkillNames = suiteManifest.skills.map((skill) => skill.name);
  const emittedSkillPaths = [];
  const preservedSkillNames = [];

  for (const skill of suiteManifest.skills) {
    const srcSkillDir = ownedSkillDir(root, skill.name);
    listFilesRecursive(srcSkillDir);
    const destSkillPath = join(destSkillsDir, skill.name);
    if (existsSync(destSkillPath)) {
      if (lstatSync(destSkillPath).isSymbolicLink()) {
        refuse(`symlinks are not allowed: .agents/skills/${skill.name}`);
      }
      rmSync(destSkillPath, { recursive: true, force: true });
    }
    cpSync(srcSkillDir, destSkillPath, {
      recursive: true,
      dereference: false,
    });
    if (lstatSync(destSkillPath).isSymbolicLink()) {
      rmSync(destSkillPath, { recursive: true, force: true });
      refuse(`symlinks are not allowed: .agents/skills/${skill.name}`);
    }
    const realDest = realpathSync(destSkillPath);
    const prefix = destRoot.endsWith(sep) ? destRoot : `${destRoot}${sep}`;
    if (realDest !== destRoot && !realDest.startsWith(prefix)) {
      rmSync(destSkillPath, { recursive: true, force: true });
      refuse(`path escapes repository: .agents/skills/${skill.name}`);
    }
    listFilesRecursive(destSkillPath);
    emittedSkillPaths.push(destSkillPath);
  }

  for (const entry of readdirSync(destSkillsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !ownedSkillNames.includes(entry.name)) {
      preservedSkillNames.push(entry.name);
    }
  }

  const agentsPath = join(root, "AGENTS.md");
  let agentsUpdated = false;
  if (existsSync(agentsPath)) {
    if (lstatSync(agentsPath).isSymbolicLink()) refuse("AGENTS.md must be a regular file");
    const original = readFileSync(agentsPath, "utf8");
    let updated;
    if (original.includes(MARKER_START) && original.includes(MARKER_END)) {
      const startIdx = original.indexOf(MARKER_START);
      const endIdx = original.indexOf(MARKER_END) + MARKER_END.length;
      updated = original.slice(0, startIdx) + CODEX_COMMANDS_BLOCK + original.slice(endIdx);
    } else {
      const doNotIdx = original.indexOf("## Do not");
      if (doNotIdx !== -1) {
        updated = `${original.slice(0, doNotIdx)}${CODEX_COMMANDS_BLOCK}\n\n${original.slice(doNotIdx)}`;
      } else {
        updated = `${original.trimEnd()}\n\n${CODEX_COMMANDS_BLOCK}\n`;
      }
    }
    if (updated !== original) {
      writeFileSync(agentsPath, updated);
      agentsUpdated = true;
    }
  }

  return {
    destSkillsDir,
    agentsPath,
    agentsUpdated,
    ownedSkills: ownedSkillNames,
    preservedSkills: preservedSkillNames,
    emittedSkillPaths,
    artifacts: listSkillMirrorArtifacts(root),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = emitCodexArtifacts();
  process.stdout.write(
    `Codex artifacts emitted: skills -> ${result.destSkillsDir}, ` +
    `owned=${result.ownedSkills.length}, preserved=${result.preservedSkills.length}, ` +
    `AGENTS.md updated -> ${result.agentsUpdated}\n`,
  );
}
