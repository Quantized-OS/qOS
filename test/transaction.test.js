import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { encodeBase58 } from "../src/base58.js";
import { publicKeyObjectFromRaw, rawPublicKey } from "../src/key-store.js";
import {
  buildCloudSettlementMessage,
  buildCloudWithdrawalMessage,
  buildNativeTransferMessage,
  buildTokenTransferCheckedMessage,
  encodeShortVec,
  parseCloudSettlementMessage,
  parseCloudWithdrawalMessage,
  parseNativeTransferMessage,
  parseTokenTransferCheckedMessage,
  signMessage,
} from "../src/transaction.js";
import { QOS_TOKEN_MINT, TOKEN_2022_PROGRAM_ID } from "../src/constants.js";

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

test("message parsers reject non-canonical compact lengths", () => {
  const message = buildNativeTransferMessage({
    payer: encodeBase58(Buffer.alloc(32, 7)),
    destination: encodeBase58(Buffer.alloc(32, 8)),
    lamports: 1n,
    recentBlockhash: encodeBase58(Buffer.alloc(32, 9)),
  });
  const nonCanonical = Buffer.concat([message.subarray(0, 3), Buffer.from([0x83, 0]), message.subarray(4)]);
  assert.throws(() => parseNativeTransferMessage(nonCanonical), { code: "NON_CANONICAL_SHORTVEC" });
});

test("transaction builders reject values outside u64", () => {
  assert.throws(() => buildNativeTransferMessage({
    payer: encodeBase58(Buffer.alloc(32, 7)),
    destination: encodeBase58(Buffer.alloc(32, 8)),
    lamports: -1n,
    recentBlockhash: encodeBase58(Buffer.alloc(32, 9)),
  }), { code: "INTEGER_OUT_OF_RANGE" });
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

test("Token-2022 TransferChecked message exactly round-trips the pinned template", () => {
  const payer = encodeBase58(Buffer.alloc(32, 11));
  const sourceTokenAccount = encodeBase58(Buffer.alloc(32, 12));
  const destinationTokenAccount = encodeBase58(Buffer.alloc(32, 13));
  const recentBlockhash = encodeBase58(Buffer.alloc(32, 14));
  const message = buildTokenTransferCheckedMessage({
    payer,
    sourceTokenAccount,
    destinationTokenAccount,
    mint: QOS_TOKEN_MINT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    amount: 2_500_000n,
    decimals: 6,
    recentBlockhash,
  });
  assert.deepEqual(parseTokenTransferCheckedMessage(message), {
    payer,
    sourceTokenAccount,
    destinationTokenAccount,
    mint: QOS_TOKEN_MINT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    recentBlockhash,
    amount: 2_500_000n,
    decimals: 6,
  });
});

test("Token-2022 parser rejects a changed instruction opcode", () => {
  const message = buildTokenTransferCheckedMessage({
    payer: encodeBase58(Buffer.alloc(32, 11)),
    sourceTokenAccount: encodeBase58(Buffer.alloc(32, 12)),
    destinationTokenAccount: encodeBase58(Buffer.alloc(32, 13)),
    mint: QOS_TOKEN_MINT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    amount: 1n,
    decimals: 6,
    recentBlockhash: encodeBase58(Buffer.alloc(32, 14)),
  });
  const tampered = Buffer.from(message);
  tampered[tampered.length - 10] = 3;
  assert.throws(() => parseTokenTransferCheckedMessage(tampered), { code: "WRONG_INSTRUCTION" });
});

test("qOS Cloud settlement atomically allocates 49 percent, 50 percent, and burns 1 percent", () => {
  const payer = encodeBase58(Buffer.alloc(32, 31));
  const sourceTokenAccount = encodeBase58(Buffer.alloc(32, 32));
  const destinationTokenAccount = encodeBase58(Buffer.alloc(32, 33));
  const lotteryDestinationTokenAccount = encodeBase58(Buffer.alloc(32, 39));
  const recentBlockhash = encodeBase58(Buffer.alloc(32, 34));
  const message = buildCloudSettlementMessage({
    payer,
    sourceTokenAccount,
    destinationTokenAccount,
    lotteryDestinationTokenAccount,
    mint: QOS_TOKEN_MINT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    treasuryAmount: 490_000n,
    lotteryAmount: 500_000n,
    burnAmount: 10_000n,
    decimals: 6,
    recentBlockhash,
  });
  assert.deepEqual(parseCloudSettlementMessage(message), {
    payer,
    sourceTokenAccount,
    destinationTokenAccount,
    lotteryDestinationTokenAccount,
    mint: QOS_TOKEN_MINT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    recentBlockhash,
    treasuryAmount: 490_000n,
    lotteryAmount: 500_000n,
    burnAmount: 10_000n,
    decimals: 6,
  });
});

test("qOS Cloud settlement supports a deferred burn remainder with a lottery allocation", () => {
  const message = buildCloudSettlementMessage({
    payer: encodeBase58(Buffer.alloc(32, 35)),
    sourceTokenAccount: encodeBase58(Buffer.alloc(32, 36)),
    destinationTokenAccount: encodeBase58(Buffer.alloc(32, 37)),
    lotteryDestinationTokenAccount: encodeBase58(Buffer.alloc(32, 40)),
    mint: QOS_TOKEN_MINT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    treasuryAmount: 50n,
    lotteryAmount: 49n,
    burnAmount: 0n,
    decimals: 6,
    recentBlockhash: encodeBase58(Buffer.alloc(32, 38)),
  });
  const parsed = parseCloudSettlementMessage(message);
  assert.equal(parsed.treasuryAmount, 50n);
  assert.equal(parsed.lotteryAmount, 49n);
  assert.equal(parsed.burnAmount, 0n);
});

test("qOS Cloud native withdrawal atomically sends the net amount and 0.25-percent fee", () => {
  const payer = encodeBase58(Buffer.alloc(32, 41));
  const destination = encodeBase58(Buffer.alloc(32, 42));
  const treasury = encodeBase58(Buffer.alloc(32, 43));
  const recentBlockhash = encodeBase58(Buffer.alloc(32, 44));
  const parsed = parseCloudWithdrawalMessage(buildCloudWithdrawalMessage({
    payer,
    assetKind: "sol",
    grossAmount: "1000000",
    destinationAmount: "997500",
    feeAmount: "2500",
    destination,
    treasury,
    recentBlockhash,
  }));

  assert.equal(parsed.assetKind, "sol");
  assert.equal(parsed.payer, payer);
  assert.equal(parsed.recentBlockhash, recentBlockhash);
  assert.deepEqual(parsed.transfers, [
    { destination, amount: 997_500n },
    { destination: treasury, amount: 2_500n },
  ]);
});

test("qOS Cloud token withdrawal can create both ATAs and transfer net plus fee", () => {
  const payer = encodeBase58(Buffer.alloc(32, 45));
  const destination = encodeBase58(Buffer.alloc(32, 46));
  const treasury = encodeBase58(Buffer.alloc(32, 47));
  const sourceTokenAccount = encodeBase58(Buffer.alloc(32, 48));
  const destinationTokenAccount = encodeBase58(Buffer.alloc(32, 49));
  const treasuryTokenAccount = encodeBase58(Buffer.alloc(32, 50));
  const recentBlockhash = encodeBase58(Buffer.alloc(32, 51));
  const parsed = parseCloudWithdrawalMessage(buildCloudWithdrawalMessage({
    payer,
    assetKind: "token",
    grossAmount: "2000000",
    destinationAmount: "1995000",
    feeAmount: "5000",
    destination,
    treasury,
    mint: QOS_TOKEN_MINT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    sourceTokenAccount,
    destinationTokenAccount,
    treasuryTokenAccount,
    decimals: 6,
    createDestinationTokenAccount: true,
    createTreasuryTokenAccount: true,
    recentBlockhash,
  }));

  assert.equal(parsed.assetKind, "token");
  assert.equal(parsed.tokenProgram, TOKEN_2022_PROGRAM_ID);
  assert.equal(parsed.createInstructions.length, 2);
  assert.deepEqual(parsed.transfers, [
    { sourceTokenAccount, mint: QOS_TOKEN_MINT, destinationTokenAccount, amount: 1_995_000n, decimals: 6 },
    { sourceTokenAccount, mint: QOS_TOKEN_MINT, destinationTokenAccount: treasuryTokenAccount, amount: 5_000n, decimals: 6 },
  ]);
});
