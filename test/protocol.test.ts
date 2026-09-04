import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolError,
  newId,
  optionalString,
  parseBoundedInteger,
  parseDeliveryMode,
  requireString,
} from "../plugins/kxm/src/protocol.ts";

test("newId creates prefixed unique identifiers", () => {
  const first = newId("msg");
  const second = newId("msg");
  assert.match(first, /^msg_[a-f0-9]{32}$/);
  assert.notEqual(first, second);
});

test("string validators trim values and enforce shape", () => {
  assert.equal(requireString("  value  ", "field"), "value");
  assert.equal(requireString("", "field", { allowEmpty: true }), "");
  assert.equal(optionalString(undefined, "field", 10), undefined);
  assert.equal(optionalString(null, "field", 10), undefined);
  assert.equal(optionalString("", "field", 10), undefined);
  assert.equal(optionalString(" value ", "field", 10), "value");
  assert.throws(() => requireString(1, "field"), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.statusCode, 400);
    return true;
  });
  assert.throws(() => requireString("   ", "field"), /cannot be empty/);
  assert.throws(() => requireString("long", "field", { max: 3 }), /exceeds 3/);
});

test("delivery mode validator accepts every mode and defaults safely", () => {
  assert.equal(parseDeliveryMode(undefined), "followUp");
  assert.equal(parseDeliveryMode("followUp"), "followUp");
  assert.equal(parseDeliveryMode("steer"), "steer");
  assert.equal(parseDeliveryMode("nextTurn"), "nextTurn");
  assert.throws(() => parseDeliveryMode("now"), /delivery must be/);
});

test("bounded integer validator applies fallback and boundaries", () => {
  assert.equal(parseBoundedInteger(undefined, "count", 3, 1, 5), 3);
  assert.equal(parseBoundedInteger(1, "count", 3, 1, 5), 1);
  assert.equal(parseBoundedInteger(5, "count", 3, 1, 5), 5);
  assert.throws(() => parseBoundedInteger(0, "count", 3, 1, 5), /between 1 and 5/);
  assert.throws(() => parseBoundedInteger(1.5, "count", 3, 1, 5), /between 1 and 5/);
  assert.throws(() => parseBoundedInteger("2", "count", 3, 1, 5), /between 1 and 5/);
});
