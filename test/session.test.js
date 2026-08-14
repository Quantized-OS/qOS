import test from "node:test";
import assert from "node:assert/strict";
import { EphemeralSession } from "../src/session.js";

test("ephemeral session blocks in-flight and completed nonce replay", () => {
  const session = new EphemeralSession({ clock: () => 1_000 });
  const release = session.begin("7", 10);
  assert.equal(session.status().activeAuthorizations, 1);
  assert.throws(() => session.begin("7", 10), { code: "NONCE_IN_FLIGHT" });
  release();
  assert.equal(session.status().activeAuthorizations, 0);
  assert.throws(() => session.begin("7", 10), { code: "NONCE_REPLAY" });
});

test("ephemeral session rate limits without retaining transaction details", () => {
  let now = 1_000;
  const session = new EphemeralSession({ clock: () => now });
  session.begin("1", 2)();
  session.begin("2", 2)();
  assert.throws(() => session.begin("3", 2), { code: "RATE_LIMITED" });
  assert.deepEqual(Object.keys(session.status()).sort(), [
    "activeAuthorizations",
    "recentAuthorizationCount",
    "rememberedNonceCommitments",
    "retention",
  ]);
  now += 60_001;
  session.begin("3", 2)();
});

test("dispose clears all volatile session state", () => {
  const session = new EphemeralSession({
    clock: () => 1_000,
    nonceSource: () => Buffer.from("00000000000000000000000000000001", "hex"),
  });
  session.begin("1", 10);
  session.dispose();
  assert.equal(session.status().activeAuthorizations, 0);
  assert.equal(session.status().recentAuthorizationCount, 0);
  assert.equal(session.status().rememberedNonceCommitments, 0);
  assert.equal(session.nextNonce(), "1");
});
