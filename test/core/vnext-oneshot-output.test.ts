import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUILTIN_HARNESSES, parseClaudeOneShotUsage, parseCodexOneShotUsage } from "../../plugins/kxm/src/vnext-harness.ts";

// Sanitized native output from the 2026-09-10 arithmetic witness. No session
// ids, paths, raw reasoning, or credentials; reported cost is not a bill.
const grokWire = readFileSync(new URL("../fixtures/harness/grok-oneshot.json", import.meta.url), "utf8");

test("Grok catalog decoder preserves native modelUsage identity and cumulative usage", () => {
  const parser = BUILTIN_HARNESSES.find((entry) => entry.id === "grok")!.oneShot!.usageParser;
  const parsed = parser(grokWire, "", "grok-4.6");
  assert.equal(parsed.effectiveModel, "grok-4.6-build");
  assert.equal(parsed.usage?.tokensIn, 56020);
  assert.equal(parsed.usage?.cacheReadTokens, 1280);
  assert.equal(parsed.usage?.costUsd, 0.01922904);
  assert.equal(parsed.usage?.contextTokens, null);
  const failed = parser(JSON.stringify({ ...JSON.parse(grokWire), stopReason: "error" }), "", "grok-4.6");
  assert.equal(failed.isError, true);
});

test("Claude attempt totals do not become auxiliary-model totals or context occupancy", () => {
  const parsed = parseClaudeOneShotUsage(JSON.stringify({
    result: '{"outcome":"passed"}',
    usage: { input_tokens: 20, output_tokens: 80, cache_read_input_tokens: 1000001 },
    modelUsage: {
      "claude-haiku-4-5": { inputTokens: 5, outputTokens: 6 },
      "claude-fable-5-1": { inputTokens: 12, outputTokens: 70 },
    },
  }), "", "fable");
  assert.equal(parsed.effectiveModel, "claude-fable-5-1");
  assert.equal(parsed.usage?.tokensIn, 20);
  assert.equal(parsed.usage?.cacheReadTokens, 1000001);
  assert.equal(parsed.usage?.contextTokens, null);
});

test("ambiguous reported model aliases remain unknown rather than choosing the first", () => {
  const parsed = parseClaudeOneShotUsage(JSON.stringify({
    result: '{"outcome":"passed"}',
    modelUsage: { "claude-fable-5-1": {}, "claude-fable-5-2": {} },
  }), "", "fable");
  assert.equal(parsed.effectiveModel, undefined);
});

test("Codex uses the final completed agent message and requires turn completion", () => {
  const message = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const final = '{"outcome":"passed"}';
  const partial = parseCodexOneShotUsage(message(final), "");
  assert.equal(partial.isError, true);
  const complete = parseCodexOneShotUsage([
    message("I will inspect the files."), message(final),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 4 } }),
  ].join("\n"), "");
  assert.equal(complete.text, final);
  assert.equal(complete.isError, false);
  assert.equal(complete.usage?.contextTokens, null);
});
