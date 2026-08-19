import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { hasExactKeys } from "./canonical.js";
import { validateDexAction } from "./dex.js";
import { assertQos, QosError } from "./errors.js";
import { loadPolicy, parseUnsigned } from "./policy.js";
import { readPrivateJson, writePrivateJsonAtomic } from "./private-json.js";
import { loadRuntimeProfile } from "./runtime-profile.js";
import { assertPrivateDirectory, readSecureFile } from "./secure-file.js";

const REGISTRY_KEYS = ["version", "agents"];
const AGENT_V1_KEYS = [
  "version",
  "id",
  "name",
  "enabled",
  "approvalMode",
  "asset",
  "maxAmount",
  "destination",
  "strategyId",
  "tokenSha256",
];
const AGENT_KEYS = [...AGENT_V1_KEYS, "dexTrading"];
const SKILL_FILES = ["SKILL.md", "capabilities.md", "transfer.md", "swap.md", "mcp.md", "approval.md", "manifest.json"];
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function agentPaths(home, id = undefined) {
  const resolvedHome = resolve(home);
  const agents = join(resolvedHome, "agents");
  return {
    home: resolvedHome,
    agents,
    registry: join(agents, "registry.json"),
    ...(id === undefined ? {} : {
      agent: join(agents, id),
      token: join(agents, id, "token"),
      skills: join(agents, id, "skills"),
    }),
  };
}

function ensureAgentsDirectory(home) {
  const paths = agentPaths(home);
  assertPrivateDirectory(paths.home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS profile home" });
  if (!existsSync(paths.agents)) {
    mkdirSync(paths.agents, { mode: 0o700 });
    chmodSync(paths.agents, 0o700);
  }
  assertPrivateDirectory(paths.agents, { errorCode: "INSECURE_AGENT_DIRECTORY", label: "Agent registry directory" });
  return paths;
}

function validateAgentRecord(record) {
  assertQos(record && typeof record === "object" && !Array.isArray(record), "INVALID_AGENT_REGISTRY", "Agent record has missing or unknown fields");
  if (record.version === 1 && hasExactKeys(record, AGENT_V1_KEYS)) record = { ...record, version: 2, dexTrading: false };
  assertQos(hasExactKeys(record, AGENT_KEYS), "INVALID_AGENT_REGISTRY", "Agent record has missing or unknown fields");
  assertQos(record.version === 2, "INVALID_AGENT_REGISTRY", "Agent record version is unsupported");
  assertQos(typeof record.id === "string" && AGENT_ID.test(record.id), "INVALID_AGENT_ID", "Agent ID must start with a lowercase letter and contain only lowercase letters, digits, or hyphens");
  assertQos(typeof record.name === "string" && record.name.length >= 1 && record.name.length <= 80 && !/[\x00-\x1f\x7f]/u.test(record.name), "INVALID_AGENT_NAME", "Agent name must contain 1 to 80 printable characters");
  assertQos(record.enabled === true, "INVALID_AGENT_REGISTRY", "Stored agents must be enabled");
  assertQos(record.approvalMode === "ask" || record.approvalMode === "auto", "INVALID_APPROVAL_MODE", "Approval mode must be ask or auto");
  assertQos(record.asset === "sol" || record.asset === "qos-token", "INVALID_AGENT_ASSET", "Agent asset must be sol or qos-token");
  assertQos(parseUnsigned(record.maxAmount, 64, "agent.maxAmount") > 0n, "INVALID_AGENT_AMOUNT", "Agent max amount must be greater than zero");
  assertQos(typeof record.destination === "string", "INVALID_AGENT_DESTINATION", "Agent destination is invalid");
  assertQos(Number.isInteger(record.strategyId) && record.strategyId >= 0 && record.strategyId <= 0xffffffff, "INVALID_STRATEGY_ID", "Agent strategy ID must fit in u32");
  assertQos(typeof record.tokenSha256 === "string" && /^[0-9a-f]{64}$/.test(record.tokenSha256), "INVALID_AGENT_REGISTRY", "Agent credential hash is invalid");
  assertQos(typeof record.dexTrading === "boolean", "INVALID_AGENT_REGISTRY", "Agent DEX capability flag is invalid");
  return Object.freeze({ ...record });
}

function validateRegistry(registry) {
  assertQos(registry && typeof registry === "object" && !Array.isArray(registry) && hasExactKeys(registry, REGISTRY_KEYS), "INVALID_AGENT_REGISTRY", "Agent registry has missing or unknown fields");
  assertQos(registry.version === 1 && Array.isArray(registry.agents) && registry.agents.length <= 64, "INVALID_AGENT_REGISTRY", "Agent registry version or size is invalid");
  const agents = registry.agents.map(validateAgentRecord);
  assertQos(new Set(agents.map((agent) => agent.id)).size === agents.length, "INVALID_AGENT_REGISTRY", "Agent registry contains duplicate IDs");
  assertQos(agents.every((agent, index) => index === 0 || agents[index - 1].id < agent.id), "INVALID_AGENT_REGISTRY", "Agent registry must be sorted by ID");
  return Object.freeze({ version: 1, agents: Object.freeze(agents) });
}

export function loadAgentRegistry(home) {
  const paths = agentPaths(home);
  assertPrivateDirectory(paths.home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS profile home" });
  if (!existsSync(paths.agents)) return Object.freeze({ version: 1, agents: Object.freeze([]) });
  assertPrivateDirectory(paths.agents, { errorCode: "INSECURE_AGENT_DIRECTORY", label: "Agent registry directory" });
  if (!existsSync(paths.registry)) return Object.freeze({ version: 1, agents: Object.freeze([]) });
  return validateRegistry(readPrivateJson(paths.registry, {
    errorCode: "INVALID_AGENT_REGISTRY",
    label: "Agent registry",
  }));
}

function publicAgent(home, record) {
  const paths = agentPaths(home, record.id);
  const { tokenSha256: _secretVerifier, ...safe } = record;
  return {
    ...safe,
    tokenFile: paths.token,
    skillsDirectory: paths.skills,
  };
}

function validateAgentRuntimeFiles(home, record) {
  const paths = agentPaths(home, record.id);
  assertPrivateDirectory(paths.agent, { errorCode: "INSECURE_AGENT_DIRECTORY", label: `Agent ${record.id} directory` });
  assertPrivateDirectory(paths.skills, { errorCode: "INSECURE_AGENT_DIRECTORY", label: `Agent ${record.id} skills directory` });
  const token = readSecureFile(paths.token, {
    privateFile: true,
    minBytes: 33,
    maxBytes: 513,
    errorCode: "INSECURE_AGENT_TOKEN",
    label: `Agent ${record.id} token file`,
  });
  try {
    let end = token.length;
    if (token[end - 1] === 0x0a) end -= 1;
    if (end > 0 && token[end - 1] === 0x0d) end -= 1;
    const hash = createHash("sha256").update(token.subarray(0, end)).digest("hex");
    assertQos(hash === record.tokenSha256, "AGENT_TOKEN_MISMATCH", `Agent ${record.id} token does not match the registry`);
  } finally {
    token.fill(0);
  }
  return paths;
}

function ensureScope(policy, { asset, maxAmount, destination, strategyId }) {
  assertQos(policy.allowedDestinations.includes(destination), "AGENT_DESTINATION_FORBIDDEN", "Agent destination must already be allowlisted by the qOS policy");
  assertQos(policy.allowedStrategyIds.includes(strategyId), "AGENT_STRATEGY_FORBIDDEN", "Agent strategy ID must already be allowlisted by the qOS policy");
  const amount = parseUnsigned(maxAmount, 64, "agent.maxAmount");
  assertQos(amount > 0n, "INVALID_AGENT_AMOUNT", "Agent max amount must be greater than zero");
  if (asset === "sol") {
    assertQos(BigInt(policy.maxTransferLamports) > 0n, "AGENT_ASSET_DISABLED", "Native SOL transfers are disabled by this profile");
    assertQos(amount <= BigInt(policy.maxTransferLamports), "AGENT_AMOUNT_LIMIT_EXCEEDED", "Agent SOL limit exceeds the qOS policy limit");
  } else {
    assertQos(asset === "qos-token" && policy.tokenTransfer !== null, "AGENT_ASSET_DISABLED", "The pinned qOS token transfer is disabled by this profile");
    assertQos(amount <= BigInt(policy.tokenTransfer.maxTransferAmount), "AGENT_AMOUNT_LIMIT_EXCEEDED", "Agent token limit exceeds the qOS policy limit");
  }
}

function skillText(record, paths, policy) {
  const action = record.asset === "sol" ? "transfer_sol" : "transfer_qos";
  const dex = record.dexTrading ? policy.dexTrading : null;
  const pairText = dex === null ? "" : dex.allowedPairs.map((pair) => `- ${pair.inputMint} → ${pair.outputMint}: max ${pair.maxInputAmount} gross base units per swap; ${pair.dailyInputLimit} per UTC day`).join("\n");
  return {
    "SKILL.md": `# qOS policy action skill\n\nThe local qOS MCP service starts automatically when this agent is onboarded. This credential may request the fixed transfer \`${action}\`${record.dexTrading ? " and bounded `swap` actions" : ""}. It cannot request arbitrary signatures, programs, mints, destinations, strategies, endpoints, or shell commands.\n\nRead \`capabilities.md\`, \`mcp.md\`, \`transfer.md\`${record.dexTrading ? ", `swap.md`" : ""}, and \`approval.md\` before requesting an action. The bearer credential is stored in \`${paths.token}\`; read it only at request time and never place its contents in a prompt, log, source file, or command history.\n`,
    "capabilities.md": `# Capabilities\n\n- Agent: ${record.name} (${record.id})\n- Network: ${policy.cluster}\n- Asset: ${record.asset}\n- Maximum transfer: ${record.maxAmount} base units\n- Transfer destination: ${record.destination}\n- Strategy ID: ${record.strategyId}\n- Approval mode: ${record.approvalMode}\n- MCP: http://127.0.0.1:8790/mcp\n- REST compatibility API: http://127.0.0.1:8790/v1/actions\n- DEX swaps: ${record.dexTrading ? "enabled through the pinned Jupiter HTTPS endpoint" : "disabled"}${dex === null ? "" : `\n- Swap output receiver: ${dex.receiver ?? "firmware signer"}\n- Maximum slippage: ${dex.maxSlippageBps} bps\n- Maximum route fee: ${dex.maxRouteFeeBps} bps\n- Cooldown: ${dex.minIntervalSeconds} seconds\n- Maximum swaps per UTC day: ${dex.maxSwapsPerDay}\n\nAllowed pairs:\n${pairText}`}\n`,
    "transfer.md": `# Request a transfer\n\nPrefer the MCP tool \`qos_request_transfer\` with exactly one argument: \`{"amount":"BASE_UNITS"}\`. qOS fills in the pinned action \`${action}\`, destination \`${record.destination}\`, and strategy ID ${record.strategyId}.\n\nThe REST compatibility route is \`http://127.0.0.1:8790/v1/actions\` and accepts exactly:\n\n\`\`\`json\n{"version":1,"action":"${action}","amount":"BASE_UNITS","destination":"${record.destination}","strategyId":${record.strategyId}}\n\`\`\`\n\nUse a canonical positive integer no greater than ${record.maxAmount}. qOS rechecks the live policy, cluster, accounts, fee, simulation, signer response, and confirmation.\n`,
    "swap.md": record.dexTrading
      ? `# Request a DEX swap\n\nUse MCP tool \`qos_request_swap\` with exactly \`inputMint\`, \`outputMint\`, and \`amount\`. qOS accepts only the pair and base-unit amount listed in \`capabilities.md\`. It obtains a manual ExactIn Jupiter order, rejects JupiterZ and gasless/co-signer paths, checks route/slippage/network-fee limits, signs only a one-signer v0 transaction, and reserves the authorized gross input against persistent daily limits before delivery. A confirmed response narrows the reservation to the wallet debit; an ambiguous delivery keeps the conservative reservation.\n\nDo not interpret a quote as guaranteed output or profit. Never ask qOS to sign provider-supplied bytes through any other route.\n`
      : "# DEX swaps\n\nDEX swaps are disabled for this agent.\n",
    "mcp.md": `# MCP connection\n\nEndpoint: \`http://127.0.0.1:8790/mcp\`\nTransport: Streamable HTTP POST\nProtocol: \`2026-07-28\` (\`2025-06-18\` compatibility is also accepted)\nAuthentication: Bearer token read from \`${paths.token}\`\n\nFor protocol 2026-07-28, send \`MCP-Protocol-Version: 2026-07-28\`, \`Mcp-Method\` equal to the JSON-RPC method, and matching \`params._meta["io.modelcontextprotocol/protocolVersion"]\`. For \`tools/call\`, also send \`Mcp-Name\` equal to the tool name. Accept both \`application/json\` and \`text/event-stream\`.\n\nStart with \`qos_capabilities\`. Request a transfer with \`qos_request_transfer\` and only an \`amount\` string.${record.dexTrading ? " Request an allowlisted DEX swap with `qos_request_swap`." : ""} Never send the token or either BYOK credential to a remote model or non-loopback endpoint.\n`,
    "approval.md": record.approvalMode === "ask"
      ? "# Approval\n\nEach valid request is held only in listener memory. Wait for the operator to approve or reject the request in qOS. Do not retry a pending request unless the operator says it expired.\n"
      : "# Approval\n\nValid requests may execute automatically while the operator runs the listener in live mode. Mainnet still requires the operator to start the listener with `--confirm-live`.\n",
  };
}

function writeSkillPack(record, paths, policy) {
  mkdirSync(paths.agent, { mode: 0o700 });
  chmodSync(paths.agent, 0o700);
  mkdirSync(paths.skills, { mode: 0o700 });
  chmodSync(paths.skills, 0o700);
  const files = skillText(record, paths, policy);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(paths.skills, name), text, { flag: "wx", mode: 0o600 });
    chmodSync(join(paths.skills, name), 0o600);
  }
  const manifest = {
    version: 3,
    agentId: record.id,
    mcpEndpoint: "http://127.0.0.1:8790/mcp",
    restEndpoint: "http://127.0.0.1:8790/v1/actions",
    mcpProtocolVersion: "2026-07-28",
    tokenFile: paths.token,
    action: record.asset === "sol" ? "transfer_sol" : "transfer_qos",
    dexAction: record.dexTrading ? "swap" : null,
    amountEncoding: "canonical-base-unit-integer",
    approvalMode: record.approvalMode,
  };
  writeFileSync(join(paths.skills, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(join(paths.skills, "manifest.json"), 0o600);
}

function removeKnownAgentFiles(paths) {
  for (const name of SKILL_FILES) {
    const path = join(paths.skills, name);
    if (existsSync(path)) unlinkSync(path);
  }
  if (existsSync(paths.skills) && readdirSync(paths.skills).length === 0) rmdirSync(paths.skills);
  if (existsSync(paths.agent) && readdirSync(paths.agent).length === 0) rmdirSync(paths.agent);
}

export function onboardAgent(home, {
  id,
  name = id,
  approvalMode = "ask",
  asset,
  maxAmount,
  destination,
  strategyId,
  acceptAuto = false,
  enableDexTrading = false,
} = {}) {
  const resolvedHome = resolve(home);
  const runtime = loadRuntimeProfile(resolvedHome);
  const policy = loadPolicy(join(resolvedHome, "policy.json"));
  assertQos(typeof id === "string" && AGENT_ID.test(id), "INVALID_AGENT_ID", "Agent ID must start with a lowercase letter and contain at most 32 lowercase letters, digits, or hyphens");
  assertQos(typeof name === "string" && name.length >= 1 && name.length <= 80 && !/[\x00-\x1f\x7f]/u.test(name), "INVALID_AGENT_NAME", "Agent name must contain 1 to 80 printable characters");
  assertQos(approvalMode === "ask" || approvalMode === "auto", "INVALID_APPROVAL_MODE", "Approval mode must be ask or auto");
  assertQos(approvalMode !== "auto" || acceptAuto === true, "AUTO_APPROVAL_ACKNOWLEDGEMENT_REQUIRED", "Automatic execution requires explicit acknowledgement with --accept-auto");
  assertQos(typeof enableDexTrading === "boolean", "INVALID_DEX_AGENT_SCOPE", "Agent DEX capability must be a boolean");
  assertQos(!enableDexTrading || policy.dexTrading !== null, "DEX_TRADING_DISABLED", "Configure a DEX policy before enabling agent trading");
  const selectedAsset = asset ?? (runtime.profile === "devnet" ? "sol" : "qos-token");
  const selectedDestination = destination ?? policy.allowedDestinations[0];
  const selectedStrategy = strategyId ?? policy.allowedStrategyIds[0];
  assertQos(Number.isInteger(selectedStrategy), "INVALID_STRATEGY_ID", "Agent strategy ID must be an integer");
  ensureScope(policy, {
    asset: selectedAsset,
    maxAmount,
    destination: selectedDestination,
    strategyId: selectedStrategy,
  });
  const rootPaths = ensureAgentsDirectory(resolvedHome);
  const registry = loadAgentRegistry(resolvedHome);
  assertQos(registry.agents.length < 64, "AGENT_LIMIT_REACHED", "A profile may onboard at most 64 agents");
  assertQos(!registry.agents.some((agent) => agent.id === id), "AGENT_ALREADY_EXISTS", `Agent ${id} is already onboarded`);
  const paths = agentPaths(resolvedHome, id);
  assertQos(!existsSync(paths.agent), "AGENT_PATH_CONFLICT", "Agent directory already exists; inspect it before retrying");
  const token = Buffer.from(`${randomBytes(48).toString("base64url")}\n`, "ascii");
  const record = validateAgentRecord({
    version: 2,
    id,
    name,
    enabled: true,
    approvalMode,
    asset: selectedAsset,
    maxAmount,
    destination: selectedDestination,
    strategyId: selectedStrategy,
    tokenSha256: createHash("sha256").update(token.subarray(0, token.length - 1)).digest("hex"),
    dexTrading: enableDexTrading,
  });
  try {
    writeSkillPack(record, paths, policy);
    writeFileSync(paths.token, token, { flag: "wx", mode: 0o600 });
    chmodSync(paths.token, 0o600);
    const next = { version: 1, agents: [...registry.agents, record].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) };
    validateRegistry(next);
    writePrivateJsonAtomic(rootPaths.registry, next, { errorCode: "AGENT_REGISTRY_WRITE_FAILED", label: "Agent registry" });
  } catch (error) {
    if (existsSync(paths.token)) {
      try { unlinkSync(paths.token); } catch {}
    }
    try { removeKnownAgentFiles(paths); } catch {}
    throw error;
  } finally {
    token.fill(0);
  }
  return publicAgent(resolvedHome, record);
}

export function listAgents(home) {
  const resolvedHome = resolve(home);
  return loadAgentRegistry(resolvedHome).agents.map((record) => {
    validateAgentRuntimeFiles(resolvedHome, record);
    return publicAgent(resolvedHome, record);
  });
}

export function getAgent(home, id) {
  const resolvedHome = resolve(home);
  assertQos(typeof id === "string" && AGENT_ID.test(id), "INVALID_AGENT_ID", "Agent ID is invalid");
  const record = loadAgentRegistry(resolvedHome).agents.find((agent) => agent.id === id);
  assertQos(record !== undefined, "AGENT_NOT_FOUND", `Agent ${id} is not onboarded`);
  validateAgentRuntimeFiles(resolvedHome, record);
  return publicAgent(resolvedHome, record);
}

export function getAgentRecord(home, id) {
  assertQos(typeof id === "string" && AGENT_ID.test(id), "INVALID_AGENT_ID", "Agent ID is invalid");
  const record = loadAgentRegistry(home).agents.find((agent) => agent.id === id);
  assertQos(record !== undefined, "AGENT_NOT_FOUND", `Agent ${id} is not onboarded`);
  return record;
}

export function authenticateAgent(home, bearer) {
  assertQos(typeof bearer === "string" && bearer.length >= 32 && bearer.length <= 512 && /^[\x21-\x7e]+$/.test(bearer), "AGENT_UNAUTHORIZED", "Agent bearer credential is missing or invalid");
  const suppliedHash = createHash("sha256").update(bearer, "utf8").digest();
  try {
    for (const record of loadAgentRegistry(home).agents) {
      const expected = Buffer.from(record.tokenSha256, "hex");
      try {
        if (timingSafeEqual(suppliedHash, expected)) return record;
      } finally {
        expected.fill(0);
      }
    }
  } finally {
    suppliedHash.fill(0);
  }
  throw new QosError("AGENT_UNAUTHORIZED", "Agent bearer credential is missing or invalid");
}

export function validateAgentAction(home, record, action) {
  const policy = loadPolicy(join(resolve(home), "policy.json"));
  if (action?.version === 2 || action?.action === "swap") {
    assertQos(record.dexTrading === true, "AGENT_ACTION_FORBIDDEN", "Agent is not allowed to request DEX swaps");
    return validateDexAction(policy, action).action;
  }
  assertQos(action && typeof action === "object" && !Array.isArray(action) && hasExactKeys(action, ["version", "action", "amount", "destination", "strategyId"]), "INVALID_AGENT_ACTION", "Agent action has missing or unknown fields");
  assertQos(action.version === 1, "INVALID_AGENT_ACTION", "Agent action version is unsupported");
  const expectedAction = record.asset === "sol" ? "transfer_sol" : "transfer_qos";
  assertQos(action.action === expectedAction, "AGENT_ACTION_FORBIDDEN", `Agent may request only ${expectedAction}`);
  assertQos(action.destination === record.destination, "AGENT_DESTINATION_FORBIDDEN", "Agent cannot change its destination");
  assertQos(action.strategyId === record.strategyId, "AGENT_STRATEGY_FORBIDDEN", "Agent cannot change its strategy ID");
  const amount = parseUnsigned(action.amount, 64, "agent action amount");
  assertQos(amount > 0n && amount <= BigInt(record.maxAmount), "AGENT_AMOUNT_LIMIT_EXCEEDED", "Agent amount exceeds its onboarded limit");
  ensureScope(policy, { ...record, maxAmount: action.amount });
  return Object.freeze({ ...action });
}

export function offboardAgent(home, id) {
  const resolvedHome = resolve(home);
  const rootPaths = ensureAgentsDirectory(resolvedHome);
  const registry = loadAgentRegistry(resolvedHome);
  const record = registry.agents.find((agent) => agent.id === id);
  assertQos(record !== undefined, "AGENT_NOT_FOUND", `Agent ${id} is not onboarded`);
  const next = { version: 1, agents: registry.agents.filter((agent) => agent.id !== id) };
  writePrivateJsonAtomic(rootPaths.registry, next, { errorCode: "AGENT_REGISTRY_WRITE_FAILED", label: "Agent registry" });
  const paths = agentPaths(resolvedHome, id);
  let localCredentialRemoved = false;
  let cleanupWarning = null;
  try {
    validateAgentRuntimeFiles(resolvedHome, record);
    if (existsSync(paths.token)) {
      unlinkSync(paths.token);
      localCredentialRemoved = true;
    }
    removeKnownAgentFiles(paths);
  } catch {
    cleanupWarning = "Agent authorization was revoked, but unsafe or damaged local agent files were preserved for manual inspection";
  }
  return {
    id,
    status: "offboarded",
    credentialRevoked: true,
    localCredentialRemoved,
    cleanupWarning,
    remainingAgents: next.agents.length,
  };
}
