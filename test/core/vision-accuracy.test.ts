import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runVisionGate, VISION_GATE_DEFAULT_ROUTE } from "../../plugins/kxm/src/vision-gate.ts";

const fixtureDir = new URL("../fixtures/vision/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtureDir), "utf8")) as {
  schema: string;
  route: string;
  witness: string;
  cases: Array<{ image: string; question: string; expect: boolean }>;
};

test("vision accuracy fixtures name the admitted default and a true/false pair", () => {
  assert.equal(manifest.schema, "kxm.vision-witness.v1");
  assert.equal(manifest.route, VISION_GATE_DEFAULT_ROUTE);
  assert.match(manifest.witness, /OPENROUTER_API_KEY/);
  assert.match(manifest.witness, /test\/core\/vision-accuracy\.test\.ts/);
  assert.equal(manifest.cases.length, 2);
  assert.deepEqual(new Set(manifest.cases.map((entry) => entry.expect)), new Set([true, false]));
  for (const entry of manifest.cases) {
    const bytes = readFileSync(new URL(entry.image, fixtureDir));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${entry.image} is a png`);
    assert.ok(entry.question.trim().length > 0);
  }
});

// Live witness: node --disable-warning=ExperimentalWarning --experimental-strip-types --test --test-force-exit test/core/vision-accuracy.test.ts
// Requires OPENROUTER_API_KEY and pi on PATH. Without the key this case is skipped.
const live = Boolean(process.env.OPENROUTER_API_KEY);
(live ? test : test.skip)("vision accuracy witness calls the admitted route on the fixture images", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-vision-live-"));
  mkdirSync(join(root, ".kxm"), { recursive: true });
  writeFileSync(
    join(root, ".kxm", "routes.yaml"),
    `schema: kxm.routes.v2\nupdatedAt: '2026-10-21T00:00:00.000Z'\nadmitted:\n  - ${manifest.route}\ndisabled: []\n`,
    "utf8",
  );
  try {
    for (const entry of manifest.cases) {
      const result = await runVisionGate({
        projectRoot: root,
        imagePath: new URL(entry.image, fixtureDir).pathname,
        question: entry.question,
        route: manifest.route,
        timeoutMs: 120_000,
      });
      assert.equal(result.divergence, undefined, result.raw);
      assert.equal(result.verdict, entry.expect, result.raw);
      assert.equal(result.route, VISION_GATE_DEFAULT_ROUTE);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
