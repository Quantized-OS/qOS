import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { hasExactKeys } from "./canonical.js";
import { assertQos, QosError } from "./errors.js";
import {
  createModelProviderProfile,
  modelProviderCatalog,
  publicModelProviderProfile,
  validateModelProviderProfile,
} from "./model-provider.js";
import { readPrivateJson, writePrivateJsonAtomic } from "./private-json.js";
import { loadRuntimeProfile } from "./runtime-profile.js";
import { assertPrivateDirectory, readSecureFile } from "./secure-file.js";

const REGISTRY_KEYS = ["version", "profiles"];
const MAX_PROFILES = 32;

export function modelProviderPaths(home, id = undefined) {
  const resolvedHome = resolve(home);
  const root = join(resolvedHome, "model-providers");
  return {
    home: resolvedHome,
    root,
    registry: join(root, "registry.json"),
    ...(id === undefined ? {} : {
      profile: join(root, id),
      credential: join(root, id, "api-key"),
    }),
  };
}

function ensureProviderDirectory(home) {
  const paths = modelProviderPaths(home);
  loadRuntimeProfile(paths.home);
  if (!existsSync(paths.root)) {
    mkdirSync(paths.root, { mode: 0o700 });
    chmodSync(paths.root, 0o700);
  }
  assertPrivateDirectory(paths.root, { errorCode: "INSECURE_MODEL_PROVIDER_DIRECTORY", label: "Model provider directory" });
  return paths;
}

function validateRegistry(registry) {
  assertQos(registry && typeof registry === "object" && !Array.isArray(registry) && hasExactKeys(registry, REGISTRY_KEYS), "MODEL_REGISTRY_INVALID", "Model provider registry has missing or unknown fields");
  assertQos(registry.version === 1 && Array.isArray(registry.profiles) && registry.profiles.length <= MAX_PROFILES, "MODEL_REGISTRY_INVALID", "Model provider registry version or size is invalid");
  const profiles = registry.profiles.map(validateModelProviderProfile);
  assertQos(new Set(profiles.map((profile) => profile.id)).size === profiles.length, "MODEL_REGISTRY_INVALID", "Model provider registry contains duplicate IDs");
  assertQos(profiles.every((profile, index) => index === 0 || profiles[index - 1].id < profile.id), "MODEL_REGISTRY_INVALID", "Model provider registry must be sorted by ID");
  return Object.freeze({ version: 1, profiles: Object.freeze(profiles) });
}

export function loadModelProviderRegistry(home) {
  const paths = modelProviderPaths(home);
  loadRuntimeProfile(paths.home);
  if (!existsSync(paths.root)) return Object.freeze({ version: 1, profiles: Object.freeze([]) });
  assertPrivateDirectory(paths.root, { errorCode: "INSECURE_MODEL_PROVIDER_DIRECTORY", label: "Model provider directory" });
  if (!existsSync(paths.registry)) return Object.freeze({ version: 1, profiles: Object.freeze([]) });
  return validateRegistry(readPrivateJson(paths.registry, {
    errorCode: "MODEL_REGISTRY_INVALID",
    label: "Model provider registry",
  }));
}

function importedCredential(path) {
  const bytes = readSecureFile(path, {
    privateFile: true,
    minBytes: 8,
    maxBytes: 4096,
    errorCode: "MODEL_CREDENTIAL_INSECURE",
    label: "Imported model provider API key file",
  });
  let end = bytes.length;
  if (bytes[end - 1] === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  const key = bytes.subarray(0, end);
  try {
    assertQos(key.length >= 8 && key.length <= 2048 && key.every((byte) => byte >= 0x21 && byte <= 0x7e), "MODEL_CREDENTIAL_INVALID", "Model provider API key must contain 8 to 2048 visible ASCII bytes");
    return {
      bytes,
      normalized: Buffer.from(`${key.toString("ascii")}\n`, "ascii"),
      sha256: createHash("sha256").update(key).digest("hex"),
    };
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

function writeCredentialAtomic(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    throw new QosError("MODEL_CREDENTIAL_WRITE_FAILED", "Model provider API key could not be stored atomically");
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch {}
    }
  }
}

function validateRuntimeFiles(home, record) {
  const paths = modelProviderPaths(home, record.id);
  assertPrivateDirectory(paths.profile, { errorCode: "INSECURE_MODEL_PROVIDER_DIRECTORY", label: `Model provider ${record.id} directory` });
  if (record.credentialSha256 === null) {
    assertQos(!existsSync(paths.credential), "MODEL_CREDENTIAL_FORBIDDEN", "Local model profile unexpectedly contains an API key");
  } else {
    const bytes = readSecureFile(paths.credential, {
      privateFile: true,
      minBytes: 8,
      maxBytes: 4096,
      errorCode: "MODEL_CREDENTIAL_INSECURE",
      label: `Model provider ${record.id} API key file`,
    });
    try {
      let end = bytes.length;
      if (bytes[end - 1] === 0x0a) end -= 1;
      if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
      const hash = createHash("sha256").update(bytes.subarray(0, end)).digest("hex");
      assertQos(hash === record.credentialSha256, "MODEL_CREDENTIAL_MISMATCH", `Model provider ${record.id} API key does not match the registry`);
    } finally {
      bytes.fill(0);
    }
  }
  return paths;
}

export function configureModelProvider(home, {
  id,
  provider,
  model,
  endpoint = undefined,
  apiKeyFile = undefined,
  allowCustomEndpoint = false,
} = {}) {
  const resolvedHome = resolve(home);
  assertQos(typeof provider === "string" && modelProviderCatalog().some((entry) => entry.id === provider), "MODEL_PROVIDER_UNSUPPORTED", "Model provider is unsupported; use qos-model catalog to list built-in and compatible providers");
  const requiresCredential = provider !== "local";
  assertQos(requiresCredential ? typeof apiKeyFile === "string" : apiKeyFile === undefined, requiresCredential ? "MODEL_CREDENTIAL_REQUIRED" : "MODEL_CREDENTIAL_FORBIDDEN", requiresCredential ? "Remote model providers require --api-key-file" : "Local model providers must not receive an API key");
  let imported;
  try {
    if (requiresCredential) imported = importedCredential(resolve(apiKeyFile));
    const record = createModelProviderProfile({
      id,
      provider,
      model,
      endpoint,
      credentialSha256: imported?.sha256 ?? null,
      allowCustomEndpoint,
    });
    const rootPaths = ensureProviderDirectory(resolvedHome);
    const registry = loadModelProviderRegistry(resolvedHome);
    assertQos(registry.profiles.length < MAX_PROFILES, "MODEL_PROFILE_LIMIT_REACHED", `A qOS profile may configure at most ${MAX_PROFILES} model providers`);
    assertQos(!registry.profiles.some((profile) => profile.id === id), "MODEL_PROFILE_ALREADY_EXISTS", `Model profile ${id} already exists; rotate its key or remove it before changing provider settings`);
    const paths = modelProviderPaths(resolvedHome, id);
    assertQos(!existsSync(paths.profile), "MODEL_PROFILE_PATH_CONFLICT", "Model profile directory already exists; inspect it before retrying");
    try {
      mkdirSync(paths.profile, { mode: 0o700 });
      chmodSync(paths.profile, 0o700);
      if (imported !== undefined) writeCredentialAtomic(paths.credential, imported.normalized);
      const next = {
        version: 1,
        profiles: [...registry.profiles, record].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      };
      validateRegistry(next);
      writePrivateJsonAtomic(rootPaths.registry, next, { errorCode: "MODEL_REGISTRY_WRITE_FAILED", label: "Model provider registry" });
    } catch (error) {
      if (existsSync(paths.credential)) {
        try { unlinkSync(paths.credential); } catch {}
      }
      if (existsSync(paths.profile) && readdirSync(paths.profile).length === 0) {
        try { rmdirSync(paths.profile); } catch {}
      }
      throw error;
    }
    validateRuntimeFiles(resolvedHome, record);
    return publicModelProviderProfile(record);
  } finally {
    imported?.normalized.fill(0);
    imported?.bytes.fill(0);
  }
}

export function listModelProviders(home) {
  const resolvedHome = resolve(home);
  return loadModelProviderRegistry(resolvedHome).profiles.map((record) => {
    validateRuntimeFiles(resolvedHome, record);
    return publicModelProviderProfile(record);
  });
}

export function getModelProvider(home, id) {
  const resolvedHome = resolve(home);
  const record = loadModelProviderRegistry(resolvedHome).profiles.find((profile) => profile.id === id);
  assertQos(record !== undefined, "MODEL_PROFILE_NOT_FOUND", `Model profile ${id} is not configured`);
  validateRuntimeFiles(resolvedHome, record);
  return publicModelProviderProfile(record);
}

export function loadModelProviderForRequest(home, id) {
  const resolvedHome = resolve(home);
  const record = loadModelProviderRegistry(resolvedHome).profiles.find((profile) => profile.id === id);
  assertQos(record !== undefined, "MODEL_PROFILE_NOT_FOUND", `Model profile ${id} is not configured`);
  const paths = validateRuntimeFiles(resolvedHome, record);
  return Object.freeze({
    profile: record,
    credentialFile: record.credentialSha256 === null ? undefined : paths.credential,
  });
}

export function rotateModelProviderCredential(home, id, { apiKeyFile } = {}) {
  const resolvedHome = resolve(home);
  assertQos(typeof apiKeyFile === "string", "MODEL_CREDENTIAL_REQUIRED", "Key rotation requires --api-key-file");
  const registry = loadModelProviderRegistry(resolvedHome);
  const index = registry.profiles.findIndex((profile) => profile.id === id);
  assertQos(index !== -1, "MODEL_PROFILE_NOT_FOUND", `Model profile ${id} is not configured`);
  const existing = registry.profiles[index];
  assertQos(existing.credentialSha256 !== null, "MODEL_CREDENTIAL_FORBIDDEN", "Local model profiles do not use API keys");
  validateRuntimeFiles(resolvedHome, existing);
  const paths = modelProviderPaths(resolvedHome, id);
  const previous = readSecureFile(paths.credential, {
    privateFile: true,
    minBytes: 8,
    maxBytes: 4096,
    errorCode: "MODEL_CREDENTIAL_INSECURE",
    label: `Model provider ${id} API key file`,
  });
  let imported;
  try {
    imported = importedCredential(resolve(apiKeyFile));
    const updated = createModelProviderProfile({ ...existing, credentialSha256: imported.sha256, allowCustomEndpoint: true });
    writeCredentialAtomic(paths.credential, imported.normalized);
    try {
      const profiles = [...registry.profiles];
      profiles[index] = updated;
      writePrivateJsonAtomic(modelProviderPaths(resolvedHome).registry, { version: 1, profiles }, { errorCode: "MODEL_REGISTRY_WRITE_FAILED", label: "Model provider registry" });
      validateRuntimeFiles(resolvedHome, updated);
      return { ...publicModelProviderProfile(updated), credentialRotated: true };
    } catch (error) {
      try {
        writeCredentialAtomic(paths.credential, previous);
        writePrivateJsonAtomic(modelProviderPaths(resolvedHome).registry, registry, { errorCode: "MODEL_REGISTRY_WRITE_FAILED", label: "Model provider registry" });
      } catch {
        throw new QosError("MODEL_CREDENTIAL_ROTATION_FAILED", "Model provider key rotation failed and could not be rolled back; the profile now fails closed and requires operator repair");
      }
      throw error;
    }
  } finally {
    previous.fill(0);
    imported?.normalized.fill(0);
    imported?.bytes.fill(0);
  }
}

export function removeModelProvider(home, id) {
  const resolvedHome = resolve(home);
  const rootPaths = ensureProviderDirectory(resolvedHome);
  const registry = loadModelProviderRegistry(resolvedHome);
  const record = registry.profiles.find((profile) => profile.id === id);
  assertQos(record !== undefined, "MODEL_PROFILE_NOT_FOUND", `Model profile ${id} is not configured`);
  const next = { version: 1, profiles: registry.profiles.filter((profile) => profile.id !== id) };
  writePrivateJsonAtomic(rootPaths.registry, next, { errorCode: "MODEL_REGISTRY_WRITE_FAILED", label: "Model provider registry" });
  const paths = modelProviderPaths(resolvedHome, id);
  let credentialRemoved = record.credentialSha256 === null;
  let cleanupWarning = null;
  try {
    validateRuntimeFiles(resolvedHome, record);
    if (existsSync(paths.credential)) {
      unlinkSync(paths.credential);
      credentialRemoved = true;
    }
    if (readdirSync(paths.profile).length === 0) rmdirSync(paths.profile);
  } catch {
    cleanupWarning = "Model profile was revoked, but unsafe or damaged local files were preserved for manual inspection";
  }
  return {
    id,
    status: "removed",
    credentialRevoked: true,
    credentialRemoved,
    cleanupWarning,
    remainingProfiles: next.profiles.length,
  };
}
