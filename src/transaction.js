import { sign, verify } from "node:crypto";
import { decodeBase58, encodeBase58 } from "./base58.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
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

export function buildCloudSettlementMessage({
  payer,
  sourceTokenAccount,
  destinationTokenAccount,
  mint,
  tokenProgram,
  treasuryAmount,
  burnAmount,
  decimals,
  recentBlockhash,
}) {
  assertQos(tokenProgram === TOKEN_2022_PROGRAM_ID, "UNSUPPORTED_TOKEN_PROGRAM", "qOS Cloud settlement requires the pinned Token-2022 program");
  assertQos(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, "INVALID_TOKEN_DECIMALS", "Token decimals must fit in u8");
  const treasury = BigInt(treasuryAmount);
  const burn = BigInt(burnAmount);
  assertQos(treasury >= 0n && burn >= 0n && treasury + burn > 0n, "ZERO_AMOUNT", "Cloud settlement must transfer or burn at least one base unit");
  const accounts = [
    decodeBase58(payer, 32),
    decodeBase58(sourceTokenAccount, 32),
    decodeBase58(destinationTokenAccount, 32),
    decodeBase58(mint, 32),
    decodeBase58(tokenProgram, 32),
  ];
  assertQos(new Set(accounts.map((account) => account.toString("hex"))).size === accounts.length, "DUPLICATE_TRANSACTION_ACCOUNT", "Cloud settlement requires five distinct accounts");
  const instructions = [];
  if (treasury > 0n) {
    const transferData = Buffer.concat([Buffer.from([12]), u64le(treasury), Buffer.from([decimals])]);
    instructions.push(Buffer.concat([
      Buffer.from([4]),
      encodeShortVec(4),
      Buffer.from([1, 3, 2, 0]),
      encodeShortVec(transferData.length),
      transferData,
    ]));
  }
  if (burn > 0n) {
    const burnData = Buffer.concat([Buffer.from([15]), u64le(burn), Buffer.from([decimals])]);
    instructions.push(Buffer.concat([
      Buffer.from([4]),
      encodeShortVec(3),
      Buffer.from([1, 3, 0]),
      encodeShortVec(burnData.length),
      burnData,
    ]));
  }
  return Buffer.concat([
    // Mint is writable because BurnChecked reduces total supply. Only the
    // Token-2022 program is an unsigned read-only account.
    Buffer.from([1, 0, 1]),
    encodeShortVec(accounts.length),
    ...accounts,
    decodeBase58(recentBlockhash, 32),
    encodeShortVec(instructions.length),
    ...instructions,
  ]);
}

function compileLegacyMessage({ payer, recentBlockhash, instructions }) {
  const metadata = new Map();
  const order = [];
  function include(pubkey, { signer = false, writable = false } = {}) {
    decodeBase58(pubkey, 32);
    const current = metadata.get(pubkey);
    if (current) {
      current.signer ||= signer;
      current.writable ||= writable;
      return;
    }
    metadata.set(pubkey, { pubkey, signer, writable });
    order.push(pubkey);
  }
  include(payer, { signer: true, writable: true });
  for (const instruction of instructions) {
    for (const key of instruction.keys) include(key.pubkey, { signer: key.signer === true, writable: key.writable === true });
    include(instruction.programId);
  }
  const entries = order.map((pubkey) => metadata.get(pubkey));
  const signedWritable = entries.filter((item) => item.signer && item.writable);
  const signedReadonly = entries.filter((item) => item.signer && !item.writable);
  const unsignedWritable = entries.filter((item) => !item.signer && item.writable);
  const unsignedReadonly = entries.filter((item) => !item.signer && !item.writable);
  const accounts = [...signedWritable, ...signedReadonly, ...unsignedWritable, ...unsignedReadonly];
  assertQos(signedWritable.length === 1 && signedWritable[0].pubkey === payer && signedReadonly.length === 0, "UNEXPECTED_SIGNERS", "Cloud withdrawal requires exactly one writable signer");
  const indexes = new Map(accounts.map((item, index) => [item.pubkey, index]));
  const encodedInstructions = instructions.map((instruction) => Buffer.concat([
    Buffer.from([indexes.get(instruction.programId)]),
    encodeShortVec(instruction.keys.length),
    Buffer.from(instruction.keys.map((key) => indexes.get(key.pubkey))),
    encodeShortVec(instruction.data.length),
    instruction.data,
  ]));
  return Buffer.concat([
    Buffer.from([1, 0, unsignedReadonly.length]),
    encodeShortVec(accounts.length),
    ...accounts.map((item) => decodeBase58(item.pubkey, 32)),
    decodeBase58(recentBlockhash, 32),
    encodeShortVec(encodedInstructions.length),
    ...encodedInstructions,
  ]);
}

function systemTransferInstruction(payer, destination, amount) {
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: payer, signer: true, writable: true },
      { pubkey: destination, writable: true },
    ],
    data: Buffer.concat([Buffer.from([2, 0, 0, 0]), u64le(amount)]),
  };
}

function createAssociatedInstruction(payer, tokenAccount, owner, mint, tokenProgram) {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, signer: true, writable: true },
      { pubkey: tokenAccount, writable: true },
      { pubkey: owner },
      { pubkey: mint },
      { pubkey: SYSTEM_PROGRAM_ID },
      { pubkey: tokenProgram },
    ],
    data: Buffer.from([1]),
  };
}

function transferCheckedInstruction(payer, source, destination, mint, tokenProgram, amount, decimals) {
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: source, writable: true },
      { pubkey: mint },
      { pubkey: destination, writable: true },
      { pubkey: payer, signer: true },
    ],
    data: Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([decimals])]),
  };
}

export function buildCloudWithdrawalMessage(intent) {
  const gross = BigInt(intent.grossAmount);
  const destinationAmount = BigInt(intent.destinationAmount);
  const feeAmount = BigInt(intent.feeAmount);
  assertQos(gross > 0n && destinationAmount + feeAmount === gross, "CLOUD_WITHDRAWAL_SPLIT_INVALID", "Withdrawal split is invalid");
  const instructions = [];
  if (intent.assetKind === "sol") {
    instructions.push(systemTransferInstruction(intent.payer, intent.destination, destinationAmount));
    if (feeAmount > 0n) instructions.push(systemTransferInstruction(intent.payer, intent.treasury, feeAmount));
  } else {
    assertQos(intent.tokenProgram === TOKEN_PROGRAM_ID || intent.tokenProgram === TOKEN_2022_PROGRAM_ID, "UNSUPPORTED_TOKEN_PROGRAM", "Cloud withdrawal supports only Token and Token-2022 assets");
    assertQos(Number.isInteger(intent.decimals) && intent.decimals >= 0 && intent.decimals <= 255, "INVALID_TOKEN_DECIMALS", "Withdrawal decimals must fit in u8");
    if (intent.createDestinationTokenAccount) {
      instructions.push(createAssociatedInstruction(intent.payer, intent.destinationTokenAccount, intent.destination, intent.mint, intent.tokenProgram));
    }
    if (intent.createTreasuryTokenAccount) {
      instructions.push(createAssociatedInstruction(intent.payer, intent.treasuryTokenAccount, intent.treasury, intent.mint, intent.tokenProgram));
    }
    instructions.push(transferCheckedInstruction(intent.payer, intent.sourceTokenAccount, intent.destinationTokenAccount, intent.mint, intent.tokenProgram, destinationAmount, intent.decimals));
    if (feeAmount > 0n) {
      instructions.push(transferCheckedInstruction(intent.payer, intent.sourceTokenAccount, intent.treasuryTokenAccount, intent.mint, intent.tokenProgram, feeAmount, intent.decimals));
    }
  }
  return compileLegacyMessage({ payer: intent.payer, recentBlockhash: intent.recentBlockhash, instructions });
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

function parseCompiledLegacyMessage(message) {
  const reader = new Reader(message);
  const header = [reader.byte(), reader.byte(), reader.byte()];
  assertQos(header[0] === 1 && header[1] === 0, "UNEXPECTED_MESSAGE_HEADER", "Cloud withdrawal requires one writable signer");
  const accountCount = reader.shortVec();
  assertQos(accountCount >= 3 && accountCount <= 12, "UNEXPECTED_ACCOUNTS", "Cloud withdrawal account count is outside its template");
  const accounts = Array.from({ length: accountCount }, () => encodeBase58(reader.bytes(32)));
  assertQos(new Set(accounts).size === accounts.length, "DUPLICATE_TRANSACTION_ACCOUNT", "Cloud withdrawal message contains duplicate account entries");
  const recentBlockhash = encodeBase58(reader.bytes(32));
  const instructionCount = reader.shortVec();
  assertQos(instructionCount >= 1 && instructionCount <= 4, "UNEXPECTED_INSTRUCTIONS", "Cloud withdrawal instruction count is outside its template");
  const instructions = [];
  for (let index = 0; index < instructionCount; index += 1) {
    const programIndex = reader.byte();
    assertQos(programIndex < accounts.length, "WRONG_PROGRAM", "Cloud withdrawal program index is invalid");
    const accountIndexCount = reader.shortVec();
    const accountIndexes = [...reader.bytes(accountIndexCount)];
    assertQos(accountIndexes.every((value) => value < accounts.length), "WRONG_ACCOUNTS", "Cloud withdrawal account index is invalid");
    const dataLength = reader.shortVec();
    instructions.push({
      programId: accounts[programIndex],
      accounts: accountIndexes.map((value) => accounts[value]),
      data: Buffer.from(reader.bytes(dataLength)),
    });
  }
  assertQos(reader.offset === reader.buffer.length, "TRAILING_TRANSACTION_DATA", "Cloud withdrawal contains trailing bytes");
  return { header, accounts, payer: accounts[0], recentBlockhash, instructions };
}

export function parseCloudWithdrawalMessage(message) {
  const parsed = parseCompiledLegacyMessage(message);
  const transferInstructions = parsed.instructions.filter((item) => item.programId !== ASSOCIATED_TOKEN_PROGRAM_ID);
  const createInstructions = parsed.instructions.filter((item) => item.programId === ASSOCIATED_TOKEN_PROGRAM_ID);
  if (transferInstructions.every((item) => item.programId === SYSTEM_PROGRAM_ID)) {
    assertQos(createInstructions.length === 0 && transferInstructions.length <= 2, "WRONG_INSTRUCTION", "Native withdrawal permits only one or two System Program transfers");
    const transfers = transferInstructions.map((item) => {
      assertQos(item.accounts.length === 2 && item.accounts[0] === parsed.payer, "WRONG_ACCOUNTS", "Native withdrawal transfer accounts changed");
      assertQos(item.data.length === 12 && item.data.readUInt32LE(0) === 2, "WRONG_INSTRUCTION", "Native withdrawal permits only SystemProgram.transfer");
      return { destination: item.accounts[1], amount: item.data.readBigUInt64LE(4) };
    });
    return { ...parsed, assetKind: "sol", transfers };
  }
  assertQos(transferInstructions.length >= 1 && transferInstructions.length <= 2, "WRONG_INSTRUCTION", "Token withdrawal permits one or two TransferChecked instructions");
  const tokenProgram = transferInstructions[0].programId;
  assertQos(tokenProgram === TOKEN_PROGRAM_ID || tokenProgram === TOKEN_2022_PROGRAM_ID, "WRONG_PROGRAM", "Token withdrawal program is not supported");
  for (const instruction of createInstructions) {
    assertQos(instruction.data.length === 1 && instruction.data[0] === 1, "WRONG_INSTRUCTION", "Token withdrawal permits only CreateIdempotent associated-account instructions");
    assertQos(instruction.accounts.length === 6 && instruction.accounts[0] === parsed.payer
      && instruction.accounts[4] === SYSTEM_PROGRAM_ID && instruction.accounts[5] === tokenProgram,
    "WRONG_ACCOUNTS", "Associated token account creation template changed");
  }
  const transfers = transferInstructions.map((item) => {
    assertQos(item.programId === tokenProgram && item.accounts.length === 4 && item.accounts[3] === parsed.payer, "WRONG_ACCOUNTS", "Token withdrawal TransferChecked accounts changed");
    assertQos(item.data.length === 10 && item.data[0] === 12, "WRONG_INSTRUCTION", "Token withdrawal permits only TransferChecked");
    return {
      sourceTokenAccount: item.accounts[0],
      mint: item.accounts[1],
      destinationTokenAccount: item.accounts[2],
      amount: item.data.readBigUInt64LE(1),
      decimals: item.data[9],
    };
  });
  assertQos(transfers.every((item) => item.sourceTokenAccount === transfers[0].sourceTokenAccount
    && item.mint === transfers[0].mint && item.decimals === transfers[0].decimals),
  "WRONG_ACCOUNTS", "Token withdrawal transfers disagree on source, mint, or decimals");
  return { ...parsed, assetKind: "token", tokenProgram, createInstructions, transfers };
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

export function parseCloudSettlementMessage(message) {
  const reader = new Reader(message);
  const header = [reader.byte(), reader.byte(), reader.byte()];
  assertQos(header[0] === 1 && header[1] === 0 && header[2] === 1, "UNEXPECTED_MESSAGE_HEADER", "Cloud settlement header does not match the pinned template");
  const accountCount = reader.shortVec();
  assertQos(accountCount === 5, "UNEXPECTED_ACCOUNTS", "Cloud settlement requires exactly five accounts");
  const accounts = Array.from({ length: accountCount }, () => encodeBase58(reader.bytes(32)));
  assertQos(new Set(accounts).size === accounts.length, "DUPLICATE_TRANSACTION_ACCOUNT", "Cloud settlement contains duplicate accounts");
  const recentBlockhash = encodeBase58(reader.bytes(32));
  const instructionCount = reader.shortVec();
  assertQos(instructionCount === 1 || instructionCount === 2, "UNEXPECTED_INSTRUCTIONS", "Cloud settlement requires one or two pinned instructions");
  let treasuryAmount = 0n;
  let burnAmount = 0n;
  let decimals;
  for (let index = 0; index < instructionCount; index += 1) {
    const programIndex = reader.byte();
    const accountIndexCount = reader.shortVec();
    const indexes = [...reader.bytes(accountIndexCount)];
    const dataLength = reader.shortVec();
    const data = reader.bytes(dataLength);
    assertQos(programIndex === 4 && accounts[programIndex] === TOKEN_2022_PROGRAM_ID, "WRONG_PROGRAM", "Cloud settlement may invoke only the pinned Token-2022 program");
    assertQos(data.length === 10, "WRONG_INSTRUCTION", "Cloud settlement instruction data is not canonical");
    const amount = data.readBigUInt64LE(1);
    assertQos(amount > 0n, "ZERO_AMOUNT", "Cloud settlement instructions must use positive amounts");
    if (data[0] === 12) {
      assertQos(treasuryAmount === 0n && index === 0 && accountIndexCount === 4 && indexes[0] === 1 && indexes[1] === 3 && indexes[2] === 2 && indexes[3] === 0, "WRONG_INSTRUCTION", "Cloud settlement TransferChecked accounts or ordering changed");
      treasuryAmount = amount;
    } else if (data[0] === 15) {
      assertQos(burnAmount === 0n && accountIndexCount === 3 && indexes[0] === 1 && indexes[1] === 3 && indexes[2] === 0, "WRONG_INSTRUCTION", "Cloud settlement BurnChecked accounts changed");
      burnAmount = amount;
    } else {
      assertQos(false, "WRONG_INSTRUCTION", "Cloud settlement permits only TransferChecked and BurnChecked");
    }
    assertQos(decimals === undefined || decimals === data[9], "INVALID_TOKEN_DECIMALS", "Cloud settlement instructions disagree on token decimals");
    decimals = data[9];
  }
  assertQos(reader.offset === reader.buffer.length, "TRAILING_TRANSACTION_DATA", "Cloud settlement contains trailing bytes");
  return {
    payer: accounts[0],
    sourceTokenAccount: accounts[1],
    destinationTokenAccount: accounts[2],
    mint: accounts[3],
    tokenProgram: accounts[4],
    recentBlockhash,
    treasuryAmount,
    burnAmount,
    decimals,
  };
}
