import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog, digestBytes, digestCanonical } from "./audit.js";
import { decodeBase58 } from "./base58.js";
import {
  DEVNET_GENESIS_HASH,
  MARKET_ID,
  VENUE_ID,
  WRAPPED_SOL_MINT,
} from "./constants.js";
import { assertQos } from "./errors.js";
import {
  loadAuditKey,
  loadPrivateKey,
  publicKeyAddress,
  writeNewAuditKey,
  writeNewEd25519Key,
} from "./key-store.js";
import { loadPolicy, parseUnsigned, validateIntent, validatePolicy } from "./policy.js";
import { SolanaRpc } from "./rpc.js";
import { buildNativeTransferMessage, parseNativeTransferMessage, signMessage } from "./transaction.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function sandboxPaths(home) {
  return {
    home,
    signerKey: join(home, "signer.pem"),
    receiverKey: join(home, "receiver.pem"),
    auditKey: join(home, "audit.key"),
    auditLog: join(home, "audit.log"),
    auditLock: join(home, "audit.lock"),
    policy: join(home, "policy.json"),
  };
}

export function initializeSandbox(home, destination = undefined) {
  assertQos(!existsSync(home), "SANDBOX_ALREADY_EXISTS", `Refusing to overwrite existing sandbox: ${home}`);
  mkdirSync(home, { recursive: false, mode: 0o700 });
  chmodSync(home, 0o700);
  const paths = sandboxPaths(home);
  const signerKey = writeNewEd25519Key(paths.signerKey);
  writeNewAuditKey(paths.auditKey);
  let receiver;
  if (destination === undefined) {
    const receiverKey = writeNewEd25519Key(paths.receiverKey);
    receiver = publicKeyAddress(receiverKey);
  } else {
    decodeBase58(destination, 32);
    receiver = destination;
  }
  const template = JSON.parse(readFileSync(join(PROJECT_ROOT, "config", "devnet.policy.json"), "utf8"));
  template.allowedDestinations = [receiver];
  validatePolicy(template);
  writeFileSync(paths.policy, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(paths.policy, 0o600);
  return {
    home,
    signer: publicKeyAddress(signerKey),
    destination: receiver,
    cluster: "devnet",
    clusterGenesis: DEVNET_GENESIS_HASH,
  };
}

function parsePrepareOptions(options, policy, audit) {
  assertQos(options && typeof options === "object" && !Array.isArray(options), "INVALID_PREPARE_REQUEST", "Prepare request must be an object");
  const allowed = new Set(["requestNonce", "destination", "lamports", "maxFeeLamports", "strategyId"]);
  assertQos(Object.keys(options).every((key) => allowed.has(key)), "INVALID_PREPARE_REQUEST", "Prepare request contains unknown fields");
  const destination = options.destination ?? policy.allowedDestinations[0];
  const lamports = options.lamports ?? "1000000";
  const maxFeeLamports = options.maxFeeLamports ?? policy.maxFeeLamports;
  const strategyId = options.strategyId ?? policy.allowedStrategyIds[0];
  const requestNonce = options.requestNonce ?? (audit.lastNonce() + 1n).toString();
  parseUnsigned(lamports, 64, "lamports");
  parseUnsigned(maxFeeLamports, 64, "maxFeeLamports");
  parseUnsigned(requestNonce, 128, "requestNonce");
  assertQos(Number.isInteger(strategyId), "INVALID_STRATEGY_ID", "strategyId must be an integer");
  return { destination, lamports, maxFeeLamports, strategyId, requestNonce };
}

export class QosService {
  constructor({ paths, policy, privateKey, audit, rpc }) {
    this.paths = paths;
    this.policy = policy;
    this.privateKey = privateKey;
    this.publicKey = publicKeyAddress(privateKey);
    this.audit = audit;
    this.rpc = rpc;
  }

  static open(home, { rpcUrl = process.env.SOLANA_RPC_URL } = {}) {
    const paths = sandboxPaths(home);
    const policy = loadPolicy(paths.policy, rpcUrl);
    const privateKey = loadPrivateKey(paths.signerKey);
    const audit = new AuditLog(paths.auditLog, paths.auditLock, loadAuditKey(paths.auditKey));
    audit.readVerified();
    const rpc = new SolanaRpc(policy.rpcUrl, {
      timeoutMs: policy.rpcTimeoutMs,
      commitment: policy.commitment,
    });
    return new QosService({ paths, policy, privateKey, audit, rpc });
  }

  async assertCluster() {
    const genesis = await this.rpc.getGenesisHash();
    assertQos(genesis === this.policy.clusterGenesis, "RPC_CLUSTER_MISMATCH", "RPC endpoint is not the pinned Solana Devnet cluster", {
      expected: this.policy.clusterGenesis,
      received: genesis,
    });
    return genesis;
  }

  async health() {
    const genesis = await this.assertCluster();
    const balance = await this.balance();
    return {
      status: "ok",
      cluster: this.policy.cluster,
      clusterGenesis: genesis,
      signer: this.publicKey,
      balanceLamports: balance.toString(),
      auditRecords: this.audit.readVerified().length,
    };
  }

  async balance(address = this.publicKey) {
    decodeBase58(address, 32);
    const result = await this.rpc.getBalance(address);
    assertQos(Number.isSafeInteger(result?.value) && result.value >= 0, "RPC_INVALID_BALANCE", "RPC returned an invalid balance");
    return BigInt(result.value);
  }

  async airdrop(lamports = "200000000") {
    const amount = parseUnsigned(lamports, 64, "lamports");
    assertQos(amount > 0n && amount <= 1_000_000_000n, "AIRDROP_LIMIT", "Sandbox airdrop must be between 1 lamport and 1 SOL");
    await this.assertCluster();
    const signature = await this.rpc.requestAirdrop(this.publicKey, amount);
    const status = await this.rpc.confirmSignature(signature, {
      timeoutMs: this.policy.confirmationTimeoutMs,
    });
    return {
      signature,
      slot: status.slot,
      confirmationStatus: status.confirmationStatus,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    };
  }

  async prepareIntent(options = {}) {
    const parsed = parsePrepareOptions(options, this.policy, this.audit);
    const [genesis, blockhashResult, currentSlot] = await Promise.all([
      this.assertCluster(),
      this.rpc.getLatestBlockhash(),
      this.rpc.getSlot(),
    ]);
    assertQos(typeof blockhashResult?.value?.blockhash === "string", "RPC_INVALID_BLOCKHASH", "RPC returned an invalid latest blockhash");
    const intent = {
      version: 1,
      requestNonce: parsed.requestNonce,
      clusterGenesis: genesis,
      venueId: VENUE_ID,
      marketId: MARKET_ID,
      side: "SEND",
      inputMint: WRAPPED_SOL_MINT,
      outputMint: WRAPPED_SOL_MINT,
      inputAmount: parsed.lamports,
      minimumOutput: parsed.lamports,
      maxFeeLamports: parsed.maxFeeLamports,
      maxCuPrice: "0",
      maxRelayTip: "0",
      destination: parsed.destination,
      recentBlockhash: blockhashResult.value.blockhash,
      expiresAtSlot: (BigInt(currentSlot) + BigInt(this.policy.maxIntentTtlSlots)).toString(),
      strategyId: parsed.strategyId,
      operatorApproval: null,
    };
    validateIntent(intent, this.policy, currentSlot);
    return intent;
  }

  async submitIntent(intent) {
    const [genesis, currentSlot, blockhashValid] = await Promise.all([
      this.assertCluster(),
      this.rpc.getSlot(),
      this.rpc.isBlockhashValid(intent?.recentBlockhash),
    ]);
    assertQos(genesis === intent?.clusterGenesis, "WRONG_CLUSTER", "Intent cluster does not match RPC cluster");
    assertQos(blockhashValid === true, "INVALID_BLOCKHASH", "Intent recentBlockhash is not valid on the pinned cluster");
    const values = validateIntent(intent, this.policy, currentSlot);
    const message = buildNativeTransferMessage({
      payer: this.publicKey,
      destination: intent.destination,
      lamports: values.amount,
      recentBlockhash: intent.recentBlockhash,
    });
    const parsedMessage = parseNativeTransferMessage(message);
    assertQos(parsedMessage.payer === this.publicKey && parsedMessage.destination === intent.destination && parsedMessage.lamports === values.amount, "TEMPLATE_SELF_CHECK_FAILED", "Constructed message did not match the authorized intent");
    const messageBase64 = message.toString("base64");
    const fee = await this.rpc.getFeeForMessage(messageBase64);
    assertQos(Number.isSafeInteger(fee) && fee >= 0, "FEE_UNAVAILABLE", "RPC could not calculate a valid transaction fee");
    const feeLamports = BigInt(fee);
    assertQos(feeLamports <= values.maxFee, "ACTUAL_FEE_LIMIT_EXCEEDED", "Calculated transaction fee exceeds intent limit");
    assertQos(feeLamports <= BigInt(this.policy.maxFeeLamports), "POLICY_FEE_LIMIT_EXCEEDED", "Calculated transaction fee exceeds policy limit");
    const signed = signMessage(message, this.privateKey);
    this.audit.authorizeAndAppend({
      requestNonce: intent.requestNonce,
      intentDigest: digestCanonical(intent),
      messageDigest: digestBytes(message),
      signature: signed.signature,
      publicKey: signed.publicKey,
      feeLamports: feeLamports.toString(),
    }, this.policy.maxRequestsPerMinute);
    const simulation = await this.rpc.simulateTransaction(signed.transactionBase64);
    assertQos(simulation && simulation.err === null, "SIMULATION_FAILED", "Solana preflight simulation rejected the transaction", {
      err: simulation?.err,
      logs: Array.isArray(simulation?.logs) ? simulation.logs.slice(-20) : undefined,
    });
    const rpcSignature = await this.rpc.sendTransaction(signed.transactionBase64);
    assertQos(rpcSignature === signed.signature, "SIGNATURE_MISMATCH", "RPC returned a different transaction signature");
    const status = await this.rpc.confirmSignature(signed.signature, {
      timeoutMs: this.policy.confirmationTimeoutMs,
      recentBlockhash: intent.recentBlockhash,
    });
    return {
      signature: signed.signature,
      signer: signed.publicKey,
      destination: intent.destination,
      lamports: intent.inputAmount,
      feeLamports: feeLamports.toString(),
      slot: status.slot,
      confirmationStatus: status.confirmationStatus,
      transactionBytes: signed.transactionBytes,
      explorerUrl: `https://explorer.solana.com/tx/${signed.signature}?cluster=devnet`,
    };
  }

  publicPolicy() {
    return {
      ...this.policy,
      rpcUrl: new URL(this.policy.rpcUrl).origin,
      signer: this.publicKey,
      lastRequestNonce: this.audit.lastNonce().toString(),
    };
  }
}
