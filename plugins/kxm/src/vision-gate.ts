import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isRouteAdmitted } from "./routes.ts";

/** Deterministic vision gate: judge a UI screenshot through an admitted
 * vision route with a bounded prompt and a strict structured verdict. The
 * gate never free-form chats and never fabricates — an unreadable image, an
 * unadmitted route, or an unparsable verdict returns `verdict: null` with a
 * `divergence` reason. Transport is injectable so tests run without
 * network. */

export const VISION_GATE_DEFAULT_ROUTE = "zai-coding-cn/glm-5.3-flash";
const QUESTION_MAX_CHARS = 500;
const RAW_MAX_CHARS = 2000;

export interface VisionGateOptions {
  projectRoot?: string | undefined;
  /** Absolute or project-relative path to the screenshot. */
  imagePath: string;
  /** What to assert about the screenshot, phrased as a yes/no question. */
  question: string;
  /** Producer id as admitted in routes.yaml. Defaults to the verified
   * vision route. */
  route?: string | undefined;
  timeoutMs?: number | undefined;
  /** Injectable transport: receives the composed prompt, returns CLI stdout. */
  transport?: ((prompt: string) => Promise<string>) | undefined;
}

export interface VisionGateResult {
  /** true/false when the verdict parsed; null = fail closed. */
  verdict: boolean | null;
  route: string;
  /** Bounded raw output for audit. */
  raw: string;
  divergence?: string | undefined;
}

export function visionGatePrompt(question: string, imagePath?: string | undefined): string {
  const bounded = question.trim().slice(0, QUESTION_MAX_CHARS);
  const reference = imagePath ? `Look at the image @${imagePath}.` : "Look at the image attached to this prompt.";
  return [
    "You are judging a UI screenshot for an automated verification gate.",
    reference,
    bounded,
    'Reply with exactly one JSON object and nothing else: {"verdict": true} or {"verdict": false}',
  ].join(" ");
}

export function parseVisionVerdict(raw: string): boolean | null {
  const match = /"verdict"\s*:\s*(true|false)/i.exec(raw);
  return match ? match[1] === "true" : null;
}

function defaultTransport(prompt: string, timeoutMs: number): string {
  return execFileSync(
    "pi",
    ["--provider", "zai-coding-cn", "--model", "glm-5.3-flash", "-p", "--no-session", prompt],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
  );
}

export async function runVisionGate(options: VisionGateOptions): Promise<VisionGateResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const route = options.route ?? VISION_GATE_DEFAULT_ROUTE;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const base: VisionGateResult = { verdict: null, route, raw: "" };

  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
    return { ...base, divergence: "timeout_out_of_bounds" };
  }
  if (!options.imagePath || !existsSync(options.imagePath) || !statSync(options.imagePath).isFile()) {
    return { ...base, divergence: "image unreadable" };
  }
  if (!isRouteAdmitted(projectRoot, route)) {
    return { ...base, divergence: "route_not_admitted" };
  }
  const prompt = visionGatePrompt(options.question, options.imagePath);

  let raw: string;
  try {
    raw = options.transport
      ? await options.transport(prompt)
      : defaultTransport(prompt, timeoutMs);
  } catch (error) {
    return { ...base, divergence: `transport failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` };
  }
  const boundedRaw = raw.slice(0, RAW_MAX_CHARS);
  const verdict = parseVisionVerdict(boundedRaw);
  if (verdict === null) {
    return { ...base, raw: boundedRaw, divergence: "verdict unreadable" };
  }
  return { ...base, verdict, raw: boundedRaw };
}
