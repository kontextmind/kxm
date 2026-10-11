/**
 * Owner for the `kxm.config.v1` terminal editor.
 *
 * The panel publishes this contribution and routes every write back here.
 * `listSections` re-reads the merged files on each publish. `set` and `clear`
 * validate the field and the value, then call the config owner. A refusal
 * throws before either owner call, so the file bytes stay as they were.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  KXM_TUI_CLEAR_ACTION,
  KXM_TUI_SET_ACTION,
  createKxmTuiRegistry,
  createKxmTuiPiPanel,
  createPlainKxmTuiTheme,
  runKxmTuiPanel,
  type KxmTuiContribution,
  type KxmTuiField,
  type KxmTuiSectionView,
} from "@kontextmind/tui";
import {
  deleteKxmConfigValue,
  getKxmConfigValue,
  kxmConfigFileForScope,
  loadKxmConfig,
  setKxmConfigValue,
  userConfigDirForEnv,
  type KxmResolvedConfig,
} from "./config.ts";

export const KXM_CONFIG_EDITOR_SOURCE = "kxm/config";

export type KxmConfigEditorScope = "project" | "user";

const INTEGER_TEXT = /^(0|[1-9][0-9]*)$/;
const DECIMAL_TEXT = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const TEXT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

interface EnumSpec {
  readonly kind: "enum";
  readonly choices: readonly string[];
}

interface NumberSpec {
  readonly kind: "number";
  readonly integer: boolean;
  readonly min: number;
  readonly max: number;
}

interface TextSpec {
  readonly kind: "text";
}

type ValueSpec = EnumSpec | NumberSpec | TextSpec;

interface ConfigEditorFieldSpec {
  readonly id: string;
  readonly label: string;
  readonly keyPath: string;
  readonly spec: ValueSpec;
  readonly note?: string;
}

interface ConfigEditorSectionSpec {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly fields: readonly ConfigEditorFieldSpec[];
}

const SCREEN_CHOICES = ["agents", "tasks", "workflows", "plans", "inbox", "procs", "spend"] as const;

const SECTIONS: readonly ConfigEditorSectionSpec[] = [
  {
    id: "user",
    title: "User",
    order: 10,
    fields: [
      { id: "user-theme", label: "Theme", keyPath: "user.theme", spec: { kind: "enum", choices: ["dark", "light", "minimal"] } },
      { id: "user-token-budget", label: "Token budget", keyPath: "user.tokenBudget", spec: { kind: "number", integer: true, min: 1, max: 2_000_000 } },
    ],
  },
  {
    id: "defaults",
    title: "Defaults",
    order: 20,
    fields: [
      { id: "defaults-workflow", label: "Workflow", keyPath: "defaults.workflow", spec: { kind: "text" } },
      { id: "defaults-harness", label: "Harness", keyPath: "defaults.harness", spec: { kind: "text" } },
    ],
  },
  {
    id: "dash",
    title: "Dashboard",
    order: 30,
    fields: [
      { id: "dash-screen", label: "Default screen", keyPath: "dash.defaultScreen", spec: { kind: "enum", choices: SCREEN_CHOICES } },
      { id: "dash-refresh", label: "Refresh interval", keyPath: "dash.refreshIntervalMs", spec: { kind: "number", integer: true, min: 250, max: 3_600_000 } },
      { id: "dash-auto-open", label: "Auto-open", keyPath: "dash.autoOpen", spec: { kind: "enum", choices: ["true", "false"] } },
    ],
  },
  {
    id: "sync",
    title: "Sync",
    order: 40,
    fields: [
      { id: "sync-tracker", label: "Default tracker", keyPath: "sync.defaultTracker", spec: { kind: "enum", choices: ["github", "jira", "none"] } },
    ],
  },
  {
    id: "hub",
    title: "Hub",
    order: 50,
    fields: [
      {
        id: "hub-auto-start",
        label: "Auto-start",
        keyPath: "hub.autoStart",
        spec: { kind: "enum", choices: ["background", "off"] },
        note: "Hub URLs and key references stay out of this panel.",
      },
    ],
  },
  {
    id: "improvement",
    title: "Improvement",
    order: 60,
    fields: [
      { id: "improvement-policy", label: "Promotion policy", keyPath: "improvement.promotionPolicy", spec: { kind: "enum", choices: ["manual_pr", "critic_quorum", "auto_threshold"] } },
      { id: "improvement-half-life", label: "Telemetry half-life", keyPath: "improvement.telemetryHalfLifeDays", spec: { kind: "number", integer: false, min: 0.000001, max: 3650 } },
      { id: "improvement-min-runs", label: "Minimum runs", keyPath: "improvement.autoThreshold.minRuns", spec: { kind: "number", integer: true, min: 1, max: 1_000_000 } },
      { id: "improvement-min-pass-rate", label: "Minimum pass rate", keyPath: "improvement.autoThreshold.minPassRate", spec: { kind: "number", integer: false, min: 0, max: 1 } },
      { id: "improvement-min-cost-savings", label: "Minimum cost savings", keyPath: "improvement.autoThreshold.minCostSavings", spec: { kind: "number", integer: false, min: 0, max: 1_000_000 } },
    ],
  },
  {
    id: "routing",
    title: "Routing",
    order: 70,
    fields: [
      {
        id: "routing-shadow",
        label: "Shadow execution",
        keyPath: "routing.shadowExecution.enabled",
        spec: { kind: "enum", choices: ["true", "false"] },
        note: "Strategy, fallback, and context limits stay in role and route files.",
      },
      { id: "routing-sample-rate", label: "Sample rate", keyPath: "routing.shadowExecution.sampleRate", spec: { kind: "number", integer: false, min: 0, max: 1 } },
      { id: "routing-breaker-mode", label: "Breaker mode", keyPath: "routing.circuitBreaker.mode", spec: { kind: "enum", choices: ["soft_demotion", "quarantine"] } },
      { id: "routing-failure-threshold", label: "Failure threshold", keyPath: "routing.circuitBreaker.failureThreshold", spec: { kind: "number", integer: true, min: 1, max: 10_000 } },
      { id: "routing-window-seconds", label: "Window seconds", keyPath: "routing.circuitBreaker.windowSeconds", spec: { kind: "number", integer: true, min: 1, max: 31_536_000 } },
      { id: "routing-cooldown-seconds", label: "Cooldown seconds", keyPath: "routing.circuitBreaker.cooldownSeconds", spec: { kind: "number", integer: true, min: 0, max: 31_536_000 } },
      { id: "routing-penalty", label: "Penalty multiplier", keyPath: "routing.circuitBreaker.penaltyMultiplier", spec: { kind: "number", integer: false, min: 0.000001, max: 1000 } },
    ],
  },
  {
    id: "telemetry",
    title: "Telemetry",
    order: 80,
    fields: [
      { id: "telemetry-federated", label: "Federated", keyPath: "telemetry.federated", spec: { kind: "enum", choices: ["true", "false"] } },
      { id: "telemetry-anonymize", label: "Anonymize", keyPath: "telemetry.anonymize", spec: { kind: "enum", choices: ["true", "false"] } },
    ],
  },
];

const FIELDS = new Map<string, ConfigEditorFieldSpec>(
  SECTIONS.flatMap((section) => section.fields.map((field) => [field.id, field] as const)),
);

export class KxmConfigEditorError extends Error {
  readonly code = "config_edit_refused";

  constructor(message: string) {
    super(message);
    this.name = "KxmConfigEditorError";
  }
}

export interface KxmConfigEditorTarget {
  readonly cwd: string;
  readonly scope: KxmConfigEditorScope;
  readonly userConfigDir?: string | undefined;
}

export function kxmConfigEditorKeyPaths(): readonly string[] {
  return SECTIONS.flatMap((section) => section.fields.map((field) => field.keyPath));
}

export function createKxmConfigEditorContribution(target: KxmConfigEditorTarget): KxmTuiContribution {
  return {
    source: KXM_CONFIG_EDITOR_SOURCE,
    republishAfterWrite: true,
    listSections: () => listConfigEditorSections(target),
    handlers: {
      [KXM_TUI_SET_ACTION]: (input) => {
        writeConfigEditorValue(target, input.fieldId, input.value);
      },
      [KXM_TUI_CLEAR_ACTION]: (input) => {
        clearConfigEditorValue(target, input.fieldId);
      },
    },
    describeError: (error) => (error instanceof Error && error.message ? error.message : "config edit failed"),
  };
}

function scopeFile(target: KxmConfigEditorTarget): string {
  return kxmConfigFileForScope(target.cwd, target.scope, target.userConfigDir);
}

function scopePhrase(scope: KxmConfigEditorScope): string {
  return scope === "project" ? "the project file .kxm/config.yaml" : "the user file config.yaml";
}

function listConfigEditorSections(target: KxmConfigEditorTarget): KxmTuiSectionView[] {
  const config = loadKxmConfig(target.cwd, target.userConfigDir === undefined ? {} : { userConfigDir: target.userConfigDir });
  const owned = readScopeDocument(scopeFile(target));
  const where = scopePhrase(target.scope);
  return SECTIONS.map((section) => ({
    source: KXM_CONFIG_EDITOR_SOURCE,
    id: section.id,
    title: section.title,
    order: section.order,
    detail: `kxm.config.v1 · ${target.scope} scope. Re-read from disk after each write.`,
    fields: section.fields.map((field) => publishField(field, config, owned, where)),
  }));
}

function publishField(
  field: ConfigEditorFieldSpec,
  config: KxmResolvedConfig,
  owned: Record<string, unknown> | undefined,
  where: string,
): KxmTuiField {
  const effective = getKxmConfigValue(config, field.keyPath);
  const stored = ownValue(owned, field.keyPath);
  const shown = displayScalar(effective);
  const inherited = !stored.present;
  const unsupported = stored.present && !sameScalar(stored.value, effective);
  const detail = [
    `Writes ${where}.`,
    inherited ? "Shown value is inherited." : "This scope sets the value.",
    "Clear removes only this scope's override.",
    field.note ?? "",
    unsupported ? "Stored value is unsupported; showing the effective value." : "",
  ].filter((part) => part.length > 0).join(" ");
  const choices = field.spec.kind === "enum"
    ? field.spec.choices.map((choice) => ({ id: choice, label: choice }))
    : undefined;
  return {
    id: field.id,
    label: field.label,
    kind: field.spec.kind === "enum" ? "enum" : "text",
    keyPath: field.keyPath,
    detail,
    status: "ready",
    ...(shown === undefined ? {} : { value: shown }),
    ...(choices === undefined ? {} : { choices }),
    ...(unsupported ? { statusText: "stored value is not a supported scalar" } : {}),
  };
}

function displayScalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function sameScalar(stored: unknown, effective: unknown): boolean {
  if (typeof stored === "boolean" || typeof stored === "number") return stored === effective;
  if (typeof stored === "string") return stored === effective || stored === displayScalar(effective);
  return false;
}

function writeConfigEditorValue(target: KxmConfigEditorTarget, fieldId: string, raw: string | undefined): void {
  const field = requireField(fieldId);
  const value = parseEditorValue(field, raw);
  setKxmConfigValue(target.cwd, field.keyPath, value, {
    scope: target.scope,
    ...(target.userConfigDir === undefined ? {} : { userConfigDir: target.userConfigDir }),
  });
}

function clearConfigEditorValue(target: KxmConfigEditorTarget, fieldId: string): void {
  const field = requireField(fieldId);
  deleteKxmConfigValue(target.cwd, field.keyPath, {
    scope: target.scope,
    ...(target.userConfigDir === undefined ? {} : { userConfigDir: target.userConfigDir }),
  });
}

function requireField(fieldId: string): ConfigEditorFieldSpec {
  const field = FIELDS.get(fieldId);
  if (!field) throw new KxmConfigEditorError("unknown configuration field");
  return field;
}

function parseEditorValue(field: ConfigEditorFieldSpec, raw: string | undefined): string | number | boolean {
  if (raw === undefined) throw new KxmConfigEditorError("a value is required");
  if (raw.length === 0 || raw.length > 128 || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new KxmConfigEditorError("value must be a single bounded line");
  }
  if (field.spec.kind === "enum") {
    if (!field.spec.choices.includes(raw)) throw new KxmConfigEditorError("value is not a supported choice");
    if (field.spec.choices.length === 2 && field.spec.choices[0] === "true" && field.spec.choices[1] === "false") return raw === "true";
    return raw;
  }
  if (field.spec.kind === "text") {
    if (!TEXT_VALUE.test(raw)) throw new KxmConfigEditorError("value must be a single bounded line");
    return raw;
  }
  if (!(field.spec.integer ? INTEGER_TEXT : DECIMAL_TEXT).test(raw)) {
    throw new KxmConfigEditorError("value must be a finite number in range");
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || (field.spec.integer && !Number.isInteger(parsed)) || parsed < field.spec.min || parsed > field.spec.max) {
    throw new KxmConfigEditorError("value must be a finite number in range");
  }
  return parsed;
}

function readScopeDocument(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  const parsed = parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KxmConfigEditorError(`config file ${file} must be a mapping`);
  }
  return parsed as Record<string, unknown>;
}

function ownValue(root: Record<string, unknown> | undefined, keyPath: string): { present: boolean; value: unknown } {
  if (!root) return { present: false, value: undefined };
  let cursor: unknown = root;
  for (const part of keyPath.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return { present: false, value: undefined };
    const record = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, part)) return { present: false, value: undefined };
    cursor = record[part];
  }
  return { present: true, value: cursor };
}

const EDITOR_HELP = [
  "↑↓ move · enter edits · x clears this scope's override · q quits",
  "Writes are checked, saved, then re-read. A refused edit leaves the file unchanged.",
] as const;

const FRAME_NOW_MS = Date.UTC(2026, 9, 11);

export async function runKxmConfigEditor(input: {
  readonly target: KxmConfigEditorTarget;
  readonly stdout: (text: string) => void;
  readonly isTty: boolean;
  readonly dryRun: boolean;
}): Promise<number> {
  const registry = createKxmTuiRegistry();
  try {
    registry.register(createKxmConfigEditorContribution(input.target));
    registry.getSections();
    const failed = registry.getIssues()[0];
    if (failed) throw new KxmConfigEditorError(failed.message);
    const interactive = input.isTty && !input.dryRun;
    return await runKxmTuiPanel({
      registry,
      title: "KXM configuration",
      breadcrumb: `kxm.config.v1 · ${input.target.scope} scope`,
      helpLines: EDITOR_HELP,
      stdout: input.stdout,
      isTty: interactive,
      theme: interactive ? undefined : createPlainKxmTuiTheme(),
      now: () => FRAME_NOW_MS,
    });
  } finally {
    registry.dispose();
  }
}

interface ConfigPanelUi {
  notify?: ((message: string, type?: string) => void) | undefined;
  custom?: ((
    factory: (
      tui: { requestRender(): void },
      theme: { fg(token: string, text: string): string; bg(token: string, text: string): string },
      keybindings: unknown,
      done: (result: undefined) => void,
    ) => { render(width: number): string[]; handleInput(data: string): void; invalidate(): void },
  ) => Promise<unknown>) | undefined;
}

/** Mount the project-scope editor on Pi's generic custom panel. */
export async function openKxmProjectConfigPanel(
  ui: { notify?: (message: string, type?: string) => void; custom?: unknown },
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (typeof ui.custom !== "function") {
    ui.notify?.(
      "kxm: /kxm config needs Pi's custom panel. Open the repository in the Pi TUI, or run kxm config edit --scope project",
      "warning",
    );
    return;
  }
  const custom = ui.custom as NonNullable<ConfigPanelUi["custom"]>;
  const registry = createKxmTuiRegistry();
  const userConfigDir = userConfigDirForEnv(env);
  try {
    registry.register(createKxmConfigEditorContribution({
      cwd,
      scope: "project",
      ...(userConfigDir === undefined ? {} : { userConfigDir }),
    }));
    await custom((tui, theme, _keybindings, done) => createKxmTuiPiPanel({
      registry,
      tui,
      theme,
      title: "KXM configuration",
      breadcrumb: "kxm.config.v1 · project scope",
      helpLines: EDITOR_HELP,
      done: () => {
        registry.dispose();
        done(undefined);
      },
    }));
  } finally {
    registry.dispose();
  }
}
