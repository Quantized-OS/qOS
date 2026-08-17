#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { stopAgentDaemon } from "../src/agent-daemon.js";
import { hasExactKeys } from "../src/canonical.js";
import { assertQos, publicError, QosError } from "../src/errors.js";
import { readPrivateJson, writePrivateJsonAtomic } from "../src/private-json.js";
import { assertPrivateDirectory } from "../src/secure-file.js";

const REGISTRY_KEYS = ["version", "installations"];
const INSTALL_KEYS = ["home", "bin", "toolchainRoot"];
const PROFILE_MARKER = ".qos-managed-profile.json";
const TOOLCHAIN_MARKER = ".qos-managed-toolchain.json";
const MAX_PURGE_ENTRIES = 500_000;
const MANAGED_MARKER = "# qOS managed launcher";
const MANAGED_LAUNCHERS = [
  "qos", "qos-core", "qos-shell", "qos-firmware", "qos-agent",
  "qos-agent-demo", "qos-agent-security-audit", "qos-agent-external-setup",
  "qos-profile", "qos-policy", "qos-wallet",
];

function parseArgs(argv) {
  const [action, ...tokens] = argv;
  if (!action || !["register", "purge"].includes(action)) throw new QosError("INVALID_ARGUMENT", "Use qos-install-state register or purge");
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index];
    if (!["--data-root", "--home", "--bin", "--toolchain-root", "--project-root"].includes(name)) throw new QosError("INVALID_ARGUMENT", `Unknown option: ${name}`);
    assertQos(!values.has(name), "DUPLICATE_ARGUMENT", `Duplicate ${name}`);
    const value = tokens[++index];
    assertQos(typeof value === "string" && value.length > 0 && !value.startsWith("--"), "MISSING_ARGUMENT", `${name} requires a value`);
    values.set(name, value);
  }
  return { action, values };
}

function absolute(values, name) {
  const value = values.get(name);
  assertQos(typeof value === "string" && isAbsolute(value), "INVALID_MANAGED_PATH", `${name} must be an absolute path`);
  return resolve(value);
}

function assertDataRoot(dataRoot) {
  const userHome = resolve(process.env.HOME ?? "/nonexistent-qos-home");
  assertQos(dataRoot !== "/" && dataRoot !== userHome, "INVALID_MANAGED_PATH", "qOS data root is too broad to manage safely");
  return join(dataRoot, "qos");
}

function ensurePrivateDirectory(path) {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    assertQos(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid(), "INSECURE_INSTALL_STATE_DIRECTORY", "qOS installation state path must be an owned directory, not a symbolic link");
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
  assertPrivateDirectory(path, { errorCode: "INSECURE_INSTALL_STATE_DIRECTORY", label: "qOS installation state directory" });
}

function secureOwnedDirectoryForPurge(path, label) {
  const metadata = lstatSync(path);
  assertQos(
    metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid(),
    "UNSAFE_PURGE_TARGET",
    `${label} must be an owned directory, not a symbolic link`,
  );
  chmodSync(path, 0o700);
  assertPrivateDirectory(path, {
    errorCode: "INSECURE_INSTALL_STATE_DIRECTORY",
    label,
  });
}

function validateInstall(record) {
  assertQos(record && typeof record === "object" && !Array.isArray(record) && hasExactKeys(record, INSTALL_KEYS), "INVALID_INSTALL_REGISTRY", "Installation record has missing or unknown fields");
  for (const key of INSTALL_KEYS) assertQos(typeof record[key] === "string" && isAbsolute(record[key]) && resolve(record[key]) === record[key], "INVALID_INSTALL_REGISTRY", `Installation ${key} is invalid`);
  return Object.freeze({ ...record });
}

function validateRegistry(value) {
  assertQos(value && typeof value === "object" && !Array.isArray(value) && hasExactKeys(value, REGISTRY_KEYS), "INVALID_INSTALL_REGISTRY", "Installation registry has missing or unknown fields");
  assertQos(value.version === 1 && Array.isArray(value.installations) && value.installations.length <= 128, "INVALID_INSTALL_REGISTRY", "Installation registry version or size is invalid");
  const installations = value.installations.map(validateInstall);
  const identities = installations.map((entry) => `${entry.home}\0${entry.bin}\0${entry.toolchainRoot}`);
  assertQos(new Set(identities).size === identities.length, "INVALID_INSTALL_REGISTRY", "Installation registry contains duplicates");
  return { version: 1, installations };
}

function readRegistry(qosRoot) {
  const path = join(qosRoot, "installations.json");
  if (!existsSync(path)) return { version: 1, installations: [] };
  return validateRegistry(readPrivateJson(path, { errorCode: "INVALID_INSTALL_REGISTRY", label: "qOS installation registry" }));
}

function marker(path, kind) {
  return { version: 1, kind, path };
}

function writeMarker(directory, name, kind) {
  assertPrivateDirectory(directory, { errorCode: "INSECURE_MANAGED_DIRECTORY", label: `qOS managed ${kind} directory` });
  const path = join(directory, name);
  const intended = marker(resolve(directory), kind);
  if (existsSync(path)) {
    const current = readPrivateJson(path, { errorCode: "INVALID_MANAGED_MARKER", label: `qOS ${kind} marker` });
    assertQos(hasExactKeys(current, ["version", "kind", "path"]) && current.version === 1 && current.kind === kind && current.path === intended.path, "INVALID_MANAGED_MARKER", `Existing qOS ${kind} marker is invalid`);
  }
  writePrivateJsonAtomic(path, intended, { errorCode: "MANAGED_MARKER_WRITE_FAILED", label: `qOS ${kind} marker` });
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertNarrowTarget(path, forbidden) {
  assertQos(path !== "/" && path.split(sep).filter(Boolean).length >= 2, "UNSAFE_PURGE_TARGET", "Refusing an overly broad purge target");
  for (const value of forbidden) assertQos(path !== value, "UNSAFE_PURGE_TARGET", "Refusing to purge a protected parent directory");
}

function validateMarker(directory, name, kind) {
  const value = readPrivateJson(join(directory, name), { errorCode: "INVALID_MANAGED_MARKER", label: `qOS ${kind} marker` });
  assertQos(hasExactKeys(value, ["version", "kind", "path"]) && value.version === 1 && value.kind === kind && value.path === resolve(directory), "INVALID_MANAGED_MARKER", `qOS ${kind} marker does not authorize this directory`);
}

function removeTree(root, counter, label) {
  const rootMetadata = lstatSync(root);
  assertQos(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink() && rootMetadata.uid === process.getuid(), "UNSAFE_PURGE_TARGET", `${label} must be an owned regular directory`);
  const rootDevice = rootMetadata.dev;
  function remove(path) {
    counter.count += 1;
    assertQos(counter.count <= MAX_PURGE_ENTRIES, "PURGE_ENTRY_LIMIT", "qOS purge exceeded its file-count safety limit");
    const metadata = lstatSync(path);
    assertQos(metadata.uid === process.getuid(), "UNSAFE_PURGE_ENTRY", `Refusing to remove an entry not owned by the current user: ${path}`);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      assertQos(metadata.dev === rootDevice, "PURGE_MOUNT_BOUNDARY", `Refusing to cross a filesystem boundary: ${path}`);
      for (const name of readdirSync(path).sort()) remove(join(path, name));
      rmdirSync(path);
      return;
    }
    assertQos(metadata.isFile() || metadata.isSymbolicLink(), "UNSAFE_PURGE_ENTRY", `Refusing to remove a special file: ${path}`);
    unlinkSync(path);
  }
  remove(root);
}

function removeManagedLaunchers(binDirectory, removed) {
  if (!existsSync(binDirectory)) return;
  const directory = lstatSync(binDirectory);
  assertQos(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid(), "UNSAFE_LAUNCHER_DIRECTORY", `Refusing an unsafe qOS launcher directory: ${binDirectory}`);
  for (const name of MANAGED_LAUNCHERS) {
    const path = join(binDirectory, name);
    if (!existsSync(path)) continue;
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || metadata.size > 16_384) continue;
    const lines = readFileSync(path, "utf8").split(/\r?\n/u);
    if (!lines.includes(MANAGED_MARKER)) continue;
    unlinkSync(path);
    removed.push(path);
  }
}

async function register(values) {
  const dataRoot = absolute(values, "--data-root");
  const qosRoot = assertDataRoot(dataRoot);
  const home = absolute(values, "--home");
  const bin = absolute(values, "--bin");
  const toolchainRoot = absolute(values, "--toolchain-root");
  assertNarrowTarget(home, [resolve(process.env.HOME), dataRoot, qosRoot]);
  ensurePrivateDirectory(qosRoot);
  writeMarker(home, PROFILE_MARKER, "profile");
  if (!isWithin(qosRoot, toolchainRoot)) {
    ensurePrivateDirectory(toolchainRoot);
    writeMarker(toolchainRoot, TOOLCHAIN_MARKER, "toolchain");
  }
  const registry = readRegistry(qosRoot);
  const candidate = validateInstall({ home, bin, toolchainRoot });
  const identity = (entry) => `${entry.home}\0${entry.bin}\0${entry.toolchainRoot}`;
  const installations = [...registry.installations.filter((entry) => identity(entry) !== identity(candidate)), candidate]
    .sort((left, right) => identity(left).localeCompare(identity(right)));
  writePrivateJsonAtomic(join(qosRoot, "installations.json"), { version: 1, installations }, {
    errorCode: "INSTALL_REGISTRY_WRITE_FAILED",
    label: "qOS installation registry",
  });
  return { status: "registered", qosRoot, home, bin, toolchainRoot };
}

function existingProfileHomes(qosRoot, registry) {
  const homes = new Set(registry.installations.map((entry) => entry.home));
  const profiles = join(qosRoot, "profiles");
  if (existsSync(profiles)) {
    const metadata = lstatSync(profiles);
    assertQos(metadata.isDirectory() && !metadata.isSymbolicLink(), "UNSAFE_PURGE_TARGET", "qOS profiles path is unsafe");
    for (const name of readdirSync(profiles)) {
      const path = join(profiles, name);
      const item = lstatSync(path);
      if (item.isDirectory() && !item.isSymbolicLink()) homes.add(resolve(path));
    }
  }
  return [...homes];
}

async function purge(values) {
  const dataRoot = absolute(values, "--data-root");
  const projectRoot = absolute(values, "--project-root");
  const qosRoot = assertDataRoot(dataRoot);
  const userHome = resolve(process.env.HOME);
  const counter = { count: 0 };
  let registry = { version: 1, installations: [] };
  if (existsSync(qosRoot)) {
    secureOwnedDirectoryForPurge(qosRoot, "qOS data directory");
    registry = readRegistry(qosRoot);
  }
  const homes = existingProfileHomes(qosRoot, registry).filter(existsSync);
  for (const home of homes) {
    if (!isWithin(qosRoot, home)) validateMarker(home, PROFILE_MARKER, "profile");
    secureOwnedDirectoryForPurge(home, "qOS profile directory");
    const agents = join(home, "agents");
    if (existsSync(agents)) secureOwnedDirectoryForPurge(agents, "qOS agent directory");
    const state = join(home, "agents", "listener.json");
    if (existsSync(state)) await stopAgentDaemon(home);
  }
  const removed = [];
  const binDirectories = new Set(registry.installations.map((entry) => entry.bin));
  const requestedBin = values.get("--bin");
  if (requestedBin !== undefined) {
    assertQos(isAbsolute(requestedBin), "INVALID_MANAGED_PATH", "--bin must be an absolute path");
    binDirectories.add(resolve(requestedBin));
  }
  for (const binDirectory of binDirectories) removeManagedLaunchers(binDirectory, removed);
  for (const home of homes) {
    if (isWithin(qosRoot, home) || !existsSync(home)) continue;
    assertNarrowTarget(home, [userHome, dataRoot, qosRoot, projectRoot]);
    validateMarker(home, PROFILE_MARKER, "profile");
    removeTree(home, counter, "qOS profile");
    removed.push(home);
  }
  for (const toolchainRoot of new Set(registry.installations.map((entry) => entry.toolchainRoot))) {
    if (isWithin(qosRoot, toolchainRoot) || !existsSync(toolchainRoot)) continue;
    assertNarrowTarget(toolchainRoot, [userHome, dataRoot, qosRoot, projectRoot]);
    validateMarker(toolchainRoot, TOOLCHAIN_MARKER, "toolchain");
    removeTree(toolchainRoot, counter, "qOS toolchain");
    removed.push(toolchainRoot);
  }
  if (existsSync(qosRoot)) {
    assertNarrowTarget(qosRoot, [userHome, dataRoot, projectRoot]);
    removeTree(qosRoot, counter, "qOS data root");
    removed.push(qosRoot);
  }
  const auxiliaryRoots = [
    join(resolve(process.env.XDG_CONFIG_HOME ?? join(userHome, ".config")), "qos"),
    join(resolve(process.env.XDG_STATE_HOME ?? join(userHome, ".local", "state")), "qos"),
    join(resolve(process.env.XDG_CACHE_HOME ?? join(userHome, ".cache")), "qos"),
  ];
  for (const path of auxiliaryRoots) {
    if (!existsSync(path)) continue;
    assertNarrowTarget(path, [userHome, dataRoot, projectRoot]);
    removeTree(path, counter, "qOS auxiliary data");
    removed.push(path);
  }
  const projectArtifacts = [
    "build", "node_modules", "release-artifacts", "firmware-demo/target",
    ".qos-ephemeral-devnet", ".qos-ephemeral-mainnet", ".qos-demo",
    ".qos-devnet", ".qos-mainnet", ".qos-setup-backup",
    "scripts/__pycache__", "tests/__pycache__", "test/__pycache__",
  ];
  if (existsSync(projectRoot)) {
    for (const relativePath of projectArtifacts) {
      const path = join(projectRoot, relativePath);
      if (!existsSync(path)) continue;
      assertQos(isWithin(projectRoot, path) && path !== projectRoot, "UNSAFE_PURGE_TARGET", "Project artifact path escaped the qOS checkout");
      removeTree(path, counter, `qOS build artifact ${relativePath}`);
      removed.push(path);
    }
  }
  return { status: "purged", removed, entriesRemoved: counter.count, sourceCheckoutPreserved: existsSync(projectRoot) };
}

async function main() {
  process.umask(0o077);
  const options = parseArgs(process.argv.slice(2));
  const value = options.action === "register" ? await register(options.values) : await purge(options.values);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  process.exitCode = 1;
});
