import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, readFileSync, readlinkSync } from "node:fs";
import { decodeBase58, encodeBase58 } from "../src/base58.js";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from "../src/constants.js";
import {
  clusterGenesisBytes,
  encodeKeyMailbox,
  encodeIntentBundle,
  encodeIntentFrame,
  openRamBackedFile,
  parseFirmwareOutput,
  redactFirmwareOutput,
  validateProvisioningRecord,
} from "../bin/qos-firmware-demo.js";

function frame(overrides = {}) {
  return encodeIntentFrame({
    requestNonce: 1n,
    clusterGenesis: encodeBase58(Buffer.alloc(32, 1)),
    destination: encodeBase58(Buffer.alloc(32, 2)),
    amount: 1_000_000n,
    minimumOutput: 1_000_000n,
    maxFeeLamports: 10_000n,
    recentBlockhash: encodeBase58(Buffer.alloc(32, 3)),
    expiresAtSlot: 220n,
    currentSlot: 100n,
    strategyId: 1,
    ...overrides,
  });
}

test("firmware pads the canonical mainnet genesis identity to its 32-byte field", () => {
  const decoded = decodeBase58(MAINNET_GENESIS_HASH);
  assert.equal(decoded.length, 23);
  const bytes = clusterGenesisBytes(MAINNET_GENESIS_HASH);
  assert.equal(bytes.length, 32);
  assert.deepEqual(bytes.subarray(0, 9), Buffer.alloc(9));
  assert.deepEqual(bytes.subarray(9), decoded);
  assert.deepEqual(frame({ clusterGenesis: MAINNET_GENESIS_HASH }).subarray(24, 56), bytes);
});

test("firmware key mailbox has a fixed typed format", () => {
  const seed = Buffer.alloc(32, 9);
  const mailbox = encodeKeyMailbox(seed);
  assert.equal(mailbox.length, 40);
  assert.equal(mailbox.subarray(0, 8).toString(), "QOSKEYV1");
  assert.deepEqual(mailbox.subarray(8), seed);
  mailbox.fill(0);
  seed.fill(0);
});

test("QEMU mailbox is unlinked immediately from Linux tmpfs", { skip: process.platform !== "linux" }, () => {
  const contents = Buffer.from("ephemeral-qos-test");
  const fd = openRamBackedFile(contents, "test");
  try {
    assert.deepEqual(readFileSync("/proc/self/fd/" + fd), contents);
    assert.match(readlinkSync("/proc/self/fd/" + fd), /\(deleted\)$/);
  } finally {
    closeSync(fd);
    contents.fill(0);
  }
});

test("firmware intent wire format is fixed-length and canonical", () => {
  const encoded = frame();
  assert.equal(encoded.length, 304);
  assert.equal(encoded.readUInt32LE(0), 2);
  assert.equal(encoded.readBigUInt64LE(88), 1_000_000n);
  assert.equal(encoded.readBigUInt64LE(104), 10_000n);
  assert.equal(encoded.readBigUInt64LE(144), 220n);
  assert.equal(encoded.readUInt32LE(164), 0);
});

test("firmware bundle declares exact frame count and size", () => {
  const bundle = encodeIntentBundle([frame(), frame({ requestNonce: 2n })]);
  assert.equal(bundle.subarray(0, 8).toString(), "QOSINTV2");
  assert.equal(bundle.readUInt32LE(8), 2);
  assert.equal(bundle.readUInt32LE(12), 304);
  assert.equal(bundle.length, 16 + 2 * 304);
  assert.throws(() => encodeIntentBundle([Buffer.alloc(303)]), { code: "INVALID_DEMO_FRAME" });
});

test("firmware frame rejects a nonce that cannot fit in the wire format", () => {
  assert.throws(() => frame({ requestNonce: 1n << 128n }), { code: "INTEGER_OUT_OF_RANGE" });
});

test("firmware token frame pins mint, token accounts, program, and decimals", () => {
  const encoded = frame({
    asset: "token",
    mint: encodeBase58(Buffer.alloc(32, 4)),
    sourceTokenAccount: encodeBase58(Buffer.alloc(32, 5)),
    destinationTokenAccount: encodeBase58(Buffer.alloc(32, 6)),
    tokenProgram: encodeBase58(Buffer.alloc(32, 7)),
    decimals: 6,
  });
  assert.equal(encoded.readUInt32LE(4), 1);
  assert.deepEqual(encoded.subarray(168, 200), Buffer.alloc(32, 4));
  assert.deepEqual(encoded.subarray(200, 232), Buffer.alloc(32, 5));
  assert.deepEqual(encoded.subarray(232, 264), Buffer.alloc(32, 6));
  assert.deepEqual(encoded.subarray(264, 296), Buffer.alloc(32, 7));
  assert.equal(encoded[296], 6);
});

test("demo transcript must prove acceptance, tamper rejection, and replay rejection", () => {
  const signatureHex = "ab".repeat(64);
  const output = [
    `QOS_FW:ACCEPT index=0 signature_hex=${signatureHex}`,
    "QOS_FW:REJECT index=1 code=AMOUNT",
    "QOS_FW:REJECT index=2 code=NONCE_REPLAY",
    "QOS_FW:DONE",
  ].join("\n");
  assert.deepEqual(parseFirmwareOutput(output), Buffer.alloc(64, 0xab));
  assert.throws(() => parseFirmwareOutput(output.replace("NONCE_REPLAY", "OTHER")), { code: "FIRMWARE_REPLAY_TEST_FAILED" });
  let failure;
  try {
    parseFirmwareOutput(`${output}\nQOS_FW:ACCEPT index=2 signature_hex=${"cd".repeat(64)}`);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "FIRMWARE_ACCEPT_SET_INVALID");
  assert.equal(failure.details.output.includes(signatureHex), false);
  assert.match(failure.details.output, /signature_hex=<redacted-in-memory>/);
  const redacted = redactFirmwareOutput(output);
  assert.equal(redacted.includes(signatureHex), false);
  assert.match(redacted, /signature_hex=<redacted-in-memory>/);
});

test("provisioning validation binds the firmware to the sole policy strategy", () => {
  const destination = encodeBase58(Buffer.alloc(32, 41));
  const policy = {
    clusterGenesis: DEVNET_GENESIS_HASH,
    allowedDestinations: [destination],
    allowedStrategyIds: [1],
    maxTransferLamports: "100000000",
    maxFeeLamports: "10000",
    maxIntentTtlSlots: 120,
    tokenTransfer: null,
  };
  const firmwareSha256 = "a".repeat(64);
  const record = {
    version: 3,
    firmwareSha256,
    signer: encodeBase58(Buffer.alloc(32, 42)),
    clusterGenesis: policy.clusterGenesis,
    destination,
    maxTransferLamports: policy.maxTransferLamports,
    maxFeeLamports: policy.maxFeeLamports,
    maxIntentTtlSlots: policy.maxIntentTtlSlots,
    strategyId: 1,
    tokenTransfer: null,
  };
  assert.equal(validateProvisioningRecord(record, policy, firmwareSha256), record);
  assert.throws(
    () => validateProvisioningRecord({ ...record, strategyId: 2 }, policy, firmwareSha256),
    { code: "PROVISIONING_POLICY_MISMATCH" },
  );
  assert.throws(
    () => validateProvisioningRecord(record, { ...policy, allowedStrategyIds: [1, 2] }, firmwareSha256),
    { code: "PROVISIONING_POLICY_MISMATCH" },
  );
});

test("firmware demo exposes conventional help flags without requiring a sandbox", () => {
  for (const flag of ["--help", "-h"]) {
    const result = spawnSync(process.execPath, [new URL("../bin/qos-firmware-demo.js", import.meta.url).pathname, flag], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /qOS QEMU firmware transaction demo/);
  }
});
