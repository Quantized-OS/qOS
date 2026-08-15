#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { loadEncryptedPrivateKey, loadPrivateKey, publicKeyAddress } from "../src/key-store.js";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function requireSyntheticPath(path, root) {
  const resolved = resolve(path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || rel === "" && resolved !== root) {
    fail("agent-key-probe refused a path outside the synthetic test root");
  }
  return resolved;
}

function syntheticRoot(home) {
  const resolved = resolve(home);
  const rel = relative(tmpdir(), resolved);
  const rootName = rel.split(sep)[0];
  if (!rootName.startsWith("qos-agent-security-")) {
    fail("agent-key-probe only accepts qos-agent-security temporary homes");
  }
  return resolve(tmpdir(), rootName);
}

function inspectFile(path) {
  if (!existsSync(path)) return { exists: false };
  let bytes;
  try {
    bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    const containsPrivateKeyMarker = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
    return {
      exists: true,
      readable: true,
      bytes: bytes.length,
      containsPrivateKeyMarker,
    };
  } catch {
    return { exists: true, readable: false };
  } finally {
    bytes?.fill(0);
  }
}

function probePrivateKey(home, files, passphrasePath) {
  const signerPem = files.find((file) => file.name === "signer.pem");
  const signerQkey = files.find((file) => file.name === "signer.qkey");
  let canLoadPrivateKey = false;
  let canDecryptPrivateKey = false;
  let recoveredPublicKey;

  if (signerPem?.readable) {
    try {
      const key = loadPrivateKey(signerPem.path);
      recoveredPublicKey = publicKeyAddress(key);
      canLoadPrivateKey = true;
    } catch {
      canLoadPrivateKey = false;
    }
  }

  let passphraseReadable = false;
  if (passphrasePath) {
    try {
      const passphrase = readFileSync(passphrasePath);
      passphraseReadable = passphrase.length >= 16;
      passphrase.fill(0);
    } catch {
      passphraseReadable = false;
    }
  }

  if (signerQkey?.readable && passphraseReadable) {
    try {
      const key = loadEncryptedPrivateKey(signerQkey.path, passphrasePath);
      recoveredPublicKey = publicKeyAddress(key);
      canDecryptPrivateKey = true;
    } catch {
      canDecryptPrivateKey = false;
    }
  }

  return {
    homeReadable: true,
    files: files.map(({ path, ...file }) => file),
    privateKeyReadable: files.some((file) => file.containsPrivateKeyMarker === true),
    canLoadPrivateKey,
    canDecryptPrivateKey,
    passphraseReadable,
    recoveredPublicKey,
    emittedSecretBytes: false,
  };
}

function main() {
  const home = process.env.QOS_AGENT_TEST_HOME;
  if (typeof home !== "string" || home.length === 0) fail("QOS_AGENT_TEST_HOME is required");
  const root = syntheticRoot(home);
  const safeHome = requireSyntheticPath(home, root);
  const passphrasePath = process.env.QOS_AGENT_TEST_PASSPHRASE_PATH
    ? requireSyntheticPath(process.env.QOS_AGENT_TEST_PASSPHRASE_PATH, root)
    : undefined;

  const files = [];
  for (const name of readdirSync(safeHome)) {
    const path = requireSyntheticPath(`${safeHome}/${name}`, root);
    const inspected = inspectFile(path);
    if (inspected.exists) files.push({ name, path, ...inspected });
  }

  process.stdout.write(`${JSON.stringify(probePrivateKey(safeHome, files, passphrasePath))}\n`);
}

try {
  main();
} catch {
  fail("agent-key-probe failed closed");
}
