import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decodeBase58, encodeBase58 } from "./base58.js";
import { hasExactKeys } from "./canonical.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants.js";
import { assertQos, QosError } from "./errors.js";
import { loadPolicy, parseUnsigned, validateDexTradingPolicy, validatePolicy } from "./policy.js";
import { readPrivateJson, writePrivateJsonAtomic } from "./private-json.js";
import { assertPrivateDirectory, readSecureFile } from "./secure-file.js";
import { parseGenericMintAccount } from "./token.js";
import { encodeShortVec } from "./transaction.js";
import { intentCommitment, policyCommitment } from "./zk.js";

export const JUPITER_SWAP_ENDPOINT = "https://api.jup.ag/swap/v2";
const PROVIDER_KEYS = ["version", "provider", "endpoint"];
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
    writePrivateJsonAtomic(paths.provider, { version: 1, provider: "jupiter", endpoint: JUPITER_SWAP_ENDPOINT }, { errorCode: "DEX_CONFIG_WRITE_FAILED", label: "DEX provider configuration" });
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
  assertQos(hasExactKeys(provider, PROVIDER_KEYS) && provider.version === 1 && provider.provider === "jupiter" && provider.endpoint === JUPITER_SWAP_ENDPOINT, "INVALID_DEX_CONFIG", "DEX provider configuration is invalid");
  readSecureFile(paths.apiKey, { privateFile: true, minBytes: 8, maxBytes: 2_050, errorCode: "INSECURE_DEX_CREDENTIAL", label: "Jupiter API key file" }).fill(0);
  return { ...policy.dexTrading, credentialConfigured: true };
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
  assertQos(action && typeof action === "object" && !Array.isArray(action) && hasExactKeys(action, ["version", "action", "inputMint", "outputMint", "amount", "strategyId"]), "INVALID_DEX_ACTION", "DEX action has missing or unknown fields");
  assertQos(action.version === 2 && action.action === "swap", "INVALID_DEX_ACTION", "DEX action version or name is unsupported");
  decodeBase58(action.inputMint, 32);
  decodeBase58(action.outputMint, 32);
  assertQos(action.inputMint !== action.outputMint, "DEX_IDENTICAL_MINTS", "DEX input and output mints must differ");
  assertQos(Number.isInteger(action.strategyId) && policy.allowedStrategyIds.includes(action.strategyId), "STRATEGY_NOT_ALLOWED", "DEX strategy is not allowlisted");
  const pair = pairFor(policy, action);
  const amount = parseUnsigned(action.amount, 64, "DEX input amount");
  assertQos(amount > 0n && amount <= BigInt(pair.maxInputAmount), "DEX_INPUT_LIMIT_EXCEEDED", "DEX input amount exceeds the pair policy");
  return Object.freeze({ action: Object.freeze({ ...action }), pair, amount });
}

async function validateSolanaTokenMints(rpc, action) {
  assertQos(rpc && typeof rpc.getAccountInfo === "function", "DEX_RPC_UNAVAILABLE", "DEX trading requires Solana RPC account validation");
  const [input, output] = await Promise.all([
    rpc.getAccountInfo(action.inputMint),
    rpc.getAccountInfo(action.outputMint),
  ]);
  for (const [label, address, value] of [
    ["input", action.inputMint, input],
    ["output", action.outputMint, output],
  ]) {
    assertQos(value && typeof value === "object", "DEX_MINT_NOT_FOUND", `DEX ${label} mint does not exist on the policy-pinned Solana cluster`, { mint: address });
    assertQos(value.owner === TOKEN_PROGRAM_ID || value.owner === TOKEN_2022_PROGRAM_ID, "DEX_MINT_NOT_TOKEN", `DEX ${label} mint is not owned by a supported Solana token program`, { mint: address, owner: value.owner ?? null });
    parseGenericMintAccount(value, value.owner);
  }
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

export async function executeDexSwap({ home, policy, signer, runtimeProfile, proofGate, rpc, action, fetchImpl = globalThis.fetch, now = new Date() }) {
  const paths = dexPaths(home);
  const { pair, amount } = validateDexAction(policy, action);
  assertQos(policy.cluster === "mainnet-beta", "DEX_CLUSTER_UNSUPPORTED", "Live DEX trading is supported only on Solana mainnet-beta");
  assertQos(process.env.QOS_ENABLE_MAINNET_BROADCAST === "I_UNDERSTAND", "MAINNET_BROADCAST_DISABLED", "Set QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND to authorize a mainnet DEX swap");
  const signerStatus = signer.status();
  assertQos(signerStatus?.keyExportableToAgentProcess === false || (signerStatus?.keyExportableToAgentProcess === true && runtimeProfile?.profile === "mainnet-insecure"), "MAINNET_EXTERNAL_SIGNER_REQUIRED", "Mainnet software signing requires a setup-created --insecure profile; otherwise use a non-exportable external signer");
  assertQos(proofGate?.status?.().required !== true, "DEX_ZK_PROOF_UNSUPPORTED", "DEX swaps are disabled while a mandatory SNARK gate is configured");
  await validateSolanaTokenMints(rpc, action);
  const provider = publicDexTrading(paths.home);
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
