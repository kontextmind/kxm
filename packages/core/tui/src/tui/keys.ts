/**
 * Keyboard input helpers for KXM terminal surfaces.
 *
 * The panel reducer must be testable without a terminal, so decoding lives here
 * as pure functions instead of being scattered through `handleInput`. Paste and
 * bracketed input arrive as one buffer, so every entry point is bounded and
 * control bytes are dropped before they can reach a field value.
 */

import { decodeKittyPrintable, parseKey } from "@earendil-works/pi-tui";

export type KxmTuiInputKind =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "delete"
  | "ctrlC"
  | "text"
  | "ignored";

export interface KxmTuiInput {
  readonly kind: KxmTuiInputKind;
  /** Printable payload for `kind: "text"`. */
  readonly text?: string;
}

/** Printable maximum for one committed value; longer input is truncated. */
export const KXM_TUI_INPUT_MAX_LENGTH = 4096;

const CONTROL_BYTES = /[\u0000-\u0008\u000a-\u001f\u007f\u0080-\u009f]/u;

const NAMED_KEYS: Readonly<Record<string, KxmTuiInputKind>> = Object.freeze({
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "pageUp",
  pagedown: "pageDown",
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
});

const CONTROL_BYTES_GLOBAL = /[\u0000-\u0008\u000a-\u001f\u007f\u0080-\u009f]/gu;

/** Strip control bytes, collapse newlines, and bound the result. */
export function normalizeInputText(value: string): string {
  return value.replace(CONTROL_BYTES_GLOBAL, " ").replace(/ {2,}/gu, " ").trim().slice(0, KXM_TUI_INPUT_MAX_LENGTH);
}

/** True when the buffer carries no printable text (pure escape/control input). */
export function isControlInput(data: string): boolean {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Decode one input event.
 *
 * Named keys resolve through the Pi key parser, which handles Kitty,
 * modifyOtherKeys, and legacy SS3/CSI forms. A multi-character buffer that is
 * not a key sequence is treated as pasted text.
 */
export function decodeKxmTuiInput(data: string | undefined): KxmTuiInput {
  if (typeof data !== "string" || data.length === 0) return { kind: "ignored" };
  const named = parseKey(data);
  if (named === "ctrl+c") return { kind: "ctrlC" };
  if (named) {
    const kind = NAMED_KEYS[named.toLowerCase()];
    if (kind) return { kind };
    if (named === "space") return { kind: "text", text: " " };
    // A single printable character comes back as its own key id. Everything
    // else (f1, shift+tab, dead keys) is refused rather than mistaken for text.
    if (Array.from(named).length === 1 && !CONTROL_BYTES.test(named)) {
      return { kind: "text", text: named };
    }
    return { kind: "ignored" };
  }
  const kitty = decodeKittyPrintable(data);
  if (kitty) {
    const text = normalizeInputText(kitty);
    return text ? { kind: "text", text } : { kind: "ignored" };
  }
  // An unrecognized escape sequence is a key we do not model, never text. A
  // paste can legitimately carry newlines and other control bytes, so it is
  // normalised rather than rejected.
  if (data.startsWith("\u001b")) return { kind: "ignored" };
  const pasted = normalizeInputText(data);
  return pasted ? { kind: "text", text: pasted } : { kind: "ignored" };
}

/** Delete the last character; surrogate pairs go together. */
export function deleteBackward(text: string): string {
  const units = Array.from(text);
  units.pop();
  return units.join("");
}

/** Insert at an index and return the new text plus the advanced caret. */
export function insertAt(
  text: string,
  caret: number,
  insert: string,
  maxLength = KXM_TUI_INPUT_MAX_LENGTH,
): { text: string; caret: number } {
  const units = Array.from(text);
  const at = Math.max(0, Math.min(caret, units.length));
  const added = Array.from(insert);
  const merged = [...units.slice(0, at), ...added, ...units.slice(at)].join("");
  const next = merged.length > maxLength ? merged.slice(0, maxLength) : merged;
  return { text: next, caret: Math.min(next.length, at + added.length) };
}
