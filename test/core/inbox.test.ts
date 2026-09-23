import assert from "node:assert/strict";
import test from "node:test";
import { deliverInboxNotification } from "../../plugins/kxm/src/inbox.ts";

test("failed MCP inbox notifications remain retryable and successful delivery deduplicates", async () => {
  const delivered = new Set<string>();
  let attempts = 0;
  await assert.rejects(() => deliverInboxNotification("msg_1", delivered, async () => {
    attempts += 1;
    throw new Error("temporary channel failure");
  }), /temporary channel failure/);
  assert.equal(delivered.has("msg_1"), false);

  assert.equal(await deliverInboxNotification("msg_1", delivered, async () => {
    attempts += 1;
  }), true);
  assert.equal(await deliverInboxNotification("msg_1", delivered, async () => {
    attempts += 1;
  }), false);
  assert.equal(attempts, 2);
});

test("concurrent MCP inbox notifications for one message announce it once", async () => {
  const delivered = new Set<string>();
  let sends = 0;
  let releaseFirst!: () => void;
  const firstSending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = deliverInboxNotification("msg_1", delivered, async () => {
    sends += 1;
    await firstSending;
  });
  const second = deliverInboxNotification("msg_1", delivered, async () => {
    sends += 1;
  });
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(sends, 1);
});
