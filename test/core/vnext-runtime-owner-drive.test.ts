import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import {
  admitVnextRun,
  attachVnextDriveSession,
  clearVnextDriveSession,
  registerVnextRuntimeHandle,
  releaseVnextRun,
  unregisterVnextRuntimeHandle,
  vnextDriveSession,
  vnextOpenDriveSessions,
  vnextRuntimeHandleCount,
  type VnextDriveSession,
} from "../../plugins/kxm/src/vnext-runtime-owner.ts";
import {
  isProducerAdmitted,
  listInventoryModels,
  listRoleBindings,
  loadProducerPolicy,
} from "../../plugins/kxm/src/producers.ts";
import { removeTempDir } from "../helpers.ts";

function session(runId: string, token: string, driveId: string): VnextDriveSession {
  return {
    driveId,
    runId,
    token,
    homeRuntimeId: "rtm_owner_drive",
    mode: "simulated",
    openedAt: new Date().toISOString(),
    controller: new AbortController(),
    settled: Promise.resolve(),
  };
}

test("drive session attach is token-bound, exclusive, and listed while open", () => {
  const storePath = join(tmpdir(), `kxm-owner-drive-${randomUUID()}`);
  const missing = vnextOpenDriveSessions(storePath);
  assert.deepEqual(missing, []);
  assert.equal(vnextDriveSession(storePath, "run-missing"), undefined);

  const runId = "run-drive-1";
  const token = admitVnextRun(storePath, runId, "rev-1", 2);
  try {
    const first = session(runId, token, "drv_aaaaaaaaaaaaaaaaaaaaaaaa");
    attachVnextDriveSession(storePath, runId, token, first);
    assert.equal(vnextDriveSession(storePath, runId)?.driveId, first.driveId);
    assert.equal(vnextOpenDriveSessions(storePath).length, 1);

    assert.throws(
      () => attachVnextDriveSession(storePath, runId, token, session(runId, token, "drv_bbbbbbbbbbbbbbbbbbbbbbbb")),
      /already has a drive session/,
    );
    assert.throws(
      () => attachVnextDriveSession(storePath, runId, "wrong-token", session(runId, "wrong-token", "drv_cccccccccccccccccccccccc")),
      /exact admitted token/,
    );

    clearVnextDriveSession(storePath, runId, "wrong-token");
    assert.equal(vnextDriveSession(storePath, runId)?.driveId, first.driveId);
    clearVnextDriveSession(storePath, runId, token);
    assert.equal(vnextDriveSession(storePath, runId), undefined);
    assert.deepEqual(vnextOpenDriveSessions(storePath), []);

    const second = session(runId, token, "drv_dddddddddddddddddddddddd");
    attachVnextDriveSession(storePath, runId, token, second);
    assert.equal(vnextDriveSession(storePath, runId)?.driveId, second.driveId);
  } finally {
    releaseVnextRun(storePath, runId, token);
  }
  assert.equal(vnextDriveSession(storePath, runId), undefined);
});

test("runtime handle counts and producer inventory helpers stay fail-closed", () => {
  const storePath = join(tmpdir(), `kxm-owner-handle-${randomUUID()}`);
  assert.equal(vnextRuntimeHandleCount(storePath), 0);
  unregisterVnextRuntimeHandle(storePath);
  assert.equal(vnextRuntimeHandleCount(storePath), 0);
  registerVnextRuntimeHandle(storePath);
  registerVnextRuntimeHandle(storePath);
  assert.equal(vnextRuntimeHandleCount(storePath), 2);
  unregisterVnextRuntimeHandle(storePath);
  assert.equal(vnextRuntimeHandleCount(storePath), 1);
  unregisterVnextRuntimeHandle(storePath);
  assert.equal(vnextRuntimeHandleCount(storePath), 0);

  const root = mkdtempSync(join(tmpdir(), "kxm-producer-helpers-"));
  try {
    assert.deepEqual(listRoleBindings(root), {});
    assert.deepEqual(listInventoryModels(root), []);
    assert.equal(isProducerAdmitted(root, "missing"), false);
    assert.equal(loadProducerPolicy(root).schema, "kxm.producers.v1");
    mkdirSync(join(root, ".kxm", "roles"), { recursive: true });
    mkdirSync(join(root, ".kxm", "models"), { recursive: true });
    writeFileSync(join(root, ".kxm", "roles", "writer.yaml"), "schema: kxm.role.v1\nid: writer\nroster:\n  - model: grok-4.6\n", "utf8");
    writeFileSync(join(root, ".kxm", "models", "inventory.yaml"), "models:\n  - id: grok-4.6\n", "utf8");
    assert.deepEqual(listRoleBindings(root).writer, ["grok-4.6"]);
    assert.deepEqual(listInventoryModels(root), ["grok-4.6"]);
  } finally {
    removeTempDir(root);
  }
});
