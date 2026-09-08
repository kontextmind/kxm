import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLogger,
  redactLogValue,
  rotateLogFiles,
  LOG_LEVEL_PRIORITY,
} from "../plugins/kxm/src/logger.ts";

test("logger: formats valid JSONL with level, timestamp, component, and correlation fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-logger-test-"));
  const logFile = join(dir, "test.log");
  try {
    const logger = createLogger({
      component: "test-hub",
      path: logFile,
      stdout: false,
      correlation: { runId: "run_test_123" },
    });

    logger.info("service_started", { port: 8080 });
    logger.warn("high_memory", { usagePercent: 88 });
    logger.close();

    assert.ok(existsSync(logFile));
    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);

    assert.equal(lines[0].level, "info");
    assert.equal(lines[0].component, "test-hub");
    assert.equal(lines[0].event, "service_started");
    assert.equal(lines[0].port, 8080);
    assert.equal(lines[0].runId, "run_test_123");
    assert.ok(typeof lines[0].timestamp === "string");
    assert.ok(!Number.isNaN(Date.parse(lines[0].timestamp)));

    assert.equal(lines[1].level, "warn");
    assert.equal(lines[1].component, "test-hub");
    assert.equal(lines[1].event, "high_memory");
    assert.equal(lines[1].usagePercent, 88);
    assert.equal(lines[1].runId, "run_test_123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logger: filters by configured log level", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-logger-test-"));
  const logFile = join(dir, "level.log");
  try {
    const logger = createLogger({
      component: "filter-test",
      path: logFile,
      level: "warn",
      stdout: false,
    });

    logger.debug("debug_event", { detail: "d" });
    logger.info("info_event", { detail: "i" });
    logger.warn("warn_event", { detail: "w" });
    logger.error("error_event", { detail: "e" });
    logger.close();

    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].level, "warn");
    assert.equal(lines[0].event, "warn_event");
    assert.equal(lines[1].level, "error");
    assert.equal(lines[1].event, "error_event");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logger: child creates nested component name and inherits/merges correlation", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-logger-test-"));
  const logFile = join(dir, "child.log");
  try {
    const rootLogger = createLogger({
      component: "runtime",
      path: logFile,
      stdout: false,
      correlation: { runId: "run-root", sessionId: "sess-1" },
    });

    const childLogger = rootLogger.child({
      component: "worker",
      correlation: { stageId: "stage-compile", sessionId: "sess-child" },
    });

    childLogger.info("child_started", { pid: 4321 });
    childLogger.close();

    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].component, "runtime.worker");
    assert.equal(lines[0].runId, "run-root");
    assert.equal(lines[0].sessionId, "sess-child");
    assert.equal(lines[0].stageId, "stage-compile");
    assert.equal(lines[0].event, "child_started");
    assert.equal(lines[0].pid, 4321);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logger: redaction on write sanitizes sensitive keys and secret values", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-logger-test-"));
  const logFile = join(dir, "redact.log");
  try {
    const logger = createLogger({
      component: "redact-test",
      path: logFile,
      stdout: false,
    });

    logger.info("auth_check", {
      token: "secret-token-123456",
      apiKey: "sk-proj-xyz1234567890abcdef",
      password: "mySecretPassword123",
      nested: {
        bearer_token: "sensitive-jwt",
        openRouterKey: "sk-or-v1-abcdef0123456789",
      },
      status: "ok",
      authType: "bearer",
    });
    logger.close();

    const raw = readFileSync(logFile, "utf8");
    assert.doesNotMatch(raw, /secret-token-123456/);
    assert.doesNotMatch(raw, /mySecretPassword123/);
    assert.doesNotMatch(raw, /sensitive-jwt/);
    assert.doesNotMatch(raw, /sk-proj-xyz1234567890abcdef/);

    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.token, "[redacted]");
    assert.equal(parsed.apiKey, "[redacted]");
    assert.equal(parsed.password, "[redacted]");
    assert.equal(parsed.nested.bearer_token, "[redacted]");
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.authType, "bearer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logger: size-capped rotation rotates file and prunes files exceeding maxFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-logger-rotation-"));
  const logFile = join(dir, "rot.log");
  try {
    // maxBytes = 100 bytes (min clamp is 100 bytes), maxFiles = 2
    const logger = createLogger({
      component: "rot",
      path: logFile,
      maxBytes: 100,
      maxFiles: 2,
      stdout: false,
    });

    // Write enough records to trigger rotation multiple times
    for (let i = 0; i < 15; i++) {
      logger.info(`iteration_${i}`, { payload: "data_payload_to_exceed_100_bytes_threshold" });
    }
    logger.close();

    assert.ok(existsSync(logFile), "active log file exists");
    assert.ok(existsSync(`${logFile}.1`), "rot.log.1 exists");
    assert.ok(existsSync(`${logFile}.2`), "rot.log.2 exists");
    assert.equal(existsSync(`${logFile}.3`), false, "rot.log.3 should not exist because maxFiles is 2");

    // Check that files contain valid JSON lines
    const activeLines = readFileSync(logFile, "utf8").trim().split("\n");
    assert.ok(activeLines.length > 0);
    JSON.parse(activeLines[0]!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logger: rotateLogFiles unit function rotates sequentially and unlinks excess", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-rotate-unit-"));
  const base = join(dir, "app.log");
  try {
    writeFileSync(base, "current\n");
    rotateLogFiles(base, 2);
    assert.ok(existsSync(`${base}.1`));
    assert.equal(readFileSync(`${base}.1`, "utf8"), "current\n");

    writeFileSync(base, "second\n");
    rotateLogFiles(base, 2);
    assert.ok(existsSync(`${base}.2`));
    assert.equal(readFileSync(`${base}.2`, "utf8"), "current\n");
    assert.ok(existsSync(`${base}.1`));
    assert.equal(readFileSync(`${base}.1`, "utf8"), "second\n");

    writeFileSync(base, "third\n");
    rotateLogFiles(base, 2);
    assert.equal(readFileSync(`${base}.2`, "utf8"), "second\n");
    assert.equal(readFileSync(`${base}.1`, "utf8"), "third\n");
    assert.equal(existsSync(`${base}.3`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logger: stdout suppressed when daemonized or daemon option is true", () => {
  const originalStdoutWrite = process.stdout.write;
  let stdoutCalls = 0;
  process.stdout.write = ((chunk: any) => {
    stdoutCalls++;
    return true;
  }) as any;

  try {
    const daemonLogger = createLogger({
      component: "daemon-test",
      daemon: true,
    });
    daemonLogger.info("daemon_event", { msg: "hidden" });
    assert.equal(stdoutCalls, 0, "daemon: true suppresses stdout");

    const envPrior = process.env.KXM_DAEMON;
    try {
      process.env.KXM_DAEMON = "1";
      const envDaemonLogger = createLogger({
        component: "env-daemon-test",
      });
      envDaemonLogger.info("env_daemon_event", { msg: "hidden" });
      assert.equal(stdoutCalls, 0, "KXM_DAEMON=1 suppresses stdout");
    } finally {
      if (envPrior === undefined) {
        delete process.env.KXM_DAEMON;
      } else {
        process.env.KXM_DAEMON = envPrior;
      }
    }

    const nonDaemonLogger = createLogger({
      component: "interactive",
      daemon: false,
      stdout: true,
    });
    nonDaemonLogger.info("interactive_event", { msg: "shown" });
    assert.equal(stdoutCalls, 1, "non-daemon with stdout: true writes to stdout");
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});
