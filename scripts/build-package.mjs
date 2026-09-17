/**
 * Build one workspace package to `dist/`.
 *
 * The repo bundles with esbuild everywhere — the CLI, the hub, the extension,
 * and the MCP server — so a package builds with the same bundler and the same
 * Node target. That keeps CI on one toolchain and makes a built package
 * reproducible from the committed sources.
 *
 * Usage: node scripts/build-package.mjs packages/core/kxm-tui
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { build } from "esbuild";

const EXTERNAL = Object.freeze([
  "@earendil-works/pi-tui",
  "@earendil-works/pi-coding-agent",
  "@anthropic-ai/claude-agent-sdk",
  "typebox",
]);

export async function buildPackage(projectDir, repository = REPOSITORY) {
  const root = resolve(repository);
  const project = resolve(root, projectDir);
  await build({
    absWorkingDir: root,
    entryPoints: [resolve(project, "src/exports/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: resolve(project, "dist/index.js"),
    external: EXTERNAL,
    sourcemap: false,
  });
  return resolve(project, "dist/index.js");
}

// A package script runs with its own directory as cwd, so accept a bare
// "packages/..." path as well and resolve it against the repository.
function normalizeProjectPath(value) {
  return value.startsWith("packages/") || value.startsWith("plugins/")
    ? resolve(REPOSITORY, value)
    : resolve(value);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write("usage: node scripts/build-package.mjs <project-dir>\n");
    process.exitCode = 2;
  } else {
    const written = await buildPackage(normalizeProjectPath(target));
    process.stdout.write(`built ${dirname(written).split("/").slice(-2).join("/")}/index.js\n`);
  }
}
