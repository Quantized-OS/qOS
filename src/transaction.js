import { sign, verify } from "node:crypto";
import { decodeBase58, encodeBase58 } from "./base58.js";
import { MAX_TRANSACTION_BYTES, SYSTEM_PROGRAM_ID } from "./constants.js";
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
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(BigInt(value));
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

export function signMessage(message, privateKey) {
  const publicKeyBytes = rawPublicKey(privateKey);
  const signature = sign(null, message, privateKey);
  assertQos(signature.length === 64, "INVALID_SIGNATURE", "Ed25519 signer returned a non-64-byte signature");
  assertQos(verify(null, message, publicKeyObjectFromRaw(publicKeyBytes), signature), "SIGNATURE_SELF_CHECK_FAILED", "Generated signature did not verify");
  const transaction = Buffer.concat([encodeShortVec(1), signature, message]);
  assertQos(transaction.length <= MAX_TRANSACTION_BYTES, "TRANSACTION_TOO_LARGE", "Serialized transaction exceeds Solana's 1232-byte limit");
  return {
    signature: encodeBase58(signature),
    publicKey: encodeBase58(publicKeyBytes),
    messageBase64: Buffer.from(message).toString("base64"),
    transactionBase64: transaction.toString("base64"),
    transactionBytes: transaction.length,
  };
}

class Reader {
  constructor(buffer) {
    this.buffer = Buffer.from(buffer);
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
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = this.byte();
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
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
  assertQos(accounts[programIndex] === SYSTEM_PROGRAM_ID, "WRONG_PROGRAM", "Only the System Program is allowed");
  assertQos(indexes[0] === 0 && indexes[1] < accounts.length, "WRONG_ACCOUNTS", "Transfer accounts do not match the pinned template");
  assertQos(data.length === 12 && data.readUInt32LE(0) === 2, "WRONG_INSTRUCTION", "Only SystemProgram.transfer is allowed");
  return {
    payer: accounts[0],
    destination: accounts[indexes[1]],
    systemProgram: accounts[programIndex],
    recentBlockhash: blockhash,
    lamports: data.readBigUInt64LE(4),
  };
}
