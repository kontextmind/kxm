import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseVisionVerdict,
  runVisionGate,
  visionGatePrompt,
  VISION_GATE_DEFAULT_ROUTE,
} from "../../plugins/kxm/src/vision-gate.ts";

function projectWithRoutes(admitted: string[]): { root: string; image: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-vision-gate-"));
  mkdirSync(join(root, ".kxm"), { recursive: true });
  writeFileSync(
    join(root, ".kxm", "routes.yaml"),
    `schema: kxm.routes.v2\nupdatedAt: '2026-09-16T00:00:00.000Z'\nadmitted:\n${admitted.map((m) => `  - ${m}`).join("\n")}\ndisabled: []\n`,
    "utf8",
  );
  const image = join(root, "shot.png");
  writeFileSync(image, "png-bytes");
  return { root, image };
}

test("vision gate prompt embeds the image reference, stays bounded, demands a strict verdict", () => {
  const prompt = visionGatePrompt("Does the page show an error banner? " + "x".repeat(800), "/tmp/shot.png");
  assert.match(prompt, /Does the page show an error banner\?/);
  assert.match(prompt, /@\/tmp\/shot\.png/, "the @path image reference is how pi attaches the screenshot");
  assert.ok(prompt.length < 1200, "prompt must stay bounded");
  assert.match(prompt, /\{"verdict": true\} or \{"verdict": false\}/);
});

test("parseVisionVerdict accepts only strict verdict objects", () => {
  assert.equal(parseVisionVerdict('{"verdict": true}'), true);
  assert.equal(parseVisionVerdict('noise {"verdict":false} noise'), false);
  assert.equal(parseVisionVerdict("the banner is red"), null);
  assert.equal(parseVisionVerdict('{"error": true}'), null);
});

test("runVisionGate returns the model verdict on an admitted route", async () => {
  const { root, image } = projectWithRoutes([VISION_GATE_DEFAULT_ROUTE]);
  try {
    const result = await runVisionGate({
      projectRoot: root,
      imagePath: image,
      question: "Does the page show an error banner?",
      transport: async () => 'prefix {"verdict": true} suffix',
    });
    assert.equal(result.verdict, true);
    assert.equal(result.divergence, undefined);
    assert.equal(result.route, VISION_GATE_DEFAULT_ROUTE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runVisionGate fails closed on unadmitted routes without calling transport", async () => {
  const { root, image } = projectWithRoutes(["anthropic/fable"]);
  try {
    let called = false;
    const result = await runVisionGate({
      projectRoot: root,
      imagePath: image,
      question: "error banner?",
      transport: async () => { called = true; return '{"verdict": true}'; },
    });
    assert.equal(called, false, "transport must not run for unadmitted routes");
    assert.equal(result.verdict, null);
    assert.equal(result.divergence, "route_not_admitted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runVisionGate fails closed on unreadable images and unparsable verdicts", async () => {
  const { root } = projectWithRoutes([VISION_GATE_DEFAULT_ROUTE]);
  try {
    const missing = await runVisionGate({
      projectRoot: root,
      imagePath: join(root, "missing.png"),
      question: "error banner?",
      transport: async () => '{"verdict": true}',
    });
    assert.equal(missing.verdict, null);
    assert.equal(missing.divergence, "image unreadable");

    const image = join(root, "shot.png");
    writeFileSync(image, "png-bytes");
    const unparsable = await runVisionGate({
      projectRoot: root,
      imagePath: image,
      question: "error banner?",
      transport: async () => "the banner is definitely red",
    });
    assert.equal(unparsable.verdict, null);
    assert.equal(unparsable.divergence, "verdict unreadable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runVisionGate validates the timeout bound", async () => {
  const { root, image } = projectWithRoutes([VISION_GATE_DEFAULT_ROUTE]);
  try {
    for (const timeoutMs of [0, 4_000, 300_001, Number.NaN]) {
      const result = await runVisionGate({
        projectRoot: root,
        imagePath: image,
        question: "error banner?",
        timeoutMs,
        transport: async () => '{"verdict": true}',
      });
      assert.equal(result.verdict, null);
      assert.equal(result.divergence, "timeout_out_of_bounds");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
