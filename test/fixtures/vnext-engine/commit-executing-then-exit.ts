import { createVnextSimulatedProducer, driveVnextRun } from "../../../plugins/kxm/src/vnext-engine.ts";
import { closeVnextRuntimeContext, openVnextRuntimeContext } from "../../../plugins/kxm/src/vnext-runtime.ts";

const payload = JSON.parse(process.argv[2] ?? "{}") as {
  projectRoot?: string;
  stateRoot?: string;
  homeRuntimeId?: string;
  runId?: string;
};
if (!payload.projectRoot || !payload.stateRoot || !payload.homeRuntimeId || !payload.runId) {
  process.stderr.write("commit-executing-then-exit: missing argv payload\n");
  process.exit(2);
}

const projectRoot = payload.projectRoot;
const stateRoot = payload.stateRoot;
const homeRuntimeId = payload.homeRuntimeId;
const runId = payload.runId;

const context = openVnextRuntimeContext(projectRoot, {
  stateRoot,
  homeRuntimeId,
});
const neverSettle = createVnextSimulatedProducer(() => new Promise(() => undefined));
void driveVnextRun(context, runId, neverSettle).catch(() => undefined);

const deadline = Date.now() + 8_000;
const wait = async (): Promise<void> => {
  while (Date.now() < deadline) {
    const events = context.eventStore.events(runId, 0, 1_000);
    if (events.some((event) => event.eventType === "attempt.status_changed" && event.payload.status === "executing")) {
      closeVnextRuntimeContext(context);
      process.stdout.write("executing\n");
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    closeVnextRuntimeContext(context);
  } catch {
    /* already closed */
  }
  process.stderr.write("commit-executing-then-exit: executing event was not committed\n");
  process.exit(2);
};

void wait();
