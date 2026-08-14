import test from "node:test";
import assert from "node:assert/strict";
import { decodeBase58, encodeBase58 } from "../src/base58.js";
import { MAINNET_GENESIS_HASH } from "../src/constants.js";
import {
  clusterGenesisBytes,
  encodeIntentBundle,
  encodeIntentFrame,
  parseFirmwareOutput,
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
  const output = [
    "QOS_FW:ACCEPT index=0 tx_hex=010203",
    "QOS_FW:REJECT index=1 code=AMOUNT",
    "QOS_FW:REJECT index=2 code=NONCE_REPLAY",
    "QOS_FW:DONE",
  ].join("\n");
  assert.deepEqual(parseFirmwareOutput(output), Buffer.from([1, 2, 3]));
  assert.throws(() => parseFirmwareOutput(output.replace("NONCE_REPLAY", "OTHER")), { code: "FIRMWARE_REPLAY_TEST_FAILED" });
  assert.throws(() => parseFirmwareOutput(`${output}\nQOS_FW:ACCEPT index=2 tx_hex=04`), { code: "FIRMWARE_ACCEPT_SET_INVALID" });
});
