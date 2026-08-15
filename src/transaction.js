import { sign, verify } from "node:crypto";
import { decodeBase58, encodeBase58 } from "./base58.js";
import {
  MAX_TRANSACTION_BYTES,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import { assertQos } from "./errors.js";
import { publicKeyObjectFromRaw, rawPublicKey } from "./key-store.js";

export function encodeShortVec(value) {
  assertQos(Number.isSafeInteger(value) && value >= 0, "INVALID_SHORTVEC", "shortvec value must be a non-negative safe integer");
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

function u64le(value) {
  const integer = BigInt(value);
  assertQos(integer >= 0n && integer < (1n << 64n), "INTEGER_OUT_OF_RANGE", "u64 value is outside the unsigned 64-bit range");
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(integer);
  return output;
}

export function buildNativeTransferMessage({ payer, destination, lamports, recentBlockhash }) {
  const payerBytes = decodeBase58(payer, 32);
  const destinationBytes = decodeBase58(destination, 32);
  const systemBytes = decodeBase58(SYSTEM_PROGRAM_ID, 32);
  const blockhashBytes = decodeBase58(recentBlockhash, 32);
  const sameAccount = payerBytes.equals(destinationBytes);
  const accounts = sameAccount
    ? [payerBytes, systemBytes]
    : [payerBytes, destinationBytes, systemBytes];
  const destinationIndex = sameAccount ? 0 : 1;
  const systemIndex = accounts.length - 1;
  const instructionData = Buffer.concat([Buffer.from([2, 0, 0, 0]), u64le(lamports)]);
  const instruction = Buffer.concat([
    Buffer.from([systemIndex]),
    encodeShortVec(2),
    Buffer.from([0, destinationIndex]),
    encodeShortVec(instructionData.length),
    instructionData,
  ]);
  return Buffer.concat([
    Buffer.from([1, 0, 1]),
    encodeShortVec(accounts.length),
    ...accounts,
    blockhashBytes,
    encodeShortVec(1),
    instruction,
  ]);
}

export function buildTokenTransferCheckedMessage({
  payer,
  sourceTokenAccount,
  destinationTokenAccount,
  mint,
  tokenProgram,
  amount,
  decimals,
  recentBlockhash,
}) {
  assertQos(tokenProgram === TOKEN_PROGRAM_ID || tokenProgram === TOKEN_2022_PROGRAM_ID, "UNSUPPORTED_TOKEN_PROGRAM", "Only the pinned Token and Token-2022 programs are supported");
  assertQos(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, "INVALID_TOKEN_DECIMALS", "Token decimals must fit in u8");
  const accounts = [
    decodeBase58(payer, 32),
    decodeBase58(sourceTokenAccount, 32),
    decodeBase58(destinationTokenAccount, 32),
    decodeBase58(mint, 32),
    decodeBase58(tokenProgram, 32),
  ];
  assertQos(new Set(accounts.map((account) => account.toString("hex"))).size === accounts.length, "DUPLICATE_TRANSACTION_ACCOUNT", "Token transfer template requires five distinct accounts");
  const instructionData = Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([decimals])]);
  const instruction = Buffer.concat([
    Buffer.from([4]),
    encodeShortVec(4),
    Buffer.from([1, 3, 2, 0]),
    encodeShortVec(instructionData.length),
    instructionData,
  ]);
  return Buffer.concat([
    Buffer.from([1, 0, 2]),
    encodeShortVec(accounts.length),
    ...accounts,
    decodeBase58(recentBlockhash, 32),
    encodeShortVec(1),
    instruction,
  ]);
}

export function signMessage(message, privateKey) {
  const publicKeyBytes = rawPublicKey(privateKey);
  let signature;
  try {
    signature = sign(null, message, privateKey);
    return assembleSignedTransaction(message, publicKeyBytes, signature);
  } finally {
    signature?.fill(0);
    publicKeyBytes.fill(0);
  }
}

export function assembleSignedTransaction(message, publicKeyBytes, signatureBytes) {
  const publicKey = Buffer.from(publicKeyBytes);
  const signature = Buffer.from(signatureBytes);
  let transaction;
  try {
    assertQos(publicKey.length === 32, "INVALID_PUBLIC_KEY", "Ed25519 public key must be 32 bytes");
    assertQos(signature.length === 64, "INVALID_SIGNATURE", "Ed25519 signer returned a non-64-byte signature");
    assertQos(verify(null, message, publicKeyObjectFromRaw(publicKey), signature), "SIGNATURE_SELF_CHECK_FAILED", "Generated signature did not verify");
    transaction = Buffer.concat([encodeShortVec(1), signature, message]);
    assertQos(transaction.length <= MAX_TRANSACTION_BYTES, "TRANSACTION_TOO_LARGE", "Serialized transaction exceeds Solana's 1232-byte limit");
    return {
      signature: encodeBase58(signature),
      publicKey: encodeBase58(publicKey),
      messageBase64: Buffer.from(message).toString("base64"),
      transactionBase64: transaction.toString("base64"),
      transactionBytes: transaction.length,
    };
  } finally {
    signature.fill(0);
    publicKey.fill(0);
    transaction?.fill(0);
  }
}

class Reader {
  constructor(buffer) {
    const bytes = Buffer.from(buffer);
    assertQos(bytes.length <= MAX_TRANSACTION_BYTES - 65, "TRANSACTION_TOO_LARGE", "Serialized message exceeds the pinned Solana transaction limit");
    this.buffer = bytes;
    this.offset = 0;
  }
  bytes(length) {
    assertQos(this.offset + length <= this.buffer.length, "TRUNCATED_TRANSACTION", "Serialized message is truncated");
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  byte() {
    return this.bytes(1)[0];
  }
  shortVec() {
    const start = this.offset;
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 4; i += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        assertQos(encodeShortVec(value).equals(this.buffer.subarray(start, this.offset)), "NON_CANONICAL_SHORTVEC", "Serialized message contains a non-canonical compact length");
        return value;
      }
      multiplier *= 128;
    }
    assertQos(false, "INVALID_SHORTVEC", "shortvec is too long");
  }
}

export function parseNativeTransferMessage(message) {
  const reader = new Reader(message);
  const header = [reader.byte(), reader.byte(), reader.byte()];
  assertQos(header[0] === 1 && header[1] === 0 && header[2] === 1, "UNEXPECTED_MESSAGE_HEADER", "Message header does not match the pinned template");
  const accountCount = reader.shortVec();
  assertQos(accountCount === 2 || accountCount === 3, "UNEXPECTED_ACCOUNTS", "Pinned transfer requires two or three accounts");
  const accounts = Array.from({ length: accountCount }, () => encodeBase58(reader.bytes(32)));
  const blockhash = encodeBase58(reader.bytes(32));
  assertQos(reader.shortVec() === 1, "UNEXPECTED_INSTRUCTIONS", "Pinned template requires exactly one instruction");
  const programIndex = reader.byte();
  const accountIndexCount = reader.shortVec();
  assertQos(accountIndexCount === 2, "UNEXPECTED_INSTRUCTION_ACCOUNTS", "System transfer requires two account indexes");
  const indexes = [...reader.bytes(2)];
  const dataLength = reader.shortVec();
  const data = reader.bytes(dataLength);
  assertQos(reader.offset === reader.buffer.length, "TRAILING_TRANSACTION_DATA", "Message contains trailing bytes");
  assertQos(programIndex === accounts.length - 1 && accounts[programIndex] === SYSTEM_PROGRAM_ID, "WRONG_PROGRAM", "Only the System Program is allowed");
  const expectedDestinationIndex = accountCount === 2 ? 0 : 1;
  assertQos(indexes[0] === 0 && indexes[1] === expectedDestinationIndex, "WRONG_ACCOUNTS", "Transfer accounts do not match the pinned template");
  assertQos(data.length === 12 && data.readUInt32LE(0) === 2, "WRONG_INSTRUCTION", "Only SystemProgram.transfer is allowed");
  return {
    payer: accounts[0],
    destination: accounts[indexes[1]],
    systemProgram: accounts[programIndex],
    recentBlockhash: blockhash,
    lamports: data.readBigUInt64LE(4),
  };
}

export function parseTokenTransferCheckedMessage(message) {
  const reader = new Reader(message);
  const header = [reader.byte(), reader.byte(), reader.byte()];
  assertQos(header[0] === 1 && header[1] === 0 && header[2] === 2, "UNEXPECTED_MESSAGE_HEADER", "Token message header does not match the pinned template");
  const accountCount = reader.shortVec();
  assertQos(accountCount === 5, "UNEXPECTED_ACCOUNTS", "Pinned token transfer requires exactly five accounts");
  const accounts = Array.from({ length: accountCount }, () => encodeBase58(reader.bytes(32)));
  assertQos(new Set(accounts).size === accounts.length, "DUPLICATE_TRANSACTION_ACCOUNT", "Token transfer message contains duplicate accounts");
  const recentBlockhash = encodeBase58(reader.bytes(32));
  assertQos(reader.shortVec() === 1, "UNEXPECTED_INSTRUCTIONS", "Pinned token template requires exactly one instruction");
  const programIndex = reader.byte();
  assertQos(reader.shortVec() === 4, "UNEXPECTED_INSTRUCTION_ACCOUNTS", "TransferChecked requires four account indexes");
  const indexes = [...reader.bytes(4)];
  const dataLength = reader.shortVec();
  const data = reader.bytes(dataLength);
  assertQos(reader.offset === reader.buffer.length, "TRAILING_TRANSACTION_DATA", "Message contains trailing bytes");
  assertQos(programIndex === 4 && (accounts[programIndex] === TOKEN_PROGRAM_ID || accounts[programIndex] === TOKEN_2022_PROGRAM_ID), "WRONG_PROGRAM", "Only the pinned Token or Token-2022 program is allowed");
  assertQos(indexes[0] === 1 && indexes[1] === 3 && indexes[2] === 2 && indexes[3] === 0, "WRONG_ACCOUNTS", "TransferChecked accounts do not match the pinned template");
  assertQos(data.length === 10 && data[0] === 12, "WRONG_INSTRUCTION", "Only SPL Token TransferChecked is allowed");
  return {
    payer: accounts[0],
    sourceTokenAccount: accounts[1],
    destinationTokenAccount: accounts[2],
    mint: accounts[3],
    tokenProgram: accounts[4],
    recentBlockhash,
    amount: data.readBigUInt64LE(1),
    decimals: data[9],
  };
}
