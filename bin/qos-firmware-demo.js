#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, verify } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBase58, encodeBase58 } from "../src/base58.js";
import { assertQos, publicError, QosError } from "../src/errors.js";
import {
  loadPrivateKey,
  privateKeySeed,
  publicKeyAddress,
  publicKeyObjectFromRaw,
} from "../src/key-store.js";
import { loadPolicy, parseUnsigned } from "../src/policy.js";
import { SolanaRpc } from "../src/rpc.js";
import { parseNativeTransferMessage, parseTokenTransferCheckedMessage } from "../src/transaction.js";
import { associatedTokenAddress, verifyTokenTransferAccounts } from "../src/token.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRMWARE_DIR = join(ROOT, "firmware-demo");
const BUILD_DIR = join(ROOT, "build", "firmware-demo");
const FIRMWARE_ELF = join(FIRMWARE_DIR, "target", "riscv64imac-unknown-none-elf", "release", "qos-firmware-demo");
const PROVISIONING_FILE = join(BUILD_DIR, "provisioning.json");
const INTENT_FILE = join(BUILD_DIR, "intents.bin");
const FRAME_SIZE = 304;
const BUNDLE_MAGIC = Buffer.from("QOSINTV2");

function usage() {
  return `qOS QEMU firmware transaction demo

Usage:
  node bin/qos-firmware-demo.js build [--home PATH]
  node bin/qos-firmware-demo.js run [--home PATH] [--asset sol|token]
                                     [--lamports N | --amount N] [--broadcast]
  node bin/qos-firmware-demo.js demo [--home PATH] [--asset sol|token]
                                      [--lamports N | --amount N] [--broadcast]

build provisions the selected sandbox key and policy into an M-mode RV64 ELF.
run never reads signer.pem; it passes typed intents to QEMU and relays the result.
`;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    assertQos(token.startsWith("--"), "INVALID_ARGUMENT", `Unexpected argument: ${token}`);
    const name = token.slice(2);
    assertQos(!Object.hasOwn(options, name), "DUPLICATE_ARGUMENT", `Duplicate --${name}`);
    if (name === "broadcast") {
      options[name] = true;
      continue;
    }
    const value = argv[++index];
    assertQos(value !== undefined && !value.startsWith("--"), "MISSING_ARGUMENT", `Missing value for --${name}`);
    options[name] = value;
  }
  return { command, options };
}

function only(options, allowed) {
  const unknown = Object.keys(options).filter((name) => !allowed.includes(name));
  assertQos(unknown.length === 0, "UNKNOWN_ARGUMENT", `Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}`);
}

function homeOf(options) {
  return resolve(options.home ?? process.env.QOS_HOME ?? ".qos-devnet");
}

function policyPath(home) {
  return join(home, "policy.json");
}

function commandAvailable(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function restrictTree(path) {
  if (!existsSync(path)) return;
  const metadata = statSync(path);
  if (!metadata.isDirectory()) {
    chmodSync(path, (metadata.mode & 0o111) === 0 ? 0o600 : 0o700);
    return;
  }
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) restrictTree(join(path, entry));
}

function writeU128LE(buffer, value, offset) {
  let remaining = BigInt(value);
  for (let index = 0; index < 16; index += 1) {
    buffer[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

export function encodeIntentFrame({
  asset = "sol",
  requestNonce,
  clusterGenesis,
  destination,
  amount,
  minimumOutput,
  maxFeeLamports,
  recentBlockhash,
  expiresAtSlot,
  currentSlot,
  strategyId,
  mint = undefined,
  sourceTokenAccount = undefined,
  destinationTokenAccount = undefined,
  tokenProgram = undefined,
  decimals = 0,
}) {
  const frame = Buffer.alloc(FRAME_SIZE);
  assertQos(asset === "sol" || asset === "token", "INVALID_DEMO_ASSET", "Firmware asset must be sol or token");
  frame.writeUInt32LE(2, 0);
  frame.writeUInt32LE(asset === "token" ? 1 : 0, 4);
  writeU128LE(frame, requestNonce, 8);
  decodeBase58(clusterGenesis, 32).copy(frame, 24);
  decodeBase58(destination, 32).copy(frame, 56);
  frame.writeBigUInt64LE(BigInt(amount), 88);
  frame.writeBigUInt64LE(BigInt(minimumOutput), 96);
  frame.writeBigUInt64LE(BigInt(maxFeeLamports), 104);
  decodeBase58(recentBlockhash, 32).copy(frame, 112);
  frame.writeBigUInt64LE(BigInt(expiresAtSlot), 144);
  frame.writeBigUInt64LE(BigInt(currentSlot), 152);
  frame.writeUInt32LE(strategyId, 160);
  frame.writeUInt32LE(0, 164);
  if (asset === "token") {
    decodeBase58(mint, 32).copy(frame, 168);
    decodeBase58(sourceTokenAccount, 32).copy(frame, 200);
    decodeBase58(destinationTokenAccount, 32).copy(frame, 232);
    decodeBase58(tokenProgram, 32).copy(frame, 264);
    assertQos(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, "INVALID_TOKEN_DECIMALS", "Token decimals must fit in u8");
    frame[296] = decimals;
  }
  return frame;
}

export function encodeIntentBundle(frames) {
  assertQos(Array.isArray(frames) && frames.length >= 1 && frames.length <= 4, "INVALID_DEMO_BUNDLE", "Firmware demo bundle must contain one to four frames");
  const header = Buffer.alloc(16);
  BUNDLE_MAGIC.copy(header, 0);
  header.writeUInt32LE(frames.length, 8);
  header.writeUInt32LE(FRAME_SIZE, 12);
  return Buffer.concat([header, ...frames]);
}

export function parseFirmwareOutput(output) {
  const accepted = output.match(/QOS_FW:ACCEPT index=0 tx_hex=([0-9a-f]+)/);
  assertQos(accepted, "FIRMWARE_NO_TRANSACTION", "Firmware did not return the authorized transaction", { output });
  assertQos(/QOS_FW:REJECT index=1 code=AMOUNT/.test(output), "FIRMWARE_TAMPER_TEST_FAILED", "Firmware did not reject the over-limit amount");
  assertQos(/QOS_FW:REJECT index=2 code=NONCE_REPLAY/.test(output), "FIRMWARE_REPLAY_TEST_FAILED", "Firmware did not reject the replayed nonce");
  assertQos(/QOS_FW:DONE/.test(output), "FIRMWARE_DID_NOT_FINISH", "Firmware did not reach a clean completion");
  return Buffer.from(accepted[1], "hex");
}

function provisioningEnv(home, policy) {
  const privateKey = loadPrivateKey(join(home, "signer.pem"));
  assertQos(policy.allowedDestinations.length === 1, "DEMO_POLICY_DESTINATIONS", "Firmware demo requires exactly one pinned destination");
  const signer = publicKeyAddress(privateKey);
  const token = policy.tokenTransfer;
  const sourceTokenAccount = token === null ? null : associatedTokenAddress({
    owner: signer,
    mint: token.mint,
    tokenProgram: token.tokenProgram,
  });
  const destinationTokenAccount = token === null ? null : associatedTokenAddress({
    owner: policy.allowedDestinations[0],
    mint: token.mint,
    tokenProgram: token.tokenProgram,
  });
  return {
    privateKey,
    sourceTokenAccount,
    destinationTokenAccount,
    env: {
      ...process.env,
      QOS_FW_SEED_HEX: privateKeySeed(privateKey).toString("hex"),
      QOS_FW_GENESIS_HEX: decodeBase58(policy.clusterGenesis, 32).toString("hex"),
      QOS_FW_DESTINATION_HEX: decodeBase58(policy.allowedDestinations[0], 32).toString("hex"),
      QOS_FW_MAX_AMOUNT: policy.maxTransferLamports,
      QOS_FW_MAX_FEE: policy.maxFeeLamports,
      QOS_FW_MAX_TTL_SLOTS: String(policy.maxIntentTtlSlots),
      QOS_FW_STRATEGY_ID: String(policy.allowedStrategyIds[0]),
      QOS_FW_TOKEN_ENABLED: token === null ? "0" : "1",
      QOS_FW_TOKEN_MINT_HEX: token === null ? "0".repeat(64) : decodeBase58(token.mint, 32).toString("hex"),
      QOS_FW_TOKEN_PROGRAM_HEX: token === null ? "0".repeat(64) : decodeBase58(token.tokenProgram, 32).toString("hex"),
      QOS_FW_SOURCE_TOKEN_HEX: sourceTokenAccount === null ? "0".repeat(64) : decodeBase58(sourceTokenAccount, 32).toString("hex"),
      QOS_FW_DESTINATION_TOKEN_HEX: destinationTokenAccount === null ? "0".repeat(64) : decodeBase58(destinationTokenAccount, 32).toString("hex"),
      QOS_FW_TOKEN_DECIMALS: token === null ? "0" : String(token.decimals),
      QOS_FW_MAX_TOKEN_AMOUNT: token === null ? "0" : token.maxTransferAmount,
    },
  };
}

export function buildFirmware(home) {
  assertQos(commandAvailable("cargo"), "CARGO_REQUIRED", "Install Rust/Cargo before building the firmware demo");
  assertQos(commandAvailable("rustup"), "RUSTUP_REQUIRED", "Install rustup before building the firmware demo");
  const targets = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
  assertQos(targets.split(/\s+/).includes("riscv64imac-unknown-none-elf"), "RUST_TARGET_REQUIRED", "Run: rustup target add riscv64imac-unknown-none-elf");
  const policy = loadPolicy(policyPath(home), process.env.SOLANA_RPC_URL);
  const { privateKey, sourceTokenAccount, destinationTokenAccount, env } = provisioningEnv(home, policy);
  mkdirSync(BUILD_DIR, { recursive: true, mode: 0o700 });
  execFileSync("cargo", ["build", "--release"], {
    cwd: FIRMWARE_DIR,
    env,
    stdio: "inherit",
  });
  assertQos(existsSync(FIRMWARE_ELF), "FIRMWARE_BUILD_MISSING", "Cargo completed without producing the firmware ELF");
  restrictTree(join(FIRMWARE_DIR, "target"));
  const record = {
    version: 2,
    firmwareElf: FIRMWARE_ELF,
    firmwareSha256: sha256File(FIRMWARE_ELF),
    signer: publicKeyAddress(privateKey),
    clusterGenesis: policy.clusterGenesis,
    destination: policy.allowedDestinations[0],
    maxTransferLamports: policy.maxTransferLamports,
    maxFeeLamports: policy.maxFeeLamports,
    maxIntentTtlSlots: policy.maxIntentTtlSlots,
    strategyId: policy.allowedStrategyIds[0],
    tokenTransfer: policy.tokenTransfer === null ? null : {
      ...policy.tokenTransfer,
      sourceTokenAccount,
      destinationTokenAccount,
    },
    provisionedAt: new Date().toISOString(),
  };
  writeFileSync(PROVISIONING_FILE, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(PROVISIONING_FILE, 0o600);
  return record;
}

function loadProvisioning(home, policy) {
  assertQos(existsSync(PROVISIONING_FILE) && existsSync(FIRMWARE_ELF), "FIRMWARE_NOT_PROVISIONED", "Run the firmware demo build command first");
  const record = JSON.parse(readFileSync(PROVISIONING_FILE, "utf8"));
  assertQos(record.version === 2, "BAD_PROVISIONING_RECORD", "Unsupported firmware provisioning record");
  assertQos(record.firmwareSha256 === sha256File(FIRMWARE_ELF), "FIRMWARE_MEASUREMENT_MISMATCH", "Firmware ELF changed after provisioning");
  assertQos(record.clusterGenesis === policy.clusterGenesis, "PROVISIONING_POLICY_MISMATCH", "Provisioned cluster does not match current policy");
  assertQos(record.destination === policy.allowedDestinations[0], "PROVISIONING_POLICY_MISMATCH", "Provisioned destination does not match current policy");
  assertQos(record.maxTransferLamports === policy.maxTransferLamports && record.maxFeeLamports === policy.maxFeeLamports && record.maxIntentTtlSlots === policy.maxIntentTtlSlots, "PROVISIONING_POLICY_MISMATCH", "Provisioned limits do not match current policy");
  const expectedToken = policy.tokenTransfer === null ? null : {
    ...policy.tokenTransfer,
    sourceTokenAccount: associatedTokenAddress({ owner: record.signer, mint: policy.tokenTransfer.mint, tokenProgram: policy.tokenTransfer.tokenProgram }),
    destinationTokenAccount: associatedTokenAddress({ owner: policy.allowedDestinations[0], mint: policy.tokenTransfer.mint, tokenProgram: policy.tokenTransfer.tokenProgram }),
  };
  assertQos(JSON.stringify(record.tokenTransfer) === JSON.stringify(expectedToken), "PROVISIONING_POLICY_MISMATCH", "Provisioned token policy does not match current policy");
  return record;
}

function verifyFirmwareTransaction(transaction, record, intent) {
  assertQos(transaction.length >= 66 && transaction[0] === 1, "BAD_FIRMWARE_TRANSACTION", "Firmware returned a malformed transaction");
  const signature = transaction.subarray(1, 65);
  const message = transaction.subarray(65);
  const signer = decodeBase58(record.signer, 32);
  assertQos(verify(null, message, publicKeyObjectFromRaw(signer), signature), "BAD_FIRMWARE_SIGNATURE", "Firmware Ed25519 signature did not verify");
  if (intent.asset === "sol") {
    const parsed = parseNativeTransferMessage(message);
    assertQos(parsed.payer === record.signer, "BAD_FIRMWARE_PAYER", "Firmware transaction payer is not provisioned signer");
    assertQos(parsed.destination === intent.destination, "BAD_FIRMWARE_DESTINATION", "Firmware transaction destination differs from intent");
    assertQos(parsed.lamports === BigInt(intent.amount), "BAD_FIRMWARE_AMOUNT", "Firmware transaction amount differs from intent");
    assertQos(parsed.recentBlockhash === intent.recentBlockhash, "BAD_FIRMWARE_BLOCKHASH", "Firmware transaction blockhash differs from intent");
  } else {
    const parsed = parseTokenTransferCheckedMessage(message);
    assertQos(parsed.payer === record.signer, "BAD_FIRMWARE_PAYER", "Firmware token payer is not provisioned signer");
    assertQos(parsed.sourceTokenAccount === intent.sourceTokenAccount && parsed.destinationTokenAccount === intent.destinationTokenAccount, "BAD_FIRMWARE_TOKEN_ACCOUNTS", "Firmware token accounts differ from intent");
    assertQos(parsed.mint === intent.mint && parsed.tokenProgram === intent.tokenProgram && parsed.decimals === intent.decimals, "BAD_FIRMWARE_TOKEN_POLICY", "Firmware token instruction differs from provisioned policy");
    assertQos(parsed.amount === BigInt(intent.amount), "BAD_FIRMWARE_AMOUNT", "Firmware token amount differs from intent");
    assertQos(parsed.recentBlockhash === intent.recentBlockhash, "BAD_FIRMWARE_BLOCKHASH", "Firmware transaction blockhash differs from intent");
  }
  return { signature: encodeBase58(signature), message, transactionBase64: transaction.toString("base64") };
}

export async function runFirmware(home, { asset = "sol", lamports = undefined, amount = undefined, broadcast = false } = {}) {
  const qemu = process.env.QOS_FIRMWARE_DEMO_QEMU ?? "qemu-system-riscv64";
  assertQos(commandAvailable(qemu), "QEMU_REQUIRED", "Install qemu-system-riscv64 before running the firmware demo");
  const policy = loadPolicy(policyPath(home), process.env.SOLANA_RPC_URL);
  const record = loadProvisioning(home, policy);
  assertQos(asset === "sol" || asset === "token", "INVALID_DEMO_ASSET", "--asset must be sol or token");
  assertQos(!(lamports !== undefined && amount !== undefined), "CONFLICTING_AMOUNT_OPTIONS", "Use --lamports for SOL or --amount for tokens, not both");
  const amountText = asset === "sol" ? (lamports ?? amount ?? "1000000") : (amount ?? lamports ?? "1000000");
  const transferAmount = parseUnsigned(amountText, 64, asset === "sol" ? "lamports" : "amount");
  const maxAmount = asset === "sol" ? BigInt(record.maxTransferLamports) : BigInt(record.tokenTransfer?.maxTransferAmount ?? "0");
  assertQos(asset !== "token" || record.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "Provisioned firmware does not enable token transfers");
  assertQos(transferAmount > 0n && transferAmount <= maxAmount, "AMOUNT_LIMIT_EXCEEDED", "Demo transfer exceeds provisioned firmware policy");
  const rpc = new SolanaRpc(policy.rpcUrl, { timeoutMs: policy.rpcTimeoutMs, commitment: policy.commitment });
  const [genesis, latest, currentSlot] = await Promise.all([
    rpc.getGenesisHash(),
    rpc.getLatestBlockhash(),
    rpc.getSlot(),
  ]);
  assertQos(genesis === record.clusterGenesis, "RPC_CLUSTER_MISMATCH", "RPC endpoint does not match provisioned firmware cluster");
  assertQos(typeof latest?.value?.blockhash === "string", "RPC_INVALID_BLOCKHASH", "RPC returned an invalid blockhash");
  if (asset === "token") {
    await verifyTokenTransferAccounts({
      rpc,
      tokenPolicy: policy.tokenTransfer,
      sourceOwner: record.signer,
      destinationOwner: record.destination,
      sourceTokenAccount: record.tokenTransfer.sourceTokenAccount,
      destinationTokenAccount: record.tokenTransfer.destinationTokenAccount,
      amount: transferAmount,
    });
  }
  const base = {
    asset,
    requestNonce: 1n,
    clusterGenesis: genesis,
    destination: record.destination,
    amount: transferAmount,
    minimumOutput: transferAmount,
    maxFeeLamports: BigInt(record.maxFeeLamports),
    recentBlockhash: latest.value.blockhash,
    expiresAtSlot: BigInt(currentSlot) + BigInt(record.maxIntentTtlSlots),
    currentSlot: BigInt(currentSlot),
    strategyId: record.strategyId,
    ...(asset === "token" ? {
      mint: record.tokenTransfer.mint,
      sourceTokenAccount: record.tokenTransfer.sourceTokenAccount,
      destinationTokenAccount: record.tokenTransfer.destinationTokenAccount,
      tokenProgram: record.tokenTransfer.tokenProgram,
      decimals: record.tokenTransfer.decimals,
    } : {}),
  };
  const valid = encodeIntentFrame(base);
  const overLimit = maxAmount + 1n;
  const tampered = encodeIntentFrame({ ...base, requestNonce: 2n, amount: overLimit, minimumOutput: overLimit });
  const replay = encodeIntentFrame(base);
  mkdirSync(BUILD_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(INTENT_FILE, encodeIntentBundle([valid, tampered, replay]), { mode: 0o600 });
  chmodSync(INTENT_FILE, 0o600);

  const qemuResult = spawnSync(qemu, [
    "-machine", "virt",
    "-cpu", "rv64",
    "-smp", "1",
    "-m", "128M",
    "-bios", "none",
    "-kernel", FIRMWARE_ELF,
    "-device", `loader,file=${INTENT_FILE},addr=0x81000000,force-raw=on`,
    "-display", "none",
    "-serial", "stdio",
    "-monitor", "none",
    "-no-reboot",
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const firmwareOutput = `${qemuResult.stdout ?? ""}${qemuResult.stderr ?? ""}`;
  process.stdout.write(firmwareOutput);
  assertQos(!qemuResult.error, "QEMU_FAILED", `QEMU execution failed: ${qemuResult.error?.message}`);
  assertQos(qemuResult.status === 0, "QEMU_FAILED", `QEMU exited with status ${qemuResult.status}`, { firmwareOutput });
  const transaction = parseFirmwareOutput(firmwareOutput);
  const verified = verifyFirmwareTransaction(transaction, record, base);
  const fee = await rpc.getFeeForMessage(verified.message.toString("base64"));
  assertQos(Number.isSafeInteger(fee) && BigInt(fee) <= BigInt(record.maxFeeLamports), "FEE_LIMIT_EXCEEDED", "Live fee exceeds provisioned firmware policy");
  const simulation = await rpc.simulateTransaction(verified.transactionBase64);
  assertQos(simulation?.err === null, "SIMULATION_FAILED", "Firmware-signed transaction failed simulation", { err: simulation?.err, logs: simulation?.logs });
  if (!broadcast) {
    return {
      status: "verified",
      broadcast: false,
      asset,
      signer: record.signer,
      destination: record.destination,
      ...(asset === "sol" ? { lamports: amountText } : {
        mint: record.tokenTransfer.mint,
        amount: amountText,
        decimals: record.tokenTransfer.decimals,
        sourceTokenAccount: record.tokenTransfer.sourceTokenAccount,
        destinationTokenAccount: record.tokenTransfer.destinationTokenAccount,
      }),
      feeLamports: String(fee),
      signature: verified.signature,
      firmwareSha256: record.firmwareSha256,
    };
  }
  if (policy.cluster === "mainnet-beta") {
    assertQos(process.env.QOS_ENABLE_MAINNET_BROADCAST === "I_UNDERSTAND", "MAINNET_BROADCAST_DISABLED", "Set QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND to authorize a mainnet broadcast");
  }
  const rpcSignature = await rpc.sendTransaction(verified.transactionBase64);
  assertQos(rpcSignature === verified.signature, "SIGNATURE_MISMATCH", "RPC returned a different signature");
  const status = await rpc.confirmSignature(verified.signature, {
    timeoutMs: policy.confirmationTimeoutMs,
    recentBlockhash: latest.value.blockhash,
  });
  return {
    status: "confirmed",
    broadcast: true,
    asset,
    signer: record.signer,
    destination: record.destination,
    ...(asset === "sol" ? { lamports: amountText } : {
      mint: record.tokenTransfer.mint,
      amount: amountText,
      decimals: record.tokenTransfer.decimals,
      sourceTokenAccount: record.tokenTransfer.sourceTokenAccount,
      destinationTokenAccount: record.tokenTransfer.destinationTokenAccount,
    }),
    feeLamports: String(fee),
    signature: verified.signature,
    slot: status.slot,
    confirmationStatus: status.confirmationStatus,
    firmwareSha256: record.firmwareSha256,
    explorerUrl: policy.cluster === "devnet"
      ? `https://explorer.solana.com/tx/${verified.signature}?cluster=devnet`
      : `https://explorer.solana.com/tx/${verified.signature}`,
  };
}

async function main() {
  process.umask(0o077);
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") {
    process.stdout.write(usage());
    return;
  }
  const home = homeOf(options);
  if (command === "build") {
    only(options, ["home"]);
    process.stdout.write(`${JSON.stringify(buildFirmware(home), null, 2)}\n`);
    return;
  }
  if (command === "run") {
    only(options, ["home", "asset", "lamports", "amount", "broadcast"]);
    process.stdout.write(`${JSON.stringify(await runFirmware(home, {
      asset: options.asset,
      lamports: options.lamports,
      amount: options.amount,
      broadcast: options.broadcast === true,
    }), null, 2)}\n`);
    return;
  }
  if (command === "demo") {
    only(options, ["home", "asset", "lamports", "amount", "broadcast"]);
    buildFirmware(home);
    process.stdout.write(`${JSON.stringify(await runFirmware(home, {
      asset: options.asset,
      lamports: options.lamports,
      amount: options.amount,
      broadcast: options.broadcast === true,
    }), null, 2)}\n`);
    return;
  }
  throw new QosError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}
