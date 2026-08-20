import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeBase58 } from "../src/base58.js";
import { loadPolicy } from "../src/policy.js";
import {
  changePolicyDestination,
  changePolicyStrategy,
  setPolicyField,
  showEditablePolicy,
} from "../src/policy-store.js";
import { ensureRuntimeProfile } from "../src/runtime-profile.js";
import { initializeSandbox } from "../src/service.js";

function profile(t) {
  const root = mkdtempSync(join(tmpdir(), "qos-policy-store-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  initializeSandbox(home);
  ensureRuntimeProfile(home, { profile: "devnet" });
  return home;
}

test("inline policy edits are atomic, validated, and leave template identity locked", (t) => {
  const home = profile(t);
  const before = showEditablePolicy(home);
  const venue = before.policy.venueId;
  const genesis = before.policy.clusterGenesis;
  const changed = setPolicyField(home, "max-sol-lamports", "2000000");
  assert.equal(changed.policy.maxTransferLamports, "2000000");
  assert.notEqual(changed.policyCommitment, before.policyCommitment);
  assert.equal(changed.policy.venueId, venue);
  assert.equal(changed.policy.clusterGenesis, genesis);
  assert.equal(changed.externalSignerPolicySyncRequired, false);
  assert.equal(readFileSync(join(home, "policy.json"), "utf8").endsWith("\n"), true);

  const preserved = readFileSync(join(home, "policy.json"), "utf8");
  assert.throws(() => setPolicyField(home, "rpc-url", "http://remote.invalid"), { code: "INSECURE_RPC_URL" });
  assert.equal(readFileSync(join(home, "policy.json"), "utf8"), preserved);
  const customRpc = "https://provider.example/secret-project-path/?region=us-east";
  assert.equal(setPolicyField(home, "rpc-url", customRpc).policy.rpcUrl, customRpc);
  assert.throws(() => setPolicyField(home, "clusterGenesis", genesis), { code: "POLICY_FIELD_LOCKED" });
});

test("destination and strategy allowlists remain non-empty and duplicate-free", (t) => {
  const home = profile(t);
  const second = encodeBase58(Buffer.alloc(32, 117));
  changePolicyDestination(home, "add", second);
  assert.ok(loadPolicy(join(home, "policy.json")).allowedDestinations.includes(second));
  assert.throws(() => changePolicyDestination(home, "add", second), { code: "DUPLICATE_DESTINATION" });
  changePolicyDestination(home, "remove", second);
  const sole = loadPolicy(join(home, "policy.json")).allowedDestinations[0];
  assert.throws(() => changePolicyDestination(home, "remove", sole), { code: "EMPTY_DESTINATION_ALLOWLIST" });

  changePolicyStrategy(home, "add", "2");
  assert.deepEqual(loadPolicy(join(home, "policy.json")).allowedStrategyIds, [1, 2]);
  changePolicyStrategy(home, "remove", "1");
  assert.throws(() => changePolicyStrategy(home, "remove", "2"), { code: "EMPTY_STRATEGY_ALLOWLIST" });
});
