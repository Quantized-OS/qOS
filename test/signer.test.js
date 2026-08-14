import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase58 } from "../src/base58.js";
import { publicKeyAddress } from "../src/key-store.js";
import { initializeSandbox, sandboxPaths } from "../src/service.js";
import { ExternalCommandSigner } from "../src/signer.js";

test("external command signer returns a verified signature without exposing a key handle", async () => {
  const home = mkdtempSync(join(tmpdir(), "qos-external-signer-"));
  const keyPath = join(home, "test-signer.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const signer = new ExternalCommandSigner({
    publicKey: publicKeyAddress(privateKey),
    command: process.execPath,
    args: [new URL("../fixtures/external-signer.js", import.meta.url).pathname, keyPath],
  });
  const signature = await signer.sign(Buffer.from("qos external signing test"), {
    version: 1,
    intent: {},
    intentCommitment: "0".repeat(64),
    policyCommitment: "1".repeat(64),
    privacyProofVerified: false,
  });
  assert.equal(signature.length, 64);
  assert.deepEqual(signer.status(), {
    backend: "external-command-v1",
    custody: "non-exportable-external-boundary",
    keyExportableToAgentProcess: false,
  });
  assert.equal(Object.hasOwn(signer, "privateKey"), false);
});

test("external signer initialization creates no private key files", () => {
  const parent = mkdtempSync(join(tmpdir(), "qos-external-home-"));
  const home = join(parent, "sandbox");
  const signer = encodeBase58(Buffer.alloc(32, 7));
  const destination = encodeBase58(Buffer.alloc(32, 8));
  const result = initializeSandbox(home, destination, { signerPublicKey: signer });
  const paths = sandboxPaths(home);
  assert.equal(result.signer, signer);
  assert.equal(existsSync(paths.signerDescriptor), true);
  assert.equal(existsSync(paths.signerKey), false);
  assert.equal(existsSync(paths.encryptedSignerKey), false);
  assert.equal(existsSync(paths.receiverKey), false);
  assert.equal(existsSync(paths.encryptedReceiverKey), false);
});
