import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBase58 } from "./base58.js";
import { assertQos } from "./errors.js";
import {
  publicKeyAddress,
  writeNewEncryptedEd25519Key,
  writeNewEd25519Key,
} from "./key-store.js";
import { loadPolicy, parseRpcSlot, parseUnsigned, validateIntent, validatePolicy } from "./policy.js";
import { SolanaRpc } from "./rpc.js";
import { EphemeralSession } from "./session.js";
import {
  assembleSignedTransaction,
  buildNativeTransferMessage,
  buildTokenTransferCheckedMessage,
  parseNativeTransferMessage,
  parseTokenTransferCheckedMessage,
} from "./transaction.js";
import { openSigner, signerDescriptor } from "./signer.js";
import {
  associatedTokenAddress,
  parseMintAccount,
  parseTokenAccount,
  verifyTokenTransferAccounts,
} from "./token.js";
import { intentCommitment, policyCommitment, SnarkProofGate, unwrapProofRequest } from "./zk.js";
import { assertPrivateDirectory } from "./secure-file.js";
import { loadRuntimeProfile } from "./runtime-profile.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function sandboxPaths(home) {
  return {
    home,
    signerKey: join(home, "signer.pem"),
    encryptedSignerKey: join(home, "signer.qkey"),
    signerDescriptor: join(home, "signer.json"),
    receiverKey: join(home, "receiver.pem"),
    encryptedReceiverKey: join(home, "receiver.qkey"),
    legacyAuditKey: join(home, "audit.key"),
    legacyAuditLog: join(home, "audit.log"),
    legacyAuditLock: join(home, "audit.lock"),
    policy: join(home, "policy.json"),
  };
}

export function initializeSandbox(home, destination = undefined, {
  cluster = "devnet",
  signerPublicKey = undefined,
  keyPassphraseFile = undefined,
} = {}) {
  assertQos(!existsSync(home), "SANDBOX_ALREADY_EXISTS", `Refusing to overwrite existing sandbox: ${home}`);
  assertQos(cluster === "devnet" || cluster === "mainnet-beta", "UNSUPPORTED_CLUSTER", "Cluster must be devnet or mainnet-beta");
  assertQos(!(signerPublicKey !== undefined && keyPassphraseFile !== undefined), "SIGNER_CONFIG_CONFLICT", "External and encrypted software signer modes are mutually exclusive");
  if (signerPublicKey !== undefined) {
    decodeBase58(signerPublicKey, 32);
    assertQos(destination !== undefined, "DESTINATION_REQUIRED", "External signer initialization requires an explicit destination so qOS creates no private keys");
    assertQos(signerPublicKey !== destination, "SELF_TRANSFER_NOT_ALLOWED", "External signer and destination must be different accounts");
  }
  const policyFile = cluster === "devnet" ? "devnet.policy.json" : "mainnet.policy.json";
  const templateText = readFileSync(join(PROJECT_ROOT, "config", policyFile), "utf8");
  if (destination !== undefined) decodeBase58(destination, 32);
  const preflightPolicy = JSON.parse(templateText);
  preflightPolicy.allowedDestinations = [destination ?? "11111111111111111111111111111111"];
  validatePolicy(preflightPolicy);

  // Allow a first-run sandbox to use a nested --home path while retaining the
  // atomic sibling-directory initialization below.
  mkdirSync(dirname(home), { recursive: true, mode: 0o700 });
  const stagingHome = `${home}.init-${process.pid}-${Date.now()}`;
  assertQos(!existsSync(stagingHome), "SANDBOX_INIT_COLLISION", "Could not allocate a unique sandbox staging path");
  try {
    mkdirSync(stagingHome, { recursive: false, mode: 0o700 });
    chmodSync(stagingHome, 0o700);
    const stagingPaths = sandboxPaths(stagingHome);
    let signer;
    if (signerPublicKey !== undefined) {
      signer = signerPublicKey;
      writeFileSync(stagingPaths.signerDescriptor, `${JSON.stringify(signerDescriptor(signerPublicKey), null, 2)}\n`, { flag: "wx", mode: 0o600 });
      chmodSync(stagingPaths.signerDescriptor, 0o600);
    } else if (keyPassphraseFile !== undefined) {
      signer = publicKeyAddress(writeNewEncryptedEd25519Key(stagingPaths.encryptedSignerKey, keyPassphraseFile));
    } else {
      signer = publicKeyAddress(writeNewEd25519Key(stagingPaths.signerKey));
    }
    let receiver = destination;
    if (receiver === undefined) {
      receiver = keyPassphraseFile === undefined
        ? publicKeyAddress(writeNewEd25519Key(stagingPaths.receiverKey))
        : publicKeyAddress(writeNewEncryptedEd25519Key(stagingPaths.encryptedReceiverKey, keyPassphraseFile));
    }
    const template = JSON.parse(templateText);
    template.allowedDestinations = [receiver];
    validatePolicy(template);
    writeFileSync(stagingPaths.policy, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(stagingPaths.policy, 0o600);
    assertQos(!existsSync(home), "SANDBOX_ALREADY_EXISTS", `Refusing to overwrite existing sandbox: ${home}`);
    renameSync(stagingHome, home);
    return {
      home,
      signer,
      destination: receiver,
      cluster: template.cluster,
      clusterGenesis: template.clusterGenesis,
      tokenTransfer: template.tokenTransfer,
      retention: "ephemeral-memory",
      keyCustody: signerPublicKey !== undefined
        ? "non-exportable-external-boundary"
        : keyPassphraseFile !== undefined
          ? "aes-256-gcm-encrypted-at-rest"
          : "plaintext-development",
    };
  } catch (error) {
    rmSync(stagingHome, { recursive: true, force: true });
    throw error;
  }
}

function parsePrepareOptions(options, policy, session) {
  assertQos(options && typeof options === "object" && !Array.isArray(options), "INVALID_PREPARE_REQUEST", "Prepare request must be an object");
  const allowed = new Set(["requestNonce", "destination", "lamports", "maxFeeLamports", "strategyId"]);
  assertQos(Object.keys(options).every((key) => allowed.has(key)), "INVALID_PREPARE_REQUEST", "Prepare request contains unknown fields");
  const destination = options.destination ?? policy.allowedDestinations[0];
  const lamports = options.lamports ?? "1000000";
  const maxFeeLamports = options.maxFeeLamports ?? policy.maxFeeLamports;
  const strategyId = options.strategyId ?? policy.allowedStrategyIds[0];
  const requestNonce = options.requestNonce ?? session.nextNonce();
  parseUnsigned(lamports, 64, "lamports");
  parseUnsigned(maxFeeLamports, 64, "maxFeeLamports");
  parseUnsigned(requestNonce, 128, "requestNonce");
  assertQos(Number.isInteger(strategyId), "INVALID_STRATEGY_ID", "strategyId must be an integer");
  return { destination, lamports, maxFeeLamports, strategyId, requestNonce };
}

function parseTokenPrepareOptions(options, policy, session) {
  assertQos(policy.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "Policy does not enable token transfers");
  assertQos(options && typeof options === "object" && !Array.isArray(options), "INVALID_PREPARE_REQUEST", "Prepare request must be an object");
  const allowed = new Set(["requestNonce", "destination", "amount", "maxFeeLamports", "strategyId"]);
  assertQos(Object.keys(options).every((key) => allowed.has(key)), "INVALID_PREPARE_REQUEST", "Token prepare request contains unknown fields");
  const destination = options.destination ?? policy.allowedDestinations[0];
  const amount = options.amount ?? "1000000";
  const maxFeeLamports = options.maxFeeLamports ?? policy.maxFeeLamports;
  const strategyId = options.strategyId ?? policy.allowedStrategyIds[0];
  const requestNonce = options.requestNonce ?? session.nextNonce();
  parseUnsigned(amount, 64, "amount");
  parseUnsigned(maxFeeLamports, 64, "maxFeeLamports");
  parseUnsigned(requestNonce, 128, "requestNonce");
  assertQos(Number.isInteger(strategyId), "INVALID_STRATEGY_ID", "strategyId must be an integer");
  return { destination, amount, maxFeeLamports, strategyId, requestNonce };
}

export class QosService {
  constructor({ paths, policy, signer, session, rpc, proofGate = new SnarkProofGate(), runtimeProfile = null }) {
    this.paths = paths;
    this.policy = policy;
    this.signer = signer;
    this.publicKey = signer.publicKey;
    this.session = session;
    this.rpc = rpc;
    this.proofGate = proofGate;
    this.runtimeProfile = runtimeProfile;
  }

  static open(home, { rpcUrl = process.env.SOLANA_RPC_URL } = {}) {
    assertPrivateDirectory(home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS sandbox home" });
    const paths = sandboxPaths(home);
    const legacyFiles = [paths.legacyAuditKey, paths.legacyAuditLog, paths.legacyAuditLock].filter(existsSync);
    assertQos(
      legacyFiles.length === 0,
      "LEGACY_AUDIT_DATA_PRESENT",
      "This sandbox contains transaction audit data from qOS v0.5. Initialize a fresh qOS v0.6 home before using ephemeral mode.",
      { files: legacyFiles },
    );
    const policy = loadPolicy(paths.policy, rpcUrl);
    const signer = openSigner(paths);
    const session = new EphemeralSession();
    const proofGate = SnarkProofGate.fromEnvironment();
    const rpc = new SolanaRpc(policy.rpcUrl, {
      timeoutMs: policy.rpcTimeoutMs,
      commitment: policy.commitment,
    });
    const runtimeProfile = existsSync(join(home, "runtime.json")) ? loadRuntimeProfile(home) : null;
    return new QosService({ paths, policy, signer, session, rpc, proofGate, runtimeProfile });
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
      ...this.session.status(),
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
    const parsed = parsePrepareOptions(options, this.policy, this.session);
    assertQos(parsed.destination !== this.publicKey, "SELF_TRANSFER_NOT_ALLOWED", "Native SOL destination must differ from the firmware signer");
    const [genesis, blockhashResult, currentSlot] = await Promise.all([
      this.assertCluster(),
      this.rpc.getLatestBlockhash(),
      this.rpc.getSlot(),
    ]);
    assertQos(typeof blockhashResult?.value?.blockhash === "string", "RPC_INVALID_BLOCKHASH", "RPC returned an invalid latest blockhash");
    const slot = parseRpcSlot(currentSlot);
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
      expiresAtSlot: (slot + BigInt(this.policy.maxIntentTtlSlots)).toString(),
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
    const parsed = parseTokenPrepareOptions(options, this.policy, this.session);
    const source = this.tokenAddresses(this.publicKey).tokenAccount;
    const destinationTokenAccount = this.tokenAddresses(parsed.destination).tokenAccount;
    assertQos(source !== destinationTokenAccount, "DUPLICATE_TOKEN_ACCOUNT", "Token destination must not resolve to the signer token account");
    const [genesis, blockhashResult, currentSlot] = await Promise.all([
      this.assertCluster(),
      this.rpc.getLatestBlockhash(),
      this.rpc.getSlot(),
    ]);
    assertQos(typeof blockhashResult?.value?.blockhash === "string", "RPC_INVALID_BLOCKHASH", "RPC returned an invalid latest blockhash");
    const slot = parseRpcSlot(currentSlot);
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
      expiresAtSlot: (slot + BigInt(this.policy.maxIntentTtlSlots)).toString(),
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

  async submitIntent(request) {
    const { intent, privacyProof } = unwrapProofRequest(request);
    const [genesis, currentSlot] = await Promise.all([
      this.assertCluster(),
      this.rpc.getSlot(),
    ]);
    assertQos(genesis === intent?.clusterGenesis, "WRONG_CLUSTER", "Intent cluster does not match RPC cluster");
    const values = validateIntent(intent, this.policy, currentSlot);
    const releaseAuthorization = this.session.begin(intent.requestNonce, this.policy.maxRequestsPerMinute);
    let message;
    let signature;
    try {
    const proofResult = await this.proofGate.verify(intent, privacyProof, {
      policy: this.policy,
      signer: this.publicKey,
    });
    if (values.kind === "native") {
      assertQos(intent.destination !== this.publicKey, "SELF_TRANSFER_NOT_ALLOWED", "Native SOL destination must differ from the firmware signer");
    }
    const blockhashValid = await this.rpc.isBlockhashValid(intent.recentBlockhash);
    assertQos(blockhashValid === true, "INVALID_BLOCKHASH", "Intent recentBlockhash is not valid on the pinned cluster");
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
    const availableLamports = await this.balance();
    const requiredLamports = feeLamports + (values.kind === "native" ? values.amount : 0n);
    assertQos(availableLamports >= requiredLamports, "INSUFFICIENT_SOL_BALANCE", "Signer needs more SOL for the transfer and network fee", {
      signer: this.publicKey,
      availableLamports: availableLamports.toString(),
      requiredLamports: requiredLamports.toString(),
    });
    if (this.policy.cluster === "mainnet-beta") {
      assertQos(process.env.QOS_ENABLE_MAINNET_BROADCAST === "I_UNDERSTAND", "MAINNET_BROADCAST_DISABLED", "Set QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND to authorize a mainnet broadcast");
      const signerStatus = this.signer.status();
      assertQos(
        signerStatus?.keyExportableToAgentProcess === false
          || (signerStatus?.keyExportableToAgentProcess === true && this.runtimeProfile?.profile === "mainnet-insecure"),
        "MAINNET_EXTERNAL_SIGNER_REQUIRED",
        "Mainnet software signing requires a setup-created --insecure profile; otherwise use a non-exportable external signer",
      );
    }
    signature = await this.signer.sign(message, {
      version: 1,
      intent,
      intentCommitment: intentCommitment(intent),
      policyCommitment: policyCommitment(this.policy),
      privacyProofVerified: proofResult.verified,
    });
    const signed = assembleSignedTransaction(message, decodeBase58(this.publicKey, 32), signature);
    const simulation = await this.rpc.simulateTransaction(signed.transactionBase64);
    assertQos(simulation && simulation.err === null, "SIMULATION_FAILED", "Solana preflight simulation rejected the transaction");
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
      retention: "ephemeral-memory",
      transactionRetained: false,
      privacyProofVerified: proofResult.verified,
      explorerUrl: this.policy.cluster === "devnet"
        ? `https://explorer.solana.com/tx/${signed.signature}?cluster=devnet`
        : `https://explorer.solana.com/tx/${signed.signature}`,
    };
    } finally {
      if (Buffer.isBuffer(message)) message.fill(0);
      if (Buffer.isBuffer(signature)) signature.fill(0);
      releaseAuthorization();
    }
  }

  publicPolicy() {
    return {
      ...this.policy,
      rpcUrl: new URL(this.policy.rpcUrl).origin,
      signer: this.publicKey,
      keyCustody: this.signer.status(),
      privacyProof: this.proofGate.status(),
      ...this.session.status(),
    };
  }

  privacyStatus() {
    return {
      ...this.session.status(),
      transactionFiles: [],
      persistentFiles: [
        this.paths.signerKey,
        this.paths.encryptedSignerKey,
        this.paths.signerDescriptor,
        this.paths.receiverKey,
        this.paths.encryptedReceiverKey,
        this.paths.policy,
        join(this.paths.home, "runtime.json"),
        join(this.paths.home, "api-token"),
        join(this.paths.home, "agents", "registry.json"),
      ].filter(existsSync),
      persistentCredentialDirectories: [
        join(this.paths.home, "agents"),
      ].filter(existsSync),
      keyCustody: this.signer.status(),
      privacyProof: this.proofGate.status(),
      note: "Signer identity, policy, runtime credentials, onboarded agent scopes/credential files/skill packs, and key-custody configuration persist. Pending approvals and completed transaction details are not written by qOS.",
    };
  }
}
