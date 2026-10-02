/**
 * `npm pack --json` is a one-element array through npm 11. npm 12 returns
 * one object keyed by package name. Both shapes carry `filename` and `files`.
 */
export function npmPackArtifacts(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const values = Object.values(parsed);
    if (values.length > 0 && values.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
      return values;
    }
  }
  throw new Error(`unexpected npm pack JSON: ${String(stdout).slice(0, 200)}`);
}
