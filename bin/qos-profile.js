#!/usr/bin/env node

import { resolve } from "node:path";

import { publicError, QosError } from "../src/errors.js";
import { ensureRuntimeProfile, loadRuntimeProfile } from "../src/runtime-profile.js";

function usage() {
  return `qOS runtime profile manager

Usage:
  qos-profile create --home PATH --profile devnet|mainnet-external
                     [--signer-command /absolute/path/to/adapter]
  qos-profile show --home PATH

The generated API token remains in an owner-only file. Its value is never
printed; only its path is returned.
`;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new QosError("INVALID_ARGUMENT", `Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (Object.hasOwn(options, name)) throw new QosError("DUPLICATE_ARGUMENT", `Duplicate --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", `Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function only(options, allowed) {
  const unknown = Object.keys(options).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) throw new QosError("UNKNOWN_ARGUMENT", `Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}`);
}

async function main() {
  process.umask(0o077);
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (typeof options.home !== "string") throw new QosError("MISSING_ARGUMENT", "--home is required");
  const home = resolve(options.home);
  let result;
  if (command === "create") {
    only(options, ["home", "profile", "signer-command"]);
    if (typeof options.profile !== "string") throw new QosError("MISSING_ARGUMENT", "--profile is required");
    result = ensureRuntimeProfile(home, {
      profile: options.profile,
      signerCommand: options["signer-command"] ?? null,
    });
  } else if (command === "show") {
    only(options, ["home"]);
    result = loadRuntimeProfile(home);
  } else {
    throw new QosError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  process.exitCode = 1;
});
