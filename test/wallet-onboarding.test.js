import test from "node:test";
import assert from "node:assert/strict";

import { fundDevnetWallet, walletReadiness } from "../src/wallet-onboarding.js";

test("wallet readiness verifies the pinned cluster and Devnet fee reserve", async () => {
  let balance = 0n;
  const service = {
    publicKey: "Signer111111111111111111111111111111111",
    policy: {
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      maxFeeLamports: "10000",
      maxTransferLamports: "100000000",
      tokenTransfer: null,
    },
    async assertCluster() { return "devnet-genesis"; },
    async balance() { return balance; },
    async airdrop(lamports) {
      balance += BigInt(lamports);
      return { signature: "synthetic-airdrop", confirmationStatus: "confirmed" };
    },
  };
  const before = await walletReadiness(service);
  assert.equal(before.status, "action-required");
  assert.ok(before.blockers.some((blocker) => blocker.includes("fee")));
  const funded = await fundDevnetWallet(service, "200000000");
  assert.equal(funded.status, "funded");
  assert.equal(funded.readiness.status, "ready");
  assert.equal(funded.readiness.balanceLamports, "200000000");
});

test("mainnet readiness reports the exact derived source token account when unfunded", async () => {
  const service = {
    publicKey: "Signer111111111111111111111111111111111",
    policy: {
      cluster: "mainnet-beta",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      maxFeeLamports: "100000",
      maxTransferLamports: "0",
      tokenTransfer: { decimals: 6 },
      allowedDestinations: ["DestinationOwner"],
    },
    async assertCluster() { return "mainnet-genesis"; },
    async balance() { return 0n; },
    tokenAddresses(owner = this.publicKey) {
      return {
        owner,
        mint: "PinnedMint",
        tokenProgram: "Token2022",
        tokenAccount: owner === this.publicKey ? "DerivedSourceAta" : "DerivedDestinationAta",
      };
    },
    rpc: { async getAccountInfo() { return null; } },
    async tokenBalance() { assert.fail("missing source account must be reported before token parsing"); },
  };
  const report = await walletReadiness(service);
  assert.equal(report.status, "action-required");
  assert.equal(report.token.tokenAccount, "DerivedSourceAta");
  assert.equal(report.token.accountExists, false);
  assert.equal(report.token.destinations[0].accountExists, false);
  assert.ok(report.blockers.some((blocker) => blocker.includes("associated account")));
  assert.ok(report.blockers.some((blocker) => blocker.includes("destination")));
  assert.ok(report.nextSteps.some((step) => step.includes("DerivedSourceAta")));
  assert.ok(report.nextSteps.some((step) => step.includes("Run qos wallet status again")));
});
