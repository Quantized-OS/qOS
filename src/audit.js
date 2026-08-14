import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { canonicalJson, hasExactKeys } from "./canonical.js";
import { INITIAL_AUDIT_HASH } from "./constants.js";
import { assertQos, QosError } from "./errors.js";
import { parseUnsigned } from "./policy.js";

const RECORD_KEYS = [
  "sequence",
  "requestNonce",
  "timestamp",
  "intentDigest",
  "messageDigest",
  "signature",
  "publicKey",
  "feeLamports",
  "previousHash",
  "recordHash",
  "hmac",
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function payloadOf(record) {
  return {
    sequence: record.sequence,
    requestNonce: record.requestNonce,
    timestamp: record.timestamp,
    intentDigest: record.intentDigest,
    messageDigest: record.messageDigest,
    signature: record.signature,
    publicKey: record.publicKey,
    feeLamports: record.feeLamports,
    previousHash: record.previousHash,
  };
}

function equalHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length || !/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export class AuditLog {
  constructor(path, lockPath, key) {
    this.path = path;
    this.lockPath = lockPath;
    this.key = Buffer.from(key);
  }

  readVerified() {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    if (text.length === 0) return [];
    assertQos(text.endsWith("\n"), "AUDIT_TRUNCATED", "Audit log does not end at a record boundary");
    const lines = text.slice(0, -1).split("\n");
    const records = [];
    let previousHash = INITIAL_AUDIT_HASH;
    let previousNonce = 0n;
    let previousTimestamp = 0;
    for (let index = 0; index < lines.length; index += 1) {
      let record;
      try {
        record = JSON.parse(lines[index]);
      } catch {
        throw new QosError("AUDIT_PARSE_FAILED", `Audit record ${index + 1} is invalid JSON`);
      }
      assertQos(hasExactKeys(record, RECORD_KEYS), "AUDIT_SHAPE_FAILED", `Audit record ${index + 1} has an invalid shape`);
      assertQos(record.sequence === index + 1, "AUDIT_SEQUENCE_FAILED", "Audit sequence is not contiguous");
      const nonce = parseUnsigned(record.requestNonce, 128, "audit.requestNonce");
      assertQos(nonce > previousNonce, "AUDIT_NONCE_FAILED", "Audit nonces are not strictly increasing");
      assertQos(record.previousHash === previousHash, "AUDIT_CHAIN_FAILED", "Audit hash chain is broken");
      const expectedHash = sha256(canonicalJson(payloadOf(record)));
      const expectedHmac = createHmac("sha256", this.key).update(expectedHash).digest("hex");
      assertQos(equalHex(record.recordHash, expectedHash), "AUDIT_HASH_FAILED", "Audit record hash does not verify");
      assertQos(equalHex(record.hmac, expectedHmac), "AUDIT_HMAC_FAILED", "Audit record authentication failed");
      const timestamp = Date.parse(record.timestamp);
      assertQos(Number.isFinite(timestamp), "AUDIT_TIME_FAILED", "Audit record timestamp is invalid");
      assertQos(timestamp >= previousTimestamp, "AUDIT_TIME_ROLLBACK", "Audit timestamps moved backwards");
      for (const field of ["intentDigest", "messageDigest"]) {
        assertQos(typeof record[field] === "string" && /^[0-9a-f]{64}$/.test(record[field]), "AUDIT_DIGEST_FAILED", `${field} is invalid`);
      }
      parseUnsigned(record.feeLamports, 64, "audit.feeLamports");
      records.push(record);
      previousHash = record.recordHash;
      previousNonce = nonce;
      previousTimestamp = timestamp;
    }
    return records;
  }

  lastNonce() {
    const records = this.readVerified();
    return records.length === 0 ? 0n : BigInt(records.at(-1).requestNonce);
  }

  authorizeAndAppend({ requestNonce, intentDigest, messageDigest, signature, publicKey, feeLamports }, maxRequestsPerMinute) {
    let lock;
    try {
      lock = openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new QosError("SIGNER_BUSY", "Signer state is locked; refusing concurrent authorization");
      }
      throw error;
    }
    try {
      const records = this.readVerified();
      const nonce = parseUnsigned(requestNonce, 128, "requestNonce");
      const lastNonce = records.length === 0 ? 0n : BigInt(records.at(-1).requestNonce);
      assertQos(nonce > lastNonce, "NONCE_REPLAY", "requestNonce must be strictly greater than the last authorized nonce");
      const cutoff = Date.now() - 60_000;
      const recentCount = records.filter((record) => Date.parse(record.timestamp) >= cutoff).length;
      assertQos(recentCount < maxRequestsPerMinute, "RATE_LIMITED", "Signer rate limit exceeded");
      const now = Date.now();
      if (records.length > 0) {
        assertQos(now >= Date.parse(records.at(-1).timestamp), "CLOCK_ROLLBACK", "System clock moved backwards; signer fails closed");
      }
      const payload = {
        sequence: records.length + 1,
        requestNonce,
        timestamp: new Date(now).toISOString(),
        intentDigest,
        messageDigest,
        signature,
        publicKey,
        feeLamports,
        previousHash: records.length === 0 ? INITIAL_AUDIT_HASH : records.at(-1).recordHash,
      };
      const recordHash = sha256(canonicalJson(payload));
      const hmac = createHmac("sha256", this.key).update(recordHash).digest("hex");
      const record = { ...payload, recordHash, hmac };
      const descriptor = openSync(this.path, "a", 0o600);
      try {
        writeSync(descriptor, `${JSON.stringify(record)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return record;
    } finally {
      closeSync(lock);
      unlinkSync(this.lockPath);
    }
  }
}

export function digestCanonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
