import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decodeBase58, encodeBase58 } from "./base58.js";
import { hasExactKeys } from "./canonical.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from "./constants.js";
import { assertQos, QosError } from "./errors.js";
import { loadPolicy, parseUnsigned, validateDexTradingPolicy, validatePolicy } from "./policy.js";
import { readPrivateJson, writePrivateJsonAtomic } from "./private-json.js";
import { assertPrivateDirectory, readSecureFile } from "./secure-file.js";
import { associatedTokenAddress, parseGenericMintAccount } from "./token.js";
import { encodeShortVec } from "./transaction.js";
import { intentCommitment, policyCommitment } from "./zk.js";

export const JUPITER_SWAP_ENDPOINT = "https://api.jup.ag/swap/v2";
export const RAYDIUM_SWAP_ENDPOINT = "https://transaction-v1.raydium.io";
const PROVIDER_V1_KEYS = ["version", "provider", "endpoint"];
const PROVIDER_V2_KEYS = ["version", "provider", "endpoint", "venues", "raydiumEndpoint"];
const STATE_KEYS = ["version", "day", "tradeCount", "lastExecutedAt", "inputTotals"];
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TRANSACTION_BYTES = 1_232;

export function dexPaths(home) {
  const resolvedHome = resolve(home);
  return {
    home: resolvedHome,
    dex: join(resolvedHome, "dex"),
    provider: join(resolvedHome, "dex", "provider.json"),
    apiKey: join(resolvedHome, "dex", "jupiter-api-key"),
    runtimeState: join(resolvedHome, "runtime-state"),
    tradingState: join(resolvedHome, "runtime-state", "dex-trading.json"),
  };
}

function emptyTradingState() {
  return { version: 1, day: null, tradeCount: 0, lastExecutedAt: null, inputTotals: {} };
}

function validateTradingState(value) {
  assertQos(value && typeof value === "object" && !Array.isArray(value) && hasExactKeys(value, STATE_KEYS), "INVALID_DEX_STATE", "DEX state has missing or unknown fields");
  assertQos(value.version === 1, "INVALID_DEX_STATE", "DEX state version is unsupported");
  assertQos(value.day === null || /^\d{4}-\d{2}-\d{2}$/.test(value.day), "INVALID_DEX_STATE", "DEX state day is invalid");
  assertQos(Number.isInteger(value.tradeCount) && value.tradeCount >= 0 && value.tradeCount <= 1_000_000, "INVALID_DEX_STATE", "DEX trade count is invalid");
  assertQos(value.lastExecutedAt === null || (typeof value.lastExecutedAt === "string" && Number.isFinite(Date.parse(value.lastExecutedAt))), "INVALID_DEX_STATE", "DEX last execution time is invalid");
  assertQos(value.inputTotals && typeof value.inputTotals === "object" && !Array.isArray(value.inputTotals), "INVALID_DEX_STATE", "DEX input totals are invalid");
  for (const [pair, amount] of Object.entries(value.inputTotals)) {
    assertQos(pair.length >= 65 && pair.length <= 96 && pair.includes(">"), "INVALID_DEX_STATE", "DEX state contains an invalid pair identifier");
    parseUnsigned(amount, 64, "dex state input total");
  }
  return value;
}

function visibleApiKey(bytes) {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  const value = Buffer.from(bytes.subarray(0, end));
  assertQos(value.length >= 8 && value.length <= 2_048 && value.every((byte) => byte >= 0x21 && byte <= 0x7e), "DEX_CREDENTIAL_INVALID", "Jupiter API key must contain 8 to 2048 visible ASCII characters");
  return value;
}

function writeSecretAtomic(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function configureDexTrading(home, {
  apiKeyFile,
  venues = ["jupiter", "raydium"],
  allowedPairs = undefined,
  maxInputAmount = undefined,
  dailyInputLimit = undefined,
  receiver = null,
  maxSlippageBps = 100,
  maxRouteFeeBps = 100,
  maxFeeLamports = "5000000",
  minIntervalSeconds = 60,
  maxSwapsPerDay = 100,
} = {}) {
  const paths = dexPaths(home);
  assertPrivateDirectory(paths.home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS profile home" });
  assertQos(typeof apiKeyFile === "string" && apiKeyFile.length > 0, "DEX_CREDENTIAL_REQUIRED", "Jupiter trading requires an owner-only API key file");
  assertQos(Array.isArray(venues) && venues.length >= 1 && venues.length <= 2 && venues.every((venue) => venue === "jupiter" || venue === "raydium") && new Set(venues).size === venues.length, "INVALID_DEX_VENUES", "DEX venues must select Jupiter, Raydium, or both reviewed adapters");
  const policy = loadPolicy(join(paths.home, "policy.json"));
  assertQos(policy.cluster === "mainnet-beta", "DEX_CLUSTER_UNSUPPORTED", "Live DEX trading is supported only on Solana mainnet-beta");
  const riskLimits = allowedPairs === undefined
    ? { tokenScope: "any-solana-token", maxInputAmount, dailyInputLimit }
    : { allowedPairs };
  const dexTrading = validateDexTradingPolicy({
    provider: "jupiter",
    endpoint: JUPITER_SWAP_ENDPOINT,
    receiver,
    ...riskLimits,
    maxSlippageBps,
    maxRouteFeeBps,
    maxFeeLamports,
    minIntervalSeconds,
    maxSwapsPerDay,
  });
  const source = readSecureFile(apiKeyFile, { privateFile: true, minBytes: 8, maxBytes: 2_050, errorCode: "INSECURE_DEX_CREDENTIAL", label: "Jupiter API key file" });
  let credential;
  try {
    credential = visibleApiKey(source);
    if (!existsSync(paths.dex)) mkdirSync(paths.dex, { mode: 0o700 });
    chmodSync(paths.dex, 0o700);
    if (!existsSync(paths.runtimeState)) mkdirSync(paths.runtimeState, { mode: 0o700 });
    chmodSync(paths.runtimeState, 0o700);
    const storedCredential = Buffer.alloc(credential.length + 1);
    try {
      credential.copy(storedCredential);
      storedCredential[storedCredential.length - 1] = 0x0a;
      writeSecretAtomic(paths.apiKey, storedCredential);
    } finally {
      storedCredential.fill(0);
    }
    writePrivateJsonAtomic(paths.provider, {
      version: 2,
      provider: "reviewed-multivenue",
      endpoint: JUPITER_SWAP_ENDPOINT,
      venues,
      raydiumEndpoint: RAYDIUM_SWAP_ENDPOINT,
    }, { errorCode: "DEX_CONFIG_WRITE_FAILED", label: "DEX provider configuration" });
    if (!existsSync(paths.tradingState)) writePrivateJsonAtomic(paths.tradingState, emptyTradingState(), { errorCode: "DEX_STATE_WRITE_FAILED", label: "DEX trading state" });
    const nextPolicy = validatePolicy({ ...policy, version: 3, dexTrading });
    writePrivateJsonAtomic(join(paths.home, "policy.json"), nextPolicy, { errorCode: "POLICY_WRITE_FAILED", label: "Policy file" });
  } finally {
    source.fill(0);
    credential?.fill(0);
  }
  return publicDexTrading(paths.home);
}

export function publicDexTrading(home) {
  const paths = dexPaths(home);
  const policy = loadPolicy(join(paths.home, "policy.json"));
  if (policy.dexTrading === null) return null;
  const provider = readPrivateJson(paths.provider, { errorCode: "INVALID_DEX_CONFIG", label: "DEX provider configuration" });
  if (hasExactKeys(provider, PROVIDER_V1_KEYS)) {
    assertQos(provider.version === 1 && provider.provider === "jupiter" && provider.endpoint === JUPITER_SWAP_ENDPOINT, "INVALID_DEX_CONFIG", "DEX provider configuration is invalid");
    provider.venues = ["jupiter"];
    provider.raydiumEndpoint = RAYDIUM_SWAP_ENDPOINT;
  } else {
    assertQos(hasExactKeys(provider, PROVIDER_V2_KEYS) && provider.version === 2 && provider.provider === "reviewed-multivenue" && provider.endpoint === JUPITER_SWAP_ENDPOINT && provider.raydiumEndpoint === RAYDIUM_SWAP_ENDPOINT, "INVALID_DEX_CONFIG", "DEX provider configuration is invalid");
    assertQos(Array.isArray(provider.venues) && provider.venues.length >= 1 && provider.venues.length <= 2 && provider.venues.every((venue) => venue === "jupiter" || venue === "raydium") && new Set(provider.venues).size === provider.venues.length, "INVALID_DEX_CONFIG", "DEX venue configuration is invalid");
  }
  readSecureFile(paths.apiKey, { privateFile: true, minBytes: 8, maxBytes: 2_050, errorCode: "INSECURE_DEX_CREDENTIAL", label: "Jupiter API key file" }).fill(0);
  return { ...policy.dexTrading, provider: provider.provider, venues: [...provider.venues], raydiumEndpoint: provider.raydiumEndpoint, credentialConfigured: true };
}

function pairFor(policy, action) {
  assertQos(policy.dexTrading !== null, "DEX_TRADING_DISABLED", "This qOS profile does not enable DEX trading");
  if (policy.dexTrading.tokenScope === "any-solana-token") {
    return Object.freeze({
      inputMint: action.inputMint,
      outputMint: action.outputMint,
      maxInputAmount: policy.dexTrading.maxInputAmount,
      dailyInputLimit: policy.dexTrading.dailyInputLimit,
    });
  }
  const pair = policy.dexTrading.allowedPairs.find((item) => item.inputMint === action.inputMint && item.outputMint === action.outputMint);
  assertQos(pair !== undefined, "DEX_PAIR_NOT_ALLOWED", "Requested DEX mint pair is not allowlisted");
  return pair;
}

export function validateDexAction(policy, action) {
  const legacy = action && typeof action === "object" && !Array.isArray(action) && hasExactKeys(action, ["version", "action", "inputMint", "outputMint", "amount", "strategyId"]);
  const multivenue = action && typeof action === "object" && !Array.isArray(action) && hasExactKeys(action, ["version", "action", "venue", "inputMint", "outputMint", "amount", "strategyId"]);
  assertQos(legacy || multivenue, "INVALID_DEX_ACTION", "DEX action has missing or unknown fields");
  assertQos((legacy && action.version === 2 || multivenue && action.version === 3) && action.action === "swap", "INVALID_DEX_ACTION", "DEX action version or name is unsupported");
  const venue = legacy ? "jupiter" : action.venue;
  assertQos(venue === "jupiter" || venue === "raydium", "DEX_VENUE_NOT_ALLOWED", "DEX venue must be Jupiter or Raydium");
  decodeBase58(action.inputMint, 32);
  decodeBase58(action.outputMint, 32);
  assertQos(action.inputMint !== action.outputMint, "DEX_IDENTICAL_MINTS", "DEX input and output mints must differ");
  assertQos(Number.isInteger(action.strategyId) && policy.allowedStrategyIds.includes(action.strategyId), "STRATEGY_NOT_ALLOWED", "DEX strategy is not allowlisted");
  const pair = pairFor(policy, action);
  const amount = parseUnsigned(action.amount, 64, "DEX input amount");
  assertQos(amount > 0n && amount <= BigInt(pair.maxInputAmount), "DEX_INPUT_LIMIT_EXCEEDED", "DEX input amount exceeds the pair policy");
  return Object.freeze({ action: Object.freeze({ ...action, venue }), pair, amount, venue });
}

async function validateSolanaTokenMints(rpc, action) {
  assertQos(rpc && typeof rpc.getAccountInfo === "function", "DEX_RPC_UNAVAILABLE", "DEX trading requires Solana RPC account validation");
  const [input, output] = await Promise.all([
    rpc.getAccountInfo(action.inputMint),
    rpc.getAccountInfo(action.outputMint),
  ]);
  const validated = {};
  for (const [label, address, value] of [
    ["input", action.inputMint, input],
    ["output", action.outputMint, output],
  ]) {
    assertQos(value && typeof value === "object", "DEX_MINT_NOT_FOUND", `DEX ${label} mint does not exist on the policy-pinned Solana cluster`, { mint: address });
    assertQos(value.owner === TOKEN_PROGRAM_ID || value.owner === TOKEN_2022_PROGRAM_ID, "DEX_MINT_NOT_TOKEN", `DEX ${label} mint is not owned by a supported Solana token program`, { mint: address, owner: value.owner ?? null });
    validated[label] = { ...parseGenericMintAccount(value, value.owner), tokenProgram: value.owner };
  }
  return validated;
}

async function readJsonResponse(response, operation) {
  assertQos(response && typeof response.arrayBuffer === "function" && Number.isInteger(response.status), "DEX_PROVIDER_RESPONSE_INVALID", `Jupiter ${operation} response is invalid`);
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    assertQos(/^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= MAX_RESPONSE_BYTES, "DEX_PROVIDER_RESPONSE_TOO_LARGE", `Jupiter ${operation} response is too large`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    assertQos(bytes.length <= MAX_RESPONSE_BYTES, "DEX_PROVIDER_RESPONSE_TOO_LARGE", `Jupiter ${operation} response is too large`);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new QosError("DEX_PROVIDER_RESPONSE_INVALID", `Jupiter ${operation} returned invalid JSON`); }
    assertQos(response.ok === true, "DEX_PROVIDER_REJECTED", `Jupiter ${operation} rejected the request`, { statusCode: response.status, providerCode: value?.code ?? value?.errorCode ?? null });
    return value;
  } finally {
    bytes.fill(0);
  }
}

function safeNumber(value, field) {
  assertQos(Number.isSafeInteger(value) && value >= 0, "DEX_ORDER_INVALID", `Jupiter order ${field} is invalid`);
  return BigInt(value);
}

function currentState(paths, now) {
  const state = validateTradingState(readPrivateJson(paths.tradingState, { errorCode: "INVALID_DEX_STATE", label: "DEX trading state" }));
  const day = now.toISOString().slice(0, 10);
  return state.day === day ? state : { ...emptyTradingState(), day };
}

function enforceState(policy, pair, amount, routeFeeBps, state, now) {
  const pairId = `${pair.inputMint}>${pair.outputMint}`;
  const worstGross = (amount * BigInt(10_000 + routeFeeBps) + 9_999n) / 10_000n;
  const prior = BigInt(state.inputTotals[pairId] ?? "0");
  assertQos(worstGross <= BigInt(pair.maxInputAmount), "DEX_GROSS_INPUT_LIMIT_EXCEEDED", "DEX input plus the maximum quoted route fee exceeds the per-swap limit");
  assertQos(prior + worstGross <= BigInt(pair.dailyInputLimit), "DEX_DAILY_INPUT_LIMIT_EXCEEDED", "DEX daily input limit would be exceeded");
  assertQos(state.tradeCount < policy.maxSwapsPerDay, "DEX_DAILY_COUNT_EXCEEDED", "DEX daily swap count limit has been reached");
  if (state.lastExecutedAt !== null) {
    const earliest = Date.parse(state.lastExecutedAt) + policy.minIntervalSeconds * 1_000;
    assertQos(now.getTime() >= earliest, "DEX_COOLDOWN_ACTIVE", "DEX cooldown is still active", { retryAfterSeconds: Math.ceil((earliest - now.getTime()) / 1_000) });
  }
  return { pairId, worstGross };
}

function validateOrder(order, policy, action, pair, signer) {
  assertQos(order && typeof order === "object" && !Array.isArray(order), "DEX_ORDER_INVALID", "Jupiter order is invalid");
  assertQos(order.mode === "manual" && order.swapMode === "ExactIn", "DEX_ORDER_MODE_INVALID", "Jupiter order must be a manual ExactIn swap");
  assertQos(order.inputMint === action.inputMint && order.outputMint === action.outputMint && order.inAmount === action.amount, "DEX_ORDER_MISMATCH", "Jupiter order does not match the requested pair and amount");
  assertQos(order.taker === signer, "DEX_ORDER_TAKER_MISMATCH", "Jupiter order changed the firmware signer");
  if (Object.hasOwn(order, "receiver")) {
    assertQos(order.receiver === (policy.receiver ?? signer), "DEX_ORDER_RECEIVER_MISMATCH", "Jupiter order changed the policy-pinned output receiver");
  }
  assertQos(order.router !== "jupiterz" && ["metis", "dflow", "okx"].includes(order.router), "DEX_ROUTER_NOT_ALLOWED", "Jupiter order selected an unsupported router");
  assertQos(order.gasless === false && order.signatureFeePayer === signer, "DEX_GASLESS_FORBIDDEN", "qOS rejects sponsored or market-maker signing paths");
  for (const payer of [order.prioritizationFeePayer, order.rentFeePayer]) assertQos(payer === null || payer === signer, "DEX_FEE_PAYER_MISMATCH", "Jupiter order changed a fee payer");
  assertQos(Number.isInteger(order.slippageBps) && order.slippageBps >= 0 && order.slippageBps <= policy.maxSlippageBps, "DEX_SLIPPAGE_LIMIT_EXCEEDED", "Jupiter order exceeds the slippage policy");
  assertQos(Number.isInteger(order.feeBps) && order.feeBps >= 0 && order.feeBps <= policy.maxRouteFeeBps, "DEX_ROUTE_FEE_LIMIT_EXCEEDED", "Jupiter order exceeds the route fee policy");
  const outAmount = parseUnsigned(order.outAmount, 64, "Jupiter order output amount");
  const minimumOutput = parseUnsigned(order.otherAmountThreshold, 64, "Jupiter order minimum output");
  assertQos(outAmount > 0n && minimumOutput > 0n && minimumOutput <= outAmount, "DEX_ORDER_INVALID", "Jupiter order output protection is invalid");
  const networkFee = safeNumber(order.signatureFeeLamports, "signatureFeeLamports")
    + safeNumber(order.prioritizationFeeLamports, "prioritizationFeeLamports")
    + safeNumber(order.rentFeeLamports, "rentFeeLamports");
  assertQos(networkFee <= BigInt(policy.maxFeeLamports), "DEX_NETWORK_FEE_LIMIT_EXCEEDED", "Jupiter order exceeds the network and rent fee policy");
  assertQos(typeof order.requestId === "string" && /^[A-Za-z0-9._:-]{8,256}$/.test(order.requestId), "DEX_ORDER_INVALID", "Jupiter order request ID is invalid");
  assertQos(typeof order.lastValidBlockHeight === "string" && /^[1-9][0-9]*$/.test(order.lastValidBlockHeight), "DEX_ORDER_INVALID", "Jupiter order block height is invalid");
  assertQos(typeof order.transaction === "string" && order.transaction.length > 0, "DEX_ORDER_BUILD_FAILED", "Jupiter did not build a swap transaction", { providerCode: order.errorCode ?? null });
  return { pair, outAmount, minimumOutput, networkFee };
}

function readShortVec(bytes, cursor, field) {
  const start = cursor.offset;
  let value = 0;
  let multiplier = 1;
  for (let count = 0; count < 5; count += 1) {
    assertQos(cursor.offset < bytes.length, "DEX_TRANSACTION_INVALID", `Jupiter transaction ${field} is truncated`);
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * multiplier;
    assertQos(Number.isSafeInteger(value), "DEX_TRANSACTION_INVALID", `Jupiter transaction ${field} is too large`);
    if ((byte & 0x80) === 0) {
      const canonical = encodeShortVec(value);
      assertQos(canonical.length === cursor.offset - start && canonical.equals(bytes.subarray(start, cursor.offset)), "DEX_TRANSACTION_INVALID", `Jupiter transaction ${field} is non-canonical`);
      return value;
    }
    multiplier *= 128;
  }
  assertQos(false, "DEX_TRANSACTION_INVALID", `Jupiter transaction ${field} is too long`);
}

function take(bytes, cursor, length, field) {
  assertQos(Number.isSafeInteger(length) && length >= 0 && cursor.offset + length <= bytes.length, "DEX_TRANSACTION_INVALID", `Jupiter transaction ${field} is truncated`);
  const value = bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

function deserializeOrderTransaction(order, signer) {
  const raw = Buffer.from(order.transaction, "base64");
  try {
    assertQos(raw.length > 0 && raw.length <= MAX_TRANSACTION_BYTES && raw.toString("base64") === order.transaction, "DEX_TRANSACTION_INVALID", "Jupiter transaction encoding is invalid");
    const cursor = { offset: 0 };
    const signatureCount = readShortVec(raw, cursor, "signature count");
    assertQos(signatureCount === 1, "DEX_SIGNER_SET_INVALID", "Jupiter transaction must require only the qOS signer");
    const signatureOffset = cursor.offset;
    const priorSignature = take(raw, cursor, 64, "signature");
    assertQos(priorSignature.every((byte) => byte === 0), "DEX_TRANSACTION_PRESIGNED", "Jupiter transaction contains an unexpected signature");
    const messageOffset = cursor.offset;
    const version = take(raw, cursor, 1, "message version")[0];
    assertQos(version === 0x80, "DEX_TRANSACTION_VERSION_INVALID", "Jupiter transaction must use Solana message v0");
    const header = take(raw, cursor, 3, "message header");
    assertQos(header[0] === 1 && header[1] === 0, "DEX_SIGNER_SET_INVALID", "Jupiter transaction must require one writable qOS signer");
    const staticAccountCount = readShortVec(raw, cursor, "static account count");
    assertQos(staticAccountCount >= 1 && staticAccountCount <= 64, "DEX_TRANSACTION_COMPLEXITY", "Jupiter transaction static account count is invalid");
    const staticAccounts = take(raw, cursor, staticAccountCount * 32, "static accounts");
    assertQos(encodeBase58(staticAccounts.subarray(0, 32)) === signer, "DEX_SIGNER_SET_INVALID", "qOS signer must be the transaction fee payer");
    const recentBlockhash = encodeBase58(take(raw, cursor, 32, "recent blockhash"));
    const instructionCount = readShortVec(raw, cursor, "instruction count");
    assertQos(instructionCount >= 1 && instructionCount <= 64, "DEX_TRANSACTION_COMPLEXITY", "Jupiter transaction instruction count is invalid");
    for (let index = 0; index < instructionCount; index += 1) {
      take(raw, cursor, 1, "program index");
      const accountCount = readShortVec(raw, cursor, "instruction account count");
      assertQos(accountCount <= 128, "DEX_TRANSACTION_COMPLEXITY", "Jupiter instruction account count is too large");
      take(raw, cursor, accountCount, "instruction accounts");
      const dataLength = readShortVec(raw, cursor, "instruction data length");
      take(raw, cursor, dataLength, "instruction data");
    }
    const lookupCount = readShortVec(raw, cursor, "address lookup count");
    assertQos(lookupCount <= 8, "DEX_TRANSACTION_COMPLEXITY", "Jupiter transaction address lookup count is too large");
    for (let index = 0; index < lookupCount; index += 1) {
      take(raw, cursor, 32, "address lookup table key");
      const writableCount = readShortVec(raw, cursor, "writable lookup count");
      take(raw, cursor, writableCount, "writable lookup indexes");
      const readonlyCount = readShortVec(raw, cursor, "readonly lookup count");
      take(raw, cursor, readonlyCount, "readonly lookup indexes");
    }
    assertQos(cursor.offset === raw.length, "DEX_TRANSACTION_INVALID", "Jupiter transaction contains trailing bytes");
    const preserved = Buffer.from(raw);
    return {
      raw: preserved,
      message: preserved.subarray(messageOffset),
      recentBlockhash,
      sign(signature) {
        assertQos(Buffer.isBuffer(signature) && signature.length === 64, "INVALID_SIGNATURE", "DEX signer returned an invalid Ed25519 signature");
        const signed = Buffer.from(preserved);
        signature.copy(signed, signatureOffset);
        return signed;
      },
    };
  } finally {
    raw.fill(0);
  }
}

const RAYDIUM_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",
]);

async function readRaydiumJson(response, operation) {
  assertQos(response && typeof response.arrayBuffer === "function" && Number.isInteger(response.status), "DEX_PROVIDER_RESPONSE_INVALID", `Raydium ${operation} response is invalid`);
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    assertQos(/^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= MAX_RESPONSE_BYTES, "DEX_PROVIDER_RESPONSE_TOO_LARGE", `Raydium ${operation} response is too large`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    assertQos(bytes.length <= MAX_RESPONSE_BYTES, "DEX_PROVIDER_RESPONSE_TOO_LARGE", `Raydium ${operation} response is too large`);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new QosError("DEX_PROVIDER_RESPONSE_INVALID", `Raydium ${operation} returned invalid JSON`); }
    assertQos(response.ok === true && value?.success === true, "DEX_PROVIDER_REJECTED", `Raydium ${operation} rejected the request`, { statusCode: response.status, providerCode: value?.msg ?? null });
    return value;
  } finally {
    bytes.fill(0);
  }
}

function deserializeRaydiumTransaction(encoded, signer) {
  const raw = Buffer.from(encoded, "base64");
  try {
    assertQos(raw.length > 0 && raw.length <= MAX_TRANSACTION_BYTES && raw.toString("base64") === encoded, "DEX_TRANSACTION_INVALID", "Raydium transaction encoding is invalid");
    const cursor = { offset: 0 };
    const signatureCount = readShortVec(raw, cursor, "signature count");
    assertQos(signatureCount === 1, "DEX_SIGNER_SET_INVALID", "Raydium transaction must require only the qOS signer");
    const signatureOffset = cursor.offset;
    const priorSignature = take(raw, cursor, 64, "signature");
    assertQos(priorSignature.every((byte) => byte === 0), "DEX_TRANSACTION_PRESIGNED", "Raydium transaction contains an unexpected signature");
    const messageOffset = cursor.offset;
    const header = take(raw, cursor, 3, "message header");
    assertQos((header[0] & 0x80) === 0 && header[0] === 1 && header[1] === 0, "DEX_TRANSACTION_VERSION_INVALID", "Raydium transactions must use a one-signer legacy Solana message");
    const accountCount = readShortVec(raw, cursor, "account count");
    assertQos(accountCount >= 1 && accountCount <= 64, "DEX_TRANSACTION_COMPLEXITY", "Raydium transaction account count is invalid");
    const accountBytes = take(raw, cursor, accountCount * 32, "accounts");
    const accounts = Array.from({ length: accountCount }, (_, index) => encodeBase58(accountBytes.subarray(index * 32, index * 32 + 32)));
    assertQos(accounts[0] === signer, "DEX_SIGNER_SET_INVALID", "qOS signer must be the Raydium transaction fee payer");
    const recentBlockhash = encodeBase58(take(raw, cursor, 32, "recent blockhash"));
    const instructionCount = readShortVec(raw, cursor, "instruction count");
    assertQos(instructionCount >= 1 && instructionCount <= 64, "DEX_TRANSACTION_COMPLEXITY", "Raydium transaction instruction count is invalid");
    let raydiumInstruction = false;
    const instructions = [];
    for (let index = 0; index < instructionCount; index += 1) {
      const programIndex = take(raw, cursor, 1, "program index")[0];
      assertQos(programIndex < accounts.length && RAYDIUM_PROGRAM_IDS.has(accounts[programIndex]), "DEX_PROGRAM_NOT_ALLOWED", "Raydium transaction invokes a program outside the reviewed allowlist", { programId: accounts[programIndex] ?? null });
      if ([
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
        "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",
      ].includes(accounts[programIndex])) raydiumInstruction = true;
      const instructionAccounts = readShortVec(raw, cursor, "instruction account count");
      assertQos(instructionAccounts <= 128, "DEX_TRANSACTION_COMPLEXITY", "Raydium instruction account count is too large");
      const accountIndexes = [...take(raw, cursor, instructionAccounts, "instruction accounts")];
      assertQos(accountIndexes.every((accountIndex) => accountIndex < accounts.length), "DEX_TRANSACTION_INVALID", "Raydium instruction references an account outside the transaction");
      const dataLength = readShortVec(raw, cursor, "instruction data length");
      const data = Buffer.from(take(raw, cursor, dataLength, "instruction data"));
      instructions.push({
        programId: accounts[programIndex],
        accounts: accountIndexes.map((accountIndex) => accounts[accountIndex]),
        data,
      });
    }
    assertQos(raydiumInstruction, "DEX_PROGRAM_NOT_ALLOWED", "Raydium transaction does not invoke a reviewed Raydium swap program");
    assertQos(cursor.offset === raw.length, "DEX_TRANSACTION_INVALID", "Raydium transaction contains trailing bytes");
    const preserved = Buffer.from(raw);
    return {
      raw: preserved,
      message: preserved.subarray(messageOffset),
      recentBlockhash,
      accounts,
      instructions,
      sign(signature) {
        assertQos(Buffer.isBuffer(signature) && signature.length === 64, "INVALID_SIGNATURE", "DEX signer returned an invalid Ed25519 signature");
        const signed = Buffer.from(preserved);
        signature.copy(signed, signatureOffset);
        return signed;
      },
    };
  } finally {
    raw.fill(0);
  }
}

function dexTokenAccount(value, { tokenProgram, mint, owner, field, allowMissing = false }) {
  if (value === null || value === undefined) {
    assertQos(allowMissing, "DEX_TOKEN_ACCOUNT_NOT_FOUND", `${field} does not exist`);
    return null;
  }
  assertQos(value && value.owner === tokenProgram && Array.isArray(value.data) && value.data.length === 2 && value.data[1] === "base64", "DEX_TOKEN_ACCOUNT_INVALID", `${field} is not a canonical token account`);
  const bytes = Buffer.from(value.data[0], "base64");
  try {
    assertQos(bytes.toString("base64") === value.data[0] && bytes.length >= 165, "DEX_TOKEN_ACCOUNT_INVALID", `${field} is not a canonical token account`);
    assertQos(encodeBase58(bytes.subarray(0, 32)) === mint && encodeBase58(bytes.subarray(32, 64)) === owner && bytes[108] === 1, "DEX_TOKEN_ACCOUNT_INVALID", `${field} changed mint, authority, or state`);
    return bytes.readBigUInt64LE(64);
  } finally {
    bytes.fill(0);
  }
}

function accountLamports(value, field) {
  assertQos(value && Number.isSafeInteger(value.lamports) && value.lamports >= 0, "DEX_ACCOUNT_INVALID", `${field} has an invalid SOL balance`);
  return BigInt(value.lamports);
}

function transferAmount(data, checked) {
  const expected = checked ? 10 : 9;
  assertQos(data.length === expected, "DEX_TOKEN_INSTRUCTION_INVALID", "Raydium token transfer data has an invalid length");
  return data.readBigUInt64LE(1);
}

function validateRaydiumInstructionSurface(transaction, {
  signer,
  inputAccount,
  outputAccount,
  inputMint,
  outputMint,
  inputTokenProgram,
  outputTokenProgram,
  inputOwner,
  outputOwner,
  wrapSol,
  unwrapSol,
  maximumInput,
}) {
  assertQos(transaction.accounts.includes(inputAccount) && transaction.accounts.includes(outputAccount), "DEX_ACCOUNT_SET_INVALID", "Raydium transaction omitted the policy-derived input or output account");
  let swapInstruction = false;
  for (const instruction of transaction.instructions) {
    if (instruction.programId === SYSTEM_PROGRAM_ID) {
      assertQos(wrapSol && instruction.data.length === 12 && instruction.data.readUInt32LE(0) === 2, "DEX_SYSTEM_INSTRUCTION_FORBIDDEN", "Raydium transaction contains an unreviewed System Program instruction");
      assertQos(instruction.accounts.length === 2 && instruction.accounts[0] === signer && instruction.accounts[1] === inputAccount, "DEX_SYSTEM_INSTRUCTION_FORBIDDEN", "Raydium transaction changed the wrapped-SOL funding destination");
      assertQos(instruction.data.readBigUInt64LE(4) <= maximumInput + 2_500_000n, "DEX_SYSTEM_INSTRUCTION_FORBIDDEN", "Raydium transaction exceeds the wrapped-SOL funding limit");
      continue;
    }
    if (instruction.programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
      assertQos(instruction.data.length === 0 || (instruction.data.length === 1 && instruction.data[0] === 1), "DEX_ATA_INSTRUCTION_FORBIDDEN", "Raydium transaction contains an unsupported associated-account instruction");
      assertQos(instruction.accounts.length >= 6 && instruction.accounts[0] === signer, "DEX_ATA_INSTRUCTION_FORBIDDEN", "Raydium associated-account creation changed the fee payer");
      const associated = instruction.accounts[1];
      const expected = associated === inputAccount
        ? { owner: inputOwner, mint: inputMint, tokenProgram: inputTokenProgram }
        : associated === outputAccount
          ? { owner: outputOwner, mint: outputMint, tokenProgram: outputTokenProgram }
          : null;
      assertQos(expected !== null && instruction.accounts[2] === expected.owner && instruction.accounts[3] === expected.mint && instruction.accounts[4] === SYSTEM_PROGRAM_ID && instruction.accounts[5] === expected.tokenProgram, "DEX_ATA_INSTRUCTION_FORBIDDEN", "Raydium transaction tried to create an account outside the requested swap");
      continue;
    }
    if (instruction.programId === TOKEN_PROGRAM_ID || instruction.programId === TOKEN_2022_PROGRAM_ID) {
      const opcode = instruction.data[0];
      if (opcode === 17) {
        assertQos(instruction.data.length === 1 && instruction.accounts.length === 1 && instruction.accounts[0] === inputAccount && wrapSol, "DEX_TOKEN_INSTRUCTION_FORBIDDEN", "Raydium SyncNative instruction is outside the requested wrapped-SOL input");
        continue;
      }
      if (opcode === 9) {
        const reviewedWrappedAccount = (wrapSol && instruction.accounts[0] === inputAccount) || (unwrapSol && instruction.accounts[0] === outputAccount);
        assertQos(instruction.data.length === 1 && instruction.accounts.length >= 3 && reviewedWrappedAccount && instruction.accounts[1] === signer && instruction.accounts[2] === signer, "DEX_TOKEN_INSTRUCTION_FORBIDDEN", "Raydium close-account instruction is outside the requested wrapped-SOL flow");
        continue;
      }
      if (opcode === 3 || opcode === 12) {
        const amount = transferAmount(instruction.data, opcode === 12);
        const authorityIndex = opcode === 12 ? 3 : 2;
        const checkedMintMatches = opcode !== 12 || instruction.accounts[1] === inputMint;
        assertQos(instruction.programId === inputTokenProgram && instruction.accounts.length > authorityIndex && instruction.accounts[0] === inputAccount && instruction.accounts[authorityIndex] === signer && checkedMintMatches && amount <= maximumInput, "DEX_TOKEN_INSTRUCTION_FORBIDDEN", "Raydium direct token transfer exceeds or changes the requested input");
        continue;
      }
      assertQos(false, "DEX_TOKEN_INSTRUCTION_FORBIDDEN", "Raydium transaction contains an unreviewed direct token instruction");
    }
    if ([
      "ComputeBudget111111111111111111111111111111",
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    ].includes(instruction.programId)) continue;
    if ([
      "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
      "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
      "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
      "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",
    ].includes(instruction.programId)) {
      if (instruction.accounts.includes(inputAccount) && instruction.accounts.includes(outputAccount)) swapInstruction = true;
      continue;
    }
    assertQos(false, "DEX_PROGRAM_NOT_ALLOWED", "Raydium transaction invokes a program outside the reviewed adapter");
  }
  assertQos(swapInstruction, "DEX_ACCOUNT_SET_INVALID", "Raydium swap instruction did not bind the requested input and output accounts");
}

async function rejectUnexpectedSignerTokenAccounts(rpc, transaction, signer, allowedAccounts) {
  const values = await rpc.getMultipleAccounts(transaction.accounts);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === null || (value.owner !== TOKEN_PROGRAM_ID && value.owner !== TOKEN_2022_PROGRAM_ID) || !Array.isArray(value.data) || value.data[1] !== "base64") continue;
    const bytes = Buffer.from(value.data[0], "base64");
    try {
      if (bytes.toString("base64") !== value.data[0] || bytes.length < 165 || bytes[108] !== 1) continue;
      if (encodeBase58(bytes.subarray(32, 64)) === signer) {
        assertQos(allowedAccounts.has(transaction.accounts[index]), "DEX_ACCOUNT_SET_INVALID", "Raydium transaction included another token account controlled by the firmware signer");
      }
    } finally {
      bytes.fill(0);
    }
  }
}

function validateRaydiumSimulation(simulation, {
  inspectionAccounts,
  signer,
  inputAccount,
  outputAccount,
  inputMint,
  outputMint,
  inputTokenProgram,
  outputTokenProgram,
  inputOwner,
  outputOwner,
  wrapSol,
  unwrapSol,
  preAccounts,
  minimumOutput,
  maximumInput,
  maximumFeeLamports,
}) {
  assertQos(simulation && simulation.err === null && Array.isArray(simulation.accounts) && simulation.accounts.length === inspectionAccounts.length, "DEX_SIMULATION_FAILED", "Raydium preflight simulation failed or omitted inspected account state");
  const before = new Map(inspectionAccounts.map((address, index) => [address, preAccounts[index]]));
  const after = new Map(inspectionAccounts.map((address, index) => [address, simulation.accounts[index]]));
  if (!wrapSol) {
    const prior = dexTokenAccount(before.get(inputAccount), { tokenProgram: inputTokenProgram, mint: inputMint, owner: inputOwner, field: "Raydium input account" });
    const next = dexTokenAccount(after.get(inputAccount), { tokenProgram: inputTokenProgram, mint: inputMint, owner: inputOwner, field: "simulated Raydium input account" });
    assertQos(prior > next && prior - next <= maximumInput, "DEX_SIMULATION_INPUT_MISMATCH", "Raydium simulation exceeded or did not debit the requested input");
  }
  if (!unwrapSol) {
    const prior = dexTokenAccount(before.get(outputAccount), { tokenProgram: outputTokenProgram, mint: outputMint, owner: outputOwner, field: "Raydium output account", allowMissing: true }) ?? 0n;
    const next = dexTokenAccount(after.get(outputAccount), { tokenProgram: outputTokenProgram, mint: outputMint, owner: outputOwner, field: "simulated Raydium output account" });
    assertQos(next >= prior && next - prior >= minimumOutput, "DEX_SIMULATION_OUTPUT_MISMATCH", "Raydium simulation did not deliver the quote-protected minimum output");
  }
  const priorSol = accountLamports(before.get(signer), "Raydium signer account");
  const nextSol = accountLamports(after.get(signer), "simulated Raydium signer account");
  if (wrapSol) assertQos(priorSol <= nextSol + maximumInput + maximumFeeLamports, "DEX_SIMULATION_SOL_MISMATCH", "Raydium simulation debited more SOL than the input and fee policy allows");
  if (unwrapSol) assertQos(nextSol + maximumFeeLamports >= priorSol + minimumOutput, "DEX_SIMULATION_OUTPUT_MISMATCH", "Raydium simulation did not return the quote-protected SOL output");
}

function validateRaydiumQuote(quote, policy, action) {
  const data = quote?.data;
  assertQos(data && typeof data === "object" && data.swapType === "BaseIn", "DEX_ORDER_INVALID", "Raydium quote is not a BaseIn swap");
  assertQos(data.inputMint === action.inputMint && data.outputMint === action.outputMint && data.inputAmount === action.amount, "DEX_ORDER_MISMATCH", "Raydium quote does not match the requested pair and amount");
  assertQos(Number.isInteger(data.slippageBps) && data.slippageBps >= 0 && data.slippageBps <= policy.maxSlippageBps, "DEX_SLIPPAGE_LIMIT_EXCEEDED", "Raydium quote exceeds the slippage policy");
  const outputAmount = parseUnsigned(data.outputAmount, 64, "Raydium output amount");
  const minimumOutput = parseUnsigned(data.otherAmountThreshold, 64, "Raydium minimum output");
  assertQos(outputAmount > 0n && minimumOutput > 0n && minimumOutput <= outputAmount, "DEX_ORDER_INVALID", "Raydium quote output protection is invalid");
  assertQos(Array.isArray(data.routePlan) && data.routePlan.length >= 1 && data.routePlan.length <= 16, "DEX_ORDER_INVALID", "Raydium quote route plan is invalid");
  const feeAmount = data.routePlan.reduce((sum, leg) => sum + parseUnsigned(leg?.feeAmount ?? "0", 64, "Raydium route fee"), 0n);
  const input = BigInt(action.amount);
  const routeFeeBps = Number((feeAmount * 10_000n + input - 1n) / input);
  assertQos(routeFeeBps <= policy.maxRouteFeeBps, "DEX_ROUTE_FEE_LIMIT_EXCEEDED", "Raydium quote exceeds the route fee policy");
  return { data, outputAmount, minimumOutput, routeFeeBps };
}

async function executeRaydiumSwap({ paths, provider, pair, amount, policy, signer, rpc, action, fetchImpl, now, mints }) {
  assertQos(provider.venues.includes("raydium"), "DEX_VENUE_NOT_ALLOWED", "Raydium is not enabled for this qOS profile");
  const quoteUrl = new URL(`${provider.raydiumEndpoint}/compute/swap-base-in`);
  quoteUrl.searchParams.set("inputMint", action.inputMint);
  quoteUrl.searchParams.set("outputMint", action.outputMint);
  quoteUrl.searchParams.set("amount", action.amount);
  quoteUrl.searchParams.set("slippageBps", String(provider.maxSlippageBps));
  quoteUrl.searchParams.set("txVersion", "LEGACY");
  const quote = await readRaydiumJson(await fetchImpl(quoteUrl, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000) }), "quote");
  const validated = validateRaydiumQuote(quote, provider, action);
  const state = currentState(paths, now);
  const budget = enforceState(provider, pair, amount, validated.routeFeeBps, state, now);
  const receiver = provider.receiver ?? signer.publicKey;
  const wrapSol = action.inputMint === WRAPPED_SOL_MINT;
  const unwrapSol = action.outputMint === WRAPPED_SOL_MINT && receiver === signer.publicKey;
  const inputTokenAccount = associatedTokenAddress({ owner: signer.publicKey, mint: action.inputMint, tokenProgram: mints.input.tokenProgram });
  const outputTokenAccount = associatedTokenAddress({ owner: receiver, mint: action.outputMint, tokenProgram: mints.output.tokenProgram });
  const inputAccount = wrapSol ? null : inputTokenAccount;
  const outputAccount = unwrapSol ? null : outputTokenAccount;
  if (inputAccount !== null) assertQos(await rpc.getAccountInfo(inputAccount) !== null, "DEX_INPUT_ACCOUNT_NOT_FOUND", "Raydium input token account does not exist for the firmware signer");
  const outputExists = await rpc.getAccountInfo(outputTokenAccount) !== null;
  const buildBody = {
    computeUnitPriceMicroLamports: "0",
    swapResponse: quote,
    txVersion: "LEGACY",
    wallet: signer.publicKey,
    wrapSol,
    unwrapSol,
    ...(inputAccount === null ? {} : { inputAccount }),
    ...(outputAccount === null ? {} : { outputAccount }),
  };
  const built = await readRaydiumJson(await fetchImpl(`${provider.raydiumEndpoint}/transaction/swap-base-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildBody),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }), "transaction build");
  const entries = Array.isArray(built.data) ? built.data : [built.data];
  assertQos(entries.length === 1 && entries.every((entry) => typeof entry?.transaction === "string"), "DEX_TRANSACTION_INVALID", "The reviewed Raydium adapter requires one atomic swap transaction");
  const transactions = entries.map((entry) => deserializeRaydiumTransaction(entry.transaction, signer.publicKey));
  validateRaydiumInstructionSurface(transactions[0], {
    signer: signer.publicKey,
    inputAccount: inputTokenAccount,
    outputAccount: outputTokenAccount,
    inputMint: action.inputMint,
    outputMint: action.outputMint,
    inputTokenProgram: mints.input.tokenProgram,
    outputTokenProgram: mints.output.tokenProgram,
    inputOwner: signer.publicKey,
    outputOwner: receiver,
    wrapSol,
    unwrapSol,
    maximumInput: budget.worstGross,
  });
  await rejectUnexpectedSignerTokenAccounts(rpc, transactions[0], signer.publicKey, new Set([inputTokenAccount, outputTokenAccount]));
  const inspectionAccounts = [...new Set([signer.publicKey, inputTokenAccount, outputTokenAccount])];
  const preAccounts = await rpc.getMultipleAccounts(inspectionAccounts);
  const networkFees = await Promise.all(transactions.map((transaction) => rpc.getFeeForMessage(transaction.message.toString("base64"))));
  assertQos(networkFees.every((fee) => Number.isSafeInteger(fee) && fee >= 0), "FEE_UNAVAILABLE", "RPC could not calculate a Raydium transaction fee");
  const estimatedRentLamports = outputExists ? 0n : 2_500_000n;
  const networkFee = networkFees.reduce((sum, fee) => sum + BigInt(fee), 0n) + estimatedRentLamports;
  assertQos(networkFee <= BigInt(provider.maxFeeLamports), "DEX_NETWORK_FEE_LIMIT_EXCEEDED", "Raydium transaction batch exceeds the network and rent fee policy");
  const reservedState = {
    version: 1,
    day: now.toISOString().slice(0, 10),
    tradeCount: state.tradeCount + 1,
    lastExecutedAt: now.toISOString(),
    inputTotals: { ...state.inputTotals, [budget.pairId]: (BigInt(state.inputTotals[budget.pairId] ?? "0") + budget.worstGross).toString() },
  };
  validateTradingState(reservedState);
  const signatures = [];
  try {
    for (let index = 0; index < transactions.length; index += 1) {
      const transaction = transactions[index];
      const message = Buffer.from(transaction.message);
      let signature;
      try {
        const dexIntent = {
          version: 2,
          provider: "raydium",
          endpoint: provider.raydiumEndpoint,
          batchIndex: index,
          batchSize: transactions.length,
          inputMint: action.inputMint,
          outputMint: action.outputMint,
          receiver,
          inputAmount: action.amount,
          minimumOutput: validated.minimumOutput.toString(),
          maxSlippageBps: provider.maxSlippageBps,
          maxRouteFeeBps: provider.maxRouteFeeBps,
          maxFeeLamports: provider.maxFeeLamports,
          strategyId: action.strategyId,
          recentBlockhash: transaction.recentBlockhash,
          transactionSha256: createHash("sha256").update(message).digest("hex"),
        };
        signature = await signer.sign(message, {
          version: 1,
          intent: dexIntent,
          intentCommitment: intentCommitment(dexIntent),
          policyCommitment: policyCommitment(policy),
          privacyProofVerified: false,
        });
        const expectedSignature = encodeBase58(signature);
        const signedBytes = transaction.sign(signature);
        let submitted;
        try {
          const signedTransaction = signedBytes.toString("base64");
          const simulation = await rpc.simulateTransaction(signedTransaction, { accounts: inspectionAccounts });
          validateRaydiumSimulation(simulation, {
            inspectionAccounts,
            signer: signer.publicKey,
            inputAccount: inputTokenAccount,
            outputAccount: outputTokenAccount,
            inputMint: action.inputMint,
            outputMint: action.outputMint,
            inputTokenProgram: mints.input.tokenProgram,
            outputTokenProgram: mints.output.tokenProgram,
            inputOwner: signer.publicKey,
            outputOwner: receiver,
            wrapSol,
            unwrapSol,
            preAccounts,
            minimumOutput: validated.minimumOutput,
            maximumInput: budget.worstGross,
            maximumFeeLamports: BigInt(provider.maxFeeLamports),
          });
          if (index === 0) writePrivateJsonAtomic(paths.tradingState, reservedState, { errorCode: "DEX_STATE_WRITE_FAILED", label: "DEX trading state" });
          submitted = await rpc.sendTransaction(signedTransaction);
        } finally {
          signedBytes.fill(0);
        }
        assertQos(submitted === expectedSignature, "SIGNATURE_MISMATCH", "Solana RPC returned a different Raydium transaction signature");
        await rpc.confirmSignature(submitted, { timeoutMs: policy.confirmationTimeoutMs, recentBlockhash: transaction.recentBlockhash });
        signatures.push(submitted);
      } finally {
        message.fill(0);
        signature?.fill(0);
      }
    }
    const next = {
      ...reservedState,
      inputTotals: { ...state.inputTotals, [budget.pairId]: (BigInt(state.inputTotals[budget.pairId] ?? "0") + amount).toString() },
    };
    validateTradingState(next);
    writePrivateJsonAtomic(paths.tradingState, next, { errorCode: "DEX_STATE_WRITE_FAILED", label: "DEX trading state" });
    return {
      status: "confirmed",
      provider: "raydium",
      router: "raydium-direct",
      inputMint: action.inputMint,
      outputMint: action.outputMint,
      receiver,
      requestedInputAmount: action.amount,
      totalInputAmount: action.amount,
      totalOutputAmount: validated.outputAmount.toString(),
      minimumOutput: validated.minimumOutput.toString(),
      slippageBps: validated.data.slippageBps,
      routeFeeBps: validated.routeFeeBps,
      networkAndRentFeeLamports: networkFee.toString(),
      signature: signatures.at(-1),
      signatures,
      explorerUrl: `https://solscan.io/tx/${signatures.at(-1)}`,
      explorerUrls: signatures.map((value) => `https://solscan.io/tx/${value}`),
      limits: { day: next.day, tradeCount: next.tradeCount, pairInputTotal: next.inputTotals[budget.pairId] },
    };
  } finally {
    for (const transaction of transactions) {
      transaction.raw.fill(0);
      for (const instruction of transaction.instructions) instruction.data.fill(0);
    }
  }
}

export async function executeDexSwap({ home, policy, signer, runtimeProfile, proofGate, rpc, action, fetchImpl = globalThis.fetch, now = new Date() }) {
  const paths = dexPaths(home);
  const { pair, amount, venue } = validateDexAction(policy, action);
  assertQos(policy.cluster === "mainnet-beta", "DEX_CLUSTER_UNSUPPORTED", "Live DEX trading is supported only on Solana mainnet-beta");
  assertQos(process.env.QOS_ENABLE_MAINNET_BROADCAST === "I_UNDERSTAND", "MAINNET_BROADCAST_DISABLED", "Set QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND to authorize a mainnet DEX swap");
  const signerStatus = signer.status();
  assertQos(signerStatus?.keyExportableToAgentProcess === false || (signerStatus?.keyExportableToAgentProcess === true && runtimeProfile?.profile === "mainnet-insecure"), "MAINNET_EXTERNAL_SIGNER_REQUIRED", "Mainnet software signing requires a setup-created --insecure profile; otherwise use a non-exportable external signer");
  assertQos(proofGate?.status?.().required !== true, "DEX_ZK_PROOF_UNSUPPORTED", "DEX swaps are disabled while a mandatory SNARK gate is configured");
  const mints = await validateSolanaTokenMints(rpc, action);
  const provider = publicDexTrading(paths.home);
  assertQos(provider.venues.includes(venue), "DEX_VENUE_NOT_ALLOWED", "Requested DEX venue is not enabled for this qOS profile");
  if (venue === "raydium") {
    return executeRaydiumSwap({ paths, provider, pair, amount, policy, signer, rpc, action: { ...action, venue }, fetchImpl, now, mints });
  }
  const credentialBytes = readSecureFile(paths.apiKey, { privateFile: true, minBytes: 8, maxBytes: 2_050, errorCode: "INSECURE_DEX_CREDENTIAL", label: "Jupiter API key file" });
  let credential;
  try {
    credential = visibleApiKey(credentialBytes);
    const url = new URL(`${provider.endpoint}/order`);
    url.searchParams.set("inputMint", action.inputMint);
    url.searchParams.set("outputMint", action.outputMint);
    url.searchParams.set("amount", action.amount);
    url.searchParams.set("taker", signer.publicKey);
    if (provider.receiver !== null) {
      assertQos(provider.receiver !== signer.publicKey, "DEX_RECEIVER_INVALID", "An explicit DEX output receiver must differ from the firmware signer");
      url.searchParams.set("receiver", provider.receiver);
    }
    url.searchParams.set("swapMode", "ExactIn");
    url.searchParams.set("slippageBps", String(provider.maxSlippageBps));
    url.searchParams.set("excludeRouters", "jupiterz");
    const headers = { "x-api-key": credential.toString("ascii") };
    const order = await readJsonResponse(await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(15_000) }), "order");
    const validated = validateOrder(order, provider, action, pair, signer.publicKey);
    const state = currentState(paths, now);
    const budget = enforceState(provider, pair, amount, order.feeBps, state, now);
    const transaction = deserializeOrderTransaction(order, signer.publicKey);
    const message = Buffer.from(transaction.message);
    let signature;
    try {
      const dexIntent = {
        version: 5,
        clusterGenesis: policy.clusterGenesis,
        provider: provider.provider,
        endpoint: provider.endpoint,
        inputMint: action.inputMint,
        outputMint: action.outputMint,
        receiver: provider.receiver ?? signer.publicKey,
        inputAmount: action.amount,
        minimumOutput: validated.minimumOutput.toString(),
        maxSlippageBps: provider.maxSlippageBps,
        maxRouteFeeBps: provider.maxRouteFeeBps,
        maxFeeLamports: provider.maxFeeLamports,
        strategyId: action.strategyId,
        orderRequestId: order.requestId,
        recentBlockhash: transaction.recentBlockhash,
        lastValidBlockHeight: order.lastValidBlockHeight,
        transactionSha256: createHash("sha256").update(message).digest("hex"),
      };
      signature = await signer.sign(message, {
        version: 1,
        intent: dexIntent,
        intentCommitment: intentCommitment(dexIntent),
        policyCommitment: policyCommitment(policy),
        privacyProofVerified: false,
      });
      assertQos(Buffer.isBuffer(signature) && signature.length === 64, "INVALID_SIGNATURE", "DEX signer returned an invalid Ed25519 signature");
      const signedBytes = transaction.sign(signature);
      const signedTransaction = signedBytes.toString("base64");
      signedBytes.fill(0);
      const reservedState = {
        version: 1,
        day: now.toISOString().slice(0, 10),
        tradeCount: state.tradeCount + 1,
        lastExecutedAt: now.toISOString(),
        inputTotals: { ...state.inputTotals, [budget.pairId]: (BigInt(state.inputTotals[budget.pairId] ?? "0") + budget.worstGross).toString() },
      };
      validateTradingState(reservedState);
      // Once a signed transaction is handed to the venue, delivery can become
      // ambiguous even when the HTTP request times out. Reserve the full
      // authorized gross amount first so a restart or retry cannot reuse funds
      // that may already have landed. A confirmed response narrows this
      // conservative reservation to the provider-reported wallet debit below.
      writePrivateJsonAtomic(paths.tradingState, reservedState, { errorCode: "DEX_STATE_WRITE_FAILED", label: "DEX trading state" });
      const execution = await readJsonResponse(await fetchImpl(`${provider.endpoint}/execute`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ signedTransaction, requestId: order.requestId, lastValidBlockHeight: order.lastValidBlockHeight }),
        redirect: "error",
        signal: AbortSignal.timeout(90_000),
      }), "execute");
      assertQos(execution.status === "Success" && execution.code === 0, "DEX_EXECUTION_FAILED", "Jupiter could not land the swap", { providerCode: execution.code ?? null });
      decodeBase58(execution.signature, 64);
      const totalInput = parseUnsigned(execution.totalInputAmount, 64, "Jupiter total input amount");
      const totalOutput = parseUnsigned(execution.totalOutputAmount, 64, "Jupiter total output amount");
      // Validate the response before replacing the conservative reservation.
      // If any value is impossible, keep the reservation fail-closed.
      assertQos(totalInput > 0n && totalInput <= budget.worstGross, "DEX_EXECUTION_INPUT_MISMATCH", "Jupiter execution exceeded the authorized gross input budget");
      assertQos(totalOutput >= validated.minimumOutput, "DEX_EXECUTION_OUTPUT_MISMATCH", "Jupiter execution returned less than the authorized minimum output");
      const next = {
        version: 1,
        day: now.toISOString().slice(0, 10),
        tradeCount: reservedState.tradeCount,
        lastExecutedAt: now.toISOString(),
        inputTotals: { ...state.inputTotals, [budget.pairId]: (BigInt(state.inputTotals[budget.pairId] ?? "0") + totalInput).toString() },
      };
      validateTradingState(next);
      writePrivateJsonAtomic(paths.tradingState, next, { errorCode: "DEX_STATE_WRITE_FAILED", label: "DEX trading state" });
      return {
        status: "confirmed",
        provider: "jupiter",
        router: order.router,
        inputMint: action.inputMint,
        outputMint: action.outputMint,
        receiver: provider.receiver ?? signer.publicKey,
        requestedInputAmount: action.amount,
        totalInputAmount: totalInput.toString(),
        totalOutputAmount: totalOutput.toString(),
        minimumOutput: validated.minimumOutput.toString(),
        slippageBps: order.slippageBps,
        routeFeeBps: order.feeBps,
        networkAndRentFeeLamports: validated.networkFee.toString(),
        signature: execution.signature,
        slot: execution.slot ?? null,
        explorerUrl: `https://solscan.io/tx/${execution.signature}`,
        limits: { day: next.day, tradeCount: next.tradeCount, pairInputTotal: next.inputTotals[budget.pairId] },
      };
    } finally {
      message.fill(0);
      transaction.raw.fill(0);
      signature?.fill(0);
    }
  } finally {
    credentialBytes.fill(0);
    credential?.fill(0);
  }
}
