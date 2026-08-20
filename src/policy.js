import { TextDecoder } from "node:util";
import { decodeBase58 } from "./base58.js";
import { hasExactKeys } from "./canonical.js";
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  MARKET_ID,
  QOS_TOKEN_DECIMALS,
  QOS_TOKEN_MINT,
  QOS_TOKEN_MINT_EXTENSIONS,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  VENUE_ID,
  WRAPPED_SOL_MINT,
} from "./constants.js";
import { assertQos } from "./errors.js";
import { readSecureFile } from "./secure-file.js";

export const INTENT_KEYS = [
  "version",
  "requestNonce",
  "clusterGenesis",
  "venueId",
  "marketId",
  "side",
  "inputMint",
  "outputMint",
  "inputAmount",
  "minimumOutput",
  "maxFeeLamports",
  "maxCuPrice",
  "maxRelayTip",
  "destination",
  "recentBlockhash",
  "expiresAtSlot",
  "strategyId",
  "operatorApproval",
];

export const TOKEN_INTENT_KEYS = [
  "version",
  "requestNonce",
  "clusterGenesis",
  "venueId",
  "marketId",
  "side",
  "mint",
  "amount",
  "maxFeeLamports",
  "maxCuPrice",
  "maxRelayTip",
  "destination",
  "sourceTokenAccount",
  "destinationTokenAccount",
  "tokenProgram",
  "decimals",
  "recentBlockhash",
  "expiresAtSlot",
  "strategyId",
  "operatorApproval",
];

export const CLOUD_SETTLEMENT_INTENT_KEYS = [
  "version",
  "requestNonce",
  "clusterGenesis",
  "venueId",
  "marketId",
  "side",
  "mint",
  "grossAmount",
  "treasuryAmount",
  "burnAmount",
  "burnBasisPoints",
  "burnRemainderBefore",
  "burnRemainderAfter",
  "maxFeeLamports",
  "maxCuPrice",
  "maxRelayTip",
  "destination",
  "sourceTokenAccount",
  "destinationTokenAccount",
  "tokenProgram",
  "decimals",
  "recentBlockhash",
  "expiresAtSlot",
  "strategyId",
  "operatorApproval",
];

export const CLOUD_WITHDRAWAL_INTENT_KEYS = [
  "version",
  "requestNonce",
  "clusterGenesis",
  "venueId",
  "marketId",
  "side",
  "assetKind",
  "mint",
  "tokenProgram",
  "sourceTokenAccount",
  "destinationTokenAccount",
  "treasuryTokenAccount",
  "decimals",
  "grossAmount",
  "destinationAmount",
  "feeAmount",
  "feeBasisPoints",
  "feeRemainderBefore",
  "feeRemainderAfter",
  "createDestinationTokenAccount",
  "createTreasuryTokenAccount",
  "maxFeeLamports",
  "maxCuPrice",
  "maxRelayTip",
  "destination",
  "treasury",
  "recentBlockhash",
  "expiresAtSlot",
  "strategyId",
  "operatorApproval",
];

const POLICY_KEYS = [
  "version",
  "cluster",
  "clusterGenesis",
  "rpcUrl",
  "venueId",
  "marketId",
  "inputMint",
  "outputMint",
  "tokenTransfer",
  "dexTrading",
  "allowedDestinations",
  "allowedStrategyIds",
  "maxTransferLamports",
  "maxFeeLamports",
  "maxComputeUnitPrice",
  "maxRelayTipLamports",
  "maxIntentTtlSlots",
  "maxRequestsPerMinute",
  "commitment",
  "rpcTimeoutMs",
  "confirmationTimeoutMs",
];

const LEGACY_POLICY_KEYS = POLICY_KEYS.filter((key) => key !== "dexTrading");

const TOKEN_POLICY_KEYS = [
  "mint",
  "tokenProgram",
  "decimals",
  "maxTransferAmount",
  "allowedMintExtensions",
];

const LEGACY_DEX_POLICY_KEYS_WITH_RECEIVER = [
  "provider",
  "endpoint",
  "receiver",
  "allowedPairs",
  "maxSlippageBps",
  "maxRouteFeeBps",
  "maxFeeLamports",
  "minIntervalSeconds",
  "maxSwapsPerDay",
];

const LEGACY_DEX_POLICY_KEYS = LEGACY_DEX_POLICY_KEYS_WITH_RECEIVER.filter((key) => key !== "receiver");

const ANY_TOKEN_DEX_POLICY_KEYS = [
  "provider",
  "endpoint",
  "receiver",
  "tokenScope",
  "maxInputAmount",
  "dailyInputLimit",
  "maxSlippageBps",
  "maxRouteFeeBps",
  "maxFeeLamports",
  "minIntervalSeconds",
  "maxSwapsPerDay",
];

const DEX_PAIR_KEYS = ["inputMint", "outputMint", "maxInputAmount", "dailyInputLimit"];

export function validateDexTradingPolicy(value) {
  if (value === null) return null;
  if (value && typeof value === "object" && !Array.isArray(value) && hasExactKeys(value, LEGACY_DEX_POLICY_KEYS)) {
    value = { ...value, receiver: null };
  }
  assertQos(value && typeof value === "object" && !Array.isArray(value), "INVALID_DEX_POLICY", "DEX policy has missing or unknown fields");
  const legacyPairs = hasExactKeys(value, LEGACY_DEX_POLICY_KEYS_WITH_RECEIVER);
  const anyToken = hasExactKeys(value, ANY_TOKEN_DEX_POLICY_KEYS);
  assertQos(legacyPairs || anyToken, "INVALID_DEX_POLICY", "DEX policy has missing or unknown fields");
  assertQos(value.provider === "jupiter", "INVALID_DEX_PROVIDER", "Only the reviewed Jupiter provider is supported");
  assertQos(value.endpoint === "https://api.jup.ag/swap/v2", "INVALID_DEX_ENDPOINT", "Jupiter swaps must use the pinned HTTPS endpoint");
  assertQos(value.receiver === null || typeof value.receiver === "string", "INVALID_DEX_RECEIVER", "DEX receiver must be null or a Solana public key");
  if (value.receiver !== null) decodeBase58(value.receiver, 32);
  let normalized;
  if (legacyPairs) {
    assertQos(Array.isArray(value.allowedPairs) && value.allowedPairs.length >= 1 && value.allowedPairs.length <= 16, "INVALID_DEX_PAIR_ALLOWLIST", "DEX policy must allow between one and sixteen mint pairs");
    const pairs = value.allowedPairs.map((pair) => {
      assertQos(pair && typeof pair === "object" && !Array.isArray(pair) && hasExactKeys(pair, DEX_PAIR_KEYS), "INVALID_DEX_PAIR", "DEX pair has missing or unknown fields");
      decodeBase58(pair.inputMint, 32);
      decodeBase58(pair.outputMint, 32);
      assertQos(pair.inputMint !== pair.outputMint, "INVALID_DEX_PAIR", "DEX input and output mints must differ");
      const maxInputAmount = parseUnsigned(pair.maxInputAmount, 64, "dexTrading.allowedPairs.maxInputAmount");
      const dailyInputLimit = parseUnsigned(pair.dailyInputLimit, 64, "dexTrading.allowedPairs.dailyInputLimit");
      assertQos(maxInputAmount > 0n && dailyInputLimit >= maxInputAmount, "INVALID_DEX_LIMIT", "DEX daily input limit must be at least the maximum input per swap");
      return Object.freeze({ ...pair });
    });
    const pairIds = pairs.map((pair) => `${pair.inputMint}>${pair.outputMint}`);
    assertQos(new Set(pairIds).size === pairIds.length, "DUPLICATE_DEX_PAIR", "DEX pair allowlist contains duplicates");
    normalized = { ...value, allowedPairs: Object.freeze(pairs) };
  } else {
    assertQos(value.tokenScope === "any-solana-token", "INVALID_DEX_TOKEN_SCOPE", "DEX token scope must allow any verified Solana token mint");
    const maxInputAmount = parseUnsigned(value.maxInputAmount, 64, "dexTrading.maxInputAmount");
    const dailyInputLimit = parseUnsigned(value.dailyInputLimit, 64, "dexTrading.dailyInputLimit");
    assertQos(maxInputAmount > 0n && dailyInputLimit >= maxInputAmount, "INVALID_DEX_LIMIT", "DEX daily input limit must be at least the maximum input per swap");
    normalized = { ...value };
  }
  assertQos(Number.isInteger(value.maxSlippageBps) && value.maxSlippageBps >= 1 && value.maxSlippageBps <= 1_000, "INVALID_DEX_SLIPPAGE", "DEX slippage cap must be between 1 and 1000 basis points");
  assertQos(Number.isInteger(value.maxRouteFeeBps) && value.maxRouteFeeBps >= 0 && value.maxRouteFeeBps <= 500, "INVALID_DEX_ROUTE_FEE", "DEX route fee cap must be between 0 and 500 basis points");
  const maxFeeLamports = parseUnsigned(value.maxFeeLamports, 64, "dexTrading.maxFeeLamports");
  assertQos(maxFeeLamports >= 5_000n && maxFeeLamports <= 10_000_000n, "INVALID_DEX_NETWORK_FEE", "DEX network and rent fee cap must be between 5000 and 10000000 lamports");
  assertQos(Number.isInteger(value.minIntervalSeconds) && value.minIntervalSeconds >= 5 && value.minIntervalSeconds <= 86_400, "INVALID_DEX_INTERVAL", "DEX minimum interval must be between 5 seconds and one day");
  assertQos(Number.isInteger(value.maxSwapsPerDay) && value.maxSwapsPerDay >= 1 && value.maxSwapsPerDay <= 1_000, "INVALID_DEX_DAILY_COUNT", "DEX daily swap count must be between 1 and 1000");
  return Object.freeze(normalized);
}

export function parseUnsigned(text, bits, field) {
  assertQos(typeof text === "string" && /^(0|[1-9][0-9]*)$/.test(text), "INVALID_INTEGER", `${field} must be a canonical unsigned decimal string`);
  const value = BigInt(text);
  assertQos(value < (1n << BigInt(bits)), "INTEGER_OUT_OF_RANGE", `${field} does not fit in u${bits}`);
  return value;
}

function validateRpcUrl(rpcUrl) {
  assertQos(typeof rpcUrl === "string" && rpcUrl.length <= 2048, "INVALID_RPC_URL", "rpcUrl is not a valid URL");
  let url;
  try {
    url = new URL(rpcUrl);
  } catch {
    assertQos(false, "INVALID_RPC_URL", "rpcUrl is not a valid URL");
  }
  // Node preserves brackets in URL.hostname for IPv6 literals.
  const local = url.hostname === "127.0.0.1"
    || url.hostname === "::1"
    || url.hostname === "[::1]";
  assertQos(url.protocol === "https:" || (local && url.protocol === "http:"), "INSECURE_RPC_URL", "RPC must use HTTPS unless it is loopback");
  assertQos(!url.username && !url.password, "RPC_CREDENTIALS_IN_URL", "Do not put credentials in rpcUrl");
  assertQos(url.hash === "", "INVALID_RPC_URL", "rpcUrl must not contain a fragment");
}

export function parseRpcSlot(value, field = "currentSlot") {
  assertQos(Number.isSafeInteger(value) && value >= 0, "RPC_INVALID_SLOT", `${field} must be a non-negative safe integer`);
  return BigInt(value);
}

export function validatePolicy(policy) {
  if (policy?.version === 2 && hasExactKeys(policy, LEGACY_POLICY_KEYS)) policy = { ...policy, version: 3, dexTrading: null };
  assertQos(hasExactKeys(policy, POLICY_KEYS), "INVALID_POLICY_SHAPE", "Policy has missing or unknown fields");
  assertQos(policy.version === 3, "UNSUPPORTED_POLICY", "Only policy version 3 is supported");
  const genesisByCluster = { devnet: DEVNET_GENESIS_HASH, "mainnet-beta": MAINNET_GENESIS_HASH };
  assertQos(Object.hasOwn(genesisByCluster, policy.cluster), "UNSUPPORTED_CLUSTER", "Policy cluster must be devnet or mainnet-beta");
  assertQos(policy.clusterGenesis === genesisByCluster[policy.cluster], "WRONG_CLUSTER_POLICY", "Policy genesis hash does not match its Solana cluster");
  assertQos(policy.venueId === VENUE_ID && policy.marketId === MARKET_ID, "UNSUPPORTED_TEMPLATE", "Policy transaction template is not supported");
  assertQos(policy.inputMint === WRAPPED_SOL_MINT && policy.outputMint === WRAPPED_SOL_MINT, "UNSUPPORTED_MINT", "Native transfer fields must use wrapped SOL as the typed asset identifier");
  if (policy.tokenTransfer !== null) {
    assertQos(policy.cluster === "mainnet-beta", "TOKEN_CLUSTER_MISMATCH", "The pinned qOS token is only enabled on mainnet-beta");
    assertQos(hasExactKeys(policy.tokenTransfer, TOKEN_POLICY_KEYS), "INVALID_TOKEN_POLICY_SHAPE", "tokenTransfer has missing or unknown fields");
    assertQos(policy.tokenTransfer.mint === QOS_TOKEN_MINT, "UNSUPPORTED_MINT", "This build only supports the pinned qOS token mint");
    assertQos(policy.tokenTransfer.tokenProgram === TOKEN_2022_PROGRAM_ID, "UNSUPPORTED_TOKEN_PROGRAM", "The pinned qOS mint requires the Token-2022 program");
    decodeBase58(policy.tokenTransfer.mint, 32);
    assertQos(policy.tokenTransfer.decimals === QOS_TOKEN_DECIMALS, "INVALID_TOKEN_DECIMALS", "The pinned qOS mint must use six decimals");
    parseUnsigned(policy.tokenTransfer.maxTransferAmount, 64, "policy.tokenTransfer.maxTransferAmount");
    assertQos(Array.isArray(policy.tokenTransfer.allowedMintExtensions), "INVALID_MINT_EXTENSIONS", "allowedMintExtensions must be an array");
    for (const extension of policy.tokenTransfer.allowedMintExtensions) {
      assertQos(Number.isInteger(extension) && extension >= 0 && extension <= 0xffff, "INVALID_MINT_EXTENSIONS", "Mint extension identifiers must fit in u16");
    }
    const canonicalExtensions = [...new Set(policy.tokenTransfer.allowedMintExtensions)].sort((left, right) => left - right);
    assertQos(canonicalExtensions.length === policy.tokenTransfer.allowedMintExtensions.length && canonicalExtensions.every((value, index) => value === policy.tokenTransfer.allowedMintExtensions[index]), "INVALID_MINT_EXTENSIONS", "Mint extension identifiers must be sorted and unique");
    assertQos(
      canonicalExtensions.length === QOS_TOKEN_MINT_EXTENSIONS.length
        && canonicalExtensions.every((value, index) => value === QOS_TOKEN_MINT_EXTENSIONS[index]),
      "INVALID_MINT_EXTENSIONS",
      "The pinned qOS mint must use only metadata-pointer and token-metadata extensions",
    );
  }
  policy.dexTrading = validateDexTradingPolicy(policy.dexTrading);
  validateRpcUrl(policy.rpcUrl);
  assertQos(Array.isArray(policy.allowedDestinations) && policy.allowedDestinations.length > 0, "EMPTY_DESTINATION_ALLOWLIST", "Policy must allow at least one destination");
  assertQos(policy.allowedDestinations.length <= 64, "DESTINATION_ALLOWLIST_TOO_LARGE", "Policy may allow at most 64 destinations");
  for (const address of policy.allowedDestinations) decodeBase58(address, 32);
  assertQos(new Set(policy.allowedDestinations).size === policy.allowedDestinations.length, "DUPLICATE_DESTINATION", "Destination allowlist contains duplicates");
  assertQos(Array.isArray(policy.allowedStrategyIds) && policy.allowedStrategyIds.length > 0, "EMPTY_STRATEGY_ALLOWLIST", "Policy must allow at least one strategy ID");
  assertQos(policy.allowedStrategyIds.length <= 64, "STRATEGY_ALLOWLIST_TOO_LARGE", "Policy may allow at most 64 strategy IDs");
  for (const id of policy.allowedStrategyIds) {
    assertQos(Number.isInteger(id) && id >= 0 && id <= 0xffffffff, "INVALID_STRATEGY_ID", "Strategy IDs must be u32 integers");
  }
  parseUnsigned(policy.maxTransferLamports, 64, "policy.maxTransferLamports");
  parseUnsigned(policy.maxFeeLamports, 64, "policy.maxFeeLamports");
  parseUnsigned(policy.maxComputeUnitPrice, 64, "policy.maxComputeUnitPrice");
  parseUnsigned(policy.maxRelayTipLamports, 64, "policy.maxRelayTipLamports");
  assertQos(Number.isInteger(policy.maxIntentTtlSlots) && policy.maxIntentTtlSlots >= 1 && policy.maxIntentTtlSlots <= 300, "INVALID_TTL", "maxIntentTtlSlots must be between 1 and 300");
  assertQos(Number.isInteger(policy.maxRequestsPerMinute) && policy.maxRequestsPerMinute >= 1 && policy.maxRequestsPerMinute <= 120, "INVALID_RATE_LIMIT", "maxRequestsPerMinute must be between 1 and 120");
  assertQos(["confirmed", "finalized"].includes(policy.commitment), "INVALID_COMMITMENT", "Commitment must be confirmed or finalized");
  for (const key of ["rpcTimeoutMs", "confirmationTimeoutMs"]) {
    assertQos(Number.isInteger(policy[key]) && policy[key] >= 1000 && policy[key] <= 300000, "INVALID_TIMEOUT", `${key} is outside the safe range`);
  }
  Object.freeze(policy.allowedDestinations);
  Object.freeze(policy.allowedStrategyIds);
  if (policy.tokenTransfer !== null) {
    Object.freeze(policy.tokenTransfer.allowedMintExtensions);
    Object.freeze(policy.tokenTransfer);
  }
  if (policy.dexTrading !== null) Object.freeze(policy.dexTrading);
  return Object.freeze(policy);
}

export function loadPolicy(path, rpcOverride = undefined) {
  const bytes = readSecureFile(path, {
    maxBytes: 256 * 1024,
    errorCode: "INSECURE_POLICY_FILE",
    label: "Policy file",
  });
  let policy;
  try {
    policy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
  }
  if (rpcOverride !== undefined) policy.rpcUrl = rpcOverride;
  return validatePolicy(policy);
}

export function validateIntent(intent, policy, currentSlot) {
  assertQos(intent && typeof intent === "object" && !Array.isArray(intent), "INVALID_INTENT_SHAPE", "Intent must be an object");
  if (intent.version === 1) return validateNativeIntent(intent, policy, currentSlot);
  if (intent.version === 2) return validateTokenIntent(intent, policy, currentSlot);
  if (intent.version === 3) return validateCloudSettlementIntent(intent, policy, currentSlot);
  if (intent.version === 4) return validateCloudWithdrawalIntent(intent, policy, currentSlot);
  assertQos(false, "UNSUPPORTED_INTENT", "Only native, token-transfer, qOS Cloud settlement, and qOS Cloud withdrawal intents are supported");
}

function validateCommonIntent(intent, policy, currentSlot, expectedSide = "SEND") {
  const nonce = parseUnsigned(intent.requestNonce, 128, "requestNonce");
  assertQos(nonce > 0n, "INVALID_NONCE", "requestNonce must be greater than zero");
  assertQos(intent.clusterGenesis === policy.clusterGenesis, "WRONG_CLUSTER", "Intent is not pinned to the configured cluster");
  assertQos(intent.venueId === policy.venueId && intent.marketId === policy.marketId, "VENUE_NOT_ALLOWED", "Venue or market is not allowlisted");
  assertQos(intent.side === expectedSide, "SIDE_NOT_ALLOWED", `Intent side must be ${expectedSide}`);
  const maxFee = parseUnsigned(intent.maxFeeLamports, 64, "maxFeeLamports");
  assertQos(maxFee <= parseUnsigned(policy.maxFeeLamports, 64, "policy.maxFeeLamports"), "FEE_LIMIT_EXCEEDED", "Requested fee cap exceeds policy");
  assertQos(parseUnsigned(intent.maxCuPrice, 64, "maxCuPrice") <= parseUnsigned(policy.maxComputeUnitPrice, 64, "policy.maxComputeUnitPrice"), "CU_PRICE_LIMIT_EXCEEDED", "Compute-unit price exceeds policy");
  assertQos(parseUnsigned(intent.maxRelayTip, 64, "maxRelayTip") <= parseUnsigned(policy.maxRelayTipLamports, 64, "policy.maxRelayTipLamports"), "TIP_LIMIT_EXCEEDED", "Relay tip exceeds policy");
  decodeBase58(intent.destination, 32);
  assertQos(policy.allowedDestinations.includes(intent.destination), "DESTINATION_NOT_ALLOWED", "Destination is not allowlisted");
  decodeBase58(intent.recentBlockhash, 32);
  const expiresAtSlot = parseUnsigned(intent.expiresAtSlot, 64, "expiresAtSlot");
  const now = parseRpcSlot(currentSlot);
  assertQos(expiresAtSlot > now, "INTENT_EXPIRED", "Intent has expired");
  assertQos(expiresAtSlot <= now + BigInt(policy.maxIntentTtlSlots), "INTENT_TTL_EXCEEDED", "Intent expiry exceeds policy TTL");
  assertQos(Number.isInteger(intent.strategyId) && policy.allowedStrategyIds.includes(intent.strategyId), "STRATEGY_NOT_ALLOWED", "Strategy is not allowlisted");
  assertQos(intent.operatorApproval === null, "UNSUPPORTED_APPROVAL", "Operator approval tokens are not implemented in the sandbox signer");
  return { nonce, maxFee, expiresAtSlot };
}

function validateNativeIntent(intent, policy, currentSlot) {
  assertQos(hasExactKeys(intent, INTENT_KEYS), "INVALID_INTENT_SHAPE", "Native intent has missing or unknown fields");
  const common = validateCommonIntent(intent, policy, currentSlot);
  assertQos(intent.inputMint === policy.inputMint && intent.outputMint === policy.outputMint, "MINT_NOT_ALLOWED", "Native asset identifier is not allowlisted");
  const amount = parseUnsigned(intent.inputAmount, 64, "inputAmount");
  const minimumOutput = parseUnsigned(intent.minimumOutput, 64, "minimumOutput");
  assertQos(amount > 0n, "ZERO_AMOUNT", "Transfer amount must be greater than zero");
  assertQos(amount === minimumOutput, "INVALID_MINIMUM_OUTPUT", "Native transfer minimumOutput must equal inputAmount");
  assertQos(amount <= parseUnsigned(policy.maxTransferLamports, 64, "policy.maxTransferLamports"), "AMOUNT_LIMIT_EXCEEDED", "Native transfer exceeds the policy amount limit");
  return { ...common, kind: "native", amount };
}

function validateTokenIntent(intent, policy, currentSlot) {
  assertQos(hasExactKeys(intent, TOKEN_INTENT_KEYS), "INVALID_INTENT_SHAPE", "Token intent has missing or unknown fields");
  assertQos(policy.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "Policy does not enable token transfers");
  const common = validateCommonIntent(intent, policy, currentSlot);
  const token = policy.tokenTransfer;
  assertQos(intent.mint === token.mint && intent.tokenProgram === token.tokenProgram && intent.decimals === token.decimals, "MINT_NOT_ALLOWED", "Token mint, program, or decimals do not match policy");
  decodeBase58(intent.mint, 32);
  decodeBase58(intent.tokenProgram, 32);
  decodeBase58(intent.sourceTokenAccount, 32);
  decodeBase58(intent.destinationTokenAccount, 32);
  assertQos(intent.sourceTokenAccount !== intent.destinationTokenAccount, "DUPLICATE_TOKEN_ACCOUNT", "Source and destination token accounts must differ");
  const amount = parseUnsigned(intent.amount, 64, "amount");
  assertQos(amount > 0n, "ZERO_AMOUNT", "Token transfer amount must be greater than zero");
  assertQos(amount <= parseUnsigned(token.maxTransferAmount, 64, "policy.tokenTransfer.maxTransferAmount"), "AMOUNT_LIMIT_EXCEEDED", "Token transfer exceeds the policy amount limit");
  return { ...common, kind: "token", amount };
}

function validateCloudSettlementIntent(intent, policy, currentSlot) {
  assertQos(hasExactKeys(intent, CLOUD_SETTLEMENT_INTENT_KEYS), "INVALID_INTENT_SHAPE", "Cloud settlement intent has missing or unknown fields");
  assertQos(policy.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "Policy does not enable qOS settlement");
  const common = validateCommonIntent(intent, policy, currentSlot, "SETTLE");
  const token = policy.tokenTransfer;
  assertQos(intent.mint === token.mint && intent.tokenProgram === token.tokenProgram && intent.decimals === token.decimals, "MINT_NOT_ALLOWED", "Settlement mint, program, or decimals do not match policy");
  assertQos(intent.burnBasisPoints === 100, "CLOUD_BURN_POLICY_CHANGED", "Cloud settlement must burn exactly one percent cumulatively");
  decodeBase58(intent.mint, 32);
  decodeBase58(intent.tokenProgram, 32);
  decodeBase58(intent.sourceTokenAccount, 32);
  decodeBase58(intent.destinationTokenAccount, 32);
  assertQos(intent.sourceTokenAccount !== intent.destinationTokenAccount, "DUPLICATE_TOKEN_ACCOUNT", "Settlement source and destination token accounts must differ");
  const grossAmount = parseUnsigned(intent.grossAmount, 64, "grossAmount");
  const treasuryAmount = parseUnsigned(intent.treasuryAmount, 64, "treasuryAmount");
  const burnAmount = parseUnsigned(intent.burnAmount, 64, "burnAmount");
  const remainderBefore = parseUnsigned(intent.burnRemainderBefore, 7, "burnRemainderBefore");
  const remainderAfter = parseUnsigned(intent.burnRemainderAfter, 7, "burnRemainderAfter");
  assertQos(grossAmount > 0n && grossAmount <= parseUnsigned(token.maxTransferAmount, 64, "policy.tokenTransfer.maxTransferAmount"), "AMOUNT_LIMIT_EXCEEDED", "Cloud settlement exceeds the policy amount limit");
  assertQos(remainderBefore < 100n && remainderAfter < 100n, "CLOUD_BURN_REMAINDER_INVALID", "Cloud burn remainder must be between 0 and 99 base units");
  const burnNumerator = remainderBefore + grossAmount;
  assertQos(burnAmount === burnNumerator / 100n && remainderAfter === burnNumerator % 100n, "CLOUD_BURN_POLICY_CHANGED", "Cloud burn amount does not equal the cumulative one-percent policy");
  assertQos(treasuryAmount + burnAmount === grossAmount, "CLOUD_SETTLEMENT_SPLIT_INVALID", "Cloud treasury and burn amounts must equal the gross charge");
  return { ...common, kind: "cloud-settlement", amount: grossAmount, grossAmount, treasuryAmount, burnAmount, remainderBefore, remainderAfter };
}

function validateCloudWithdrawalIntent(intent, policy, currentSlot) {
  assertQos(hasExactKeys(intent, CLOUD_WITHDRAWAL_INTENT_KEYS), "INVALID_INTENT_SHAPE", "Cloud withdrawal intent has missing or unknown fields");
  const common = validateCommonIntent(intent, policy, currentSlot, "WITHDRAW");
  decodeBase58(intent.treasury, 32);
  assertQos(policy.allowedDestinations.includes(intent.treasury), "DESTINATION_NOT_ALLOWED", "Withdrawal fee treasury is not allowlisted");
  assertQos(intent.destination !== intent.treasury || intent.destinationAmount !== "0", "ZERO_AMOUNT", "Withdrawal destination amount must be positive");
  const grossAmount = parseUnsigned(intent.grossAmount, 64, "grossAmount");
  const destinationAmount = parseUnsigned(intent.destinationAmount, 64, "destinationAmount");
  const feeAmount = parseUnsigned(intent.feeAmount, 64, "feeAmount");
  const remainderBefore = parseUnsigned(intent.feeRemainderBefore, 14, "feeRemainderBefore");
  const remainderAfter = parseUnsigned(intent.feeRemainderAfter, 14, "feeRemainderAfter");
  assertQos(grossAmount > 0n, "ZERO_AMOUNT", "Cloud withdrawal amount must be greater than zero");
  assertQos(intent.feeBasisPoints === 25, "CLOUD_WITHDRAWAL_FEE_CHANGED", "Cloud withdrawal fee must be exactly 0.25 percent cumulatively");
  assertQos(remainderBefore < 10_000n && remainderAfter < 10_000n, "CLOUD_WITHDRAWAL_FEE_REMAINDER_INVALID", "Cloud withdrawal fee remainder must be below ten thousand");
  const feeNumerator = remainderBefore + grossAmount * 25n;
  assertQos(feeAmount === feeNumerator / 10_000n && remainderAfter === feeNumerator % 10_000n, "CLOUD_WITHDRAWAL_FEE_CHANGED", "Cloud withdrawal fee does not match the cumulative 0.25-percent policy");
  assertQos(destinationAmount + feeAmount === grossAmount, "CLOUD_WITHDRAWAL_SPLIT_INVALID", "Withdrawal destination and fee amounts must equal the gross amount");

  assertQos(intent.assetKind === "sol" || intent.assetKind === "token", "CLOUD_WITHDRAWAL_ASSET_INVALID", "Cloud withdrawal asset kind is invalid");
  if (intent.assetKind === "sol") {
    assertQos(intent.mint === null && intent.tokenProgram === null && intent.sourceTokenAccount === null
      && intent.destinationTokenAccount === null && intent.treasuryTokenAccount === null && intent.decimals === null,
    "CLOUD_WITHDRAWAL_ASSET_INVALID", "Native SOL withdrawal must not include token fields");
    assertQos(intent.createDestinationTokenAccount === false && intent.createTreasuryTokenAccount === false, "CLOUD_WITHDRAWAL_ASSET_INVALID", "Native SOL withdrawal cannot create token accounts");
  } else {
    decodeBase58(intent.mint, 32);
    decodeBase58(intent.tokenProgram, 32);
    decodeBase58(intent.sourceTokenAccount, 32);
    decodeBase58(intent.destinationTokenAccount, 32);
    decodeBase58(intent.treasuryTokenAccount, 32);
    assertQos(intent.tokenProgram === TOKEN_PROGRAM_ID || intent.tokenProgram === TOKEN_2022_PROGRAM_ID, "UNSUPPORTED_TOKEN_PROGRAM", "Cloud withdrawal supports only Token and Token-2022 assets");
    assertQos(Number.isInteger(intent.decimals) && intent.decimals >= 0 && intent.decimals <= 255, "INVALID_TOKEN_DECIMALS", "Withdrawal token decimals must fit in u8");
    assertQos(intent.sourceTokenAccount !== intent.destinationTokenAccount && intent.sourceTokenAccount !== intent.treasuryTokenAccount, "DUPLICATE_TOKEN_ACCOUNT", "Withdrawal source token account must differ from its destinations");
    assertQos(typeof intent.createDestinationTokenAccount === "boolean" && typeof intent.createTreasuryTokenAccount === "boolean", "CLOUD_WITHDRAWAL_ASSET_INVALID", "Withdrawal token-account creation flags are invalid");
  }
  return {
    ...common,
    kind: "cloud-withdrawal",
    amount: grossAmount,
    grossAmount,
    destinationAmount,
    feeAmount,
    remainderBefore,
    remainderAfter,
  };
}
