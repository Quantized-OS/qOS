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
import { TextDecoder } from "node:util";

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
export const AGENT_SKILL_FILES = ["SKILL.md", "capabilities.md", "trading.md", "risk-controls.md", "transfer.md", "mcp.md", "approval.md", "connection.json", "manifest.json"];
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
  assertQos(record.asset === "sol" || record.asset === "qos-token" || record.asset === "trading-only", "INVALID_AGENT_ASSET", "Agent asset must be sol, qos-token, or trading-only");
  const maxAmount = parseUnsigned(record.maxAmount, 64, "agent.maxAmount");
  assertQos(record.asset === "trading-only" ? maxAmount === 0n : maxAmount > 0n, "INVALID_AGENT_AMOUNT", "Trading-only agents use a zero transfer amount; transfer agents require a positive limit");
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
  if (asset === "trading-only") {
    assertQos(amount === 0n, "AGENT_ASSET_DISABLED", "Trading-only scope must not include a transfer allowance");
    return;
  }
  assertQos(amount > 0n, "INVALID_AGENT_AMOUNT", "Agent max amount must be greater than zero");
  if (asset === "sol") {
    assertQos(BigInt(policy.maxTransferLamports) > 0n, "AGENT_ASSET_DISABLED", "Native SOL transfers are disabled by this profile");
    assertQos(amount <= BigInt(policy.maxTransferLamports), "AGENT_AMOUNT_LIMIT_EXCEEDED", "Agent SOL limit exceeds the qOS policy limit");
  } else {
    assertQos(asset === "qos-token" && policy.tokenTransfer !== null, "AGENT_ASSET_DISABLED", "The pinned qOS token transfer is disabled by this profile");
    assertQos(amount <= BigInt(policy.tokenTransfer.maxTransferAmount), "AGENT_AMOUNT_LIMIT_EXCEEDED", "Agent token limit exceeds the qOS policy limit");
  }
}

function skillText(record, policy, endpoints) {
  const action = record.asset === "sol" ? "transfer_sol" : record.asset === "qos-token" ? "transfer_qos" : null;
  const dex = record.dexTrading ? policy.dexTrading : null;
  const anyToken = dex?.tokenScope === "any-solana-token";
  const limits = anyToken
    ? { maxInputAmount: dex.maxInputAmount, dailyInputLimit: dex.dailyInputLimit }
    : null;
  const legacyPairs = dex !== null && !anyToken
    ? dex.allowedPairs.map((pair) => `- ${pair.inputMint} → ${pair.outputMint}: max ${pair.maxInputAmount} input base units per swap; ${pair.dailyInputLimit} per UTC day`).join("\n")
    : "";
  const files = {
    "SKILL.md": `---\nname: qos-solana-trader\ndescription: Trade Solana tokens through this box's policy-enforced qOS MCP server.\n---\n\n# qOS Solana trading skill\n\nUse this skill whenever the user asks to inspect this box, trade or swap a Solana token, automate a bounded trading strategy, or retrieve transaction evidence. This skill is generated for **${record.name}** (\`${record.id}\`) and reflects its live policy at creation time.\n\n## Connect\n\n- MCP endpoint: \`${endpoints.mcpEndpoint}\`\n- Skill document: \`${endpoints.skillEndpoint}\`\n- Downloadable skill pack: \`${endpoints.skillDownloadEndpoint}\`\n- Authentication: \`Authorization: Bearer <box MCP token>\`\n\nInstall by extracting the downloaded ZIP into the agent's skills directory, then configure the MCP endpoint and Bearer token in the agent client. The token is issued separately and is intentionally never embedded in this pack. This skill cannot request arbitrary signatures, arbitrary programs, or shell commands.\n\n## Required workflow\n\n1. Connect with Streamable HTTP and call \`qos_capabilities\`. Do not trade if its policy differs from this pack.\n2. Resolve the intended Solana input and output mint addresses. Never infer a mint from a ticker alone.\n3. Convert the exact input quantity to the input token's smallest unit and call \`qos_request_swap\` once.\n4. If approval mode is \`ask\`, report the pending request ID and wait. If it is \`auto\`, wait for the terminal result.\n5. Treat timeouts after submission as ambiguous. Do not retry until the transaction signature or account state proves the first request did not land.\n6. On success, return the input/output amounts, signature, and Solscan URL.\n\nRead \`capabilities.md\`, \`trading.md\`, \`risk-controls.md\`, \`mcp.md\`, and \`approval.md\` before the first trade. qOS tokens are not a trading restriction: in qOS Cloud they are used only for launch and service settlement charges.\n`,
    "capabilities.md": `# Box capabilities\n\n- Agent: ${record.name} (\`${record.id}\`)\n- Network: ${policy.cluster}\n- Strategy ID: ${record.strategyId}\n- Approval mode: ${record.approvalMode}\n- Trading: ${record.dexTrading ? "enabled through the policy-pinned Jupiter Ultra Swap endpoint" : "disabled"}\n- Token scope: ${anyToken ? "any initialized Solana Token Program or Token-2022 mint" : dex === null ? "none" : "legacy configured pairs"}\n- Output receiver: ${dex?.receiver ?? "box signer"}\n- MCP endpoint: ${endpoints.mcpEndpoint}\n- Skill endpoint: ${endpoints.skillEndpoint}\n${dex === null ? "" : `- Per-trade input cap: ${limits?.maxInputAmount ?? "pair-specific"} input-token base units\n- UTC daily input cap: ${limits?.dailyInputLimit ?? "pair-specific"} input-token base units per mint pair\n- Maximum slippage: ${dex.maxSlippageBps} bps\n- Maximum route fee: ${dex.maxRouteFeeBps} bps\n- Maximum network and rent fee: ${dex.maxFeeLamports} lamports\n- Minimum interval: ${dex.minIntervalSeconds} seconds\n- Maximum swaps per UTC day: ${dex.maxSwapsPerDay}\n${legacyPairs ? `\nLegacy configured pairs:\n${legacyPairs}\n` : ""}`}\nThe amount field is always a canonical positive decimal integer in the **input token's smallest unit**. Token decimals vary; fetch and verify the mint before converting a human quantity.\n`,
    "trading.md": dex === null
      ? "# Trading\n\nDEX trading is disabled for this agent.\n"
      : `# Trading with qOS\n\nCall \`qos_request_swap\` with exactly:\n\n\`\`\`json\n{"inputMint":"SOLANA_MINT","outputMint":"SOLANA_MINT","amount":"INPUT_BASE_UNITS"}\n\`\`\`\n\n${anyToken ? "Both mint addresses may be any distinct initialized mint on Solana mainnet owned by the classic Token Program or Token-2022 Program. Firmware validates both mint accounts on the policy-pinned cluster before requesting an order." : "Both addresses must match one of the legacy pairs in capabilities.md."}\n\nqOS obtains a manual ExactIn Jupiter order, rejects JupiterZ and gasless/co-signer paths, validates receiver, fee payer, signer set, transaction form, slippage, route fee, network/rent fee, and minimum output, then signs and submits the reviewed transaction. A success result contains a Solana signature and Solscan URL.\n\nNever describe a quote as guaranteed profit. Never ask qOS to sign arbitrary bytes or bypass the MCP tool. Never retry an ambiguous submitted trade without reconciling chain state.\n`,
    "risk-controls.md": dex === null
      ? "# Risk controls\n\nTrading is disabled.\n"
      : `# Enforced risk controls\n\nThese controls are enforced by firmware, not by prompt instructions:\n\n- ExactIn only; positive u64 input amount.\n- ${anyToken ? `Any verified Solana token pair, capped at ${dex.maxInputAmount} input base units per trade and ${dex.dailyInputLimit} per pair per UTC day.` : "Only configured legacy pairs and their pair-specific caps."}\n- ${dex.maxSwapsPerDay} swaps per UTC day across this profile.\n- ${dex.minIntervalSeconds}-second minimum interval between landed or ambiguously delivered swaps.\n- ${dex.maxSlippageBps} bps maximum slippage; ${dex.maxRouteFeeBps} bps maximum route fee.\n- ${dex.maxFeeLamports} lamports maximum aggregate signature, priority, and rent fee.\n- One writable qOS signer in a version-0 Solana transaction; no provider co-signer or gasless path.\n- Persistent conservative reservation before provider execution; ambiguous delivery consumes the authorized budget until reconciled.\n\nDo not split one intended trade into rapid requests to evade controls. Stop and report policy errors instead of adjusting security parameters autonomously.\n`,
    "mcp.md": `# MCP connection\n\nEndpoint: \`${endpoints.mcpEndpoint}\`\nTransport: Streamable HTTP POST\nProtocols: \`2026-07-28\` and \`2025-06-18\` compatibility\nAuthentication: Bearer token issued for this box\n\nThe server exposes standard \`initialize\`, \`ping\`, \`tools/list\`, \`tools/call\`, \`resources/list\`, and \`resources/read\` methods. Skill resources use \`qos://skill/<filename>\`. Use \`qos_get_trading_skill\` for a tool-based discovery path.\n\nStart with \`qos_capabilities\`, then use \`qos_request_swap\`.${action === null ? "" : " This legacy non-Cloud scope also exposes `qos_request_transfer`."} Never place the Bearer token or the Jupiter BYOK secret in a model prompt, log, URL, source file, or skill bundle.\n`,
    "approval.md": record.approvalMode === "ask"
      ? "# Approval\n\nEvery valid trade request is held in listener memory for operator approval. Report the pending request ID and wait. Do not retry unless the request expires or the operator explicitly asks.\n"
      : "# Approval\n\nValid in-policy trades execute automatically while live mainnet execution is enabled. Automatic approval does not bypass firmware token, amount, frequency, fee, signer, transaction, or confirmation checks.\n",
    "connection.json": `${JSON.stringify({
      version: 1,
      transport: "streamable-http",
      mcpEndpoint: endpoints.mcpEndpoint,
      skillEndpoint: endpoints.skillEndpoint,
      skillDownloadEndpoint: endpoints.skillDownloadEndpoint,
      authentication: { type: "bearer", secretIncluded: false },
      protocolVersions: ["2026-07-28", "2025-06-18"],
    }, null, 2)}\n`,
  };
  if (action !== null) files["transfer.md"] = `# Legacy transfer scope\n\nThis non-Cloud agent may request \`${action}\` to ${record.destination}, capped at ${record.maxAmount} base units. qOS Cloud trading boxes use trading-only scope and do not expose this tool.\n`;
  return files;
}

function writeSkillPack(record, paths, policy, endpoints) {
  mkdirSync(paths.agent, { mode: 0o700 });
  chmodSync(paths.agent, 0o700);
  mkdirSync(paths.skills, { mode: 0o700 });
  chmodSync(paths.skills, 0o700);
  const files = skillText(record, policy, endpoints);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(paths.skills, name), text, { flag: "wx", mode: 0o600 });
    chmodSync(join(paths.skills, name), 0o600);
  }
  const manifest = {
    version: 4,
    agentId: record.id,
    mcpEndpoint: endpoints.mcpEndpoint,
    skillEndpoint: endpoints.skillEndpoint,
    skillDownloadEndpoint: endpoints.skillDownloadEndpoint,
    restEndpoint: endpoints.restEndpoint,
    mcpProtocolVersion: "2026-07-28",
    action: record.asset === "sol" ? "transfer_sol" : record.asset === "qos-token" ? "transfer_qos" : null,
    dexAction: record.dexTrading ? "swap" : null,
    amountEncoding: "canonical-base-unit-integer",
    approvalMode: record.approvalMode,
  };
  writeFileSync(join(paths.skills, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(join(paths.skills, "manifest.json"), 0o600);
}

function removeKnownAgentFiles(paths) {
  for (const name of AGENT_SKILL_FILES) {
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
  skillMcpEndpoint = "http://127.0.0.1:8790/mcp",
  skillEndpoint = "http://127.0.0.1:8790/skill",
  skillDownloadEndpoint = "http://127.0.0.1:8790/skill/download",
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
  for (const [label, value] of [["MCP", skillMcpEndpoint], ["skill", skillEndpoint], ["skill download", skillDownloadEndpoint]]) {
    assertQos(typeof value === "string" && value.length <= 2_048, "INVALID_SKILL_ENDPOINT", `Agent ${label} endpoint is invalid`);
    let parsed;
    try { parsed = new URL(value); } catch { assertQos(false, "INVALID_SKILL_ENDPOINT", `Agent ${label} endpoint is invalid`); }
    assertQos((parsed.protocol === "https:" || (parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname))) && !parsed.username && !parsed.password && !parsed.hash, "INVALID_SKILL_ENDPOINT", `Agent ${label} endpoint must use HTTPS or loopback HTTP`);
  }
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
    writeSkillPack(record, paths, policy, {
      mcpEndpoint: skillMcpEndpoint,
      skillEndpoint,
      skillDownloadEndpoint,
      restEndpoint: "http://127.0.0.1:8790/v1/actions",
    });
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

export function readAgentSkillPack(home, id) {
  const resolvedHome = resolve(home);
  const record = getAgentRecord(resolvedHome, id);
  const paths = validateAgentRuntimeFiles(resolvedHome, record);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files = {};
  for (const name of AGENT_SKILL_FILES) {
    const path = join(paths.skills, name);
    if (!existsSync(path)) continue;
    const bytes = readSecureFile(path, {
      privateFile: true,
      minBytes: 1,
      maxBytes: 256 * 1024,
      errorCode: "INSECURE_AGENT_SKILL",
      label: `Agent ${record.id} skill ${name}`,
    });
    try {
      files[name] = decoder.decode(bytes);
    } catch {
      throw new QosError("INVALID_AGENT_SKILL", `Agent ${record.id} skill ${name} is not valid UTF-8`);
    } finally {
      bytes.fill(0);
    }
  }
  assertQos(typeof files["SKILL.md"] === "string" && typeof files["manifest.json"] === "string", "INVALID_AGENT_SKILL", `Agent ${record.id} skill pack is incomplete`);
  let manifest;
  try { manifest = JSON.parse(files["manifest.json"]); } catch { throw new QosError("INVALID_AGENT_SKILL", `Agent ${record.id} skill manifest is invalid`); }
  return Object.freeze({ agent: publicAgent(resolvedHome, record), manifest: Object.freeze(manifest), files: Object.freeze(files) });
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
  assertQos(record.asset !== "trading-only", "AGENT_ACTION_FORBIDDEN", "Trading-only agents may request only DEX swaps");
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
