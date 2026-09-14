/**
 * KXM Browser Automation & Steel Session Client
 *
 * Lightweight, harness-agnostic client for self-hosted Steel on DOKS.
 * Manages remote browser sessions, CDP endpoints, human takeover handoffs,
 * pass-cli credential references, and automated cleanup without leaking secrets.
 */

import { execSync } from "node:child_process";

export type SessionState =
  | "AGENT_CONTROL"
  | "AUTH_REQUIRED"
  | "HUMAN_CONTROL"
  | "VERIFY_AUTHENTICATION"
  | "RELEASED"
  | "EXPIRED"
  | "FAILED";

export interface SteelSession {
  id: string;
  createdAt: string;
  status: "idle" | "live" | "released" | "failed";
  state: SessionState;
  websocketUrl: string;
  debugUrl: string;
  debuggerUrl: string;
  sessionViewerUrl: string;
  timeoutMs: number;
  lastActiveAt: number;
  activeController: "agent" | "human" | "none";
  takeoverReason?: string | undefined;
  userAgent?: string | undefined;
}

export interface CreateSessionOptions {
  timeoutMs?: number | undefined;
  dimensions?: { width: number; height: number } | undefined;
  userAgent?: string | undefined;
  proxy?: string | undefined;
}

export interface ScrapeResult {
  content: {
    html: string;
  };
  metadata: {
    statusCode: number;
    title: string;
    description?: string | undefined;
    language?: string | undefined;
    urlSource: string;
    timestamp: string;
  };
  links: Array<{ url: string; text: string }>;
}

export interface ScreenshotResult {
  path?: string | undefined;
  base64?: string | undefined;
  url: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationItem {
  id?: string | undefined;
  label: string;
  note: string;
  selector?: string | undefined;
  boundingBox?: BoundingBox | undefined;
  severity?: "suggestion" | "fix" | "blocker" | undefined;
}

export interface AnnotationFeedback {
  sessionId?: string | undefined;
  url: string;
  sectionSelector?: string | undefined;
  screenshotBase64?: string | undefined;
  screenshotPath?: string | undefined;
  annotations: AnnotationItem[];
  overallSummary: string;
  requestedChanges: string[];
  capturedAt: string;
}

export interface SteelConfig {
  apiUrl: string;
  apiKey?: string | undefined;
  uiUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Resolve Steel configuration from environment or pass-cli.
 * Does not write secrets to disk or logs.
 */
export function resolveSteelConfig(overrides?: Partial<SteelConfig>): SteelConfig {
  const apiUrl =
    overrides?.apiUrl ||
    process.env.STEEL_API_URL ||
    "https://steel.kontextmind.com";

  let apiKey = overrides?.apiKey || process.env.STEEL_API_KEY;

  if (!apiKey && typeof process !== "undefined" && process.env.USE_PASS_CLI !== "false") {
    try {
      const output = execSync(
        'pass-cli item view --vault-name "AI Provider Keys" --item-title "Steel Browser (KontextMind DOKS)" --output json',
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 5000 }
      );
      const parsed = JSON.parse(output);
      const extraFields = parsed?.item?.content?.extra_fields || [];
      const customSections = parsed?.item?.content?.content?.Custom?.sections || [];
      const sectionFields = customSections.flatMap((s: any) => s.section_fields || []);
      const allFields = [...extraFields, ...sectionFields];

      const hiddenKey = allFields.find((f: any) => f.name === "STEEL_API_KEY")?.content?.Hidden;
      if (hiddenKey) {
        apiKey = hiddenKey;
      }
    } catch {
      // pass-cli unavailable or item not found; continue with undefined apiKey
    }
  }

  const uiUrl =
    overrides?.uiUrl ||
    process.env.STEEL_UI_URL ||
    `${apiUrl.replace(/\/$/, "")}/ui`;

  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    apiKey,
    uiUrl,
    timeoutMs: overrides?.timeoutMs || 300000, // 5 minutes default
  };
}

/**
 * Format a remote CDP connection URL for Playwright or agent-browser.
 */
export function formatCDPEndpoint(session: Pick<SteelSession, "id" | "websocketUrl">, config: SteelConfig): string {
  const baseApi = config.apiUrl;
  const urlObj = new URL(baseApi);
  const isSecure = urlObj.protocol === "https:";
  const wsProtocol = isSecure ? "wss:" : "ws:";
  const host = urlObj.host;

  const searchParams = new URLSearchParams();
  searchParams.set("sessionId", session.id);
  if (config.apiKey) {
    searchParams.set("apiKey", config.apiKey);
  }

  return `${wsProtocol}//${host}/v1/devtools?${searchParams.toString()}`;
}

/**
 * Redact sensitive API keys and tokens from URLs and objects for logging.
 */
export function sanitizeLogOutput<T>(input: T): T {
  if (typeof input === "string") {
    return input.replace(/apiKey=[^&]+/g, "apiKey=[REDACTED]").replace(/steel_[a-f0-9]+/g, "steel_[REDACTED]") as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map(sanitizeLogOutput) as unknown as T;
  }
  if (input !== null && typeof input === "object") {
    const copy: Record<string, any> = {};
    for (const [k, v] of Object.entries(input)) {
      if (/key|secret|token|auth|password/i.test(k) && typeof v === "string") {
        copy[k] = "[REDACTED]";
      } else {
        copy[k] = sanitizeLogOutput(v);
      }
    }
    return copy as T;
  }
  return input;
}

/**
 * Create a structured annotation feedback package from captured section data.
 */
export function createAnnotationFeedback(
  feedback: Omit<AnnotationFeedback, "capturedAt"> & { capturedAt?: string }
): AnnotationFeedback {
  return {
    ...feedback,
    capturedAt: feedback.capturedAt || new Date().toISOString(),
  };
}

/**
 * Format structured visual annotations and requested UI changes into a
 * clear, actionable prompt block that an agent can parse and execute.
 */
export function formatAnnotationFeedbackPrompt(feedback: AnnotationFeedback): string {
  let output = `## Visual Feedback & Section Annotation\n\n`;
  output += `- **Target URL**: ${feedback.url}\n`;
  if (feedback.sessionId) {
    output += `- **Session ID**: ${feedback.sessionId}\n`;
  }
  if (feedback.sectionSelector) {
    output += `- **Section Target Selector**: \`${feedback.sectionSelector}\`\n`;
  }
  if (feedback.screenshotPath) {
    output += `- **Screenshot Artifact**: \`${feedback.screenshotPath}\`\n`;
  }
  output += `- **Captured At**: ${feedback.capturedAt}\n\n`;

  output += `### Summary\n${feedback.overallSummary}\n\n`;

  if (feedback.annotations.length > 0) {
    output += `### Annotated Elements & Notes\n\n`;
    feedback.annotations.forEach((item, idx) => {
      output += `${idx + 1}. **${item.label}**`;
      if (item.severity) {
        output += ` [${item.severity.toUpperCase()}]`;
      }
      output += `\n   - **Note**: ${item.note}\n`;
      if (item.selector) {
        output += `   - **Selector**: \`${item.selector}\`\n`;
      }
      if (item.boundingBox) {
        output += `   - **Region (Box)**: x=${item.boundingBox.x}, y=${item.boundingBox.y}, w=${item.boundingBox.width}, h=${item.boundingBox.height}\n`;
      }
    });
    output += `\n`;
  }

  if (feedback.requestedChanges.length > 0) {
    output += `### Actionable Change List\n\n`;
    feedback.requestedChanges.forEach((change, idx) => {
      output += `- [ ] ${change}\n`;
    });
  }

  return output;
}

/**
 * Steel Browser Session Manager & Handoff Orchestrator.
 */
export class SteelClient {
  private config: SteelConfig;
  private activeSessions = new Map<string, SteelSession>();

  constructor(config?: Partial<SteelConfig>) {
    this.config = resolveSteelConfig(config);
  }

  getConfig(): Readonly<SteelConfig> {
    return { ...this.config };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      h["x-steel-api-key"] = this.config.apiKey;
    }
    return h;
  }

  /**
   * Launch a new Steel browser session on DOKS.
   */
  async createSession(options?: CreateSessionOptions): Promise<SteelSession> {
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs ?? 300000;
    const body: Record<string, any> = {
      timeout: timeoutMs,
    };
    if (options?.dimensions) {
      body.dimensions = options.dimensions;
    }
    if (options?.userAgent) {
      body.userAgent = options.userAgent;
    }
    if (options?.proxy) {
      body.proxy = options.proxy;
    }

    const res = await fetch(`${this.config.apiUrl}/v1/sessions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create Steel session (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const session: SteelSession = {
      id: data.id,
      createdAt: data.createdAt || new Date().toISOString(),
      status: "live",
      state: "AGENT_CONTROL",
      websocketUrl: data.websocketUrl || "",
      debugUrl: data.debugUrl || "",
      debuggerUrl: data.debuggerUrl || "",
      sessionViewerUrl: data.sessionViewerUrl || `${this.config.uiUrl}?sessionId=${data.id}`,
      timeoutMs,
      lastActiveAt: Date.now(),
      activeController: "agent",
      userAgent: data.userAgent,
    };

    this.activeSessions.set(session.id, session);
    return session;
  }

  /**
   * Get details of an existing session.
   */
  async getSession(sessionId: string): Promise<SteelSession | null> {
    const res = await fetch(`${this.config.apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: this.headers(),
    });

    if (res.status === 404) {
      const cached = this.activeSessions.get(sessionId);
      if (cached) {
        cached.state = "EXPIRED";
        cached.status = "released";
        cached.activeController = "none";
      }
      return null;
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch Steel session (${res.status})`);
    }

    const data = await res.json();
    const existing = this.activeSessions.get(sessionId);
    const session: SteelSession = {
      id: data.id,
      createdAt: data.createdAt,
      status: data.status,
      state: existing?.state ?? (data.status === "live" ? "AGENT_CONTROL" : "RELEASED"),
      websocketUrl: data.websocketUrl || existing?.websocketUrl || "",
      debugUrl: data.debugUrl || existing?.debugUrl || "",
      debuggerUrl: data.debuggerUrl || existing?.debuggerUrl || "",
      sessionViewerUrl: existing?.sessionViewerUrl || `${this.config.uiUrl}?sessionId=${data.id}`,
      timeoutMs: data.timeout || existing?.timeoutMs || 300000,
      lastActiveAt: Date.now(),
      activeController: existing?.activeController ?? (data.status === "live" ? "agent" : "none"),
      userAgent: data.userAgent,
    };

    this.activeSessions.set(session.id, session);
    return session;
  }

  /**
   * Request human takeover for MFA, login, or consent.
   * Pauses agent automation and sets state to HUMAN_CONTROL.
   */
  requestHumanTakeover(sessionId: string, reason: string): {
    session: SteelSession;
    takeoverUrl: string;
    instructions: string;
  } {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not tracked or already released`);
    }
    if (session.state === "RELEASED" || session.state === "EXPIRED" || session.state === "FAILED") {
      throw new Error(`Cannot initiate takeover on session in state ${session.state}`);
    }

    session.state = "HUMAN_CONTROL";
    session.activeController = "human";
    session.takeoverReason = reason;
    session.lastActiveAt = Date.now();

    const takeoverUrl = `${this.config.uiUrl}?sessionId=${encodeURIComponent(sessionId)}`;
    const instructions =
      `[HUMAN TAKEOVER REQUIRED]\n` +
      `Reason: ${reason}\n` +
      `Session ID: ${session.id}\n` +
      `Takeover URL: ${takeoverUrl}\n\n` +
      `Instructions for Operator:\n` +
      `1. Open the URL above to access the session UI.\n` +
      `2. Perform the required authentication / MFA / consent action.\n` +
      `3. Return to the terminal and signal completion. Automation is paused until you confirm.`;

    return {
      session,
      takeoverUrl,
      instructions,
    };
  }

  /**
   * Signal that human takeover is complete.
   * Moves state to VERIFY_AUTHENTICATION before transitioning back to AGENT_CONTROL.
   */
  signalHumanComplete(sessionId: string): {
    session: SteelSession;
    state: SessionState;
  } {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not tracked or already released`);
    }
    if (session.state !== "HUMAN_CONTROL") {
      throw new Error(`Session ${sessionId} is not in HUMAN_CONTROL state (currently ${session.state})`);
    }

    session.state = "VERIFY_AUTHENTICATION";
    session.activeController = "agent";
    session.lastActiveAt = Date.now();

    return {
      session,
      state: session.state,
    };
  }

  /**
   * Confirm authentication verification passed and restore AGENT_CONTROL.
   */
  confirmAuthenticationVerified(sessionId: string): SteelSession {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not tracked or already released`);
    }
    if (session.state !== "VERIFY_AUTHENTICATION") {
      throw new Error(`Session ${sessionId} is not in VERIFY_AUTHENTICATION state (currently ${session.state})`);
    }

    session.state = "AGENT_CONTROL";
    session.activeController = "agent";
    session.takeoverReason = undefined;
    session.lastActiveAt = Date.now();

    return session;
  }

  /**
   * Gracefully release a session.
   */
  async releaseSession(sessionId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}/release`, {
        method: "POST",
        headers: this.headers(),
      });

      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.status = "released";
        session.state = "RELEASED";
        session.activeController = "none";
      }
      this.activeSessions.delete(sessionId);
      return res.ok;
    } catch {
      this.activeSessions.delete(sessionId);
      return false;
    }
  }

  /**
   * Perform a direct stateless scrape without manual session management.
   */
  async scrape(url: string): Promise<ScrapeResult> {
    const res = await fetch(`${this.config.apiUrl}/v1/scrape`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Scrape failed (${res.status}): ${err}`);
    }

    return res.json();
  }

  /**
   * Perform a direct screenshot action.
   */
  async screenshot(url: string, fullPage = false): Promise<ScreenshotResult> {
    const res = await fetch(`${this.config.apiUrl}/v1/screenshot`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ url, fullPage }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Screenshot failed (${res.status}): ${err}`);
    }

    return res.json();
  }

  /**
   * Detect and list orphaned or timed-out active sessions.
   */
  async checkOrphanedSessions(maxIdleMs = 600000): Promise<string[]> {
    const res = await fetch(`${this.config.apiUrl}/v1/sessions`, {
      method: "GET",
      headers: this.headers(),
    });

    if (!res.ok) {
      return [];
    }

    const data = await res.json();
    const remoteSessions: Array<{ id: string; status: string; createdAt: string; duration: number }> =
      data.sessions || [];

    const now = Date.now();
    const orphaned: string[] = [];

    for (const rs of remoteSessions) {
      if (rs.status === "live" || rs.status === "idle") {
        const tracked = this.activeSessions.get(rs.id);
        if (!tracked && rs.duration > maxIdleMs) {
          orphaned.push(rs.id);
        } else if (tracked && now - tracked.lastActiveAt > maxIdleMs && tracked.state !== "HUMAN_CONTROL") {
          orphaned.push(rs.id);
        }
      }
    }

    return orphaned;
  }
}
