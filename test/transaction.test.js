import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { encodeBase58 } from "../src/base58.js";
import { publicKeyObjectFromRaw, rawPublicKey } from "../src/key-store.js";
import {
  buildNativeTransferMessage,
  encodeShortVec,
  parseNativeTransferMessage,
  signMessage,
} from "../src/transaction.js";

test("shortvec encodes Solana compact lengths", () => {
  assert.deepEqual([...encodeShortVec(0)], [0]);
  assert.deepEqual([...encodeShortVec(127)], [127]);
  assert.deepEqual([...encodeShortVec(128)], [128, 1]);
  assert.deepEqual([...encodeShortVec(16384)], [128, 128, 1]);
});

test("native transfer message exactly round-trips the pinned template", () => {
  const payer = encodeBase58(Buffer.alloc(32, 7));
  const destination = encodeBase58(Buffer.alloc(32, 8));
  const recentBlockhash = encodeBase58(Buffer.alloc(32, 9));
  const message = buildNativeTransferMessage({ payer, destination, lamports: 123456n, recentBlockhash });
  assert.deepEqual(parseNativeTransferMessage(message), {
    payer,
    destination,
    systemProgram: "11111111111111111111111111111111",
    recentBlockhash,
    lamports: 123456n,
  });
});

test("signed transaction has a verifiable Ed25519 signature", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const payer = encodeBase58(rawPublicKey(privateKey));
  const message = buildNativeTransferMessage({
    payer,
    destination: encodeBase58(Buffer.alloc(32, 4)),
    lamports: 42n,
    recentBlockhash: encodeBase58(Buffer.alloc(32, 5)),
  });
  const signed = signMessage(message, privateKey);
  const serialized = Buffer.from(signed.transactionBase64, "base64");
  assert.equal(serialized[0], 1);
  assert.equal(signed.signature.length > 80, true);
  assert.equal(verify(null, message, publicKeyObjectFromRaw(rawPublicKey(privateKey)), serialized.subarray(1, 65)), true);
  assert.deepEqual(serialized.subarray(65), message);
  assert.equal(signed.transactionBytes, serialized.length);
});

test("message parser rejects trailing instructions or data", () => {
  const message = buildNativeTransferMessage({
    payer: encodeBase58(Buffer.alloc(32, 2)),
    destination: encodeBase58(Buffer.alloc(32, 3)),
    lamports: 1n,
    recentBlockhash: encodeBase58(Buffer.alloc(32, 4)),
  });
  assert.throws(() => parseNativeTransferMessage(Buffer.concat([message, Buffer.from([0])])), { code: "TRAILING_TRANSACTION_DATA" });
});
