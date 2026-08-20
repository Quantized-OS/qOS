import assert from "node:assert/strict";
import test from "node:test";

import { encodeBase58 } from "../src/base58.js";
import { DEXSCREENER_ORIGIN, marketDataSources, searchSolanaMarkets, solanaTokenMarkets } from "../src/market-data.js";

const MINT = encodeBase58(Buffer.alloc(32, 71));
const QUOTE = encodeBase58(Buffer.alloc(32, 72));
const PUMP_PAIR = encodeBase58(Buffer.alloc(32, 73));
const RAYDIUM_PAIR = encodeBase58(Buffer.alloc(32, 74));

function jsonResponse(value) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
  });
}

function pair({ pairAddress, dexId, liquidity }) {
  return {
    chainId: "solana",
    pairAddress,
    dexId,
    url: `https://dexscreener.com/solana/${pairAddress}`,
    baseToken: { address: MINT, symbol: "BOT", name: "Untrusted market text" },
    quoteToken: { address: QUOTE, symbol: "SOL", name: "Wrapped SOL" },
    priceUsd: "0.0123",
    priceNative: "0.0001",
    liquidity: { usd: liquidity },
    volume: { h24: 321.5 },
    txns: { h24: { buys: 3, sells: 2 } },
    priceChange: { h24: -1.25 },
    pairCreatedAt: 1_700_000_000_000,
  };
}

test("market discovery is pinned to DexScreener and filters Pump.fun-origin Solana pairs", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ pairs: [
      pair({ pairAddress: RAYDIUM_PAIR, dexId: "raydium", liquidity: 9_000 }),
      pair({ pairAddress: PUMP_PAIR, dexId: "pumpfun", liquidity: 100 }),
      { ...pair({ pairAddress: encodeBase58(Buffer.alloc(32, 75)), dexId: "pumpfun", liquidity: 99_000 }), chainId: "ethereum" },
    ] });
  };

  const result = await searchSolanaMarkets({ query: "BOT", source: "pumpfun", fetchImpl });
  assert.equal(result.resultCount, 1);
  assert.equal(result.pairs[0].pairAddress, PUMP_PAIR);
  assert.equal(result.pairs[0].launchpad, "pump.fun");
  assert.equal(new URL(calls[0].url).origin, DEXSCREENER_ORIGIN);
  assert.equal(new URL(calls[0].url).pathname, "/latest/dex/search");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(marketDataSources().map((source) => source.id), ["dexscreener", "pumpfun"]);
});

test("token lookup accepts only an exact mint and returns bounded normalized fields", async () => {
  let requested;
  const result = await solanaTokenMarkets({
    mint: MINT,
    fetchImpl: async (url) => {
      requested = String(url);
      return jsonResponse([pair({ pairAddress: RAYDIUM_PAIR, dexId: "raydium", liquidity: 500 })]);
    },
  });
  assert.equal(new URL(requested).pathname, `/token-pairs/v1/solana/${MINT}`);
  assert.equal(result.resultCount, 1);
  assert.deepEqual(Object.keys(result.pairs[0]).sort(), [
    "baseToken", "chainId", "dexId", "launchpad", "liquidityUsd", "pairAddress", "pairCreatedAt",
    "priceChange24hPercent", "priceNative", "priceUsd", "quoteToken", "source", "txns24h", "url", "volume24hUsd",
  ].sort());
  await assert.rejects(solanaTokenMarkets({ mint: "not-a-mint", fetchImpl: async () => assert.fail("must not fetch") }));
  await assert.rejects(searchSolanaMarkets({ query: "x", source: null, fetchImpl: async () => assert.fail("must not fetch") }), { code: "MARKET_DATA_SOURCE_INVALID" });
});

test("market discovery rejects oversized or non-JSON upstream responses", async () => {
  await assert.rejects(searchSolanaMarkets({
    query: "BOT",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: (name) => name === "content-type" ? "application/json" : "524289" },
      arrayBuffer: async () => assert.fail("declared oversized response must not be read"),
    }),
  }), { code: "MARKET_DATA_RESPONSE_TOO_LARGE" });

  await assert.rejects(searchSolanaMarkets({
    query: "BOT",
    fetchImpl: async () => new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
  }), { code: "MARKET_DATA_RESPONSE_INVALID" });
});
