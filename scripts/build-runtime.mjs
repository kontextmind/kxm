import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["plugins/kxm/src/cli.ts", "plugins/kxm/src/server.ts", "plugins/kxm/src/vnext-runtime-supervisor.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "plugins/kxm/dist",
  entryNames: "[name]",
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  entryPoints: [
    "plugins/kxm/src/core.ts",
    "plugins/kxm/src/runtime.ts",
    "plugins/kxm/src/client.ts",
    "plugins/kxm/src/extension.ts",
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "plugins/kxm/dist",
  entryNames: "[name]",
  external: [
    "@earendil-works/pi-coding-agent",
    "typebox",
    "@anthropic-ai/claude-agent-sdk",
  ],
});

const shebang = "#!/usr/bin/env node\n";
const createRequire = "import { createRequire as __kxmCreateRequire } from 'node:module'; const require = __kxmCreateRequire(import.meta.url);\n";
// The bundled YAML CommonJS internals use dynamic require, which is
// unsupported in ESM output; provide createRequire for every runtime bundle.
for (const bundlePath of [
  "plugins/kxm/dist/cli.js",
  "plugins/kxm/dist/server.js",
  "plugins/kxm/dist/vnext-runtime-supervisor.js",
]) {
  const bundled = readFileSync(bundlePath, "utf8");
  if (!bundled.startsWith(shebang)) throw new Error(`runtime bundle is missing its executable shebang: ${bundlePath}`);
  writeFileSync(bundlePath, `${shebang}${createRequire}${bundled.slice(shebang.length)}`);
}

const runtimeLibrary = "plugins/kxm/dist/runtime.js";
const runtimeLibraryText = readFileSync(runtimeLibrary, "utf8");
if (runtimeLibraryText.startsWith(shebang)) {
  throw new Error(`library bundle must not have an executable shebang: ${runtimeLibrary}`);
}
writeFileSync(runtimeLibrary, `${createRequire}${runtimeLibraryText}`);

const { emitCodexArtifacts } = await import("./emit-codex-artifacts.mjs");
emitCodexArtifacts();

const { syncHarnessMemory } = await import("../plugins/kxm/src/memory.ts");
syncHarnessMemory(process.cwd());
