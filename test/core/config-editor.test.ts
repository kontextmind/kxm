import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { KXM_TUI_CLEAR_ACTION, KXM_TUI_SET_ACTION, createKxmTuiRegistry } from "@kontextmind/tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";
import {
  KXM_CONFIG_EDITOR_SOURCE,
  createKxmConfigEditorContribution,
  openKxmProjectConfigPanel,
  type KxmConfigEditorTarget,
} from "../../plugins/kxm/src/config-editor.ts";
import piMeshExtension from "../../plugins/kxm/src/extension.ts";

function sandbox(): { root: string; project: string; user: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "kxm-config-editor-"));
  const project = join(root, "project");
  const user = join(root, "user");
  return { root, project, user, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function target(project: string, user: string, scope: "project" | "user"): KxmConfigEditorTarget {
  return { cwd: project, scope, userConfigDir: user };
}

function projectFile(project: string): string {
  return join(project, ".kxm", "config.yaml");
}

function userFile(user: string): string {
  return join(user, "config.yaml");
}

function writeYaml(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

function fieldValue(project: string, user: string, scope: "project" | "user", sectionId: string, fieldId: string): {
  value?: string;
  statusText?: string;
  keyPath?: string;
} {
  const registry = createKxmTuiRegistry();
  registry.register(createKxmConfigEditorContribution(target(project, user, scope)));
  const sections = registry.getSections();
  const issues = registry.getIssues();
  assert.deepEqual(issues, [], issues[0]?.message ?? "");
  const field = sections
    .find((section) => section.id === sectionId)
    ?.fields.find((item) => item.id === fieldId);
  assert.ok(field, `${sectionId}/${fieldId}`);
  registry.dispose();
  return {
    ...(field.value === undefined ? {} : { value: field.value }),
    ...(field.statusText === undefined ? {} : { statusText: field.statusText }),
    ...(field.keyPath === undefined ? {} : { keyPath: field.keyPath }),
  };
}

async function invoke(
  project: string,
  user: string,
  scope: "project" | "user",
  sectionId: string,
  fieldId: string,
  action: string,
  value?: string,
): Promise<{ ok: boolean; message?: string }> {
  const registry = createKxmTuiRegistry();
  registry.register(createKxmConfigEditorContribution(target(project, user, scope)));
  const result = await registry.invoke({
    source: KXM_CONFIG_EDITOR_SOURCE,
    sectionId,
    fieldId,
    action,
    ...(value === undefined ? {} : { value }),
  });
  registry.dispose();
  return result;
}

function capture(): CliIo & { read: () => { stdout: string; stderr: string } } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

async function cli(argv: string[], project: string, user: string, tty = false): Promise<{ code: number; stdout: string; stderr: string }> {
  const previousIn = process.stdin.isTTY;
  const previousOut = process.stdout.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = tty;
  (process.stdout as { isTTY?: boolean }).isTTY = tty;
  const io = capture();
  try {
    const code = await runCli(argv, {
      KXM_USER_CONFIG_DIR: user,
      KXM_STATE_HOME: join(project, "state"),
      KXM_LOGS_DIR: join(project, "logs"),
      PATH: process.env.PATH,
    }, io, project);
    return { code, ...io.read() };
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = previousIn;
    (process.stdout as { isTTY?: boolean }).isTTY = previousOut;
  }
}

test("accepted set persists and the republished value is the one re-read from disk", async () => {
  const box = sandbox();
  try {
    const written = await invoke(box.project, box.user, "project", "user", "user-theme", KXM_TUI_SET_ACTION, "light");
    assert.equal(written.ok, true, written.message ?? "");
    const file = projectFile(box.project);
    assert.equal((parse(readFileSync(file, "utf8")) as { user: { theme: string } }).user.theme, "light");
    assert.equal(fieldValue(box.project, box.user, "project", "user", "user-theme").value, "light");
    writeYaml(file, "user:\n  theme: minimal\n");
    assert.equal(fieldValue(box.project, box.user, "project", "user", "user-theme").value, "minimal");
  } finally {
    box.cleanup();
  }
});

test("a rejected value and a wrong section/field pair leave the file bytes unchanged", async () => {
  const box = sandbox();
  try {
    const file = projectFile(box.project);
    const original = "# keep-bytes\nuser:\n  theme: dark\n";
    writeYaml(file, original);
    const before = readFileSync(file);
    const rejected = await invoke(box.project, box.user, "project", "user", "user-theme", KXM_TUI_SET_ACTION, "neon");
    assert.equal(rejected.ok, false);
    assert.match(rejected.message ?? "", /not a supported choice/);
    assert.deepEqual(readFileSync(file), before);
    const wrongPair = await invoke(box.project, box.user, "project", "user", "defaults-workflow", KXM_TUI_SET_ACTION, "review");
    assert.equal(wrongPair.ok, false);
    assert.match(wrongPair.message ?? "", /unknown configuration field/);
    const wrongClear = await invoke(box.project, box.user, "project", "defaults", "user-theme", KXM_TUI_CLEAR_ACTION);
    assert.equal(wrongClear.ok, false);
    assert.deepEqual(readFileSync(file), before);
    const shown = fieldValue(box.project, box.user, "project", "user", "user-theme");
    assert.equal(shown.value, "dark");
    assert.equal(shown.statusText, undefined);
  } finally {
    box.cleanup();
  }
});

test("project clear reveals the user value and user clear reveals the built-in value", async () => {
  const box = sandbox();
  try {
    writeYaml(userFile(box.user), "user:\n  theme: light\n");
    writeYaml(projectFile(box.project), "user:\n  theme: minimal\n");
    assert.equal(fieldValue(box.project, box.user, "project", "user", "user-theme").value, "minimal");
    assert.equal(fieldValue(box.project, box.user, "user", "user", "user-theme").value, "light");
    const projectClear = await invoke(box.project, box.user, "project", "user", "user-theme", KXM_TUI_CLEAR_ACTION);
    assert.equal(projectClear.ok, true, projectClear.message ?? "");
    assert.equal(fieldValue(box.project, box.user, "project", "user", "user-theme").value, "light");
    assert.match(readFileSync(userFile(box.user), "utf8"), /light/);

    writeYaml(projectFile(box.project), "user:\n  theme: minimal\n");
    const userClear = await invoke(box.project, box.user, "user", "user", "user-theme", KXM_TUI_CLEAR_ACTION);
    assert.equal(userClear.ok, true, userClear.message ?? "");
    assert.equal(fieldValue(box.project, box.user, "user", "user", "user-theme").value, "dark");
    assert.match(readFileSync(projectFile(box.project), "utf8"), /minimal/);
    assert.equal(fieldValue(box.project, box.user, "project", "user", "user-theme").value, "minimal");
  } finally {
    box.cleanup();
  }
});

test("a stored scalar whose runtime type does not match the field is diagnosed", async () => {
  const box = sandbox();
  try {
    writeYaml(projectFile(box.project), "user:\n  theme: true\ndash:\n  autoOpen: \"true\"\n");
    const theme = fieldValue(box.project, box.user, "project", "user", "user-theme");
    assert.equal(theme.value, "true");
    assert.match(theme.statusText ?? "", /stored type does not match this field/);
    const shown = fieldValue(box.project, box.user, "project", "dash", "dash-auto-open");
    assert.equal(shown.value, "true");
    assert.match(shown.statusText ?? "", /stored type does not match this field/);
    const frame = await cli(["config", "edit", "--scope", "project"], box.project, box.user);
    assert.equal(frame.code, 0, frame.stderr);
    assert.match(frame.stdout, /stored type does not match this field/);
  } finally {
    box.cleanup();
  }
});

test("workflow and harness ids accept @ and refuse whitespace and control characters", async () => {
  const box = sandbox();
  try {
    const file = projectFile(box.project);
    writeYaml(file, "defaults:\n  workflow: review\n");
    const accepted = await invoke(
      box.project,
      box.user,
      "project",
      "defaults",
      "defaults-workflow",
      KXM_TUI_SET_ACTION,
      "@scope/feature",
    );
    assert.equal(accepted.ok, true, accepted.message ?? "");
    assert.equal(fieldValue(box.project, box.user, "project", "defaults", "defaults-workflow").value, "@scope/feature");
    const harness = await invoke(
      box.project,
      box.user,
      "project",
      "defaults",
      "defaults-harness",
      KXM_TUI_SET_ACTION,
      "team@pi",
    );
    assert.equal(harness.ok, true, harness.message ?? "");
    const before = readFileSync(file);
    for (const raw of ["bad id", "bad\nid", "bad\u0001id"]) {
      const refused = await invoke(box.project, box.user, "project", "defaults", "defaults-workflow", KXM_TUI_SET_ACTION, raw);
      assert.equal(refused.ok, false, raw);
      assert.deepEqual(readFileSync(file), before);
    }
  } finally {
    box.cleanup();
  }
});

test("published key paths stay on scalar preferences", () => {
  const box = sandbox();
  try {
    const registry = createKxmTuiRegistry();
    registry.register(createKxmConfigEditorContribution(target(box.project, box.user, "project")));
    const fields = registry.getSections().flatMap((section) => section.fields);
    assert.ok(fields.length > 0);
    const paths = fields.map((field) => field.keyPath ?? "");
    assert.ok(paths.includes("user.theme"));
    assert.ok(paths.includes("defaults.workflow"));
    assert.ok(paths.includes("hub.autoStart"));
    for (const field of fields) {
      assert.ok(field.kind === "text" || field.kind === "enum");
      assert.equal(field.value === undefined || typeof field.value === "string", true);
      assert.doesNotMatch(field.keyPath ?? "", /(^|\.)(key|secret|password|credential|endpoint|url)(\.|$)/i);
      assert.doesNotMatch(field.keyPath ?? "", /preferredCritics|candidateModels|github|jira|projects|roles|routes|gates|roster/);
    }
    assert.equal(paths.some((path) => path.startsWith("hub.") && path !== "hub.autoStart"), false);
    registry.dispose();
  } finally {
    box.cleanup();
  }
});

test("config edit renders without writing for a non-TTY and a dry run, and get/set/list still work", async () => {
  const box = sandbox();
  try {
    const file = projectFile(box.project);
    writeYaml(file, "# keep-bytes\nuser:\n  theme: dark\n");
    const before = readFileSync(file);
    const frame = await cli(["config", "edit", "--scope", "project"], box.project, box.user);
    assert.equal(frame.code, 0, frame.stderr);
    assert.match(frame.stdout, /Theme/);
    assert.doesNotMatch(frame.stdout, /\u001b/);
    assert.deepEqual(readFileSync(file), before);
    const dry = await cli(["config", "edit", "--scope", "user", "--dry-run"], box.project, box.user, true);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Theme/);
    assert.equal(readFileSync(file, "utf8").includes("keep-bytes"), true);
    const missingScope = await cli(["config", "edit"], box.project, box.user);
    assert.equal(missingScope.code, 2);
    assert.match(missingScope.stderr, /config edit requires --scope/);
    const badScope = await cli(["config", "edit", "--scope", "workspace"], box.project, box.user);
    assert.equal(badScope.code, 2);
    const json = await cli(["config", "edit", "--scope", "project", "--json"], box.project, box.user);
    assert.equal(json.code, 2);
    assert.match(json.stderr, /machine-readable/);
    assert.deepEqual(readFileSync(file), before);
    const set = await cli(["config", "set", "user.theme", "light", "--scope", "project"], box.project, box.user);
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /Set user\.theme = light/);
    const get = await cli(["config", "get", "user.theme"], box.project, box.user);
    assert.equal(get.code, 0, get.stderr);
    assert.match(get.stdout, /light/);
    const list = await cli(["config", "list"], box.project, box.user);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /theme: light/);
  } finally {
    box.cleanup();
  }
});

test("/kxm config mounts the custom panel only in tui mode", async () => {
  const box = sandbox();
  const previous = process.env.KXM_USER_CONFIG_DIR;
  process.env.KXM_USER_CONFIG_DIR = box.user;
  try {
    writeYaml(projectFile(box.project), "# keep-bytes\nuser:\n  theme: dark\n");
    const before = readFileSync(projectFile(box.project));
    const fake = fakePi();
    piMeshExtension(fake.api);
    const handler = fake.commands.get("kxm")?.handler;
    assert.equal(typeof handler, "function");
    for (const mode of ["rpc", "json", "print"]) {
      const ui = recordingUi();
      await handler!("config", { cwd: box.project, mode, ui: ui.ui });
      assert.equal(ui.customCalls, 0, mode);
      assert.equal(ui.notices.some((notice) => notice.type === "warning" && /Nothing was written/.test(notice.message)), true, mode);
    }
    assert.deepEqual(readFileSync(projectFile(box.project)), before);
    const tui = recordingUi();
    await handler!("config", { cwd: box.project, mode: "tui", ui: tui.ui });
    assert.equal(tui.customCalls, 1);
    assert.equal(tui.overlay, true);
    assert.match(tui.rendered, /Theme/);
    assert.equal(tui.closed, true);
    assert.deepEqual(readFileSync(projectFile(box.project)), before);
  } finally {
    if (previous === undefined) delete process.env.KXM_USER_CONFIG_DIR;
    else process.env.KXM_USER_CONFIG_DIR = previous;
    box.cleanup();
  }
});

interface RecordingUi {
  ui: {
    notify: (message: string, type?: string) => void;
    custom: (factory: (...args: unknown[]) => unknown, options?: { overlay?: boolean }) => Promise<void>;
  };
  notices: Array<{ message: string; type?: string }>;
  customCalls: number;
  rendered: string;
  closed: boolean;
  overlay: boolean | undefined;
}

function recordingUi(): RecordingUi {
  const notices: Array<{ message: string; type?: string }> = [];
  const result: RecordingUi = {
    notices,
    customCalls: 0,
    rendered: "",
    closed: false,
    overlay: undefined,
    ui: {
      notify(message: string, type?: string) {
        notices.push({ message, ...(type === undefined ? {} : { type }) });
      },
      async custom(factory, options) {
        result.customCalls += 1;
        result.overlay = options?.overlay;
        const component = factory(
          { requestRender() { return undefined; } },
          { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
          {},
          () => { result.closed = true; },
        ) as { render(width: number): string[]; handleInput(data: string): void };
        result.rendered = component.render(100).join("\n");
        component.handleInput("q");
      },
    },
  };
  return result;
}

function fakePi(): { api: ExtensionAPI; commands: Map<string, { handler: (...args: unknown[]) => unknown }> } {
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const api = {
    on() { return undefined; },
    registerTool() { return undefined; },
    registerCommand(name: string, command: { handler: (...args: unknown[]) => unknown }) {
      commands.set(name, command);
    },
    sendMessage() { return undefined; },
    getSessionName() { return "config-editor-test"; },
  } as unknown as ExtensionAPI;
  return { api, commands };
}
