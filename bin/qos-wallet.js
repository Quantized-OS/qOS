#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import { publicError, QosError } from "../src/errors.js";
import { writeResult } from "../src/human-output.js";
import { QosService } from "../src/service.js";
import { fundDevnetWallet, walletReadiness } from "../src/wallet-onboarding.js";

function usage() {
  return `qOS source-wallet onboarding

Usage:
  qos-wallet [--home PATH] [--json] status
  qos-wallet [--home PATH] [--json] fund-devnet [--lamports N] [--confirm-airdrop]

status verifies the RPC genesis, source address, SOL fee reserve, and the pinned
qOS Token-2022 source account when enabled. fund-devnet requests and confirms a
Devnet airdrop; it is never available on mainnet.
`;
}

function parseArgs(argv) {
  let home = process.env.QOS_HOME;
  let json = false;
  let confirmed = false;
  let lamports = "200000000";
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
    } else if (token === "--lamports") {
      if (seen.has("lamports")) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --lamports");
      seen.add("lamports");
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new QosError("MISSING_ARGUMENT", "--lamports requires a value");
      lamports = value;
    } else if (token === "-j" || token === "--json") {
      if (seen.has("json")) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --json");
      seen.add("json");
      json = true;
    } else if (token === "--confirm-airdrop") {
      if (seen.has("confirm")) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --confirm-airdrop");
      seen.add("confirm");
      confirmed = true;
    } else if (token.startsWith("-")) {
      throw new QosError("INVALID_ARGUMENT", `Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (typeof home !== "string") throw new QosError("MISSING_RUNTIME_PROFILE", "Use --home or QOS_HOME to select an installed qOS profile");
  return { help: false, home: resolve(home), json, confirmed, lamports, positional };
}

async function confirmAirdrop(options) {
  if (options.confirmed) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new QosError("AIRDROP_CONFIRMATION_REQUIRED", "Devnet funding requires --confirm-airdrop when input is not an interactive terminal");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Request and confirm ${options.lamports} Devnet lamports for the source wallet? [y/N] `);
    if (!["y", "yes"].includes(answer.trim().toLowerCase())) throw new QosError("AIRDROP_CANCELLED", "Devnet wallet was not funded");
  } finally {
    terminal.close();
  }
}

async function main() {
  process.umask(0o077);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const [command = "status", ...rest] = options.positional;
  if (rest.length) throw new QosError("INVALID_ARGUMENT", `${command} accepts no positional arguments`);
  const service = QosService.open(options.home);
  let result;
  if (command === "status" || command === "check") {
    result = await walletReadiness(service);
  } else if (command === "fund-devnet" || command === "fund") {
    await confirmAirdrop(options);
    result = await fundDevnetWallet(service, options.lamports);
  } else {
    throw new QosError("UNKNOWN_COMMAND", `Unknown wallet command: ${command}`);
  }
  writeResult(result, { json: options.json, title: "qOS source wallet" });
}

main().catch((error) => {
  const json = process.argv.includes("--json") || process.argv.includes("-j");
  if (json) process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  else process.stderr.write(`qOS error [${error?.code ?? "INTERNAL_ERROR"}]: ${error instanceof QosError ? error.message : "The request failed closed"}\n`);
  process.exitCode = 1;
});
