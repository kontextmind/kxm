/**
 * Anthropic session / Keychain material that must not reach logs or telemetry.
 * Complements plugins/kxm/src/redact.ts.
 */

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted]" },
  { re: /\bANTHROPIC_(?:API_KEY|AUTH_TOKEN|SESSION_KEY)=\S+/gi, replacement: "ANTHROPIC_[redacted]" },
  { re: /\bCLAUDE_(?:API_KEY|SESSION_KEY)=\S+/gi, replacement: "CLAUDE_[redacted]" },
  {
    re: /("?(?:sessionKey|session_key|claude_oauth_token|anthropicApiKey|sk-ant)"?\s*[:=]\s*")[^"]*(")/gi,
    replacement: "$1[redacted]$2",
  },
];

export function redactClaudeBridgeSecrets(text: string): string {
  let result = text;
  for (const { re, replacement } of PATTERNS) {
    result = result.replace(re, replacement);
  }
  return result;
}

export function looksLikeClaudeBridgeSecret(value: string): boolean {
  return redactClaudeBridgeSecrets(value) !== value;
}
