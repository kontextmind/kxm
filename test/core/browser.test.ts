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
  type SteelSession,
} from "../../plugins/kxm/src/browser.ts";

describe("KXM Browser & Steel Integration", () => {
  let server: http.Server;
  let serverUrl: string;
  let serverPort: number;

  const mockSessions = new Map<string, any>();

  beforeEach(async () => {
    mockSessions.clear();
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          const id = `mock-session-${Date.now()}`;
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

  it("resolves steel config with secure defaults and overrides", () => {
    const config = resolveSteelConfig({
      apiUrl: "https://steel.test.local",
      apiKey: "steel_testkey12345",
    });

    assert.strictEqual(config.apiUrl, "https://steel.test.local");
    assert.strictEqual(config.apiKey, "steel_testkey12345");
    assert.strictEqual(config.uiUrl, "https://steel.test.local/ui");
    assert.strictEqual(config.timeoutMs, 300000);
  });

  it("formats remote CDP endpoint cleanly with session ID and auth", () => {
    const config = {
      apiUrl: "https://steel.kontextmind.com",
      apiKey: "steel_secret_key",
      uiUrl: "https://steel.kontextmind.com/ui",
    };
    const session = {
      id: "sess_12345",
      websocketUrl: "ws://0.0.0.0:3000/",
    };

    const cdpUrl = formatCDPEndpoint(session, config);
    assert.ok(cdpUrl.startsWith("wss://steel.kontextmind.com/v1/devtools?"));
    assert.ok(cdpUrl.includes("sessionId=sess_12345"));
    assert.ok(cdpUrl.includes("apiKey=steel_secret_key"));
  });

  it("sanitizes and redacts secrets in logs and diagnostic outputs", () => {
    const rawUrl = "wss://steel.kontextmind.com/v1/devtools?sessionId=123&apiKey=steel_998877665544332211";
    const sanitizedUrl = sanitizeLogOutput(rawUrl);
    assert.strictEqual(sanitizedUrl, "wss://steel.kontextmind.com/v1/devtools?sessionId=123&apiKey=[REDACTED]");

    const rawObj = {
      sessionId: "123",
      apiKey: "steel_secret123",
      headers: {
        "x-steel-api-key": "steel_secret123",
      },
      nested: {
        token: "jwt.secret.here",
        url: "https://example.com",
      },
    };
    const sanitizedObj = sanitizeLogOutput(rawObj) as any;
    assert.strictEqual(sanitizedObj.apiKey, "[REDACTED]");
    assert.strictEqual(sanitizedObj.headers["x-steel-api-key"], "[REDACTED]");
    assert.strictEqual(sanitizedObj.nested.token, "[REDACTED]");
    assert.strictEqual(sanitizedObj.nested.url, "https://example.com");
  });

  it("manages session lifecycle (create, inspect, release)", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
      timeoutMs: 60000,
    });

    const session = await client.createSession({
      userAgent: "TestRunner/1.0",
      dimensions: { width: 1280, height: 800 },
    });

    assert.ok(session.id);
    assert.strictEqual(session.status, "live");
    assert.strictEqual(session.state, "AGENT_CONTROL");
    assert.strictEqual(session.activeController, "agent");
    assert.strictEqual(session.timeoutMs, 60000);

    const fetched = await client.getSession(session.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.id, session.id);

    const released = await client.releaseSession(session.id);
    assert.strictEqual(released, true);

    const afterRelease = await client.getSession(session.id);
    assert.strictEqual(afterRelease?.status, "released");
  });

  it("enforces human takeover protocol state transitions and exclusive ownership", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
    });

    const session = await client.createSession();
    assert.strictEqual(session.state, "AGENT_CONTROL");
    assert.strictEqual(session.activeController, "agent");

    // 1. Initiate human takeover for MFA
    const takeover = client.requestHumanTakeover(session.id, "MFA prompt encountered on dashboard login");
    assert.strictEqual(session.state, "HUMAN_CONTROL");
    assert.strictEqual(session.activeController, "human");
    assert.ok(takeover.takeoverUrl.includes(session.id));
    assert.ok(takeover.instructions.includes("HUMAN TAKEOVER REQUIRED"));

    // 2. Reject invalid transitions while human has control
    assert.throws(() => {
      client.confirmAuthenticationVerified(session.id);
    }, /not in VERIFY_AUTHENTICATION state/);

    // 3. Human completes action and signals completion
    const completion = client.signalHumanComplete(session.id);
    assert.strictEqual(completion.state, "VERIFY_AUTHENTICATION");
    assert.strictEqual(session.activeController, "agent");

    // 4. Verify authenticated state before resuming agent automation
    const verified = client.confirmAuthenticationVerified(session.id);
    assert.strictEqual(verified.state, "AGENT_CONTROL");
    assert.strictEqual(verified.activeController, "agent");
    assert.strictEqual(verified.takeoverReason, undefined);
  });

  it("handles stateless scrape and screenshot", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
    });

    const scrapeRes = await client.scrape("https://example.com");
    assert.strictEqual(scrapeRes.metadata.title, "Test Title");
    assert.ok(scrapeRes.content.html.includes("Scraped: https://example.com"));

    const shotRes = await client.screenshot("https://example.com");
    assert.strictEqual(shotRes.url, "https://example.com");
    assert.ok(shotRes.base64);
  });

  it("detects orphaned sessions based on inactivity and untracked status", async () => {
    const client = new SteelClient({
      apiUrl: serverUrl,
      apiKey: "test_key",
    });

    // Create a tracked session
    const session = await client.createSession();

    // Create an untracked session directly on mock server
    mockSessions.set("untracked-orphan-1", {
      id: "untracked-orphan-1",
      status: "live",
      duration: 700000,
    });

    const orphans = await client.checkOrphanedSessions(500000);
    assert.ok(orphans.includes("untracked-orphan-1"));
    assert.ok(!orphans.includes(session.id));
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
  });
});
