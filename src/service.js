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
import { QOS_TOKEN_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants.js";
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
  buildCloudSettlementMessage,
  buildCloudWithdrawalMessage,
  buildNativeTransferMessage,
  buildTokenTransferCheckedMessage,
  parseCloudSettlementMessage,
  parseCloudWithdrawalMessage,
  parseNativeTransferMessage,
  parseTokenTransferCheckedMessage,
} from "./transaction.js";
import { openSigner, signerDescriptor } from "./signer.js";
import {
  associatedTokenAddress,
  parseGenericDestinationAccount,
  parseGenericMintAccount,
  parseMintAccount,
  parseOwnedTokenAccount,
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

function parseCloudSettlementOptions(options, policy, session) {
  assertQos(policy.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "Policy does not enable qOS Cloud settlement");
  assertQos(options && typeof options === "object" && !Array.isArray(options), "INVALID_PREPARE_REQUEST", "Cloud settlement request must be an object");
  const allowed = new Set(["requestNonce", "destination", "grossAmount", "burnRemainderBefore", "maxFeeLamports", "strategyId"]);
  assertQos(Object.keys(options).every((key) => allowed.has(key)), "INVALID_PREPARE_REQUEST", "Cloud settlement request contains unknown fields");
  const destination = options.destination ?? policy.allowedDestinations[0];
  const grossAmount = options.grossAmount;
  const burnRemainderBefore = options.burnRemainderBefore ?? "0";
  const maxFeeLamports = options.maxFeeLamports ?? policy.maxFeeLamports;
  const strategyId = options.strategyId ?? policy.allowedStrategyIds[0];
  const requestNonce = options.requestNonce ?? session.nextNonce();
  const gross = parseUnsigned(grossAmount, 64, "grossAmount");
  const remainder = parseUnsigned(burnRemainderBefore, 7, "burnRemainderBefore");
  parseUnsigned(maxFeeLamports, 64, "maxFeeLamports");
  parseUnsigned(requestNonce, 128, "requestNonce");
  assertQos(gross > 0n, "ZERO_AMOUNT", "Cloud settlement amount must be greater than zero");
  assertQos(remainder < 100n, "CLOUD_BURN_REMAINDER_INVALID", "Cloud burn remainder must be between 0 and 99 base units");
  assertQos(Number.isInteger(strategyId), "INVALID_STRATEGY_ID", "strategyId must be an integer");
  return { destination, grossAmount, burnRemainderBefore, maxFeeLamports, strategyId, requestNonce, gross, remainder };
}

function parseWalletAssetId(assetId) {
  assertQos(typeof assetId === "string" && assetId.length <= 192, "CLOUD_WITHDRAWAL_ASSET_INVALID", "Wallet asset ID is invalid");
  if (assetId === "sol") return { assetId, kind: "sol" };
  const match = /^token:([^:]+):([^:]+):([^:]+)$/.exec(assetId);
  assertQos(match !== null, "CLOUD_WITHDRAWAL_ASSET_INVALID", "Wallet asset ID is invalid");
  const [, tokenProgram, mint, tokenAccount] = match;
  assertQos(tokenProgram === TOKEN_PROGRAM_ID || tokenProgram === TOKEN_2022_PROGRAM_ID, "UNSUPPORTED_TOKEN_PROGRAM", "Wallet asset uses an unsupported token program");
  decodeBase58(mint, 32);
  decodeBase58(tokenAccount, 32);
  return { assetId, kind: "token", tokenProgram, mint, tokenAccount };
}

function parseCloudWithdrawalOptions(options, policy, session) {
  assertQos(options && typeof options === "object" && !Array.isArray(options), "INVALID_PREPARE_REQUEST", "Cloud withdrawal request must be an object");
  const allowed = new Set(["requestNonce", "assetId", "destination", "treasury", "grossAmount", "feeRemainderBefore", "maxFeeLamports", "strategyId"]);
  assertQos(Object.keys(options).every((key) => allowed.has(key)), "INVALID_PREPARE_REQUEST", "Cloud withdrawal request contains unknown fields");
  const asset = parseWalletAssetId(options.assetId);
  const destination = options.destination;
  const treasury = options.treasury;
  decodeBase58(destination, 32);
  decodeBase58(treasury, 32);
  assertQos(destination !== undefined && treasury !== undefined, "DESTINATION_REQUIRED", "Cloud withdrawal requires its owner destination and fee treasury");
  const gross = parseUnsigned(options.grossAmount, 64, "grossAmount");
  const remainder = parseUnsigned(options.feeRemainderBefore ?? "0", 14, "feeRemainderBefore");
  assertQos(gross > 0n, "ZERO_AMOUNT", "Cloud withdrawal amount must be greater than zero");
  assertQos(remainder < 10_000n, "CLOUD_WITHDRAWAL_FEE_REMAINDER_INVALID", "Cloud withdrawal fee remainder must be below ten thousand");
  const maxFeeLamports = options.maxFeeLamports ?? policy.maxFeeLamports;
  const strategyId = options.strategyId ?? policy.allowedStrategyIds[0];
  const requestNonce = options.requestNonce ?? session.nextNonce();
  parseUnsigned(maxFeeLamports, 64, "maxFeeLamports");
  parseUnsigned(requestNonce, 128, "requestNonce");
  assertQos(Number.isInteger(strategyId), "INVALID_STRATEGY_ID", "strategyId must be an integer");
  return { asset, destination, treasury, gross, remainder, maxFeeLamports, strategyId, requestNonce };
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

  async walletAssets(owner = this.publicKey) {
    decodeBase58(owner, 32);
    await this.assertCluster();
    const [lamports, classicAccounts, extensionAccounts] = await Promise.all([
      this.balance(owner),
      this.rpc.getTokenAccountsByOwner(owner, TOKEN_PROGRAM_ID),
      this.rpc.getTokenAccountsByOwner(owner, TOKEN_2022_PROGRAM_ID),
    ]);
    const parsedAccounts = [];
    for (const [tokenProgram, entries] of [[TOKEN_PROGRAM_ID, classicAccounts], [TOKEN_2022_PROGRAM_ID, extensionAccounts]]) {
      for (const entry of entries) {
        try {
          const parsed = parseOwnedTokenAccount(entry, { tokenProgram, owner, field: "walletTokenAccount" });
          if (parsed.amount > 0n) parsedAccounts.push(parsed);
        } catch (error) {
          if (error?.code !== "TOKEN_ACCOUNT_NATIVE_STATE") throw error;
        }
      }
    }
    const mintKeys = [...new Set(parsedAccounts.map((item) => item.mint))];
    const mintValues = [];
    for (let offset = 0; offset < mintKeys.length; offset += 100) {
      mintValues.push(...await this.rpc.getMultipleAccounts(mintKeys.slice(offset, offset + 100)));
    }
    const mintByAddress = new Map(mintKeys.map((mint, index) => [mint, mintValues[index]]));
    const assets = [{
      assetId: "sol",
      kind: "sol",
      symbol: "SOL",
      mint: null,
      tokenProgram: null,
      tokenAccount: null,
      amount: lamports.toString(),
      decimals: 9,
      withdrawSupported: true,
      errorCode: null,
    }];
    for (const account of parsedAccounts) {
      let mint;
      let errorCode = null;
      try { mint = parseGenericMintAccount(mintByAddress.get(account.mint), account.tokenProgram); }
      catch (error) { errorCode = error?.code ?? "INVALID_MINT_ACCOUNT"; }
      assets.push({
        assetId: `token:${account.tokenProgram}:${account.mint}:${account.tokenAccount}`,
        kind: "token",
        symbol: account.mint === QOS_TOKEN_MINT ? "qOS" : null,
        mint: account.mint,
        tokenProgram: account.tokenProgram,
        tokenAccount: account.tokenAccount,
        amount: account.amount.toString(),
        decimals: mint?.decimals ?? null,
        withdrawSupported: mint !== undefined,
        errorCode,
      });
    }
    assets.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "sol" ? -1 : 1;
      if (left.symbol === "qOS" && right.symbol !== "qOS") return -1;
      if (right.symbol === "qOS" && left.symbol !== "qOS") return 1;
      return String(left.mint).localeCompare(String(right.mint));
    });
    return { version: 1, owner, assets };
  }

  async prepareCloudWithdrawalIntent(options = {}) {
    const parsed = parseCloudWithdrawalOptions(options, this.policy, this.session);
    assertQos(parsed.destination !== this.publicKey && parsed.treasury !== this.publicKey, "SELF_TRANSFER_NOT_ALLOWED", "Cloud withdrawal destinations must differ from the billing signer");
    const [genesis, blockhashResult, currentSlot] = await Promise.all([
      this.assertCluster(),
      this.rpc.getLatestBlockhash(),
      this.rpc.getSlot(),
    ]);
    assertQos(typeof blockhashResult?.value?.blockhash === "string", "RPC_INVALID_BLOCKHASH", "RPC returned an invalid latest blockhash");
    const slot = parseRpcSlot(currentSlot);
    const feeNumerator = parsed.remainder + parsed.gross * 25n;
    const feeAmount = feeNumerator / 10_000n;
    const destinationAmount = parsed.gross - feeAmount;
    const tokenFields = {
      mint: null,
      tokenProgram: null,
      sourceTokenAccount: null,
      destinationTokenAccount: null,
      treasuryTokenAccount: null,
      decimals: null,
      createDestinationTokenAccount: false,
      createTreasuryTokenAccount: false,
    };
    if (parsed.asset.kind === "token") {
      const destinationTokenAccount = associatedTokenAddress({ owner: parsed.destination, mint: parsed.asset.mint, tokenProgram: parsed.asset.tokenProgram });
      const treasuryTokenAccount = associatedTokenAddress({ owner: parsed.treasury, mint: parsed.asset.mint, tokenProgram: parsed.asset.tokenProgram });
      const [sourceInfo, mintInfo, destinationInfo, treasuryInfo] = await Promise.all([
        this.rpc.getAccountInfo(parsed.asset.tokenAccount),
        this.rpc.getAccountInfo(parsed.asset.mint),
        this.rpc.getAccountInfo(destinationTokenAccount),
        destinationTokenAccount === treasuryTokenAccount ? Promise.resolve(null) : this.rpc.getAccountInfo(treasuryTokenAccount),
      ]);
      const source = parseOwnedTokenAccount(sourceInfo, { tokenProgram: parsed.asset.tokenProgram, owner: this.publicKey, field: "withdrawalSourceTokenAccount" });
      assertQos(source.mint === parsed.asset.mint, "TOKEN_ACCOUNT_MINT_MISMATCH", "Withdrawal source token account is for a different mint");
      assertQos(source.amount >= parsed.gross, "INSUFFICIENT_TOKEN_BALANCE", "Wallet token balance is below the requested withdrawal amount");
      const mint = parseGenericMintAccount(mintInfo, parsed.asset.tokenProgram);
      if (destinationInfo !== null) parseGenericDestinationAccount(destinationInfo, { tokenProgram: parsed.asset.tokenProgram, mint: parsed.asset.mint, owner: parsed.destination, field: "withdrawalDestinationTokenAccount" });
      if (treasuryTokenAccount !== destinationTokenAccount && treasuryInfo !== null) parseGenericDestinationAccount(treasuryInfo, { tokenProgram: parsed.asset.tokenProgram, mint: parsed.asset.mint, owner: parsed.treasury, field: "withdrawalTreasuryTokenAccount" });
      Object.assign(tokenFields, {
        mint: parsed.asset.mint,
        tokenProgram: parsed.asset.tokenProgram,
        sourceTokenAccount: parsed.asset.tokenAccount,
        destinationTokenAccount,
        treasuryTokenAccount,
        decimals: mint.decimals,
        createDestinationTokenAccount: destinationInfo === null,
        createTreasuryTokenAccount: feeAmount > 0n && treasuryTokenAccount !== destinationTokenAccount && treasuryInfo === null,
      });
    }
    const intent = {
      version: 4,
      requestNonce: parsed.requestNonce,
      clusterGenesis: genesis,
      venueId: this.policy.venueId,
      marketId: this.policy.marketId,
      side: "WITHDRAW",
      assetKind: parsed.asset.kind,
      ...tokenFields,
      grossAmount: parsed.gross.toString(),
      destinationAmount: destinationAmount.toString(),
      feeAmount: feeAmount.toString(),
      feeBasisPoints: 25,
      feeRemainderBefore: parsed.remainder.toString(),
      feeRemainderAfter: (feeNumerator % 10_000n).toString(),
      maxFeeLamports: parsed.maxFeeLamports,
      maxCuPrice: "0",
      maxRelayTip: "0",
      destination: parsed.destination,
      treasury: parsed.treasury,
      recentBlockhash: blockhashResult.value.blockhash,
      expiresAtSlot: (slot + BigInt(this.policy.maxIntentTtlSlots)).toString(),
      strategyId: parsed.strategyId,
      operatorApproval: null,
    };
    validateIntent(intent, this.policy, currentSlot);
    return intent;
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

  async prepareCloudSettlementIntent(options = {}) {
    const parsed = parseCloudSettlementOptions(options, this.policy, this.session);
    const source = this.tokenAddresses(this.publicKey).tokenAccount;
    const destinationTokenAccount = this.tokenAddresses(parsed.destination).tokenAccount;
    assertQos(source !== destinationTokenAccount, "DUPLICATE_TOKEN_ACCOUNT", "Cloud settlement destination must differ from the billing token account");
    const [genesis, blockhashResult, currentSlot] = await Promise.all([
      this.assertCluster(),
      this.rpc.getLatestBlockhash(),
      this.rpc.getSlot(),
    ]);
    assertQos(typeof blockhashResult?.value?.blockhash === "string", "RPC_INVALID_BLOCKHASH", "RPC returned an invalid latest blockhash");
    const slot = parseRpcSlot(currentSlot);
    const burnNumerator = parsed.remainder + parsed.gross;
    const burnAmount = burnNumerator / 100n;
    const treasuryAmount = parsed.gross - burnAmount;
    const intent = {
      version: 3,
      requestNonce: parsed.requestNonce,
      clusterGenesis: genesis,
      venueId: this.policy.venueId,
      marketId: this.policy.marketId,
      side: "SETTLE",
      mint: this.policy.tokenTransfer.mint,
      grossAmount: parsed.gross.toString(),
      treasuryAmount: treasuryAmount.toString(),
      burnAmount: burnAmount.toString(),
      burnBasisPoints: 100,
      burnRemainderBefore: parsed.remainder.toString(),
      burnRemainderAfter: (burnNumerator % 100n).toString(),
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
      amount: values.grossAmount,
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
    } else if (values.kind === "cloud-withdrawal") {
      if (intent.assetKind === "token") {
        const expectedDestination = associatedTokenAddress({ owner: intent.destination, mint: intent.mint, tokenProgram: intent.tokenProgram });
        const expectedTreasury = associatedTokenAddress({ owner: intent.treasury, mint: intent.mint, tokenProgram: intent.tokenProgram });
        assertQos(intent.destinationTokenAccount === expectedDestination && intent.treasuryTokenAccount === expectedTreasury, "TEMPLATE_SELF_CHECK_FAILED", "Withdrawal associated token accounts changed");
        const [sourceInfo, mintInfo] = await Promise.all([
          this.rpc.getAccountInfo(intent.sourceTokenAccount),
          this.rpc.getAccountInfo(intent.mint),
        ]);
        const source = parseOwnedTokenAccount(sourceInfo, { tokenProgram: intent.tokenProgram, owner: this.publicKey, field: "withdrawalSourceTokenAccount" });
        assertQos(source.mint === intent.mint && source.amount >= values.grossAmount, "INSUFFICIENT_TOKEN_BALANCE", "Withdrawal source token balance or mint changed");
        const mint = parseGenericMintAccount(mintInfo, intent.tokenProgram);
        assertQos(mint.decimals === intent.decimals, "MINT_DECIMALS_MISMATCH", "Withdrawal token decimals changed");
      }
      message = buildCloudWithdrawalMessage({ ...intent, payer: this.publicKey });
      const parsedMessage = parseCloudWithdrawalMessage(message);
      assertQos(parsedMessage.payer === this.publicKey && parsedMessage.recentBlockhash === intent.recentBlockhash && parsedMessage.assetKind === intent.assetKind, "TEMPLATE_SELF_CHECK_FAILED", "Constructed cloud withdrawal did not match the authorized intent");
      assertQos(parsedMessage.transfers.length === (values.feeAmount > 0n ? 2 : 1), "TEMPLATE_SELF_CHECK_FAILED", "Constructed cloud withdrawal transfer count changed");
      if (intent.assetKind === "sol") {
        assertQos(parsedMessage.transfers[0].destination === intent.destination && parsedMessage.transfers[0].amount === values.destinationAmount, "TEMPLATE_SELF_CHECK_FAILED", "Constructed SOL withdrawal destination changed");
        if (values.feeAmount > 0n) assertQos(parsedMessage.transfers[1].destination === intent.treasury && parsedMessage.transfers[1].amount === values.feeAmount, "TEMPLATE_SELF_CHECK_FAILED", "Constructed SOL withdrawal fee changed");
      } else {
        assertQos(parsedMessage.tokenProgram === intent.tokenProgram && parsedMessage.transfers[0].sourceTokenAccount === intent.sourceTokenAccount
          && parsedMessage.transfers[0].mint === intent.mint && parsedMessage.transfers[0].destinationTokenAccount === intent.destinationTokenAccount
          && parsedMessage.transfers[0].amount === values.destinationAmount && parsedMessage.transfers[0].decimals === intent.decimals,
        "TEMPLATE_SELF_CHECK_FAILED", "Constructed token withdrawal destination changed");
        if (values.feeAmount > 0n) assertQos(parsedMessage.transfers[1].destinationTokenAccount === intent.treasuryTokenAccount && parsedMessage.transfers[1].amount === values.feeAmount, "TEMPLATE_SELF_CHECK_FAILED", "Constructed token withdrawal fee changed");
      }
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
      if (values.kind === "cloud-settlement") {
        message = buildCloudSettlementMessage({
          payer: this.publicKey,
          sourceTokenAccount: intent.sourceTokenAccount,
          destinationTokenAccount: intent.destinationTokenAccount,
          mint: intent.mint,
          tokenProgram: intent.tokenProgram,
          treasuryAmount: values.treasuryAmount,
          burnAmount: values.burnAmount,
          decimals: intent.decimals,
          recentBlockhash: intent.recentBlockhash,
        });
        const parsedMessage = parseCloudSettlementMessage(message);
        assertQos(parsedMessage.payer === this.publicKey && parsedMessage.sourceTokenAccount === intent.sourceTokenAccount && parsedMessage.destinationTokenAccount === intent.destinationTokenAccount && parsedMessage.mint === intent.mint && parsedMessage.tokenProgram === intent.tokenProgram && parsedMessage.treasuryAmount === values.treasuryAmount && parsedMessage.burnAmount === values.burnAmount && parsedMessage.decimals === intent.decimals, "TEMPLATE_SELF_CHECK_FAILED", "Constructed cloud settlement did not match the authorized intent");
      } else {
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
    }
    const messageBase64 = message.toString("base64");
    const fee = await this.rpc.getFeeForMessage(messageBase64);
    assertQos(Number.isSafeInteger(fee) && fee >= 0, "FEE_UNAVAILABLE", "RPC could not calculate a valid transaction fee");
    const feeLamports = BigInt(fee);
    assertQos(feeLamports <= values.maxFee, "ACTUAL_FEE_LIMIT_EXCEEDED", "Calculated transaction fee exceeds intent limit");
    assertQos(feeLamports <= BigInt(this.policy.maxFeeLamports), "POLICY_FEE_LIMIT_EXCEEDED", "Calculated transaction fee exceeds policy limit");
    const availableLamports = await this.balance();
    const requiredLamports = feeLamports + (values.kind === "native" || (values.kind === "cloud-withdrawal" && intent.assetKind === "sol") ? values.amount : 0n);
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
      ...(values.kind === "native" ? { lamports: intent.inputAmount } : values.kind === "cloud-withdrawal" ? {
        assetKind: intent.assetKind,
        mint: intent.mint,
        tokenProgram: intent.tokenProgram,
        sourceTokenAccount: intent.sourceTokenAccount,
        destinationTokenAccount: intent.destinationTokenAccount,
        treasuryTokenAccount: intent.treasuryTokenAccount,
        grossAmount: intent.grossAmount,
        destinationAmount: intent.destinationAmount,
        feeAmount: intent.feeAmount,
        feeBasisPoints: intent.feeBasisPoints,
        feeRemainderAfter: intent.feeRemainderAfter,
        decimals: intent.decimals,
        treasury: intent.treasury,
      } : values.kind === "cloud-settlement" ? {
        mint: intent.mint,
        grossAmount: intent.grossAmount,
        treasuryAmount: intent.treasuryAmount,
        burnAmount: intent.burnAmount,
        burnBasisPoints: intent.burnBasisPoints,
        burnRemainderAfter: intent.burnRemainderAfter,
        decimals: intent.decimals,
        sourceTokenAccount: intent.sourceTokenAccount,
        destinationTokenAccount: intent.destinationTokenAccount,
      } : {
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
