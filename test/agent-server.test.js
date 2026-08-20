import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { agentPaths, offboardAgent, onboardAgent } from "../src/agent-registry.js";
import { MCP_PROTOCOL_VERSION, startAgentServer } from "../src/agent-server.js";
import { encodeBase58 } from "../src/base58.js";
import { configureDexTrading } from "../src/dex.js";
import { loadPolicy } from "../src/policy.js";
import { setPolicyField } from "../src/policy-store.js";
import { ensureRuntimeProfile } from "../src/runtime-profile.js";
import { initializeSandbox } from "../src/service.js";

function profile(t) {
  const root = mkdtempSync(join(tmpdir(), "qos-agent-server-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  initializeSandbox(home);
  const runtime = ensureRuntimeProfile(home, { profile: "devnet" });
  return { home, runtime };
}

async function request(url, token, { method = "GET", body = undefined } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: await response.json() };
}

async function mcpRequest(origin, token, body, { method = body.method, name = body.params?.name, requestOrigin = "http://127.0.0.1:43210" } = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
      ...(requestOrigin === null ? {} : { origin: requestOrigin }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
}

test("managed Docker proxy bind requires both the option and environment acknowledgement", async (t) => {
  const { home, runtime } = profile(t);
  const service = { policy: loadPolicy(join(home, "policy.json")) };
  assert.throws(() => startAgentServer(service, {
    home,
    host: "0.0.0.0",
    port: 0,
    apiTokenFile: runtime.apiTokenFile,
    managedProxy: true,
  }), { code: "LOOPBACK_REQUIRED" });

  const previous = process.env.QOS_ENABLE_MANAGED_PROXY;
  process.env.QOS_ENABLE_MANAGED_PROXY = "I_UNDERSTAND";
  t.after(() => {
    if (previous === undefined) delete process.env.QOS_ENABLE_MANAGED_PROXY;
    else process.env.QOS_ENABLE_MANAGED_PROXY = previous;
  });
  const server = startAgentServer(service, {
    home,
    host: "0.0.0.0",
    port: 0,
    apiTokenFile: runtime.apiTokenFile,
    managedProxy: true,
  });
  t.after(() => server.close());
  if (!server.listening) await once(server, "listening");
  assert.equal(typeof server.address().port, "number");
});

test("agent listener separates agent credentials from memory-only operator approvals", async (t) => {
  const { home, runtime } = profile(t);
  const policy = loadPolicy(join(home, "policy.json"));
  const destination = policy.allowedDestinations[0];
  const askAgent = onboardAgent(home, {
    id: "ask-bot",
    approvalMode: "ask",
    asset: "sol",
    maxAmount: "1000",
    destination,
    strategyId: 1,
  });
  const autoAgent = onboardAgent(home, {
    id: "auto-bot",
    approvalMode: "auto",
    asset: "sol",
    maxAmount: "1000",
    destination,
    strategyId: 1,
    acceptAuto: true,
  });
  const prepared = [];
  const submitted = [];
  const service = {
    policy,
    async prepareIntent(options) {
      prepared.push(options);
      return { type: "native-intent", ...options };
    },
    async prepareTokenIntent() {
      assert.fail("Devnet agent must not reach token preparation");
    },
    async submitIntent(intent) {
      submitted.push(intent);
      return { signature: `synthetic-${submitted.length}`, destination: intent.destination };
    },
  };
  const server = startAgentServer(service, {
    home,
    host: "127.0.0.1",
    port: 0,
    apiTokenFile: runtime.apiTokenFile,
  });
  t.after(() => server.close());
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const operatorToken = readFileSync(runtime.apiTokenFile, "ascii").trim();
  const askToken = readFileSync(askAgent.tokenFile, "ascii").trim();
  const autoToken = readFileSync(autoAgent.tokenFile, "ascii").trim();
  const action = { version: 1, action: "transfer_sol", amount: "99", destination, strategyId: 1 };

  const pending = await request(`${origin}/v1/actions`, askToken, { method: "POST", body: action });
  assert.equal(pending.status, 202);
  assert.equal(pending.value.status, "pending-approval");
  assert.equal(prepared.length, 0);
  const listed = await request(`${origin}/v1/operator/requests`, operatorToken);
  assert.equal(listed.value.requests.length, 1);
  assert.equal(listed.value.requests[0].amount, "99");
  assert.equal(JSON.stringify(listed.value).includes(askToken), false);

  const approved = await request(`${origin}/v1/operator/requests/${pending.value.requestId}/approve`, operatorToken, {
    method: "POST",
    body: { version: 1 },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.value.status, "executed");
  assert.equal(submitted.length, 1);

  const automatic = await request(`${origin}/v1/actions`, autoToken, { method: "POST", body: action });
  assert.equal(automatic.status, 200);
  assert.equal(automatic.value.status, "executed");
  assert.equal(submitted.length, 2);

  const forbidden = await request(`${origin}/v1/actions`, autoToken, {
    method: "POST",
    body: { ...action, destination: "11111111111111111111111111111111" },
  });
  assert.equal(forbidden.status, 400);
  assert.equal(forbidden.value.error.code, "AGENT_DESTINATION_FORBIDDEN");

  setPolicyField(home, "max-sol-lamports", "90000000");
  const staleListener = await request(`${origin}/v1/actions`, autoToken, { method: "POST", body: action });
  assert.equal(staleListener.status, 400);
  assert.equal(staleListener.value.error.code, "POLICY_RELOAD_REQUIRED");
});

test("offboarding revokes new and already-pending agent requests", async (t) => {
  const { home, runtime } = profile(t);
  const policy = loadPolicy(join(home, "policy.json"));
  const agent = onboardAgent(home, {
    id: "revoked-bot",
    approvalMode: "ask",
    asset: "sol",
    maxAmount: "1000",
    destination: policy.allowedDestinations[0],
    strategyId: 1,
  });
  let submissions = 0;
  const service = {
    policy,
    async prepareIntent(options) { return options; },
    async submitIntent() { submissions += 1; return { signature: "never" }; },
  };
  const server = startAgentServer(service, { home, port: 0, apiTokenFile: runtime.apiTokenFile });
  t.after(() => server.close());
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const operatorToken = readFileSync(runtime.apiTokenFile, "ascii").trim();
  const token = readFileSync(agentPaths(home, agent.id).token, "ascii").trim();
  const action = { version: 1, action: "transfer_sol", amount: "1", destination: agent.destination, strategyId: 1 };
  const pending = await request(`${origin}/v1/actions`, token, { method: "POST", body: action });
  offboardAgent(home, agent.id);
  const denied = await request(`${origin}/v1/actions`, token, { method: "POST", body: action });
  assert.equal(denied.status, 401);
  const approval = await request(`${origin}/v1/operator/requests/${pending.value.requestId}/approve`, operatorToken, {
    method: "POST",
    body: { version: 1 },
  });
  assert.equal(approval.status, 400);
  assert.equal(approval.value.error.code, "AGENT_NOT_FOUND");
  assert.equal(submissions, 0);
});

test("automatic mainnet agents cannot even prepare until the operator starts live mode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-agent-mainnet-listener-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  const destination = encodeBase58(Buffer.alloc(32, 121));
  initializeSandbox(home, destination, { cluster: "mainnet-beta" });
  const runtime = ensureRuntimeProfile(home, { profile: "mainnet-insecure", acceptInsecureRisk: true });
  const agent = onboardAgent(home, {
    id: "mainnet-bot",
    approvalMode: "auto",
    asset: "qos-token",
    maxAmount: "1000",
    destination,
    strategyId: 1,
    acceptAuto: true,
  });
  const policy = loadPolicy(join(home, "policy.json"));
  let preparations = 0;
  const service = {
    policy,
    async prepareTokenIntent() { preparations += 1; return {}; },
    async submitIntent() { assert.fail("mainnet submit must remain disabled"); },
  };
  const server = startAgentServer(service, {
    home,
    port: 0,
    apiTokenFile: runtime.apiTokenFile,
    enableMainnetBroadcast: false,
  });
  t.after(() => server.close());
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = readFileSync(agent.tokenFile, "ascii").trim();
  const denied = await request(`${origin}/v1/actions`, token, {
    method: "POST",
    body: { version: 1, action: "transfer_qos", amount: "1", destination, strategyId: 1 },
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.value.error.code, "LIVE_CONFIRMATION_REQUIRED");
  assert.equal(preparations, 0);
});

test("authenticated MCP tools reuse agent scope and the memory-only approval queue", async (t) => {
  const { home, runtime } = profile(t);
  const policy = loadPolicy(join(home, "policy.json"));
  const agent = onboardAgent(home, {
    id: "mcp-bot",
    approvalMode: "ask",
    asset: "sol",
    maxAmount: "321",
    destination: policy.allowedDestinations[0],
    strategyId: 1,
  });
  const service = {
    policy,
    async prepareIntent() { assert.fail("ask-mode MCP call must wait for operator approval"); },
    async submitIntent() { assert.fail("ask-mode MCP call must not submit"); },
  };
  const server = startAgentServer(service, { home, port: 0, apiTokenFile: runtime.apiTokenFile });
  t.after(() => server.close());
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = readFileSync(agent.tokenFile, "ascii").trim();
  const meta = { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION };

  const listed = await mcpRequest(origin, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { _meta: meta },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.value.result.tools.map((tool) => tool.name), ["qos_capabilities", "qos_get_trading_skill", "qos_request_transfer"]);
  assert.equal(listed.value.result.tools[2].inputSchema.required[0], "amount");
  assert.equal(JSON.stringify(listed.value).includes(token), false);

  const resources = await mcpRequest(origin, token, {
    jsonrpc: "2.0",
    id: "resources",
    method: "resources/list",
    params: { _meta: meta },
  });
  assert.equal(resources.status, 200);
  assert.ok(resources.value.result.resources.some((resource) => resource.uri === "qos://skill/SKILL.md"));

  const skillUri = "qos://skill/SKILL.md";
  const skillResource = await mcpRequest(origin, token, {
    jsonrpc: "2.0",
    id: "skill-resource",
    method: "resources/read",
    params: { uri: skillUri, _meta: meta },
  }, { name: skillUri });
  assert.match(skillResource.value.result.contents[0].text, /qOS Solana trading skill/);

  const skillResponse = await fetch(`${origin}/skill`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(skillResponse.status, 200);
  assert.match(await skillResponse.text(), /qOS Solana trading skill/);
  const skillDownload = await fetch(`${origin}/skill/download`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(skillDownload.status, 200);
  assert.equal(skillDownload.headers.get("content-type"), "application/zip");
  assert.equal(Buffer.from(await skillDownload.arrayBuffer()).subarray(0, 4).toString("hex"), "504b0304");

  const called = await mcpRequest(origin, token, {
    jsonrpc: "2.0",
    id: "transfer-1",
    method: "tools/call",
    params: { name: "qos_request_transfer", arguments: { amount: "300" }, _meta: meta },
  });
  assert.equal(called.status, 200);
  assert.equal(called.value.result.structuredContent.status, "pending-approval");
  assert.equal(called.value.result.isError, undefined);

  const operatorToken = readFileSync(runtime.apiTokenFile, "ascii").trim();
  const pending = await request(`${origin}/v1/operator/requests`, operatorToken);
  assert.equal(pending.value.requests.length, 1);
  assert.equal(pending.value.requests[0].amount, "300");
  assert.equal(pending.value.requests[0].destination, agent.destination);

  const mismatch = await mcpRequest(origin, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "qos_request_transfer", arguments: { amount: "1" }, _meta: meta },
  }, { name: "qos_capabilities" });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.value.error.code, -32020);

  const foreignOrigin = await mcpRequest(origin, token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: { _meta: meta },
  }, { requestOrigin: "https://attacker.example" });
  assert.equal(foreignOrigin.status, 400);
  assert.equal(foreignOrigin.value.error.code, -32600);
});

test("Raydium-only MCP advertises discovery and only its configured execution venue", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-agent-raydium-mcp-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  const destination = encodeBase58(Buffer.alloc(32, 122));
  initializeSandbox(home, destination, { cluster: "mainnet-beta" });
  const runtime = ensureRuntimeProfile(home, { profile: "mainnet-insecure", acceptInsecureRisk: true });
  configureDexTrading(home, { venues: ["raydium"] });
  const policy = loadPolicy(join(home, "policy.json"));
  const agent = onboardAgent(home, {
    id: "raydium-mcp",
    approvalMode: "auto",
    asset: "trading-only",
    maxAmount: "0",
    destination,
    strategyId: 1,
    acceptAuto: true,
    enableDexTrading: true,
  });
  const server = startAgentServer({ policy }, { home, port: 0, apiTokenFile: runtime.apiTokenFile });
  t.after(() => server.close());
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = readFileSync(agent.tokenFile, "ascii").trim();
  const meta = { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION };
  const listed = await mcpRequest(origin, token, {
    jsonrpc: "2.0",
    id: "raydium-tools",
    method: "tools/list",
    params: { _meta: meta },
  });
  assert.deepEqual(listed.value.result.tools.map((tool) => tool.name), [
    "qos_capabilities",
    "qos_get_trading_skill",
    "qos_search_markets",
    "qos_token_markets",
    "qos_request_swap",
  ]);
  assert.deepEqual(listed.value.result.tools.at(-1).inputSchema.properties.venue.enum, ["raydium"]);
  const capabilities = await mcpRequest(origin, token, {
    jsonrpc: "2.0",
    id: "raydium-capabilities",
    method: "tools/call",
    params: { name: "qos_capabilities", arguments: {}, _meta: meta },
  });
  assert.deepEqual(capabilities.value.result.structuredContent.dexTrading.venues, ["raydium"]);
  assert.deepEqual(capabilities.value.result.structuredContent.marketData.map((source) => source.id), ["dexscreener", "pumpfun"]);
});
