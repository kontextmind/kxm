import assert from "node:assert/strict";
import test from "node:test";
import {
  extractProjectId,
  isUsableRuntimeModelId,
  jsonOrTextError,
  parseApiKey,
  resolveProjectId,
} from "../../plugins/kxm/src/providers/antigravity/client/index.ts";
import {
  buildAntigravityCatalog,
  getCurrentAntigravityCatalog,
  getMaxOutputTokens,
  getThinkingConfig,
  resetAntigravityCatalogForTests,
} from "../../plugins/kxm/src/providers/antigravity/models/index.ts";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "../../plugins/kxm/src/providers/antigravity/pi-compat.ts";
import {
  buildRequest,
  convertMessages,
  convertTools,
  friendlyAntigravityError,
  mapStopReason,
} from "../../plugins/kxm/src/providers/antigravity/stream/index.ts";
import { formatModelsList, formatUsageSummary } from "../../plugins/kxm/src/providers/antigravity/usage/index.ts";
import { nowRequestId } from "../../plugins/kxm/src/providers/antigravity/utils/util.ts";
import type { AccountUsage } from "../../plugins/kxm/src/providers/antigravity/types/types.ts";

test.afterEach(() => {
  resetAntigravityCatalogForTests();
});

function geminiModel(id = "gemini-3.8-flash"): Model<"antigravity-api"> {
  return {
    id,
    name: id,
    api: "antigravity-api",
    provider: "antigravity",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };
}

function usageFixture(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    projectId: "p",
    endpoint: "https://daily-cloudcode-pa.googleapis.com",
    fetchedAt: Date.now(),
    models: [],
    groups: [],
    ...overrides,
  };
}

test("usage formatters cover hour resets, missing reset, and quota-error notes", () => {
  const twoHours = Date.now() + 130 * 60 * 1000;
  const summary = formatUsageSummary(
    usageFixture({
      planLabel: "Free (free-tier)",
      groups: [
        {
          displayName: "Hourly",
          buckets: [
            {
              bucketId: "h",
              displayName: "Hour",
              remainingFraction: 0.4,
              resetTime: new Date(twoHours).toISOString(),
            },
            { bucketId: "n", displayName: "None", remainingFraction: 0.1 },
          ],
        },
      ],
    }),
  );
  assert.match(summary, /Free/);
  assert.match(summary, /2h|1h|n\/a/);
  assert.match(
    formatUsageSummary(usageFixture({ quotaSummaryError: "timeout talking to quota" })),
    /unavailable/,
  );
  assert.match(
    formatUsageSummary(usageFixture({ quotaSummaryError: "account missing license for quota" })),
    /paid subscription/,
  );
  assert.match(
    formatModelsList(
      usageFixture({
        models: [{ modelId: "same", displayName: "same" }],
      }),
    ),
    /same/,
  );
});

test("client and model helpers cover remaining id, token, and thinking branches", () => {
  assert.equal(extractProjectId({ antigravityProjectId: "a1" }), "a1");
  assert.equal(extractProjectId({ userDefinedCloudaicompanionProject: "u1" }), "u1");
  assert.equal(extractProjectId({ projectIds: ["from-ids"] }), "from-ids");
  assert.equal(extractProjectId({}), undefined);
  assert.equal(jsonOrTextError('{"error":{}}'), '{"error":{}}');
  assert.throws(() => parseApiKey(JSON.stringify({ token: "t" })), /Invalid Antigravity credentials/);
  assert.equal(isUsableRuntimeModelId("MODEL_PLACEHOLDER_M1"), false);
  assert.equal(isUsableRuntimeModelId("gemini-3.8-flash has space"), false);
  assert.equal(isUsableRuntimeModelId("gemini-3.8-flash"), true);
  delete process.env.ANTIGRAVITY_PROJECT_ID;
  assert.match(resolveProjectId({ token: "t", email: "seed@example.com" }), /-/);
  assert.equal(getMaxOutputTokens("gemini-3.8-flash"), 65536);
  assert.equal(getMaxOutputTokens("x", "claude-unknown-9"), 64000);
  assert.equal(getMaxOutputTokens("x", "gpt-oss-unknown"), 32768);
  assert.equal(getMaxOutputTokens("x", "gemini-3.1-pro-custom"), 65535);
  assert.deepEqual(getThinkingConfig("gemini-3-flash-agent", "medium"), {
    includeThoughts: true,
    thinkingBudget: 4_000,
  });
  assert.deepEqual(getThinkingConfig("gemini-3.1-pro", undefined), {
    includeThoughts: false,
    thinkingBudget: 0,
  });
  assert.equal(getThinkingConfig("gemini-pro-agent", "xhigh")?.thinkingBudget, 10_001);
  assert.match(nowRequestId(), /^agent\//);
});

test("stream helpers cover source images, default system prompt, and leftover error text", () => {
  const model = geminiModel();
  const context: Context = {
    messages: [
      {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "see" },
          { type: "image", data: "abcd", mimeType: "image/webp" },
          { type: "image", data: "", mimeType: "image/png" },
          "skip-me" as never,
        ],
      },
      {
        role: "assistant",
        api: "other",
        provider: "other",
        model: "other",
        stopReason: "stop",
        timestamp: 2,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [{ type: "thinking", thinking: "foreign" }],
      },
    ],
  };
  const turns = convertMessages(model, context, "gemini-3.8-flash-low");
  assert.ok(turns.some((turn) => turn.parts.some((part) => "inlineData" in part)));
  const request = buildRequest(
    model,
    { messages: [{ role: "user", timestamp: 1, content: "hi" }] },
    "p",
    {},
    "gemini-3.8-flash-low",
  );
  assert.ok(request.request.systemInstruction?.parts.length);
  assert.ok((request.request.generationConfig?.maxOutputTokens ?? 0) > 0);
  assert.equal(mapStopReason(undefined), "stop");
  assert.match(friendlyAntigravityError(undefined, "plain"), /plain/);
  assert.match(friendlyAntigravityError(429, "quota exceeded"), /Quota reached/);
  assert.match(friendlyAntigravityError(418, "teapot"), /teapot/);
  assert.equal(
    convertTools([
      {
        name: "root-ref",
        description: "r",
        parameters: { $ref: "#/allOf/9", allOf: [{ type: "string" }] },
      },
      {
        name: "into-scalar",
        description: "s",
        parameters: { $ref: "#/type/nope", type: "string" },
      },
    ]),
    undefined,
  );

  const usage = {
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost({ cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, usage);
  assert.ok(usage.cost.total > 0);
  const stream = createAssistantMessageEventStream();
  stream.end();
});

test("catalog grouping merges unsuffixed agent aliases into the family", () => {
  const grouped = buildAntigravityCatalog(
    {
      "gemini-9.3-flash-low": { displayName: "Gemini 9.3 Flash (Low)", supportsThinking: true },
      "gemini-9.3-flash-agent": { displayName: "Gemini 9.3 Flash", supportsThinking: true },
      "claude-haiku-9": { displayName: "Claude Haiku 9" },
      "gemini-custom-other": { displayName: "Gemini Custom Other" },
    },
    getCurrentAntigravityCatalog(),
  );
  assert.ok(grouped.models.some((item) => item.id === "gemini-9.3-flash"));
  assert.ok(grouped.models.some((item) => item.id === "claude-haiku-9"));
  assert.ok(grouped.models.some((item) => item.id === "gemini-custom-other"));
});
