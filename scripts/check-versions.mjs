import { readFile } from "node:fs/promises";

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
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

const failures = [...versions].filter(([, version]) => version !== root.version);
if (failures.length > 0) {
  for (const [name, version] of failures) {
    process.stderr.write(`${name} version ${String(version)} does not match ${root.version}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`all package surfaces use version ${root.version}\n`);
}
