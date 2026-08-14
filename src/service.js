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
import {
  buildNativeTransferMessage,
  buildTokenTransferCheckedMessage,
  parseNativeTransferMessage,
  parseTokenTransferCheckedMessage,
  signMessage,
} from "./transaction.js";
import {
  associatedTokenAddress,
  parseMintAccount,
  parseTokenAccount,
  verifyTokenTransferAccounts,
} from "./token.js";

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

export function initializeSandbox(home, destination = undefined, { cluster = "devnet" } = {}) {
  assertQos(!existsSync(home), "SANDBOX_ALREADY_EXISTS", `Refusing to overwrite existing sandbox: ${home}`);
  assertQos(cluster === "devnet" || cluster === "mainnet-beta", "UNSUPPORTED_CLUSTER", "Cluster must be devnet or mainnet-beta");
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
  const policyFile = cluster === "devnet" ? "devnet.policy.json" : "mainnet.policy.json";
  const template = JSON.parse(readFileSync(join(PROJECT_ROOT, "config", policyFile), "utf8"));
  template.allowedDestinations = [receiver];
  validatePolicy(template);
  writeFileSync(paths.policy, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(paths.policy, 0o600);
  return {
    home,
    signer: publicKeyAddress(signerKey),
    destination: receiver,
    cluster: template.cluster,
    clusterGenesis: template.clusterGenesis,
    tokenTransfer: template.tokenTransfer,
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

function parseTokenPrepareOptions(options, policy, audit) {
  assertQos(policy.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "Policy does not enable token transfers");
  assertQos(options && typeof options === "object" && !Array.isArray(options), "INVALID_PREPARE_REQUEST", "Prepare request must be an object");
  const allowed = new Set(["requestNonce", "destination", "amount", "maxFeeLamports", "strategyId"]);
  assertQos(Object.keys(options).every((key) => allowed.has(key)), "INVALID_PREPARE_REQUEST", "Token prepare request contains unknown fields");
  const destination = options.destination ?? policy.allowedDestinations[0];
  const amount = options.amount ?? "1000000";
  const maxFeeLamports = options.maxFeeLamports ?? policy.maxFeeLamports;
  const strategyId = options.strategyId ?? policy.allowedStrategyIds[0];
  const requestNonce = options.requestNonce ?? (audit.lastNonce() + 1n).toString();
  parseUnsigned(amount, 64, "amount");
  parseUnsigned(maxFeeLamports, 64, "maxFeeLamports");
  parseUnsigned(requestNonce, 128, "requestNonce");
  assertQos(Number.isInteger(strategyId), "INVALID_STRATEGY_ID", "strategyId must be an integer");
  return { destination, amount, maxFeeLamports, strategyId, requestNonce };
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
    assertQos(genesis === this.policy.clusterGenesis, "RPC_CLUSTER_MISMATCH", "RPC endpoint is not the cluster pinned by policy", {
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
      tokenMint: this.policy.tokenTransfer?.mint ?? null,
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
    assertQos(this.policy.cluster === "devnet", "AIRDROP_UNAVAILABLE", "Airdrop is only available on Devnet");
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
      venueId: this.policy.venueId,
      marketId: this.policy.marketId,
      side: "SEND",
      inputMint: this.policy.inputMint,
      outputMint: this.policy.outputMint,
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

  tokenAddresses(owner = this.publicKey) {
    assertQos(this.policy.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "Policy does not enable token transfers");
    decodeBase58(owner, 32);
    return {
      owner,
      mint: this.policy.tokenTransfer.mint,
      tokenProgram: this.policy.tokenTransfer.tokenProgram,
      tokenAccount: associatedTokenAddress({
        owner,
        mint: this.policy.tokenTransfer.mint,
        tokenProgram: this.policy.tokenTransfer.tokenProgram,
      }),
    };
  }

  async tokenBalance(owner = this.publicKey) {
    await this.assertCluster();
    const address = this.tokenAddresses(owner);
    const [mintInfo, tokenInfo] = await Promise.all([
      this.rpc.getAccountInfo(address.mint),
      this.rpc.getAccountInfo(address.tokenAccount),
    ]);
    parseMintAccount(mintInfo, this.policy.tokenTransfer);
    const account = parseTokenAccount(tokenInfo, {
      tokenProgram: address.tokenProgram,
      mint: address.mint,
      owner,
      field: "tokenAccount",
    });
    return { ...address, amount: account.amount.toString(), decimals: this.policy.tokenTransfer.decimals };
  }

  async prepareTokenIntent(options = {}) {
    const parsed = parseTokenPrepareOptions(options, this.policy, this.audit);
    const source = this.tokenAddresses(this.publicKey).tokenAccount;
    const destinationTokenAccount = this.tokenAddresses(parsed.destination).tokenAccount;
    assertQos(source !== destinationTokenAccount, "DUPLICATE_TOKEN_ACCOUNT", "Token destination must not resolve to the signer token account");
    const [genesis, blockhashResult, currentSlot] = await Promise.all([
      this.assertCluster(),
      this.rpc.getLatestBlockhash(),
      this.rpc.getSlot(),
    ]);
    assertQos(typeof blockhashResult?.value?.blockhash === "string", "RPC_INVALID_BLOCKHASH", "RPC returned an invalid latest blockhash");
    const intent = {
      version: 2,
      requestNonce: parsed.requestNonce,
      clusterGenesis: genesis,
      venueId: this.policy.venueId,
      marketId: this.policy.marketId,
      side: "SEND",
      mint: this.policy.tokenTransfer.mint,
      amount: parsed.amount,
      maxFeeLamports: parsed.maxFeeLamports,
      maxCuPrice: "0",
      maxRelayTip: "0",
      destination: parsed.destination,
      sourceTokenAccount: source,
      destinationTokenAccount,
      tokenProgram: this.policy.tokenTransfer.tokenProgram,
      decimals: this.policy.tokenTransfer.decimals,
      recentBlockhash: blockhashResult.value.blockhash,
      expiresAtSlot: (BigInt(currentSlot) + BigInt(this.policy.maxIntentTtlSlots)).toString(),
      strategyId: parsed.strategyId,
      operatorApproval: null,
    };
    const values = validateIntent(intent, this.policy, currentSlot);
    await verifyTokenTransferAccounts({
      rpc: this.rpc,
      tokenPolicy: this.policy.tokenTransfer,
      sourceOwner: this.publicKey,
      destinationOwner: intent.destination,
      sourceTokenAccount: intent.sourceTokenAccount,
      destinationTokenAccount: intent.destinationTokenAccount,
      amount: values.amount,
    });
    return intent;
  }

  async submitIntent(intent) {
    const [genesis, currentSlot] = await Promise.all([
      this.assertCluster(),
      this.rpc.getSlot(),
    ]);
    assertQos(genesis === intent?.clusterGenesis, "WRONG_CLUSTER", "Intent cluster does not match RPC cluster");
    const values = validateIntent(intent, this.policy, currentSlot);
    const blockhashValid = await this.rpc.isBlockhashValid(intent.recentBlockhash);
    assertQos(blockhashValid === true, "INVALID_BLOCKHASH", "Intent recentBlockhash is not valid on the pinned cluster");
    let message;
    if (values.kind === "native") {
      message = buildNativeTransferMessage({
        payer: this.publicKey,
        destination: intent.destination,
        lamports: values.amount,
        recentBlockhash: intent.recentBlockhash,
      });
      const parsedMessage = parseNativeTransferMessage(message);
      assertQos(parsedMessage.payer === this.publicKey && parsedMessage.destination === intent.destination && parsedMessage.lamports === values.amount, "TEMPLATE_SELF_CHECK_FAILED", "Constructed native message did not match the authorized intent");
    } else {
      await verifyTokenTransferAccounts({
        rpc: this.rpc,
        tokenPolicy: this.policy.tokenTransfer,
        sourceOwner: this.publicKey,
        destinationOwner: intent.destination,
        sourceTokenAccount: intent.sourceTokenAccount,
        destinationTokenAccount: intent.destinationTokenAccount,
        amount: values.amount,
      });
      message = buildTokenTransferCheckedMessage({
        payer: this.publicKey,
        sourceTokenAccount: intent.sourceTokenAccount,
        destinationTokenAccount: intent.destinationTokenAccount,
        mint: intent.mint,
        tokenProgram: intent.tokenProgram,
        amount: values.amount,
        decimals: intent.decimals,
        recentBlockhash: intent.recentBlockhash,
      });
      const parsedMessage = parseTokenTransferCheckedMessage(message);
      assertQos(parsedMessage.payer === this.publicKey && parsedMessage.sourceTokenAccount === intent.sourceTokenAccount && parsedMessage.destinationTokenAccount === intent.destinationTokenAccount && parsedMessage.mint === intent.mint && parsedMessage.tokenProgram === intent.tokenProgram && parsedMessage.amount === values.amount && parsedMessage.decimals === intent.decimals, "TEMPLATE_SELF_CHECK_FAILED", "Constructed token message did not match the authorized intent");
    }
    const messageBase64 = message.toString("base64");
    const fee = await this.rpc.getFeeForMessage(messageBase64);
    assertQos(Number.isSafeInteger(fee) && fee >= 0, "FEE_UNAVAILABLE", "RPC could not calculate a valid transaction fee");
    const feeLamports = BigInt(fee);
    assertQos(feeLamports <= values.maxFee, "ACTUAL_FEE_LIMIT_EXCEEDED", "Calculated transaction fee exceeds intent limit");
    assertQos(feeLamports <= BigInt(this.policy.maxFeeLamports), "POLICY_FEE_LIMIT_EXCEEDED", "Calculated transaction fee exceeds policy limit");
    if (this.policy.cluster === "mainnet-beta") {
      assertQos(process.env.QOS_ENABLE_MAINNET_BROADCAST === "I_UNDERSTAND", "MAINNET_BROADCAST_DISABLED", "Set QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND to authorize a mainnet broadcast");
    }
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
      asset: values.kind,
      ...(values.kind === "native" ? { lamports: intent.inputAmount } : {
        mint: intent.mint,
        amount: intent.amount,
        decimals: intent.decimals,
        sourceTokenAccount: intent.sourceTokenAccount,
        destinationTokenAccount: intent.destinationTokenAccount,
      }),
      feeLamports: feeLamports.toString(),
      slot: status.slot,
      confirmationStatus: status.confirmationStatus,
      transactionBytes: signed.transactionBytes,
      explorerUrl: this.policy.cluster === "devnet"
        ? `https://explorer.solana.com/tx/${signed.signature}?cluster=devnet`
        : `https://explorer.solana.com/tx/${signed.signature}`,
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
