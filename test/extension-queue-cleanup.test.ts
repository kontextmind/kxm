import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const queueTest = join(here, "extension.test.ts");
const preload = pathToFileURL(join(here, "fixtures", "queue-first-send-abort.mjs")).href;
const queueTestName = "^Pi extension drops terminal work, advances its queue, and exposes transient reply failures$";
const deadlineMs = 15_000;

test("injected queue first-send failure exits the child itself", { timeout: 20_000 }, async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--import",
      preload,
      "--test",
      "--test-name-pattern",
      queueTestName,
      queueTest,
    ],
    {
      cwd: join(here, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, deadlineMs);
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  clearTimeout(timer);
  const output = `${stdout}\n${stderr}`;
  assert.equal(timedOut, false, `child was still alive after ${deadlineMs}ms\n${output}`);
  assert.equal(closed.signal, null, `child exited from ${closed.signal}\n${output}`);
  assert.notEqual(closed.code, 0, `injected failure must not pass the queue test\n${output}`);
  assert.match(output, /request timed out after 5000ms/);
});
