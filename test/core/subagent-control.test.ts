import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  narrowSubagentTools,
  SubagentManager,
  SUBAGENT_TYPES,
  DEFAULT_SUBAGENT_MODELS,
} from "../../plugins/kxm/src/subagent-control.ts";

describe("subagent control and real-time steering", () => {
  describe("narrowSubagentTools", () => {
    test("defaults safely when requested tools is empty", () => {
      const parent = ["read", "write", "edit", "bash"];
      const tools = narrowSubagentTools(undefined, parent);
      assert.deepEqual(tools, parent);

      const fallback = narrowSubagentTools(undefined, undefined);
      assert.deepEqual(fallback, ["read", "grep", "find"]);
    });

    test("narrows tools to intersection with parent tool surface", () => {
      const parent = ["read", "grep", "find", "edit"];
      const requested = ["read", "find"];
      const tools = narrowSubagentTools(requested, parent);
      assert.deepEqual(tools, ["read", "find"]);
    });

    test("throws error when requested tools expand beyond parent authority", () => {
      const parent = ["read", "grep"];
      const requested = ["bash", "write"];
      assert.throws(() => {
        narrowSubagentTools(requested, parent);
      }, /expand beyond parent capabilities/);
    });
  });

  describe("SubagentManager spawn lifecycle", () => {
    test("spawns a subagent with default model and custom allowlist", () => {
      const manager = new SubagentManager();
      const record = manager.spawn({
        prompt: "Explore the codebase for auth tokens",
        description: "Explore auth tokens",
        type: "Explore",
        allowed_tools: ["read", "grep"],
        parent_tools: ["read", "grep", "edit"],
      });

      assert.ok(record.id.startsWith("ag_"));
      assert.equal(record.type, "Explore");
      assert.equal(record.model, DEFAULT_SUBAGENT_MODELS["Explore"]);
      assert.deepEqual(record.allowedTools, ["read", "grep"]);
      assert.equal(record.status, "running");
      assert.equal(record.turnsCompleted, 0);
    });

    test("fails when prompt or description is missing", () => {
      const manager = new SubagentManager();
      assert.throws(() => {
        manager.spawn({ prompt: "", description: "test" });
      }, /prompt.*required/i);

      assert.throws(() => {
        manager.spawn({ prompt: "some prompt", description: "" });
      }, /description.*required/i);
    });

    test("handles background: false", () => {
      const manager = new SubagentManager();
      const record = manager.spawn({
        prompt: "Synchronous task",
        description: "Sync task",
        background: false,
      });
      assert.equal(record.status, "completed");
    });
  });

  describe("SubagentManager control actions", () => {
    test("action: 'info' returns types, models, and active agents", () => {
      const manager = new SubagentManager();
      manager.spawn({ prompt: "Task 1", description: "Worker 1" });
      manager.spawn({ prompt: "Task 2", description: "Worker 2" });

      const infoTypes = manager.control({ action: "info", kind: "types" });
      assert.equal(infoTypes.ok, true);
      assert.deepEqual(infoTypes.types, SUBAGENT_TYPES);

      const infoModels = manager.control({ action: "info", kind: "models" });
      assert.equal(infoModels.ok, true);
      assert.ok(infoModels.result?.includes("grok-4.6"));

      const infoActive = manager.control({ action: "info", kind: "active" });
      assert.equal(infoActive.ok, true);
      assert.equal(infoActive.activeAgents?.length, 2);
    });

    test("action: 'result' retrieves progress and output", () => {
      const manager = new SubagentManager();
      const record = manager.spawn({ prompt: "Researching", description: "Researcher" });

      const pendingResult = manager.control({ action: "result", agent_id: record.id });
      assert.equal(pendingResult.ok, true);
      assert.ok(pendingResult.result?.includes("running"));

      manager.complete(record.id, "Found 3 relevant files");
      const doneResult = manager.control({ action: "result", agent_id: record.id });
      assert.equal(doneResult.ok, true);
      assert.equal(doneResult.status, "completed");
      assert.equal(doneResult.result, "Found 3 relevant files");
    });

    test("action: 'steer' injects mid-flight guidance", () => {
      const manager = new SubagentManager();
      const record = manager.spawn({ prompt: "Running turn", description: "Worker" });

      const steerRes = manager.control({
        action: "steer",
        agent_id: record.id,
        message: "Please focus on plugins/kxm/src/auth.ts first",
      });

      assert.equal(steerRes.ok, true);
      assert.equal(steerRes.steered, true);
      assert.equal(record.steeringMessages.length, 1);
      assert.equal(record.steeringMessages[0]?.text, "Please focus on plugins/kxm/src/auth.ts first");

      // Cannot steer completed agent
      manager.complete(record.id, "Done");
      const failSteer = manager.control({
        action: "steer",
        agent_id: record.id,
        message: "Another message",
      });
      assert.equal(failSteer.ok, false);
      assert.ok(failSteer.error?.includes("Cannot steer"));
    });

    test("action: 'stop' cancels active agent", () => {
      const manager = new SubagentManager();
      const record = manager.spawn({ prompt: "To be cancelled", description: "Cancelled worker" });

      const stopRes = manager.control({ action: "stop", agent_id: record.id });
      assert.equal(stopRes.ok, true);
      assert.equal(stopRes.stopped, true);
      assert.equal(record.status, "stopped");
    });

    test("handles non-existent agent_id gracefully", () => {
      const manager = new SubagentManager();
      const res = manager.control({ action: "result", agent_id: "ag_nonexistent" });
      assert.equal(res.ok, false);
      assert.ok(res.error?.includes("not found"));
    });
  });

  describe("SubagentManager listActive", () => {
    test("filters to running, pending, or blocked agents", () => {
      const manager = new SubagentManager();
      const ag1 = manager.spawn({ prompt: "Active 1", description: "Active 1" });
      const ag2 = manager.spawn({ prompt: "Active 2", description: "Active 2" });
      manager.complete(ag1.id, "Finished");

      const active = manager.listActive();
      assert.equal(active.length, 1);
      assert.equal(active[0]?.id, ag2.id);
    });
  });
});
