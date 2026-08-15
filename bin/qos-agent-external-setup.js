#!/usr/bin/env node

import { createExternalSignerHome, parseExternalSetupArgs, resolveExternalSetup } from "../src/external-setup.js";
import { publicError } from "../src/errors.js";

function usage() {
  console.log(`qOS external-signer home setup

Usage:
  node bin/qos-agent-external-setup.js --public-key <external signer public key> [--source-home .qos-ephemeral-mainnet] [--destination <owner>] [--home .qos-ephemeral-mainnet-external] [--signer-command /absolute/path/to/adapter] --create

The public key must be generated and controlled by the external signer, HSM,
or reviewed adapter. This command never reads signer.pem, copies private
keys, imports keys, funds accounts, or broadcasts transactions.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }
  const options = parseExternalSetupArgs(argv);
  if (options.create !== true) {
    process.stdout.write(`${JSON.stringify({ status: "dry-run", plan: resolveExternalSetup(options), next: "add --create after reviewing the new home path and public key" }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(createExternalSignerHome(options), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  process.exitCode = 1;
});
