import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { privateKeySeed, rawPublicKey } from "../src/key-store.js";

test("firmware provisioning extracts the canonical Ed25519 seed", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKeySeed(privateKey);
  assert.equal(seed.length, 32);
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const reconstructed = createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    type: "pkcs8",
    format: "der",
  });
  assert.deepEqual(rawPublicKey(reconstructed), rawPublicKey(privateKey));
});
