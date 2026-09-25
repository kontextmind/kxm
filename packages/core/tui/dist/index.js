// packages/core/tui/src/types/surface.ts
var KXM_TUI_CONTRACT_SCHEMA = "kxm.tui-contract.v1";
var KXM_TUI_FIELD_KINDS = ["text", "enum", "choice", "info"];
var KXM_TUI_STATUSES = ["ready", "available", "blocked"];
var KXM_TUI_STEP_STATES = ["pending", "satisfied", "running", "done", "failed"];
var KXM_TUI_NOTICE_LEVELS = ["info", "error"];
var KXM_TUI_SET_ACTION = "set";
var KXM_TUI_CLEAR_ACTION = "clear";
var KXM_TUI_ABORT_ACTION = "abort";
var KXM_TUI_LIMITS = Object.freeze({
  sourceMax: 128,
  idMax: 128,
  choiceIdMax: 256,
  labelMax: 48,
  choiceLabelMax: 96,
  detailMax: 240,
  shortDetailMax: 96,
  stepDetailMax: 160,
  statusTextMax: 240,
  valueMax: 4096,
  keyPathMax: 128,
  outputLineMax: 512,
  outputMaxLines: 64,
  choicesMax: 128,
  actionsMax: 4,
  stepsMax: 24,
  fieldsMax: 64,
  sectionsMax: 32,
  orderMax: 1e3
});
var ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
var SOURCE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;
var KEY_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.[\]-]*$/;
var ACTION_KEY_PATTERN = /^[A-Za-z0-9]$/;
function issue(path, code, message) {
  return { path, code, message };
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedText(issues, path, value, max, required) {
  if (value === void 0) {
    if (required) issues.push(issue(path, "required", `${path} is required`));
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue(path, "invalid_string", `${path} must be a non-empty string`));
    return;
  }
  if (value.length > max) {
    issues.push(issue(path, "too_long", `${path} exceeds ${max} characters`));
    return;
  }
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) {
    issues.push(issue(path, "control_character", `${path} must not contain control characters`));
  }
}
function optionalEnum(issues, path, value, allowed) {
  if (value === void 0) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push(issue(path, "invalid_choice", `${path} must be one of ${allowed.join(", ")}`));
  }
}
function ratioField(issues, path, value) {
  if (value === void 0) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(issue(path, "invalid_ratio", `${path} must be a finite number between 0 and 1`));
  }
}
function validateChoice(issues, path, raw) {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  boundedText(issues, `${path}.id`, raw.id, KXM_TUI_LIMITS.choiceIdMax, true);
  if (typeof raw.id === "string" && /[\s]/u.test(raw.id)) {
    issues.push(issue(`${path}.id`, "invalid_choice_id", `${path}.id must not contain whitespace`));
  }
  boundedText(issues, `${path}.label`, raw.label, KXM_TUI_LIMITS.choiceLabelMax, true);
  boundedText(issues, `${path}.detail`, raw.detail, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.group`, raw.group, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.statusText`, raw.statusText, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.action`, raw.action, KXM_TUI_LIMITS.idMax, false);
  optionalEnum(issues, `${path}.status`, raw.status, KXM_TUI_STATUSES);
}
function validateAction(issues, path, raw) {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  if (typeof raw.key !== "string" || !ACTION_KEY_PATTERN.test(raw.key)) {
    issues.push(issue(`${path}.key`, "invalid_action_key", `${path}.key must be a single alphanumeric key`));
  }
  boundedText(issues, `${path}.label`, raw.label, KXM_TUI_LIMITS.shortDetailMax, true);
  boundedText(issues, `${path}.action`, raw.action, KXM_TUI_LIMITS.idMax, true);
}
function validateStep(issues, path, raw) {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  boundedText(issues, `${path}.label`, raw.label, KXM_TUI_LIMITS.shortDetailMax, true);
  boundedText(issues, `${path}.detail`, raw.detail, KXM_TUI_LIMITS.stepDetailMax, false);
  optionalEnum(issues, `${path}.state`, raw.state, KXM_TUI_STEP_STATES);
  if (raw.state === void 0) issues.push(issue(`${path}.state`, "required", `${path}.state is required`));
}
function validateField(issues, path, raw) {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  boundedText(issues, `${path}.id`, raw.id, KXM_TUI_LIMITS.idMax, true);
  if (typeof raw.id === "string" && !ID_PATTERN.test(raw.id)) {
    issues.push(issue(`${path}.id`, "invalid_id", `${path}.id must match ${ID_PATTERN}`));
  }
  boundedText(issues, `${path}.label`, raw.label, KXM_TUI_LIMITS.labelMax, true);
  if (raw.kind === void 0) {
    issues.push(issue(`${path}.kind`, "required", `${path}.kind is required`));
  } else {
    optionalEnum(issues, `${path}.kind`, raw.kind, KXM_TUI_FIELD_KINDS);
  }
  boundedText(issues, `${path}.value`, raw.value, KXM_TUI_LIMITS.valueMax, false);
  boundedText(issues, `${path}.placeholder`, raw.placeholder, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.detail`, raw.detail, KXM_TUI_LIMITS.detailMax, false);
  boundedText(issues, `${path}.statusText`, raw.statusText, KXM_TUI_LIMITS.statusTextMax, false);
  if (raw.updatedAt !== void 0) {
    boundedText(issues, `${path}.updatedAt`, raw.updatedAt, 64, false);
    if (typeof raw.updatedAt === "string" && !Number.isFinite(Date.parse(raw.updatedAt))) {
      issues.push(issue(`${path}.updatedAt`, "invalid_timestamp", `${path}.updatedAt must be an ISO timestamp`));
    }
  }
  optionalEnum(issues, `${path}.status`, raw.status, KXM_TUI_STATUSES);
  if (raw.keyPath !== void 0) {
    boundedText(issues, `${path}.keyPath`, raw.keyPath, KXM_TUI_LIMITS.keyPathMax, false);
    if (typeof raw.keyPath === "string" && !KEY_PATH_PATTERN.test(raw.keyPath)) {
      issues.push(issue(`${path}.keyPath`, "invalid_key_path", `${path}.keyPath must be a dotted config key`));
    }
  }
  for (const listKey of ["busy", "awaitingInput"]) {
    if (raw[listKey] !== void 0 && typeof raw[listKey] !== "boolean") {
      issues.push(issue(`${path}.${listKey}`, "invalid_boolean", `${path}.${listKey} must be a boolean`));
    }
  }
  if (raw.progress !== void 0) {
    if (!isPlainObject(raw.progress)) {
      issues.push(issue(`${path}.progress`, "invalid_object", `${path}.progress must be an object`));
    } else {
      boundedText(issues, `${path}.progress.label`, raw.progress.label, KXM_TUI_LIMITS.shortDetailMax, true);
      ratioField(issues, `${path}.progress.ratio`, raw.progress.ratio);
    }
  }
  for (const [listKey, max, check] of [
    ["choices", KXM_TUI_LIMITS.choicesMax, validateChoice],
    ["actions", KXM_TUI_LIMITS.actionsMax, validateAction],
    ["steps", KXM_TUI_LIMITS.stepsMax, validateStep]
  ]) {
    const list = raw[listKey];
    if (list === void 0) continue;
    if (!Array.isArray(list) || list.length > max) {
      issues.push(issue(`${path}.${listKey}`, "invalid_list", `${path}.${listKey} must be an array of at most ${max}`));
      continue;
    }
    list.forEach((entry, index) => check(issues, `${path}.${listKey}[${index}]`, entry));
  }
  const output = raw.output;
  if (output !== void 0) {
    if (!Array.isArray(output) || output.length > KXM_TUI_LIMITS.outputMaxLines) {
      issues.push(issue(`${path}.output`, "invalid_list", `${path}.output must be an array of at most ${KXM_TUI_LIMITS.outputMaxLines} lines`));
    } else {
      output.forEach((line, index) => {
        if (typeof line !== "string") issues.push(issue(`${path}.output[${index}]`, "invalid_string", "output lines must be strings"));
        else if (line.length > KXM_TUI_LIMITS.outputLineMax) issues.push(issue(`${path}.output[${index}]`, "too_long", "output line is too long"));
      });
    }
  }
}
function validateSection(issues, path, raw) {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  boundedText(issues, `${path}.id`, raw.id, KXM_TUI_LIMITS.idMax, true);
  if (typeof raw.id === "string" && !ID_PATTERN.test(raw.id)) {
    issues.push(issue(`${path}.id`, "invalid_id", `${path}.id must match ${ID_PATTERN}`));
  }
  boundedText(issues, `${path}.title`, raw.title, KXM_TUI_LIMITS.labelMax, true);
  boundedText(issues, `${path}.detail`, raw.detail, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.notice`, raw.notice, KXM_TUI_LIMITS.detailMax, false);
  optionalEnum(issues, `${path}.noticeLevel`, raw.noticeLevel, KXM_TUI_NOTICE_LEVELS);
  if (typeof raw.order !== "number" || !Number.isInteger(raw.order) || raw.order < 0 || raw.order > KXM_TUI_LIMITS.orderMax) {
    issues.push(issue(`${path}.order`, "invalid_order", `${path}.order must be an integer between 0 and ${KXM_TUI_LIMITS.orderMax}`));
  }
  if (!Array.isArray(raw.fields) || raw.fields.length > KXM_TUI_LIMITS.fieldsMax) {
    issues.push(issue(`${path}.fields`, "invalid_list", `${path}.fields must be an array of at most ${KXM_TUI_LIMITS.fieldsMax}`));
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  raw.fields.forEach((field, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    validateField(issues, fieldPath, field);
    if (isPlainObject(field) && typeof field.id === "string") {
      if (seen.has(field.id)) issues.push(issue(`${fieldPath}.id`, "duplicate_id", `${field.id} is published twice in ${path}`));
      seen.add(field.id);
    }
  });
}
function validateKxmTuiSurface(sections) {
  if (!Array.isArray(sections)) return [issue("sections", "invalid_list", "sections must be an array")];
  if (sections.length > KXM_TUI_LIMITS.sectionsMax) {
    return [issue("sections", "too_many", `sections must number at most ${KXM_TUI_LIMITS.sectionsMax}`)];
  }
  const issues = [];
  const seenSources = /* @__PURE__ */ new Map();
  sections.forEach((section, index) => {
    const path = `sections[${index}]`;
    validateSection(issues, path, section);
    if (!isPlainObject(section)) return;
    boundedText(issues, `${path}.source`, section.source, KXM_TUI_LIMITS.sourceMax, true);
    if (typeof section.source === "string" && !SOURCE_PATTERN.test(section.source)) {
      issues.push(issue(`${path}.source`, "invalid_source", `${path}.source must be an addressable owner id`));
    }
    if (typeof section.source === "string" && typeof section.id === "string") {
      const ids = seenSources.get(section.source) ?? /* @__PURE__ */ new Set();
      seenSources.set(section.source, ids);
      if (ids.has(section.id)) issues.push(issue(`${path}.id`, "duplicate_section", `${section.source}/${section.id} is published twice`));
      ids.add(section.id);
    }
  });
  return issues;
}
function assertKxmTuiSurface(sections) {
  const issues = validateKxmTuiSurface(sections);
  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(`kxm tui surface refused (${issues.length} issue(s)): ${first.path} ${first.code}: ${first.message}`);
  }
  return sections.slice().sort((a, b) => sectionOrder(a) - sectionOrder(b));
}
function sectionOrder(value) {
  return isPlainObject(value) && typeof value.order === "number" ? value.order : Number.MAX_SAFE_INTEGER;
}
function isSelectableField(field) {
  return field !== void 0 && field.kind !== "info";
}
function fieldIsEditable(field) {
  if (!isSelectableField(field)) return false;
  const editable = field;
  return editable.kind === "text" || editable.kind === "enum" || editable.kind === "choice" && (editable.choices?.length ?? 0) > 0;
}
function groupedKxmTuiChoices(field) {
  const choices = field.choices ?? [];
  if (choices.length === 0) return [];
  if (choices.every((choice) => choice.group === void 0)) return [{ group: "", choices }];
  const groups = [];
  const index = /* @__PURE__ */ new Map();
  for (const choice of choices) {
    const group = choice.group ?? "";
    let bucket = index.get(group);
    if (!bucket) {
      bucket = [];
      index.set(group, bucket);
      groups.push({ group, choices: bucket });
    }
    bucket.push(choice);
  }
  return groups;
}

// packages/core/tui/src/tui/keys.ts
import { decodeKittyPrintable, parseKey } from "@earendil-works/pi-tui";
var KXM_TUI_INPUT_MAX_LENGTH = 4096;
var CONTROL_BYTES = /[\u0000-\u0008\u000a-\u001f\u007f\u0080-\u009f]/u;
var NAMED_KEYS = Object.freeze({
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "pageUp",
  pagedown: "pageDown",
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backspace: "backspace",
  delete: "delete"
});
var CONTROL_BYTES_GLOBAL = /[\u0000-\u0008\u000a-\u001f\u007f\u0080-\u009f]/gu;
function normalizeInputText(value) {
  return value.replace(CONTROL_BYTES_GLOBAL, " ").replace(/ {2,}/gu, " ").trim().slice(0, KXM_TUI_INPUT_MAX_LENGTH);
}
function isControlInput(data) {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function decodeKxmTuiInput(data) {
  if (typeof data !== "string" || data.length === 0) return { kind: "ignored" };
  const named = parseKey(data);
  if (named === "ctrl+c") return { kind: "ctrlC" };
  if (named) {
    const kind = NAMED_KEYS[named.toLowerCase()];
    if (kind) return { kind };
    if (named === "space") return { kind: "text", text: " " };
    if (Array.from(named).length === 1 && !CONTROL_BYTES.test(named)) {
      return { kind: "text", text: named };
    }
    return { kind: "ignored" };
  }
  const kitty = decodeKittyPrintable(data);
  if (kitty) {
    const text = normalizeInputText(kitty);
    return text ? { kind: "text", text } : { kind: "ignored" };
  }
  if (data.startsWith("\x1B")) return { kind: "ignored" };
  const pasted = normalizeInputText(data);
  return pasted ? { kind: "text", text: pasted } : { kind: "ignored" };
}
function deleteBackward(text) {
  const units = Array.from(text);
  units.pop();
  return units.join("");
}
function insertAt(text, caret, insert, maxLength = KXM_TUI_INPUT_MAX_LENGTH) {
  const units = Array.from(text);
  const at = Math.max(0, Math.min(caret, units.length));
  const added = Array.from(insert);
  const merged = [...units.slice(0, at), ...added, ...units.slice(at)].join("");
  const next = merged.length > maxLength ? merged.slice(0, maxLength) : merged;
  return { text: next, caret: Math.min(next.length, at + added.length) };
}

// packages/core/tui/src/tui/layout.ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
var KXM_TUI_ELLIPSIS = "\u2026";
function fitText(text, width) {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (!text.includes("\x1B")) {
    let out = "";
    for (const unit of Array.from(text)) {
      if (visibleWidth(out) + visibleWidth(unit) > width - KXM_TUI_ELLIPSIS.length) break;
      out += unit;
    }
    return out + KXM_TUI_ELLIPSIS;
  }
  return truncateToWidth(text, width, KXM_TUI_ELLIPSIS);
}
function alignRight(left, right, width) {
  if (width <= 0) return "";
  const detail = fitText(right, Math.max(0, width - 2));
  const detailWidth = visibleWidth(detail);
  const leftWidth = Math.max(1, width - detailWidth - 1);
  const fitted = fitText(left, leftWidth);
  const filler = Math.max(1, width - visibleWidth(fitted) - detailWidth);
  return `${fitted}${" ".repeat(filler)}${detail}`;
}
function padRight(text, width) {
  const missing = width - visibleWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}
function wrapPlain(text, width) {
  if (width <= 0) return [];
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (!current.length) current = word;
    else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length) lines.push(current);
  return lines.length ? lines : [];
}
function formatAge(iso, nowMs) {
  if (!iso) return "\u2014";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "\u2014";
  const seconds = Math.floor((nowMs - at) / 1e3);
  if (seconds < 0) return "\u2014";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${String(hours % 24).padStart(2, "0")}h`;
}
function progressBar(ratio, width = 10) {
  const cells = Math.max(1, width);
  if (ratio === void 0 || !Number.isFinite(ratio)) return "\u2591".repeat(cells);
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * cells);
  return "\u2588".repeat(filled) + "\u2591".repeat(Math.max(0, cells - filled));
}
var KXM_TUI_MARKS = Object.freeze({
  pending: "\u25CB",
  active: "\u25B6",
  waiting: "\u29D7",
  passed: "\u2714",
  failed: "\u2716",
  cancelled: "\u2298",
  blocked: "\u2717",
  ready: "\u25CF",
  available: "\u25D0",
  cursor: "\u25B8",
  blankCursor: " "
});

// packages/core/tui/src/tui/theme.ts
var SGR = Object.freeze({
  text: "37",
  accent: "1;36",
  muted: "2",
  dim: "2",
  success: "1;32",
  error: "1;31",
  warning: "1;33",
  border: "90"
});
function createPlainKxmTuiTheme() {
  const passthrough = (text) => text;
  return {
    colored: false,
    fg: (_token, text) => text,
    accent: passthrough,
    success: passthrough,
    error: passthrough,
    warning: passthrough,
    muted: passthrough,
    dim: passthrough,
    label: passthrough,
    value: passthrough,
    key: passthrough,
    cursor: passthrough,
    headerBg: passthrough,
    panelBg: passthrough
  };
}
function createKxmTuiAnsiTheme(color) {
  if (!color) return createPlainKxmTuiTheme();
  const fg = (token, text) => `\x1B[${SGR[token]}m${text}\x1B[0m`;
  return {
    colored: true,
    fg,
    accent: (text) => fg("accent", text),
    success: (text) => fg("success", text),
    error: (text) => fg("error", text),
    warning: (text) => fg("warning", text),
    muted: (text) => fg("muted", text),
    dim: (text) => fg("dim", text),
    label: (text) => fg("text", text),
    value: (text) => `\x1B[1m${text}\x1B[0m`,
    key: (text) => fg("muted", text),
    cursor: (text) => fg("accent", text),
    headerBg: (text) => `\x1B[1;97;44m${text}\x1B[0m`,
    panelBg: (text) => `\x1B[48;5;236m${text}\x1B[0m`
  };
}
function createDefaultKxmTuiTheme(env = process.env) {
  return createKxmTuiAnsiTheme(!(env.NO_COLOR || env.KXM_TUI_NO_COLOR));
}
function createKxmTuiThemeFromPi(theme, colored = true) {
  if (!colored) return createPlainKxmTuiTheme();
  const fg = (token, text) => theme.fg(token === "dim" ? "muted" : token, text);
  return {
    colored: true,
    fg,
    accent: (text) => fg("accent", text),
    success: (text) => fg("success", text),
    error: (text) => fg("error", text),
    warning: (text) => fg("warning", text),
    muted: (text) => fg("muted", text),
    dim: (text) => fg("dim", text),
    label: (text) => fg("text", text),
    value: (text) => fg("accent", text),
    key: (text) => fg("muted", text),
    cursor: (text) => fg("accent", text),
    headerBg: (text) => theme.bg("selectedBg", text),
    panelBg: (text) => theme.bg("selectedBg", text)
  };
}

// packages/core/tui/src/tui/panel.ts
var PANE_KEYS = /* @__PURE__ */ new Set(["j", "k", "h", "l"]);
function initialKxmTuiPanelState(sections) {
  return {
    pane: "sections",
    mode: "browse",
    sectionIndex: 0,
    fieldIndex: firstSelectableFieldIndex(sections[0]?.fields ?? []),
    choiceIndex: 0,
    draft: "",
    caret: 0,
    filter: "",
    filtering: false,
    help: false,
    pending: []
  };
}
function pendingKey(invocation) {
  return `${invocation.source}\0${invocation.sectionId}\0${invocation.fieldId}`;
}
function firstSelectableFieldIndex(fields) {
  const index = fields.findIndex(isSelectableField);
  return index < 0 ? 0 : index;
}
function visibleChoices(field, filter) {
  const choices = field?.choices ?? [];
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...choices];
  return choices.filter(
    (choice) => `${choice.group ?? ""} ${choice.label} ${choice.id} ${choice.detail ?? ""}`.toLowerCase().includes(needle)
  );
}
function currentSection(sections, state) {
  return sections[state.sectionIndex];
}
function currentField(sections, state) {
  return currentSection(sections, state)?.fields[state.fieldIndex];
}
function reconcileKxmTuiPanelState(state, sections) {
  const sectionIndex = Math.min(state.sectionIndex, Math.max(0, sections.length - 1));
  const fields = sections[sectionIndex]?.fields ?? [];
  let fieldIndex = Math.min(state.fieldIndex, Math.max(0, fields.length - 1));
  if (!isSelectableField(fields[fieldIndex])) fieldIndex = firstSelectableFieldIndex(fields);
  const field = fields[fieldIndex];
  const keepsEdit = state.mode === "edit" && (field?.statusText !== void 0 || field?.awaitingInput === true);
  return {
    ...state,
    sectionIndex,
    fieldIndex,
    mode: keepsEdit ? "edit" : "browse",
    choiceIndex: 0,
    pending: []
  };
}
function focusedFieldIsEditable(sections, state) {
  return fieldIsEditable(currentField(sections, state));
}
function reduceKxmTuiInput(state, sections, input) {
  return reduceDecoded(state, sections, decodeKxmTuiInput(input));
}
function invokeEffect(state, section, field, action, value) {
  const invocation = {
    source: section.source,
    sectionId: section.id,
    fieldId: field.id,
    action,
    ...value === void 0 ? {} : { value }
  };
  const key = pendingKey(invocation);
  return {
    state: { ...state, pending: state.pending.includes(key) ? state.pending : [...state.pending, key] },
    effects: [{ type: "invoke", invocation }]
  };
}
function moveSection(state, sections, delta) {
  if (sections.length === 0) return state;
  const next = Math.max(0, Math.min(state.sectionIndex + delta, sections.length - 1));
  if (next === state.sectionIndex) return state;
  return {
    ...state,
    sectionIndex: next,
    fieldIndex: firstSelectableFieldIndex(sections[next]?.fields ?? []),
    mode: "browse",
    choiceIndex: 0,
    draft: "",
    caret: 0,
    filter: "",
    filtering: false
  };
}
function moveField(state, fields, delta) {
  const step = delta < 0 ? -1 : 1;
  let next = state.fieldIndex + step;
  while (next >= 0 && next < fields.length && !isSelectableField(fields[next])) next += step;
  if (next < 0 || next >= fields.length) return state;
  return {
    ...state,
    fieldIndex: next,
    mode: "browse",
    choiceIndex: 0,
    draft: "",
    caret: 0,
    filter: "",
    filtering: false
  };
}
function moveChoice(state, count, delta) {
  if (count === 0) return state;
  return { ...state, choiceIndex: Math.max(0, Math.min(state.choiceIndex + delta, count - 1)) };
}
function choiceAt(field, state) {
  const choices = visibleChoices(field, state.filter);
  return choices[Math.max(0, Math.min(state.choiceIndex, choices.length - 1))];
}
function enterField(state, section, field) {
  if (!field) return { state, effects: [] };
  if (field.kind === "choice") {
    if ((field.choices?.length ?? 0) === 0) {
      return { state, effects: [{ type: "notice", message: `${field.label} has nothing to offer yet` }] };
    }
    return { state: { ...state, mode: "choices", choiceIndex: 0 }, effects: [] };
  }
  if (field.kind === "enum") {
    const choices = field.choices ?? [];
    if (choices.length === 0) {
      return { state, effects: [{ type: "notice", message: `${field.label} has no values published` }] };
    }
    const current = choices.findIndex((choice) => choice.id === field.value);
    const next = choices[(current + 1) % choices.length];
    if (next.status === "blocked") {
      return { state, effects: [{ type: "notice", message: next.statusText ?? `${next.label} is unavailable` }] };
    }
    return invokeEffect(state, section, field, next.action ?? KXM_TUI_SET_ACTION, next.id);
  }
  if (field.kind !== "text") return { state, effects: [] };
  return { state: { ...state, mode: "edit", draft: field.value ?? "", caret: (field.value ?? "").length }, effects: [] };
}
function reduceDecoded(state, sections, decoded) {
  const section = sections[state.sectionIndex];
  const field = currentField(sections, state);
  if (decoded.kind === "ctrlC") {
    if (field?.busy && section) {
      return invokeEffect(state, section, field, KXM_TUI_ABORT_ACTION);
    }
    return { state, effects: [{ type: "quit" }] };
  }
  if (!section) return { state, effects: [{ type: "quit" }] };
  if (state.mode === "edit") return reduceEdit(state, section, field, decoded);
  if (state.mode === "choices") return reduceChoices(state, section, field, decoded);
  return reduceBrowse(state, sections, section, field, decoded);
}
function caretSource(text, caret) {
  return Array.from(text).slice(0, caret).join("").length;
}
function reduceEdit(state, section, field, decoded) {
  if (!field) return { state: { ...state, mode: "browse" }, effects: [] };
  switch (decoded.kind) {
    case "escape":
      return { state: { ...state, mode: "browse", draft: "", caret: 0 }, effects: [] };
    case "enter": {
      const value = normalizeInputText(state.draft).trim();
      if (!value) return { state: { ...state, mode: "browse", draft: "", caret: 0 }, effects: [] };
      const step = invokeEffect(state, section, field, KXM_TUI_SET_ACTION, value);
      return { state: { ...step.state, mode: "browse", draft: "", caret: 0 }, effects: step.effects };
    }
    case "backspace": {
      if (state.caret === 0) return { state, effects: [] };
      const cut = caretSource(state.draft, state.caret);
      const before = deleteBackward(state.draft.slice(0, cut));
      const draft = `${before}${state.draft.slice(cut)}`;
      return { state: { ...state, draft, caret: Array.from(before).length }, effects: [] };
    }
    case "delete": {
      const units = Array.from(state.draft);
      const text = [...units.slice(0, state.caret), ...units.slice(state.caret + 1)].join("");
      return { state: { ...state, draft: text }, effects: [] };
    }
    case "left":
      return { state: { ...state, caret: Math.max(0, state.caret - 1) }, effects: [] };
    case "right":
      return { state: { ...state, caret: Math.min(Array.from(state.draft).length, state.caret + 1) }, effects: [] };
    case "home":
      return { state: { ...state, caret: 0 }, effects: [] };
    case "end":
      return { state: { ...state, caret: Array.from(state.draft).length }, effects: [] };
    case "text": {
      const text = decoded.text ?? "";
      if (!text) return { state, effects: [] };
      const inserted = insertAt(state.draft, state.caret, text);
      return { state: { ...state, draft: inserted.text, caret: inserted.caret }, effects: [] };
    }
    default:
      return { state, effects: [] };
  }
}
function reduceChoices(state, section, field, decoded) {
  if (!field) return { state: { ...state, mode: "browse" }, effects: [] };
  const choices = visibleChoices(field, state.filter);
  switch (decoded.kind) {
    case "escape":
      return { state: { ...state, mode: "browse", filter: "", filtering: false, choiceIndex: 0 }, effects: [] };
    case "up":
      return { state: moveChoice(state, choices.length, -1), effects: [] };
    case "down":
      return { state: moveChoice(state, choices.length, 1), effects: [] };
    case "pageUp":
      return { state: moveChoice(state, choices.length, -8), effects: [] };
    case "pageDown":
      return { state: moveChoice(state, choices.length, 8), effects: [] };
    case "enter": {
      const choice = choiceAt(field, state);
      if (!choice) return { state, effects: [] };
      if (choice.status === "blocked") {
        return { state, effects: [{ type: "notice", message: choice.statusText ?? `${choice.label} is unavailable` }] };
      }
      const clearing = (choice.action ?? KXM_TUI_SET_ACTION) === KXM_TUI_CLEAR_ACTION;
      const step = invokeEffect(
        state,
        section,
        field,
        choice.action ?? KXM_TUI_SET_ACTION,
        clearing ? void 0 : choice.id
      );
      return { state: { ...step.state, mode: "browse", filter: "", filtering: false }, effects: step.effects };
    }
    case "backspace": {
      if (state.filter.length === 0) return { state: { ...state, filtering: false }, effects: [] };
      return { state: { ...state, filter: deleteBackward(state.filter), choiceIndex: 0 }, effects: [] };
    }
    case "text": {
      const text = normalizeInputText(decoded.text ?? "");
      if (!text) return { state, effects: [] };
      return { state: { ...state, filtering: true, filter: `${state.filter}${text}`, choiceIndex: 0 }, effects: [] };
    }
    default:
      return { state, effects: [] };
  }
}
function reduceBrowse(state, sections, section, field, decoded) {
  if (state.help && (decoded.kind === "escape" || decoded.kind === "enter")) {
    return { state: { ...state, help: false }, effects: [] };
  }
  if (state.help) return { state, effects: [] };
  if (decoded.kind === "text") {
    const key = decoded.text ?? "";
    if (key === "q") return { state, effects: [{ type: "quit" }] };
    if (key === "h" || key === "?") return { state: { ...state, help: true }, effects: [] };
    const action = field?.actions?.find((candidate) => candidate.key === key);
    if (action && field) return invokeEffect(state, section, field, action.action);
    if ((key === "x" || key === "d") && field && field.value !== void 0 && field.kind !== "info") {
      return invokeEffect(state, section, field, KXM_TUI_CLEAR_ACTION);
    }
    if (PANE_KEYS.has(key)) {
      if (key === "h") return { state: { ...state, pane: "sections" }, effects: [] };
      if (key === "l") return { state: { ...state, pane: "fields" }, effects: [] };
      const delta = key === "k" ? -1 : 1;
      return {
        state: state.pane === "fields" ? moveField(state, section.fields, delta) : moveSection(state, sections, delta),
        effects: []
      };
    }
    return { state, effects: [] };
  }
  switch (decoded.kind) {
    case "escape":
      return state.pane === "fields" ? { state: { ...state, pane: "sections", mode: "browse" }, effects: [] } : { state, effects: [{ type: "quit" }] };
    case "tab":
      return { state: { ...state, pane: state.pane === "fields" ? "sections" : "fields" }, effects: [] };
    case "right":
      return { state: { ...state, pane: "fields" }, effects: [] };
    case "left":
      return { state: { ...state, pane: "sections" }, effects: [] };
    case "up":
      return { state: state.pane === "fields" ? moveField(state, section.fields, -1) : moveSection(state, sections, -1), effects: [] };
    case "down":
      return { state: state.pane === "fields" ? moveField(state, section.fields, 1) : moveSection(state, sections, 1), effects: [] };
    case "pageUp":
      return { state: moveSection(state, sections, -1), effects: [] };
    case "pageDown":
      return { state: moveSection(state, sections, 1), effects: [] };
    case "enter":
      return state.pane === "fields" ? enterField(state, section, field) : { state: { ...state, pane: "fields" }, effects: [] };
    default:
      return { state, effects: [] };
  }
}

// packages/core/tui/src/tui/render.ts
import { stripTerminalSequences } from "@earendil-works/pi-tui";
var SECTION_PANE_RATIO = 1 / 3;
var MIN_PANE_WIDTH = 16;
var PROGRESS_WIDTH = 20;
var OUTPUT_TAIL = 6;
var SPLIT_MIN_WIDTH = 76;
function statusMark(status, theme, fallback) {
  switch (status) {
    case "ready":
      return theme.fg("success", KXM_TUI_MARKS.ready);
    case "available":
      return theme.fg("accent", KXM_TUI_MARKS.available);
    case "blocked":
      return theme.fg("error", KXM_TUI_MARKS.blocked);
    default:
      return theme.dim(fallback);
  }
}
function cursorMark(active, theme) {
  return active ? theme.cursor(KXM_TUI_MARKS.cursor) : KXM_TUI_MARKS.blankCursor;
}
function paneSplit(width) {
  const third = Math.max(MIN_PANE_WIDTH, Math.floor(width * SECTION_PANE_RATIO));
  const sections = Math.min(third, Math.max(MIN_PANE_WIDTH, Math.floor(width / 2)));
  return { sections, fields: Math.max(MIN_PANE_WIDTH, width - sections - 1) };
}
function fieldIsPending(state, section, field) {
  return state.pending.includes(pendingKey({ source: section.source, sectionId: section.id, fieldId: field.id }));
}
function sectionRow(section, focused, pane, theme, width) {
  const cursor = cursorMark(focused && pane === "sections", theme);
  const flag = section.notice ? theme.fg(section.noticeLevel === "error" ? "error" : "warning", "!") : " ";
  const count = section.fields.length;
  const unset = section.fields.filter((field) => field.kind !== "info" && field.value === void 0).length;
  const right = unset > 0 ? `${unset} unset / ${count}` : `${count} field${count === 1 ? "" : "s"}`;
  return fitText(alignRight(`${cursor} ${flag} ${section.title}`, right, width), width);
}
function choiceSuffix(choice) {
  const parts = [];
  if (choice.detail) parts.push(choice.detail);
  if (choice.statusText) parts.push(choice.statusText);
  return parts.join(" \xB7 ");
}
function choiceRows(field, state, theme, width) {
  const shown = visibleChoices(field, state.filter);
  const lines = [];
  if (state.filtering) {
    lines.push(fitText(`   ${theme.dim(`filter: ${state.filter || "(type to filter \xB7 esc clears)"}`)}`, width));
  }
  if (shown.length === 0) {
    lines.push(fitText(`   ${theme.dim("no match")}`, width));
    return lines;
  }
  let position = -1;
  for (const group of groupedKxmTuiChoices(field)) {
    const filtered = shown.filter((choice) => (choice.group ?? "") === group.group);
    if (filtered.length === 0) continue;
    if (group.group) lines.push(fitText(`   ${theme.key(group.group.toUpperCase())}`, width));
    for (const choice of filtered) {
      position += 1;
      lines.push(
        fitText(
          alignRight(
            `${cursorMark(position === state.choiceIndex, theme)} ${statusMark(choice.status, theme, KXM_TUI_MARKS.pending)} ${choice.label}`,
            choiceSuffix(choice),
            width
          ),
          width
        )
      );
    }
  }
  return lines;
}
var STEP_MARKS = {
  pending: "\xB7",
  satisfied: KXM_TUI_MARKS.passed,
  running: KXM_TUI_MARKS.active,
  done: KXM_TUI_MARKS.passed,
  failed: KXM_TUI_MARKS.failed
};
function stepColor(state, theme) {
  switch (state) {
    case "running":
      return (text) => theme.fg("accent", text);
    case "done":
      return (text) => theme.fg("success", text);
    case "failed":
      return (text) => theme.fg("error", text);
    default:
      return theme.dim;
  }
}
function stepRows(steps, theme, width) {
  return steps.map((step) => {
    const paint = stepColor(step.state, theme);
    return fitText(alignRight(`   ${paint(STEP_MARKS[step.state])} ${step.label}`, step.detail ?? "", width), width);
  });
}
function progressRow(field, theme, width) {
  const progress = field.progress;
  if (!progress) return "";
  const ratio = progress.ratio;
  const right = ratio === void 0 ? "working" : `${Math.round(ratio * 100)}%`;
  return fitText(alignRight(`   ${progress.label}`, `${progressBar(ratio, PROGRESS_WIDTH)} ${right}`, width), width);
}
function focusedFieldDetail(field, state, theme, width) {
  const lines = [];
  if (field.keyPath) lines.push(fitText(`   ${theme.dim(`key: ${field.keyPath}`)}`, width));
  for (const line of wrapPlain(field.detail ?? "", width - 3)) {
    if (line) lines.push(fitText(`   ${theme.dim(line)}`, width));
  }
  for (const line of wrapPlain(field.statusText ?? "", width - 3)) {
    if (line) lines.push(fitText(`   ${theme.fg("error", line)}`, width));
  }
  const progress = progressRow(field, theme, width);
  if (progress) lines.push(progress);
  if (field.steps?.length) lines.push(...stepRows(field.steps, theme, width));
  if (field.output?.length) {
    lines.push(...field.output.slice(-OUTPUT_TAIL).map((line) => fitText(`   ${theme.dim(line)}`, width)));
  }
  if (field.actions?.length) {
    lines.push(fitText(`   ${theme.key(field.actions.map((action) => `${action.key} ${action.label}`).join(" \xB7 "))}`, width));
  }
  if (state.mode === "choices") lines.push(...choiceRows(field, state, theme, width));
  if (state.mode === "edit" || field.awaitingInput) {
    const draft = state.mode === "edit" ? `${state.draft.slice(0, state.caret)}|${state.draft.slice(state.caret)}` : "|";
    lines.push(fitText(`   ${theme.dim("\u203A")} ${draft}`, width));
  }
  return lines;
}
function fieldRows(section, state, theme, width, nowMs) {
  const lines = [];
  section.fields.forEach((field, index) => {
    const focused = state.pane === "fields" && state.fieldIndex === index;
    if (field.kind === "info") {
      lines.push(fitText(`   ${theme.dim(field.label)}  ${theme.dim(field.value ?? field.placeholder ?? "")}`, width));
      return;
    }
    const pending = fieldIsPending(state, section, field);
    const mark = statusMark(field.status, theme, pending ? "\u25CC" : KXM_TUI_MARKS.pending);
    const value = pending && field.value === void 0 ? theme.dim("saving\u2026") : field.value;
    const shown = value ?? theme.dim(field.placeholder ?? "not set");
    const age = field.updatedAt ? theme.dim(` (${formatAge(field.updatedAt, nowMs)})`) : "";
    lines.push(fitText(`${cursorMark(focused, theme)} ${mark} ${alignRight(field.label, `${shown}${age}`, width - 4)}`, width));
    if (focused) lines.push(...focusedFieldDetail(field, state, theme, width));
  });
  return lines;
}
function noticeRows(section, theme, width) {
  if (!section?.notice) return [];
  const token = section.noticeLevel === "error" ? "error" : "warning";
  return wrapPlain(section.notice, width - 2).map((line) => fitText(theme.fg(token, line), width));
}
function singlePaneLines(sections, state, theme, width, nowMs) {
  const section = sections[state.sectionIndex];
  if (state.pane === "fields" && section) {
    return [
      fitText(theme.headerBg(alignRight(` ${section.title}`, section.source, width)), width),
      ...noticeRows(section, theme, width),
      ...fieldRows(section, state, theme, width, nowMs)
    ];
  }
  return [
    fitText(theme.headerBg(alignRight(" SECTIONS", `${sections.length}`, width)), width),
    ...sections.map((candidate, index) => sectionRow(candidate, index === state.sectionIndex, state.pane, theme, width))
  ];
}
function twoPaneLines(sections, state, theme, width, nowMs) {
  const split = paneSplit(width);
  const left = [fitText(theme.key(" SECTIONS"), split.sections)];
  sections.forEach(
    (candidate, index) => left.push(sectionRow(candidate, index === state.sectionIndex, state.pane, theme, split.sections))
  );
  const right = [];
  const section = sections[state.sectionIndex];
  if (section) {
    right.push(fitText(alignRight(` ${section.title}`, section.source, split.fields), split.fields));
    if (section.detail) right.push(fitText(` ${theme.dim(section.detail)}`, split.fields));
    right.push(...noticeRows(section, theme, split.fields));
    right.push(...fieldRows(section, state, theme, split.fields, nowMs));
  } else {
    right.push(fitText(theme.dim("no surface is published"), split.fields));
  }
  const rows = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    rows.push(fitText(`${padRight(left[index] ?? "", split.sections)} ${right[index] ?? ""}`, width));
  }
  return rows;
}
function renderKxmTuiPanel(sections, state, theme, options, width = 120) {
  const nowMs = options.nowMs ?? Date.now();
  const title = `${theme.cursor(options.title)}${options.breadcrumb ? `  ${theme.dim(options.breadcrumb)}` : ""}`;
  const header = [fitText(title, width)];
  if (state.help) {
    const help = (options.helpLines ?? ["no help published"]).flatMap((line) => wrapPlain(line, Math.max(1, width - 2)));
    return [...header, ...help.map((line) => fitText(line, width)), fitText(theme.dim("esc close help"), width)];
  }
  const body = width < SPLIT_MIN_WIDTH ? singlePaneLines(sections, state, theme, width, nowMs) : twoPaneLines(sections, state, theme, width, nowMs);
  const footer = options.footer ? [fitText(theme.dim(options.footer), width)] : [];
  return [...header, ...body, ...footer];
}
function renderKxmTuiPanelText(sections, state, options, width = 120) {
  return `${renderKxmTuiPanel(sections, state, createPlainKxmTuiTheme(), options, width).map((line) => stripTerminalSequences(line)).join("\n")}
`;
}

// packages/core/tui/src/tui/panelComponent.ts
import { Box, HStack, ScrollView, Text, TruncatedText, VStack, Key, matchesKey } from "@earendil-works/pi-tui";
var KXM_TUI_PANEL_HELP = Object.freeze([
  "\u2191\u2193 move \xB7 \u2190\u2192 or Tab panes \xB7 PgUp/PgDn section \xB7 enter edit or open list",
  "type to filter a list \xB7 x clears a value \xB7 esc backs out \xB7 q quit \xB7 h help"
]);
function rowsComponent() {
  const stack = new VStack([], { gap: 0 });
  const scroll = new ScrollView(stack, { primary: true, overscroll: "contain", scrollbar: "auto" });
  const fill = (rows) => {
    stack.clear();
    for (const row of rows) stack.addChild(new TruncatedText(row, 0, 0));
  };
  return { stack, scroll, fill };
}
var KxmTuiPanelComponent = class {
  root = new VStack([], { gap: 0 });
  options;
  body = rowsComponent();
  sections;
  state;
  notice;
  unsubscribe;
  constructor(options) {
    this.options = options;
    this.sections = options.registry.getSections();
    this.state = initialKxmTuiPanelState(this.sections);
    this.unsubscribe = options.registry.subscribe(() => this.refresh());
    this.rebuild();
  }
  getState() {
    return this.state;
  }
  getSections() {
    return this.sections;
  }
  /** Point the cursor at a field, e.g. after opening a named section. */
  focus(sectionId, fieldId) {
    const sectionIndex = this.sections.findIndex((section) => section.id === sectionId);
    if (sectionIndex < 0) return;
    const fields = this.sections[sectionIndex]?.fields ?? [];
    const fieldIndex = fieldId ? Math.max(0, fields.findIndex((field) => field.id === fieldId)) : this.state.fieldIndex;
    this.state = { ...this.state, pane: "fields", sectionIndex, fieldIndex };
    this.rebuild();
    this.options.requestRender();
  }
  setStatus(message) {
    this.notice = message;
    this.rebuild();
    this.options.requestRender();
  }
  refresh() {
    const next = this.options.registry.getSections();
    this.sections = next;
    this.state = reconcileKxmTuiPanelState(this.state, next);
    this.rebuild();
    this.options.requestRender();
  }
  handleInput(data) {
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.body.scroll.scrollBy(-(this.viewport() - 2));
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.body.scroll.scrollBy(this.viewport() - 2);
      this.options.requestRender();
      return;
    }
    const step = reduceKxmTuiInput(this.state, this.sections, data);
    this.state = step.state;
    for (const effect of step.effects) this.run(effect);
    this.rebuild();
    this.options.requestRender();
  }
  viewport() {
    const height = this.body.scroll.viewportHeight;
    return height > 3 ? height : 10;
  }
  run(effect) {
    if (effect.type === "quit") {
      this.options.onQuit();
      return;
    }
    if (effect.type === "notice") {
      this.notice = effect.message;
      return;
    }
    this.notice = void 0;
    void this.options.registry.invoke(effect.invocation).then((result) => {
      if (!result.ok) this.setStatus(result.message ?? "the owner refused that change");
      else if (this.notice === void 0) this.setStatus(void 0);
    });
  }
  footer() {
    const status = this.notice ?? this.options.statusText?.();
    const base = "\u2191\u2193 \xB7 \u2190\u2192 panes \xB7 enter edit \xB7 x clear \xB7 esc back \xB7 h help \xB7 q quit";
    return status ? `${base}  ${status}` : base;
  }
  rebuild() {
    const theme = this.options.theme;
    const width = this.options.getWidth?.() ?? 120;
    const title = new Box(1, 0, theme.headerBg);
    title.addChild(new HStack([
      { component: new Text(theme.cursor(this.options.title), 0, 0), basis: 12, shrink: 1, minSize: 6 },
      {
        component: new Text(
          this.options.breadcrumb ? theme.dim(fitText(this.options.breadcrumb, Math.max(4, width - 16))) : "",
          0,
          0
        ),
        grow: 1,
        shrink: 1,
        minSize: 8
      }
    ], { gap: 2 }));
    this.body.fill(
      renderKxmTuiPanel(this.sections, this.state, theme, {
        title: this.options.title,
        ...this.options.breadcrumb ? { breadcrumb: this.options.breadcrumb } : {},
        helpLines: this.options.helpLines ?? KXM_TUI_PANEL_HELP,
        footer: this.footer()
      }, width)
    );
    const panel = new Box(0, 0, theme.panelBg);
    panel.addChild(this.body.scroll);
    this.root.clear();
    this.root.addChild(title, { basis: "auto", shrink: 0 });
    this.root.addChild(panel, { basis: "auto", grow: 1, shrink: 1, minSize: 1 });
  }
  handleMouse(event) {
    return this.root.handleMouse?.(event);
  }
  invalidate() {
    this.root.invalidate();
  }
  render(width) {
    return this.root.render(width);
  }
  dispose() {
    this.unsubscribe();
    this.unsubscribe = () => void 0;
  }
};
function createKxmTuiPanelComponent(options) {
  return new KxmTuiPanelComponent(options);
}

// packages/core/tui/src/tui/optimizer.ts
function evaluatePlanOptimizations(tasks) {
  const proposals = [];
  const byStage = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    const list = byStage.get(task.stageId) ?? [];
    list.push(task);
    byStage.set(task.stageId, list);
  }
  for (const [stageId, stageTasks] of byStage) {
    if (stageTasks.length >= 2) {
      const independent = stageTasks.filter((t) => t.dependencies.length === 0 || t.dependencies.every((dep) => !stageTasks.some((st) => st.id === dep)));
      if (independent.length >= 2) {
        proposals.push({
          id: `opt_fanout_${stageId}`,
          category: "concurrency",
          title: `Parallelize ${independent.length} tasks in stage "${stageId}"`,
          description: `Tasks [${independent.map((t) => t.id).join(", ")}] have zero mutual dependencies and can execute concurrently via kxm_fanout.`,
          targetTaskIds: independent.map((t) => t.id),
          projectedTimeSavingsSeconds: Math.round(independent.length * 15),
          projectedCostSavingsPercent: 0,
          selected: true
        });
      }
    }
  }
  for (const task of tasks) {
    const isFrontier = /claude-3-5-sonnet|claude-3-opus|gpt-4o|gpt-5/i.test(task.model);
    if (isFrontier && (task.category === "docs" || /doc|readme|markdown/i.test(task.title))) {
      proposals.push({
        id: `opt_cost_${task.id}`,
        category: "cost",
        title: `Downscale model for documentation task "${task.title}"`,
        description: `Task "${task.id}" is documentation-focused. Routing to a high-throughput lightweight model saves significant token budget.`,
        targetTaskIds: [task.id],
        projectedTimeSavingsSeconds: 5,
        projectedCostSavingsPercent: 65,
        suggestedHarness: "pi",
        suggestedModel: "qwen/qwen3-coder-plus",
        selected: true
      });
    } else if (isFrontier && (task.category === "lint" || /lint|format|style/i.test(task.title))) {
      proposals.push({
        id: `opt_lint_${task.id}`,
        category: "cost",
        title: `Downscale model for formatting/lint task "${task.title}"`,
        description: `Task "${task.id}" performs deterministic formatting/linting. Use a fast local/tier-1 helper.`,
        targetTaskIds: [task.id],
        projectedTimeSavingsSeconds: 8,
        projectedCostSavingsPercent: 80,
        suggestedHarness: "pi",
        suggestedModel: "google/gemini-2.5-flash",
        selected: true
      });
    }
  }
  const totalTimeSavings = proposals.reduce((acc, p) => acc + p.projectedTimeSavingsSeconds, 0);
  const totalCostSavings = proposals.length > 0 ? Math.round(proposals.reduce((acc, p) => acc + p.projectedCostSavingsPercent, 0) / proposals.length) : 0;
  return {
    proposals,
    totalProjectedTimeSavingsSeconds: totalTimeSavings,
    totalProjectedCostSavingsPercent: totalCostSavings
  };
}
function applyPlanOptimizations(tasks, proposals) {
  const selected = proposals.filter((p) => p.selected);
  if (selected.length === 0) return { tasks: [...tasks], appliedCount: 0 };
  const modelOverrides = /* @__PURE__ */ new Map();
  for (const proposal of selected) {
    if (proposal.category === "cost" && proposal.suggestedModel) {
      for (const targetId of proposal.targetTaskIds) {
        modelOverrides.set(targetId, {
          ...proposal.suggestedHarness ? { harness: proposal.suggestedHarness } : {},
          model: proposal.suggestedModel
        });
      }
    }
  }
  const updated = tasks.map((task) => {
    const override = modelOverrides.get(task.id);
    if (!override) return task;
    return {
      ...task,
      ...override.harness ? { harness: override.harness } : {},
      ...override.model ? { model: override.model } : {}
    };
  });
  return {
    tasks: updated,
    appliedCount: selected.length
  };
}

// packages/core/tui/src/tui/history.ts
function filterHistoryEvents(events, options = {}) {
  const category = options.category ?? "all";
  const query = options.query?.trim().toLowerCase();
  return events.filter((ev) => {
    if (category !== "all" && ev.category !== category) return false;
    if (!query) return true;
    const matchTarget = `${ev.id} ${ev.title} ${ev.stageId ?? ""} ${ev.taskId ?? ""} ${ev.role ?? ""} ${ev.model ?? ""} ${ev.journalSummary ?? ""}`.toLowerCase();
    return matchTarget.includes(query);
  });
}
function renderWorkflowHistoryMarkdown(runId, events) {
  const totalSpend = events.reduce((acc, ev) => acc + (ev.costUsd ?? 0), 0);
  const passedCount = events.filter((ev) => ev.status === "passed").length;
  const failedCount = events.filter((ev) => ev.status === "failed").length;
  let mdContent = `# KXM Workflow Retrospective: ${runId}

`;
  mdContent += `**Total Events:** ${events.length} (Passed: ${passedCount}, Failed: ${failedCount})
`;
  mdContent += `**Total Spend:** $${totalSpend.toFixed(4)} USD

`;
  mdContent += `## Chronological Event Journal

`;
  mdContent += `| Timestamp | Category | Title | Status | Role / Model | Duration | Spend |
`;
  mdContent += `|---|---|---|---|---|---|---|
`;
  for (const ev of events) {
    const elapsed = ev.durationMs !== void 0 ? `${(ev.durationMs / 1e3).toFixed(1)}s` : "-";
    const spend = ev.costUsd !== void 0 ? `$${ev.costUsd.toFixed(4)}` : "-";
    const roleModel = ev.role ? `${ev.role} (${ev.harness ?? "-"}/${ev.model ?? "-"})` : "-";
    mdContent += `| ${ev.timestamp} | ${ev.category} | ${ev.title} | ${ev.status} | ${roleModel} | ${elapsed} | ${spend} |
`;
  }
  mdContent += `
## Produced Artifacts & Proofs

`;
  for (const ev of events) {
    if (ev.artifacts && ev.artifacts.length > 0) {
      mdContent += `### ${ev.title} (${ev.id})
`;
      for (const art of ev.artifacts) {
        mdContent += `- \`${art}\`
`;
      }
    }
  }
  return mdContent;
}
function formatWorkflowHistoryJsonl(runId, events) {
  return events.map((ev) => JSON.stringify({
    schema: "kxm.workflow-history-event.v1",
    runId,
    ...ev
  })).join("\n") + "\n";
}

// packages/core/tui/src/tui/queue.ts
function reorderQueuedTasks(tasks, fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= tasks.length || toIndex < 0 || toIndex >= tasks.length || fromIndex === toIndex) {
    return { success: false, tasks, warning: "invalid_indices" };
  }
  const target = tasks[fromIndex];
  if (target.status === "in_flight" || target.status === "completed") {
    return {
      success: false,
      tasks,
      warning: `cannot move ${target.status} task "${target.id}"`
    };
  }
  const draft = [...tasks];
  const [removed] = draft.splice(fromIndex, 1);
  draft.splice(toIndex, 0, removed);
  const idToIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < draft.length; i++) {
    idToIndex.set(draft[i].id, i);
  }
  for (let i = 0; i < draft.length; i++) {
    const task = draft[i];
    for (const depId of task.dependencies) {
      const depIndex = idToIndex.get(depId);
      if (depIndex !== void 0 && depIndex > i) {
        return {
          success: false,
          tasks,
          warning: `Prerequisite violation: "${task.id}" depends on "${depId}", which is scheduled later at position ${depIndex + 1}`
        };
      }
    }
  }
  return {
    success: true,
    tasks: draft
  };
}

// packages/core/tui/src/tui/roleBudget.ts
function evaluateRoleBudget(config, state, projectedCostUsd = 0) {
  const projectedRunSpend = state.currentRunSpendUsd + projectedCostUsd;
  if (config.runSpendCapUsd !== void 0 && projectedRunSpend > config.runSpendCapUsd) {
    if (config.onExhausted === "cascade_to_roster" && config.fallbackModel) {
      return {
        status: "exhausted",
        nextAction: "cascade",
        fallbackModel: config.fallbackModel,
        fallbackHarness: config.fallbackHarness ?? "pi",
        warning: `Role "${config.roleId}" reached run spend cap ($${config.runSpendCapUsd.toFixed(2)}); rolling over to ${config.fallbackModel}`
      };
    }
    if (config.onExhausted === "borrow_from_pool" && (config.emergencyPoolLimitUsd ?? 0) > state.borrowedFromPoolUsd) {
      return {
        status: "exhausted",
        nextAction: "borrow",
        warning: `Role "${config.roleId}" borrowing from project emergency buffer`
      };
    }
    return {
      status: "exhausted",
      nextAction: config.onExhausted === "pause_for_approval" ? "pause" : "fail_closed",
      warning: `Role "${config.roleId}" exhausted run spend cap ($${config.runSpendCapUsd.toFixed(2)})`
    };
  }
  if (config.monthlySpendCapUsd !== void 0 && state.currentMonthlySpendUsd + projectedCostUsd > config.monthlySpendCapUsd) {
    if (config.onExhausted === "cascade_to_roster" && config.fallbackModel) {
      return {
        status: "exhausted",
        nextAction: "cascade",
        fallbackModel: config.fallbackModel,
        fallbackHarness: config.fallbackHarness ?? "pi",
        warning: `Role "${config.roleId}" reached monthly budget limit ($${config.monthlySpendCapUsd.toFixed(2)})`
      };
    }
    return {
      status: "exhausted",
      nextAction: "pause",
      warning: `Role "${config.roleId}" reached monthly budget cap ($${config.monthlySpendCapUsd.toFixed(2)})`
    };
  }
  if (config.runSpendCapUsd && projectedRunSpend / config.runSpendCapUsd >= 0.85) {
    return {
      status: "near_limit",
      nextAction: "proceed",
      warning: `Role "${config.roleId}" is at ${Math.round(projectedRunSpend / config.runSpendCapUsd * 100)}% of run budget`
    };
  }
  return {
    status: "ok",
    nextAction: "proceed"
  };
}

// packages/core/tui/src/tui/modelSelector.ts
function filterModelOptions(models, query, providerFilter) {
  const q = query?.trim().toLowerCase();
  const prov = providerFilter?.trim().toLowerCase();
  return models.filter((m) => {
    if (prov && m.provider.toLowerCase() !== prov && m.harness.toLowerCase() !== prov) {
      return false;
    }
    if (!q) return true;
    const matchTarget = `${m.id} ${m.selector} ${m.name} ${m.provider} ${m.harness}`.toLowerCase();
    return matchTarget.includes(q);
  });
}

// packages/core/tui/src/services/registry.ts
function describe(error) {
  if (error instanceof Error && error.message) return error.message.split(/\r?\n/u)[0].slice(0, KXM_TUI_LIMITS.detailMax);
  return String(error).split(/\r?\n/u)[0].slice(0, KXM_TUI_LIMITS.detailMax);
}
function normalizeSource(source) {
  if (!/^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/u.test(source) || source.length > KXM_TUI_LIMITS.sourceMax) {
    throw new Error(`invalid kxm tui surface source: ${source.slice(0, 64)}`);
  }
  return source;
}
function createKxmTuiRegistry(options = {}) {
  const contributions = /* @__PURE__ */ new Map();
  const notices = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Set();
  const published = /* @__PURE__ */ new Map();
  const issues = /* @__PURE__ */ new Map();
  let generation = 0;
  let disposed = false;
  let epoch = 0;
  const report = (error, context) => {
    if (options.onInternalError) options.onInternalError(error, context);
  };
  const emit = (event) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        report(error, "listener");
      }
    }
  };
  function readOwner(source, force) {
    if (!force) {
      const cached = published.get(source);
      if (cached) return cached;
    }
    const contribution = contributions.get(source);
    if (!contribution) {
      published.set(source, []);
      return [];
    }
    let sections;
    try {
      const raw = contribution.listSections();
      const ownerIssues = validateKxmTuiSurface(raw);
      if (ownerIssues.length > 0) {
        issues.set(source, ownerIssues);
        sections = raw.filter((section) => Boolean(section) && typeof section === "object").map((section) => ({
          ...section,
          notice: section.notice ?? `published surface was refused: ${ownerIssues[0].code} at ${ownerIssues[0].path}`,
          noticeLevel: "error"
        }));
      } else {
        issues.delete(source);
        sections = raw;
      }
    } catch (error) {
      issues.set(source, [{ path: source, code: "list_sections_failed", message: describe(error) }]);
      report(error, `listSections:${source}`);
      sections = [{ source, id: "error", title: source, order: 900, notice: describe(error), noticeLevel: "error", fields: [] }];
    }
    const pending = notices.get(source);
    const withNotice = pending !== void 0 && sections.length > 0 ? sections.map((section, index) => index === 0 ? { ...section, notice: pending, noticeLevel: "error" } : section) : sections;
    published.set(source, withNotice);
    return withNotice;
  }
  function merged() {
    const all = [];
    for (const source of contributions.keys()) all.push(...readOwner(source, false));
    return all.slice().sort((a, b) => a.order - b.order || a.source.localeCompare(b.source) || a.title.localeCompare(b.title));
  }
  return {
    register(contribution) {
      if (disposed) throw new Error("kxm tui registry is disposed");
      const source = normalizeSource(contribution.source);
      notices.delete(source);
      published.delete(source);
      issues.delete(source);
      contributions.set(source, { ...contribution, source });
      emit({ reason: "publish", source });
    },
    unregister(source) {
      contributions.delete(source);
      published.delete(source);
      issues.delete(source);
      notices.delete(source);
      emit({ reason: "publish", source });
    },
    getSections() {
      return merged();
    },
    getIssues() {
      return [...issues.values()].flat();
    },
    async invoke(invocation) {
      if (disposed) return { ok: false, message: "kxm tui registry is disposed" };
      const contribution = contributions.get(invocation.source);
      if (!contribution) {
        emit({ reason: "refused", source: invocation.source, message: "unknown owner" });
        return { ok: false, message: `${invocation.source} does not own a surface here` };
      }
      const handler = contribution.handlers[invocation.action];
      if (!handler) {
        const message = `${invocation.source} does not accept "${invocation.action}"`;
        emit({ reason: "refused", source: invocation.source, message });
        return { ok: false, message };
      }
      const currentEpoch = epoch;
      try {
        await handler({
          sectionId: invocation.sectionId,
          fieldId: invocation.fieldId,
          action: invocation.action,
          ...invocation.value === void 0 ? {} : { value: invocation.value }
        });
      } catch (error) {
        const failure = contribution.describeError?.(error, invocation.action) ?? describe(error);
        notices.set(invocation.source, failure);
        emit({ reason: "failed", source: invocation.source, message: failure });
        readOwner(invocation.source, true);
        generation += 1;
        return { ok: false, message: failure };
      }
      if (currentEpoch !== epoch) {
        readOwner(invocation.source, true);
        return { ok: false, message: "stale write result was discarded" };
      }
      notices.delete(invocation.source);
      readOwner(invocation.source, true);
      generation += 1;
      emit({ reason: "publish", source: invocation.source });
      return { ok: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getGeneration() {
      return generation;
    },
    hasSource(source) {
      return contributions.has(source);
    },
    listSources() {
      return [...contributions.keys()];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      listeners.clear();
      contributions.clear();
      published.clear();
      issues.clear();
      notices.clear();
    }
  };
}
function checkedKxmTuiSections(sections) {
  return assertKxmTuiSurface(sections);
}

// packages/core/tui/src/adapters/terminal.ts
import { ProcessTerminal, TuiAltScreen, stripTerminalSequences as stripTerminalSequences2 } from "@earendil-works/pi-tui";
function renderKxmTuiPanelFrame(input) {
  const theme = input.theme ?? createPlainKxmTuiTheme();
  const lines = renderKxmTuiPanel(
    input.registry.getSections(),
    initialKxmTuiPanelState(input.registry.getSections()),
    theme,
    { title: input.title, footer: input.footer ?? "non-interactive frame", nowMs: input.nowMs ?? Date.now() },
    input.width ?? 100
  );
  return `${lines.map((line) => stripTerminalSequences2(line)).join("\n")}
`;
}
async function runKxmTuiPanel(input) {
  const theme = input.theme ?? createDefaultKxmTuiTheme();
  const tty = input.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) {
    input.stdout(renderKxmTuiPanelFrame({
      registry: input.registry,
      title: input.title,
      theme,
      ...input.now === void 0 ? {} : { nowMs: input.now() },
      ...input.breadcrumb ? { footer: input.breadcrumb } : {}
    }));
    return 0;
  }
  const terminal = input.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, void 0, { mouse: true });
  let timer;
  let stopped = false;
  let finished = () => void 0;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    input.abort?.removeEventListener("abort", stop);
    panel.dispose();
    tui.stop();
    finished();
  };
  const panel = new KxmTuiPanelComponent({
    registry: input.registry,
    theme,
    title: input.title,
    ...input.breadcrumb ? { breadcrumb: input.breadcrumb } : {},
    ...input.helpLines ? { helpLines: input.helpLines } : {},
    requestRender: () => tui.requestRender(),
    onQuit: stop,
    getWidth: () => terminal.columns
  });
  input.abort?.addEventListener("abort", stop, { once: true });
  tui.setLayoutRoot(panel.root);
  tui.setFocus(panel);
  tui.start();
  timer = setInterval(() => panel.refresh(), input.pollMs ?? 2e3);
  timer.unref?.();
  await done;
  return stopped && input.abort?.aborted ? 130 : 0;
}

// packages/core/tui/src/adapters/omp.ts
function resolveKxmTheme(theme) {
  if ("headerBg" in theme && typeof theme.headerBg === "function") {
    return theme;
  }
  return createKxmTuiThemeFromPi(theme);
}
function createKxmTuiOmpOverlay(options) {
  let closed = false;
  let mode = options.initialMode ?? "expanded";
  let autoDispatch = Boolean(options.autoDispatch);
  const theme = resolveKxmTheme(options.theme);
  const panel = new KxmTuiPanelComponent({
    registry: options.registry,
    theme,
    title: options.title,
    ...options.goal ? { breadcrumb: `Goal: ${options.goal}` } : {},
    helpLines: [
      "[Ctrl+O/F2] Toggle Fold  [h] History  [a] Toggle Auto  [o] Optimize  [Shift+\u2191/\u2193] Reorder"
    ],
    requestRender: () => options.tui.requestRender(),
    onQuit: () => {
      if (closed) return;
      closed = true;
      panel.dispose();
      options.done?.(true);
    },
    ...options.width === void 0 ? {} : { getWidth: options.width }
  });
  function renderCollapsed(width) {
    const goalText = options.goal ? `Goal: ${options.goal}` : options.title;
    const modeBadge = autoDispatch ? theme.accent("[AUTO: ON]") : theme.dim("[STEP MODE]");
    const hint = theme.dim("[Ctrl+O to Expand]");
    const content = ` [KXM] ${goalText} \u2500\u2500 ${modeBadge} \u2500\u2500 ${hint}`;
    const pad = Math.max(0, width - content.length);
    return [content + " ".repeat(pad)];
  }
  function handleInput(data) {
    if (closed) return;
    if (data === "" || data === "\x1BOQ" || data === "\x1B[12~") {
      mode = mode === "collapsed" ? "expanded" : "collapsed";
      options.tui.requestRender();
      return;
    }
    if (mode === "collapsed") {
      if (data === "\r" || data === " " || data === "o" || data === "O") {
        mode = "expanded";
        options.tui.requestRender();
      }
      return;
    }
    if (data === "a" || data === "A") {
      autoDispatch = !autoDispatch;
      options.onToggleAutoDispatch?.(autoDispatch);
      options.tui.requestRender();
      return;
    }
    if (data === "h" || data === "H") {
      mode = mode === "history" ? "expanded" : "history";
      options.tui.requestRender();
      return;
    }
    if (data === "o" || data === "O") {
      mode = "optimizer";
      options.onRunOptimizer?.();
      options.tui.requestRender();
      return;
    }
    if ((data === "x" || data === "X") && mode === "history") {
      options.onExportHistory?.("both");
      options.tui.requestRender();
      return;
    }
    if (data === "\x1B" && mode !== "expanded") {
      mode = "expanded";
      options.tui.requestRender();
      return;
    }
    panel.handleInput(data);
    options.tui.requestRender();
  }
  return {
    getMode: () => mode,
    setMode: (nextMode) => {
      mode = nextMode;
      options.tui.requestRender();
    },
    isAutoDispatch: () => autoDispatch,
    toggleAutoDispatch: () => {
      autoDispatch = !autoDispatch;
      options.onToggleAutoDispatch?.(autoDispatch);
      options.tui.requestRender();
    },
    render: (width) => {
      if (mode === "collapsed") {
        return renderCollapsed(width);
      }
      return panel.render(width);
    },
    handleInput,
    invalidate: () => panel.invalidate(),
    dispose: () => {
      if (closed) return;
      closed = true;
      panel.dispose();
      options.done?.(true);
    }
  };
}

// packages/core/tui/src/adapters/pi.ts
var createKxmTuiPiOverlay = createKxmTuiOmpOverlay;
function renderPiWorkflowWidget(options) {
  const filled = Math.min(10, Math.max(0, Math.round(options.progressPercent / 100 * 10)));
  const bar = `[${"\u2588".repeat(filled)}${"\u2591".repeat(10 - filled)}] ${options.progressPercent}%`;
  const mode = options.autoDispatch ? "AUTO" : "STEP";
  const line1 = `[KXM] Goal: ${options.goal} \u2500\u2500 Stage: ${options.stage} (${bar}) [${mode}]`;
  const line2 = options.activeTask ? `  Active: ${options.activeTask}` : `  Waiting for next dispatch (use /kxm progress)`;
  return [line1, line2];
}
function createKxmTuiPiPanel(options) {
  let closed = false;
  const panel = new KxmTuiPanelComponent({
    registry: options.registry,
    theme: createKxmTuiThemeFromPi(options.theme),
    title: options.title,
    ...options.breadcrumb === void 0 ? {} : { breadcrumb: options.breadcrumb },
    ...options.helpLines === void 0 ? {} : { helpLines: options.helpLines },
    requestRender: () => options.tui.requestRender(),
    onQuit: () => {
      if (closed) return;
      closed = true;
      panel.dispose();
      options.done?.(true);
    },
    ...options.width === void 0 ? {} : { getWidth: options.width }
  });
  return {
    render: (width) => panel.render(width),
    handleInput: (data) => {
      if (closed) return;
      panel.handleInput(data);
      options.tui.requestRender();
    },
    invalidate: () => panel.invalidate()
  };
}

// packages/core/tui/src/adapters/claude.ts
function formatClaudeTaskHud(options, compact = false) {
  const percent = options.totalTasks > 0 ? Math.round(options.completedTasks / options.totalTasks * 100) : 0;
  const filled = Math.round(percent / 100 * 10);
  const bar = `[${"\u2588".repeat(filled)}${"\u2591".repeat(10 - filled)}] ${percent}%`;
  const modeTag = options.autoDispatch ? "[AUTO]" : "[STEP]";
  const attemptTag = options.attempt && options.attempt > 1 ? ` (Attempt ${options.attempt}/${options.maxAttempts ?? 3})` : "";
  const timeTag = options.elapsedSeconds !== void 0 ? ` \u23F1 ${options.elapsedSeconds}s` : "";
  if (compact) {
    return `[KXM ${modeTag}] ${options.goal} \u2500\u2500 Stage ${options.stageIndex}/${options.totalStages} ${bar}${attemptTag}${timeTag}`;
  }
  const activeTask = options.activeTaskTitle ? `
\u2502  Active Task: ${options.activeTaskTitle}${attemptTag} [${options.activeRole ?? "agent"} (${options.activeModel ?? "default"})]` : "";
  return [
    `\u250C\u2500\u2500 KXM TASK HUD \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510`,
    `\u2502  Goal: ${options.goal}`,
    `\u2502  Stage ${options.stageIndex}/${options.totalStages}: ${options.stageName}  \u2502 Progress: ${bar}${timeTag} \u2502 Mode: ${modeTag}${activeTask}`,
    `\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`
  ].join("\n");
}
function formatClaudeUpcomingQueue(tasks) {
  if (tasks.length === 0) return "No upcoming tasks in queue.";
  const lines = ["### KXM Upcoming Task Queue:"];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const deps = t.dependencies.length > 0 ? ` (Requires: ${t.dependencies.join(", ")})` : " (Ready)";
    lines.push(`${i + 1}. [${t.status.toUpperCase()}] **${t.title}** (\`${t.id}\`)`);
    lines.push(`   Role: \`${t.role}\` [${t.harness}/${t.model}]${deps}`);
  }
  return lines.join("\n");
}
function formatClaudeOptimizerReport(result) {
  if (result.proposals.length === 0) {
    return "Plan Optimizer: No pending optimization proposals.";
  }
  const lines = [
    `### KXM Plan Optimizer Proposals:`,
    `Total Projected Savings: -${result.totalProjectedTimeSavingsSeconds}s execution time, -${result.totalProjectedCostSavingsPercent}% token cost`,
    ""
  ];
  for (const p of result.proposals) {
    const icon = p.category === "concurrency" ? "\u26A1" : "\u{1F4B0}";
    lines.push(`${icon} **${p.title}** (\`${p.id}\`)`);
    lines.push(`   ${p.description}`);
    if (p.suggestedModel) {
      lines.push(`   Suggested Routing: \`${p.suggestedHarness ?? "pi"}/${p.suggestedModel}\``);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
function formatClaudeRoleBudget(config, state) {
  const runCap = config.runSpendCapUsd !== void 0 ? `$${config.runSpendCapUsd.toFixed(2)}` : "Unmetered";
  const monthlyCap = config.monthlySpendCapUsd !== void 0 ? `$${config.monthlySpendCapUsd.toFixed(2)}` : "Unmetered";
  const currentRun = `$${state.currentRunSpendUsd.toFixed(4)}`;
  const currentMonthly = `$${state.currentMonthlySpendUsd.toFixed(2)}`;
  return [
    `Role: ${config.roleId} (${config.type})`,
    `Run Spend: ${currentRun} / ${runCap}`,
    `Monthly Spend: ${currentMonthly} / ${monthlyCap}`,
    `On Exhausted: ${config.onExhausted}${config.fallbackModel ? ` (Fallback: ${config.fallbackModel})` : ""}`
  ].join(" \u2502 ");
}
function formatClaudeWorkflowHistory(runId, events) {
  return renderWorkflowHistoryMarkdown(runId, events);
}

// packages/core/tui/src/adapters/historyExport.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function exportWorkflowHistory(runId, events, destinationDir) {
  mkdirSync(destinationDir, { recursive: true });
  const sanitizedRunId = runId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const mdPath = join(destinationDir, `retrospective-${sanitizedRunId}.md`);
  const jsonlPath = join(destinationDir, `history-${sanitizedRunId}.jsonl`);
  writeFileSync(mdPath, renderWorkflowHistoryMarkdown(runId, events), "utf8");
  writeFileSync(jsonlPath, formatWorkflowHistoryJsonl(runId, events), "utf8");
  return { mdPath, jsonlPath };
}
export {
  KXM_TUI_ABORT_ACTION,
  KXM_TUI_CLEAR_ACTION,
  KXM_TUI_CONTRACT_SCHEMA,
  KXM_TUI_ELLIPSIS,
  KXM_TUI_FIELD_KINDS,
  KXM_TUI_INPUT_MAX_LENGTH,
  KXM_TUI_LIMITS,
  KXM_TUI_MARKS,
  KXM_TUI_NOTICE_LEVELS,
  KXM_TUI_PANEL_HELP,
  KXM_TUI_SET_ACTION,
  KXM_TUI_STATUSES,
  KXM_TUI_STEP_STATES,
  KxmTuiPanelComponent,
  alignRight,
  applyPlanOptimizations,
  assertKxmTuiSurface,
  checkedKxmTuiSections,
  createDefaultKxmTuiTheme,
  createKxmTuiAnsiTheme,
  createKxmTuiOmpOverlay,
  createKxmTuiPanelComponent,
  createKxmTuiPiOverlay,
  createKxmTuiPiPanel,
  createKxmTuiRegistry,
  createKxmTuiThemeFromPi,
  createPlainKxmTuiTheme,
  currentField,
  currentSection,
  decodeKxmTuiInput,
  deleteBackward,
  evaluatePlanOptimizations,
  evaluateRoleBudget,
  exportWorkflowHistory,
  fieldIsEditable,
  filterHistoryEvents,
  filterModelOptions,
  firstSelectableFieldIndex,
  fitText,
  focusedFieldIsEditable,
  formatAge,
  formatClaudeOptimizerReport,
  formatClaudeRoleBudget,
  formatClaudeTaskHud,
  formatClaudeUpcomingQueue,
  formatClaudeWorkflowHistory,
  formatWorkflowHistoryJsonl,
  groupedKxmTuiChoices,
  initialKxmTuiPanelState,
  insertAt,
  isControlInput,
  isSelectableField,
  normalizeInputText,
  padRight,
  pendingKey,
  progressBar,
  reconcileKxmTuiPanelState,
  reduceKxmTuiInput,
  renderKxmTuiPanel,
  renderKxmTuiPanelFrame,
  renderKxmTuiPanelText,
  renderPiWorkflowWidget,
  renderWorkflowHistoryMarkdown,
  reorderQueuedTasks,
  runKxmTuiPanel,
  validateKxmTuiSurface,
  visibleChoices,
  wrapPlain
};
