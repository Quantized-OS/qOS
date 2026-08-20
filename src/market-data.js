import { decodeBase58 } from "./base58.js";
import { assertQos, QosError } from "./errors.js";

export const DEXSCREENER_ORIGIN = "https://api.dexscreener.com";
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESULTS = 25;
const SOURCES = new Set(["all", "dexscreener", "pumpfun"]);

function boundedText(value, maximum, fallback = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\x00-\x1f\x7f]/u.test(value)) return fallback;
  return value;
}

function decimal(value) {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text) && text.length <= 64 ? text : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function boundedJson(response, operation) {
  assertQos(response && typeof response.arrayBuffer === "function" && Number.isInteger(response.status), "MARKET_DATA_RESPONSE_INVALID", `${operation} returned an invalid response`);
  const type = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
  assertQos(type.startsWith("application/json"), "MARKET_DATA_RESPONSE_INVALID", `${operation} returned a non-JSON response`);
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) assertQos(/^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= MAX_RESPONSE_BYTES, "MARKET_DATA_RESPONSE_TOO_LARGE", `${operation} response exceeded 512 KiB`);
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    assertQos(bytes.length <= MAX_RESPONSE_BYTES, "MARKET_DATA_RESPONSE_TOO_LARGE", `${operation} response exceeded 512 KiB`);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new QosError("MARKET_DATA_RESPONSE_INVALID", `${operation} returned invalid JSON`); }
    assertQos(response.ok === true, "MARKET_DATA_UNAVAILABLE", `${operation} rejected the request`, { statusCode: response.status });
    return value;
  } finally {
    bytes.fill(0);
  }
}

function normalizedToken(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const address = boundedText(value.address, 64);
  if (address === null) return null;
  try { decodeBase58(address, 32); } catch { return null; }
  return {
    address,
    symbol: boundedText(value.symbol, 24),
    name: boundedText(value.name, 96),
  };
}

function normalizePair(pair) {
  if (!pair || typeof pair !== "object" || Array.isArray(pair) || pair.chainId !== "solana") return null;
  const pairAddress = boundedText(pair.pairAddress, 64);
  const dexId = boundedText(pair.dexId, 40);
  const baseToken = normalizedToken(pair.baseToken);
  const quoteToken = normalizedToken(pair.quoteToken);
  if (pairAddress === null || dexId === null || baseToken === null || quoteToken === null) return null;
  try { decodeBase58(pairAddress, 32); } catch { return null; }
  const url = boundedText(pair.url, 512);
  let publicUrl = null;
  if (url !== null) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && parsed.hostname === "dexscreener.com" && parsed.username === "" && parsed.password === "") publicUrl = parsed.href;
    } catch {}
  }
  return {
    source: "dexscreener",
    chainId: "solana",
    dexId,
    launchpad: dexId.toLowerCase().includes("pump") ? "pump.fun" : null,
    pairAddress,
    url: publicUrl,
    baseToken,
    quoteToken,
    priceUsd: decimal(pair.priceUsd),
    priceNative: decimal(pair.priceNative),
    liquidityUsd: finiteNumber(pair.liquidity?.usd),
    volume24hUsd: finiteNumber(pair.volume?.h24),
    txns24h: {
      buys: Number.isSafeInteger(pair.txns?.h24?.buys) && pair.txns.h24.buys >= 0 ? pair.txns.h24.buys : null,
      sells: Number.isSafeInteger(pair.txns?.h24?.sells) && pair.txns.h24.sells >= 0 ? pair.txns.h24.sells : null,
    },
    priceChange24hPercent: typeof pair.priceChange?.h24 === "number" && Number.isFinite(pair.priceChange.h24) ? pair.priceChange.h24 : null,
    pairCreatedAt: Number.isSafeInteger(pair.pairCreatedAt) && pair.pairCreatedAt > 0 ? new Date(pair.pairCreatedAt).toISOString() : null,
  };
}

function normalizePairs(value, source) {
  const records = Array.isArray(value) ? value : Array.isArray(value?.pairs) ? value.pairs : [];
  return records
    .map(normalizePair)
    .filter((pair) => pair !== null && (source !== "pumpfun" || pair.launchpad === "pump.fun"))
    .sort((left, right) => (right.liquidityUsd ?? -1) - (left.liquidityUsd ?? -1))
    .slice(0, MAX_RESULTS);
}

function selectedSource(source) {
  const value = source === undefined ? "all" : source;
  assertQos(SOURCES.has(value), "MARKET_DATA_SOURCE_INVALID", "Market source must be all, dexscreener, or pumpfun");
  return value;
}

export async function searchSolanaMarkets({ query, source = "all", fetchImpl = globalThis.fetch } = {}) {
  assertQos(typeof query === "string" && query.trim().length >= 1 && query.trim().length <= 80 && !/[\x00-\x1f\x7f]/u.test(query), "MARKET_DATA_QUERY_INVALID", "Market query must contain 1 to 80 printable characters");
  assertQos(typeof fetchImpl === "function", "MARKET_DATA_UNAVAILABLE", "Market-data fetch is unavailable");
  const selected = selectedSource(source);
  const url = new URL("/latest/dex/search", DEXSCREENER_ORIGIN);
  url.searchParams.set("q", query.trim());
  let response;
  try { response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000) }); }
  catch { throw new QosError("MARKET_DATA_UNAVAILABLE", "DexScreener market search is unavailable"); }
  const pairs = normalizePairs(await boundedJson(response, "DexScreener market search"), selected);
  return {
    version: 1,
    source: selected === "pumpfun" ? "dexscreener-pumpfun-filter" : "dexscreener",
    query: query.trim(),
    resultCount: pairs.length,
    pairs,
    warning: "Third-party market data is untrusted and may be stale or manipulated. Verify mint accounts, liquidity, price impact, and route quotes before trading.",
  };
}

export async function solanaTokenMarkets({ mint, source = "all", fetchImpl = globalThis.fetch } = {}) {
  assertQos(typeof mint === "string", "MARKET_DATA_MINT_INVALID", "Solana mint is required");
  decodeBase58(mint, 32);
  assertQos(typeof fetchImpl === "function", "MARKET_DATA_UNAVAILABLE", "Market-data fetch is unavailable");
  const selected = selectedSource(source);
  const url = new URL(`/token-pairs/v1/solana/${mint}`, DEXSCREENER_ORIGIN);
  let response;
  try { response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000) }); }
  catch { throw new QosError("MARKET_DATA_UNAVAILABLE", "DexScreener token-market lookup is unavailable"); }
  const pairs = normalizePairs(await boundedJson(response, "DexScreener token-market lookup"), selected);
  return {
    version: 1,
    source: selected === "pumpfun" ? "dexscreener-pumpfun-filter" : "dexscreener",
    mint,
    resultCount: pairs.length,
    pairs,
    warning: "Discovery does not establish that a token is safe or tradable. qOS independently validates the mint and execution transaction before signing.",
  };
}

export function marketDataSources() {
  return Object.freeze([
    Object.freeze({ id: "dexscreener", mode: "read-only", scope: "Solana pair and token-market discovery" }),
    Object.freeze({ id: "pumpfun", mode: "read-only-via-dexscreener-filter", scope: "Pump.fun-origin pools identified by venue metadata" }),
  ]);
}
