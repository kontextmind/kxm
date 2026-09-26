#!/usr/bin/env node
/**
 * Render roadmap markdown from plans/kxm-roadmap/state.json and build the site.
 * Does not edit state.json. Same state, byte-identical markdown.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const statePath = join(here, "state.json");
const schemaPath = join(repoRoot, "schemas", "roadmap-state.schema.json");
const docsRoadmap = join(repoRoot, "docs", "roadmap");
const HISTORY_CAP = 12;
const CONTACT_WINDOW_DAYS = 90;
const TEMPLATES = new Set([
  "feature",
  "research",
  "bug-fix",
  "architecture",
  "adr",
  "test-plan",
  "test-report",
  "review",
  "handoff",
  "runbook",
  "postmortem",
]);

let validator;

function schemaValidator() {
  if (validator) return validator;
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  validator = ajv.compile(schema);
  return validator;
}

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

function utcDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!match) return null;
  const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day) ? null : day;
}

function ageDays(confirmed, updated) {
  const left = utcDay(confirmed);
  const right = utcDay(updated);
  if (left === null || right === null) return null;
  return (right - left) / 86400000;
}

function taskHasSource(task) {
  const section = typeof task.planSection === "string" && task.planSection.trim().length > 0;
  const evidence = typeof task.evidence === "string" && task.evidence.trim().length > 0;
  return section || evidence;
}

function semanticErrors(state) {
  const errors = [];
  for (const phase of state.phases || []) {
    for (const task of phase.tasks || []) {
      if (task.detail !== "ready") continue;
      if (!TEMPLATES.has(task.template)) {
        errors.push(`task_ready_without_template: ${task.id} has detail ready and template ${task.template ?? "none"}`);
      }
      if (!taskHasSource(task)) {
        errors.push(`task_ready_without_source: ${task.id} has detail ready and no plan section or evidence`);
      }
    }
  }
  return errors;
}

function pruneHistory(history) {
  const entries = (Array.isArray(history) ? history : []).map((entry, index) => ({ entry, index }));
  entries.sort((left, right) => {
    if (left.entry.date < right.entry.date) return -1;
    if (left.entry.date > right.entry.date) return 1;
    return left.index - right.index;
  });
  const ordered = entries.map((item) => item.entry);
  if (ordered.length <= HISTORY_CAP) return ordered;
  const dropped = ordered.length - HISTORY_CAP;
  console.error(`history_over_cap: dropped ${dropped} oldest`);
  return ordered.slice(dropped);
}

function freshContacts(state) {
  return (state.contacts || []).filter((contact) => {
    const age = ageDays(contact.confirmed, state.updated);
    return age !== null && age <= CONTACT_WINDOW_DAYS;
  });
}

function annotate(phases) {
  const items = (phases || []).map((phase, index) => ({
    phase,
    index,
    status: phaseStatus(phase),
    file: phaseFile(phase, index),
    horizon: "soon",
  }));
  const next = items.find((item) => item.status !== "later" && item.status !== "done");
  for (const item of items) {
    if (item.status === "later") item.horizon = "later";
    else if (next && item === next) item.horizon = "next";
    else item.horizon = "soon";
  }
  return items;
}

function taskLines(tasks, onlyOpen) {
  const chosen = (tasks || []).filter((task) => !onlyOpen || task.status === "open");
  if (chosen.length === 0) return "None.\n";
  return chosen.map((task) => {
    const evidence = task.evidence ? ` Evidence: \`${task.evidence}\`.` : "";
    return `- \`${task.id}\` ${task.title}.${evidence}`;
  }).join("\n") + "\n";
}

function recorded(task, key) {
  const value = typeof task[key] === "string" ? task[key].trim() : "";
  return value || "None.";
}

function renderTask(task) {
  const detail = task.detail || "brief";
  if (detail === "brief") {
    return [
      `### ${task.title}`,
      "",
      `Done criterion: ${recorded(task, "doneCriterion")}`,
      "",
      `Evidence needed: ${recorded(task, "evidenceNeeded")}`,
    ].join("\n");
  }
  const template = task.template || "none";
  const templateText = detail === "ready" && TEMPLATES.has(template)
    ? `[${template}](../../templates/${template}.md)`
    : `\`${template}\``;
  const parts = [
    `### ${task.title}`,
    "",
    `\`${task.id}\`. Status: ${task.status}. Detail: ${detail}.`,
    "",
    `Template: ${templateText}.`,
    "",
    `Done criterion: ${recorded(task, "doneCriterion")}`,
    "",
    `Evidence needed: ${recorded(task, "evidenceNeeded")}`,
  ];
  if (typeof task.planSection === "string" && task.planSection.trim()) {
    parts.push("", `Plan section: ${task.planSection}.`);
  }
  if (typeof task.evidence === "string" && task.evidence.trim()) {
    parts.push("", `Evidence: \`${task.evidence}\`.`);
  }
  return parts.join("\n");
}

function renderTasks(tasks) {
  if (!tasks || tasks.length === 0) return "None.\n";
  return `${tasks.map((task) => renderTask(task)).join("\n\n")}\n`;
}

function renderHistory(entries) {
  if (!entries || entries.length === 0) return "None.\n";
  return `${entries.map((entry) => `- ${entry.date}: ${entry.line}`).join("\n")}\n`;
}

function renderContacts(state) {
  const contacts = freshContacts(state);
  if (contacts.length === 0) return "No confirmed contacts.\n";
  return `${contacts.map((contact) => {
    const name = contact.name ? `, ${contact.name}` : "";
    return `- ${contact.role}${name} (confirmed ${contact.confirmed})`;
  }).join("\n")}\n`;
}

function section(item, onlyOpenTasks) {
  const phase = item.phase;
  const parts = [
    `### ${phase.title}`,
    "",
    `Status: ${item.status}. Horizon: ${item.horizon}.`,
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
    `[Phase page](${item.file})`,
    "",
  ];
  return parts.join("\n");
}

function renderDashboard(state, annotated, history) {
  const next = annotated.find((item) => item.horizon === "next");
  const active = annotated.filter((item) => item !== next && item.status !== "later" && item.status !== "done");
  const later = annotated.filter((item) => item.status === "later");
  const activeBlockers = annotated
    .filter((item) => item.status !== "later")
    .reduce((sum, item) => sum + (item.phase.blockers || []).length, 0);
  const activeQuestions = annotated
    .filter((item) => item.status !== "later")
    .reduce((sum, item) => sum + (item.phase.questions || []).length, 0);

  const indexRows = [
    "| Phase | Status | Horizon | Page |",
    "| --- | --- | --- | --- |",
    ...annotated.map((item) => `| ${item.phase.title} | ${item.status} | ${item.horizon} | [page](${item.file}) |`),
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
    chunks.push(section(next, true));
  }
  chunks.push("## Active phases", "");
  if (active.length === 0) chunks.push("None.", "");
  else for (const item of active) chunks.push(section(item, true));
  chunks.push("## Later", "");
  if (later.length === 0) chunks.push("None.", "");
  else for (const item of later) chunks.push(section(item, true));
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
    renderContacts(state),
    "## History",
    "",
    renderHistory(history),
  );
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function renderMaster(state, annotated, history) {
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
      `Status: ${item.status}. Horizon: ${item.horizon}.`,
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
  chunks.push(
    "## History",
    "",
    renderHistory(history),
  );
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function renderPhase(state, item) {
  const phase = item.phase;
  const chunks = [
    `# ${phase.title}`,
    "",
    `Status: ${item.status}. Horizon: ${item.horizon}.`,
    "",
    `Source: \`${phase.source}\`.`,
    "",
    `Updated: ${state.updated}.`,
    "",
    phase.goal,
    "",
    "## Tasks",
    "",
    renderTasks(phase.tasks),
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

export function prepareRoadmap(state) {
  const validate = schemaValidator();
  if (!validate(state)) {
    const detail = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    return {
      ok: false,
      message: `roadmap state failed schema validation: ${detail}`,
    };
  }
  const errors = semanticErrors(state);
  if (errors.length > 0) {
    return { ok: false, message: errors.join("\n") };
  }
  const history = pruneHistory(state.history);
  const annotated = annotate(state.phases);
  return {
    ok: true,
    history,
    annotated,
    dashboard: renderDashboard(state, annotated, history),
    master: renderMaster(state, annotated, history),
    phases: annotated.map((item) => ({ file: item.file, text: renderPhase(state, item) })),
  };
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
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    console.error(`roadmap state failed to parse: ${error.message}`);
    process.exit(1);
  }
  const prepared = prepareRoadmap(state);
  if (!prepared.ok) {
    console.error(prepared.message);
    process.exit(1);
  }

  writeFile(join(here, "dashboard.md"), prepared.dashboard);
  writeFile(join(here, "MASTER.md"), prepared.master);
  for (const phase of prepared.phases) {
    writeFile(join(here, phase.file), phase.text);
  }

  mkdirSync(join(docsRoadmap, "phases"), { recursive: true });
  ensureSymlink(join(docsRoadmap, "dashboard.md"), join(here, "dashboard.md"));
  ensureSymlink(join(docsRoadmap, "MASTER.md"), join(here, "MASTER.md"));
  for (const phase of prepared.phases) {
    ensureSymlink(join(docsRoadmap, phase.file), join(here, phase.file));
  }

  const next = prepared.annotated.find((item) => item.horizon === "next");
  if (next) {
    const open = (next.phase.tasks || []).filter((task) => task.status === "open");
    console.log(`Next: ${next.phase.title}`);
    for (const task of open) console.log(`- ${task.id} ${task.title}`);
  } else {
    console.log("Next: none");
  }

  runMkdocs();
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
