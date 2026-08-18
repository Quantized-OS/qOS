#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import { publicError, QosError } from "../src/errors.js";
import { writeResult } from "../src/human-output.js";
import {
  changePolicyDestination,
  changePolicyStrategy,
  EDITABLE_POLICY_FIELDS,
  setPolicyField,
  showEditablePolicy,
} from "../src/policy-store.js";

function usage() {
  return `qOS inline policy editor

Usage:
  qos policy show
  qos policy set FIELD VALUE [--confirm-policy-change]
  qos policy destination add|remove PUBKEY [--confirm-policy-change]
  qos policy strategy add|remove ID [--confirm-policy-change]
  qos policy edit

Editable fields:
  ${EDITABLE_POLICY_FIELDS.join(", ")}

The cluster genesis, transaction templates, program IDs, token mint, decimals,
and mint-extension rules are locked in this build. Mainnet external-signer
operators must also update and review the protected signer-side commitment.
`;
}

function parseArgs(argv) {
  let home = process.env.QOS_HOME;
  let json = false;
  let confirmed = false;
  const positional = [];
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") return { help: true };
    if (token === "-H" || token === "--home") {
      if (seen.has("home")) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --home");
      seen.add("home");
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new QosError("MISSING_ARGUMENT", "--home requires a path");
      home = value;
    } else if (token === "-j" || token === "--json") {
      if (seen.has("json")) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --json");
      seen.add("json");
      json = true;
    } else if (token === "--confirm-policy-change") {
      if (seen.has("confirm")) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --confirm-policy-change");
      seen.add("confirm");
      confirmed = true;
    } else if (token.startsWith("-")) {
      throw new QosError("INVALID_ARGUMENT", `Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (typeof home !== "string") throw new QosError("MISSING_RUNTIME_PROFILE", "Use --home or QOS_HOME to select an installed qOS profile");
  return { help: false, home: resolve(home), json, confirmed, positional };
}

function summary(result) {
  const policy = result.policy;
  return {
    status: result.changed ? "policy-updated" : "current-policy",
    profile: result.profile,
    cluster: result.cluster,
    policyFile: result.policyFile,
    policyCommitment: result.policyCommitment,
    rpcUrl: policy.rpcUrl,
    commitment: policy.commitment,
    destinations: policy.allowedDestinations,
    strategyIds: policy.allowedStrategyIds,
    maxSolLamports: policy.maxTransferLamports,
    maxTokenAmount: policy.tokenTransfer?.maxTransferAmount ?? "disabled",
    maxFeeLamports: policy.maxFeeLamports,
    rateLimitPerMinute: policy.maxRequestsPerMinute,
    ttlSlots: policy.maxIntentTtlSlots,
    lockedTemplate: `${policy.venueId}/${policy.marketId}`,
    externalSignerPolicySyncRequired: result.externalSignerPolicySyncRequired,
  };
}

async function confirmChange(options, description) {
  if (options.confirmed) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new QosError("POLICY_CHANGE_CONFIRMATION_REQUIRED", "Policy changes require --confirm-policy-change when input is not an interactive terminal");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Apply policy change (${description})? Type yes to continue: `);
    if (answer.trim().toLowerCase() !== "yes") throw new QosError("POLICY_CHANGE_CANCELLED", "Policy was not changed");
  } finally {
    terminal.close();
  }
}

async function interactiveEdit(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new QosError("INTERACTIVE_TTY_REQUIRED", "policy edit requires a terminal; use policy set with flags for automation");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let field;
  let value;
  try {
    process.stdout.write(`Editable fields: ${EDITABLE_POLICY_FIELDS.join(", ")}\n`);
    field = (await terminal.question("Field: ")).trim();
    value = (await terminal.question("New value: ")).trim();
    const answer = await terminal.question(`Apply ${field} = ${value}? Type yes to continue: `);
    if (answer.trim().toLowerCase() !== "yes") throw new QosError("POLICY_CHANGE_CANCELLED", "Policy was not changed");
  } finally {
    terminal.close();
  }
  return setPolicyField(options.home, field, value);
}

async function main() {
  process.umask(0o077);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const [command = "show", ...rest] = options.positional;
  let result;
  if (command === "show") {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "policy show accepts no arguments");
    result = showEditablePolicy(options.home);
  } else if (command === "edit") {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "policy edit accepts no arguments");
    result = await interactiveEdit(options);
  } else if (command === "set") {
    if (rest.length !== 2) throw new QosError("INVALID_ARGUMENT", "policy set requires FIELD VALUE");
    await confirmChange(options, `${rest[0]} = ${rest[1]}`);
    result = setPolicyField(options.home, rest[0], rest[1]);
  } else if (command === "destination") {
    if (rest.length !== 2) throw new QosError("INVALID_ARGUMENT", "policy destination requires add|remove PUBKEY");
    await confirmChange(options, `${rest[0]} destination ${rest[1]}`);
    result = changePolicyDestination(options.home, rest[0], rest[1]);
  } else if (command === "strategy") {
    if (rest.length !== 2) throw new QosError("INVALID_ARGUMENT", "policy strategy requires add|remove ID");
    await confirmChange(options, `${rest[0]} strategy ${rest[1]}`);
    result = changePolicyStrategy(options.home, rest[0], rest[1]);
  } else {
    throw new QosError("UNKNOWN_COMMAND", `Unknown policy command: ${command}`);
  }
  writeResult(options.json ? result : summary(result), { json: options.json, title: "qOS policy" });
  if (result.externalSignerPolicySyncRequired) {
    process.stderr.write("NOTICE: update and re-review the protected policy commitment in the external signer before signing again.\n");
  }
}

main().catch((error) => {
  const json = process.argv.includes("--json") || process.argv.includes("-j");
  if (json) process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  else process.stderr.write(`qOS error [${error?.code ?? "INTERNAL_ERROR"}]: ${error instanceof QosError ? error.message : "The request failed closed"}\n`);
  process.exitCode = 1;
});
