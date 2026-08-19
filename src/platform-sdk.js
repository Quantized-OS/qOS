// Stable host-integration boundary for services that operate qOS profiles.
// Managed services live in separate repositories and depend on this versioned
// interface instead of importing qOS internals by filesystem path.

export const QOS_PLATFORM_SDK_VERSION = 1;

export { getAgent, onboardAgent } from "./agent-registry.js";
export { decodeBase58 } from "./base58.js";
export { QOS_TOKEN_MINT } from "./constants.js";
export { configureDexTrading, JUPITER_SWAP_ENDPOINT, publicDexTrading } from "./dex.js";
export { assertQos, publicError, QosError } from "./errors.js";
export { publicKeyAddress, publicKeyObjectFromRaw } from "./key-store.js";
export { modelProviderCatalog } from "./model-provider.js";
export { configureModelProvider } from "./model-registry.js";
export { changePolicyDestination } from "./policy-store.js";
export { readPrivateJson, writePrivateJsonAtomic } from "./private-json.js";
export { ensureRuntimeProfile } from "./runtime-profile.js";
export { readSecureFile } from "./secure-file.js";
export { initializeSandbox, QosService } from "./service.js";
