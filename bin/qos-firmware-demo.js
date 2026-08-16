#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, verify } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { decodeBase58, encodeBase58 } from "../src/base58.js";
import { canonicalJson } from "../src/canonical.js";
import { assertQos, publicError, QosError } from "../src/errors.js";
import {
  loadPrivateKey,
  privateKeySeed,
  publicKeyAddress,
  publicKeyObjectFromRaw,
} from "../src/key-store.js";
import { loadPolicy, parseRpcSlot, parseUnsigned } from "../src/policy.js";
import { SolanaRpc } from "../src/rpc.js";
import {
  buildNativeTransferMessage,
  buildTokenTransferCheckedMessage,
  parseNativeTransferMessage,
  parseTokenTransferCheckedMessage,
} from "../src/transaction.js";
import { associatedTokenAddress, verifyTokenTransferAccounts } from "../src/token.js";
import { assertPrivateDirectory, readSecureFile } from "../src/secure-file.js";
import { assertTrustedExecutable } from "../src/subprocess.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRMWARE_DIR = join(ROOT, "firmware-demo");
const BUILD_DIR = join(ROOT, "build", "firmware-demo");
const CARGO_FIRMWARE_ELF = join(FIRMWARE_DIR, "target", "riscv64imac-unknown-none-elf", "release", "qos-firmware-demo");
const FIRMWARE_ELF = join(BUILD_DIR, "qos-firmware-demo.elf");
const PROVISIONING_FILE = join(BUILD_DIR, "provisioning.json");
const FRAME_SIZE = 304;
const BUNDLE_MAGIC = Buffer.from("QOSINTV2");
const KEY_MAGIC = Buffer.from("QOSKEYV1");
const LINUX_TMPFS_MAGIC = 0x01021994;
const DEFAULT_QEMU = "/usr/bin/qemu-system-riscv64";
const SAFE_TOOL_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function usage() {
  return `qOS QEMU firmware transaction demo

Usage:
  node bin/qos-firmware-demo.js build [--home PATH]
  node bin/qos-firmware-demo.js run [--home PATH] [--asset sol|token]
                                     [--lamports N | --amount N] [--offline | --broadcast]
  node bin/qos-firmware-demo.js demo [--home PATH] [--asset sol|token]
                                      [--lamports N | --amount N] [--offline | --broadcast]

build provisions a key-independent M-mode RV64 ELF and records its measurement.
run reads signer.pem only to create an unlinked RAM key mailbox for QEMU.
Mainnet broadcast is forbidden because that software seed is host-readable.
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
    if (name === "broadcast" || name === "offline") {
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
  return resolve(options.home ?? process.env.QOS_HOME ?? ".qos-ephemeral-devnet");
}

function policyPath(home) {
  return join(home, "policy.json");
}

function toolEnvironment({ isolatedCargo = false } = {}) {
  const installedCargoHome = resolve(process.env.CARGO_HOME ?? join(process.env.HOME ?? "/", ".cargo"));
  return {
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    CARGO_HOME: isolatedCargo ? join(BUILD_DIR, "cargo-home") : installedCargoHome,
    ...(process.env.RUSTUP_HOME === undefined ? {} : { RUSTUP_HOME: process.env.RUSTUP_HOME }),
    PATH: `${join(installedCargoHome, "bin")}:${SAFE_TOOL_PATH}`,
    LANG: "C",
    LC_ALL: "C",
  };
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: "/",
    env: toolEnvironment(),
    stdio: "ignore",
    timeout: 5_000,
  });
  return result.error === undefined && result.status === 0;
}

function sha256File(path) {
  const bytes = readSecureFile(path, {
    privateFile: true,
    maxBytes: 64 * 1024 * 1024,
    errorCode: "INSECURE_FIRMWARE_FILE",
    label: "Firmware ELF",
  });
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

function restrictTree(path) {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  assertQos(!metadata.isSymbolicLink(), "UNSAFE_BUILD_OUTPUT", "Firmware build output must not contain symbolic links");
  if (!metadata.isDirectory()) {
    chmodSync(path, (metadata.mode & 0o111) === 0 ? 0o600 : 0o700);
    return;
  }
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) restrictTree(join(path, entry));
}

export function installFirmwareElf(source, destination) {
  assertQos(resolve(source) !== resolve(destination), "INVALID_FIRMWARE_INSTALL", "Cargo output and installed firmware paths must differ");
  assertPrivateDirectory(dirname(destination), {
    errorCode: "INSECURE_FIRMWARE_INSTALL_DIRECTORY",
    label: "Firmware install directory",
  });
  const bytes = readSecureFile(source, {
    privateFile: true,
    requireSingleLink: false,
    maxBytes: 64 * 1024 * 1024,
    errorCode: "INSECURE_FIRMWARE_BUILD_OUTPUT",
    label: "Cargo firmware ELF",
  });
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o700 });
    chmodSync(temporary, 0o700);
    renameSync(temporary, destination);
    return destination;
  } catch (error) {
    if (error instanceof QosError) throw error;
    throw new QosError("FIRMWARE_INSTALL_FAILED", "Could not install the private firmware ELF");
  } finally {
    bytes.fill(0);
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch {}
    }
  }
}

function writeU128LE(buffer, value, offset) {
  let remaining = BigInt(value);
  assertQos(remaining >= 0n && remaining < (1n << 128n), "INTEGER_OUT_OF_RANGE", "requestNonce does not fit in u128");
  for (let index = 0; index < 16; index += 1) {
    buffer[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

export function clusterGenesisBytes(clusterGenesis) {
  const decoded = decodeBase58(clusterGenesis, 32);
  const field = Buffer.alloc(32);
  decoded.copy(field, field.length - decoded.length);
  return field;
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
  clusterGenesisBytes(clusterGenesis).copy(frame, 24);
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
  assertQos(frames.every((frame) => Buffer.isBuffer(frame) && frame.length === FRAME_SIZE), "INVALID_DEMO_FRAME", `Every firmware intent frame must be exactly ${FRAME_SIZE} bytes`);
  const header = Buffer.alloc(16);
  BUNDLE_MAGIC.copy(header, 0);
  header.writeUInt32LE(frames.length, 8);
  header.writeUInt32LE(FRAME_SIZE, 12);
  return Buffer.concat([header, ...frames]);
}

export function encodeKeyMailbox(seed) {
  assertQos(Buffer.isBuffer(seed) && seed.length === 32, "INVALID_FIRMWARE_SEED", "Firmware seed must be exactly 32 bytes");
  return Buffer.concat([KEY_MAGIC, seed]);
}

export function openRamBackedFile(bytes, label = "mailbox") {
  assertQos(Buffer.isBuffer(bytes), "INVALID_RAM_FILE", "RAM-backed mailbox contents must be a Buffer");
  const directory = resolve(process.env.QOS_RAM_DIR ?? "/dev/shm");
  let fsType;
  try {
    fsType = Number(statfsSync(directory).type);
  } catch {
    assertQos(false, "RAM_FILESYSTEM_REQUIRED", "qOS requires a readable RAM-backed directory at /dev/shm or QOS_RAM_DIR");
  }
  assertQos(fsType === LINUX_TMPFS_MAGIC, "RAM_FILESYSTEM_REQUIRED", "QOS_RAM_DIR must be a Linux tmpfs RAM filesystem");
  const path = join(directory, ".qos-" + process.pid + "-" + randomBytes(12).toString("hex") + "-" + label);
  let fd;
  try {
    fd = openSync(path, "wx+", 0o600);
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written, written);
      assertQos(count > 0, "RAM_FILE_WRITE_FAILED", "Could not finish writing the RAM-backed mailbox");
      written += count;
    }
    unlinkSync(path);
    return fd;
  } catch (error) {
    if (existsSync(path)) unlinkSync(path);
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}

export function redactFirmwareOutput(output) {
  return output.replace(/(QOS_FW:ACCEPT index=[0-9]+ signature_hex=)[0-9a-f]+/g, "$1<redacted-in-memory>");
}

export function parseFirmwareOutput(output) {
  const accepted = [...output.matchAll(/QOS_FW:ACCEPT index=(\d+) signature_hex=([0-9a-f]{128})(?![0-9a-f])/g)];
  assertQos(accepted.length === 1 && accepted[0][1] === "0", "FIRMWARE_ACCEPT_SET_INVALID", "Firmware must accept exactly the first intent and no others", { output: redactFirmwareOutput(output) });
  assertQos(/QOS_FW:REJECT index=1 code=AMOUNT/.test(output), "FIRMWARE_TAMPER_TEST_FAILED", "Firmware did not reject the over-limit amount");
  assertQos(/QOS_FW:REJECT index=2 code=NONCE_REPLAY/.test(output), "FIRMWARE_REPLAY_TEST_FAILED", "Firmware did not reject the replayed nonce");
  assertQos(/QOS_FW:DONE/.test(output), "FIRMWARE_DID_NOT_FINISH", "Firmware did not reach a clean completion");
  return Buffer.from(accepted[0][2], "hex");
}

function provisioningEnv(home, policy) {
  const privateKey = loadPrivateKey(join(home, "signer.pem"));
  assertQos(policy.allowedDestinations.length === 1, "DEMO_POLICY_DESTINATIONS", "Firmware demo requires exactly one pinned destination");
  assertQos(policy.allowedStrategyIds.length === 1, "DEMO_POLICY_STRATEGIES", "Firmware demo requires exactly one pinned strategy ID");
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
      ...toolEnvironment({ isolatedCargo: true }),
      QOS_FW_SIGNER_HEX: decodeBase58(signer, 32).toString("hex"),
      QOS_FW_GENESIS_HEX: clusterGenesisBytes(policy.clusterGenesis).toString("hex"),
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
  assertPrivateDirectory(home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS sandbox home" });
  assertQos(existsSync(policyPath(home)), "SANDBOX_NOT_INITIALIZED", `No qOS policy found at ${policyPath(home)}; run node bin/qos.js init first`);
  assertQos(existsSync(join(home, "signer.pem")), "SANDBOX_NOT_INITIALIZED", `No qOS signer found in ${home}; run node bin/qos.js init first`);
  assertQos(commandAvailable("cargo"), "CARGO_REQUIRED", "Install Rust/Cargo before building the firmware demo");
  assertQos(commandAvailable("rustup"), "RUSTUP_REQUIRED", "Install rustup before building the firmware demo");
  const targets = execFileSync("rustup", ["target", "list", "--installed"], {
    cwd: "/",
    env: toolEnvironment(),
    encoding: "utf8",
  });
  assertQos(targets.split(/\s+/).includes("riscv64imac-unknown-none-elf"), "RUST_TARGET_REQUIRED", "Run: rustup target add riscv64imac-unknown-none-elf");
  const policy = loadPolicy(policyPath(home), process.env.SOLANA_RPC_URL);
  const { privateKey, sourceTokenAccount, destinationTokenAccount, env } = provisioningEnv(home, policy);
  mkdirSync(BUILD_DIR, { recursive: true, mode: 0o700 });
  chmodSync(BUILD_DIR, 0o700);
  execFileSync("cargo", ["build", "--release", "--locked"], {
    cwd: FIRMWARE_DIR,
    env,
    stdio: "inherit",
  });
  assertQos(existsSync(CARGO_FIRMWARE_ELF), "FIRMWARE_BUILD_MISSING", "Cargo completed without producing the firmware ELF");
  restrictTree(join(FIRMWARE_DIR, "target"));
  installFirmwareElf(CARGO_FIRMWARE_ELF, FIRMWARE_ELF);
  const record = {
    version: 3,
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
  const temporaryProvisioningFile = `${PROVISIONING_FILE}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    writeFileSync(temporaryProvisioningFile, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temporaryProvisioningFile, 0o600);
    renameSync(temporaryProvisioningFile, PROVISIONING_FILE);
  } finally {
    if (existsSync(temporaryProvisioningFile)) unlinkSync(temporaryProvisioningFile);
  }
  return record;
}

export function validateProvisioningRecord(record, policy, firmwareSha256) {
  assertQos(record && typeof record === "object" && !Array.isArray(record), "BAD_PROVISIONING_RECORD", "Firmware provisioning record must be an object");
  assertQos(record.version === 3, "BAD_PROVISIONING_RECORD", "Unsupported firmware provisioning record");
  decodeBase58(record.signer, 32).fill(0);
  assertQos(record.firmwareSha256 === firmwareSha256, "FIRMWARE_MEASUREMENT_MISMATCH", "Firmware ELF changed after provisioning");
  assertQos(policy.allowedDestinations.length === 1, "PROVISIONING_POLICY_MISMATCH", "Firmware demo policy must still contain exactly one destination");
  assertQos(policy.allowedStrategyIds.length === 1, "PROVISIONING_POLICY_MISMATCH", "Firmware demo policy must still contain exactly one strategy ID");
  assertQos(record.clusterGenesis === policy.clusterGenesis, "PROVISIONING_POLICY_MISMATCH", "Provisioned cluster does not match current policy");
  assertQos(record.destination === policy.allowedDestinations[0], "PROVISIONING_POLICY_MISMATCH", "Provisioned destination does not match current policy");
  assertQos(record.maxTransferLamports === policy.maxTransferLamports && record.maxFeeLamports === policy.maxFeeLamports && record.maxIntentTtlSlots === policy.maxIntentTtlSlots, "PROVISIONING_POLICY_MISMATCH", "Provisioned limits do not match current policy");
  assertQos(record.strategyId === policy.allowedStrategyIds[0], "PROVISIONING_POLICY_MISMATCH", "Provisioned strategy does not match current policy");
  const expectedToken = policy.tokenTransfer === null ? null : {
    ...policy.tokenTransfer,
    sourceTokenAccount: associatedTokenAddress({ owner: record.signer, mint: policy.tokenTransfer.mint, tokenProgram: policy.tokenTransfer.tokenProgram }),
    destinationTokenAccount: associatedTokenAddress({ owner: policy.allowedDestinations[0], mint: policy.tokenTransfer.mint, tokenProgram: policy.tokenTransfer.tokenProgram }),
  };
  assertQos(canonicalJson(record.tokenTransfer) === canonicalJson(expectedToken), "PROVISIONING_POLICY_MISMATCH", "Provisioned token policy does not match current policy");
  return record;
}

export function assertFirmwareBroadcastAllowed(policy, broadcast) {
  if (broadcast && policy.cluster === "mainnet-beta") {
    assertQos(
      false,
      "MAINNET_QEMU_BROADCAST_FORBIDDEN",
      "The QEMU demo uses a host-readable software seed and may not broadcast on mainnet",
    );
  }
}

function loadProvisioning(home, policy) {
  assertQos(existsSync(PROVISIONING_FILE) && existsSync(FIRMWARE_ELF), "FIRMWARE_NOT_PROVISIONED", "Run the firmware demo build command first");
  const bytes = readSecureFile(PROVISIONING_FILE, {
    privateFile: true,
    maxBytes: 64 * 1024,
    errorCode: "BAD_PROVISIONING_RECORD",
    label: "Firmware provisioning record",
  });
  let record;
  try {
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
  }
  return validateProvisioningRecord(record, policy, sha256File(FIRMWARE_ELF));
}

function verifyFirmwareTransaction(signature, record, intent) {
  assertQos(Buffer.isBuffer(signature) && signature.length === 64, "BAD_FIRMWARE_SIGNATURE", "Firmware returned a malformed Ed25519 signature");
  const signer = decodeBase58(record.signer, 32);
  let message;
  try {
    if (intent.asset === "sol") {
      message = buildNativeTransferMessage({
        payer: record.signer,
        destination: intent.destination,
        lamports: BigInt(intent.amount),
        recentBlockhash: intent.recentBlockhash,
      });
    } else {
      message = buildTokenTransferCheckedMessage({
        payer: record.signer,
        sourceTokenAccount: intent.sourceTokenAccount,
        destinationTokenAccount: intent.destinationTokenAccount,
        mint: intent.mint,
        tokenProgram: intent.tokenProgram,
        amount: BigInt(intent.amount),
        decimals: intent.decimals,
        recentBlockhash: intent.recentBlockhash,
      });
    }
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
    const transaction = Buffer.concat([Buffer.from([1]), signature, message]);
    try {
      return { signature: encodeBase58(signature), message, transactionBase64: transaction.toString("base64") };
    } finally {
      transaction.fill(0);
    }
  } catch (error) {
    message?.fill(0);
    throw error;
  } finally {
    signer.fill(0);
  }
}

export async function runFirmware(home, { asset = "sol", lamports = undefined, amount = undefined, broadcast = false, offline = false } = {}) {
  const qemu = process.env.QOS_FIRMWARE_DEMO_QEMU ?? DEFAULT_QEMU;
  assertPrivateDirectory(home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS sandbox home" });
  assertQos(existsSync(policyPath(home)), "SANDBOX_NOT_INITIALIZED", `No qOS policy found at ${policyPath(home)}; run node bin/qos.js init first`);
  assertTrustedExecutable(qemu, "QEMU");
  assertQos(commandAvailable(qemu), "QEMU_REQUIRED", "Install qemu-system-riscv64 before running the firmware demo");
  assertQos(!(offline && broadcast), "OFFLINE_BROADCAST_CONFLICT", "--offline cannot be combined with --broadcast");
  const policy = loadPolicy(policyPath(home), process.env.SOLANA_RPC_URL);
  assertFirmwareBroadcastAllowed(policy, broadcast);
  const record = loadProvisioning(home, policy);
  const privateKey = loadPrivateKey(join(home, "signer.pem"));
  assertQos(publicKeyAddress(privateKey) === record.signer, "SIGNER_MEASUREMENT_MISMATCH", "Runtime signer does not match the provisioned firmware identity");
  assertQos(asset === "sol" || asset === "token", "INVALID_DEMO_ASSET", "--asset must be sol or token");
  assertQos(!(lamports !== undefined && amount !== undefined), "CONFLICTING_AMOUNT_OPTIONS", "Use --lamports for SOL or --amount for tokens, not both");
  const amountText = asset === "sol" ? (lamports ?? amount ?? "1000000") : (amount ?? lamports ?? "1000000");
  const transferAmount = parseUnsigned(amountText, 64, asset === "sol" ? "lamports" : "amount");
  const maxAmount = asset === "sol" ? BigInt(record.maxTransferLamports) : BigInt(record.tokenTransfer?.maxTransferAmount ?? "0");
  assertQos(asset !== "token" || record.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "Provisioned firmware does not enable token transfers");
  assertQos(transferAmount > 0n && transferAmount <= maxAmount, "AMOUNT_LIMIT_EXCEEDED", "Demo transfer exceeds provisioned firmware policy");
  const rpc = offline ? null : new SolanaRpc(policy.rpcUrl, { timeoutMs: policy.rpcTimeoutMs, commitment: policy.commitment });
  let genesis = record.clusterGenesis;
  let latest = {
    value: {
      blockhash: encodeBase58(createHash("sha256").update("qOS deterministic offline firmware demo v1").digest()),
    },
  };
  let currentSlot = 1_000_000;
  if (!offline) {
    [genesis, latest, currentSlot] = await Promise.all([
      rpc.getGenesisHash(),
      rpc.getLatestBlockhash(),
      rpc.getSlot(),
    ]);
    assertQos(genesis === record.clusterGenesis, "RPC_CLUSTER_MISMATCH", "RPC endpoint does not match provisioned firmware cluster");
    assertQos(typeof latest?.value?.blockhash === "string", "RPC_INVALID_BLOCKHASH", "RPC returned an invalid blockhash");
  }
  const slot = parseRpcSlot(currentSlot);
  if (asset === "token" && !offline) {
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
    expiresAtSlot: slot + BigInt(record.maxIntentTtlSlots),
    currentSlot: slot,
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
  const overLimit = maxAmount === ((1n << 64n) - 1n) ? 0n : maxAmount + 1n;
  const tampered = encodeIntentFrame({ ...base, requestNonce: 2n, amount: overLimit, minimumOutput: overLimit });
  const replay = encodeIntentFrame(base);
  mkdirSync(BUILD_DIR, { recursive: true, mode: 0o700 });
  const bundle = encodeIntentBundle([valid, tampered, replay]);
  const seed = privateKeySeed(privateKey);
  const keyBytes = encodeKeyMailbox(seed);
  seed.fill(0);
  let intentFd;
  let keyFd;
  let qemuResult;
  try {
    intentFd = openRamBackedFile(bundle, "intent");
    keyFd = openRamBackedFile(keyBytes, "key");
    qemuResult = spawnSync(qemu, [
    "-machine", "virt",
    "-cpu", "rv64",
    "-smp", "1",
    "-m", "128M",
    "-bios", "none",
    "-kernel", FIRMWARE_ELF,
    "-device", "loader,file=/proc/self/fd/3,addr=0x81000000,force-raw=on",
    "-device", "loader,file=/proc/self/fd/4,addr=0x81200000,force-raw=on",
    "-display", "none",
    "-serial", "stdio",
    "-monitor", "none",
    "-no-reboot",
    ], {
      cwd: "/",
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: SAFE_TOOL_PATH },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", intentFd, keyFd],
    });
  } finally {
    if (intentFd !== undefined) {
      try { closeSync(intentFd); } catch {}
    }
    if (keyFd !== undefined) {
      try { closeSync(keyFd); } catch {}
    }
    bundle.fill(0);
    keyBytes.fill(0);
    valid.fill(0);
    tampered.fill(0);
    replay.fill(0);
  }
  const firmwareOutput = `${qemuResult.stdout ?? ""}${qemuResult.stderr ?? ""}`;
  const safeFirmwareOutput = redactFirmwareOutput(firmwareOutput);
  process.stdout.write(safeFirmwareOutput);
  assertQos(!qemuResult.error, "QEMU_FAILED", `QEMU execution failed: ${qemuResult.error?.message}`);
  assertQos(qemuResult.status === 0, "QEMU_FAILED", `QEMU exited with status ${qemuResult.status}`, { firmwareOutput: safeFirmwareOutput });
  const firmwareSignature = parseFirmwareOutput(firmwareOutput);
  try {
  const verified = verifyFirmwareTransaction(firmwareSignature, record, base);
  try {
  if (offline) {
    return {
      status: "verified-offline",
      offline: true,
      networkVerified: false,
      broadcast: false,
      asset,
      signer: record.signer,
      feeLamports: null,
      firmwareSha256: record.firmwareSha256,
      retention: "ephemeral-memory",
      transactionRetained: false,
      detailsReturned: false,
    };
  }
  const fee = await rpc.getFeeForMessage(verified.message.toString("base64"));
  assertQos(Number.isSafeInteger(fee) && BigInt(fee) <= BigInt(record.maxFeeLamports), "FEE_LIMIT_EXCEEDED", "Live fee exceeds provisioned firmware policy");
  const balance = await rpc.getBalance(record.signer);
  assertQos(Number.isSafeInteger(balance?.value) && balance.value >= 0, "RPC_INVALID_BALANCE", "RPC returned an invalid signer balance");
  const requiredLamports = BigInt(fee) + (asset === "sol" ? transferAmount : 0n);
  assertQos(BigInt(balance.value) >= requiredLamports, "INSUFFICIENT_SOL_BALANCE", "Firmware signer needs more SOL for the transfer and network fee", {
    signer: record.signer,
    availableLamports: String(balance.value),
    requiredLamports: requiredLamports.toString(),
  });
  const simulation = await rpc.simulateTransaction(verified.transactionBase64);
  assertQos(simulation?.err === null, "SIMULATION_FAILED", "Firmware-signed transaction failed simulation");
  if (!broadcast) {
    return {
      status: "verified",
      offline: false,
      networkVerified: true,
      broadcast: false,
      asset,
      signer: record.signer,
      feeLamports: String(fee),
      firmwareSha256: record.firmwareSha256,
      retention: "ephemeral-memory",
      transactionRetained: false,
      detailsReturned: false,
    };
  }
  const rpcSignature = await rpc.sendTransaction(verified.transactionBase64);
  assertQos(rpcSignature === verified.signature, "SIGNATURE_MISMATCH", "RPC returned a different signature");
  const status = await rpc.confirmSignature(verified.signature, {
    timeoutMs: policy.confirmationTimeoutMs,
    recentBlockhash: latest.value.blockhash,
  });
  return {
    status: "confirmed",
    offline: false,
    networkVerified: true,
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
    retention: "ephemeral-memory",
    transactionRetained: false,
    ledgerVisibility: "public",
    explorerUrl: policy.cluster === "devnet"
      ? `https://explorer.solana.com/tx/${verified.signature}?cluster=devnet`
      : `https://explorer.solana.com/tx/${verified.signature}`,
  };
  } finally {
    verified.message.fill(0);
  }
  } finally {
    firmwareSignature.fill(0);
  }
}

async function main() {
  process.umask(0o077);
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
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
    only(options, ["home", "asset", "lamports", "amount", "broadcast", "offline"]);
    process.stdout.write(`${JSON.stringify(await runFirmware(home, {
      asset: options.asset,
      lamports: options.lamports,
      amount: options.amount,
      broadcast: options.broadcast === true,
      offline: options.offline === true,
    }), null, 2)}\n`);
    return;
  }
  if (command === "demo") {
    only(options, ["home", "asset", "lamports", "amount", "broadcast", "offline"]);
    buildFirmware(home);
    process.stdout.write(`${JSON.stringify(await runFirmware(home, {
      asset: options.asset,
      lamports: options.lamports,
      amount: options.amount,
      broadcast: options.broadcast === true,
      offline: options.offline === true,
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
