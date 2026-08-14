import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeBase58 } from "../src/base58.js";
import { DEVNET_GENESIS_HASH, MARKET_ID, VENUE_ID, WRAPPED_SOL_MINT } from "../src/constants.js";
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

test("policy accepts the exact sandbox intent", () => {
  const values = validateIntent(intent(), policy(), 100);
  assert.equal(values.amount, 1000n);
  assert.equal(values.nonce, 1n);
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
