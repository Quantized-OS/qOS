import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { encodeBase58 } from "./base58.js";
import { assertQos, QosError } from "./errors.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function requirePrivatePermissions(path) {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  assertQos((mode & 0o077) === 0, "INSECURE_KEY_PERMISSIONS", `${path} must not be accessible by group or other users`);
}

export function writeNewEd25519Key(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  try {
    writeFileSync(path, pem, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new QosError("KEY_ALREADY_EXISTS", `Refusing to overwrite existing key: ${path}`);
    }
    throw error;
  }
  return privateKey;
}

export function writeNewAuditKey(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new QosError("KEY_ALREADY_EXISTS", `Refusing to overwrite existing key: ${path}`);
    }
    throw error;
  }
}

export function loadPrivateKey(path) {
  requirePrivatePermissions(path);
  const key = createPrivateKey(readFileSync(path));
  assertQos(key.asymmetricKeyType === "ed25519", "WRONG_KEY_TYPE", "Signer key must be Ed25519");
  return key;
}

export function loadAuditKey(path) {
  requirePrivatePermissions(path);
  const key = readFileSync(path);
  assertQos(key.length === 32, "INVALID_AUDIT_KEY", "Audit key must contain exactly 32 bytes");
  return key;
}

export function rawPublicKey(privateKey) {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  assertQos(
    der.length === ED25519_SPKI_PREFIX.length + 32 && der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX),
    "INVALID_PUBLIC_KEY",
    "Unexpected Ed25519 public-key encoding",
  );
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

export function publicKeyAddress(privateKey) {
  return encodeBase58(rawPublicKey(privateKey));
}

export function publicKeyObjectFromRaw(raw) {
  assertQos(Buffer.from(raw).length === 32, "INVALID_PUBLIC_KEY", "Ed25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    type: "spki",
    format: "der",
  });
}

export function privateKeySeed(privateKey) {
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  assertQos(
    der.length === ED25519_PKCS8_SEED_PREFIX.length + 32 && der.subarray(0, ED25519_PKCS8_SEED_PREFIX.length).equals(ED25519_PKCS8_SEED_PREFIX),
    "INVALID_PRIVATE_KEY",
    "Unexpected Ed25519 PKCS#8 private-key encoding",
  );
  return der.subarray(ED25519_PKCS8_SEED_PREFIX.length);
}
