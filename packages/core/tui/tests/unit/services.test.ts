/**
 * KXM terminal kit tests: The contribution registry: publishing, routing writes, and failure reporting.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  KXM_TUI_CLEAR_ACTION,
  KXM_TUI_SET_ACTION, type KxmTuiField, type KxmTuiSectionView } from "../../src/types/surface.ts";
import { createKxmTuiRegistry, type KxmTuiContribution } from "../../src/services/registry.ts";
import { referenceSurface } from "../helpers/surface.ts";

test("registry: owners publish, invoke, and report failures without breaking the panel", async () => {
  const written: string[] = [];
  const registry = createKxmTuiRegistry();
  const events: string[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(`${event.reason}:${event.source ?? "-"}`));
  const contribution: KxmTuiContribution = {
    source: "kxm/config",
    listSections: () => referenceSurface(written.some((entry) => entry.startsWith("model=")) ? "anthropic/fable" : "xai/grok-4.6"),
    handlers: {
      [KXM_TUI_SET_ACTION]: ({ fieldId, value }) => {
        if (fieldId === "max-turns" && value !== "25") throw new Error("max turns must be 25 in this fixture");
        written.push(`${fieldId}=${value ?? ""}`);
      },
      [KXM_TUI_CLEAR_ACTION]: ({ fieldId }) => {
        written.push(`${fieldId}=<unset>`);
      },
    },
  };
  registry.register(contribution);
  assert.deepEqual(registry.listSources(), ["kxm/config"]);
  assert.equal(registry.hasSource("kxm/gates"), false);

  const sections = registry.getSections();
  assert.equal(sections.length, 2);
  assert.equal(sections[0]?.source, "kxm/config");
  assert.equal(registry.getIssues().length, 0);

  const ok = await registry.invoke({ source: "kxm/config", sectionId: "config", fieldId: "model", action: KXM_TUI_SET_ACTION, value: "anthropic/fable" });
  assert.equal(ok.ok, true);
  assert.equal(registry.getSections()[0]?.fields[1]?.value, "anthropic/fable", "the panel shows what is on disk");
  assert.ok(registry.getGeneration() > 0);

  const bad = await registry.invoke({ source: "kxm/config", sectionId: "config", fieldId: "max-turns", action: KXM_TUI_SET_ACTION, value: "999" });
  assert.equal(bad.ok, false);
  assert.match(bad.message ?? "", /must be 25/u);
  assert.equal(registry.getSections()[0]?.notice, "max turns must be 25 in this fixture", "a failure is drawn, not swallowed");

  const wrongOwner = await registry.invoke({ source: "kxm/nobody", sectionId: "config", fieldId: "model", action: KXM_TUI_SET_ACTION, value: "x" });
  assert.equal(wrongOwner.ok, false);
  assert.match(wrongOwner.message ?? "", /does not own/u);
  const wrongAction = await registry.invoke({ source: "kxm/config", sectionId: "config", fieldId: "model", action: "wipe", value: "x" });
  assert.equal(wrongAction.ok, false);
  assert.match(wrongAction.message ?? "", /does not accept/u);

  assert.ok(events.includes("publish:kxm/config"));
  assert.ok(events.includes("failed:kxm/config"));
  unsubscribe();
  registry.unregister("kxm/config");
  assert.deepEqual(registry.listSources(), []);
  registry.dispose();
  assert.deepEqual(await registry.invoke({ source: "kxm/config", sectionId: "config", fieldId: "model", action: KXM_TUI_SET_ACTION, value: "x" }).then((r) => r.ok), false);
});

test("registry: a broken owner still renders, and its failure is recorded", async () => {
  const reported: string[] = [];
  const registry = createKxmTuiRegistry({ onInternalError: (_error, context) => reported.push(context) });
  registry.register({
    source: "kxm/broken",
    listSections: () => {
      throw new Error("config.yaml is unreadable");
    },
    handlers: {},
  });
  const sections = registry.getSections();
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.notice, "config.yaml is unreadable");
  assert.equal(sections[0]?.noticeLevel, "error");
  assert.equal(reported[0], "listSections:kxm/broken");
  assert.equal(registry.getIssues()[0]?.code, "list_sections_failed");
  const refused = await registry.invoke({ source: "kxm/broken", sectionId: "error", fieldId: "x", action: "set", value: "y" });
  assert.equal(refused.ok, false);
});

test("registry: a published surface that violates the contract is annotated, not hidden", () => {
  const registry = createKxmTuiRegistry();
  registry.register({
    source: "kxm/partial",
    listSections: () => [{ source: "kxm/partial", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "slider" as KxmTuiField["kind"] }] }] as unknown as KxmTuiSectionView[],
    handlers: {},
  });
  const sections = registry.getSections();
  assert.match(sections[0]?.notice ?? "", /published surface was refused/u);
  assert.equal(registry.getIssues()[0]?.code, "invalid_choice");
});

test("registry: an unknown source and an oversized source are refused at register time", () => {
  const registry = createKxmTuiRegistry();
  assert.throws(() => registry.register({ source: "has spaces", listSections: () => [], handlers: {} }), /invalid kxm tui surface source/u);
  const disposed = createKxmTuiRegistry();
  disposed.dispose();
  assert.throws(() => disposed.register({ source: "kxm/x", listSections: () => [], handlers: {} }), /disposed/u);
});
