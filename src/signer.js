import { sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { decodeBase58 } from "./base58.js";
import { hasExactKeys } from "./canonical.js";
import { assertQos } from "./errors.js";
import {
  loadEncryptedPrivateKey,
  loadPrivateKey,
  publicKeyAddress,
  publicKeyObjectFromRaw,
} from "./key-store.js";
import { parseCommandArgs, runJsonCommand } from "./subprocess.js";

function canonicalBase64(text, expectedLength, field) {
  assertQos(typeof text === "string", "INVALID_SIGNER_RESPONSE", `${field} must be base64`);
  const bytes = Buffer.from(text, "base64");
  assertQos(bytes.length === expectedLength && bytes.toString("base64") === text, "INVALID_SIGNER_RESPONSE", `${field} is not canonical base64`);
  return bytes;
}

export class SoftwareSigner {
  #privateKey;

  constructor(privateKey, { custody = "plaintext-development" } = {}) {
    this.#privateKey = privateKey;
    this.publicKey = publicKeyAddress(privateKey);
    this.backend = "software-key-object";
    this.custody = custody;
  }

  async sign(message) {
    const signature = sign(null, message, this.#privateKey);
    assertQos(signature.length === 64, "INVALID_SIGNATURE", "Ed25519 signer returned a non-64-byte signature");
    return signature;
  }

  status() {
    return { backend: this.backend, custody: this.custody, keyExportableToAgentProcess: true };
  }
}

export class ExternalCommandSigner {
  constructor({ publicKey, command, args = [], timeoutMs = 10_000 }) {
    decodeBase58(publicKey, 32);
    assertQos(typeof command === "string" && isAbsolute(command), "EXTERNAL_SIGNER_CONFIG", "External signer command must be an absolute path");
    assertQos(Array.isArray(args) && args.every((value) => typeof value === "string"), "EXTERNAL_SIGNER_CONFIG", "External signer arguments are invalid");
    assertQos(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000, "EXTERNAL_SIGNER_CONFIG", "External signer timeout must be between 100 and 60000 milliseconds");
    this.publicKey = publicKey;
    this.command = command;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.backend = "external-command-v1";
    this.custody = "non-exportable-external-boundary";
  }

  async sign(message, authorization) {
    const request = {
      version: 1,
      operation: "sign-solana-message",
      publicKey: this.publicKey,
      messageBase64: Buffer.from(message).toString("base64"),
      authorization,
    };
    const response = await runJsonCommand(this.command, this.args, request, {
      timeoutMs: this.timeoutMs,
      errorPrefix: "EXTERNAL_SIGNER",
    });
    assertQos(hasExactKeys(response, ["version", "publicKey", "signatureBase64"]), "INVALID_SIGNER_RESPONSE", "External signer response has missing or unknown fields");
    assertQos(response.version === 1 && response.publicKey === this.publicKey, "SIGNER_IDENTITY_MISMATCH", "External signer identity does not match the provisioned key");
    const signature = canonicalBase64(response.signatureBase64, 64, "signatureBase64");
    const publicKey = publicKeyObjectFromRaw(decodeBase58(this.publicKey, 32));
    assertQos(verify(null, message, publicKey, signature), "SIGNATURE_SELF_CHECK_FAILED", "External signer returned an invalid signature");
    return signature;
  }

  status() {
    return { backend: this.backend, custody: this.custody, keyExportableToAgentProcess: false };
  }
}

function readDescriptor(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  assertQos(hasExactKeys(value, ["version", "backend", "publicKey"]), "INVALID_SIGNER_DESCRIPTOR", "Signer descriptor has missing or unknown fields");
  assertQos(value.version === 1 && value.backend === "external-command-v1", "INVALID_SIGNER_DESCRIPTOR", "Signer descriptor backend is unsupported");
  decodeBase58(value.publicKey, 32);
  return value;
}

export function openSigner(paths, env = process.env) {
  const backends = [paths.signerDescriptor, paths.encryptedSignerKey, paths.signerKey]
    .filter((path) => path && existsSync(path));
  assertQos(backends.length > 0, "SIGNER_NOT_CONFIGURED", "Signer home does not contain a configured key-custody backend");
  assertQos(backends.length === 1, "SIGNER_STATE_AMBIGUOUS", "Signer home contains multiple key-custody backends");
  if (backends[0] === paths.signerDescriptor) {
    const descriptor = readDescriptor(paths.signerDescriptor);
    const command = env.QOS_SIGNER_COMMAND;
    assertQos(typeof command === "string" && command.length > 0, "EXTERNAL_SIGNER_CONFIG", "QOS_SIGNER_COMMAND is required for an external signer home");
    return new ExternalCommandSigner({
      publicKey: descriptor.publicKey,
      command,
      args: parseCommandArgs(env.QOS_SIGNER_ARGS_JSON, "QOS_SIGNER_ARGS_JSON"),
      timeoutMs: env.QOS_SIGNER_TIMEOUT_MS === undefined ? 10_000 : Number(env.QOS_SIGNER_TIMEOUT_MS),
    });
  }
  if (backends[0] === paths.encryptedSignerKey) {
    assertQos(typeof env.QOS_KEY_PASSPHRASE_FILE === "string" && env.QOS_KEY_PASSPHRASE_FILE.length > 0, "KEY_PASSPHRASE_REQUIRED", "QOS_KEY_PASSPHRASE_FILE is required for the encrypted software key");
    assertQos(isAbsolute(env.QOS_KEY_PASSPHRASE_FILE), "KEY_PASSPHRASE_REQUIRED", "QOS_KEY_PASSPHRASE_FILE must be an absolute path");
    return new SoftwareSigner(loadEncryptedPrivateKey(paths.encryptedSignerKey, env.QOS_KEY_PASSPHRASE_FILE), {
      custody: "aes-256-gcm-encrypted-at-rest",
    });
  }
  return new SoftwareSigner(loadPrivateKey(paths.signerKey));
}

export function signerDescriptor(publicKey) {
  decodeBase58(publicKey, 32);
  return { version: 1, backend: "external-command-v1", publicKey };
}
