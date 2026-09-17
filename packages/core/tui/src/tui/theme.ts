/**
 * Colour seam for KXM terminal surfaces.
 *
 * Components ask for a semantic colour instead of emitting ANSI, so the same
 * renderer works inside the Pi TUI (host theme), inside the standalone `kxm`
 * CLI (this palette), and inside a test or a piped `--json` path (identity
 * functions). The identity theme is load-bearing, not cosmetic: `kxm dash`
 * asserts that a non-TTY snapshot contains no control sequences at all.
 *
 * The palette is the one `kxm dash` has always used, moved here so a second
 * surface cannot drift to a different shade of "this row failed".
 */

export type KxmTuiForeground =
  | "text"
  | "accent"
  | "muted"
  | "dim"
  | "success"
  | "error"
  | "warning"
  | "border";

/**
 * A semantic palette. Every method takes text and returns styled text.
 *
 * `fg()` is the primitive; the named helpers exist because callers read better
 * with `theme.error(msg)` than with a token string.
 */
export interface KxmTuiTheme {
  /** False when the theme is a passthrough (non-TTY, `NO_COLOR`, tests). */
  readonly colored: boolean;
  fg(token: KxmTuiForeground, text: string): string;
  accent(text: string): string;
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  label(text: string): string;
  value(text: string): string;
  key(text: string): string;
  cursor(text: string): string;
  headerBg(text: string): string;
  panelBg(text: string): string;
}

const SGR: Readonly<Record<KxmTuiForeground, string>> = Object.freeze({
  text: "37",
  accent: "1;36",
  muted: "2",
  dim: "2",
  success: "1;32",
  error: "1;31",
  warning: "1;33",
  border: "90",
});

/** Identity theme: emits no escape codes at all. */
export function createPlainKxmTuiTheme(): KxmTuiTheme {
  const passthrough = (text: string): string => text;
  return {
    colored: false,
    fg: (_token, text) => text,
    accent: passthrough,
    success: passthrough,
    error: passthrough,
    warning: passthrough,
    muted: passthrough,
    dim: passthrough,
    label: passthrough,
    value: passthrough,
    key: passthrough,
    cursor: passthrough,
    headerBg: passthrough,
    panelBg: passthrough,
  };
}

/**
 * SGR palette for the standalone `kxm` CLI, which has no Pi theme to borrow.
 *
 * `color: false` returns the identity theme, so a caller that already knows it
 * is not on a TTY gets plain text without needing environment variables.
 */
export function createKxmTuiAnsiTheme(color: boolean): KxmTuiTheme {
  if (!color) return createPlainKxmTuiTheme();
  const fg = (token: KxmTuiForeground, text: string): string => `\u001b[${SGR[token]}m${text}\u001b[0m`;
  return {
    colored: true,
    fg,
    accent: (text) => fg("accent", text),
    success: (text) => fg("success", text),
    error: (text) => fg("error", text),
    warning: (text) => fg("warning", text),
    muted: (text) => fg("muted", text),
    dim: (text) => fg("dim", text),
    label: (text) => fg("text", text),
    value: (text) => `\u001b[1m${text}\u001b[0m`,
    key: (text) => fg("muted", text),
    cursor: (text) => fg("accent", text),
    headerBg: (text) => `\u001b[1;97;44m${text}\u001b[0m`,
    panelBg: (text) => `\u001b[48;5;236m${text}\u001b[0m`,
  };
}

/** Choose the CLI theme from the environment, honouring `NO_COLOR`. */
export function createDefaultKxmTuiTheme(
  env: Record<string, string | undefined> = process.env,
): KxmTuiTheme {
  return createKxmTuiAnsiTheme(!(env.NO_COLOR || env.KXM_TUI_NO_COLOR));
}

/** The slice of Pi's `Theme` this kit needs. */
export interface PiThemeLike {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
}

/**
 * Adapt a Pi extension theme so kit components reuse the host's colours.
 *
 * `headerBg`/`panelBg` map onto Pi's selection background: Pi has no notion of
 * a panel fill, and inventing one here would fight the user's theme.
 */
export function createKxmTuiThemeFromPi(theme: PiThemeLike, colored = true): KxmTuiTheme {
  if (!colored) return createPlainKxmTuiTheme();
  const fg = (token: KxmTuiForeground, text: string): string => theme.fg(token === "dim" ? "muted" : token, text);
  return {
    colored: true,
    fg,
    accent: (text) => fg("accent", text),
    success: (text) => fg("success", text),
    error: (text) => fg("error", text),
    warning: (text) => fg("warning", text),
    muted: (text) => fg("muted", text),
    dim: (text) => fg("dim", text),
    label: (text) => fg("text", text),
    value: (text) => fg("accent", text),
    key: (text) => fg("muted", text),
    cursor: (text) => fg("accent", text),
    headerBg: (text) => theme.bg("selectedBg", text),
    panelBg: (text) => theme.bg("selectedBg", text),
  };
}
