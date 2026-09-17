import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import {
  admitKxmRun,
  attachKxmDriveSession,
  clearKxmDriveSession,
  registerKxmRuntimeHandle,
  releaseKxmRun,
  unregisterKxmRuntimeHandle,
  kxmDriveSession,
  kxmOpenDriveSessions,
  kxmRuntimeHandleCount,
  type KxmDriveSession,
} from "../../plugins/kxm/src/runtime-owner.ts";
import {
  isRouteAdmitted,
  listInventoryModels,
  listRoleBindings,
  loadRoutePolicy,
} from "../../plugins/kxm/src/routes.ts";
import { removeTempDir } from "../helpers.ts";

function session(runId: string, token: string, driveId: string): KxmDriveSession {
  return {
    driveId,
    runId,
    token,
    homeRuntimeId: "rtm_owner_drive",
    mode: "simulated",
    openedAt: new Date().toISOString(),
    producerId: "driver-simulated",
    controller: new AbortController(),
    settled: Promise.resolve(),
  };
}

test("drive session attach is token-bound, exclusive, and listed while open", () => {
  const storePath = join(tmpdir(), `kxm-owner-drive-${randomUUID()}`);
  const missing = kxmOpenDriveSessions(storePath);
  assert.deepEqual(missing, []);
  assert.equal(kxmDriveSession(storePath, "run-missing"), undefined);

  const runId = "run-drive-1";
  const token = admitKxmRun(storePath, runId, "rev-1", 2);
  try {
    const first = session(runId, token, "drv_aaaaaaaaaaaaaaaaaaaaaaaa");
    attachKxmDriveSession(storePath, runId, token, first);
    assert.equal(kxmDriveSession(storePath, runId)?.driveId, first.driveId);
    assert.equal(kxmOpenDriveSessions(storePath).length, 1);

    assert.throws(
      () => attachKxmDriveSession(storePath, runId, token, session(runId, token, "drv_bbbbbbbbbbbbbbbbbbbbbbbb")),
      /already has a drive session/,
    );
    assert.throws(
      () => attachKxmDriveSession(storePath, runId, "wrong-token", session(runId, "wrong-token", "drv_cccccccccccccccccccccccc")),
      /exact admitted token/,
    );

    clearKxmDriveSession(storePath, runId, "wrong-token");
    assert.equal(kxmDriveSession(storePath, runId)?.driveId, first.driveId);
    clearKxmDriveSession(storePath, runId, token);
    assert.equal(kxmDriveSession(storePath, runId), undefined);
    assert.deepEqual(kxmOpenDriveSessions(storePath), []);

    const second = session(runId, token, "drv_dddddddddddddddddddddddd");
    attachKxmDriveSession(storePath, runId, token, second);
    assert.equal(kxmDriveSession(storePath, runId)?.driveId, second.driveId);
  } finally {
    releaseKxmRun(storePath, runId, token);
  }
  assert.equal(kxmDriveSession(storePath, runId), undefined);
});

test("runtime handle counts and producer inventory helpers stay fail-closed", () => {
  const storePath = join(tmpdir(), `kxm-owner-handle-${randomUUID()}`);
  assert.equal(kxmRuntimeHandleCount(storePath), 0);
  unregisterKxmRuntimeHandle(storePath);
  assert.equal(kxmRuntimeHandleCount(storePath), 0);
  registerKxmRuntimeHandle(storePath);
  registerKxmRuntimeHandle(storePath);
  assert.equal(kxmRuntimeHandleCount(storePath), 2);
  unregisterKxmRuntimeHandle(storePath);
  assert.equal(kxmRuntimeHandleCount(storePath), 1);
  unregisterKxmRuntimeHandle(storePath);
  assert.equal(kxmRuntimeHandleCount(storePath), 0);

  const root = mkdtempSync(join(tmpdir(), "kxm-producer-helpers-"));
  try {
    assert.deepEqual(listRoleBindings(root), {});
    assert.deepEqual(listInventoryModels(root), []);
    assert.equal(isRouteAdmitted(root, "missing"), false);
    assert.equal(loadRoutePolicy(root).schema, "kxm.routes.v2");
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
