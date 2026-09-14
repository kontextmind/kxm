import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import http from "node:http";
import {
  SteelClient,
  resolveSteelConfig,
  formatCDPEndpoint,
  sanitizeLogOutput,
  createAnnotationFeedback,
  formatAnnotationFeedbackPrompt,
  resolveViewportDimensions,
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

  beforeEach(async () => {
    mockSessions.clear();
    shouldFailNext = false;
    shouldReturn500 = false;

    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

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
      process.env.USE_PASS_CLI = "true";

      // With pass-cli enabled on this test runner, it should resolve or catch cleanly
      const cfg = resolveSteelConfig();
      assert.ok(cfg.apiUrl);
      assert.ok(cfg.uiUrl);

      process.env.STEEL_API_URL = "https://steel.env.local";
      process.env.STEEL_API_KEY = "steel_envkey123";
      process.env.STEEL_UI_URL = "https://steel.env.local/custom-ui";
      process.env.USE_PASS_CLI = "false";

      const configFromEnv = resolveSteelConfig();
      assert.strictEqual(configFromEnv.apiUrl, "https://steel.env.local");
      assert.strictEqual(configFromEnv.apiKey, "steel_envkey123");
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
});
