import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decodeBase58, encodeBase58 } from "../src/base58.js";

test("base58 round-trips arbitrary bytes", () => {
  for (let length = 1; length <= 64; length += 1) {
    const input = randomBytes(length);
    assert.deepEqual(decodeBase58(encodeBase58(input)), input);
  }
});

test("base58 preserves leading zero bytes", () => {
  const input = Buffer.from([0, 0, 1, 2, 3]);
  assert.equal(encodeBase58(input).startsWith("11"), true);
  assert.deepEqual(decodeBase58(encodeBase58(input), 5), input);
});

test("base58 rejects forbidden characters and wrong lengths", () => {
  assert.throws(() => decodeBase58("0OIl"), { code: "INVALID_BASE58" });
  assert.throws(() => decodeBase58("111", 32), { code: "INVALID_BASE58_LENGTH" });
  assert.throws(() => decodeBase58("z".repeat(10_000), 32), { code: "BASE58_TOO_LONG" });
});
