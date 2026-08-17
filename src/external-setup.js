import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { decodeBase58 } from "./base58.js";
import { assertQos } from "./errors.js";
import { initializeSandbox, sandboxPaths } from "./service.js";
import { loadPolicy } from "./policy.js";
import { associatedTokenAddress } from "./token.js";
import { assertTrustedExecutable } from "./subprocess.js";

const VALUE_OPTIONS = new Set(["home", "source-home", "public-key", "destination", "cluster", "signer-command"]);

export function parseExternalSetupArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--create") {
      assertQos(!Object.hasOwn(options, "create"), "DUPLICATE_ARGUMENT", "Duplicate --create");
      options.create = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      assertQos(VALUE_OPTIONS.has(match[1]), "UNKNOWN_ARGUMENT", `Unknown option: --${match[1]}`);
      assertQos(!Object.hasOwn(options, match[1]), "DUPLICATE_ARGUMENT", `Duplicate --${match[1]}`);
      options[match[1]] = match[2];
      continue;
    }
    assertQos(arg.startsWith("--"), "INVALID_ARGUMENT", `Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    assertQos(VALUE_OPTIONS.has(name), "UNKNOWN_ARGUMENT", `Unknown option: --${name}`);
    assertQos(!Object.hasOwn(options, name), "DUPLICATE_ARGUMENT", `Duplicate --${name}`);
    const value = argv[index + 1];
    assertQos(value !== undefined && !value.startsWith("--"), "MISSING_ARGUMENT", `Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function sourceDestination(sourceHome, cluster) {
  if (sourceHome === undefined) return undefined;
  const policyPath = join(sourceHome, "policy.json");
  assertQos(existsSync(policyPath), "SOURCE_POLICY_MISSING", `Source policy does not exist: ${policyPath}`);
  const policy = loadPolicy(policyPath);
  assertQos(policy.cluster === cluster, "SOURCE_CLUSTER_MISMATCH", "Source home cluster does not match the new external home cluster");
  return policy.allowedDestinations[0];
}

function validateSignerCommand(command) {
  if (command === undefined) return null;
  assertQos(isAbsolute(command), "EXTERNAL_SIGNER_CONFIG", "--signer-command must be an absolute path");
  assertTrustedExecutable(command, "EXTERNAL_SIGNER");
  return command;
}

export function resolveExternalSetup(options = {}) {
  const cluster = options.cluster ?? "mainnet-beta";
  assertQos(cluster === "mainnet-beta" || cluster === "devnet", "UNSUPPORTED_CLUSTER", "Cluster must be mainnet-beta or devnet");
  const home = resolve(options.home ?? ".qos-ephemeral-mainnet-external");
  const sourceHome = options["source-home"] === undefined ? undefined : resolve(options["source-home"]);
  assertQos(sourceHome === undefined || sourceHome !== home, "TARGET_EQUALS_SOURCE", "External home must be different from the source home");
  const signerPublicKey = options["public-key"];
  assertQos(typeof signerPublicKey === "string", "PUBLIC_KEY_REQUIRED", "--public-key must come from the external signer adapter or HSM");
  decodeBase58(signerPublicKey, 32);
  const destination = options.destination ?? sourceDestination(sourceHome, cluster);
  assertQos(typeof destination === "string", "DESTINATION_REQUIRED", "Provide --destination or --source-home with an allowlisted destination");
  decodeBase58(destination, 32);
  const signerCommand = validateSignerCommand(options["signer-command"]);
  assertQos(!existsSync(home), "SANDBOX_ALREADY_EXISTS", `Refusing to overwrite existing external home: ${home}`);
  return { cluster, home, sourceHome: sourceHome ?? null, signerPublicKey, destination, signerCommand };
}

export function createExternalSignerHome(options = {}) {
  assertQos(options.create === true, "CREATE_CONFIRMATION_REQUIRED", "Pass --create to create the new external-signer home");
  const plan = resolveExternalSetup(options);
  const initialized = initializeSandbox(plan.home, plan.destination, {
    cluster: plan.cluster,
    signerPublicKey: plan.signerPublicKey,
  });
  const paths = sandboxPaths(plan.home);
  const privateFiles = [paths.signerKey, paths.encryptedSignerKey, paths.receiverKey, paths.encryptedReceiverKey].filter(existsSync);
  assertQos(privateFiles.length === 0, "EXTERNAL_HOME_PRIVATE_FILES", "External home unexpectedly contains private key files", { files: privateFiles });
  const tokenAccount = initialized.tokenTransfer === null
    ? null
    : associatedTokenAddress({
      owner: initialized.signer,
      mint: initialized.tokenTransfer.mint,
      tokenProgram: initialized.tokenTransfer.tokenProgram,
    });
  return {
    status: "created",
    home: plan.home,
    sourceHome: plan.sourceHome,
    cluster: plan.cluster,
    signer: initialized.signer,
    destination: initialized.destination,
    keyCustody: initialized.keyCustody,
    signerDescriptor: paths.signerDescriptor,
    policy: paths.policy,
    privateFiles,
    tokenAccount,
    signerCommand: plan.signerCommand,
    nextSteps: [
      plan.signerCommand === null
        ? "Set QOS_SIGNER_COMMAND to the absolute path of the reviewed external signer adapter before opening qOS."
        : `Set QOS_SIGNER_COMMAND=${plan.signerCommand} before opening qOS.`,
      "Fund the new signer with only the SOL and token balance needed for the rehearsal.",
      "Run privacy-status against this new home and confirm keyExportableToAgentProcess is false.",
    ],
  };
}
