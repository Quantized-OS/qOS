// Stable host-integration boundary for services that operate qOS profiles.
// Managed services live in separate repositories and depend on this versioned
// interface instead of importing qOS internals by filesystem path.

import { assertQos } from "./errors.js";

export const QOS_PLATFORM_SDK_VERSION = 1;
export const QOS_CLOUD_HOST_CONTRACT_VERSION = 3;

export function assertCloudLiveTransactions(enabled) {
  assertQos(enabled === true, "CLOUD_LIVE_TRANSACTIONS_DISABLED", "Managed qOS Cloud requires live mainnet transactions and does not support simulated-success execution");
  return Object.freeze({
    version: QOS_CLOUD_HOST_CONTRACT_VERSION,
    liveTransactions: true,
    simulatedSuccessSupported: false,
  });
}

export { getAgent, onboardAgent, readAgentSkillPack } from "./agent-registry.js";
export { decodeBase58 } from "./base58.js";
export { QOS_TOKEN_MINT } from "./constants.js";
export { configureDexTrading, JUPITER_SWAP_ENDPOINT, RAYDIUM_SWAP_ENDPOINT, publicDexTrading } from "./dex.js";
export { DEXSCREENER_ORIGIN, marketDataSources, searchSolanaMarkets, solanaTokenMarkets } from "./market-data.js";
export { assertQos, publicError, QosError } from "./errors.js";
export { publicKeyAddress, publicKeyObjectFromRaw } from "./key-store.js";
export { modelProviderCatalog } from "./model-provider.js";
export { configureModelProvider } from "./model-registry.js";
export { changePolicyDestination, setPolicyField } from "./policy-store.js";
export { readPrivateJson, writePrivateJsonAtomic } from "./private-json.js";
export { ensureRuntimeProfile } from "./runtime-profile.js";
export { readSecureFile } from "./secure-file.js";
export { buildSkillZip } from "./skill-bundle.js";
export { initializeSandbox, QosService } from "./service.js";
