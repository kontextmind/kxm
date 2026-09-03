import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["plugins/kxm-mesh/src/cli.ts", "plugins/kxm-mesh/src/server.ts", "plugins/kxm-mesh/src/vnext-runtime-supervisor.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "plugins/kxm-mesh/dist",
  entryNames: "[name]",
  banner: { js: "#!/usr/bin/env node" },
});

const shebang = "#!/usr/bin/env node\n";
const createRequire = "import { createRequire as __kxmCreateRequire } from 'node:module'; const require = __kxmCreateRequire(import.meta.url);\n";
// The bundled YAML CommonJS internals use dynamic require, which is
// unsupported in ESM output; provide createRequire for every runtime bundle.
for (const bundlePath of [
  "plugins/kxm-mesh/dist/cli.js",
  "plugins/kxm-mesh/dist/vnext-runtime-supervisor.js",
]) {
  const bundled = readFileSync(bundlePath, "utf8");
  if (!bundled.startsWith(shebang)) throw new Error(`runtime bundle is missing its executable shebang: ${bundlePath}`);
  writeFileSync(bundlePath, `${shebang}${createRequire}${bundled.slice(shebang.length)}`);
}
