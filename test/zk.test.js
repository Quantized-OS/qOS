import test from "node:test";
import assert from "node:assert/strict";
import { SnarkProofGate } from "../src/zk.js";

function gate(required = true) {
  return new SnarkProofGate({
    required,
    command: process.execPath,
    args: [new URL("../fixtures/zk-verifier.js", import.meta.url).pathname],
    circuitId: "qos-policy-test-v1",
    verifyingKeySha256: "a".repeat(64),
    proofSystem: "groth16-bn254",
  });
}

const intent = {
  requestNonce: "7",
  expiresAtSlot: "200",
  amount: "1000",
};
const context = { policy: { version: 2, max: "1000" }, signer: "11111111111111111111111111111111" };

test("required SNARK gate fails closed when a proof is missing", async () => {
  await assert.rejects(() => gate().verify(intent, undefined, context), { code: "ZK_PROOF_REQUIRED" });
});

test("SNARK gate binds the verifier response to intent, policy, signer, and circuit", async () => {
  const result = await gate().verify(intent, {
    version: 1,
    proofSystem: "groth16-bn254",
    circuitId: "qos-policy-test-v1",
    proof: { testOnlyAccept: true },
  }, context);
  assert.equal(result.verified, true);
  assert.equal(result.circuitId, "qos-policy-test-v1");
});

test("SNARK gate rejects a verifier-declared invalid proof", async () => {
  await assert.rejects(() => gate().verify(intent, {
    version: 1,
    proofSystem: "groth16-bn254",
    circuitId: "qos-policy-test-v1",
    proof: { testOnlyAccept: false },
  }, context), { code: "ZK_PROOF_INVALID" });
});
