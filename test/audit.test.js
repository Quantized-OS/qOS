import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AuditLog } from "../src/audit.js";

function fields(requestNonce) {
  return {
    requestNonce,
    intentDigest: "1".repeat(64),
    messageDigest: "2".repeat(64),
    signature: "signature",
    publicKey: "public-key",
    feeLamports: "5000",
  };
}

test("audit chain authenticates records and rejects nonce replay", () => {
  const home = mkdtempSync(join(tmpdir(), "qos-audit-"));
  const log = new AuditLog(join(home, "audit.log"), join(home, "audit.lock"), randomBytes(32));
  log.authorizeAndAppend(fields("1"), 10);
  log.authorizeAndAppend(fields("2"), 10);
  assert.equal(log.readVerified().length, 2);
  assert.equal(log.lastNonce(), 2n);
  assert.throws(() => log.authorizeAndAppend(fields("2"), 10), { code: "NONCE_REPLAY" });
});

test("audit verification fails closed after tampering", () => {
  const home = mkdtempSync(join(tmpdir(), "qos-audit-"));
  const path = join(home, "audit.log");
  const log = new AuditLog(path, join(home, "audit.lock"), randomBytes(32));
  log.authorizeAndAppend(fields("1"), 10);
  writeFileSync(path, readFileSync(path, "utf8").replace("5000", "5001"));
  assert.throws(() => log.readVerified(), { code: "AUDIT_HASH_FAILED" });
});
