#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { publicError, QosError } from "../src/errors.js";
import { initializeSandbox, QosService } from "../src/service.js";
import { startServer } from "../src/server.js";

function usage() {
  return `qOS Solana policy sandbox

Usage:
  qos init [--home PATH] [--cluster devnet|mainnet-beta] [--destination PUBKEY]
  qos address [--home PATH]
  qos health [--home PATH]
  qos balance [--home PATH] [--address PUBKEY]
  qos airdrop [--home PATH] [--lamports N]
  qos prepare [--home PATH] [--destination PUBKEY] [--lamports N]
              [--nonce N] [--max-fee-lamports N] [--strategy-id N]
  qos submit --intent FILE [--home PATH]
  qos transfer [--home PATH] [--destination PUBKEY] [--lamports N]
  qos token-address [--home PATH] [--owner PUBKEY]
  qos token-balance [--home PATH] [--owner PUBKEY]
  qos token-prepare [--home PATH] [--destination PUBKEY] [--amount N]
                    [--nonce N] [--max-fee-lamports N] [--strategy-id N]
  qos token-transfer [--home PATH] [--destination PUBKEY] [--amount N]
  qos privacy-status [--home PATH]
  qos serve [--home PATH] [--host HOST] [--port PORT]

SOL amounts are integer lamports. Token amounts are integer base units.
Mainnet submission additionally requires QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND.
`;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new QosError("INVALID_ARGUMENT", `Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", `Missing value for --${name}`);
    if (Object.hasOwn(options, name)) throw new QosError("DUPLICATE_ARGUMENT", `Duplicate --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function only(options, allowed) {
  const unknown = Object.keys(options).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) throw new QosError("UNKNOWN_ARGUMENT", `Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}`);
}

function homeOf(options, cluster = "devnet") {
  const defaultHome = cluster === "mainnet-beta" ? ".qos-ephemeral-mainnet" : ".qos-ephemeral-devnet";
  return resolve(options.home ?? process.env.QOS_HOME ?? defaultHome);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(usage());
    return;
  }

  if (command === "init") {
    only(options, ["home", "destination", "cluster"]);
    const cluster = options.cluster ?? "devnet";
    print(initializeSandbox(homeOf(options, cluster), options.destination, { cluster }));
    return;
  }

  const service = QosService.open(homeOf(options));
  switch (command) {
    case "address":
      only(options, ["home"]);
      print({ signer: service.publicKey, cluster: service.policy.cluster });
      return;
    case "health":
      only(options, ["home"]);
      print(await service.health());
      return;
    case "balance": {
      only(options, ["home", "address"]);
      const address = options.address ?? service.publicKey;
      print({ address, lamports: (await service.balance(address)).toString() });
      return;
    }
    case "airdrop":
      only(options, ["home", "lamports"]);
      print(await service.airdrop(options.lamports));
      return;
    case "prepare":
      only(options, ["home", "destination", "lamports", "nonce", "max-fee-lamports", "strategy-id"]);
      print(await service.prepareIntent({
        ...(options.destination === undefined ? {} : { destination: options.destination }),
        ...(options.lamports === undefined ? {} : { lamports: options.lamports }),
        ...(options.nonce === undefined ? {} : { requestNonce: options.nonce }),
        ...(options["max-fee-lamports"] === undefined ? {} : { maxFeeLamports: options["max-fee-lamports"] }),
        ...(options["strategy-id"] === undefined ? {} : { strategyId: Number(options["strategy-id"]) }),
      }));
      return;
    case "submit": {
      only(options, ["home", "intent"]);
      if (!options.intent) throw new QosError("MISSING_ARGUMENT", "--intent is required");
      const text = options.intent === "-" ? await readStdin() : readFileSync(resolve(options.intent), "utf8");
      print(await service.submitIntent(JSON.parse(text)));
      return;
    }
    case "transfer": {
      only(options, ["home", "destination", "lamports"]);
      const intent = await service.prepareIntent({
        ...(options.destination === undefined ? {} : { destination: options.destination }),
        ...(options.lamports === undefined ? {} : { lamports: options.lamports }),
      });
      print(await service.submitIntent(intent));
      return;
    }
    case "token-address": {
      only(options, ["home", "owner"]);
      print(service.tokenAddresses(options.owner ?? service.publicKey));
      return;
    }
    case "token-balance": {
      only(options, ["home", "owner"]);
      print(await service.tokenBalance(options.owner ?? service.publicKey));
      return;
    }
    case "token-prepare": {
      only(options, ["home", "destination", "amount", "nonce", "max-fee-lamports", "strategy-id"]);
      print(await service.prepareTokenIntent({
        ...(options.destination === undefined ? {} : { destination: options.destination }),
        ...(options.amount === undefined ? {} : { amount: options.amount }),
        ...(options.nonce === undefined ? {} : { requestNonce: options.nonce }),
        ...(options["max-fee-lamports"] === undefined ? {} : { maxFeeLamports: options["max-fee-lamports"] }),
        ...(options["strategy-id"] === undefined ? {} : { strategyId: Number(options["strategy-id"]) }),
      }));
      return;
    }
    case "token-transfer": {
      only(options, ["home", "destination", "amount"]);
      const intent = await service.prepareTokenIntent({
        ...(options.destination === undefined ? {} : { destination: options.destination }),
        ...(options.amount === undefined ? {} : { amount: options.amount }),
      });
      print(await service.submitIntent(intent));
      return;
    }
    case "privacy-status": {
      only(options, ["home"]);
      print(service.privacyStatus());
      return;
    }
    case "serve": {
      only(options, ["home", "host", "port"]);
      const host = options.host ?? process.env.QOS_HOST ?? "127.0.0.1";
      const port = Number(options.port ?? process.env.QOS_PORT ?? "8787");
      const server = startServer(service, { host, port });
      print({ status: "listening", address: `http://${host}:${port}`, signer: service.publicKey, cluster: service.policy.cluster });
      const close = () => server.close(() => process.exit(0));
      process.on("SIGINT", close);
      process.on("SIGTERM", close);
      return;
    }
    default:
      throw new QosError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
  }
}

main().catch((error) => {
  if (error instanceof SyntaxError) {
    error = new QosError("INVALID_JSON", "Input is not valid JSON");
  }
  process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  process.exitCode = 1;
});
