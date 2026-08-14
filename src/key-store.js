import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
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
import { canonicalJson, hasExactKeys } from "./canonical.js";
import { assertQos, QosError } from "./errors.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ENCRYPTED_KEY_KEYS = ["version", "keyType", "publicKey", "kdf", "kdfParams", "cipher", "iv", "ciphertext", "tag"];
const SCRYPT_N = 1 << 18;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

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

export function loadPrivateKey(path) {
  requirePrivatePermissions(path);
  const bytes = readFileSync(path);
  let key;
  try {
    key = createPrivateKey(bytes);
  } finally {
    bytes.fill(0);
  }
  assertQos(key.asymmetricKeyType === "ed25519", "WRONG_KEY_TYPE", "Signer key must be Ed25519");
  return key;
}

function canonicalBase64(text, expectedLength, field) {
  assertQos(typeof text === "string", "INVALID_ENCRYPTED_KEY", `${field} must be canonical base64`);
  const bytes = Buffer.from(text, "base64");
  assertQos((expectedLength === undefined || bytes.length === expectedLength) && bytes.toString("base64") === text, "INVALID_ENCRYPTED_KEY", `${field} must be canonical base64`);
  return bytes;
}

function readPassphrase(path) {
  requirePrivatePermissions(path);
  const stat = statSync(path);
  assertQos(stat.isFile() && stat.size >= 16 && stat.size <= 4096, "INVALID_PASSPHRASE_FILE", "Passphrase file must contain 16 to 4096 bytes");
  const bytes = readFileSync(path);
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0a) {
    const end = bytes.length > 1 && bytes[bytes.length - 2] === 0x0d ? bytes.length - 2 : bytes.length - 1;
    const withoutNewline = Buffer.from(bytes.subarray(0, end));
    bytes.fill(0);
    assertQos(withoutNewline.length >= 16, "WEAK_PASSPHRASE", "Passphrase must contain at least 16 bytes excluding its final newline");
    return withoutNewline;
  }
  return bytes;
}

function encryptedKeyAad(value) {
  return Buffer.from(canonicalJson({
    version: value.version,
    keyType: value.keyType,
    publicKey: value.publicKey,
    kdf: value.kdf,
    kdfParams: value.kdfParams,
    cipher: value.cipher,
    iv: value.iv,
  }), "utf8");
}

function encryptPrivateKey(privateKey, passphrasePath) {
  const passphrase = readPassphrase(passphrasePath);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = privateKey.export({ type: "pkcs8", format: "der" });
  let key;
  let ciphertext;
  let tag;
  try {
    key = scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
    const header = {
      version: 1,
      keyType: "ed25519-pkcs8",
      publicKey: publicKeyAddress(privateKey),
      kdf: "scrypt",
      kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("base64") },
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
    };
    const aad = encryptedKeyAad(header);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
    aad.fill(0);
    return { ...header, ciphertext: ciphertext.toString("base64"), tag: tag.toString("base64") };
  } finally {
    passphrase.fill(0);
    salt.fill(0);
    iv.fill(0);
    plaintext.fill(0);
    key?.fill(0);
    ciphertext?.fill(0);
    tag?.fill(0);
  }
}

export function writeNewEncryptedEd25519Key(path, passphrasePath) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const encrypted = encryptPrivateKey(privateKey, passphrasePath);
  try {
    writeFileSync(path, `${JSON.stringify(encrypted, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new QosError("KEY_ALREADY_EXISTS", `Refusing to overwrite existing key: ${path}`);
    }
    throw error;
  }
  return privateKey;
}

export function loadEncryptedPrivateKey(path, passphrasePath) {
  requirePrivatePermissions(path);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new QosError("INVALID_ENCRYPTED_KEY", "Encrypted key file is not valid JSON");
  }
  assertQos(hasExactKeys(value, ENCRYPTED_KEY_KEYS), "INVALID_ENCRYPTED_KEY", "Encrypted key file has missing or unknown fields");
  assertQos(value.version === 1 && value.keyType === "ed25519-pkcs8" && value.kdf === "scrypt" && value.cipher === "aes-256-gcm", "INVALID_ENCRYPTED_KEY", "Encrypted key algorithms are unsupported");
  assertQos(hasExactKeys(value.kdfParams, ["N", "r", "p", "salt"]), "INVALID_ENCRYPTED_KEY", "Encrypted key KDF parameters are invalid");
  assertQos(value.kdfParams.N === SCRYPT_N && value.kdfParams.r === SCRYPT_R && value.kdfParams.p === SCRYPT_P, "INVALID_ENCRYPTED_KEY", "Encrypted key KDF parameters were weakened or changed");
  const salt = canonicalBase64(value.kdfParams.salt, 32, "kdfParams.salt");
  const iv = canonicalBase64(value.iv, 12, "iv");
  const ciphertext = canonicalBase64(value.ciphertext, undefined, "ciphertext");
  const tag = canonicalBase64(value.tag, 16, "tag");
  assertQos(ciphertext.length >= 32 && ciphertext.length <= 4096, "INVALID_ENCRYPTED_KEY", "Encrypted PKCS#8 length is invalid");
  const passphrase = readPassphrase(passphrasePath);
  let key;
  let plaintext;
  try {
    key = scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
    const aad = encryptedKeyAad(value);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new QosError("KEY_DECRYPTION_FAILED", "Encrypted key authentication failed");
    } finally {
      aad.fill(0);
    }
    const privateKey = createPrivateKey({ key: plaintext, type: "pkcs8", format: "der" });
    assertQos(privateKey.asymmetricKeyType === "ed25519", "WRONG_KEY_TYPE", "Signer key must be Ed25519");
    assertQos(publicKeyAddress(privateKey) === value.publicKey, "KEY_IDENTITY_MISMATCH", "Encrypted key public identity does not match its authenticated header");
    return privateKey;
  } finally {
    passphrase.fill(0);
    salt.fill(0);
    iv.fill(0);
    ciphertext.fill(0);
    tag.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
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
