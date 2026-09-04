/** Hub opt-in from `kxm init`. Local-only init never starts or configures a hub. */

export type HubInitMode = "local" | "existing" | "new";

export type HubInitParseResult =
  | { ok: true; mode: HubInitMode; hubUrl?: string }
  | { ok: false; error: string; message: string };

export function parseHubInitOption(hub: unknown, hubUrl?: string): HubInitParseResult {
  const url = hubUrl?.trim();
  if (hub === undefined || hub === false) {
    if (url) {
      return {
        ok: false,
        error: "hub_url_without_hub",
        message: "--hub-url requires --hub existing; omit both for local-only",
      };
    }
    return { ok: true, mode: "local" };
  }
  const raw = hub === true ? "existing" : String(hub).trim().toLowerCase();
  if (raw === "ssh" || raw === "remote") {
    return {
      ok: false,
      error: "hub_ssh_unsupported",
      message: "SSH hub install is not available yet; use --hub existing or --hub new",
    };
  }
  if (raw !== "" && raw !== "existing" && raw !== "new") {
    return {
      ok: false,
      error: "hub_mode_invalid",
      message: "--hub must be existing or new; omit --hub for local-only",
    };
  }
  const mode: Exclude<HubInitMode, "local"> = raw === "new" ? "new" : "existing";
  if (mode === "new" && url) {
    return {
      ok: false,
      error: "hub_url_with_new",
      message: "--hub-url is only valid with --hub existing",
    };
  }
  if (mode === "existing") return { ok: true, mode, ...(url ? { hubUrl: url } : {}) };
  return { ok: true, mode: "new" };
}

export function formatHubInitNextSteps(mode: "existing" | "new", input: { hubUrl?: string; online?: boolean } = {}): string {
  if (mode === "existing") {
    const url = input.hubUrl ?? "http://127.0.0.1:7331";
    const reach = input.online === true ? "reachable" : input.online === false ? "not reachable yet" : "not probed";
    return [
      `Hub: use the existing hub at ${url} (${reach}).`,
      "Keep this project's Git configuration; do not recopy templates.",
      "Set KXM_SERVER_URL to that hub, then run kxm hub view and kxm session brief.",
      "Interactive Pi TUI shows plan/task stats when the kxm extension is loaded.",
    ].join("\n");
  }
  return [
    "Hub: start a new local hub using this project's existing Git configuration.",
    "Run kxm hub start, then kxm hub view and kxm session brief.",
    "SSH hub install is not available yet.",
    "Interactive Pi TUI shows plan/task stats when the kxm extension is loaded.",
  ].join("\n");
}
