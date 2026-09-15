// @ts-nocheck — vendored snapshot; host tsconfig is stricter than upstream.
import { antigravityEnv } from "./util.ts";

const PREWARM_TIMEOUT_MS = 5_000;

/** Host fetch. Node 22+ already pools connections; no extra HTTP client dep. */
export async function antigravityFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, init);
}

/**
 * Open the TLS connection when the extension loads so the first message of a session
 * does not pay the handshake either. Best-effort: failures are ignored.
 */
export function prewarmConnection(url: string): void {
  if (antigravityEnv("NO_PREWARM") === "1") return;
  if (process.env.NODE_TEST_CONTEXT) return;
  void (async () => {
    try {
      const res = await antigravityFetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
      await res.arrayBuffer();
    } catch {
      // Warm-up only; the real request will establish the connection instead.
    }
  })();
}
