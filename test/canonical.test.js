import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../src/canonical.js";

test("canonical JSON preserves a literal __proto__ key without prototype mutation", () => {
  const value = JSON.parse('{"z":1,"__proto__":{"polluted":true}}');
  assert.equal(canonicalJson(value), '{"__proto__":{"polluted":true},"z":1}');
  assert.equal({}.polluted, undefined);
});

test("canonical JSON rejects non-plain object instances", () => {
  assert.throws(() => canonicalJson(new Date(0)), { code: "NON_CANONICAL_VALUE" });
});
