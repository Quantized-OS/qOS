import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeBase58 } from "../src/base58.js";
import { ensureRuntimeProfile, loadRuntimeProfile } from "../src/runtime-profile.js";
import { initializeSandbox } from "../src/service.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTERNAL_SIGNER = join(ROOT, "fixtures", "external-signer.js");

test("runtime profile creates one stable owner-only API token without printing it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-runtime-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "devnet");
  initializeSandbox(home);

  const first = ensureRuntimeProfile(home, { profile: "devnet" });
  const token = readFileSync(first.apiTokenFile);
  const second = ensureRuntimeProfile(home, { profile: "devnet" });
  try {
    assert.deepEqual(second, first);
    assert.deepEqual(readFileSync(second.apiTokenFile), token);
    assert.equal(lstatSync(first.apiTokenFile).mode & 0o077, 0);
    assert.equal(lstatSync(first.apiTokenFile).nlink, 1);
    assert.equal(lstatSync(join(home, "runtime.json")).mode & 0o077, 0);
    assert.equal(lstatSync(join(home, "runtime.json")).nlink, 1);
    assert.deepEqual(loadRuntimeProfile(home), first);
    assert.equal(JSON.stringify(first).includes(token.toString("ascii").trim()), false);
  } finally {
    token.fill(0);
  }
});

test("mainnet runtime profile requires a public-only external signer before creating runtime files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-runtime-mainnet-reject-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "mainnet-software");
  initializeSandbox(home, encodeBase58(Buffer.alloc(32, 73)), { cluster: "mainnet-beta" });

  assert.throws(
    () => ensureRuntimeProfile(home, { profile: "mainnet-external", signerCommand: process.execPath }),
    { code: "EXTERNAL_SIGNER_DESCRIPTOR_REQUIRED" },
  );
  assert.equal(existsSync(join(home, "api-token")), false);
  assert.equal(existsSync(join(home, "runtime.json")), false);
});

test("insecure mainnet runtime profile requires acknowledgement and binds the generated software key", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-runtime-mainnet-insecure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "mainnet-insecure");
  initializeSandbox(home, encodeBase58(Buffer.alloc(32, 76)), { cluster: "mainnet-beta" });

  assert.throws(
    () => ensureRuntimeProfile(home, { profile: "mainnet-insecure" }),
    { code: "INSECURE_MAINNET_ACKNOWLEDGEMENT_REQUIRED" },
  );
  assert.equal(existsSync(join(home, "runtime.json")), false);
  assert.equal(existsSync(join(home, "api-token")), false);

  const profile = ensureRuntimeProfile(home, {
    profile: "mainnet-insecure",
    acceptInsecureRisk: true,
  });
  assert.equal(profile.profile, "mainnet-insecure");
  assert.equal(profile.signerCommand, null);
  assert.equal(existsSync(join(home, "signer.pem")), true);
  assert.equal(existsSync(join(home, "signer.json")), false);
  assert.equal(lstatSync(join(home, "signer.pem")).mode & 0o077, 0);
});

test("mainnet runtime profile binds an executable external signer and contains no software key", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-runtime-mainnet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "mainnet-external");
  const externalSigner = join(root, "external-signer.js");
  copyFileSync(EXTERNAL_SIGNER, externalSigner);
  chmodSync(externalSigner, 0o700);
  initializeSandbox(home, encodeBase58(Buffer.alloc(32, 74)), {
    cluster: "mainnet-beta",
    signerPublicKey: encodeBase58(Buffer.alloc(32, 75)),
  });

  const profile = ensureRuntimeProfile(home, {
    profile: "mainnet-external",
    signerCommand: externalSigner,
  });
  assert.equal(profile.signerCommand, externalSigner);
  assert.equal(existsSync(join(home, "signer.json")), true);
  assert.equal(existsSync(join(home, "signer.pem")), false);
  assert.equal(existsSync(join(home, "signer.qkey")), false);
});
