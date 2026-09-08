import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_LOG_MAX_FILES = 3;

const SENSITIVE_KEY_PATTERN = /(?:^|_)(?:token|secret|password|apiKey|api_key|authorization|bearer)(?:$|_)/i;
const ALLOWED_EXACT_KEYS = new Set(["auth", "authType", "authMethod", "authArgs", "canUpdate", "status"]);

export function redactLogValue(val: unknown, key?: string): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    if (key && SENSITIVE_KEY_PATTERN.test(key) && !ALLOWED_EXACT_KEYS.has(key)) {
      return "[redacted]";
    }
    return redactSecrets(val);
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactLogValue(item, key));
  }
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = redactLogValue(v, k);
    }
    return out;
  }
  return String(val);
}

export function rotateLogFiles(filePath: string, maxFiles: number): void {
  for (let i = maxFiles; i >= 1; i--) {
    const current = `${filePath}.${i}`;
    if (existsSync(current)) {
      if (i >= maxFiles) {
        try { unlinkSync(current); } catch { /* best effort */ }
      } else {
        try { renameSync(current, `${filePath}.${i + 1}`); } catch { /* best effort */ }
      }
    }
  }
  if (existsSync(filePath)) {
    try { renameSync(filePath, `${filePath}.1`); } catch { /* best effort */ }
  }
}

export interface LogEntry {
  timestamp?: string | undefined;
  level?: LogLevel | string | undefined;
  component?: string | undefined;
  event?: string | undefined;
  message?: string | undefined;
  correlationId?: string | undefined;
  requestId?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  traceId?: string | undefined;
  [key: string]: unknown;
}

export interface LoggerOptions {
  component: string;
  path?: string | undefined;
  maxBytes?: number | undefined;
  maxFiles?: number | undefined;
  level?: LogLevel | undefined;
  stdout?: boolean | undefined;
  daemon?: boolean | undefined;
  correlation?: Record<string, string | number | undefined> | undefined;
}

export interface Logger {
  (entryOrEvent: string | Record<string, unknown>, extra?: Record<string, unknown>): void;
  info(entryOrEvent: string | Record<string, unknown>, extra?: Record<string, unknown>): void;
  warn(entryOrEvent: string | Record<string, unknown>, extra?: Record<string, unknown>): void;
  error(entryOrEvent: string | Record<string, unknown>, extra?: Record<string, unknown>): void;
  debug(entryOrEvent: string | Record<string, unknown>, extra?: Record<string, unknown>): void;
  child(context: { component?: string | undefined; correlation?: Record<string, string | number | undefined> | undefined }): Logger;
  close(): void;
  readonly options: Readonly<LoggerOptions>;
}

export function createLogger(options: LoggerOptions): Logger {
  const component = options.component;
  const filePath = options.path;
  const maxBytes = Math.max(100, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_LOG_MAX_FILES);
  const configuredLevel: LogLevel = options.level ?? "info";
  const isDaemon = Boolean(options.daemon ?? (process.env.KXM_DAEMON === "1" || process.env.KXM_DAEMON === "true"));
  const shouldStdout = options.stdout ?? !isDaemon;
  const correlationDefaults = options.correlation ?? {};

  let currentSize = 0;
  if (filePath && existsSync(filePath)) {
    try {
      currentSize = statSync(filePath).size;
    } catch {
      currentSize = 0;
    }
  }

  function emit(level: LogLevel, entryOrEvent: string | Record<string, unknown>, extra?: Record<string, unknown>): void {
    const minPriority = LOG_LEVEL_PRIORITY[configuredLevel] ?? LOG_LEVEL_PRIORITY.info;
    const currentPriority = LOG_LEVEL_PRIORITY[level] ?? LOG_LEVEL_PRIORITY.info;
    if (currentPriority < minPriority) return;

    let base: Record<string, unknown>;
    if (typeof entryOrEvent === "string") {
      base = { event: entryOrEvent, ...extra };
    } else {
      base = { ...entryOrEvent, ...extra };
    }

    const timestamp = typeof base.timestamp === "string" ? base.timestamp : new Date().toISOString();
    delete base.timestamp;
    delete base.level;
    delete base.component;

    const payload: Record<string, unknown> = {
      timestamp,
      level,
      component,
      ...correlationDefaults,
      ...base,
    };

    const sanitized = redactLogValue(payload) as Record<string, unknown>;
    const line = `${JSON.stringify(sanitized)}\n`;

    if (filePath) {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (currentSize + lineBytes > maxBytes) {
        rotateLogFiles(filePath, maxFiles);
        currentSize = 0;
      }
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
        currentSize += lineBytes;
      } catch {
        // best effort write
      }
    }

    if (shouldStdout) {
      process.stdout.write(line);
    }
  }

  const logFn = ((entryOrEvent: string | Record<string, unknown>, extra?: Record<string, unknown>) => {
    let lvl: LogLevel = "info";
    if (typeof entryOrEvent === "object" && entryOrEvent !== null && typeof entryOrEvent.level === "string") {
      const candidate = entryOrEvent.level.toLowerCase();
      if (candidate === "debug" || candidate === "info" || candidate === "warn" || candidate === "error") {
        lvl = candidate;
      }
    }
    emit(lvl, entryOrEvent, extra);
  }) as Logger;

  logFn.info = (entryOrEvent, extra) => emit("info", entryOrEvent, extra);
  logFn.warn = (entryOrEvent, extra) => emit("warn", entryOrEvent, extra);
  logFn.error = (entryOrEvent, extra) => emit("error", entryOrEvent, extra);
  logFn.debug = (entryOrEvent, extra) => emit("debug", entryOrEvent, extra);

  logFn.child = (sub) => {
    return createLogger({
      ...options,
      component: sub.component ? `${component}.${sub.component}` : component,
      correlation: { ...correlationDefaults, ...sub.correlation },
    });
  };

  logFn.close = () => {
    // Synchronous file appends need no stream flush
  };

  Object.defineProperty(logFn, "options", {
    value: Object.freeze({ ...options }),
    writable: false,
    enumerable: true,
  });

  return logFn;
}
