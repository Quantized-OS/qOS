import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { basicAgentPlan, modelAgentPlan, normalizeAgentPlan } from "../src/agent.js";

const DESTINATION = "2HRxdPxxReP4PAHunxHD5mjPXWwBhnhYq4NowVEoLxg5";
const CONTEXT = {
  amount: "1000000",
  destination: DESTINATION,
  maxAmount: "1000000000",
};

test("basic agent emits an exact qOS transfer proposal", () => {
  assert.deepEqual(basicAgentPlan(CONTEXT), {
    action: "transfer_qos",
    amount: "1000000",
    destination: DESTINATION,
    reason: "basic policy-aware demo agent",
  });
});

test("agent rejects actions other than transfer_qos", () => {
  assert.throws(
    () => normalizeAgentPlan({ action: "swap", amount: "1000000", destination: DESTINATION }, CONTEXT),
    /Agent may only request transfer_qos/,
  );
});

test("agent cannot change the requested amount or policy destination", () => {
  assert.throws(
    () => normalizeAgentPlan({ action: "transfer_qos", amount: "1000001", destination: DESTINATION }, CONTEXT),
    /does not match the operator request/,
  );
  assert.throws(
    () => normalizeAgentPlan({ action: "transfer_qos", amount: "1000000", destination: "11111111111111111111111111111111" }, CONTEXT),
    /not the policy destination/,
  );
});

test("agent rejects unsupported proposal fields", () => {
  assert.throws(
    () => normalizeAgentPlan({ action: "transfer_qos", amount: "1000000", destination: DESTINATION, instructions: [] }, CONTEXT),
    /unsupported field/,
  );
});

test("model agent is restricted to a loopback endpoint", async () => {
  await assert.rejects(
    () => modelAgentPlan({
      url: "https://example.com/v1/chat/completions",
      amount: CONTEXT.amount,
      destination: CONTEXT.destination,
      maxAmount: CONTEXT.maxAmount,
      mint: "5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump",
      decimals: 6,
    }),
    /must run on the local machine/,
  );
});

test("agent demo exposes help without opening a sandbox", () => {
  const result = spawnSync(process.execPath, [new URL("../bin/qos-agent-demo.js", import.meta.url).pathname, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /qOS agent-directed Token-2022 transfer demo/);
});

test("agent demo rejects duplicate security-relevant options before opening a sandbox", () => {
  const result = spawnSync(process.execPath, [
    new URL("../bin/qos-agent-demo.js", import.meta.url).pathname,
    "--home", "/tmp/one",
    "--home", "/tmp/two",
    "--amount", "1",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DUPLICATE_ARGUMENT/);
});
