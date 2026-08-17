import { createHash } from "node:crypto";
import { decodeBase58, encodeBase58 } from "./base58.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import { assertQos } from "./errors.js";

const ED25519_P = (1n << 255n) - 19n;
const ED25519_D = mod(-121665n * invert(121666n));
const ED25519_SQRT_M1 = modPow(2n, (ED25519_P - 1n) / 4n);
const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "ascii");
const SUPPORTED_TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
const IMMUTABLE_OWNER_EXTENSION = 7;

function mod(value) {
  const reduced = value % ED25519_P;
  return reduced >= 0n ? reduced : reduced + ED25519_P;
}

function modPow(base, exponent) {
  let result = 1n;
  let value = mod(base);
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = mod(result * value);
    value = mod(value * value);
    power >>= 1n;
  }
  return result;
}

function invert(value) {
  return modPow(value, ED25519_P - 2n);
}

function littleEndianInteger(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
}

export function isEd25519Point(bytes) {
  const encoded = Buffer.from(bytes);
  assertQos(encoded.length === 32, "INVALID_PUBLIC_KEY", "Ed25519 point encoding must contain 32 bytes");
  const sign = encoded[31] >> 7;
  encoded[31] &= 0x7f;
  const y = littleEndianInteger(encoded);
  if (y >= ED25519_P) return false;
  const ySquared = mod(y * y);
  const xSquared = mod((ySquared - 1n) * invert(ED25519_D * ySquared + 1n));
  let x = modPow(xSquared, (ED25519_P + 3n) / 8n);
  if (mod(x * x - xSquared) !== 0n) x = mod(x * ED25519_SQRT_M1);
  if (mod(x * x - xSquared) !== 0n) return false;
  return !(x === 0n && sign === 1);
}

export function findProgramAddress(seeds, programId) {
  assertQos(Array.isArray(seeds) && seeds.length <= 16, "INVALID_PDA_SEEDS", "A PDA supports at most 16 seeds");
  const seedBytes = seeds.map((seed) => {
    const value = Buffer.from(seed);
    assertQos(value.length <= 32, "INVALID_PDA_SEED", "A PDA seed cannot exceed 32 bytes");
    return value;
  });
  const program = decodeBase58(programId, 32);
  for (let bump = 255; bump >= 0; bump -= 1) {
    const address = createHash("sha256")
      .update(Buffer.concat([...seedBytes, Buffer.from([bump]), program, PDA_MARKER]))
      .digest();
    if (!isEd25519Point(address)) return { address: encodeBase58(address), bump };
  }
  assertQos(false, "PDA_DERIVATION_FAILED", "Unable to derive an off-curve program address");
}

export function associatedTokenAddress({ owner, mint, tokenProgram }) {
  assertQos(SUPPORTED_TOKEN_PROGRAMS.has(tokenProgram), "UNSUPPORTED_TOKEN_PROGRAM", "Token account derivation requires the pinned Token or Token-2022 program");
  return findProgramAddress([
    decodeBase58(owner, 32),
    decodeBase58(tokenProgram, 32),
    decodeBase58(mint, 32),
  ], ASSOCIATED_TOKEN_PROGRAM_ID).address;
}

function rpcAccountBytes(value, expectedProgram, field) {
  assertQos(value && typeof value === "object", "TOKEN_ACCOUNT_NOT_FOUND", `${field} does not exist on the pinned cluster`);
  assertQos(value.owner === expectedProgram, "WRONG_TOKEN_PROGRAM", `${field} is not owned by the pinned token program`);
  assertQos(Array.isArray(value.data) && value.data.length === 2 && value.data[1] === "base64", "INVALID_TOKEN_ACCOUNT", `${field} RPC data is not canonical base64`);
  const bytes = Buffer.from(value.data[0], "base64");
  assertQos(bytes.toString("base64") === value.data[0], "INVALID_TOKEN_ACCOUNT", `${field} RPC data is not canonical base64`);
  return bytes;
}

function assertNoneOption(bytes, offset, valueLength, code, message) {
  assertQos(bytes.readUInt32LE(offset) === 0, code, message);
  assertQos(bytes.subarray(offset + 4, offset + 4 + valueLength).every((byte) => byte === 0), code, message);
}

export function token2022ExtensionTypes(bytes, baseLength, accountType) {
  if (bytes.length === baseLength) return [];
  assertQos(bytes.length >= 166 && bytes[165] === accountType, "INVALID_TOKEN_EXTENSION_LAYOUT", "Token-2022 extension account type is invalid");
  for (let index = baseLength; index < 165; index += 1) {
    assertQos(bytes[index] === 0, "INVALID_TOKEN_EXTENSION_LAYOUT", "Token-2022 padding is not zeroed");
  }
  const types = [];
  let offset = 166;
  while (offset < bytes.length) {
    assertQos(offset + 4 <= bytes.length, "INVALID_TOKEN_EXTENSION_LAYOUT", "Token-2022 extension header is truncated");
    const type = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (type === 0 && length === 0) {
      assertQos(bytes.subarray(offset).every((byte) => byte === 0), "INVALID_TOKEN_EXTENSION_LAYOUT", "Token-2022 extension padding is not zeroed");
      break;
    }
    assertQos(offset + length <= bytes.length, "INVALID_TOKEN_EXTENSION_LAYOUT", "Token-2022 extension value is truncated");
    assertQos(!types.includes(type), "DUPLICATE_TOKEN_EXTENSION", "Token-2022 account contains a duplicate extension");
    types.push(type);
    offset += length;
  }
  return types;
}

export function parseMintAccount(value, { tokenProgram, decimals, allowedMintExtensions }) {
  const bytes = rpcAccountBytes(value, tokenProgram, "mint");
  assertQos(bytes.length >= 82, "INVALID_MINT_ACCOUNT", "Mint account is shorter than the SPL mint layout");
  assertQos(bytes[45] === 1, "UNINITIALIZED_MINT", "Mint account is not initialized");
  assertQos(bytes[44] === decimals, "MINT_DECIMALS_MISMATCH", "Mint decimals do not match the signed policy");
  assertNoneOption(bytes, 0, 32, "MINT_AUTHORITY_PRESENT", "Pinned mint must have no mint authority");
  assertNoneOption(bytes, 46, 32, "FREEZE_AUTHORITY_PRESENT", "Pinned mint must have no freeze authority");
  const extensions = tokenProgram === TOKEN_2022_PROGRAM_ID ? token2022ExtensionTypes(bytes, 82, 1) : [];
  assertQos(tokenProgram === TOKEN_2022_PROGRAM_ID || bytes.length === 82, "INVALID_MINT_ACCOUNT", "Classic SPL mint has an unexpected account size");
  assertQos(extensions.length === allowedMintExtensions.length && extensions.every((type, index) => type === allowedMintExtensions[index]), "MINT_EXTENSIONS_MISMATCH", "Mint extensions changed from the signed policy");
  return { supply: bytes.readBigUInt64LE(36), decimals: bytes[44], extensions };
}

export function parseTokenAccount(value, { tokenProgram, mint, owner, field }) {
  const bytes = rpcAccountBytes(value, tokenProgram, field);
  assertQos(bytes.length >= 165, "INVALID_TOKEN_ACCOUNT", `${field} is shorter than the SPL token-account layout`);
  assertQos(encodeBase58(bytes.subarray(0, 32)) === mint, "TOKEN_ACCOUNT_MINT_MISMATCH", `${field} is for a different mint`);
  assertQos(encodeBase58(bytes.subarray(32, 64)) === owner, "TOKEN_ACCOUNT_OWNER_MISMATCH", `${field} has an unexpected authority`);
  assertQos(bytes[108] === 1, "TOKEN_ACCOUNT_NOT_TRANSFERABLE", `${field} is uninitialized or frozen`);
  assertNoneOption(bytes, 72, 32, "TOKEN_ACCOUNT_DELEGATE_PRESENT", `${field} must not have a transfer delegate`);
  assertNoneOption(bytes, 109, 8, "TOKEN_ACCOUNT_NATIVE_STATE", `${field} must not be a wrapped-native account`);
  assertQos(bytes.readBigUInt64LE(121) === 0n, "TOKEN_ACCOUNT_DELEGATED_BALANCE", `${field} must not retain a delegated balance`);
  assertNoneOption(bytes, 129, 32, "TOKEN_ACCOUNT_CLOSE_AUTHORITY", `${field} must not have a close authority`);
  let extensions = [];
  if (tokenProgram === TOKEN_PROGRAM_ID) {
    assertQos(bytes.length === 165, "INVALID_TOKEN_ACCOUNT", `${field} has an unexpected classic SPL account size`);
  } else {
    extensions = token2022ExtensionTypes(bytes, 165, 2);
    assertQos(
      extensions.length === 1 && extensions[0] === IMMUTABLE_OWNER_EXTENSION,
      "TOKEN_ACCOUNT_EXTENSIONS_MISMATCH",
      `${field} must contain exactly the Token-2022 immutable-owner extension`,
    );
  }
  return { amount: bytes.readBigUInt64LE(64), extensions };
}

export async function verifyTokenTransferAccounts({ rpc, tokenPolicy, sourceOwner, destinationOwner, sourceTokenAccount, destinationTokenAccount, amount }) {
  const [mintInfo, sourceInfo, destinationInfo] = await Promise.all([
    rpc.getAccountInfo(tokenPolicy.mint),
    rpc.getAccountInfo(sourceTokenAccount),
    rpc.getAccountInfo(destinationTokenAccount),
  ]);
  assertQos(
    sourceInfo !== null && sourceInfo !== undefined,
    "TOKEN_ACCOUNT_NOT_FOUND",
    `Source Token-2022 account ${sourceTokenAccount} does not exist on the pinned cluster; run qos wallet status for funding instructions`,
  );
  assertQos(
    destinationInfo !== null && destinationInfo !== undefined,
    "TOKEN_ACCOUNT_NOT_FOUND",
    `Destination Token-2022 account ${destinationTokenAccount} does not exist on the pinned cluster; run qos wallet status for funding instructions`,
  );
  const mint = parseMintAccount(mintInfo, tokenPolicy);
  const source = parseTokenAccount(sourceInfo, {
    tokenProgram: tokenPolicy.tokenProgram,
    mint: tokenPolicy.mint,
    owner: sourceOwner,
    field: "sourceTokenAccount",
  });
  const destination = parseTokenAccount(destinationInfo, {
    tokenProgram: tokenPolicy.tokenProgram,
    mint: tokenPolicy.mint,
    owner: destinationOwner,
    field: "destinationTokenAccount",
  });
  assertQos(source.amount >= BigInt(amount), "INSUFFICIENT_TOKEN_BALANCE", "Source token account balance is below the requested amount");
  return { mint, source, destination };
}
