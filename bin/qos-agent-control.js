#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  getAgent,
  listAgents,
  offboardAgent,
  onboardAgent,
} from "../src/agent-registry.js";
import {
  agentListenerStatus,
  clearAgentListenerState,
  startAgentDaemon,
  stopAgentDaemon,
  writeAgentListenerState,
} from "../src/agent-daemon.js";
import { startAgentServer } from "../src/agent-server.js";
import { publicError, QosError } from "../src/errors.js";
import { writeResult } from "../src/human-output.js";
import { loadPolicy } from "../src/policy.js";
import { loadRuntimeProfile } from "../src/runtime-profile.js";
import { readSecureFile } from "../src/secure-file.js";
import { QosService } from "../src/service.js";

const VALUE_OPTIONS = new Set([
  "--home", "--id", "--name", "--approval", "--asset", "--max-amount",
  "--destination", "--strategy-id", "--host", "--port", "--url",
  "--instance",
]);
const FLAG_OPTIONS = new Set(["--json", "--accept-auto", "--yes", "--confirm-live", "--daemon-child"]);
const OPTION_ALIASES = new Map([
  ["-H", "--home"], ["-j", "--json"], ["-I", "--id"], ["-N", "--name"],
  ["-A", "--approval"], ["-a", "--asset"], ["-M", "--max-amount"],
  ["-D", "--destination"], ["-S", "--strategy-id"], ["-p", "--port"],
]);

function usage() {
  return `qOS agent onboarding and control

Usage:
  qos agent onboard [options]
  qos agent list
  qos agent show ID
  qos agent skills ID
  qos agent offboard ID [--yes]
  qos agent start [--port 8790]
  qos agent status
  qos agent stop
  qos agent restart [--port 8790] [--confirm-live]
  qos agent requests
  qos agent approve|reject REQUEST_ID

Onboard options:
  -I, --id ID                 Stable lowercase agent ID
  -N, --name NAME             Human-readable name
  -A, --approval ask|auto     Ask the operator or execute automatically
  -a, --asset sol|qos-token   Exact transfer template the agent may use
  -M, --max-amount N          Maximum base units per request
  -D, --destination PUBKEY    Must already be in the qOS policy
  -S, --strategy-id ID        Must already be in the qOS policy
      --accept-auto           Required for unattended automatic execution
      --yes                   Accept the final onboarding summary

The onboarding wizard runs when required values are omitted in a terminal.
Each agent receives a private credential and a generated skill pack. Tokens are
never printed. The loopback REST and MCP service starts automatically after
onboarding. Mainnet execution remains disabled until restart --confirm-live.
`;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "-h" || raw === "--help") return { help: true };
    const token = OPTION_ALIASES.get(raw) ?? raw;
    if (VALUE_OPTIONS.has(token)) {
      if (values.has(token)) throw new QosError("DUPLICATE_ARGUMENT", `Duplicate ${token}`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", `${token} requires a value`);
      values.set(token, value);
    } else if (FLAG_OPTIONS.has(token)) {
      if (flags.has(token)) throw new QosError("DUPLICATE_ARGUMENT", `Duplicate ${token}`);
      flags.add(token);
    } else if (token.startsWith("-")) {
      throw new QosError("INVALID_ARGUMENT", `Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  const home = values.get("--home") ?? process.env.QOS_HOME;
  if (typeof home !== "string") throw new QosError("MISSING_RUNTIME_PROFILE", "Use --home or QOS_HOME to select an installed qOS profile");
  return { help: false, home: resolve(home), values, flags, positional, json: flags.has("--json") };
}

function parseStrategy(value) {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new QosError("INVALID_STRATEGY_ID", "--strategy-id must be a canonical non-negative integer");
  const number = Number(value);
  if (!Number.isInteger(number) || number > 0xffffffff) throw new QosError("INVALID_STRATEGY_ID", "--strategy-id must fit in u32");
  return number;
}

function assertOptionSurface(options, valueOptions = [], flagOptions = []) {
  const allowedValues = new Set(["--home", ...valueOptions]);
  const allowedFlags = new Set(["--json", ...flagOptions]);
  const invalidValues = [...options.values.keys()].filter((name) => !allowedValues.has(name));
  const invalidFlags = [...options.flags].filter((name) => !allowedFlags.has(name));
  if (invalidValues.length || invalidFlags.length) {
    throw new QosError("INVALID_ARGUMENT", `Option(s) not valid for this command: ${[...invalidValues, ...invalidFlags].join(", ")}`);
  }
}

async function ask(terminal, question, fallback = undefined) {
  const suffix = fallback === undefined ? "" : ` [${fallback}]`;
  const answer = (await terminal.question(`${question}${suffix}: `)).trim();
  return answer === "" ? fallback : answer;
}

function enabledAgentAssets(policy) {
  const assets = [];
  if (BigInt(policy.maxTransferLamports) > 0n) assets.push("sol");
  if (policy.tokenTransfer !== null && BigInt(policy.tokenTransfer.maxTransferAmount) > 0n) assets.push("qos-token");
  if (assets.length === 0) throw new QosError("AGENT_ASSET_DISABLED", "This profile has no transfer template enabled for an agent");
  return assets;
}

function assetLabel(asset) {
  return asset === "sol" ? "native SOL transfer" : "qOS Token-2022 transfer";
}

function maximumForAsset(policy, asset) {
  return asset === "sol" ? policy.maxTransferLamports : policy.tokenTransfer?.maxTransferAmount;
}

function assertAssetEnabled(asset, enabledAssets) {
  if (!enabledAssets.includes(asset)) {
    throw new QosError(
      "AGENT_ASSET_DISABLED",
      `Asset ${asset} is disabled by this profile. Enabled agent asset${enabledAssets.length === 1 ? "" : "s"}: ${enabledAssets.join(", ")}`,
    );
  }
}

async function onboardingOptions(options) {
  const runtime = loadRuntimeProfile(options.home);
  const policy = loadPolicy(`${options.home}/policy.json`);
  const enabledAssets = enabledAgentAssets(policy);
  const preferredAsset = runtime.profile === "devnet" ? "sol" : "qos-token";
  const defaultAsset = enabledAssets.includes(preferredAsset) ? preferredAsset : enabledAssets[0];
  const defaults = {
    name: undefined,
    approvalMode: "ask",
    asset: defaultAsset,
    destination: policy.allowedDestinations[0],
    strategyId: policy.allowedStrategyIds[0],
  };
  const result = {
    id: options.values.get("--id"),
    name: options.values.get("--name"),
    approvalMode: options.values.get("--approval"),
    asset: options.values.get("--asset"),
    maxAmount: options.values.get("--max-amount"),
    destination: options.values.get("--destination"),
    strategyId: parseStrategy(options.values.get("--strategy-id")),
    acceptAuto: options.flags.has("--accept-auto"),
  };
  if (result.asset !== undefined) assertAssetEnabled(result.asset, enabledAssets);
  const missing = result.id === undefined || result.maxAmount === undefined;
  if (missing && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new QosError("MISSING_ARGUMENT", "Unattended onboarding requires --id and --max-amount; other scope values use the current policy defaults");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const selectedAsset = result.asset ?? defaultAsset;
    return {
      ...defaults,
      asset: selectedAsset,
      ...Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)),
    };
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\nAgent onboarding\n----------------\nqOS will issue a revocable credential and restrict it below the active policy.\n");
    result.id = result.id ?? await ask(terminal, "Agent ID (lowercase letters, digits, hyphens)");
    result.name = result.name ?? await ask(terminal, "Agent name", result.id);
    result.approvalMode = result.approvalMode ?? await ask(terminal, "Execution mode (ask or auto)", defaults.approvalMode);
    if (result.asset === undefined && enabledAssets.length === 1) {
      result.asset = enabledAssets[0];
      process.stdout.write(`Allowed action: ${assetLabel(result.asset)} (${result.asset}); this is the only enabled transfer template.\n`);
    } else if (result.asset === undefined) {
      while (result.asset === undefined) {
        const candidate = await ask(terminal, `Allowed asset (${enabledAssets.join(" or ")})`, defaultAsset);
        if (enabledAssets.includes(candidate)) result.asset = candidate;
        else process.stdout.write(`Choose an enabled asset: ${enabledAssets.join(", ")}\n`);
      }
    }
    assertAssetEnabled(result.asset, enabledAssets);
    result.maxAmount = result.maxAmount ?? await ask(terminal, "Maximum base units per request", maximumForAsset(policy, result.asset));
    result.destination = result.destination ?? await ask(terminal, "Allowed destination", defaults.destination);
    if (result.strategyId === undefined) result.strategyId = parseStrategy(await ask(terminal, "Allowed strategy ID", String(defaults.strategyId)));
    if (result.approvalMode === "auto" && !result.acceptAuto) {
      process.stdout.write("Automatic mode may sign and broadcast every valid in-policy request while the listener is live.\n");
      const answer = await ask(terminal, "Type accept-auto to enable automatic execution");
      result.acceptAuto = answer === "accept-auto";
    }
    if (!options.flags.has("--yes")) {
      const answer = await ask(terminal, "Create this agent? Type yes to continue");
      if (answer?.toLowerCase() !== "yes") throw new QosError("AGENT_ONBOARDING_CANCELLED", "Agent was not created");
    }
  } finally {
    terminal.close();
  }
  return result;
}

async function confirmOffboard(options, id) {
  if (options.flags.has("--yes")) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new QosError("OFFBOARD_CONFIRMATION_REQUIRED", "Unattended offboarding requires --yes");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Revoke agent ${id} and delete its local credential? Type yes to continue: `);
    if (answer.trim().toLowerCase() !== "yes") throw new QosError("AGENT_OFFBOARDING_CANCELLED", "Agent was not offboarded");
  } finally {
    terminal.close();
  }
}

function validateListenerUrl(text) {
  let url;
  try { url = new URL(text); } catch { throw new QosError("INVALID_AGENT_URL", "Agent listener URL is invalid"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new QosError("INVALID_AGENT_URL", "Agent listener URL must be a plain loopback origin such as http://127.0.0.1:8790");
  }
  return url.origin;
}

function operatorToken(runtime) {
  const bytes = readSecureFile(runtime.apiTokenFile, {
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
  return token;
}

async function boundedResponse(response) {
  const contentType = response.headers.get("content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new QosError("AGENT_RESPONSE_INVALID", "Agent listener response must use application/json");
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding !== "identity") {
    throw new QosError("AGENT_RESPONSE_INVALID", "Compressed agent listener responses are not accepted");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > 256 * 1024)) {
    throw new QosError("AGENT_RESPONSE_TOO_LARGE", "Agent listener response length is invalid or too large");
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 256 * 1024) throw new QosError("AGENT_RESPONSE_TOO_LARGE", "Agent listener response exceeds 256 KiB");
      chunks.push(Buffer.from(chunk));
    }
    if (declaredLength !== null && length !== Number(declaredLength)) throw new QosError("AGENT_RESPONSE_INVALID", "Agent listener response length does not match Content-Length");
    const body = Buffer.concat(chunks);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } finally { body.fill(0); }
  } catch (error) {
    if (error instanceof QosError) throw error;
    throw new QosError("AGENT_RESPONSE_INVALID", "Agent listener returned an invalid response");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function operatorRequest(options, path, method = "GET") {
  const runtime = loadRuntimeProfile(options.home);
  const token = operatorToken(runtime);
  const url = `${validateListenerUrl(options.values.get("--url") ?? "http://127.0.0.1:8790")}${path}`;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token.toString("utf8")}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: '{"version":1}' } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(75_000),
    });
    const value = await boundedResponse(response);
    if (!response.ok) throw new QosError(value?.error?.code ?? "AGENT_LISTENER_ERROR", value?.error?.message ?? `Agent listener returned HTTP ${response.status}`);
    return value;
  } catch (error) {
    if (error instanceof QosError) throw error;
    throw new QosError("AGENT_LISTENER_UNAVAILABLE", "Could not reach the loopback qOS agent listener");
  } finally {
    token.fill(0);
  }
}

async function listen(options) {
  const runtime = loadRuntimeProfile(options.home);
  if (runtime.signerCommand !== null) process.env.QOS_SIGNER_COMMAND = runtime.signerCommand;
  const service = QosService.open(options.home);
  const host = options.values.get("--host") ?? "127.0.0.1";
  const portText = options.values.get("--port") ?? "8790";
  if (!/^[1-9][0-9]*$/.test(portText)) throw new QosError("INVALID_PORT", "--port must be between 1 and 65535");
  const port = Number(portText);
  if (!Number.isInteger(port) || port > 65535) throw new QosError("INVALID_PORT", "--port must be between 1 and 65535");
  const live = options.flags.has("--confirm-live");
  const daemonChild = options.flags.has("--daemon-child");
  const instanceId = options.values.get("--instance");
  if (daemonChild) {
    if (typeof instanceId !== "string" || !/^[0-9a-f]{64}$/.test(instanceId)) throw new QosError("INVALID_AGENT_LISTENER_INSTANCE", "Managed listener child requires a valid instance ID");
  } else if (instanceId !== undefined) {
    throw new QosError("INVALID_ARGUMENT", "--instance is reserved for a managed listener child");
  }
  if (live && service.policy.cluster === "mainnet-beta") process.env.QOS_ENABLE_MAINNET_BROADCAST = "I_UNDERSTAND";
  const server = startAgentServer(service, {
    home: options.home,
    host,
    port,
    apiTokenFile: runtime.apiTokenFile,
    enableMainnetBroadcast: live,
    managedInstanceId: daemonChild ? instanceId : null,
  });
  await new Promise((resolveReady, reject) => {
    server.once("listening", resolveReady);
    server.once("error", reject);
  });
  const actualAddress = server.address();
  const actualPort = typeof actualAddress === "object" && actualAddress !== null ? actualAddress.port : port;
  if (daemonChild) {
    writeAgentListenerState(options.home, {
      instanceId,
      host,
      port: actualPort,
      mainnetExecutionEnabled: service.policy.cluster !== "mainnet-beta" || live,
    });
  }
  const address = `http://${host === "::1" ? "[::1]" : host}:${actualPort}`;
  writeResult({
    status: "listening",
    address,
    restEndpoint: `${address}/v1/actions`,
    mcpEndpoint: `${address}/mcp`,
    cluster: service.policy.cluster,
    agents: listAgents(options.home).length,
    mainnetExecutionEnabled: service.policy.cluster !== "mainnet-beta" || live,
    pendingApprovals: "memory-only",
  }, { json: options.json, title: "qOS agent listener" });
  const close = () => server.close(() => {
    if (daemonChild) clearAgentListenerState(options.home, instanceId);
    service.session.dispose();
    process.exit(0);
  });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  server.once("qos-shutdown", close);
}

async function main() {
  process.umask(0o077);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const [command = "list", ...rest] = options.positional;
  let result;
  if (command === "onboard") {
    assertOptionSurface(options, ["--id", "--name", "--approval", "--asset", "--max-amount", "--destination", "--strategy-id"], ["--accept-auto", "--yes"]);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "agent onboard accepts options, not positional values");
    const agent = onboardAgent(options.home, await onboardingOptions(options));
    const listener = process.env.QOS_AGENT_AUTOSERVE === "0"
      ? { status: "disabled", reason: "QOS_AGENT_AUTOSERVE=0" }
      : await startAgentDaemon(options.home, { port: process.env.QOS_AGENT_PORT ?? 8790 });
    result = { ...agent, listener };
  } else if (command === "list") {
    assertOptionSurface(options);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "agent list accepts no arguments");
    result = { agents: listAgents(options.home), listener: await agentListenerStatus(options.home) };
  } else if (command === "show" || command === "skills") {
    assertOptionSurface(options);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", `agent ${command} requires one agent ID`);
    const agent = getAgent(options.home, rest[0]);
    result = command === "skills" ? {
      agentId: agent.id,
      skillsDirectory: agent.skillsDirectory,
      tokenFile: agent.tokenFile,
      mcpEndpoint: "http://127.0.0.1:8790/mcp",
      instruction: "Give the agent read access only to its skills directory and token file; never paste the token into a prompt.",
    } : agent;
  } else if (command === "offboard") {
    assertOptionSurface(options, [], ["--yes"]);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "agent offboard requires one agent ID");
    await confirmOffboard(options, rest[0]);
    result = offboardAgent(options.home, rest[0]);
    if (result.remainingAgents === 0) result.listener = await stopAgentDaemon(options.home);
  } else if (command === "start" || command === "restart") {
    assertOptionSurface(options, ["--host", "--port"], ["--confirm-live"]);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", `agent ${command} accepts options, not positional values`);
    if (listAgents(options.home).length === 0) throw new QosError("NO_AGENTS_ONBOARDED", "Onboard an agent first; qOS starts the REST and MCP service automatically after creation");
    if (command === "restart") await stopAgentDaemon(options.home);
    result = await startAgentDaemon(options.home, {
      host: options.values.get("--host") ?? "127.0.0.1",
      port: options.values.get("--port") ?? "8790",
      confirmLive: options.flags.has("--confirm-live"),
    });
  } else if (command === "status") {
    assertOptionSurface(options);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "agent status accepts no arguments");
    result = await agentListenerStatus(options.home);
  } else if (command === "stop") {
    assertOptionSurface(options);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "agent stop accepts no arguments");
    result = await stopAgentDaemon(options.home);
  } else if (command === "listen") {
    assertOptionSurface(options, ["--host", "--port", "--instance"], ["--confirm-live", "--daemon-child"]);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "agent listen accepts options, not positional values");
    await listen(options);
    return;
  } else if (command === "requests") {
    assertOptionSurface(options, ["--url"]);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "agent requests accepts no arguments");
    result = await operatorRequest(options, "/v1/operator/requests");
  } else if (command === "approve" || command === "reject") {
    assertOptionSurface(options, ["--url"]);
    if (rest.length !== 1 || !/^[0-9a-f]{32}$/.test(rest[0])) throw new QosError("INVALID_ARGUMENT", `agent ${command} requires one 32-character request ID`);
    result = await operatorRequest(options, `/v1/operator/requests/${rest[0]}/${command}`, "POST");
  } else {
    throw new QosError("UNKNOWN_COMMAND", `Unknown agent command: ${command}`);
  }
  writeResult(result, { json: options.json, title: "qOS agent control" });
}

main().catch((error) => {
  const json = process.argv.includes("--json") || process.argv.includes("-j");
  if (json) process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  else process.stderr.write(`qOS error [${error?.code ?? "INTERNAL_ERROR"}]: ${error instanceof QosError ? error.message : "The request failed closed"}\n`);
  process.exitCode = 1;
});
