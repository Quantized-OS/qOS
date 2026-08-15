import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEncryptedPrivateKey,
  privateKeySeed,
  publicKeyAddress,
  rawPublicKey,
  writeNewEncryptedEd25519Key,
} from "../src/key-store.js";

test("runtime RAM mailbox extracts the canonical Ed25519 seed", () => {
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

test("AES-256-GCM encrypted Ed25519 keys authenticate metadata and passphrase", () => {
  const home = mkdtempSync(join(tmpdir(), "qos-encrypted-key-"));
  const passphrasePath = join(home, "passphrase");
  const wrongPath = join(home, "wrong");
  const keyPath = join(home, "signer.qkey");
  writeFileSync(passphrasePath, "a secure random passphrase with 32 bytes\n", { mode: 0o600 });
  writeFileSync(wrongPath, "a different secure passphrase 32 bytes\n", { mode: 0o600 });
  chmodSync(passphrasePath, 0o600);
  chmodSync(wrongPath, 0o600);
  const created = writeNewEncryptedEd25519Key(keyPath, passphrasePath);
  const loaded = loadEncryptedPrivateKey(keyPath, passphrasePath);
  assert.equal(publicKeyAddress(loaded), publicKeyAddress(created));
  assert.throws(() => loadEncryptedPrivateKey(keyPath, wrongPath), { code: "KEY_DECRYPTION_FAILED" });
});

test("private key loaders reject symlinked key paths", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "qos-key-symlink-"));
  const passphrasePath = join(home, "passphrase");
  const keyPath = join(home, "signer.qkey");
  const linkPath = join(home, "linked.qkey");
  writeFileSync(passphrasePath, "a secure random passphrase with 32 bytes\n", { mode: 0o600 });
  writeNewEncryptedEd25519Key(keyPath, passphrasePath);
  symlinkSync(keyPath, linkPath);
  assert.throws(() => loadEncryptedPrivateKey(linkPath, passphrasePath), { code: "INSECURE_KEY_FILE" });
});
