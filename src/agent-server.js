import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { authenticateAgent, getAgentRecord, readAgentSkillPack, validateAgentAction } from "./agent-registry.js";
import { hasExactKeys } from "./canonical.js";
import { publicDexTrading } from "./dex.js";
import { assertQos, publicError, QosError } from "./errors.js";
import { loadPolicy } from "./policy.js";
import { marketDataSources, searchSolanaMarkets, solanaTokenMarkets } from "./market-data.js";
import { readSecureFile } from "./secure-file.js";
import { buildSkillZip } from "./skill-bundle.js";
import { policyCommitment } from "./zk.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PENDING = 128;
const MAX_PENDING_PER_AGENT = 16;
const PENDING_TTL_MS = 5 * 60 * 1000;
export const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_COMPATIBLE_PROTOCOLS = new Set([MCP_PROTOCOL_VERSION, "2025-06-18"]);

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendEmpty(response, status) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

function sendBytes(response, status, bytes, contentType, { filename = null } = {}) {
  const body = Buffer.from(bytes);
  const headers = {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  if (filename !== null) headers["content-disposition"] = `attachment; filename="${filename}"`;
  response.writeHead(status, headers);
  response.end(body);
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function onlyKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function singleHeader(request, name, { required = true } = {}) {
  const values = request.headersDistinct?.[name];
  if (values === undefined && !required) return undefined;
  assertQos(Array.isArray(values) && values.length === 1 && values[0].length > 0, "MCP_HEADER_INVALID", `Exactly one ${name} header is required`);
  return values[0];
}

function assertMcpTransportHeaders(request) {
  const accepts = singleHeader(request, "accept").split(",").map((item) => item.split(";", 1)[0].trim().toLowerCase());
  assertQos(accepts.includes("application/json") && accepts.includes("text/event-stream"), "MCP_ACCEPT_INVALID", "MCP clients must accept application/json and text/event-stream");
  const origin = singleHeader(request, "origin", { required: false });
  if (origin !== undefined) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new QosError("MCP_ORIGIN_FORBIDDEN", "MCP Origin is invalid"); }
    assertQos(
      parsed.username === "" && parsed.password === "" && parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
        && (parsed.protocol === "http:" || parsed.protocol === "https:")
        && ["127.0.0.1", "[::1]", "::1", "localhost"].includes(parsed.hostname),
      "MCP_ORIGIN_FORBIDDEN",
      "MCP browser Origins must be loopback",
    );
  }
}

function validateMcpEnvelope(request, body) {
  assertQos(plainObject(body), "MCP_REQUEST_INVALID", "MCP batches and non-object messages are not accepted");
  assertQos(body.jsonrpc === "2.0" && typeof body.method === "string", "MCP_REQUEST_INVALID", "MCP message must use JSON-RPC 2.0 and a method");
  assertQos(body.id === undefined || typeof body.id === "string" || (typeof body.id === "number" && Number.isSafeInteger(body.id)), "MCP_REQUEST_INVALID", "MCP request ID must be a string or safe integer");
  assertQos(onlyKeys(body, new Set(["jsonrpc", "id", "method", "params"])), "MCP_REQUEST_INVALID", "MCP message contains unknown fields");
  const params = body.params ?? {};
  assertQos(plainObject(params), "MCP_PARAMS_INVALID", "MCP params must be an object");

  const protocolHeader = singleHeader(request, "mcp-protocol-version", { required: body.method !== "initialize" });
  let protocolVersion = protocolHeader ?? params.protocolVersion;
  if (body.method === "initialize" && !MCP_COMPATIBLE_PROTOCOLS.has(protocolVersion)) protocolVersion = MCP_PROTOCOL_VERSION;
  assertQos(MCP_COMPATIBLE_PROTOCOLS.has(protocolVersion), "MCP_PROTOCOL_VERSION_UNSUPPORTED", "MCP protocol version is unsupported");
  if (protocolHeader !== undefined && body.method === "initialize" && typeof params.protocolVersion === "string") {
    assertQos(protocolHeader === params.protocolVersion, "MCP_HEADER_MISMATCH", "MCP protocol header does not match initialize params");
  }
  if (protocolVersion === MCP_PROTOCOL_VERSION) {
    assertQos(singleHeader(request, "mcp-method") === body.method, "MCP_HEADER_MISMATCH", "Mcp-Method does not match the JSON-RPC method");
    if (body.method !== "initialize") {
      assertQos(plainObject(params._meta) && params._meta["io.modelcontextprotocol/protocolVersion"] === protocolVersion, "MCP_HEADER_MISMATCH", "MCP request metadata does not match the protocol header");
    }
    if (body.method === "tools/call" || body.method === "resources/read") {
      const requestedName = body.method === "tools/call" ? params.name : params.uri;
      assertQos(singleHeader(request, "mcp-name") === requestedName, "MCP_HEADER_MISMATCH", "Mcp-Name does not match the requested capability");
    } else {
      assertQos(singleHeader(request, "mcp-name", { required: false }) === undefined, "MCP_HEADER_INVALID", "Mcp-Name is valid only for tools/call or resources/read");
    }
  }
  return { params, protocolVersion };
}

function mcpToolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function loopback(host) {
  return host === "127.0.0.1" || host === "::1";
}

function remoteIsLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function remoteIsPrivate(address) {
  const text = typeof address === "string" && address.startsWith("::ffff:") ? address.slice(7) : address;
  if (typeof text !== "string") return false;
  const octets = text.split(".").map(Number);
  if (octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  const normalized = text.toLowerCase();
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}

function bearer(request) {
  const headers = request.headersDistinct?.authorization;
  assertQos(Array.isArray(headers) && headers.length === 1, "UNAUTHORIZED", "Exactly one Bearer credential is required");
  const header = request.headers.authorization;
  assertQos(typeof header === "string" && header.startsWith("Bearer "), "UNAUTHORIZED", "Exactly one Bearer credential is required");
  return header.slice(7);
}

function readTokenFile(path) {
  const bytes = readSecureFile(path, {
    privateFile: true,
    minBytes: 32,
    maxBytes: 1024,
    errorCode: "INSECURE_API_TOKEN_FILE",
    label: "Operator API token file",
  });
  let end = bytes.length;
  if (bytes[end - 1] === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  const token = Buffer.from(bytes.subarray(0, end));
  bytes.fill(0);
  try {
    assertQos(token.length >= 32 && token.length <= 512 && token.every((byte) => byte >= 0x21 && byte <= 0x7e), "API_TOKEN_FORMAT_INVALID", "Operator API token is invalid");
    return token;
  } catch (error) {
    token.fill(0);
    throw error;
  }
}

function operatorAuthorized(request, expected) {
  let supplied;
  try {
    supplied = Buffer.from(bearer(request), "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  } finally {
    supplied?.fill(0);
  }
}

async function readJson(request) {
  const contentTypes = request.headersDistinct?.["content-type"];
  assertQos(Array.isArray(contentTypes) && contentTypes.length === 1 && contentTypes[0].split(";", 1)[0].trim() === "application/json", "UNSUPPORTED_CONTENT_TYPE", "Exactly one application/json Content-Type is required");
  assertQos(request.headers["content-encoding"] === undefined || request.headers["content-encoding"] === "identity", "UNSUPPORTED_CONTENT_ENCODING", "Compressed request bodies are not accepted");
  assertQos(request.headers["transfer-encoding"] === undefined, "TRANSFER_ENCODING_FORBIDDEN", "Transfer-Encoding is not accepted");
  const lengths = request.headersDistinct?.["content-length"];
  assertQos(Array.isArray(lengths) && lengths.length === 1 && /^(0|[1-9][0-9]*)$/.test(lengths[0]), "CONTENT_LENGTH_REQUIRED", "Exactly one canonical Content-Length is required");
  const expected = Number(lengths[0]);
  assertQos(expected <= MAX_BODY_BYTES, "BODY_TOO_LARGE", "Request body exceeds 16 KiB");
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      length += chunk.length;
      assertQos(length <= MAX_BODY_BYTES, "BODY_TOO_LARGE", "Request body exceeds 16 KiB");
      chunks.push(Buffer.from(chunk));
    }
    assertQos(length === expected, "INVALID_CONTENT_LENGTH", "Request body length does not match Content-Length");
    const body = Buffer.concat(chunks);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } finally {
      body.fill(0);
    }
  } catch (error) {
    if (error instanceof QosError) throw error;
    throw new QosError("INVALID_JSON", "Request body is not valid JSON");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function publicRecord(record) {
  const { tokenSha256: _credentialVerifier, ...safe } = record;
  return safe;
}

export function startAgentServer(service, {
  home,
  host = "127.0.0.1",
  port = 8790,
  apiTokenFile,
  enableMainnetBroadcast = false,
  managedInstanceId = null,
  managedProxy = false,
} = {}) {
  const resolvedHome = resolve(home);
  assertQos(Number.isInteger(port) && port >= 0 && port <= 65535, "INVALID_PORT", "Port must be between 0 and 65535");
  const managedProxyEnabled = managedProxy === true && process.env.QOS_ENABLE_MANAGED_PROXY === "I_UNDERSTAND";
  assertQos(loopback(host) || (managedProxyEnabled && host === "0.0.0.0"), "LOOPBACK_REQUIRED", "The agent listener may leave loopback only behind the explicitly acknowledged managed Docker proxy");
  assertQos(typeof apiTokenFile === "string", "API_TOKEN_REQUIRED", "The agent listener requires the owner-only runtime API token file");
  const operatorToken = readTokenFile(apiTokenFile);
  const initialPolicyCommitment = policyCommitment(service.policy);
  const pending = new Map();
  const recentByAgent = new Map();

  function expirePending() {
    const now = Date.now();
    for (const [id, request] of pending) {
      if (request.expiresAt <= now) pending.delete(id);
    }
  }

  function assertPolicyCurrent() {
    const current = loadPolicy(join(resolvedHome, "policy.json"));
    assertQos(policyCommitment(current) === initialPolicyCommitment, "POLICY_RELOAD_REQUIRED", "Policy changed after the listener started; restart the listener before accepting more requests");
  }

  function rateLimit(record) {
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (recentByAgent.get(record.id) ?? []).filter((timestamp) => timestamp > cutoff);
    assertQos(recent.length < service.policy.maxRequestsPerMinute, "AGENT_RATE_LIMIT", "Agent request rate exceeds the qOS policy");
    recent.push(now);
    recentByAgent.set(record.id, recent);
  }

  async function execute(record, action) {
    assertPolicyCurrent();
    const currentRecord = getAgentRecord(resolvedHome, record.id);
    assertQos(currentRecord.tokenSha256 === record.tokenSha256, "AGENT_REONBOARDED", "Agent credential changed after this request was created");
    validateAgentAction(resolvedHome, currentRecord, action);
    if (service.policy.cluster === "mainnet-beta") {
      assertQos(enableMainnetBroadcast, "LIVE_CONFIRMATION_REQUIRED", "Start the agent listener with --confirm-live before a mainnet action can execute");
    }
    if (action.action === "swap") return service.executeDexSwap(action);
    const intent = currentRecord.asset === "sol"
      ? await service.prepareIntent({ destination: action.destination, lamports: action.amount, strategyId: action.strategyId })
      : await service.prepareTokenIntent({ destination: action.destination, amount: action.amount, strategyId: action.strategyId });
    return service.submitIntent(intent);
  }

  async function acceptAction(agent, actionBody) {
    rateLimit(agent);
    assertPolicyCurrent();
    const action = validateAgentAction(resolvedHome, agent, actionBody);
    if (agent.approvalMode === "ask") {
      assertQos(pending.size < MAX_PENDING, "PENDING_LIMIT_REACHED", "Agent listener has too many pending requests");
      assertQos([...pending.values()].filter((item) => item.agent.id === agent.id).length < MAX_PENDING_PER_AGENT, "PENDING_AGENT_LIMIT_REACHED", "Agent already has too many pending requests");
      const id = randomBytes(16).toString("hex");
      pending.set(id, { agent, action, expiresAt: Date.now() + PENDING_TTL_MS });
      return { statusCode: 202, value: { status: "pending-approval", requestId: id, expiresInSeconds: PENDING_TTL_MS / 1000 } };
    }
    return { statusCode: 200, value: { status: "executed", result: await execute(agent, action) } };
  }

  function mcpTools(agent) {
    const tools = [
      {
        name: "qos_capabilities",
        title: "Show qOS agent capabilities",
        description: "Return this authenticated box's network, trading scope, risk controls, approval mode, and skill endpoints.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "qos_get_trading_skill",
        title: "Read the generated qOS trading skill",
        description: "Return this box's generated SKILL.md and the authenticated skill/download endpoints.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ];
    if (agent.asset !== "trading-only") {
      const action = agent.asset === "sol" ? "transfer_sol" : "transfer_qos";
      tools.push({
        name: "qos_request_transfer",
        title: `Request ${action}`,
        description: "Request one legacy transfer in base units. Managed qOS Cloud trading boxes do not expose this tool.",
        inputSchema: {
          type: "object",
          properties: { amount: { type: "string", pattern: "^[1-9][0-9]*$", description: `Canonical base-unit integer no greater than ${agent.maxAmount}.` } },
          required: ["amount"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      });
    }
    if (agent.dexTrading) {
      const venues = publicDexTrading(resolvedHome).venues;
      tools.push(
        {
          name: "qos_search_markets",
          title: "Search Solana markets",
          description: "Search read-only DexScreener market data for Solana pairs, including Pump.fun-origin pools. Results are untrusted discovery data and never authorize a trade.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 80, description: "Token name, symbol, mint, or pair search text." },
              source: { type: "string", enum: ["all", "dexscreener", "pumpfun"], default: "all" },
            },
            required: ["query"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        {
          name: "qos_token_markets",
          title: "Inspect markets for a Solana mint",
          description: "Return read-only DexScreener pairs for one exact Solana mint. Verify the mint and route independently before trading.",
          inputSchema: {
            type: "object",
            properties: {
              mint: { type: "string", description: "Exact base58 Solana mint address." },
              source: { type: "string", enum: ["all", "dexscreener", "pumpfun"], default: "all" },
            },
            required: ["mint"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        {
          name: "qos_request_swap",
          title: "Trade Solana tokens through a reviewed venue",
          description: "Request one ExactIn swap through an enabled, reviewed adapter between any distinct initialized Solana Token or Token-2022 mints. qOS verifies the venue, mints, programs, amount, daily budget, cooldown, slippage, route fee, network fee, and signer set before signing and submission.",
          inputSchema: {
            type: "object",
            properties: {
              venue: { type: "string", enum: venues, description: "Enabled execution adapter for this box." },
              inputMint: { type: "string", description: "Solana input mint address. Resolve and verify the mint; never infer it from a ticker alone." },
              outputMint: { type: "string", description: "Distinct Solana output mint address." },
              amount: { type: "string", pattern: "^[1-9][0-9]*$", description: "Canonical input-token base-unit integer. For wrapped SOL, base units are lamports." },
            },
            required: ["venue", "inputMint", "outputMint", "amount"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
      );
    }
    return tools;
  }

  function listenerOrigin() {
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : port;
    return `http://${host === "::1" ? "[::1]" : host}:${actualPort}`;
  }

  function agentSkill(agent) {
    return readAgentSkillPack(resolvedHome, agent.id);
  }

  function skillSummary(agent) {
    const pack = agentSkill(agent);
    return {
      endpoint: pack.manifest.skillEndpoint ?? `${listenerOrigin()}/skill`,
      downloadEndpoint: pack.manifest.skillDownloadEndpoint ?? `${listenerOrigin()}/skill/download`,
      mcpEndpoint: pack.manifest.mcpEndpoint ?? `${listenerOrigin()}/mcp`,
    };
  }

  async function handleMcp(request, response, agent) {
    let id = null;
    try {
      assertQos(request.method === "POST", "MCP_METHOD_NOT_ALLOWED", "MCP accepts POST requests only");
      assertMcpTransportHeaders(request);
      const body = await readJson(request);
      id = body?.id ?? null;
      const { params, protocolVersion } = validateMcpEnvelope(request, body);
      if (body.method === "notifications/initialized") {
        assertQos(body.id === undefined, "MCP_REQUEST_INVALID", "MCP notifications must not contain an ID");
        sendEmpty(response, 202);
        return;
      }
      assertQos(body.id !== undefined, "MCP_REQUEST_INVALID", "MCP requests must contain an ID");
      if (body.method === "initialize") {
        assertQos(onlyKeys(params, new Set(["protocolVersion", "capabilities", "clientInfo", "_meta"])), "MCP_PARAMS_INVALID", "initialize contains unknown params");
        sendJson(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
            serverInfo: { name: "qOS", version: "0.15.0" },
            instructions: "Use qos_capabilities and qos_get_trading_skill first. Use qos_search_markets or qos_token_markets for untrusted read-only discovery, then qos_request_swap through an enabled reviewed adapter. qOS validates every mint and transaction before live signing; qOS tokens are used by Cloud only for launch and settlement fees.",
          },
        });
        return;
      }
      if (body.method === "ping") {
        assertQos(onlyKeys(params, new Set(["_meta"])), "MCP_PARAMS_INVALID", "ping contains unknown params");
        sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: {} });
        return;
      }
      if (body.method === "tools/list") {
        assertQos(onlyKeys(params, new Set(["cursor", "_meta"])) && (params.cursor === undefined || params.cursor === null), "MCP_PARAMS_INVALID", "tools/list cursor is unsupported");
        sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: { tools: mcpTools(agent) } });
        return;
      }
      if (body.method === "resources/list") {
        assertQos(onlyKeys(params, new Set(["cursor", "_meta"])) && (params.cursor === undefined || params.cursor === null), "MCP_PARAMS_INVALID", "resources/list cursor is unsupported");
        const pack = agentSkill(agent);
        const resources = Object.keys(pack.files).sort().map((name) => ({
          uri: `qos://skill/${name}`,
          name,
          title: name === "SKILL.md" ? "Generated qOS Solana trading skill" : `qOS trading skill: ${name}`,
          mimeType: name.endsWith(".json") ? "application/json" : "text/markdown",
        }));
        sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: { resources } });
        return;
      }
      if (body.method === "resources/read") {
        assertQos(onlyKeys(params, new Set(["uri", "_meta"])) && typeof params.uri === "string", "MCP_PARAMS_INVALID", "resources/read params are invalid");
        const match = /^qos:\/\/skill\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(params.uri);
        assertQos(match, "MCP_RESOURCE_NOT_FOUND", "Unknown qOS skill resource");
        const pack = agentSkill(agent);
        assertQos(Object.hasOwn(pack.files, match[1]), "MCP_RESOURCE_NOT_FOUND", "Unknown qOS skill resource");
        sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: { contents: [{ uri: params.uri, mimeType: match[1].endsWith(".json") ? "application/json" : "text/markdown", text: pack.files[match[1]] }] } });
        return;
      }
      if (body.method === "tools/call") {
        assertQos(onlyKeys(params, new Set(["name", "arguments", "_meta"])) && typeof params.name === "string" && plainObject(params.arguments ?? {}), "MCP_PARAMS_INVALID", "tools/call params are invalid");
        if (params.name === "qos_capabilities") {
          assertQos(hasExactKeys(params.arguments ?? {}, []), "MCP_TOOL_ARGUMENTS_INVALID", "qos_capabilities accepts no arguments");
          const skill = skillSummary(agent);
          const value = {
            agent: publicRecord(agent),
            supportedActions: [...(agent.asset === "trading-only" ? [] : [agent.asset === "sol" ? "transfer_sol" : "transfer_qos"]), ...(agent.dexTrading ? ["swap"] : [])],
            restEndpoint: `${listenerOrigin()}/v1/actions`,
            mcpEndpoint: skill.mcpEndpoint,
            skillEndpoint: skill.endpoint,
            skillDownloadEndpoint: skill.downloadEndpoint,
            dexTrading: agent.dexTrading ? publicDexTrading(resolvedHome) : null,
            marketData: agent.dexTrading ? marketDataSources() : [],
          };
          sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: mcpToolResult(value) });
          return;
        }
        if (params.name === "qos_get_trading_skill") {
          assertQos(hasExactKeys(params.arguments ?? {}, []), "MCP_TOOL_ARGUMENTS_INVALID", "qos_get_trading_skill accepts no arguments");
          const pack = agentSkill(agent);
          const skill = skillSummary(agent);
          sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: mcpToolResult({ skill: pack.files["SKILL.md"], ...skill }) });
          return;
        }
        if (params.name === "qos_search_markets" && agent.dexTrading) {
          assertQos(hasExactKeys(params.arguments ?? {}, params.arguments?.source === undefined ? ["query"] : ["query", "source"]), "MCP_TOOL_ARGUMENTS_INVALID", "qos_search_markets requires query and optional source");
          let toolResult;
          try { toolResult = mcpToolResult(await searchSolanaMarkets(params.arguments)); }
          catch (error) { toolResult = mcpToolResult(publicError(error), true); }
          sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: toolResult });
          return;
        }
        if (params.name === "qos_token_markets" && agent.dexTrading) {
          assertQos(hasExactKeys(params.arguments ?? {}, params.arguments?.source === undefined ? ["mint"] : ["mint", "source"]), "MCP_TOOL_ARGUMENTS_INVALID", "qos_token_markets requires mint and optional source");
          let toolResult;
          try { toolResult = mcpToolResult(await solanaTokenMarkets(params.arguments)); }
          catch (error) { toolResult = mcpToolResult(publicError(error), true); }
          sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: toolResult });
          return;
        }
        assertQos((params.name === "qos_request_transfer" && agent.asset !== "trading-only") || (params.name === "qos_request_swap" && agent.dexTrading), "MCP_TOOL_NOT_FOUND", "Unknown qOS MCP tool");
        let action;
        if (params.name === "qos_request_swap") {
          assertQos(hasExactKeys(params.arguments, ["venue", "inputMint", "outputMint", "amount"]), "MCP_TOOL_ARGUMENTS_INVALID", "qos_request_swap requires exactly venue, inputMint, outputMint, and amount");
          action = { version: 3, action: "swap", venue: params.arguments.venue, inputMint: params.arguments.inputMint, outputMint: params.arguments.outputMint, amount: params.arguments.amount, strategyId: agent.strategyId };
        } else {
          assertQos(hasExactKeys(params.arguments, ["amount"]), "MCP_TOOL_ARGUMENTS_INVALID", "qos_request_transfer requires exactly one amount string");
          action = { version: 1, action: agent.asset === "sol" ? "transfer_sol" : "transfer_qos", amount: params.arguments.amount, destination: agent.destination, strategyId: agent.strategyId };
        }
        let toolResult;
        try {
          toolResult = mcpToolResult((await acceptAction(agent, action)).value);
        } catch (error) {
          toolResult = mcpToolResult(publicError(error), true);
        }
        sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: toolResult });
        return;
      }
      sendJson(response, 404, rpcError(body.id, -32601, "MCP method not found"));
    } catch (error) {
      const headerMismatch = error?.code === "MCP_HEADER_MISMATCH" || error?.code === "MCP_HEADER_INVALID";
      const status = error?.code === "MCP_METHOD_NOT_ALLOWED" ? 405 : 400;
      sendJson(response, status, rpcError(id, headerMismatch ? -32020 : -32600, error instanceof QosError ? error.message : "Invalid MCP request"));
    }
  }

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requireHostHeader: true }, async (request, response) => {
    try {
      assertQos(remoteIsLoopback(request.socket.remoteAddress) || (managedProxyEnabled && remoteIsPrivate(request.socket.remoteAddress)), "REMOTE_CLIENT_FORBIDDEN", "The agent listener accepts only loopback or its acknowledged private managed proxy");
      const hostHeaders = request.headersDistinct?.host;
      assertQos(Array.isArray(hostHeaders) && hostHeaders.length === 1 && hostHeaders[0].length >= 1 && hostHeaders[0].length <= 255, "INVALID_HOST_HEADER", "Exactly one bounded Host header is required");
      assertQos(request.headers["transfer-encoding"] === undefined, "TRANSFER_ENCODING_FORBIDDEN", "Transfer-Encoding is not accepted");
      if (request.method === "GET") {
        const contentLengths = request.headersDistinct?.["content-length"];
        assertQos(contentLengths === undefined || (contentLengths.length === 1 && contentLengths[0] === "0"), "GET_BODY_FORBIDDEN", "GET requests may not contain a body");
      }
      assertQos(typeof request.url === "string" && request.url.startsWith("/") && !request.url.startsWith("//") && !request.url.includes("#"), "INVALID_REQUEST_TARGET", "HTTP request target must use origin form");
      const url = new URL(request.url, "http://qos.local");
      assertQos(url.search === "", "QUERY_STRING_NOT_ALLOWED", "Agent API routes do not accept query strings");
      expirePending();
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", service: "qos-agent-listener" });
        return;
      }
      if (url.pathname.startsWith("/v1/operator/")) {
        if (!operatorAuthorized(request, operatorToken)) {
          sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Operator Bearer credential is missing or invalid" } });
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/operator/requests") {
          sendJson(response, 200, {
            requests: [...pending.entries()].map(([id, item]) => ({
              id,
              agentId: item.agent.id,
              agentName: item.agent.name,
              action: item.action.action,
              amount: item.action.amount,
              destination: item.action.destination ?? null,
              inputMint: item.action.inputMint ?? null,
              outputMint: item.action.outputMint ?? null,
              strategyId: item.action.strategyId,
              expiresAt: new Date(item.expiresAt).toISOString(),
            })),
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/operator/status" && managedInstanceId !== null) {
          sendJson(response, 200, {
            status: "listening",
            instanceId: managedInstanceId,
            mainnetExecutionEnabled: service.policy.cluster !== "mainnet-beta" || enableMainnetBroadcast,
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/operator/shutdown" && managedInstanceId !== null) {
          const body = await readJson(request);
          assertQos(
            body && typeof body === "object" && !Array.isArray(body)
              && hasExactKeys(body, ["version", "instanceId"])
              && body.version === 1 && body.instanceId === managedInstanceId,
            "INVALID_OPERATOR_ACTION",
            "Managed shutdown request is invalid",
          );
          sendJson(response, 200, { status: "stopping" });
          setImmediate(() => server.emit("qos-shutdown"));
          return;
        }
        const match = /^\/v1\/operator\/requests\/([0-9a-f]{32})\/(approve|reject)$/.exec(url.pathname);
        if (request.method === "POST" && match) {
          const body = await readJson(request);
          assertQos(body && typeof body === "object" && !Array.isArray(body) && hasExactKeys(body, ["version"]) && body.version === 1, "INVALID_OPERATOR_ACTION", "Operator action must be exactly {\"version\":1}");
          const [requestId, decision] = match.slice(1);
          const item = pending.get(requestId);
          assertQos(item !== undefined, "PENDING_REQUEST_NOT_FOUND", "Pending request is missing or expired");
          pending.delete(requestId);
          if (decision === "reject") {
            sendJson(response, 200, { id: requestId, status: "rejected" });
            return;
          }
          sendJson(response, 200, { id: requestId, status: "executed", result: await execute(item.agent, item.action) });
          return;
        }
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Operator route not found" } });
        return;
      }

      let agent;
      try {
        agent = authenticateAgent(resolvedHome, bearer(request));
      } catch {
        sendJson(response, 401, { error: { code: "AGENT_UNAUTHORIZED", message: "Agent Bearer credential is missing, invalid, or revoked" } });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/skill")) {
        const pack = agentSkill(agent);
        if (url.pathname === "/skill") {
          sendBytes(response, 200, Buffer.from(pack.files["SKILL.md"], "utf8"), "text/markdown; charset=utf-8");
          return;
        }
        if (url.pathname === "/skill/manifest") {
          sendJson(response, 200, { ...pack.manifest, files: Object.keys(pack.files).sort() });
          return;
        }
        if (url.pathname === "/skill/download") {
          sendBytes(response, 200, buildSkillZip(pack.files), "application/zip", { filename: `qos-${agent.id}-trading-skill.zip` });
          return;
        }
        const skillFile = /^\/skill\/files\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(url.pathname);
        if (skillFile && Object.hasOwn(pack.files, skillFile[1])) {
          sendBytes(response, 200, Buffer.from(pack.files[skillFile[1]], "utf8"), skillFile[1].endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8");
          return;
        }
        sendJson(response, 404, { error: { code: "SKILL_FILE_NOT_FOUND", message: "Skill file not found" } });
        return;
      }
      if (url.pathname === "/mcp") {
        await handleMcp(request, response, agent);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        const skill = skillSummary(agent);
        sendJson(response, 200, {
          agent: publicRecord(agent),
          endpoint: "/v1/actions",
          mcpEndpoint: skill.mcpEndpoint,
          skillEndpoint: skill.endpoint,
          skillDownloadEndpoint: skill.downloadEndpoint,
          supportedActions: [...(agent.asset === "trading-only" ? [] : [agent.asset === "sol" ? "transfer_sol" : "transfer_qos"]), ...(agent.dexTrading ? ["swap"] : [])],
          dexTrading: agent.dexTrading ? publicDexTrading(resolvedHome) : null,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/actions") {
        const accepted = await acceptAction(agent, await readJson(request));
        sendJson(response, accepted.statusCode, accepted.value);
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Agent route not found" } });
    } catch (error) {
      const status = error?.code === "UNAUTHORIZED" || error?.code === "AGENT_UNAUTHORIZED" ? 401 : error instanceof QosError ? 400 : 500;
      sendJson(response, status, publicError(error));
    }
  });
  server.requestTimeout = 75_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  server.once("close", () => {
    operatorToken.fill(0);
    pending.clear();
    recentByAgent.clear();
  });
  server.listen(port, host);
  return server;
}
