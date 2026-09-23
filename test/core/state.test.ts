import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProtocolError } from "../../plugins/kxm/src/protocol.ts";
import { MeshStore } from "../../plugins/kxm/src/store.ts";
import {
  NativeStateProvider,
  detectStateContradictions,
  findSuperseder,
  latestActive,
  parseStateItem,
  stateActiveAt,
  type StateContradiction,
} from "../../plugins/kxm/src/state.ts";
import type { ContextItem } from "../../plugins/kxm/src/context.ts";
import type { StateChangeProposal } from "../../plugins/kxm/src/context/providers.ts";

function proposal(overrides: Partial<StateChangeProposal> = {}): StateChangeProposal {
  return {
    schema: "kxm.state-change-proposal.v1",
    project: "kxm",
    key: "ci.pipeline",
    summary: "CI pipeline runs on gitlab runner fleet 2",
    // Peer proposals can only ever claim evidence authority (issue #36
    // grant floor); humans could propose instruction/policy authority.
    authority: "evidence",
    confidence: "verified",
    evidenceRefs: ["journal_journal_1", "receipt:run_1/verify"],
    proposedBy: "agent_implementer",
    origin: "peer",
    ...overrides,
  };
}

function storeItem(overrides: Record<string, unknown> = {}): ContextItem {
  return parseStateItem({
    id: "ctx_state_x",
    kind: "state",
    project: "kxm",
    summary: "initial value",
    provenance: { sourceType: "human", sourceRef: "commit:abc123" },
    authority: "instruction",
    confidence: "verified",
    stateKey: "ci.pipeline",
    status: "current",
    validFrom: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function assertProtocolError(promiseOrFn: Promise<unknown> | (() => unknown), code: string): Promise<void> | void {
  if (promiseOrFn instanceof Promise) {
    return assert.rejects(promiseOrFn, (error: unknown) => {
      assert.ok(error instanceof ProtocolError, `expected ProtocolError, got ${error}`);
      assert.equal(error.code, code);
      return true;
    });
  }
  assert.throws(promiseOrFn, (error: unknown) => {
    assert.ok(error instanceof ProtocolError, `expected ProtocolError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("state items require a key and an explicit lifecycle status", () => {
  const item = storeItem();
  assert.equal(item.stateKey, "ci.pipeline");
  assert.equal(item.status, "current");
  assertProtocolError(() => parseStateItem({ ...item, kind: "evidence" }), "invalid_state_item");
  assert.throws(() => parseStateItem({ ...item, stateKey: undefined }), /stateKey/);
  assert.throws(() => parseStateItem({ ...item, status: undefined }), /status/);
});

test("propose records a pending proposal but never serves it as current", async () => {
  const store = new MeshStore(":memory:");
  const clock = deterministicClock();
  const provider = new NativeStateProvider(store, { now: clock.now });
  const id = await provider.propose(proposal());
  const stored = store.getContextItem(id);
  assert.equal(stored?.status, "proposed");
  assert.equal(stored?.stateKey, "ci.pipeline");
  // A pending proposal is not current truth.
  assert.equal(await provider.get("kxm", "ci.pipeline"), null);
  // Cross-project lookup fails closed.
  assert.equal(await provider.get("other", "ci.pipeline"), null);
});

test("promotion is evidence-bound, authorized, and supersession-linked", async () => {
  const store = new MeshStore(":memory:");
  const clock = deterministicClock();
  const provider = new NativeStateProvider(store, { now: clock.now });
  store.saveContextItem(storeItem({ id: "ctx_state_initial" }));
  const id = await provider.propose(proposal());

  // Self-promotion fails closed.
  await assertProtocolError(
    provider.promote(id, ["eval:1"], "agent_implementer"),
    "state_promotion_invalid",
  );
  // Empty promotion evidence fails closed.
  await assertProtocolError(provider.promote(id, [], "kxm-admin"), "state_promotion_invalid");
  // Unknown proposal IDs fail closed.
  await assertProtocolError(provider.promote("ctx_missing", ["eval:1"], "kxm-admin"), "state_proposal_not_found");

  const promoted = await provider.promote(id, ["receipt:ci-migration"], "kxm-admin");
  assert.equal(promoted.status, "current");
  assert.equal(promoted.stateKey, "ci.pipeline");
  assert.deepEqual(promoted.supersedes, ["ctx_state_initial"]);
  assert.deepEqual(promoted.evidenceRefs, ["journal_journal_1", "receipt:ci-migration", "receipt:run_1/verify"]);
  assert.equal(promoted.provenance.sourceRef, "promoted-by:kxm-admin");

  // Double promotion fails closed: the proposal is consumed.
  await assertProtocolError(provider.promote(id, ["eval:1"], "kxm-admin"), "state_proposal_not_promotable");

  // The supersession graph is queryable.
  const superseder = await provider.supersededBy("kxm", "ctx_state_initial");
  assert.equal(superseder?.id, promoted.id);
  assert.equal(await provider.supersededBy("kxm", promoted.id), null);
  // Cross-project supersession queries fail closed.
  assert.equal(await provider.supersededBy("other", "ctx_state_initial"), null);
});

test("temporal queries are deterministic and superseded state never looks current", async () => {
  const store = new MeshStore(":memory:");
  const clock = deterministicClock();
  const provider = new NativeStateProvider(store, { now: clock.now });
  store.saveContextItem(storeItem({ id: "ctx_state_initial", validFrom: "2026-01-01T00:00:00.000Z" }));
  await provider.propose(proposal());
  clock.advanceTo("2026-02-01T00:00:00.000Z");
  const promoted = await provider.promote(
    (await firstProposalId(store))!,
    ["receipt:ci-migration"],
    "kxm-admin",
  );

  // Current query: only the promoted value.
  const current = await provider.get("kxm", "ci.pipeline");
  assert.equal(current?.id, promoted.id);
  assert.equal(current?.status, "current");

  // Historical query before promotion: the old value, by validity window.
  const before = await provider.get("kxm", "ci.pipeline", "2026-01-15T00:00:00.000Z");
  assert.equal(before?.id, "ctx_state_initial");
  assert.equal(before?.status, "superseded");

  // Historical query at promotion instant: old window is half-open [from, until).
  const atBoundary = await provider.get("kxm", "ci.pipeline", "2026-02-01T00:00:00.000Z");
  assert.equal(atBoundary?.id, promoted.id);

  // Deterministic: identical queries return identical items.
  const repeat = await provider.get("kxm", "ci.pipeline", "2026-01-15T00:00:00.000Z");
  assert.deepEqual(repeat, before);
  const repeatCurrent = await provider.get("kxm", "ci.pipeline");
  assert.deepEqual(repeatCurrent, current);

  // The superseded record keeps an explicit validity window.
  const initial = store.getContextItem("ctx_state_initial");
  assert.equal(initial?.status, "superseded");
  assert.equal(initial?.validUntil, "2026-02-01T00:00:00.000Z");
});

test("competing current items fail closed as contradictions", async () => {
  const store = new MeshStore(":memory:");
  const clock = deterministicClock();
  const provider = new NativeStateProvider(store, { now: clock.now });
  store.saveContextItem(storeItem({ id: "ctx_state_a", validFrom: "2026-01-01T00:00:00.000Z" }));
  store.saveContextItem(storeItem({ id: "ctx_state_b", summary: "competing value", validFrom: "2026-01-02T00:00:00.000Z" }));

  await assertProtocolError(provider.get("kxm", "ci.pipeline"), "state_contradiction");

  const contradictions = provider.contradictions();
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0]?.stateKey, "ci.pipeline");
  assert.deepEqual(contradictions[0]?.competingCurrentIds, ["ctx_state_a", "ctx_state_b"]);

  // Pure helpers behave deterministically too.
  const items = [storeItem({ id: "ctx_state_a" }), storeItem({ id: "ctx_state_b" })];
  assert.equal(findSuperseder(items, "ctx_state_a"), undefined);
  const active = items.filter((item) => stateActiveAt(item, Date.parse("2026-01-15T00:00:00.000Z")));
  assert.equal(latestActive(active)?.id, "ctx_state_b");
});

test("competing proposals are detected, not silently resolved", async () => {
  const store = new MeshStore(":memory:");
  const clock = deterministicClock();
  const provider = new NativeStateProvider(store, { now: clock.now });
  await provider.propose(proposal({ summary: "use gitlab", proposedBy: "agent_planner" }));
  await provider.propose(proposal({ summary: "use buildkite", proposedBy: "agent_critic" }));

  const contradictions = provider.contradictions();
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0]?.competingProposalIds.length, 2);
  assert.deepEqual(contradictions[0]?.competingCurrentIds, []);

  // Promoting one proposal resolves the contradiction deterministically.
  const promoted = await provider.promote(
    (await firstProposalId(store))!,
    ["receipt:ci-migration"],
    "kxm-admin",
  );
  assert.equal(promoted.status, "current");
  assert.deepEqual(provider.contradictions(), []);
});

test("set-valued state keys allow multiple currents through currentSet", async () => {
  const store = new MeshStore(":memory:");
  const clock = deterministicClock();
  const provider = new NativeStateProvider(store, { now: clock.now, setValuedKeys: new Set(["ci.fleets"]) });
  store.saveContextItem(storeItem({ id: "ctx_fleet_1", stateKey: "ci.fleets", summary: "fleet 1" }));
  store.saveContextItem(storeItem({ id: "ctx_fleet_2", stateKey: "ci.fleets", summary: "fleet 2" }));

  await assertProtocolError(provider.get("kxm", "ci.fleets"), "state_key_set_valued");
  const set = await provider.currentSet("kxm", "ci.fleets");
  assert.deepEqual(set.map((item) => item.id), ["ctx_fleet_1", "ctx_fleet_2"]);
  // Set-valued keys are exempt from single-value contradiction detection.
  const items = [storeItem({ id: "ctx_fleet_1", stateKey: "ci.fleets" }), storeItem({ id: "ctx_fleet_2", stateKey: "ci.fleets" })];
  assert.deepEqual(detectStateContradictions("kxm", items, new Set(["ci.fleets"])), [] satisfies StateContradiction[]);
  // Single-valued keys reject currentSet.
  await assertProtocolError(provider.currentSet("kxm", "ci.pipeline"), "state_key_single_valued");
});

test("state survives restart with durable migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kxm-state-"));
  const path = join(directory, "kxm.db");
  try {
    const first = new MeshStore(path);
    const clock = deterministicClock();
    const firstProvider = new NativeStateProvider(first, { now: clock.now });
    first.saveContextItem(storeItem({ id: "ctx_state_initial" }));
    await firstProvider.propose(proposal());
    clock.advanceTo("2026-02-01T00:00:00.000Z");
    const promoted = await firstProvider.promote(
      (await firstProposalId(first))!,
      ["receipt:ci-migration"],
      "kxm-admin",
    );
    const firstHistory = firstProvider.stateHistory("kxm", "ci.pipeline").map((item) => item.id);
    first.close();

    // A restarted hub sees the identical authoritative state.
    const second = new MeshStore(path);
    const secondProvider = new NativeStateProvider(second, { now: () => "2026-03-01T00:00:00.000Z" });
    const current = await secondProvider.get("kxm", "ci.pipeline");
    assert.equal(current?.id, promoted.id);
    const secondHistory = secondProvider.stateHistory("kxm", "ci.pipeline").map((item) => item.id);
    assert.deepEqual(secondHistory, firstHistory);
    const historical = await secondProvider.get("kxm", "ci.pipeline", "2026-01-15T00:00:00.000Z");
    assert.equal(historical?.id, "ctx_state_initial");
    assert.equal(await secondProvider.get("other", "ci.pipeline"), null);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Deterministic clock for repeatable temporal tests. */
function deterministicClock() {
  let current = "2026-01-10T00:00:00.000Z";
  return {
    now(): string {
      return current;
    },
    advanceTo(iso: string): void {
      current = iso;
    },
  };
}

async function firstProposalId(store: MeshStore): Promise<string | undefined> {
  const found = [...store.contextItems.values()]
    .filter((item) => item.kind === "state" && item.status === "proposed")
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  return found?.id;
}
