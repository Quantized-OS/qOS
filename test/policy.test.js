import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeBase58 } from "../src/base58.js";
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  MARKET_ID,
  QOS_TOKEN_MINT,
  TOKEN_2022_PROGRAM_ID,
  VENUE_ID,
  WRAPPED_SOL_MINT,
} from "../src/constants.js";
import { validateIntent, validatePolicy } from "../src/policy.js";

const destination = encodeBase58(Buffer.alloc(32, 21));
const blockhash = encodeBase58(Buffer.alloc(32, 22));

function policy() {
  const value = JSON.parse(readFileSync(new URL("../config/devnet.policy.json", import.meta.url), "utf8"));
  value.allowedDestinations = [destination];
  return validatePolicy(value);
}

function intent(overrides = {}) {
  return {
    version: 1,
    requestNonce: "1",
    clusterGenesis: DEVNET_GENESIS_HASH,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    side: "SEND",
    inputMint: WRAPPED_SOL_MINT,
    outputMint: WRAPPED_SOL_MINT,
    inputAmount: "1000",
    minimumOutput: "1000",
    maxFeeLamports: "10000",
    maxCuPrice: "0",
    maxRelayTip: "0",
    destination,
    recentBlockhash: blockhash,
    expiresAtSlot: "200",
    strategyId: 1,
    operatorApproval: null,
    ...overrides,
  };
}

function mainnetPolicy() {
  const value = JSON.parse(readFileSync(new URL("../config/mainnet.policy.json", import.meta.url), "utf8"));
  value.allowedDestinations = [destination];
  return validatePolicy(value);
}

function tokenIntent(overrides = {}) {
  return {
    version: 2,
    requestNonce: "1",
    clusterGenesis: MAINNET_GENESIS_HASH,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    side: "SEND",
    mint: QOS_TOKEN_MINT,
    amount: "1000000",
    maxFeeLamports: "100000",
    maxCuPrice: "0",
    maxRelayTip: "0",
    destination,
    sourceTokenAccount: encodeBase58(Buffer.alloc(32, 23)),
    destinationTokenAccount: encodeBase58(Buffer.alloc(32, 24)),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    decimals: 6,
    recentBlockhash: blockhash,
    expiresAtSlot: "200",
    strategyId: 1,
    operatorApproval: null,
    ...overrides,
  };
}

test("policy accepts the exact sandbox intent", () => {
  const values = validateIntent(intent(), policy(), 100);
  assert.equal(values.amount, 1000n);
  assert.equal(values.nonce, 1n);
});

test("policy permits plaintext RPC only on IPv4 or IPv6 loopback", () => {
  const ipv6 = JSON.parse(readFileSync(new URL("../config/devnet.policy.json", import.meta.url), "utf8"));
  ipv6.allowedDestinations = [destination];
  ipv6.rpcUrl = "http://[::1]:8899";
  assert.doesNotThrow(() => validatePolicy(ipv6));

  const remote = JSON.parse(readFileSync(new URL("../config/devnet.policy.json", import.meta.url), "utf8"));
  remote.allowedDestinations = [destination];
  remote.rpcUrl = "http://192.0.2.1:8899";
  assert.throws(() => validatePolicy(remote), { code: "INSECURE_RPC_URL" });
});

test("policy rejects unknown fields", () => {
  assert.throws(() => validateIntent(intent({ arbitraryInstruction: "AA==" }), policy(), 100), { code: "INVALID_INTENT_SHAPE" });
});

test("policy rejects wrong cluster, destination, amount, fee, and stale intent", () => {
  assert.throws(() => validateIntent(intent({ clusterGenesis: encodeBase58(Buffer.alloc(32, 3)) }), policy(), 100), { code: "WRONG_CLUSTER" });
  assert.throws(() => validateIntent(intent({ destination: encodeBase58(Buffer.alloc(32, 3)) }), policy(), 100), { code: "DESTINATION_NOT_ALLOWED" });
  assert.throws(() => validateIntent(intent({ inputAmount: "100000001", minimumOutput: "100000001" }), policy(), 100), { code: "AMOUNT_LIMIT_EXCEEDED" });
  assert.throws(() => validateIntent(intent({ maxFeeLamports: "10001" }), policy(), 100), { code: "FEE_LIMIT_EXCEEDED" });
  assert.throws(() => validateIntent(intent({ expiresAtSlot: "100" }), policy(), 100), { code: "INTENT_EXPIRED" });
});

test("policy rejects non-canonical integer encodings", () => {
  assert.throws(() => validateIntent(intent({ requestNonce: "01" }), policy(), 100), { code: "INVALID_INTEGER" });
  assert.throws(() => validateIntent(intent({ inputAmount: 1000 }), policy(), 100), { code: "INVALID_INTEGER" });
});

test("policy accepts the exact qOS Token-2022 transfer intent", () => {
  const values = validateIntent(tokenIntent(), mainnetPolicy(), 100);
  assert.equal(values.kind, "token");
  assert.equal(values.amount, 1_000_000n);
});

test("token policy rejects a changed mint, program, decimals, account reuse, or limit", () => {
  const configured = mainnetPolicy();
  assert.throws(() => validateIntent(tokenIntent({ mint: WRAPPED_SOL_MINT }), configured, 100), { code: "MINT_NOT_ALLOWED" });
  assert.throws(() => validateIntent(tokenIntent({ tokenProgram: "11111111111111111111111111111111" }), configured, 100), { code: "MINT_NOT_ALLOWED" });
  assert.throws(() => validateIntent(tokenIntent({ decimals: 9 }), configured, 100), { code: "MINT_NOT_ALLOWED" });
  const same = encodeBase58(Buffer.alloc(32, 23));
  assert.throws(() => validateIntent(tokenIntent({ sourceTokenAccount: same, destinationTokenAccount: same }), configured, 100), { code: "DUPLICATE_TOKEN_ACCOUNT" });
  assert.throws(() => validateIntent(tokenIntent({ amount: "1000000001" }), configured, 100), { code: "AMOUNT_LIMIT_EXCEEDED" });
});
