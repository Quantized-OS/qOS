import { readFileSync } from "node:fs";
import { decodeBase58 } from "./base58.js";
import { hasExactKeys } from "./canonical.js";
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  MARKET_ID,
  QOS_TOKEN_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  VENUE_ID,
  WRAPPED_SOL_MINT,
} from "./constants.js";
import { assertQos } from "./errors.js";

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

const TOKEN_POLICY_KEYS = [
  "mint",
  "tokenProgram",
  "decimals",
  "maxTransferAmount",
  "allowedMintExtensions",
];

export function parseUnsigned(text, bits, field) {
  assertQos(typeof text === "string" && /^(0|[1-9][0-9]*)$/.test(text), "INVALID_INTEGER", `${field} must be a canonical unsigned decimal string`);
  const value = BigInt(text);
  assertQos(value < (1n << BigInt(bits)), "INTEGER_OUT_OF_RANGE", `${field} does not fit in u${bits}`);
  return value;
}

function validateRpcUrl(rpcUrl) {
  let url;
  try {
    url = new URL(rpcUrl);
  } catch {
    assertQos(false, "INVALID_RPC_URL", "rpcUrl is not a valid URL");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  assertQos(url.protocol === "https:" || (local && url.protocol === "http:"), "INSECURE_RPC_URL", "RPC must use HTTPS unless it is loopback");
  assertQos(!url.username && !url.password, "RPC_CREDENTIALS_IN_URL", "Do not put credentials in rpcUrl");
}

export function validatePolicy(policy) {
  assertQos(hasExactKeys(policy, POLICY_KEYS), "INVALID_POLICY_SHAPE", "Policy has missing or unknown fields");
  assertQos(policy.version === 2, "UNSUPPORTED_POLICY", "Only policy version 2 is supported");
  const genesisByCluster = { devnet: DEVNET_GENESIS_HASH, "mainnet-beta": MAINNET_GENESIS_HASH };
  assertQos(Object.hasOwn(genesisByCluster, policy.cluster), "UNSUPPORTED_CLUSTER", "Policy cluster must be devnet or mainnet-beta");
  assertQos(policy.clusterGenesis === genesisByCluster[policy.cluster], "WRONG_CLUSTER_POLICY", "Policy genesis hash does not match its Solana cluster");
  assertQos(policy.venueId === VENUE_ID && policy.marketId === MARKET_ID, "UNSUPPORTED_TEMPLATE", "Policy transaction template is not supported");
  assertQos(policy.inputMint === WRAPPED_SOL_MINT && policy.outputMint === WRAPPED_SOL_MINT, "UNSUPPORTED_MINT", "Native transfer fields must use wrapped SOL as the typed asset identifier");
  if (policy.tokenTransfer !== null) {
    assertQos(policy.cluster === "mainnet-beta", "TOKEN_CLUSTER_MISMATCH", "The pinned qOS token is only enabled on mainnet-beta");
    assertQos(hasExactKeys(policy.tokenTransfer, TOKEN_POLICY_KEYS), "INVALID_TOKEN_POLICY_SHAPE", "tokenTransfer has missing or unknown fields");
    assertQos(policy.tokenTransfer.mint === QOS_TOKEN_MINT, "UNSUPPORTED_MINT", "This build only supports the pinned qOS token mint");
    assertQos(policy.tokenTransfer.tokenProgram === TOKEN_PROGRAM_ID || policy.tokenTransfer.tokenProgram === TOKEN_2022_PROGRAM_ID, "UNSUPPORTED_TOKEN_PROGRAM", "Token policy must pin the Token or Token-2022 program");
    decodeBase58(policy.tokenTransfer.mint, 32);
    assertQos(Number.isInteger(policy.tokenTransfer.decimals) && policy.tokenTransfer.decimals >= 0 && policy.tokenTransfer.decimals <= 255, "INVALID_TOKEN_DECIMALS", "Token decimals must fit in u8");
    parseUnsigned(policy.tokenTransfer.maxTransferAmount, 64, "policy.tokenTransfer.maxTransferAmount");
    assertQos(Array.isArray(policy.tokenTransfer.allowedMintExtensions), "INVALID_MINT_EXTENSIONS", "allowedMintExtensions must be an array");
    for (const extension of policy.tokenTransfer.allowedMintExtensions) {
      assertQos(Number.isInteger(extension) && extension >= 0 && extension <= 0xffff, "INVALID_MINT_EXTENSIONS", "Mint extension identifiers must fit in u16");
    }
    const canonicalExtensions = [...new Set(policy.tokenTransfer.allowedMintExtensions)].sort((left, right) => left - right);
    assertQos(canonicalExtensions.length === policy.tokenTransfer.allowedMintExtensions.length && canonicalExtensions.every((value, index) => value === policy.tokenTransfer.allowedMintExtensions[index]), "INVALID_MINT_EXTENSIONS", "Mint extension identifiers must be sorted and unique");
  }
  validateRpcUrl(policy.rpcUrl);
  assertQos(Array.isArray(policy.allowedDestinations) && policy.allowedDestinations.length > 0, "EMPTY_DESTINATION_ALLOWLIST", "Policy must allow at least one destination");
  for (const address of policy.allowedDestinations) decodeBase58(address, 32);
  assertQos(new Set(policy.allowedDestinations).size === policy.allowedDestinations.length, "DUPLICATE_DESTINATION", "Destination allowlist contains duplicates");
  assertQos(Array.isArray(policy.allowedStrategyIds) && policy.allowedStrategyIds.length > 0, "EMPTY_STRATEGY_ALLOWLIST", "Policy must allow at least one strategy ID");
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
  return Object.freeze(policy);
}

export function loadPolicy(path, rpcOverride = undefined) {
  const policy = JSON.parse(readFileSync(path, "utf8"));
  if (rpcOverride !== undefined) policy.rpcUrl = rpcOverride;
  return validatePolicy(policy);
}

export function validateIntent(intent, policy, currentSlot) {
  assertQos(intent && typeof intent === "object" && !Array.isArray(intent), "INVALID_INTENT_SHAPE", "Intent must be an object");
  if (intent.version === 1) return validateNativeIntent(intent, policy, currentSlot);
  if (intent.version === 2) return validateTokenIntent(intent, policy, currentSlot);
  assertQos(false, "UNSUPPORTED_INTENT", "Only native OrderIntentV1 and TokenTransferIntentV2 are supported");
}

function validateCommonIntent(intent, policy, currentSlot) {
  const nonce = parseUnsigned(intent.requestNonce, 128, "requestNonce");
  assertQos(nonce > 0n, "INVALID_NONCE", "requestNonce must be greater than zero");
  assertQos(intent.clusterGenesis === policy.clusterGenesis, "WRONG_CLUSTER", "Intent is not pinned to the configured cluster");
  assertQos(intent.venueId === policy.venueId && intent.marketId === policy.marketId, "VENUE_NOT_ALLOWED", "Venue or market is not allowlisted");
  assertQos(intent.side === "SEND", "SIDE_NOT_ALLOWED", "Transfer side must be SEND");
  const maxFee = parseUnsigned(intent.maxFeeLamports, 64, "maxFeeLamports");
  assertQos(maxFee <= parseUnsigned(policy.maxFeeLamports, 64, "policy.maxFeeLamports"), "FEE_LIMIT_EXCEEDED", "Requested fee cap exceeds policy");
  assertQos(parseUnsigned(intent.maxCuPrice, 64, "maxCuPrice") <= parseUnsigned(policy.maxComputeUnitPrice, 64, "policy.maxComputeUnitPrice"), "CU_PRICE_LIMIT_EXCEEDED", "Compute-unit price exceeds policy");
  assertQos(parseUnsigned(intent.maxRelayTip, 64, "maxRelayTip") <= parseUnsigned(policy.maxRelayTipLamports, 64, "policy.maxRelayTipLamports"), "TIP_LIMIT_EXCEEDED", "Relay tip exceeds policy");
  decodeBase58(intent.destination, 32);
  assertQos(policy.allowedDestinations.includes(intent.destination), "DESTINATION_NOT_ALLOWED", "Destination is not allowlisted");
  decodeBase58(intent.recentBlockhash, 32);
  const expiresAtSlot = parseUnsigned(intent.expiresAtSlot, 64, "expiresAtSlot");
  const now = BigInt(currentSlot);
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
