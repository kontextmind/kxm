const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bKXM_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*=\S+/gi,
  /\b(GITHUB_TOKEN|GH_TOKEN|KXM_AUTH_TOKEN|KXM_WORKFLOW_SIGNAL_SECRET)=\S+/gi,
  /\b[A-Fa-f0-9]{64}\b/g,
];

export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

export function looksLikeSecret(value: string): boolean {
  return redactSecrets(value) !== value;
}

export function redactStringList(values: string[], maxItems = 32): string[] {
  return values.slice(0, maxItems).map((value) => redactSecrets(value).slice(0, 500));
}
