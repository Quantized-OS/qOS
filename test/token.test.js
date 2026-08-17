import test from "node:test";
import assert from "node:assert/strict";
import { associatedTokenAddress, parseMintAccount, parseTokenAccount, verifyTokenTransferAccounts } from "../src/token.js";
import { QOS_TOKEN_MINT, TOKEN_2022_PROGRAM_ID } from "../src/constants.js";

const MINT_DATA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDGpH6NAwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEPrFEGyurxoDELH4NDgY2FgCwzD1H6ncBPPe75SwYqPEwCmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ+sUQbK6vGgMQsfg0OBjYWALDMPUfqdwE897vlLBio8DAAAAcU9TAwAAAHFvc1AAAABodHRwczovL2lwZnMuaW8vaXBmcy9iYWZrcmVpZjZqcGFreHF6dGcyZDJuZHN0MmpscXdrNXJrbmp2czRjcGN1ZTVzc2U3emhrM3dzcXl4dQAAAAA=";
const TOKEN_DATA = "Q+sUQbK6vGgMQsfg0OBjYWALDMPUfqdwE897vlLBio+jfDmUY6eY7jY3W4N+667b0wjf0k3kd1bbA8f2WgWe3wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgcAAAA=";
const OWNER = "C1BKZ6JmGus3mjp4eo1guaDeGsrh5gTjNC4iMpT3WfSv";

function rpcAccount(data) {
  return { owner: TOKEN_2022_PROGRAM_ID, data: [data, "base64"] };
}

test("associated token address matches a live Token-2022 qOS account vector", () => {
  assert.equal(associatedTokenAddress({ owner: OWNER, mint: QOS_TOKEN_MINT, tokenProgram: TOKEN_2022_PROGRAM_ID }), "13MSHVC3mG7T3xnFEVQcQs4Cpaj3G1uzQFGURp4Y7iB6");
});

test("pinned qOS mint verifies decimals and metadata-only extensions", () => {
  const mint = parseMintAccount(rpcAccount(MINT_DATA), {
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    decimals: 6,
    allowedMintExtensions: [18, 19],
  });
  assert.equal(mint.decimals, 6);
  assert.deepEqual(mint.extensions, [18, 19]);
});

test("Token-2022 account verifies mint, owner, state, and immutable-owner extension", () => {
  const account = parseTokenAccount(rpcAccount(TOKEN_DATA), {
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    mint: QOS_TOKEN_MINT,
    owner: OWNER,
    field: "tokenAccount",
  });
  assert.equal(account.amount, 0n);
  assert.deepEqual(account.extensions, [7]);
});

test("mint verification fails closed if extension policy changes", () => {
  assert.throws(() => parseMintAccount(rpcAccount(MINT_DATA), {
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    decimals: 6,
    allowedMintExtensions: [18],
  }), { code: "MINT_EXTENSIONS_MISMATCH" });
});

test("Token-2022 account rejects delegates and unexpected extensions", () => {
  const delegated = Buffer.from(TOKEN_DATA, "base64");
  delegated.writeUInt32LE(1, 72);
  delegated.fill(1, 76, 108);
  assert.throws(() => parseTokenAccount(rpcAccount(delegated.toString("base64")), {
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    mint: QOS_TOKEN_MINT,
    owner: OWNER,
    field: "tokenAccount",
  }), { code: "TOKEN_ACCOUNT_DELEGATE_PRESENT" });

  const extraExtension = Buffer.concat([Buffer.from(TOKEN_DATA, "base64"), Buffer.from([8, 0, 0, 0])]);
  assert.throws(() => parseTokenAccount(rpcAccount(extraExtension.toString("base64")), {
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    mint: QOS_TOKEN_MINT,
    owner: OWNER,
    field: "tokenAccount",
  }), { code: "TOKEN_ACCOUNT_EXTENSIONS_MISMATCH" });
});

test("missing source token accounts report the exact readiness command before signing", async () => {
  await assert.rejects(() => verifyTokenTransferAccounts({
    rpc: {
      async getAccountInfo(address) {
        return address === "DerivedSourceAta" ? null : rpcAccount(MINT_DATA);
      },
    },
    tokenPolicy: {
      mint: QOS_TOKEN_MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      decimals: 6,
      allowedMintExtensions: [18, 19],
    },
    sourceOwner: OWNER,
    destinationOwner: OWNER,
    sourceTokenAccount: "DerivedSourceAta",
    destinationTokenAccount: "DerivedDestinationAta",
    amount: 1n,
  }), (error) => error.code === "TOKEN_ACCOUNT_NOT_FOUND"
    && /DerivedSourceAta/.test(error.message)
    && /qos wallet status/.test(error.message));
});
