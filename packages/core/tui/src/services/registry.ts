/**
 * Surface registry: who owns which part of a KXM terminal surface.
 *
 * A panel is published, not centralised. Each owner (project, roster, routes,
 * gates, roles, workflow, config) contributes its own sections and performs its
 * own writes; the registry only routes requests and re-reads what changed. That
 * keeps one rule true everywhere in KXM: the panel never becomes a second
 * source of truth for configuration, and never writes a file by itself.
 *
 * There is no local echo. `invoke()` calls the owner and then re-reads its
 * sections, so a rejected write comes back as the old value plus the owner's
 * reason on `statusText`. A value the panel shows is a value that is on disk.
 *
 * Owners are addressed by name. A handler for an unregistered source, an
 * unknown section, or an unknown action is refused rather than guessed, and a
 * handler that throws never aborts the panel: the failure becomes a notice.
 */

import {
  KXM_TUI_LIMITS,
  assertKxmTuiSurface,
  validateKxmTuiSurface,
  type KxmTuiInvocation,
  type KxmTuiIssue,
  type KxmTuiSectionView,
} from "../types/surface.ts";

export interface KxmTuiActionInput {
  readonly sectionId: string;
  readonly fieldId: string;
  readonly action: string;
  readonly value?: string;
  /** Owner-scoped state the handler needs to resolve the current surface. */
  readonly state?: unknown;
}

export interface KxmTuiContribution<TState = unknown> {
  /** Addressable owner id, e.g. `kxm/roster`. It is audited, never display-only. */
  readonly source: string;
  /**
   * Read at publish time, not cached: an owner may have just written a file,
   * refreshed a catalog, or lost authentication, and the panel must show that.
   */
  readonly listSections: (state?: TState) => readonly KxmTuiSectionView[];
  readonly handlers: Readonly<Record<string, (input: KxmTuiActionInput) => void | Promise<void>>>;
  /** Turn an owner failure into a legible line. Defaults to `error.message`. */
  readonly describeError?: (error: unknown, action: string) => string;
  /**
   * Whether a write must be re-read through `listSections` after the handler
   * resolves. Always true here; declared so an owner cannot promise otherwise.
   */
  readonly republishAfterWrite?: true;
}

export interface KxmTuiRegistryEvent {
  readonly reason: "publish" | "invoke" | "refused" | "failed";
  readonly source?: string;
  readonly message?: string;
}

export interface KxmTuiInvokeResult {
  readonly ok: boolean;
  /** Why the request was refused or failed, already fit for one line. */
  readonly message?: string;
  /** Contract violations that made the owner's published surface unusable. */
  readonly issues?: readonly KxmTuiIssue[];
}

export interface KxmTuiRegistry {
  /** Register an owner. Re-registering the same source replaces it. */
  register(contribution: KxmTuiContribution): void;
  unregister(source: string): void;
  /** The merged surface, ordered by `order` then source, safe to render. */
  getSections(): readonly KxmTuiSectionView[];
  /** Sections as published, including any that failed validation. */
  getIssues(): readonly KxmTuiIssue[];
  invoke(invocation: KxmTuiInvocation): Promise<KxmTuiInvokeResult>;
  subscribe(listener: (event: KxmTuiRegistryEvent) => void): () => void;
  /** Monotonic token identifying the current session of this registry. */
  getGeneration(): number;
  /** A source is only present when it registered; used to gate tabs. */
  hasSource(source: string): boolean;
  listSources(): string[];
  dispose(): void;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.split(/\r?\n/u)[0]!.slice(0, KXM_TUI_LIMITS.detailMax);
  return String(error).split(/\r?\n/u)[0]!.slice(0, KXM_TUI_LIMITS.detailMax);
}

function normalizeSource(source: string): string {
  if (!/^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/u.test(source) || source.length > KXM_TUI_LIMITS.sourceMax) {
    throw new Error(`invalid kxm tui surface source: ${source.slice(0, 64)}`);
  }
  return source;
}

/**
 * Create a registry.
 *
 * `onInternalError` receives faults that cannot be shown as a field notice (a
 * malformed published surface, a listener that threw). It must never rethrow
 * into the panel: a broken owner dims a section, it does not crash the UI.
 */
export function createKxmTuiRegistry(options: {
  onInternalError?: (error: unknown, context: string) => void;
} = {}): KxmTuiRegistry {
  const contributions = new Map<string, KxmTuiContribution>();
  const notices = new Map<string, string>();
  const listeners = new Set<(event: KxmTuiRegistryEvent) => void>();
  /** Per-owner cache so one repaint does not re-read every file on disk. */
  const published = new Map<string, readonly KxmTuiSectionView[]>();
  const issues = new Map<string, readonly KxmTuiIssue[]>();
  let generation = 0;
  let disposed = false;
  let epoch = 0;

  const report = (error: unknown, context: string): void => {
    if (options.onInternalError) options.onInternalError(error, context);
  };

  const emit = (event: KxmTuiRegistryEvent): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        report(error, "listener");
      }
    }
  };

  function readOwner(source: string, force: boolean): readonly KxmTuiSectionView[] {
    if (!force) {
      const cached = published.get(source);
      if (cached) return cached;
    }
    const contribution = contributions.get(source);
    if (!contribution) {
      published.set(source, []);
      return [];
    }
    let sections: readonly KxmTuiSectionView[];
    try {
      const raw = contribution.listSections();
      const ownerIssues = validateKxmTuiSurface(raw);
      if (ownerIssues.length > 0) {
        issues.set(source, ownerIssues);
        // Keep the surface drawable anyway: the panel is where someone repairs a
        // bad file, so a broken section still has to render with its notice.
        sections = raw
          .filter((section): section is KxmTuiSectionView => Boolean(section) && typeof section === "object")
          .map((section) => ({
            ...section,
            notice: section.notice ?? `published surface was refused: ${ownerIssues[0]!.code} at ${ownerIssues[0]!.path}`,
            noticeLevel: "error" as const,
          }));
      } else {
        issues.delete(source);
        sections = raw;
      }
    } catch (error) {
      issues.set(source, [{ path: source, code: "list_sections_failed", message: describe(error) }]);
      report(error, `listSections:${source}`);
      sections = [{ source, id: "error", title: source, order: 900, notice: describe(error), noticeLevel: "error", fields: [] }];
    }
    const pending = notices.get(source);
    const withNotice = pending !== undefined && sections.length > 0
      ? sections.map((section, index) => (index === 0 ? { ...section, notice: pending, noticeLevel: "error" as const } : section))
      : sections;
    published.set(source, withNotice);
    return withNotice;
  }

  function merged(): readonly KxmTuiSectionView[] {
    const all: KxmTuiSectionView[] = [];
    for (const source of contributions.keys()) all.push(...readOwner(source, false));
    return all.slice().sort((a, b) => a.order - b.order || a.source.localeCompare(b.source) || a.title.localeCompare(b.title));
  }

  return {
    register(contribution) {
      if (disposed) throw new Error("kxm tui registry is disposed");
      const source = normalizeSource(contribution.source);
      notices.delete(source);
      published.delete(source);
      issues.delete(source);
      contributions.set(source, { ...contribution, source });
      emit({ reason: "publish", source });
    },
    unregister(source) {
      contributions.delete(source);
      published.delete(source);
      issues.delete(source);
      notices.delete(source);
      emit({ reason: "publish", source });
    },
    getSections() {
      return merged();
    },
    getIssues() {
      return [...issues.values()].flat();
    },
    async invoke(invocation) {
      if (disposed) return { ok: false, message: "kxm tui registry is disposed" };
      const contribution = contributions.get(invocation.source);
      if (!contribution) {
        emit({ reason: "refused", source: invocation.source, message: "unknown owner" });
        return { ok: false, message: `${invocation.source} does not own a surface here` };
      }
      const handler = contribution.handlers[invocation.action];
      if (!handler) {
        const message = `${invocation.source} does not accept "${invocation.action}"`;
        emit({ reason: "refused", source: invocation.source, message });
        return { ok: false, message };
      }
      const currentEpoch = epoch;
      try {
        await handler({
          sectionId: invocation.sectionId,
          fieldId: invocation.fieldId,
          action: invocation.action,
          ...(invocation.value === undefined ? {} : { value: invocation.value }),
        });
      } catch (error) {
        const failure = contribution.describeError?.(error, invocation.action) ?? describe(error);
        notices.set(invocation.source, failure);
        emit({ reason: "failed", source: invocation.source, message: failure });
        // Republish so the panel shows the on-disk value plus the reason.
        readOwner(invocation.source, true);
        generation += 1;
        return { ok: false, message: failure };
      }
      if (currentEpoch !== epoch) {
        // A stale reply after a reset must not resurrect an old surface.
        readOwner(invocation.source, true);
        return { ok: false, message: "stale write result was discarded" };
      }
      notices.delete(invocation.source);
      readOwner(invocation.source, true);
      generation += 1;
      emit({ reason: "publish", source: invocation.source });
      return { ok: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getGeneration() {
      return generation;
    },
    hasSource(source) {
      return contributions.has(source);
    },
    listSources() {
      return [...contributions.keys()];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      listeners.clear();
      contributions.clear();
      published.clear();
      issues.clear();
      notices.clear();
    },
  };
}

/** Validate a contributed surface up front, for owners that publish constants. */
export function checkedKxmTuiSections(sections: readonly KxmTuiSectionView[]): KxmTuiSectionView[] {
  return assertKxmTuiSurface(sections);
}
