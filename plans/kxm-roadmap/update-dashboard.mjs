#!/usr/bin/env node
/**
 * Render roadmap markdown from plans/kxm-roadmap/state.json and build the site.
 * Does not edit state.json. Same state, byte-identical markdown.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const statePath = join(here, "state.json");
const docsRoadmap = join(repoRoot, "docs", "roadmap");

function phaseStatus(phase) {
  if (phase.priority === "later") return "later";
  const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
  if (tasks.length > 0 && tasks.every((task) => task.status === "done")) return "done";
  return "open";
}

function pad(index) {
  return String(index + 1).padStart(2, "0");
}

function phaseFile(phase, index) {
  return `phases/${pad(index)}-${phase.slug}.md`;
}

function lines(items, empty) {
  if (!items || items.length === 0) return `${empty}\n`;
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

function taskLines(tasks, onlyOpen) {
  const chosen = (tasks || []).filter((task) => !onlyOpen || task.status === "open");
  if (chosen.length === 0) return "None.\n";
  return chosen.map((task) => {
    const evidence = task.evidence ? ` Evidence: \`${task.evidence}\`.` : "";
    return `- \`${task.id}\` ${task.title}.${evidence}`;
  }).join("\n") + "\n";
}

function section(phase, index, onlyOpenTasks) {
  const status = phaseStatus(phase);
  const page = phaseFile(phase, index);
  const parts = [
    `### ${phase.title}`,
    "",
    `Status: ${status}.`,
    "",
    `Source: \`${phase.source}\`.`,
    "",
    `Goal: ${phase.goal}`,
    "",
    "#### Open tasks",
    "",
    taskLines(phase.tasks, onlyOpenTasks),
    "#### Blockers",
    "",
    lines(phase.blockers, "None."),
    "#### Questions",
    "",
    lines(phase.questions, "None."),
    "",
    `[Phase page](${page})`,
    "",
  ];
  return parts.join("\n");
}

function renderDashboard(state, annotated) {
  const next = annotated.find((item) => item.status !== "later" && item.status !== "done");
  const active = annotated.filter((item) => item !== next && item.status !== "later" && item.status !== "done");
  const later = annotated.filter((item) => item.status === "later");
  const activeBlockers = annotated
    .filter((item) => item.status !== "later")
    .reduce((sum, item) => sum + (item.phase.blockers || []).length, 0);
  const activeQuestions = annotated
    .filter((item) => item.status !== "later")
    .reduce((sum, item) => sum + (item.phase.questions || []).length, 0);

  const indexRows = [
    "| Phase | Status | Page |",
    "| --- | --- | --- |",
    ...annotated.map((item) => `| ${item.phase.title} | ${item.status} | [page](${item.file}) |`),
  ];

  const drift = state.architecture?.drift || [];
  const driftRows = drift.length === 0
    ? ["None.", ""]
    : [
      "| Claim | Page | Status |",
      "| --- | --- | --- |",
      ...drift.map((item) => `| ${item.claim} | \`${item.page}\` | ${item.status} |`),
      "",
    ];

  const improvements = state.improvements || [];
  const contacts = state.contacts || [];
  const verified = state.architecture?.verified ?? null;

  const chunks = [
    "# Roadmap",
    "",
    `Updated: ${state.updated}.`,
    "",
    `Active blockers: ${activeBlockers}. Active questions: ${activeQuestions}. Later phases are excluded from both counts.`,
    "",
    "## Next",
    "",
  ];
  if (!next) {
    chunks.push("No open phase.", "");
  } else {
    chunks.push(section(next.phase, next.index, true));
  }
  chunks.push("## Active phases", "");
  if (active.length === 0) chunks.push("None.", "");
  else for (const item of active) chunks.push(section(item.phase, item.index, true));
  chunks.push("## Later", "");
  if (later.length === 0) chunks.push("None.", "");
  else for (const item of later) chunks.push(section(item.phase, item.index, true));
  chunks.push(
    "## Phase index",
    "",
    indexRows.join("\n"),
    "",
    "## Goal",
    "",
    state.goal,
    "",
    "## Improvements",
    "",
    lines(improvements, "None recorded."),
    "## Architecture drift",
    "",
    `Verified: ${verified === null || verified === undefined ? "null" : String(verified)}.`,
    "",
    driftRows.join("\n"),
    "## Constraints",
    "",
    lines(state.constraints, "None."),
    "## Contacts",
    "",
  );
  if (contacts.length === 0) {
    chunks.push(state.contacts_comment || "None recorded.", "");
  } else {
    chunks.push(lines(contacts.map((item) => String(item)), "None."), "");
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function renderMaster(state, annotated) {
  const chunks = [
    "# Master plan",
    "",
    `Updated: ${state.updated}.`,
    "",
    state.goal,
    "",
  ];
  for (const item of annotated) {
    chunks.push(
      `## ${item.phase.title}`,
      "",
      `Status: ${item.status}.`,
      "",
      `Source: \`${item.phase.source}\`.`,
      "",
      item.phase.goal,
      "",
      "### Tasks",
      "",
      taskLines(item.phase.tasks, false),
      "### Blockers",
      "",
      lines(item.phase.blockers, "None."),
      "### Questions",
      "",
      lines(item.phase.questions, "None."),
      "",
    );
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function renderPhase(state, item) {
  const phase = item.phase;
  const chunks = [
    `# ${phase.title}`,
    "",
    `Status: ${item.status}.`,
    "",
    `Source: \`${phase.source}\`.`,
    "",
    `Updated: ${state.updated}.`,
    "",
    phase.goal,
    "",
    "## Tasks",
    "",
    taskLines(phase.tasks, false),
    "## Blockers",
    "",
    lines(phase.blockers, "None."),
    "## Questions",
    "",
    lines(phase.questions, "None."),
    "",
    "[Dashboard](../dashboard.md)",
    "",
  ];
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current !== text) writeFileSync(path, text);
}

function ensureSymlink(linkPath, target) {
  const rel = relative(dirname(linkPath), target);
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() && readlinkSync(linkPath) === rel) return;
    unlinkSync(linkPath);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  symlinkSync(rel, linkPath);
}

function runMkdocs() {
  const attempts = [];
  const onPath = spawnSync("mkdocs", ["build"], { cwd: repoRoot, stdio: "inherit" });
  if (!onPath.error) {
    if (onPath.status !== 0) process.exit(onPath.status ?? 1);
    return;
  }
  attempts.push(onPath.error.code || "mkdocs missing");
  const uvBin = existsSync(join(process.env.HOME || "", ".local", "bin", "uv"))
    ? join(process.env.HOME, ".local", "bin", "uv")
    : "uv";
  const viaUv = spawnSync(uvBin, ["tool", "run", "--from", "mkdocs-material", "mkdocs", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (viaUv.error || viaUv.status !== 0) {
    console.error(`mkdocs build failed (${attempts.join(", ")})`);
    process.exit(viaUv.status || 1);
  }
}

function main() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.schema !== "kxm.roadmap.v1") {
    console.error(`unexpected schema ${state.schema}`);
    process.exit(1);
  }
  const phases = state.phases || [];
  const annotated = phases.map((phase, index) => ({
    phase,
    index,
    status: phaseStatus(phase),
    file: phaseFile(phase, index),
  }));

  const dashboard = renderDashboard(state, annotated);
  const master = renderMaster(state, annotated);
  writeFile(join(here, "dashboard.md"), dashboard);
  writeFile(join(here, "MASTER.md"), master);
  for (const item of annotated) {
    writeFile(join(here, item.file), renderPhase(state, item));
  }

  mkdirSync(join(docsRoadmap, "phases"), { recursive: true });
  ensureSymlink(join(docsRoadmap, "dashboard.md"), join(here, "dashboard.md"));
  ensureSymlink(join(docsRoadmap, "MASTER.md"), join(here, "MASTER.md"));
  for (const item of annotated) {
    ensureSymlink(join(docsRoadmap, item.file), join(here, item.file));
  }

  const next = annotated.find((item) => item.status !== "later" && item.status !== "done");
  if (next) {
    const open = (next.phase.tasks || []).filter((task) => task.status === "open");
    console.log(`Next: ${next.phase.title}`);
    for (const task of open) console.log(`- ${task.id} ${task.title}`);
  } else {
    console.log("Next: none");
  }

  runMkdocs();
}

main();
