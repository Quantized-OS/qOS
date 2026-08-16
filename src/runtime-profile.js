import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { hasExactKeys } from "./canonical.js";
import { assertQos, QosError } from "./errors.js";
import { loadPolicy } from "./policy.js";
import { assertPrivateDirectory, readSecureFile } from "./secure-file.js";
import { assertTrustedExecutable } from "./subprocess.js";

const RUNTIME_KEYS = [
  "version",
  "profile",
  "home",
  "apiTokenFile",
  "signerCommand",
];

export function runtimeProfilePaths(home) {
  const resolvedHome = resolve(home);
  return {
    home: resolvedHome,
    runtime: join(resolvedHome, "runtime.json"),
    apiToken: join(resolvedHome, "api-token"),
    policy: join(resolvedHome, "policy.json"),
    signerDescriptor: join(resolvedHome, "signer.json"),
    signerKey: join(resolvedHome, "signer.pem"),
    encryptedSignerKey: join(resolvedHome, "signer.qkey"),
  };
}

function validateApiToken(path) {
  const bytes = readSecureFile(path, {
    privateFile: true,
    minBytes: 32,
    maxBytes: 1024,
    errorCode: "INSECURE_API_TOKEN_FILE",
    label: "API token file",
  });
  try {
    let end = bytes.length;
    if (bytes[end - 1] === 0x0a) end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
    assertQos(end >= 32 && end <= 512, "API_TOKEN_LENGTH_INVALID", "API token must contain 32 to 512 bytes");
    assertQos(bytes.subarray(0, end).every((byte) => byte >= 0x21 && byte <= 0x7e), "API_TOKEN_FORMAT_INVALID", "API token must contain visible ASCII only");
  } finally {
    bytes.fill(0);
  }
}

function validateProfileBoundary(paths, profile, signerCommand) {
  const policy = loadPolicy(paths.policy);
  if (profile === "devnet") {
    assertQos(policy.cluster === "devnet", "RUNTIME_PROFILE_CLUSTER_MISMATCH", "Devnet runtime profile must use a Devnet policy");
    assertQos(signerCommand === null, "INVALID_RUNTIME_PROFILE", "Devnet runtime profile must not configure an external signer command");
  } else {
    assertQos(policy.cluster === "mainnet-beta", "RUNTIME_PROFILE_CLUSTER_MISMATCH", "Mainnet external runtime profile must use a mainnet-beta policy");
    assertQos(existsSync(paths.signerDescriptor), "EXTERNAL_SIGNER_DESCRIPTOR_REQUIRED", "Mainnet external profile is missing signer.json");
    assertQos(!existsSync(paths.signerKey) && !existsSync(paths.encryptedSignerKey), "EXTERNAL_HOME_PRIVATE_FILES", "Mainnet external profile must not contain software signer keys");
    assertQos(typeof signerCommand === "string" && isAbsolute(signerCommand), "EXTERNAL_SIGNER_CONFIG", "Mainnet external profile requires an absolute signer command");
    assertTrustedExecutable(signerCommand, "EXTERNAL_SIGNER");
  }
  return policy;
}

function validateRuntimeProfile(record, home) {
  const paths = runtimeProfilePaths(home);
  assertQos(record && typeof record === "object" && !Array.isArray(record), "INVALID_RUNTIME_PROFILE", "Runtime profile must be an object");
  assertQos(hasExactKeys(record, RUNTIME_KEYS), "INVALID_RUNTIME_PROFILE", "Runtime profile has missing or unknown fields");
  assertQos(record.version === 1, "INVALID_RUNTIME_PROFILE", "Unsupported runtime profile version");
  assertQos(record.profile === "devnet" || record.profile === "mainnet-external", "INVALID_RUNTIME_PROFILE", "Runtime profile type is unsupported");
  assertQos(resolve(record.home) === paths.home, "INVALID_RUNTIME_PROFILE", "Runtime profile home does not match its directory");
  assertQos(resolve(record.apiTokenFile) === paths.apiToken, "INVALID_RUNTIME_PROFILE", "Runtime profile API token path is invalid");
  validateProfileBoundary(paths, record.profile, record.signerCommand);
  validateApiToken(paths.apiToken);
  return Object.freeze({ ...record });
}

export function loadRuntimeProfile(home) {
  const paths = runtimeProfilePaths(home);
  assertPrivateDirectory(paths.home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS profile home" });
  const bytes = readSecureFile(paths.runtime, {
    privateFile: true,
    maxBytes: 64 * 1024,
    errorCode: "INVALID_RUNTIME_PROFILE",
    label: "Runtime profile",
  });
  try {
    return validateRuntimeProfile(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), paths.home);
  } catch (error) {
    if (error instanceof QosError) throw error;
    throw new QosError("INVALID_RUNTIME_PROFILE", "Runtime profile is not valid UTF-8 JSON");
  } finally {
    bytes.fill(0);
  }
}

export function ensureRuntimeProfile(home, {
  profile,
  signerCommand = null,
} = {}) {
  const paths = runtimeProfilePaths(home);
  assertPrivateDirectory(paths.home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS profile home" });
  assertQos(profile === "devnet" || profile === "mainnet-external", "INVALID_RUNTIME_PROFILE", "Profile must be devnet or mainnet-external");
  if (profile === "devnet") {
    assertQos(signerCommand === null, "INVALID_RUNTIME_PROFILE", "Devnet profile must not configure an external signer command");
  } else {
    assertQos(typeof signerCommand === "string" && isAbsolute(signerCommand), "EXTERNAL_SIGNER_CONFIG", "Mainnet external profile requires an absolute signer command");
  }
  validateProfileBoundary(paths, profile, signerCommand);

  if (!existsSync(paths.apiToken)) {
    const token = Buffer.from(`${randomBytes(48).toString("base64url")}\n`, "ascii");
    try {
      writeFileSync(paths.apiToken, token, { flag: "wx", mode: 0o600 });
      chmodSync(paths.apiToken, 0o600);
    } catch (error) {
      throw new QosError("RUNTIME_PROFILE_CREATE_FAILED", "Could not create the private API token file");
    } finally {
      token.fill(0);
    }
  }
  validateApiToken(paths.apiToken);

  const intended = {
    version: 1,
    profile,
    home: paths.home,
    apiTokenFile: paths.apiToken,
    signerCommand,
  };
  if (existsSync(paths.runtime)) {
    const existing = loadRuntimeProfile(paths.home);
    assertQos(existing.profile === intended.profile && existing.signerCommand === intended.signerCommand, "RUNTIME_PROFILE_CONFLICT", "Existing runtime profile does not match the requested configuration");
    return existing;
  }

  const temporary = `${paths.runtime}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(intended, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, paths.runtime);
  } catch (error) {
    throw new QosError("RUNTIME_PROFILE_CREATE_FAILED", "Could not create the private runtime profile");
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch {}
    }
  }
  return loadRuntimeProfile(paths.home);
}
