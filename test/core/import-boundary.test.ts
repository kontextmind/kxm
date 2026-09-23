import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { redactSecrets } from "../../plugins/kxm/src/core.ts";
import { kxmRuntimePaths } from "../../plugins/kxm/src/runtime.ts";
import { API } from "typescript/unstable/sync";
import type { Node } from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";
import { visitEachChild } from "typescript/unstable/ast/visitor";

const { GENERATED_ARTIFACTS } = await import(
  pathToFileURL(resolve("scripts/check-generated.mjs")).href,
) as { GENERATED_ARTIFACTS: readonly string[] };

const SRC_ROOT = resolve("plugins/kxm/src");
const MJS_TSCONFIG = resolve("tsconfig.mjs.json");
const PROBE_ROOT = resolve("test/fixtures/import-boundary");
const MJS_PROBE = resolve(PROBE_ROOT, "mjs-probe.mjs");
const DECOY_SPECIFIERS = [
  "comment-string-not-imported",
  "from-string-not-imported",
  "line-comment-not-imported",
  "block-comment-not-imported",
];
const SURFACE_FILES = [
  resolve(SRC_ROOT, "extension.ts"),
  resolve(SRC_ROOT, "mcp-server.ts"),
  resolve(SRC_ROOT, "claude-hook.ts"),
];
const LIBRARY_BARRELS = [
  resolve(SRC_ROOT, "core.ts"),
  resolve(SRC_ROOT, "runtime.ts"),
  resolve(SRC_ROOT, "client.ts"),
];
const NAMED_FAMILY_SEEDS = [
  resolve(SRC_ROOT, "harness.ts"),
  resolve(SRC_ROOT, "routing.ts"),
  resolve(SRC_ROOT, "envelope.ts"),
  resolve(SRC_ROOT, "redact.ts"),
];
const BANNED_SURFACE = new Set(["hub.ts", "store.ts", "workflow.ts"]);
const PI_PREFIXES = ["commander", "@earendil-works/pi-tui", "@earendil-works/pi-coding-agent"];
const EXPORT_KEYS = ["./core", "./runtime", "./client", "./tui", "./extension", "./mcp", "./package.json"];
const LIBRARY_BUNDLES = [
  "packages/core/tui/dist/index.js",
  "plugins/kxm/dist/core.js",
  "plugins/kxm/dist/runtime.js",
  "plugins/kxm/dist/client.js",
  "plugins/kxm/dist/extension.js",
];
const PACKED_LIBRARY_PATHS = [
  "plugins/kxm/dist/core.js",
  "plugins/kxm/dist/runtime.js",
  "plugins/kxm/dist/client.js",
  "plugins/kxm/dist/extension.js",
  "packages/core/tui/src/exports/index.ts",
  "plugins/kxm/src/core.ts",
  "plugins/kxm/src/runtime.ts",
  "plugins/kxm/src/restricted-yaml.mjs",
  "plugins/kxm/src/restricted-yaml.d.mts",
  "plugins/kxm/src/policy-draft.mjs",
  "plugins/kxm/src/policy-draft.d.mts",
  "schemas/policy-draft/model.v2.schema.json",
  "schemas/policy-draft/role.v2.schema.json",
];

interface ModuleEdge {
  from: string;
  specifier: string;
  isTypeOnly: boolean;
  kind: "import" | "export" | "dynamic-import" | "import-type";
}

function literalText(node: { text?: string; literal?: { text?: string } } | undefined): string | undefined {
  if (!node) return undefined;
  if (typeof node.text === "string") return node.text;
  if (typeof node.literal?.text === "string") return node.literal.text;
  return undefined;
}

function importIsTypeOnly(node: {
  importClause?: {
    isTypeOnly?: boolean;
    name?: unknown;
    namedBindings?: { name?: unknown; elements?: Array<{ isTypeOnly?: boolean }> };
  };
}): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const named = clause.namedBindings;
  if (!named) return true;
  if (named.name && !named.elements) return false;
  const elements = named.elements ?? [];
  return elements.length > 0 && elements.every((element) => element.isTypeOnly === true);
}

function collectEdges(fileName: string, sourceFile: Node): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  const visit = (node: Node): void => {
    const candidate = node as Node & {
      moduleSpecifier?: { text?: string };
      importClause?: {
        isTypeOnly?: boolean;
        name?: unknown;
        namedBindings?: { name?: unknown; elements?: Array<{ isTypeOnly?: boolean }> };
      };
      isTypeOnly?: boolean;
      expression?: Node;
      arguments?: Array<{ text?: string; literal?: { text?: string } }>;
      argument?: { text?: string; literal?: { text?: string } };
    };
    if (is.isImportDeclaration(node) && candidate.moduleSpecifier?.text) {
      edges.push({
        from: fileName,
        specifier: candidate.moduleSpecifier.text,
        isTypeOnly: importIsTypeOnly(candidate),
        kind: "import",
      });
    } else if (is.isExportDeclaration(node) && candidate.moduleSpecifier?.text) {
      edges.push({
        from: fileName,
        specifier: candidate.moduleSpecifier.text,
        isTypeOnly: candidate.isTypeOnly === true,
        kind: "export",
      });
    } else if (is.isImportTypeNode(node)) {
      const specifier = literalText(candidate.argument);
      if (specifier) {
        edges.push({ from: fileName, specifier, isTypeOnly: true, kind: "import-type" });
      }
    } else if (is.isCallExpression(node) && candidate.expression && is.isImportExpression(candidate.expression)) {
      const specifier = literalText(candidate.arguments?.[0]);
      if (specifier) {
        edges.push({ from: fileName, specifier, isTypeOnly: false, kind: "dynamic-import" });
      }
    }
    visitEachChild(node, (child) => {
      visit(child);
      return child;
    });
  };
  visit(sourceFile);
  return edges;
}

function resolveSpecifier(fromFile: string, specifier: string): { kind: "local"; path: string } | { kind: "external"; specifier: string } {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return { kind: "local", path: resolve(dirname(fromFile), specifier) };
  }
  return { kind: "external", specifier };
}

function startsWithBannedPi(specifier: string): string | undefined {
  return PI_PREFIXES.find((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

function isUnder(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

function isBoundarySource(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".mjs");
}

function ingestProject(edges: Map<string, ModuleEdge[]>, project: { program: { getSourceFileNames(): readonly string[]; getSourceFile(file: string): unknown } }): void {
  for (const fileName of project.program.getSourceFileNames()) {
    const resolved = resolve(fileName);
    if (!isUnder(SRC_ROOT, resolved) && !isUnder(PROBE_ROOT, resolved)) continue;
    if (!isBoundarySource(resolved)) continue;
    const sourceFile = project.program.getSourceFile(fileName);
    if (!sourceFile) continue;
    edges.set(resolved, collectEdges(resolved, sourceFile as Node));
  }
}

function surfaceModuleName(path: string): string | undefined {
  const name = basename(path);
  return BANNED_SURFACE.has(name) ? name.replace(/\.ts$/, "") : undefined;
}

function runNpm(args: string[], cwd: string) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
  }
  return spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

function packFilenames(cwd: string): string[] {
  const packed = runNpm(["pack", "--dry-run", "--json"], cwd);
  assert.equal(packed.status, 0, `${packed.stderr}\n${packed.stdout}`);
  const artifacts = JSON.parse(packed.stdout) as Array<{ files?: Array<{ path: string }> }>;
  assert.equal(artifacts.length, 1);
  return (artifacts[0]?.files ?? []).map((file) => file.path).sort();
}

let graphCache: Map<string, ModuleEdge[]> | undefined;

function loadGraph(): Map<string, ModuleEdge[]> {
  if (graphCache) return graphCache;
  const api = new API({ cwd: process.cwd() });
  try {
    const tsconfig = resolve("tsconfig.json");
    const snapshot = api.updateSnapshot({ openProjects: [tsconfig, MJS_TSCONFIG] });
    const tsProject = snapshot.getProject(tsconfig);
    const jsProject = snapshot.getProject(MJS_TSCONFIG);
    assert.ok(tsProject, "tsconfig project did not load");
    assert.ok(jsProject, "allowJs mjs project did not load");
    const edges = new Map<string, ModuleEdge[]>();
    ingestProject(edges, tsProject);
    ingestProject(edges, jsProject);
    graphCache = edges;
    return edges;
  } finally {
    api.close();
  }
}

function walkClosure(
  entries: string[],
  graph: Map<string, ModuleEdge[]>,
  valueOnly: boolean,
): { files: Set<string>; edges: ModuleEdge[] } {
  const files = new Set<string>();
  const seenEdges: ModuleEdge[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const edges = graph.get(file);
    assert.ok(edges, `no parsed AST for local module ${file}; boundary closure is incomplete`);
    for (const edge of edges) {
      if (valueOnly && edge.isTypeOnly) continue;
      seenEdges.push(edge);
      const resolved = resolveSpecifier(file, edge.specifier);
      if (resolved.kind === "local" && !files.has(resolved.path)) queue.push(resolved.path);
    }
  }
  return { files, edges: seenEdges };
}

function libraryEntries(graph: Map<string, ModuleEdge[]>): string[] {
  const family = [...graph.keys()].filter((file) => basename(file).startsWith("kxm-runtime"));
  return [...new Set([...LIBRARY_BARRELS, ...family, ...NAMED_FAMILY_SEEDS])];
}

test("boundary parser collects every edge kind it relies on", () => {
  const graph = loadGraph();
  const clientEdges = graph.get(resolve(SRC_ROOT, "client.ts")) ?? [];
  assert.ok(clientEdges.some((e) => e.kind === "import" && !e.isTypeOnly && e.specifier === "./workflow.ts"));
  const workflowEdges = graph.get(resolve(SRC_ROOT, "workflow.ts")) ?? [];
  assert.ok(workflowEdges.some((e) => e.kind === "export" && e.isTypeOnly && e.specifier === "./protocol.ts"));
  const telemetryEdges = graph.get(resolve(SRC_ROOT, "telemetry.ts")) ?? [];
  assert.ok(telemetryEdges.some((e) => e.kind === "import-type" && e.specifier === "./routing.ts"));
  const { files, edges } = walkClosure(LIBRARY_BARRELS, graph, false);
  assert.ok(files.has(resolve(SRC_ROOT, "harness.ts")));
  assert.ok(files.has(resolve(SRC_ROOT, "restricted-yaml.mjs")));
  assert.ok(graph.has(resolve(SRC_ROOT, "restricted-yaml.mjs")));
  assert.ok(graph.has(resolve(SRC_ROOT, "policy-draft.mjs")));
  assert.ok(edges.some((e) => e.from === resolve(SRC_ROOT, "restricted-yaml.mjs") && e.kind === "import" && e.specifier === "yaml"));
});

test("boundary closure fails closed when a local module has no AST", () => {
  const from = resolve(SRC_ROOT, "client.ts");
  const missing = resolve(SRC_ROOT, "does-not-exist.ts");
  const graph = new Map<string, ModuleEdge[]>([
    [from, [{ from, specifier: "./does-not-exist.ts", isTypeOnly: false, kind: "import" }]],
  ]);
  assert.throws(
    () => walkClosure([from], graph, false),
    (error: unknown) => error instanceof assert.AssertionError
      && error.message.includes(`no parsed AST for local module ${missing}`),
  );
});

test("mjs modules contribute real AST edges including literal dynamic imports", () => {
  const graph = loadGraph();
  const yamlModule = resolve(SRC_ROOT, "restricted-yaml.mjs");
  const yamlEdges = graph.get(yamlModule);
  assert.ok(yamlEdges, "restricted-yaml.mjs must have a JS AST, not a regex fallback");
  assert.deepEqual(yamlEdges.filter((edge) => !edge.isTypeOnly).map((edge) => ({ kind: edge.kind, specifier: edge.specifier })), [
    { kind: "import", specifier: "yaml" },
  ]);

  const probeEdges = graph.get(MJS_PROBE);
  assert.ok(probeEdges, "mjs probe must be parsed through the allowJs project");
  assert.ok(probeEdges.some((e) => e.kind === "import" && e.specifier.endsWith("/restricted-yaml.mjs")));
  assert.ok(probeEdges.some((e) => e.kind === "import" && e.specifier === "./side-effect.mjs"));
  assert.ok(probeEdges.some((e) => e.kind === "export" && e.specifier === "./reexport-target.mjs"));
  assert.ok(probeEdges.some((e) => e.kind === "dynamic-import" && e.specifier === "./dynamic-local.mjs"));
  assert.ok(probeEdges.some((e) => e.kind === "dynamic-import" && e.specifier === "commander"));
  for (const decoy of DECOY_SPECIFIERS) {
    assert.equal(probeEdges.some((e) => e.specifier === decoy), false, `comment/string decoy treated as import: ${decoy}`);
  }

  const { files, edges } = walkClosure([MJS_PROBE], graph, false);
  assert.ok(files.has(yamlModule));
  assert.ok(files.has(resolve(PROBE_ROOT, "side-effect.mjs")));
  assert.ok(files.has(resolve(PROBE_ROOT, "reexport-target.mjs")));
  assert.ok(files.has(resolve(PROBE_ROOT, "dynamic-local.mjs")));
  const banned = edges.find((e) => e.kind === "dynamic-import" && startsWithBannedPi(e.specifier));
  assert.ok(banned, "literal dynamic import of a banned Pi package must be visible to the import boundary");
  assert.equal(banned.specifier, "commander");
  assert.equal(banned.from, MJS_PROBE);
});

test("extension and mcp never import hub, store, or workflow, including type-only", () => {
  const graph = loadGraph();
  for (const file of SURFACE_FILES) {
    assert.ok(graph.has(file), `missing AST for ${file}`);
    for (const edge of graph.get(file) ?? []) {
      const resolved = resolveSpecifier(file, edge.specifier);
      if (resolved.kind !== "local") continue;
      const banned = surfaceModuleName(resolved.path);
      if (!banned) continue;
      const qualifier = edge.isTypeOnly ? "type-only " : "";
      assert.fail(`${file} has a direct ${qualifier}${edge.kind} of ${banned} via ${edge.specifier}; type-only imports are still direct imports`);
    }
  }

  for (const file of SURFACE_FILES) {
    const { files } = walkClosure([file], graph, true);
    for (const reached of files) {
      const banned = surfaceModuleName(reached);
      assert.notEqual(banned, "hub", `${file} has a transitive value path to hub`);
      assert.notEqual(banned, "store", `${file} has a transitive value path to store`);
    }
  }
});

test("core, runtime, and client closures do not import Pi or commander", () => {
  const graph = loadGraph();
  const entries = libraryEntries(graph);
  const { files, edges } = walkClosure(entries, graph, false);
  for (const entry of entries) {
    assert.ok(files.has(entry), `family seed missing from closure: ${entry}`);
  }
  for (const edge of edges) {
    const banned = startsWithBannedPi(edge.specifier);
    assert.equal(banned, undefined, `${edge.from} imports banned ${edge.specifier}`);
  }
});

test("package seams export compiled dist targets without a bare root or types condition", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    exports?: Record<string, unknown>;
    files?: string[];
    pi?: { extensions?: string[] };
  };
  const exportsMap = pkg.exports ?? {};
  assert.deepEqual(Object.keys(exportsMap).sort(), [...EXPORT_KEYS].sort());
  assert.equal("." in exportsMap, false);
  const expectedTargets: Record<string, string> = {
    "./core": "./plugins/kxm/dist/core.js",
    "./runtime": "./plugins/kxm/dist/runtime.js",
    "./client": "./plugins/kxm/dist/client.js",
    "./tui": "./packages/core/tui/dist/index.js",
    "./extension": "./plugins/kxm/dist/extension.js",
    "./mcp": "./plugins/kxm/dist/mcp-server.js",
    "./package.json": "./package.json",
  };
  for (const key of EXPORT_KEYS) {
    const target = exportsMap[key];
    assert.equal(typeof target, "string", `${key} must be a compiled path, not a condition map`);
    assert.equal(target, expectedTargets[key]);
  }
  assert.ok(pkg.files?.includes("plugins/kxm/dist"));
  assert.ok(pkg.files?.includes("plugins/kxm/src"));
  assert.deepEqual(pkg.pi?.extensions, ["./plugins/kxm/src/extension.ts"]);
  for (const artifact of LIBRARY_BUNDLES) {
    assert.ok(GENERATED_ARTIFACTS.includes(artifact), `${artifact} missing from GENERATED_ARTIFACTS`);
    assert.equal(existsSync(artifact), true, `${artifact} was not built`);
  }
});

test("packed artifact includes the four library bundles and two barrel sources", () => {
  const current = new Set(packFilenames(process.cwd()));
  for (const path of PACKED_LIBRARY_PATHS) {
    assert.ok(current.has(path), `packed artifact missing ${path}`);
  }
});

test("library bundles are ESM files without a shebang", () => {
  assert.equal(typeof redactSecrets, "function");
  assert.equal(typeof kxmRuntimePaths, "function");
  for (const artifact of LIBRARY_BUNDLES) {
    const text = readFileSync(artifact, "utf8");
    assert.equal(text.startsWith("#!/usr/bin/env node"), false, `${artifact} must not be an executable shebang bundle`);
  }
  const mcp = readFileSync("plugins/kxm/dist/mcp-server.js", "utf8");
  assert.equal(mcp.startsWith("#!/usr/bin/env node"), true);
});
