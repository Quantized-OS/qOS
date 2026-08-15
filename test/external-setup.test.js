import assert from "node:assert/strict";
import test from "node:test";
import { accessSync, constants, mkdtempSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeBase58 } from "../src/base58.js";
import { publicKeyAddress } from "../src/key-store.js";
import { createExternalSignerHome, resolveExternalSetup } from "../src/external-setup.js";
import { initializeSandbox } from "../src/service.js";

test("external setup creates a separate public-only signer home", () => {
  const root = mkdtempSync(join(tmpdir(), "qos-external-setup-test-"));
  const sourceHome = join(root, "source");
  const externalHome = join(root, "external");
  const destination = encodeBase58(Buffer.alloc(32, 9));
  initializeSandbox(sourceHome, destination, { cluster: "devnet" });
  const { privateKey } = generateKeyPairSync("ed25519");
  const signerPublicKey = publicKeyAddress(privateKey);

  const result = createExternalSignerHome({
    create: true,
    home: externalHome,
    "source-home": sourceHome,
    "public-key": signerPublicKey,
    cluster: "devnet",
  });

  assert.equal(result.keyCustody, "non-exportable-external-boundary");
  assert.deepEqual(result.privateFiles, []);
  assert.equal(result.destination, destination);
  assert.equal(result.sourceHome, sourceHome);
});

test("external setup refuses to create a home without an external public key", () => {
  assert.throws(
    () => resolveExternalSetup({ destination: encodeBase58(Buffer.alloc(32, 9)) }),
    { code: "PUBLIC_KEY_REQUIRED" },
  );
});

test("external setup accepts only an executable absolute signer command", () => {
  const root = mkdtempSync(join(tmpdir(), "qos-external-command-test-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const options = {
    home: join(root, "external"),
    "public-key": publicKeyAddress(privateKey),
    destination: encodeBase58(Buffer.alloc(32, 9)),
    "signer-command": process.execPath,
  };
  accessSync(process.execPath, constants.X_OK);
  assert.doesNotThrow(() => resolveExternalSetup(options));
  assert.throws(() => resolveExternalSetup({ ...options, "signer-command": "node" }), { code: "EXTERNAL_SIGNER_CONFIG" });
});
