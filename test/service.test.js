import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBase58, encodeBase58 } from "../src/base58.js";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, QOS_TOKEN_MINT, TOKEN_2022_PROGRAM_ID } from "../src/constants.js";
import { initializeSandbox, QosService } from "../src/service.js";

class MockRpc {
  constructor(genesis = DEVNET_GENESIS_HASH) {
    this.genesis = genesis;
    this.blockhash = encodeBase58(Buffer.alloc(32, 31));
    this.sent = [];
    this.accountInfos = new Map();
  }
  async getGenesisHash() { return this.genesis; }
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
  async getAccountInfo(address) { return this.accountInfos.get(address) ?? null; }
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

function mintAccount() {
  const bytes = Buffer.alloc(174);
  bytes.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  bytes[44] = 6;
  bytes[45] = 1;
  bytes[165] = 1;
  bytes.writeUInt16LE(18, 166);
  bytes.writeUInt16LE(0, 168);
  bytes.writeUInt16LE(19, 170);
  bytes.writeUInt16LE(0, 172);
  return { owner: TOKEN_2022_PROGRAM_ID, data: [bytes.toString("base64"), "base64"] };
}

function tokenAccount(owner, amount) {
  const bytes = Buffer.alloc(170);
  decodeBase58(QOS_TOKEN_MINT, 32).copy(bytes, 0);
  decodeBase58(owner, 32).copy(bytes, 32);
  bytes.writeBigUInt64LE(amount, 64);
  bytes[108] = 1;
  bytes[165] = 2;
  bytes.writeUInt16LE(7, 166);
  bytes.writeUInt16LE(0, 168);
  return { owner: TOKEN_2022_PROGRAM_ID, data: [bytes.toString("base64"), "base64"] };
}

test("service prepares, verifies, signs, and submits the pinned qOS Token-2022 transfer", async () => {
  const parent = mkdtempSync(join(tmpdir(), "qos-token-service-"));
  const home = join(parent, "sandbox");
  const initialized = initializeSandbox(home, undefined, { cluster: "mainnet-beta" });
  const service = QosService.open(home);
  const rpc = new MockRpc(MAINNET_GENESIS_HASH);
  const source = service.tokenAddresses(service.publicKey).tokenAccount;
  const destination = service.tokenAddresses(initialized.destination).tokenAccount;
  rpc.accountInfos.set(QOS_TOKEN_MINT, mintAccount());
  rpc.accountInfos.set(source, tokenAccount(service.publicKey, 5_000_000n));
  rpc.accountInfos.set(destination, tokenAccount(initialized.destination, 0n));
  service.rpc = rpc;
  const intent = await service.prepareTokenIntent({ amount: "1000000" });
  assert.equal(intent.mint, QOS_TOKEN_MINT);
  assert.equal(intent.sourceTokenAccount, source);
  assert.equal(intent.destinationTokenAccount, destination);
  const previous = process.env.QOS_ENABLE_MAINNET_BROADCAST;
  process.env.QOS_ENABLE_MAINNET_BROADCAST = "I_UNDERSTAND";
  try {
    const result = await service.submitIntent(intent);
    assert.equal(result.asset, "token");
    assert.equal(result.amount, "1000000");
    assert.equal(result.mint, QOS_TOKEN_MINT);
    assert.equal(rpc.sent.length, 1);
  } finally {
    if (previous === undefined) delete process.env.QOS_ENABLE_MAINNET_BROADCAST;
    else process.env.QOS_ENABLE_MAINNET_BROADCAST = previous;
  }
});

test("mainnet token submission fails before signing without explicit broadcast opt-in", async () => {
  const parent = mkdtempSync(join(tmpdir(), "qos-token-guard-"));
  const home = join(parent, "sandbox");
  const initialized = initializeSandbox(home, undefined, { cluster: "mainnet-beta" });
  const service = QosService.open(home);
  const rpc = new MockRpc(MAINNET_GENESIS_HASH);
  const source = service.tokenAddresses(service.publicKey).tokenAccount;
  const destination = service.tokenAddresses(initialized.destination).tokenAccount;
  rpc.accountInfos.set(QOS_TOKEN_MINT, mintAccount());
  rpc.accountInfos.set(source, tokenAccount(service.publicKey, 5_000_000n));
  rpc.accountInfos.set(destination, tokenAccount(initialized.destination, 0n));
  service.rpc = rpc;
  const intent = await service.prepareTokenIntent({ amount: "1000000" });
  const previous = process.env.QOS_ENABLE_MAINNET_BROADCAST;
  delete process.env.QOS_ENABLE_MAINNET_BROADCAST;
  try {
    await assert.rejects(() => service.submitIntent(intent), { code: "MAINNET_BROADCAST_DISABLED" });
    assert.equal(service.audit.readVerified().length, 0);
    assert.equal(rpc.sent.length, 0);
  } finally {
    if (previous === undefined) delete process.env.QOS_ENABLE_MAINNET_BROADCAST;
    else process.env.QOS_ENABLE_MAINNET_BROADCAST = previous;
  }
});
