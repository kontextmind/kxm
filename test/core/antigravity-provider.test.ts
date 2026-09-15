import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piMeshExtension from "../../plugins/kxm/src/extension.ts";
import { looksLikeSecret, redactSecrets } from "../../plugins/kxm/src/redact.ts";
import {
  AUTH_URL,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPES,
  buildAuthorizationUrl,
  generatePKCE,
  parsePastedCallback,
} from "../../plugins/kxm/src/providers/antigravity/auth/index.ts";
import {
  ANTIGRAVITY_MODELS,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  getCurrentAntigravityCatalog,
  resetAntigravityCatalogForTests,
} from "../../plugins/kxm/src/providers/antigravity/models/index.ts";
import {
  ANTIGRAVITY_DOUBLE_REGISTRATION_WARNING,
  antigravityRegistrationNotice,
  antigravityStandaloneCommandsPresent,
  registerAntigravityProvider,
  shouldSkipAntigravityRegistration,
} from "../../plugins/kxm/src/providers/antigravity/register.ts";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "../../plugins/kxm/src/providers/antigravity/pi-compat.ts";
import { streamResponse } from "../../plugins/kxm/src/providers/antigravity/stream/index.ts";
import { ANTIGRAVITY_ROUTING } from "../../plugins/kxm/src/providers/antigravity/models/models.ts";
import type { ModelInfoRaw } from "../../plugins/kxm/src/providers/antigravity/types/types.ts";
import { redactSecrets as redactAntigravitySecrets } from "../../plugins/kxm/src/providers/antigravity/utils/security.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "antigravity");
const catalogRaw = JSON.parse(readFileSync(join(fixtureDir, "catalog.json"), "utf8")) as {
  models: Record<string, ModelInfoRaw>;
};
const streamBody = readFileSync(join(fixtureDir, "stream-sse.txt"), "utf8");

function fakePi(options: { alreadyRegistered?: boolean; standaloneCommands?: string[] } = {}) {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const providers = new Map<string, Record<string, unknown>>();
  const notices: Array<{ message: string; type?: string }> = [];
  if (options.alreadyRegistered) providers.set("antigravity", { name: "standalone" });
  const api = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    getSessionName() {
      return "antigravity-test";
    },
    getRegisteredProviderIds() {
      return [...providers.keys()];
    },
    getCommands() {
      return (options.standaloneCommands ?? []).map((name) => ({ name, source: "extension" }));
    },
    registerProvider(name: string, config: Record<string, unknown>) {
      providers.set(name, config);
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    providers,
    notices,
    async emit(name: string, ...args: unknown[]) {
      for (const handler of handlers.get(name) ?? []) await handler(...args);
    },
  };
}

test("registration exposes the static catalog models under provider id antigravity", () => {
  const pi = fakePi();
  const result = registerAntigravityProvider(pi.api);
  assert.equal(result.registered, true);
  assert.equal(result.conflict, false);
  assert.equal(pi.providers.has("antigravity"), true);
  const config = pi.providers.get("antigravity");
  assert.equal(config?.name, "Antigravity");
  assert.equal(config?.api, "antigravity-api");
  assert.equal(typeof config?.oauth, "object");
  assert.equal(typeof (config?.oauth as { login?: unknown })?.login, "function");
  assert.equal((config?.oauth as { isSubscription?: boolean })?.isSubscription, true);
  const models = config?.models as Array<{ id: string }>;
  const ids = models.map((model) => model.id);
  for (const expected of ANTIGRAVITY_MODELS.map((model) => model.id)) {
    assert.ok(ids.includes(expected), `missing catalog model ${expected}`);
  }
});

test("recorded catalog fixture maps thinking variants and drops image/internal models", () => {
  const catalog = buildAntigravityCatalog(catalogRaw.models, {
    models: ANTIGRAVITY_MODELS,
    routing: { ...ANTIGRAVITY_ROUTING },
  });
  assert.ok(catalog.models.some((model) => model.id === "gemini-3.8-flash"));
  assert.equal(catalog.routing["gemini-3.8-flash"]?.routing?.medium, "gemini-3.8-flash-medium");
  assert.equal(catalog.models.some((model) => model.id === "chat_hidden"), false);
  assert.equal(catalog.models.some((model) => model.id === "gemini-3-pro-image"), false);
  applyAntigravityCatalog(catalog);
  try {
    assert.ok(getCurrentAntigravityCatalog().models.some((model) => model.id === "gemini-3.8-flash"));
  } finally {
    resetAntigravityCatalogForTests();
  }
});

test("OAuth URL uses PKCE S256, loopback callback, and Google scopes", () => {
  const { verifier, challenge } = generatePKCE();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    challenge,
    createHash("sha256").update(verifier).digest("base64url"),
  );
  const state = "test-state-value";
  const url = new URL(buildAuthorizationUrl(challenge, state));
  assert.equal(`${url.origin}${url.pathname}`, AUTH_URL);
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(REDIRECT_URI, /localhost:51121\/oauth-callback/);
  for (const scope of SCOPES) {
    assert.match(url.searchParams.get("scope") ?? "", new RegExp(scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const pasted = parsePastedCallback(
    `http://localhost:51121/oauth-callback?code=abc&state=${state}`,
    state,
  );
  assert.deepEqual(pasted, { code: "abc", state });
  assert.throws(() => parsePastedCallback("http://localhost:51121/oauth-callback?code=abc&state=other", state), /State mismatch/);
});

test("streaming adapter converts a recorded SSE fixture into text, thinking, and tool calls", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(streamBody));
      controller.close();
    },
  });
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "antigravity-api",
    provider: "antigravity",
    model: "gemini-3.7-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
  const hasContent = await streamResponse(new Response(body), stream, output);
  stream.end();
  assert.equal(hasContent, true);
  const text = output.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const thinking = output.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .join("");
  const toolCalls = output.content.filter((block) => block.type === "toolCall");
  assert.equal(text, "Hello world");
  assert.equal(thinking, "hmm");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.name, "read");
  assert.equal(output.stopReason, "toolUse");
  assert.equal(output.usage.input, 60);
  assert.equal(output.usage.cacheRead, 40);
  assert.equal(output.usage.output, 10);
});

test("Google OAuth token shapes are redacted from logs and evidence", () => {
  const access = "ya29.a0AfH6SMB-exampleAccessTokenValue_plusPadding==";
  const refresh = "1/0gK8abcdefghijklmnopqrstuvwxyzABCD";
  const googleRefresh = "1//0eA7abcdefghijklmnopqrstuvwxyzABCD-google";
  const bearer = "Authorization: Bearer ya29.a0AfH6SMB-googleapisToken";
  const json = '{"access_token":"ya29.secret","refresh_token":"1/0gK8abcdefghijklmnopqrstuvwxyzABCD"}';
  for (const sample of [access, refresh, googleRefresh, bearer, json]) {
    const redacted = redactSecrets(sample);
    assert.equal(looksLikeSecret(sample), true, sample);
    assert.doesNotMatch(redacted, /ya29\.[A-Za-z0-9]/);
    assert.doesNotMatch(redacted, /1\/0gK8/);
    assert.doesNotMatch(redacted, /1\/\/0eA7/);
    assert.match(redacted, /\[redacted/);
  }
  const local = redactAntigravitySecrets(`Bearer ${access} refresh=${refresh} google=${googleRefresh}`);
  assert.doesNotMatch(local, /ya29\.[A-Za-z0-9]/);
  assert.doesNotMatch(local, /1\/\/0eA7/);
  assert.match(local, /\[redacted/);
});

test("double-registration is skipped and warned at session start", () => {
  const pi = fakePi({ alreadyRegistered: true });
  const result = registerAntigravityProvider(pi.api);
  assert.equal(result.registered, false);
  assert.equal(result.conflict, true);
  assert.equal(result.warning, ANTIGRAVITY_DOUBLE_REGISTRATION_WARNING);
  assert.equal(pi.providers.get("antigravity")?.name, "standalone");
  const notice = antigravityRegistrationNotice(result);
  assert.equal(notice?.type, "warning");
  assert.match(notice?.message ?? "", /standalone pi-antigravity/);
  assert.ok((notice?.message.length ?? 0) <= 400);

  const extensionPi = fakePi({ alreadyRegistered: true });
  piMeshExtension(extensionPi.api);
  assert.equal(extensionPi.providers.get("antigravity")?.name, "standalone");
});

test("standalone slash commands skip registration and still warn after KXM registered", () => {
  const standalone = fakePi({ standaloneCommands: ["antigravity.image", "antigravity.doctor"] });
  assert.equal(antigravityStandaloneCommandsPresent(standalone.api), true);
  assert.equal(shouldSkipAntigravityRegistration(standalone.api), true);
  const skipped = registerAntigravityProvider(standalone.api);
  assert.equal(skipped.registered, false);
  assert.equal(skipped.conflict, true);
  assert.equal(standalone.providers.has("antigravity"), false);

  const ours = fakePi();
  const registered = registerAntigravityProvider(ours.api);
  assert.equal(registered.registered, true);
  const lateStandalone = fakePi({ standaloneCommands: ["antigravity.models"] });
  const notice = antigravityRegistrationNotice(registered, lateStandalone.api);
  assert.equal(notice?.type, "warning");
  assert.match(notice?.message ?? "", /standalone pi-antigravity/);
});
