/**
 * Pure text layout helpers for KXM terminal surfaces.
 *
 * Terminal rules are easy to get subtly wrong: an over-wide line corrupts the
 * frame, and padding must be measured on visible width because ANSI runs and
 * wide characters both lie about length. Width maths comes from Pi here so
 * `kxm dash` and the config surfaces agree on one implementation.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const KXM_TUI_ELLIPSIS = "…";

/** Truncate to an exact visible width, adding an ellipsis when cut. */
export function fitText(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (!text.includes("\u001b")) {
    // Plain text gets a grapheme-safe slice. Going through the ANSI-aware
    // truncator here would append reset sequences to output that has no
    // styling, and a colourless frame must contain no escape codes at all.
    let out = "";
    for (const unit of Array.from(text)) {
      if (visibleWidth(out) + visibleWidth(unit) > width - KXM_TUI_ELLIPSIS.length) break;
      out += unit;
    }
    return out + KXM_TUI_ELLIPSIS;
  }
  return truncateToWidth(text, width, KXM_TUI_ELLIPSIS);
}

/** Left text plus right-aligned detail with filler between, within `width`. */
export function alignRight(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const detail = fitText(right, Math.max(0, width - 2));
  const detailWidth = visibleWidth(detail);
  const leftWidth = Math.max(1, width - detailWidth - 1);
  const fitted = fitText(left, leftWidth);
  const filler = Math.max(1, width - visibleWidth(fitted) - detailWidth);
  return `${fitted}${" ".repeat(filler)}${detail}`;
}

/** Pad on the right to a fixed visible width; never truncates. */
export function padRight(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/**
 * Plain-text word wrap for published strings that carry no styling.
 *
 * `wrapText` above is ANSI-preserving and is what styled rows use; this variant
 * exists because a panel also draws owner-supplied prose (notices, errors,
 * details) that must never be re-wrapped after styling.
 */
export function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (!current.length) current = word;
    else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length) lines.push(current);
  return lines.length ? lines : [];
}

/**
 * Compact elapsed time: `12s`, `4m07s`, `2h15m`, `3d04h`.
 *
 * Unparseable or future timestamps return `—` rather than a fake age, so clock
 * skew in a hub record cannot read as "just now".
 */
export function formatAge(iso: string | undefined, nowMs: number): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const seconds = Math.floor((nowMs - at) / 1000);
  if (seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${String(hours % 24).padStart(2, "0")}h`;
}

/**
 * Fixed-width bar. A missing ratio draws an indeterminate bar, which is what an
 * owner that knows it is busy but not how far along should get.
 */
export function progressBar(ratio: number | undefined, width = 10): string {
  const cells = Math.max(1, width);
  if (ratio === undefined || !Number.isFinite(ratio)) return "░".repeat(cells);
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * cells);
  return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}

/** Glyph set shared by steppers, choice lists, and gate rows. */
export const KXM_TUI_MARKS = Object.freeze({
  pending: "○",
  active: "▶",
  waiting: "⧗",
  passed: "✔",
  failed: "✖",
  cancelled: "⊘",
  blocked: "✗",
  ready: "●",
  available: "◐",
  cursor: "▸",
  blankCursor: " ",
});
