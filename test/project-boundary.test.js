import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("qOS exports a versioned platform SDK without embedding the Cloud service", async () => {
  for (const path of [
    "bin/qos-cloud.js",
    "cloud",
    "src/cloud",
    "test/cloud",
    "docs/CLOUD_API.md",
    "CLOUD_LAUNCH.md",
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} belongs in qOS Cloud`);
  }

  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.exports["./platform-sdk"], "./src/platform-sdk.js");
  assert.equal(manifest.scripts.cloud, undefined);
  assert.equal(manifest.scripts["cloud:image"], undefined);

  const sdk = await import("qos-solana-sandbox/platform-sdk");
  assert.equal(sdk.QOS_PLATFORM_SDK_VERSION, 1);
  assert.equal(sdk.QOS_CLOUD_HOST_CONTRACT_VERSION, 3);
  assert.equal(typeof sdk.setPolicyField, "function");
  assert.equal(typeof sdk.RAYDIUM_SWAP_ENDPOINT, "string");
  assert.equal(typeof sdk.readAgentSkillPack, "function");
  assert.equal(typeof sdk.buildSkillZip, "function");
  assert.equal(typeof sdk.QosService, "function");
  assert.equal(typeof sdk.configureModelProvider, "function");
  assert.equal(typeof sdk.changePolicyDestination, "function");
  assert.deepEqual(sdk.assertCloudLiveTransactions(true), {
    version: 3,
    liveTransactions: true,
    simulatedSuccessSupported: false,
  });
  assert.throws(() => sdk.assertCloudLiveTransactions(false), {
    code: "CLOUD_LIVE_TRANSACTIONS_DISABLED",
  });
});
