import { readFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { join, sep } from "node:path";

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Every workspace package under `packages/`, one or two levels deep. */
function workspaceManifests() {
  const found = [];
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (existsSync(join(path, "package.json"))) found.push(path);
      else scan(path);
    }
  };
  scan("packages");
  return found.sort();
}

const root = await json("package.json");
const lock = await json("package-lock.json");
const pluginPackage = await json("plugins/kxm/package.json");
const pluginManifest = await json("plugins/kxm/.claude-plugin/plugin.json");
const marketplace = await json(".claude-plugin/marketplace.json");
const mcpSource = await readFile("plugins/kxm/src/mcp-server.ts", "utf8");
const mcpVersion = mcpSource.match(/const VERSION = "([^"]+)"/)?.[1];
const marketplaceEntry = marketplace.plugins?.find((plugin) => plugin.name === "kxm");

const versions = new Map([
  ["root package", root.version],
  ["package lock", lock.version],
  ["package lock root", lock.packages?.[""]?.version],
  ["plugin package", pluginPackage.version],
  ["Claude plugin manifest", pluginManifest.version],
  ["Claude marketplace entry", marketplaceEntry?.version],
  ["MCP server", mcpVersion],
]);

for (const dir of workspaceManifests()) {
  const manifest = await json(join(dir, "package.json"));
  const relativePath = dir.split(sep).join("/");
  versions.set(`${manifest.name} package`, manifest.version);
  versions.set(`${manifest.name} lock entry`, lock.packages?.[relativePath]?.version);
}

const failures = [...versions].filter(([, version]) => version !== root.version);
if (failures.length > 0) {
  for (const [name, version] of failures) {
    process.stderr.write(`${name} version ${String(version)} does not match ${root.version}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`all package surfaces use version ${root.version} (${versions.size} checked)\n`);
}
