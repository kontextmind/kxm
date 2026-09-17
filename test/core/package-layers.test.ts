/**
 * Package layout gate.
 *
 * The layer convention (`types` → `tui` → `services` → `adapters` → `exports`)
 * is only real if something refuses a violation. Otherwise it is a README
 * paragraph the next convenient import quietly ignores, and the kit stops being
 * testable for the very reason it was split.
 *
 * Rules, from `docs/tui-components.md`:
 * - `src/types/**` imports nothing outside itself. A contract that needs the
 *   filesystem is a service, not a type module.
 * - `src/tui/**` may import its own layer plus the Pi renderer. Never Node
 *   builtins, never a hub, never SQLite: a control that reads disk cannot be
 *   rendered in a test, and every control here is rendered in a test.
 * - `src/services/**` owns I/O and policy and never renders: no Pi import and no
 *   import of the `tui` layer.
 * - `src/exports/**` only re-exports from inside its own package.
 * - Every package carries its own manifest, config, docs, changelog, and
 *   license, shares the repository version, and is reachable by name only.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import type { Node } from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";
import { visitEachChild } from "typescript/unstable/ast/visitor";

const PACKAGES_ROOT = resolve("packages");
const PI_RENDERER = "@earendil-works/pi-tui";
const PI_SPECIFIERS = [PI_RENDERER, "@earendil-works/pi-coding-agent"];
const LAYERS = ["types", "tui", "services", "adapters", "exports"];
const REQUIRED_FILES = ["package.json", "tsconfig.json", "project.json", "README.md", "CHANGELOG.md", "LICENSE"];

interface ModuleEdge {
  readonly specifier: string;
  readonly kind: string;
}

function literalOf(node: unknown): string | undefined {
  const candidate = node as { text?: string; literal?: { text?: string }; argument?: { text?: string } };
  return candidate?.text ?? candidate?.literal?.text ?? candidate?.argument?.text;
}

function collectEdges(fileName: string, sourceFile: Node): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  const visit = (node: Node): void => {
    const candidate = node as unknown as { moduleSpecifier?: unknown; expression?: Node; arguments?: unknown[] };
    if ((is.isImportDeclaration(node) || is.isExportDeclaration(node)) && candidate.moduleSpecifier) {
      const specifier = literalOf(candidate.moduleSpecifier);
      if (specifier) edges.push({ specifier, kind: is.isImportDeclaration(node) ? "import" : "export" });
    } else if (is.isImportTypeNode(node)) {
      const specifier = literalOf((node as unknown as { argument?: unknown }).argument);
      if (specifier) edges.push({ specifier, kind: "import-type" });
    } else if (is.isCallExpression(node) && candidate.expression && is.isImportExpression(candidate.expression)) {
      const specifier = literalOf(candidate.arguments?.[0]);
      if (specifier) edges.push({ specifier, kind: "dynamic" });
    }
    visitEachChild(node, (child) => {
      visit(child);
      return child;
    });
  };
  visit(sourceFile);
  return edges;
}

function listSources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSources(path, out);
    else if (entry.endsWith(".ts")) out.push(resolve(path));
  }
  return out;
}

function packageDirs(): string[] {
  if (!existsSync(PACKAGES_ROOT)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (!statSync(path).isDirectory() || entry === "node_modules") continue;
      if (existsSync(join(path, "package.json"))) found.push(path);
      else if (depth < 3) walk(path, depth + 1);
    }
  };
  walk(PACKAGES_ROOT, 1);
  return found;
}

const packages = packageDirs();
const packageOf = (file: string): string | undefined => packages.find((dir) => file.startsWith(dir + sep));
const layerOf = (file: string): string | undefined => {
  const owner = packageOf(file);
  if (!owner) return undefined;
  const parts = relative(join(owner, "src"), file).split(sep);
  return parts.length > 1 ? parts[0] : undefined;
};

/**
 * One AST pass over the whole tsconfig program.
 *
 * The repository already parses imports this way in
 * `test/core/import-boundary.test.ts`: a real AST, so a specifier inside a
 * comment or a string literal is never mistaken for an import.
 */
let programGraph: Map<string, ModuleEdge[]> | undefined;

function importGraph(_files: readonly string[]): Map<string, ModuleEdge[]> {
  if (programGraph) return programGraph;
  const api = new API({ cwd: process.cwd() });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [resolve("tsconfig.json")] });
    const project = snapshot.getProject(resolve("tsconfig.json"));
    assert.ok(project, "tsconfig project did not load; the layer gate cannot see imports");
    const edges = new Map<string, ModuleEdge[]>();
    for (const fileName of project.program.getSourceFileNames()) {
      const resolved = resolve(fileName);
      const sourceFile = project.program.getSourceFile(fileName);
      if (!sourceFile) continue;
      if (!resolved.endsWith(".ts") || resolved.endsWith(".d.ts")) continue;
      if (!isScanned(resolved)) continue;
      edges.set(resolved, collectEdges(resolved, sourceFile as unknown as Node));
    }
    programGraph = edges;
    return edges;
  } finally {
    api.close();
  }
}

function isScanned(file: string): boolean {
  return file.startsWith(PACKAGES_ROOT + sep)
    || file.startsWith(resolve("plugins/kxm/src") + sep)
    || file.startsWith(resolve("test") + sep);
}

function describe(edge: ModuleEdge, file: string): string {
  return `${relative(process.cwd(), file)} ${edge.kind}s "${edge.specifier}"`;
}

test("packages: every package carries its own manifest, config, and docs", () => {
  assert.ok(packages.length > 0, "no packages found under packages/");
  const root = JSON.parse(readFileSync("package.json", "utf8")) as { version: string; files?: string[]; workspaces?: string[] };
  assert.ok(Array.isArray(root.workspaces) && root.workspaces.length > 0, "the root package must declare workspaces");
  for (const dir of packages) {
    const label = relative(process.cwd(), dir);
    for (const required of REQUIRED_FILES) {
      assert.ok(existsSync(join(dir, required)), `${label} is missing ${required}`);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      type?: string;
      exports?: Record<string, string>;
    };
    assert.equal(manifest.version, root.version, `${label} must share the repository version (npm run check:versions agrees)`);
    assert.equal(manifest.type, "module", `${label} must be ESM like every other package surface`);
    assert.ok(manifest.exports && "." in manifest.exports, `${label} must declare a "." export`);
    for (const target of Object.values(manifest.exports ?? {})) {
      assert.equal(target.startsWith(".."), false, `${label} must not export outside its own directory: ${target}`);
    }
    const sources = join(label, "src").split(sep).join("/");
    assert.ok((root.files ?? []).includes(sources), `root "files" must ship ${sources} for source-loaded hosts`);
  }
});

test("packages: each package is linked so imports resolve to one source", () => {
  for (const dir of packages) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string };
    const link = resolve("node_modules", ...manifest.name.split("/"));
    assert.ok(existsSync(link), `${manifest.name} is not linked; run the installer before building`);
    assert.equal(realpathSync(link), realpathSync(dir), `${manifest.name} resolves elsewhere; only one copy may exist`);
  }
});

test("packages: layer imports respect the documented boundaries", () => {
  const files = packages.flatMap((dir) => listSources(join(dir, "src")));
  assert.ok(files.length > 0, "no package sources found");
  const edges = importGraph(files);
  for (const file of files) {
    assert.ok(edges.has(file), `a package source was not parsed; the layer gate would be incomplete: ${relative(process.cwd(), file)}`);
  }

  for (const file of files) {
    const layer = layerOf(file);
    assert.ok(layer !== undefined && LAYERS.includes(layer), `${relative(process.cwd(), file)} must live under src/<layer>/`);
    for (const edge of edges.get(file) ?? []) {
      const specifier = edge.specifier;
      const external = !specifier.startsWith(".");
      if (!external) {
        const target = resolve(dirname(file), specifier);
        const targetLayer = layerOf(target);
        if (layer === "types") {
          assert.equal(targetLayer, "types", `types/ may not import the ${String(targetLayer)} layer: ${describe(edge, file)}`);
        }
        if (layer === "services") {
          assert.notEqual(targetLayer, "tui", `services/ never renders: ${describe(edge, file)}`);
        }
        if (layer === "exports") {
          assert.ok(packageOf(target) === packageOf(file), `exports/ may only re-export its own package: ${describe(edge, file)}`);
        }
        continue;
      }
      const isPi = PI_SPECIFIERS.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
      const isNode = specifier === "node" || specifier.startsWith("node:");
      if (layer === "types" || layer === "tui") {
        assert.equal(isNode, false, `${layer}/ must stay free of Node builtins: ${describe(edge, file)}`);
      }
      if (layer === "types") {
        assert.equal(isPi, false, `types/ must stay free of the Pi runtime: ${describe(edge, file)}`);
        assert.fail(`types/ may import nothing external: ${describe(edge, file)}`);
      }
      if (layer === "tui") {
        assert.equal(specifier === PI_RENDERER, true, `tui/ may import only ${PI_RENDERER}: ${describe(edge, file)}`);
      }
      if (layer === "services") {
        assert.equal(isPi, false, `services/ never renders, so it may not import Pi: ${describe(edge, file)}`);
      }
    }
  }
});

test("packages: consumers import by name, never by path into internals", () => {
  const consumers = [...listSources(resolve("plugins/kxm/src")), ...listSources(resolve("test/core")), ...listSources(resolve("test/simulations"))];
  const edges = importGraph([...consumers, ...packages.flatMap((dir) => listSources(join(dir, "src")))]);
  for (const consumer of consumers) {
    if (basename(consumer) === "package-layers.test.ts") continue;
    for (const edge of edges.get(consumer) ?? []) {
      const specifier = edge.specifier;
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(consumer), specifier);
      assert.equal(packageOf(target), undefined, `${relative(process.cwd(), consumer)} reaches into a package by path: ${specifier}`);
    }
  }
  const tui = packages.find((dir) => dir.endsWith("tui"));
  assert.ok(tui !== undefined, "the terminal kit must exist under packages/");
  assert.ok(readFileSync(join(tui, "src", "tui", "theme.ts"), "utf8").includes("SGR"), "the shared palette must stay in the kit that kxm dash reads");
});
