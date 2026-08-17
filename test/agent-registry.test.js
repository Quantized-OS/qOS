import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentPaths,
  authenticateAgent,
  getAgent,
  listAgents,
  offboardAgent,
  onboardAgent,
  validateAgentAction,
} from "../src/agent-registry.js";
import { loadPolicy } from "../src/policy.js";
import { setPolicyField } from "../src/policy-store.js";
import { ensureRuntimeProfile } from "../src/runtime-profile.js";
import { initializeSandbox } from "../src/service.js";

function profile(t) {
  const root = mkdtempSync(join(tmpdir(), "qos-agent-registry-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  initializeSandbox(home);
  ensureRuntimeProfile(home, { profile: "devnet" });
  return home;
}

function tokenAt(path) {
  return readFileSync(path, "ascii").trim();
}

test("agent onboarding creates a private revocable credential and scoped skill pack", (t) => {
  const home = profile(t);
  const policy = loadPolicy(join(home, "policy.json"));
  const agent = onboardAgent(home, {
    id: "market-bot",
    name: "Market bot",
    approvalMode: "ask",
    asset: "sol",
    maxAmount: "1000",
    destination: policy.allowedDestinations[0],
    strategyId: 1,
  });
  const paths = agentPaths(home, "market-bot");
  assert.equal(lstatSync(paths.token).mode & 0o077, 0);
  assert.equal(lstatSync(paths.token).nlink, 1);
  assert.equal(lstatSync(paths.skills).mode & 0o077, 0);
  assert.match(readFileSync(join(paths.skills, "SKILL.md"), "utf8"), /cannot request arbitrary signatures/);
  assert.match(readFileSync(join(paths.skills, "transfer.md"), "utf8"), /transfer_sol/);
  assert.match(readFileSync(join(paths.skills, "mcp.md"), "utf8"), /qos_request_transfer/);
  assert.equal(JSON.parse(readFileSync(join(paths.skills, "manifest.json"), "utf8")).mcpEndpoint, "http://127.0.0.1:8790/mcp");
  assert.doesNotMatch(readFileSync(join(paths.skills, "manifest.json"), "utf8"), new RegExp(tokenAt(paths.token)));
  assert.equal(authenticateAgent(home, tokenAt(paths.token)).id, "market-bot");
  assert.equal(getAgent(home, "market-bot").approvalMode, "ask");
  assert.equal(listAgents(home).length, 1);

  const action = {
    version: 1,
    action: "transfer_sol",
    amount: "999",
    destination: agent.destination,
    strategyId: 1,
  };
  assert.equal(validateAgentAction(home, authenticateAgent(home, tokenAt(paths.token)), action).amount, "999");
  assert.throws(() => validateAgentAction(home, authenticateAgent(home, tokenAt(paths.token)), { ...action, amount: "1001" }), { code: "AGENT_AMOUNT_LIMIT_EXCEEDED" });

  const revokedToken = tokenAt(paths.token);
  offboardAgent(home, "market-bot");
  assert.equal(existsSync(paths.token), false);
  assert.throws(() => authenticateAgent(home, revokedToken), { code: "AGENT_UNAUTHORIZED" });
  assert.equal(listAgents(home).length, 0);
});

test("automatic execution needs acknowledgement and is intersected with later policy limits", (t) => {
  const home = profile(t);
  const policy = loadPolicy(join(home, "policy.json"));
  const options = {
    id: "auto-bot",
    approvalMode: "auto",
    asset: "sol",
    maxAmount: "1000",
    destination: policy.allowedDestinations[0],
    strategyId: 1,
  };
  assert.throws(() => onboardAgent(home, options), { code: "AUTO_APPROVAL_ACKNOWLEDGEMENT_REQUIRED" });
  const agent = onboardAgent(home, { ...options, acceptAuto: true });
  setPolicyField(home, "max-sol-lamports", "500");
  assert.equal(validateAgentAction(home, {
    ...agent,
    tokenSha256: "0".repeat(64),
  }, {
    version: 1,
    action: "transfer_sol",
    amount: "400",
    destination: agent.destination,
    strategyId: 1,
  }).amount, "400");
  assert.throws(() => validateAgentAction(home, {
    ...agent,
    tokenSha256: "0".repeat(64),
  }, {
    version: 1,
    action: "transfer_sol",
    amount: "600",
    destination: agent.destination,
    strategyId: 1,
  }), { code: "AGENT_AMOUNT_LIMIT_EXCEEDED" });
});

test("offboarding revokes authorization even when local agent files were replaced unsafely", (t) => {
  const home = profile(t);
  const policy = loadPolicy(join(home, "policy.json"));
  const agent = onboardAgent(home, {
    id: "damaged-bot",
    approvalMode: "ask",
    asset: "sol",
    maxAmount: "10",
    destination: policy.allowedDestinations[0],
    strategyId: 1,
  });
  const token = readFileSync(agent.tokenFile, "ascii").trim();
  const paths = agentPaths(home, agent.id);
  const outside = join(home, "preserve-me");
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, "sentinel"), "do not delete\n", { mode: 0o600 });
  rmSync(paths.agent, { recursive: true });
  symlinkSync(outside, paths.agent);
  const result = offboardAgent(home, agent.id);
  assert.equal(result.credentialRevoked, true);
  assert.equal(result.localCredentialRemoved, false);
  assert.match(result.cleanupWarning, /preserved/);
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "do not delete\n");
  assert.throws(() => authenticateAgent(home, token), { code: "AGENT_UNAUTHORIZED" });
});
