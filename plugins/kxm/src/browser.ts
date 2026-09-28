/**
 * KXM Browser Automation & Steel Session Client
 *
 * Playwright testing and verification use Obscura by default
 * (`resolveBrowserCdpEndpoint()`). Steel remains the client for human
 * takeover, MFA, and the live session viewer (`KXM_BROWSER=steel`).
 * Manages remote Steel sessions, CDP endpoints, human takeover handoffs,
 * and automated cleanup without leaking secrets.
 *
 * steel.kontextmind.com is reached only through Caddy and Authentik forward
 * auth. Clients send `Authorization: Basic` for the svc-steel credential.
 * A Bearer token is refused. `STEEL_API_KEY` is deprecated and is not
 * enforced by Steel or Caddy. Do not put a credential in the URL.
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

export interface ViewportPreset {
  name: string;
  category: "mobile" | "tablet" | "desktop" | "laptop";
  width: number;
  height: number;
  deviceScaleFactor?: number | undefined;
  isMobile?: boolean | undefined;
  hasTouch?: boolean | undefined;
}

export const VIEWPORT_PRESETS: Record<string, ViewportPreset> = Object.freeze({
  "mobile-sm": { name: "Mobile Small (SE)", category: "mobile", width: 375, height: 667, isMobile: true, hasTouch: true },
  "mobile": { name: "Mobile (iPhone 16 / 15 Pro)", category: "mobile", width: 393, height: 852, isMobile: true, hasTouch: true },
  "mobile-lg": { name: "Mobile Large (Pro Max)", category: "mobile", width: 430, height: 932, isMobile: true, hasTouch: true },
  "pixel": { name: "Google Pixel 8/9", category: "mobile", width: 412, height: 924, isMobile: true, hasTouch: true },
  "galaxy": { name: "Samsung Galaxy S24", category: "mobile", width: 360, height: 780, isMobile: true, hasTouch: true },
  "tablet": { name: "Tablet (iPad Air / Mini)", category: "tablet", width: 820, height: 1180, isMobile: true, hasTouch: true },
  "tablet-lg": { name: "Tablet Large (iPad Pro 12.9)", category: "tablet", width: 1024, height: 1366, isMobile: true, hasTouch: true },
  "laptop": { name: "Standard Laptop", category: "laptop", width: 1366, height: 768 },
  "macbook-13": { name: "MacBook Air 13", category: "laptop", width: 1440, height: 900 },
  "macbook-16": { name: "MacBook Pro 16", category: "laptop", width: 1728, height: 1117 },
  "desktop": { name: "Desktop FHD (1080p)", category: "desktop", width: 1920, height: 1080 },
  "desktop-2k": { name: "Desktop QHD (1440p)", category: "desktop", width: 2560, height: 1440 },
  "desktop-4k": { name: "Desktop 4K UHD", category: "desktop", width: 3840, height: 2160 },
});

export function resolveViewportDimensions(
  presetOrDims?: string | { width: number; height: number } | undefined
): { width: number; height: number } {
  if (!presetOrDims) {
    return { width: 1920, height: 1080 };
  }
  if (typeof presetOrDims === "string") {
    const matched = VIEWPORT_PRESETS[presetOrDims.toLowerCase()];
    if (matched) {
      return { width: matched.width, height: matched.height };
    }
    return { width: 1920, height: 1080 };
  }
  return presetOrDims;
}

export interface CreateSessionOptions {
  timeoutMs?: number | undefined;
  dimensions?: { width: number; height: number } | undefined;
  viewportPreset?: string | undefined;
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
  /** Legacy Steel key. Omitted once Authentik Basic auth is configured. */
  apiKey?: string | undefined;
  /**
   * Full `Authorization` value, for example `Basic <base64>`.
   * Present when Authentik app-password auth is configured.
   */
  authorization?: string | undefined;
  uiUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

/** Inputs for {@link resolveSteelConfig}. Environment variables fill anything omitted. */
export interface SteelConfigOverrides extends Partial<SteelConfig> {
  /** Full Authorization value, or a bare base64 credential. Wins over the other auth inputs. */
  authHeader?: string | undefined;
  /** `base64(user:token)`, with or without a leading `Basic `. */
  authBasic?: string | undefined;
  /** Authentik username, for example `svc-steel`. Used with `authToken`. */
  authUser?: string | undefined;
  /** Authentik app password. Used with `authUser`. */
  authToken?: string | undefined;
}

export class SteelAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteelAuthConfigError";
  }
}

/** Authentik challenged the request with a redirect. The message never includes credentials. */
export class SteelAuthRedirectError extends Error {
  readonly status: number;
  readonly host: string;

  constructor(status: number, host: string) {
    super(
      `Steel request was redirected (${status}) to ${host}. ` +
        "Send Authorization: Basic via STEEL_AUTH_BASIC or STEEL_AUTH_USER and STEEL_AUTH_TOKEN. " +
        "A Bearer token is not accepted.",
    );
    this.name = "SteelAuthRedirectError";
    this.status = status;
    this.host = host;
  }
}

const LEGACY_STEEL_AUTH_WARNING =
  "kxm: STEEL_API_KEY is deprecated for Steel. Steel and Caddy do not enforce it. " +
  "Set STEEL_AUTH_HEADER, or STEEL_AUTH_BASIC, or STEEL_AUTH_USER and STEEL_AUTH_TOKEN. " +
  "Those override STEEL_API_KEY. Send Authorization on the request, not in the URL.\n";

let legacySteelAuthWarned = false;

/** Test hook. Production calls warn at most once per process. */
export function resetLegacySteelAuthWarningForTests(): void {
  legacySteelAuthWarned = false;
}

function warnLegacySteelAuth(): void {
  if (legacySteelAuthWarned) return;
  legacySteelAuthWarned = true;
  process.stderr.write(LEGACY_STEEL_AUTH_WARNING);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeAuthorization(raw: string): string {
  if (/[\r\n]/.test(raw)) {
    throw new SteelAuthConfigError("Steel authorization value contains a line break.");
  }
  const value = raw.trim();
  if (!value) {
    throw new SteelAuthConfigError("Steel authorization value is empty.");
  }
  const basicPrefix = /^basic\s+(.+)$/i.exec(value);
  if (basicPrefix) {
    const credential = basicPrefix[1] ?? "";
    if (!credential || /\s/.test(credential)) {
      throw new SteelAuthConfigError("Steel Basic credential must be a single base64 token.");
    }
    return `Basic ${credential}`;
  }
  if (/\s/.test(value)) {
    return value;
  }
  return `Basic ${value}`;
}

/**
 * Resolve the Authentik `Authorization` value.
 * Precedence: auth header override, then `STEEL_AUTH_BASIC`, then user + token.
 * Returns undefined when none of those are set so the legacy API key can apply.
 */
export function resolveSteelAuthorization(overrides?: SteelConfigOverrides): string | undefined {
  const header = firstNonEmpty(overrides?.authHeader, overrides?.authorization, process.env.STEEL_AUTH_HEADER);
  if (header) return normalizeAuthorization(header);

  const basic = firstNonEmpty(overrides?.authBasic, process.env.STEEL_AUTH_BASIC);
  if (basic) return normalizeAuthorization(basic);

  const user = firstNonEmpty(overrides?.authUser, process.env.STEEL_AUTH_USER);
  const token = firstNonEmpty(overrides?.authToken, process.env.STEEL_AUTH_TOKEN);
  if (user || token) {
    if (!user || !token) {
      throw new SteelAuthConfigError(
        "Steel Basic auth needs both STEEL_AUTH_USER and STEEL_AUTH_TOKEN, or STEEL_AUTH_BASIC.",
      );
    }
    return `Basic ${Buffer.from(`${user}:${token}`, "utf8").toString("base64")}`;
  }
  return undefined;
}

/**
 * Headers for Steel HTTP and for Playwright `chromium.connectOverCDP(url, { headers })`.
 * Basic auth wins and does not attach the legacy API key.
 */
export function steelRequestHeaders(config: Pick<SteelConfig, "authorization" | "apiKey">): Record<string, string> {
  if (config.authorization) {
    return { Authorization: config.authorization };
  }
  if (config.apiKey) {
    return { "x-steel-api-key": config.apiKey };
  }
  return {};
}

export function steelAuthRedirectError(res: {
  status: number;
  headers: { get(name: string): string | null };
}): SteelAuthRedirectError {
  let host = "the identity provider";
  const location = res.headers.get("location");
  if (location) {
    try {
      host = new URL(location, "https://id.kxmd.dev").host;
    } catch {
      host = "the identity provider";
    }
  }
  return new SteelAuthRedirectError(res.status, host);
}

export function resolvePassCliApiKey(
  execFn: (cmd: string) => string = (cmd) =>
    execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 5000 }),
): string | undefined {
  if (typeof process === "undefined" || process.env.USE_PASS_CLI === "false") {
    return undefined;
  }
  if (process.env.PASS_CLI_OUTPUT_MOCK) {
    try {
      const parsed = JSON.parse(process.env.PASS_CLI_OUTPUT_MOCK);
      const extraFields = parsed?.item?.content?.extra_fields || [];
      const customSections = parsed?.item?.content?.content?.Custom?.sections || [];
      const sectionFields = customSections.flatMap((s: any) => s.section_fields || []);
      const allFields = [...extraFields, ...sectionFields];
      return allFields.find((f: any) => f.name === "STEEL_API_KEY")?.content?.Hidden;
    } catch {
      return undefined;
    }
  }
  try {
    // Deprecated lookup. The hosted server does not enforce STEEL_API_KEY.
    const output = execFn(
      'pass-cli item view --vault-name "AI Provider Keys" --item-title "Steel Browser (KontextMind DOKS)" --output json',
    );
    const parsed = JSON.parse(output);
    const extraFields = parsed?.item?.content?.extra_fields || [];
    const customSections = parsed?.item?.content?.content?.Custom?.sections || [];
    const sectionFields = customSections.flatMap((s: any) => s.section_fields || []);
    const allFields = [...extraFields, ...sectionFields];
    return allFields.find((f: any) => f.name === "STEEL_API_KEY")?.content?.Hidden;
  } catch {
    return undefined;
  }
}

/**
 * Resolve Steel configuration from the environment.
 * Does not write secrets to disk or logs.
 * Authentik Basic auth overrides `STEEL_API_KEY`. Steel and Caddy do not enforce that key.
 *
 * Authentik Basic auth (`STEEL_AUTH_HEADER`, `STEEL_AUTH_BASIC`, or
 * `STEEL_AUTH_USER` + `STEEL_AUTH_TOKEN`) wins over `STEEL_API_KEY`.
 * The legacy key is kept only when no Basic credential is configured, and
 * a one-time deprecation warning is written to stderr.
 */
export function resolveSteelConfig(overrides?: SteelConfigOverrides): SteelConfig {
  const apiUrl =
    overrides?.apiUrl ||
    process.env.STEEL_API_URL ||
    "https://steel.kontextmind.com";

  const authorization = resolveSteelAuthorization(overrides);
  let apiKey: string | undefined;
  if (!authorization) {
    apiKey = overrides?.apiKey || process.env.STEEL_API_KEY || resolvePassCliApiKey();
    if (apiKey) warnLegacySteelAuth();
  }

  const uiUrl =
    overrides?.uiUrl ||
    (overrides?.apiUrl ? `${overrides.apiUrl.replace(/\/$/, "")}/ui` : undefined) ||
    process.env.STEEL_UI_URL ||
    `${apiUrl.replace(/\/$/, "")}/ui`;

  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    apiKey,
    authorization,
    uiUrl,
    timeoutMs: overrides?.timeoutMs || 300000, // 5 minutes default
  };
}

/**
 * Format a remote CDP connection URL for Playwright or agent-browser.
 * The legacy `apiKey` query parameter is added only when Basic auth is unset.
 */
export function formatCDPEndpoint(session: Pick<SteelSession, "id" | "websocketUrl">, config: SteelConfig): string {
  const baseApi = config.apiUrl;
  const urlObj = new URL(baseApi);
  const isSecure = urlObj.protocol === "https:";
  const wsProtocol = isSecure ? "wss:" : "ws:";
  const host = urlObj.host;

  const searchParams = new URLSearchParams();
  searchParams.set("sessionId", session.id);
  if (!config.authorization && config.apiKey) {
    searchParams.set("apiKey", config.apiKey);
  }

  return `${wsProtocol}//${host}/v1/devtools?${searchParams.toString()}`;
}

export interface SteelCdpConnect {
  /** WebSocket URL. Credentials stay out of it when Authentik Basic auth is set. */
  url: string;
  /** Pass as the second argument to `chromium.connectOverCDP(url, { headers })`. */
  headers: Record<string, string>;
}

/**
 * CDP URL plus the headers Playwright must send on the WebSocket handshake.
 * Call `chromium.connectOverCDP(url, { headers })`. Do not put the credential in the URL.
 */
export function formatCDPConnect(
  session: Pick<SteelSession, "id" | "websocketUrl">,
  config: SteelConfig,
): SteelCdpConnect {
  return {
    url: formatCDPEndpoint(session, config),
    headers: steelRequestHeaders(config),
  };
}

export const DEFAULT_OBSCURA_CDP_URL = "http://127.0.0.1:9222";
const DEFAULT_OBSCURA_PORT = 9222;

function obscuraListenPort(): number {
  const raw = process.env.OBSCURA_PORT?.trim() ?? "";
  if (raw === "") return DEFAULT_OBSCURA_PORT;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`OBSCURA_PORT must be an integer from 1 to 65535 (received ${JSON.stringify(process.env.OBSCURA_PORT)})`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`OBSCURA_PORT must be an integer from 1 to 65535 (received ${JSON.stringify(process.env.OBSCURA_PORT)})`);
  }
  return port;
}

/**
 * CDP URL for a local Obscura browser.
 * `OBSCURA_CDP_URL` wins. Otherwise `http://127.0.0.1:${OBSCURA_PORT:-9222}`.
 */
export function resolveObscuraCdpEndpoint(): string {
  const explicit = process.env.OBSCURA_CDP_URL?.trim() ?? "";
  if (explicit !== "") return explicit;
  const port = obscuraListenPort();
  if (port === DEFAULT_OBSCURA_PORT) return DEFAULT_OBSCURA_CDP_URL;
  return `http://127.0.0.1:${port}`;
}

/**
 * Playwright CDP target.
 * Obscura by default, with empty headers. `KXM_BROWSER=steel` uses {@link formatCDPConnect}.
 */
export function resolveBrowserCdpConnect(
  session?: Pick<SteelSession, "id" | "websocketUrl">,
  config?: SteelConfig,
): SteelCdpConnect {
  const browser = (process.env.KXM_BROWSER ?? "").trim().toLowerCase();
  if (browser === "" || browser === "obscura") {
    return { url: resolveObscuraCdpEndpoint(), headers: {} };
  }
  if (browser === "steel") {
    if (!session?.id) {
      throw new Error("KXM_BROWSER=steel requires a Steel session id");
    }
    return formatCDPConnect(session, config ?? resolveSteelConfig());
  }
  throw new Error(`Unsupported KXM_BROWSER value ${JSON.stringify(process.env.KXM_BROWSER)}; expected "obscura" or "steel"`);
}

/**
 * Playwright CDP endpoint.
 * Obscura by default. `KXM_BROWSER=steel` returns the URL from {@link formatCDPConnect}.
 * Pass {@link resolveBrowserCdpConnect} headers into `chromium.connectOverCDP`, or call {@link connectBrowserOverCdp}.
 */
export function resolveBrowserCdpEndpoint(
  session?: Pick<SteelSession, "id" | "websocketUrl">,
  config?: SteelConfig,
): string {
  return resolveBrowserCdpConnect(session, config).url;
}

/**
 * Connect Playwright over CDP.
 * Obscura is called with the URL only. `KXM_BROWSER=steel` passes Authentik or legacy Steel headers on the handshake.
 */
export async function connectBrowserOverCdp<T>(
  connectOverCDP: (url: string, options?: { headers?: Record<string, string> }) => Promise<T>,
  session?: Pick<SteelSession, "id" | "websocketUrl">,
  config?: SteelConfig,
): Promise<T> {
  const { url, headers } = resolveBrowserCdpConnect(session, config);
  if (Object.keys(headers).length === 0) return connectOverCDP(url);
  return connectOverCDP(url, { headers });
}

/**
 * Redact sensitive API keys and tokens from URLs and objects for logging.
 */
export function sanitizeLogOutput<T>(input: T): T {
  if (typeof input === "string") {
    const redacted = input
      .replace(/apiKey=[^&\s]+/gi, "apiKey=[REDACTED]")
      .replace(/([?&]authorization=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/authorization:\s*(?:basic\s+)?\S+/gi, "authorization: [REDACTED]")
      .replace(/\bBasic\s+(?:[A-Za-z0-9+/]*[+/=0-9][A-Za-z0-9+/]*={0,2})/g, "Basic [REDACTED]")
      .replace(/steel_[a-f0-9]+/g, "steel_[REDACTED]");
    return redacted as unknown as T;
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

  constructor(config?: SteelConfigOverrides) {
    this.config = resolveSteelConfig(config);
  }

  getConfig(): Readonly<SteelConfig> {
    return { ...this.config };
  }

  /**
   * URL and headers for `chromium.connectOverCDP(url, { headers })`.
   * The URL omits credentials when Authentik Basic auth is configured.
   */
  cdpConnectOptions(session: Pick<SteelSession, "id" | "websocketUrl">): SteelCdpConnect {
    return formatCDPConnect(session, this.config);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...steelRequestHeaders(this.config),
    };
  }

  private async steelFetch(url: string, init: RequestInit): Promise<Response> {
    const headers = {
      ...this.headers(),
      ...(init.headers as Record<string, string> | undefined),
    };
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      throw steelAuthRedirectError(res);
    }
    return res;
  }

  /**
   * Launch a new Steel browser session.
   */
  async createSession(options?: CreateSessionOptions): Promise<SteelSession> {
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs ?? 300000;
    const body: Record<string, any> = {
      timeout: timeoutMs,
    };
    const dimensions = options?.dimensions || (options?.viewportPreset ? resolveViewportDimensions(options.viewportPreset) : undefined);
    if (dimensions) {
      body.dimensions = dimensions;
    }
    if (options?.userAgent) {
      body.userAgent = options.userAgent;
    }
    if (options?.proxy) {
      body.proxy = options.proxy;
    }

    const res = await this.steelFetch(`${this.config.apiUrl}/v1/sessions`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = sanitizeLogOutput(await res.text());
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
    const res = await this.steelFetch(`${this.config.apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
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
      const res = await this.steelFetch(`${this.config.apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}/release`, {
        method: "POST",
      });

      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.status = "released";
        session.state = "RELEASED";
        session.activeController = "none";
      }
      this.activeSessions.delete(sessionId);
      return res.ok;
    } catch (error) {
      if (error instanceof SteelAuthRedirectError) throw error;
      this.activeSessions.delete(sessionId);
      return false;
    }
  }

  /**
   * Perform a direct stateless scrape without manual session management.
   */
  async scrape(url: string): Promise<ScrapeResult> {
    const res = await this.steelFetch(`${this.config.apiUrl}/v1/scrape`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = sanitizeLogOutput(await res.text());
      throw new Error(`Scrape failed (${res.status}): ${err}`);
    }

    return res.json();
  }

  /**
   * Perform a direct screenshot action.
   */
  async screenshot(url: string, fullPage = false): Promise<ScreenshotResult> {
    const res = await this.steelFetch(`${this.config.apiUrl}/v1/screenshot`, {
      method: "POST",
      body: JSON.stringify({ url, fullPage }),
    });

    if (!res.ok) {
      const err = sanitizeLogOutput(await res.text());
      throw new Error(`Screenshot failed (${res.status}): ${err}`);
    }

    return res.json();
  }

  /**
   * Detect and list orphaned or timed-out active sessions.
   */
  async checkOrphanedSessions(maxIdleMs = 600000): Promise<string[]> {
    const res = await this.steelFetch(`${this.config.apiUrl}/v1/sessions`, {
      method: "GET",
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
