import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { onboardAgent, validateAgentAction } from "../src/agent-registry.js";
import { decodeBase58, encodeBase58 } from "../src/base58.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../src/constants.js";
import { configureDexTrading, dexPaths } from "../src/dex.js";
import { ensureRuntimeProfile } from "../src/runtime-profile.js";
import { initializeSandbox, QosService } from "../src/service.js";
import { encodeShortVec } from "../src/transaction.js";

const INPUT_MINT = "So11111111111111111111111111111111111111112";
const OUTPUT_MINT = "5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump";
const RECEIVER = "2fwKS5Xj3c91cH7KZLbntMgrfGGbHiJcwt4g925x9pSy";

function mintAccount(owner, decimals = 6) {
  const bytes = Buffer.alloc(82);
  bytes.writeBigUInt64LE(1_000_000_000n, 36);
  bytes[44] = decimals;
  bytes[45] = 1;
  return { owner, data: [bytes.toString("base64"), "base64"] };
}

function dexRpc(policy) {
  return {
    getGenesisHash: async () => policy.clusterGenesis,
    getAccountInfo: async (address) => address === INPUT_MINT
      ? mintAccount(TOKEN_PROGRAM_ID, 9)
      : mintAccount(TOKEN_2022_PROGRAM_ID, 6),
  };
}

function versionedTransaction(signer) {
  const accounts = [decodeBase58(signer, 32), Buffer.alloc(32, 7)];
  const message = Buffer.concat([
    Buffer.from([0x80, 1, 0, 1]),
    encodeShortVec(accounts.length),
    ...accounts,
    Buffer.alloc(32, 8),
    encodeShortVec(1),
    Buffer.from([1]),
    encodeShortVec(1),
    Buffer.from([0]),
    encodeShortVec(1),
    Buffer.from([9]),
    encodeShortVec(0),
  ]);
  return Buffer.concat([encodeShortVec(1), Buffer.alloc(64), message]).toString("base64");
}

function jsonResponse(value, status = 200) {
  const body = JSON.stringify(value);
  return new Response(body, { status, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } });
}

function validOrder(service, amount = "1000") {
  return {
    mode: "manual",
    swapMode: "ExactIn",
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    inAmount: amount,
    outAmount: "600",
    otherAmountThreshold: "550",
    taker: service.publicKey,
    receiver: RECEIVER,
    router: "metis",
    gasless: false,
    signatureFeePayer: service.publicKey,
    prioritizationFeePayer: service.publicKey,
    rentFeePayer: null,
    slippageBps: 75,
    feeBps: 50,
    signatureFeeLamports: 5000,
    prioritizationFeeLamports: 1000,
    rentFeeLamports: 0,
    requestId: "order-request-1234",
    lastValidBlockHeight: "123456789",
    transaction: versionedTransaction(service.publicKey),
  };
}

function configuredProfile(t) {
  const root = mkdtempSync(join(tmpdir(), "qos-dex-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  initializeSandbox(home, "2HRxdPxxReP4PAHunxHD5mjPXWwBhnhYq4NowVEoLxg5", { cluster: "mainnet-beta" });
  ensureRuntimeProfile(home, { profile: "mainnet-insecure", acceptInsecureRisk: true });
  const keyFile = join(root, "jupiter.key");
  writeFileSync(keyFile, "jup-test-owner-key\n", { mode: 0o600 });
  configureDexTrading(home, {
    apiKeyFile: keyFile,
    receiver: RECEIVER,
    maxInputAmount: "2000",
    dailyInputLimit: "5000",
    maxSlippageBps: 75,
    maxRouteFeeBps: 100,
    maxFeeLamports: "5000000",
    minIntervalSeconds: 60,
    maxSwapsPerDay: 3,
  });
  return home;
}

test("BYOK Jupiter swap signs only a bounded one-signer v0 order and persists limits", async (t) => {
  const home = configuredProfile(t);
  const service = QosService.open(home);
  const calls = [];
  const order = validOrder(service);
  service.dexFetch = async (url, options) => {
    calls.push([String(url), options]);
    return calls.length === 1
      ? jsonResponse(order)
      : jsonResponse({ status: "Success", code: 0, signature: encodeBase58(Buffer.alloc(64, 12)), slot: "123", totalInputAmount: "1005", totalOutputAmount: "575" });
  };
  service.rpc = dexRpc(service.policy);
  const prior = process.env.QOS_ENABLE_MAINNET_BROADCAST;
  process.env.QOS_ENABLE_MAINNET_BROADCAST = "I_UNDERSTAND";
  try {
    const result = await service.executeDexSwap({ version: 2, action: "swap", inputMint: INPUT_MINT, outputMint: OUTPUT_MINT, amount: "1000", strategyId: 1 });
    assert.equal(result.status, "confirmed");
    assert.equal(result.totalInputAmount, "1005");
    assert.equal(result.totalOutputAmount, "575");
    assert.equal(result.receiver, RECEIVER);
    assert.match(result.explorerUrl, /^https:\/\/solscan\.io\/tx\//);
  } finally {
    if (prior === undefined) delete process.env.QOS_ENABLE_MAINNET_BROADCAST; else process.env.QOS_ENABLE_MAINNET_BROADCAST = prior;
  }
  const orderUrl = new URL(calls[0][0]);
  assert.equal(orderUrl.origin + orderUrl.pathname.replace(/\/order$/, ""), "https://api.jup.ag/swap/v2");
  assert.equal(orderUrl.searchParams.get("amount"), "1000");
  assert.equal(orderUrl.searchParams.get("receiver"), RECEIVER);
  assert.equal(orderUrl.searchParams.get("slippageBps"), "75");
  assert.equal(orderUrl.searchParams.get("excludeRouters"), "jupiterz");
  assert.equal(calls[0][1].headers["x-api-key"], "jup-test-owner-key");
  assert.deepEqual(Object.keys(JSON.parse(calls[1][1].body)).sort(), ["lastValidBlockHeight", "requestId", "signedTransaction"]);
  const state = JSON.parse(readFileSync(dexPaths(home).tradingState, "utf8"));
  assert.equal(state.tradeCount, 1);
  assert.equal(state.inputTotals[`${INPUT_MINT}>${OUTPUT_MINT}`], "1005");
});

test("a signed swap with an ambiguous execute failure conservatively reserves its budget", async (t) => {
  const home = configuredProfile(t);
  const service = QosService.open(home);
  let calls = 0;
  service.dexFetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(validOrder(service));
    throw new Error("simulated execute timeout");
  };
  service.rpc = dexRpc(service.policy);
  const prior = process.env.QOS_ENABLE_MAINNET_BROADCAST;
  process.env.QOS_ENABLE_MAINNET_BROADCAST = "I_UNDERSTAND";
  try {
    await assert.rejects(
      service.executeDexSwap({ version: 2, action: "swap", inputMint: INPUT_MINT, outputMint: OUTPUT_MINT, amount: "1000", strategyId: 1 }),
      /simulated execute timeout/,
    );
  } finally {
    if (prior === undefined) delete process.env.QOS_ENABLE_MAINNET_BROADCAST; else process.env.QOS_ENABLE_MAINNET_BROADCAST = prior;
  }
  const state = JSON.parse(readFileSync(dexPaths(home).tradingState, "utf8"));
  assert.equal(state.tradeCount, 1);
  assert.equal(state.inputTotals[`${INPUT_MINT}>${OUTPUT_MINT}`], "1005");
});

test("agent automatic trading scope accepts any Solana mint pair within firmware amount limits", (t) => {
  const home = configuredProfile(t);
  const policy = JSON.parse(readFileSync(join(home, "policy.json"), "utf8"));
  const agent = onboardAgent(home, {
    id: "trader",
    approvalMode: "auto",
    asset: "trading-only",
    maxAmount: "0",
    destination: policy.allowedDestinations[0],
    strategyId: 1,
    acceptAuto: true,
    enableDexTrading: true,
  });
  assert.equal(agent.dexTrading, true);
  const valid = { version: 2, action: "swap", inputMint: INPUT_MINT, outputMint: OUTPUT_MINT, amount: "1900", strategyId: 1 };
  assert.equal(validateAgentAction(home, { ...agent, tokenSha256: "0".repeat(64) }, valid).amount, "1900");
  assert.throws(() => validateAgentAction(home, { ...agent, tokenSha256: "0".repeat(64) }, { ...valid, amount: "2001" }), { code: "DEX_INPUT_LIMIT_EXCEEDED" });
  assert.equal(validateAgentAction(home, { ...agent, tokenSha256: "0".repeat(64) }, { ...valid, outputMint: encodeBase58(Buffer.alloc(32, 44)) }).outputMint, encodeBase58(Buffer.alloc(32, 44)));
});

test("execution rejects a syntactically valid address that is not a Solana token mint", async (t) => {
  const home = configuredProfile(t);
  const service = QosService.open(home);
  service.rpc = {
    getGenesisHash: async () => service.policy.clusterGenesis,
    getAccountInfo: async (address) => address === INPUT_MINT ? { owner: "11111111111111111111111111111111", data: [Buffer.alloc(82).toString("base64"), "base64"] } : mintAccount(TOKEN_2022_PROGRAM_ID),
  };
  const prior = process.env.QOS_ENABLE_MAINNET_BROADCAST;
  process.env.QOS_ENABLE_MAINNET_BROADCAST = "I_UNDERSTAND";
  try {
    await assert.rejects(service.executeDexSwap({ version: 2, action: "swap", inputMint: INPUT_MINT, outputMint: OUTPUT_MINT, amount: "1000", strategyId: 1 }), { code: "DEX_MINT_NOT_TOKEN" });
  } finally {
    if (prior === undefined) delete process.env.QOS_ENABLE_MAINNET_BROADCAST; else process.env.QOS_ENABLE_MAINNET_BROADCAST = prior;
  }
});
