import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase58 } from "../src/base58.js";
import { DEVNET_GENESIS_HASH } from "../src/constants.js";
import { initializeSandbox, QosService } from "../src/service.js";

class MockRpc {
  constructor() {
    this.blockhash = encodeBase58(Buffer.alloc(32, 31));
    this.sent = [];
  }
  async getGenesisHash() { return DEVNET_GENESIS_HASH; }
  async getLatestBlockhash() { return { value: { blockhash: this.blockhash, lastValidBlockHeight: 999 } }; }
  async getSlot() { return 100; }
  async isBlockhashValid(value) { return value === this.blockhash; }
  async getFeeForMessage() { return 5000; }
  async simulateTransaction() { return { err: null, logs: [] }; }
  async sendTransaction(transactionBase64) {
    this.sent.push(transactionBase64);
    return encodeBase58(Buffer.from(transactionBase64, "base64").subarray(1, 65));
  }
  async confirmSignature() { return { slot: 101, confirmationStatus: "confirmed", err: null }; }
  async getBalance() { return { value: 200000000 }; }
}

function serviceWithMock() {
  const parent = mkdtempSync(join(tmpdir(), "qos-service-"));
  const home = join(parent, "sandbox");
  const initialized = initializeSandbox(home);
  const service = QosService.open(home);
  service.rpc = new MockRpc();
  return { service, initialized };
}

test("service prepares, signs, submits, confirms, and audits a real Solana transaction", async () => {
  const { service, initialized } = serviceWithMock();
  const intent = await service.prepareIntent({ lamports: "12345" });
  assert.equal(intent.destination, initialized.destination);
  const result = await service.submitIntent(intent);
  assert.equal(result.lamports, "12345");
  assert.equal(result.feeLamports, "5000");
  assert.equal(result.confirmationStatus, "confirmed");
  assert.equal(result.signature.length > 80, true);
  assert.equal(service.rpc.sent.length, 1);
  assert.equal(service.audit.readVerified().length, 1);
  await assert.rejects(() => service.submitIntent(intent), { code: "NONCE_REPLAY" });
});

test("service refuses an RPC endpoint on the wrong cluster", async () => {
  const { service } = serviceWithMock();
  service.rpc.getGenesisHash = async () => encodeBase58(Buffer.alloc(32, 1));
  await assert.rejects(() => service.prepareIntent(), { code: "RPC_CLUSTER_MISMATCH" });
});

test("service refuses failed preflight and consumes the authorized nonce", async () => {
  const { service } = serviceWithMock();
  service.rpc.simulateTransaction = async () => ({ err: { InstructionError: [0, "Custom"] }, logs: ["failed"] });
  const intent = await service.prepareIntent();
  await assert.rejects(() => service.submitIntent(intent), { code: "SIMULATION_FAILED" });
  assert.equal(service.audit.lastNonce(), 1n);
});
