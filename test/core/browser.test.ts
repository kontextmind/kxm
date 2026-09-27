import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  SteelClient,
  SteelAuthConfigError,
  SteelAuthRedirectError,
  resolveSteelConfig,
  resolveSteelAuthorization,
  resolvePassCliApiKey,
  formatCDPEndpoint,
  resolveBrowserCdpEndpoint,
  resolveObscuraCdpEndpoint,
  DEFAULT_OBSCURA_CDP_URL,
  formatCDPConnect,
  steelRequestHeaders,
  sanitizeLogOutput,
  createAnnotationFeedback,
  formatAnnotationFeedbackPrompt,
  resolveViewportDimensions,
  resetLegacySteelAuthWarningForTests,
  VIEWPORT_PRESETS,
  type SteelSession,
} from "../../plugins/kxm/src/browser.ts";

describe("KXM Browser & Steel Integration", () => {
  let server: http.Server;
  let serverUrl: string;
  let serverPort: number;

  const mockSessions = new Map<string, any>();
  let shouldFailNext = false;
  let shouldReturn500 = false;
  let shouldRedirect = false;
  let lastHeaders: http.IncomingHttpHeaders = {};

  const steelAuthEnv = [
    "STEEL_API_KEY",
    "STEEL_API_URL",
    "STEEL_UI_URL",
    "STEEL_AUTH_HEADER",
    "STEEL_AUTH_BASIC",
    "STEEL_AUTH_USER",
    "STEEL_AUTH_TOKEN",
    "USE_PASS_CLI",
    "PASS_CLI_OUTPUT_MOCK",
  ] as const;

  function snapshotSteelEnv(): Record<string, string | undefined> {
    return Object.fromEntries(steelAuthEnv.map((name) => [name, process.env[name]]));
  }

  function restoreSteelEnv(saved: Record<string, string | undefined>): void {
    for (const name of steelAuthEnv) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  function captureStderr(fn: () => void): string {
    const chunks: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      fn();
      return chunks.join("");
    } finally {
      process.stderr.write = original;
    }
  }

  beforeEach(async () => {
    mockSessions.clear();
    shouldFailNext = false;
    shouldReturn500 = false;
    shouldRedirect = false;
    lastHeaders = {};

    server = http.createServer((req, res) => {
      lastHeaders = req.headers;
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (shouldRedirect) {
        res.writeHead(302, {
          Location: "https://id.kxmd.dev/if/flow/default-authentication-flow/?next=/v1/sessions",
          "Content-Type": "text/plain",
        });
        res.end("redirected");
        return;
      }

      if (shouldReturn500) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          const id = `mock-session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
          const sessionData = {
            id,
            createdAt: new Date().toISOString(),
            status: "live",
            websocketUrl: `ws://127.0.0.1:${serverPort}/?sessionId=${id}`,
            debugUrl: `http://127.0.0.1:${serverPort}/v1/sessions/debug`,
            debuggerUrl: `http://127.0.0.1:${serverPort}/v1/devtools/inspector.html`,
            sessionViewerUrl: `http://127.0.0.1:${serverPort}/ui?sessionId=${id}`,
            timeout: parsed.timeout || 300000,
            userAgent: parsed.userAgent || "MockAgent/1.0",
          };
          mockSessions.set(id, sessionData);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(sessionData));
        });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/sessions/")) {
        const id = url.pathname.replace("/v1/sessions/", "").replace(/\/release$/, "");
        const session = mockSessions.get(id);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(session));
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/release")) {
        const id = url.pathname.replace("/v1/sessions/", "").replace(/\/release$/, "");
        const session = mockSessions.get(id);
        if (session) {
          session.status = "released";
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, id }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/sessions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: Array.from(mockSessions.values()) }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/scrape") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              content: { html: `<html><body>Scraped: ${parsed.url}</body></html>` },
              metadata: { statusCode: 200, title: "Test Title", urlSource: parsed.url, timestamp: new Date().toISOString() },
              links: [{ url: "https://example.com/link", text: "Link" }],
            })
          );
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/screenshot") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: "https://example.com", base64: "iVBORw0KGgoAAAANSUhEUg==" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("resolves steel config with secure defaults, env vars, and pass-cli disable", () => {
    const origEnv = { ...process.env };
    try {
      delete process.env.STEEL_API_KEY;
      delete process.env.STEEL_API_URL;
      delete process.env.STEEL_UI_URL;
      delete process.env.STEEL_AUTH_HEADER;
      delete process.env.STEEL_AUTH_BASIC;
      delete process.env.STEEL_AUTH_USER;
      delete process.env.STEEL_AUTH_TOKEN;
      process.env.USE_PASS_CLI = "true";

      // Test mock pass-cli resolution
      process.env.PASS_CLI_OUTPUT_MOCK = JSON.stringify({
        item: {
          content: {
            content: {
              Custom: {
                sections: [
                  {
                    section_fields: [
                      { name: "STEEL_API_KEY", content: { Hidden: "steel_mock_resolved_key" } },
                    ],
                  },
                ],
              },
            },
          },
        },
      });
      const cfgMock = resolveSteelConfig();
      assert.strictEqual(cfgMock.apiKey, "steel_mock_resolved_key");
      assert.strictEqual(cfgMock.authorization, undefined);

      // Test mock pass-cli where STEEL_API_KEY field is missing
      process.env.PASS_CLI_OUTPUT_MOCK = JSON.stringify({
        item: {
          content: {
            extra_fields: [{ name: "OTHER_KEY", content: { Text: "value" } }],
          },
        },
      });
      const cfgNoKey = resolveSteelConfig();
      assert.strictEqual(cfgNoKey.apiKey, undefined);

      // Test mock pass-cli with invalid JSON
      process.env.PASS_CLI_OUTPUT_MOCK = "invalid-json";
      const cfgBadMock = resolveSteelConfig();
      assert.strictEqual(cfgBadMock.apiKey, undefined);

      delete process.env.PASS_CLI_OUTPUT_MOCK;

      // Test direct resolvePassCliApiKey with custom execFn
      const directKey = resolvePassCliApiKey(() =>
        JSON.stringify({
          item: {
            content: {
              extra_fields: [{ name: "STEEL_API_KEY", content: { Hidden: "direct_custom_key" } }],
            },
          },
        })
      );
      assert.strictEqual(directKey, "direct_custom_key");

      const errorKey = resolvePassCliApiKey(() => {
        throw new Error("exec failed");
      });
      assert.strictEqual(errorKey, undefined);

      process.env.STEEL_API_URL = "https://steel.env.local";
      process.env.STEEL_API_KEY = "steel_envkey123";
      process.env.STEEL_UI_URL = "https://steel.env.local/custom-ui";
      process.env.USE_PASS_CLI = "false";

      const configFromEnv = resolveSteelConfig();
      assert.strictEqual(configFromEnv.apiUrl, "https://steel.env.local");
      assert.strictEqual(configFromEnv.apiKey, "steel_envkey123");
      assert.strictEqual(configFromEnv.authorization, undefined);
      assert.strictEqual(configFromEnv.uiUrl, "https://steel.env.local/custom-ui");

      const configOverride = resolveSteelConfig({
        apiUrl: "https://steel.test.local",
        apiKey: "steel_testkey12345",
      });
      assert.strictEqual(configOverride.apiUrl, "https://steel.test.local");
      assert.strictEqual(configOverride.apiKey, "steel_testkey12345");
      assert.strictEqual(configOverride.uiUrl, "https://steel.test.local/ui");
      assert.strictEqual(configOverride.timeoutMs, 300000);
    } finally {
      process.env = origEnv;
    }
  });

  it("formats remote CDP endpoint cleanly for both secure and insecure protocols", () => {
    const configSecure = {
      apiUrl: "https://steel.kontextmind.com",
      apiKey: "steel_secret_key",
      uiUrl: "https://steel.kontextmind.com/ui",
    };
    const session = {
      id: "sess_12345",
      websocketUrl: "ws://0.0.0.0:3000/",
    };

    const cdpUrlSecure = formatCDPEndpoint(session, configSecure);
    assert.ok(cdpUrlSecure.startsWith("wss://steel.kontextmind.com/v1/devtools?"));
    assert.ok(cdpUrlSecure.includes("sessionId=sess_12345"));
    assert.ok(cdpUrlSecure.includes("apiKey=steel_secret_key"));

    const configInsecure = {
      apiUrl: "http://localhost:3000",
      uiUrl: "http://localhost:3000/ui",
    };
    const cdpUrlInsecure = formatCDPEndpoint(session, configInsecure);
    assert.ok(cdpUrlInsecure.startsWith("ws://localhost:3000/v1/devtools?"));
    assert.ok(!cdpUrlInsecure.includes("apiKey="));

    const basic = formatCDPConnect(session, {
      ...configSecure,
      authorization: "Basic dXNlcjp0b2tlbg==",
    });
    assert.strictEqual(new URL(basic.url).searchParams.get("apiKey"), null);
    assert.strictEqual(basic.headers.Authorization, "Basic dXNlcjp0b2tlbg==");
    assert.strictEqual(basic.headers["x-steel-api-key"], undefined);
  });

  it("sanitizes and redacts secrets in primitive, array, and nested log structures", () => {
    assert.strictEqual(sanitizeLogOutput(123), 123);
    assert.strictEqual(sanitizeLogOutput(true), true);
    assert.strictEqual(sanitizeLogOutput(null), null);

    const rawUrl = "wss://steel.kontextmind.com/v1/devtools?sessionId=123&apiKey=steel_998877665544332211";
    assert.strictEqual(sanitizeLogOutput(rawUrl), "wss://steel.kontextmind.com/v1/devtools?sessionId=123&apiKey=[REDACTED]");

    const rawArray = ["normal", "apiKey=secret123", { password: "p1", public: "val" }];
    const sanitizedArray = sanitizeLogOutput(rawArray) as any[];
    assert.strictEqual(sanitizedArray[0], "normal");
    assert.strictEqual(sanitizedArray[1], "apiKey=[REDACTED]");
    assert.strictEqual(sanitizedArray[2].password, "[REDACTED]");
    assert.strictEqual(sanitizedArray[2].public, "val");
  });

  it("manages session lifecycle with all options (proxy, dimensions, custom userAgent)", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
      timeoutMs: 60000,
    });

    assert.strictEqual(client.getConfig().apiKey, "test_key");

    const session = await client.createSession({
      userAgent: "CustomAgent/2.0",
      proxy: "http://proxy.example.com:8080",
      dimensions: { width: 1280, height: 800 },
    });

    assert.ok(session.id);
    assert.strictEqual(session.status, "live");
    assert.strictEqual(session.state, "AGENT_CONTROL");
    assert.strictEqual(session.activeController, "agent");
    assert.strictEqual(session.timeoutMs, 60000);

    const fetched = await client.getSession(session.id);
    assert.ok(fetched);
    assert.strictEqual(fetched?.id, session.id);

    // Test 404 on unknown session
    const notFound = await client.getSession("unknown-id-404");
    assert.strictEqual(notFound, null);

    // Test 404 on a previously cached session that was removed from server
    const cachedSession = await client.createSession();
    mockSessions.delete(cachedSession.id);
    const expiredFetched = await client.getSession(cachedSession.id);
    assert.strictEqual(expiredFetched, null);
    assert.strictEqual(cachedSession.state, "EXPIRED");

    // Test takeover on expired session throws state error
    assert.throws(() => {
      client.requestHumanTakeover(cachedSession.id, "MFA on expired");
    }, /Cannot initiate takeover on session in state EXPIRED/);

    // Test releaseSession on session not currently in activeSessions
    const releaseUntracked = await client.releaseSession("untracked-session-999");
    assert.strictEqual(releaseUntracked, true);

    const released = await client.releaseSession(session.id);
    assert.strictEqual(released, true);

    const afterRelease = await client.getSession(session.id);
    assert.strictEqual(afterRelease?.status, "released");
  });

  it("handles server failure branches gracefully", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
    });

    shouldReturn500 = true;

    await assert.rejects(async () => {
      await client.createSession();
    }, /Failed to create Steel session \(500\)/);

    await assert.rejects(async () => {
      await client.getSession("any-id");
    }, /Failed to fetch Steel session \(500\)/);

    await assert.rejects(async () => {
      await client.scrape("https://example.com");
    }, /Scrape failed \(500\)/);

    await assert.rejects(async () => {
      await client.screenshot("https://example.com");
    }, /Screenshot failed \(500\)/);

    // releaseSession returns false on network error rather than throwing
    const badClient = new SteelClient({ apiUrl: "http://127.0.0.1:1", apiKey: "key" });
    const releaseNetworkError = await badClient.releaseSession("network-error-id");
    assert.strictEqual(releaseNetworkError, false);

    const releaseFailed = await client.releaseSession("any-id");
    assert.strictEqual(releaseFailed, false);

    // checkOrphanedSessions returns empty array on error
    const orphans = await client.checkOrphanedSessions();
    assert.deepStrictEqual(orphans, []);
  });

  it("enforces human takeover protocol state transitions and error paths", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
    });

    const session = await client.createSession();

    // 1. Invalid transitions on untracked / released sessions
    assert.throws(() => {
      client.requestHumanTakeover("non-existent-id", "test");
    }, /not tracked/);

    assert.throws(() => {
      client.signalHumanComplete("non-existent-id");
    }, /not tracked/);

    assert.throws(() => {
      client.confirmAuthenticationVerified("non-existent-id");
    }, /not tracked/);

    // 2. Transition to HUMAN_CONTROL
    const takeover = client.requestHumanTakeover(session.id, "MFA prompt encountered on dashboard login");
    assert.strictEqual(session.state, "HUMAN_CONTROL");
    assert.strictEqual(session.activeController, "human");
    assert.ok(takeover.takeoverUrl.includes(session.id));

    // 3. Reject invalid state transitions
    assert.throws(() => {
      client.confirmAuthenticationVerified(session.id);
    }, /not in VERIFY_AUTHENTICATION state/);

    // 4. Transition to VERIFY_AUTHENTICATION
    const completion = client.signalHumanComplete(session.id);
    assert.strictEqual(completion.state, "VERIFY_AUTHENTICATION");
    assert.strictEqual(session.activeController, "agent");

    // 5. Cannot signalHumanComplete again when already verifying
    assert.throws(() => {
      client.signalHumanComplete(session.id);
    }, /not in HUMAN_CONTROL state/);

    // 6. Confirm verified and restore AGENT_CONTROL
    const verified = client.confirmAuthenticationVerified(session.id);
    assert.strictEqual(verified.state, "AGENT_CONTROL");
    assert.strictEqual(verified.activeController, "agent");
    assert.strictEqual(verified.takeoverReason, undefined);

    // 7. Release session and confirm takeover cannot be initiated on released session
    await client.releaseSession(session.id);
    assert.throws(() => {
      client.requestHumanTakeover(session.id, "test");
    }, /not tracked/);
  });

  it("handles stateless scrape and screenshot", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
    });

    const scrapeRes = await client.scrape("https://example.com");
    assert.strictEqual(scrapeRes.metadata.title, "Test Title");
    assert.ok(scrapeRes.content.html.includes("Scraped: https://example.com"));

    const shotRes = await client.screenshot("https://example.com", true);
    assert.strictEqual(shotRes.url, "https://example.com");
    assert.ok(shotRes.base64);
  });

  it("detects orphaned sessions based on inactivity and untracked status", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
    });

    const session = await client.createSession();

    // Create an untracked session directly on mock server
    mockSessions.set("untracked-orphan-1", {
      id: "untracked-orphan-1",
      status: "live",
      duration: 700000,
    });

    // Create an inactive tracked session
    const inactiveTracked = await client.createSession();
    inactiveTracked.lastActiveAt = Date.now() - 600000;

    // Create a tracked session in HUMAN_CONTROL (must not be treated as orphan)
    const humanSession = await client.createSession();
    client.requestHumanTakeover(humanSession.id, "User login");
    humanSession.lastActiveAt = Date.now() - 600000;

    const orphans = await client.checkOrphanedSessions(500000);
    assert.ok(orphans.includes("untracked-orphan-1"));
    assert.ok(orphans.includes(inactiveTracked.id));
    assert.ok(!orphans.includes(session.id));
    assert.ok(!orphans.includes(humanSession.id));
  });

  it("creates structured section annotation feedback and formats agent prompt", () => {
    const feedback = createAnnotationFeedback({
      sessionId: "sess_test_123",
      url: "https://app.example.com/settings/billing",
      sectionSelector: ".billing-card",
      screenshotPath: ".kxm/artifacts/browser/billing.png",
      overallSummary: "Pricing badge overflows card border",
      annotations: [
        {
          label: "Badge Overflow",
          selector: ".badge-enterprise",
          note: "Badge text clips on mobile screen widths",
          severity: "fix",
          boundingBox: { x: 10, y: 20, width: 150, height: 40 },
        },
      ],
      requestedChanges: [
        "Add flex-wrap to header container",
        "Add text truncation to badge",
      ],
    });

    assert.strictEqual(feedback.sectionSelector, ".billing-card");
    assert.ok(feedback.capturedAt);
    assert.strictEqual(feedback.annotations.length, 1);
    assert.strictEqual(feedback.annotations[0]?.severity, "fix");

    const promptText = formatAnnotationFeedbackPrompt(feedback);
    assert.ok(promptText.includes("## Visual Feedback & Section Annotation"));
    assert.ok(promptText.includes("Pricing badge overflows card border"));
    assert.ok(promptText.includes("[FIX]"));
    assert.ok(promptText.includes("Badge Overflow"));
    assert.ok(promptText.includes("x=10, y=20, w=150, h=40"));
    assert.ok(promptText.includes("- [ ] Add flex-wrap to header container"));

    // Test prompt with minimal feedback
    const minimalFeedback = createAnnotationFeedback({
      url: "https://example.com",
      overallSummary: "Clean review",
      annotations: [],
      requestedChanges: [],
    });
    const minimalPrompt = formatAnnotationFeedbackPrompt(minimalFeedback);
    assert.ok(minimalPrompt.includes("https://example.com"));
    assert.ok(minimalPrompt.includes("Clean review"));
  });

  it("resolves standard viewport presets for multi-device testing", () => {
    assert.strictEqual(VIEWPORT_PRESETS["mobile"]?.width, 393);
    assert.strictEqual(VIEWPORT_PRESETS["mobile"]?.height, 852);
    assert.strictEqual(VIEWPORT_PRESETS["tablet"]?.width, 820);
    assert.strictEqual(VIEWPORT_PRESETS["desktop"]?.width, 1920);

    const resolvedDefault = resolveViewportDimensions();
    assert.deepStrictEqual(resolvedDefault, { width: 1920, height: 1080 });

    const resolvedUnknown = resolveViewportDimensions("non-existent-preset");
    assert.deepStrictEqual(resolvedUnknown, { width: 1920, height: 1080 });

    const resolvedMobile = resolveViewportDimensions("mobile");
    assert.deepStrictEqual(resolvedMobile, { width: 393, height: 852 });

    const resolvedDesktop = resolveViewportDimensions("desktop");
    assert.deepStrictEqual(resolvedDesktop, { width: 1920, height: 1080 });

    const custom = resolveViewportDimensions({ width: 800, height: 600 });
    assert.deepStrictEqual(custom, { width: 800, height: 600 });
  });

  it("sends Authentik Basic auth on HTTP and CDP and keeps credentials out of URLs", async () => {
    const saved = snapshotSteelEnv();
    const user = "svc-steel";
    const token = "app-password-not-a-bearer";
    const expected = `Basic ${Buffer.from(`${user}:${token}`, "utf8").toString("base64")}`;
    try {
      delete process.env.STEEL_API_KEY;
      delete process.env.STEEL_AUTH_HEADER;
      delete process.env.STEEL_AUTH_BASIC;
      delete process.env.PASS_CLI_OUTPUT_MOCK;
      process.env.USE_PASS_CLI = "false";
      process.env.STEEL_AUTH_USER = user;
      process.env.STEEL_AUTH_TOKEN = token;

      resetLegacySteelAuthWarningForTests();
      const warned = captureStderr(() => {
        const config = resolveSteelConfig({ apiUrl: serverUrl });
        assert.strictEqual(config.authorization, expected);
        assert.strictEqual(config.apiKey, undefined);
      });
      assert.strictEqual(warned, "");

      const client = new SteelClient({ apiUrl: serverUrl });
      const session = await client.createSession();
      assert.strictEqual(lastHeaders.authorization, expected);
      assert.strictEqual(lastHeaders["x-steel-api-key"], undefined);
      assert.ok(!JSON.stringify(lastHeaders).includes(token));

      const connect = client.cdpConnectOptions(session);
      const parsed = new URL(connect.url);
      assert.strictEqual(parsed.searchParams.get("sessionId"), session.id);
      assert.strictEqual(parsed.searchParams.get("apiKey"), null);
      assert.strictEqual(connect.headers.Authorization, expected);
      assert.strictEqual(connect.headers["x-steel-api-key"], undefined);
      assert.ok(!connect.url.includes(token));
      assert.ok(!connect.url.includes(expected.slice("Basic ".length)));

      await client.getSession(session.id);
      assert.strictEqual(lastHeaders.authorization, expected);
      await client.releaseSession(session.id);
      assert.strictEqual(lastHeaders.authorization, expected);
    } finally {
      restoreSteelEnv(saved);
    }
  });

  it("resolves Basic auth from STEEL_AUTH_BASIC, STEEL_AUTH_HEADER, and user plus token", () => {
    const saved = snapshotSteelEnv();
    const credential = Buffer.from("svc-steel:app-password", "utf8").toString("base64");
    try {
      for (const name of steelAuthEnv) delete process.env[name];
      process.env.USE_PASS_CLI = "false";
      process.env.STEEL_API_KEY = "legacy-key-should-not-be-sent";
      process.env.STEEL_AUTH_BASIC = `Basic ${credential}`;
      process.env.STEEL_AUTH_USER = "other-user";
      process.env.STEEL_AUTH_TOKEN = "other-token";

      const fromBasic = resolveSteelConfig({ apiUrl: "https://steel.example.com" });
      assert.strictEqual(fromBasic.authorization, `Basic ${credential}`);
      assert.strictEqual(fromBasic.apiKey, undefined);

      process.env.STEEL_AUTH_HEADER = "Bearer should-stay-verbatim";
      const fromHeader = resolveSteelConfig();
      assert.strictEqual(fromHeader.authorization, "Bearer should-stay-verbatim");

      delete process.env.STEEL_AUTH_HEADER;
      delete process.env.STEEL_AUTH_BASIC;
      const fromPair = resolveSteelAuthorization();
      assert.strictEqual(fromPair, `Basic ${Buffer.from("other-user:other-token", "utf8").toString("base64")}`);

      const override = resolveSteelConfig({
        authBasic: credential,
        authHeader: undefined,
        apiKey: "constructor-key",
      });
      assert.strictEqual(override.authorization, `Basic ${credential}`);
      assert.strictEqual(override.apiKey, undefined);

      const bare = resolveSteelAuthorization({ authBasic: credential });
      assert.strictEqual(bare, `Basic ${credential}`);
    } finally {
      restoreSteelEnv(saved);
    }
  });

  it("fails closed when only one of STEEL_AUTH_USER or STEEL_AUTH_TOKEN is set", () => {
    const saved = snapshotSteelEnv();
    const secret = "super-secret-app-password";
    try {
      for (const name of steelAuthEnv) delete process.env[name];
      process.env.USE_PASS_CLI = "false";
      process.env.STEEL_AUTH_TOKEN = secret;
      assert.throws(() => resolveSteelConfig(), SteelAuthConfigError);
      try {
        resolveSteelConfig();
      } catch (error) {
        assert.ok(error instanceof SteelAuthConfigError);
        assert.ok(!error.message.includes(secret));
        assert.match(error.message, /STEEL_AUTH_USER and STEEL_AUTH_TOKEN/);
      }

      delete process.env.STEEL_AUTH_TOKEN;
      process.env.STEEL_AUTH_USER = "svc-steel";
      process.env.STEEL_AUTH_BASIC = "dXNlcjp0b2tlbg==\nleaked-tail";
      assert.throws(() => resolveSteelAuthorization(), /line break/);
      try {
        resolveSteelAuthorization();
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("leaked-tail"));
      }
    } finally {
      restoreSteelEnv(saved);
    }
  });

  it("keeps the legacy API key header and query param, and warns once", async () => {
    const saved = snapshotSteelEnv();
    const legacyKey = "steel_legacy_key_value";
    try {
      for (const name of steelAuthEnv) delete process.env[name];
      process.env.USE_PASS_CLI = "false";
      process.env.STEEL_API_KEY = legacyKey;
      resetLegacySteelAuthWarningForTests();

      const first = captureStderr(() => {
        const config = resolveSteelConfig({ apiUrl: serverUrl });
        assert.strictEqual(config.apiKey, legacyKey);
        assert.strictEqual(config.authorization, undefined);
        assert.deepStrictEqual(steelRequestHeaders(config), { "x-steel-api-key": legacyKey });
        const connect = formatCDPConnect({ id: "sess_legacy", websocketUrl: "" }, config);
        assert.ok(connect.url.includes("apiKey=steel_legacy_key_value"));
        assert.strictEqual(connect.headers["x-steel-api-key"], legacyKey);
        assert.strictEqual(connect.headers.Authorization, undefined);
      });
      assert.match(first, /STEEL_API_KEY is deprecated/);
      assert.ok(!first.includes(legacyKey));

      const second = captureStderr(() => {
        resolveSteelConfig({ apiUrl: serverUrl });
      });
      assert.strictEqual(second, "");

      const client = new SteelClient({ apiUrl: serverUrl });
      await client.createSession();
      assert.strictEqual(lastHeaders["x-steel-api-key"], legacyKey);
      assert.strictEqual(lastHeaders.authorization, undefined);
    } finally {
      restoreSteelEnv(saved);
    }
  });

  it("does not consult pass-cli or the legacy key when Basic auth is configured", () => {
    const saved = snapshotSteelEnv();
    try {
      for (const name of steelAuthEnv) delete process.env[name];
      process.env.USE_PASS_CLI = "true";
      process.env.PASS_CLI_OUTPUT_MOCK = JSON.stringify({
        item: {
          content: {
            extra_fields: [{ name: "STEEL_API_KEY", content: { Hidden: "steel_from_pass_cli" } }],
          },
        },
      });
      process.env.STEEL_AUTH_BASIC = Buffer.from("svc-steel:token", "utf8").toString("base64");
      resetLegacySteelAuthWarningForTests();
      const stderr = captureStderr(() => {
        const config = resolveSteelConfig();
        assert.strictEqual(config.apiKey, undefined);
        assert.ok(config.authorization?.startsWith("Basic "));
      });
      assert.strictEqual(stderr, "");
    } finally {
      restoreSteelEnv(saved);
    }
  });

  it("reports an Authentik redirect without following it or echoing credentials", async () => {
    const saved = snapshotSteelEnv();
    const token = "redirect-secret-token";
    try {
      for (const name of steelAuthEnv) delete process.env[name];
      process.env.USE_PASS_CLI = "false";
      process.env.STEEL_AUTH_USER = "svc-steel";
      process.env.STEEL_AUTH_TOKEN = token;
      shouldRedirect = true;

      const client = new SteelClient({ apiUrl: serverUrl });
      await assert.rejects(client.createSession(), (error: unknown) => {
        assert.ok(error instanceof SteelAuthRedirectError);
        assert.strictEqual(error.status, 302);
        assert.strictEqual(error.host, "id.kxmd.dev");
        assert.match(error.message, /Authorization: Basic/);
        assert.ok(!error.message.includes(token));
        assert.ok(!error.message.includes("default-authentication-flow"));
        return true;
      });
      assert.strictEqual(lastHeaders.authorization, `Basic ${Buffer.from(`svc-steel:${token}`, "utf8").toString("base64")}`);

      await assert.rejects(client.checkOrphanedSessions(), SteelAuthRedirectError);
      await assert.rejects(client.releaseSession("any-id"), SteelAuthRedirectError);
    } finally {
      restoreSteelEnv(saved);
    }
  });

  it("redacts Basic credentials and authorization query values", () => {
    const token = "c3ZjLXN0ZWVsOmFwcC1wYXNzd29yZA==";
    const raw = `wss://steel.kontextmind.com/v1/devtools?sessionId=abc&authorization=Basic%20${token}`;
    const sanitized = sanitizeLogOutput(`Authorization: Basic ${token} ${raw}`);
    assert.ok(!sanitized.includes(token));
    assert.match(sanitized, /authorization: \[REDACTED\]/);
    assert.match(sanitized, /authorization=\[REDACTED\]/);
    assert.match(sanitizeLogOutput("Use Basic authentication for this host"), /Basic authentication/);
  });
});

describe("resolveBrowserCdpEndpoint", () => {
  const keys = ["KXM_BROWSER", "OBSCURA_CDP_URL", "OBSCURA_PORT", "STEEL_API_URL", "STEEL_API_KEY", "STEEL_UI_URL", "USE_PASS_CLI"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("defaults to Obscura on loopback and honors OBSCURA_CDP_URL and OBSCURA_PORT", () => {
    assert.strictEqual(resolveObscuraCdpEndpoint(), DEFAULT_OBSCURA_CDP_URL);
    assert.strictEqual(resolveBrowserCdpEndpoint(), DEFAULT_OBSCURA_CDP_URL);

    process.env.KXM_BROWSER = "  Obscura  ";
    process.env.OBSCURA_CDP_URL = "  ws://127.0.0.1:9222  ";
    assert.strictEqual(resolveBrowserCdpEndpoint(), "ws://127.0.0.1:9222");

    process.env.OBSCURA_CDP_URL = "   ";
    process.env.OBSCURA_PORT = "9333";
    assert.strictEqual(resolveBrowserCdpEndpoint(), "http://127.0.0.1:9333");

    process.env.OBSCURA_PORT = "9222";
    assert.strictEqual(resolveBrowserCdpEndpoint(), DEFAULT_OBSCURA_CDP_URL);

    process.env.OBSCURA_PORT = "65535";
    assert.strictEqual(resolveObscuraCdpEndpoint(), "http://127.0.0.1:65535");
  });

  it("rejects a bad Obscura port, an unknown browser, and steel without a session", () => {
    process.env.OBSCURA_PORT = "nope";
    assert.throws(() => resolveObscuraCdpEndpoint(), /OBSCURA_PORT must be an integer/);
    process.env.OBSCURA_PORT = "0";
    assert.throws(() => resolveBrowserCdpEndpoint(), /OBSCURA_PORT must be an integer/);
    process.env.OBSCURA_PORT = "65536";
    assert.throws(() => resolveBrowserCdpEndpoint(), /OBSCURA_PORT must be an integer/);

    delete process.env.OBSCURA_PORT;
    process.env.KXM_BROWSER = "chrome";
    assert.throws(() => resolveBrowserCdpEndpoint(), /Unsupported KXM_BROWSER/);

    process.env.KXM_BROWSER = "steel";
    assert.throws(() => resolveBrowserCdpEndpoint(), /requires a Steel session id/);
    assert.throws(() => resolveBrowserCdpEndpoint({ id: "", websocketUrl: "" }), /requires a Steel session id/);
  });

  it("uses the Steel session CDP endpoint only when KXM_BROWSER=steel", () => {
    process.env.KXM_BROWSER = " Steel ";
    process.env.OBSCURA_CDP_URL = "http://127.0.0.1:9222";
    const session = { id: "sess_12345", websocketUrl: "ws://ignored" };
    const config = {
      apiUrl: "https://steel.example.com",
      apiKey: "steel_secret_key",
      uiUrl: "https://steel.example.com/ui",
    };
    const endpoint = resolveBrowserCdpEndpoint(session, config);
    assert.strictEqual(endpoint, formatCDPEndpoint(session, config));
    assert.ok(endpoint.startsWith("wss://steel.example.com/v1/devtools?"));
    assert.ok(endpoint.includes("sessionId=sess_12345"));
    assert.ok(!endpoint.includes("127.0.0.1"));

    delete process.env.OBSCURA_CDP_URL;
    process.env.USE_PASS_CLI = "false";
    process.env.STEEL_API_URL = "http://steel.env.local";
    process.env.STEEL_API_KEY = "steel_envkey123";
    const fromEnv = resolveBrowserCdpEndpoint(session);
    assert.ok(fromEnv.startsWith("ws://steel.env.local/v1/devtools?"));
    assert.ok(fromEnv.includes("apiKey=steel_envkey123"));
  });
});

describe("obscura launcher", () => {
  it("pins Obscura v0.2.3 and refuses a port that disagrees with OBSCURA_CDP_URL", () => {
    const source = readFileSync("scripts/obscura.mjs", "utf8");
    assert.match(source, /const OBSCURA_VERSION = "v0\.2\.3"/);
    assert.match(source, /obscura-x86_64-linux\.tar\.gz/);
    assert.match(source, /1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec/);
    assert.match(source, /--allow-private-network/);
    assert.match(source, /\/json\/version/);
    assert.doesNotMatch(source, /playwright install/);

    const mismatch = spawnSync(process.execPath, ["scripts/obscura.mjs", "--ensure"], {
      encoding: "utf8",
      env: { ...process.env, OBSCURA_PORT: "9222", OBSCURA_CDP_URL: "http://127.0.0.1:9333" },
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /OBSCURA_PORT=9222 does not match/);

    const help = spawnSync(process.execPath, ["scripts/obscura.mjs", "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--ensure/);
    assert.match(help.stdout, /--stop/);
  });
});
