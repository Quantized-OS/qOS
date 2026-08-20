#!/usr/bin/env node
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { publicError, QosError } from "../src/errors.js";
import { initializeSandbox, QosService } from "../src/service.js";
import { startServer } from "../src/server.js";
import { readSecureFile } from "../src/secure-file.js";
import { configureDexTrading, defaultDexVenue, publicDexTrading } from "../src/dex.js";

const MAX_CLI_JSON_BYTES = 256 * 1024;

function usage() {
  return `qOS Solana policy sandbox

Usage:
  qos init [--home PATH] [--cluster devnet|mainnet-beta] [--destination PUBKEY]
           [--signer-public-key PUBKEY | --key-passphrase-file PATH]
  qos address [--home PATH]
  qos health [--home PATH]
  qos balance [--home PATH] [--address PUBKEY]
  qos airdrop [--home PATH] [--lamports N]
  qos prepare [--home PATH] [--destination PUBKEY] [--lamports N]
              [--nonce N] [--max-fee-lamports N] [--strategy-id N]
  qos submit --intent FILE [--proof FILE] [--home PATH]
  qos transfer [--home PATH] [--destination PUBKEY] [--lamports N]
  qos token-address [--home PATH] [--owner PUBKEY]
  qos token-balance [--home PATH] [--owner PUBKEY]
  qos token-prepare [--home PATH] [--destination PUBKEY] [--amount N]
                    [--nonce N] [--max-fee-lamports N] [--strategy-id N]
  qos token-transfer [--home PATH] [--destination PUBKEY] [--amount N]
  qos dex-status [--home PATH]
  qos dex-configure --home PATH [--api-key-file PATH] [--venues jupiter,raydium]
                    [--max-input-amount N] [--daily-input-limit N]
                    [--receiver PUBKEY] [policy limit options]
  qos dex-swap --home PATH [--venue jupiter|raydium] --input-mint PUBKEY
               --output-mint PUBKEY --amount N [--strategy-id N]
  qos privacy-status [--home PATH]
  qos serve [--home PATH] [--host HOST] [--port PORT]

SOL amounts are integer lamports. Token amounts are integer base units.
Mainnet submission additionally requires QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND.
External signer homes require QOS_SIGNER_COMMAND. Encrypted software-key homes
require QOS_KEY_PASSPHRASE_FILE. Prefer the external signer for agent workloads.
The HTTP service requires QOS_API_TOKEN_FILE or QOS_API_TOKEN; mainnet service
mode requires the secure token-file form.
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

function humanServeOutput() {
  return process.env.QOS_HUMAN_OUTPUT === "1" && process.argv[2] === "serve";
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_CLI_JSON_BYTES) throw new QosError("INPUT_TOO_LARGE", "CLI JSON input exceeds 256 KiB");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new QosError("INVALID_JSON", "Input is not valid UTF-8 JSON");
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readJsonFile(path, label) {
  const bytes = readSecureFile(resolve(path), {
    maxBytes: MAX_CLI_JSON_BYTES,
    errorCode: "INSECURE_INPUT_FILE",
    label,
  });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new QosError("INVALID_JSON", `${label} is not valid UTF-8 JSON`);
  } finally {
    bytes.fill(0);
  }
}

async function main() {
  process.umask(0o077);
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  if (command === "init") {
    only(options, ["home", "destination", "cluster", "signer-public-key", "key-passphrase-file"]);
    const cluster = options.cluster ?? "devnet";
    print(initializeSandbox(homeOf(options, cluster), options.destination, {
      cluster,
      signerPublicKey: options["signer-public-key"],
      keyPassphraseFile: options["key-passphrase-file"] === undefined ? undefined : resolve(options["key-passphrase-file"]),
    }));
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
      only(options, ["home", "intent", "proof"]);
      if (!options.intent) throw new QosError("MISSING_ARGUMENT", "--intent is required");
      const text = options.intent === "-" ? await readStdin() : readJsonFile(options.intent, "Intent file");
      const intent = JSON.parse(text);
      const request = options.proof === undefined
        ? intent
        : { intent, privacyProof: JSON.parse(readJsonFile(options.proof, "Proof file")) };
      print(await service.submitIntent(request));
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
    case "dex-status": {
      only(options, ["home"]);
      const configuration = publicDexTrading(service.paths.home);
      print({ status: configuration === null ? "disabled" : "enabled", configuration });
      return;
    }
    case "dex-configure": {
      only(options, ["home", "api-key-file", "venues", "max-input-amount", "daily-input-limit", "receiver", "max-slippage-bps", "max-route-fee-bps", "max-fee-lamports", "min-interval-seconds", "max-swaps-per-day"]);
      print(configureDexTrading(service.paths.home, {
        ...(options["api-key-file"] === undefined ? {} : { apiKeyFile: resolve(options["api-key-file"]) }),
        ...(options.venues === undefined ? {} : { venues: options.venues.split(",").map((value) => value.trim()) }),
        ...(options["max-input-amount"] === undefined ? {} : { maxInputAmount: options["max-input-amount"] }),
        ...(options["daily-input-limit"] === undefined ? {} : { dailyInputLimit: options["daily-input-limit"] }),
        ...(options.receiver === undefined ? {} : { receiver: options.receiver }),
        ...(options["max-slippage-bps"] === undefined ? {} : { maxSlippageBps: Number(options["max-slippage-bps"]) }),
        ...(options["max-route-fee-bps"] === undefined ? {} : { maxRouteFeeBps: Number(options["max-route-fee-bps"]) }),
        ...(options["max-fee-lamports"] === undefined ? {} : { maxFeeLamports: options["max-fee-lamports"] }),
        ...(options["min-interval-seconds"] === undefined ? {} : { minIntervalSeconds: Number(options["min-interval-seconds"]) }),
        ...(options["max-swaps-per-day"] === undefined ? {} : { maxSwapsPerDay: Number(options["max-swaps-per-day"]) }),
      }));
      return;
    }
    case "dex-swap": {
      only(options, ["home", "venue", "input-mint", "output-mint", "amount", "strategy-id"]);
      for (const required of ["input-mint", "output-mint", "amount"]) {
        if (options[required] === undefined) throw new QosError("MISSING_ARGUMENT", `--${required} is required`);
      }
      print(await service.executeDexSwap({
        version: 3,
        action: "swap",
        venue: options.venue ?? defaultDexVenue(service.paths.home),
        inputMint: options["input-mint"],
        outputMint: options["output-mint"],
        amount: options.amount,
        strategyId: Number(options["strategy-id"] ?? "1"),
      }));
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
      const status = { status: "listening", address: `http://${host}:${port}`, signer: service.publicKey, cluster: service.policy.cluster };
      if (humanServeOutput()) {
        process.stdout.write(`qOS API service\n---------------\nStatus: listening\nAddress: ${status.address}\nCluster: ${status.cluster}\nSigner: ${status.signer}\nAuthentication: required\nStop: Ctrl-C\n`);
      } else {
        print(status);
      }
      const close = () => server.close(() => {
        service.session.dispose();
        process.exit(0);
      });
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
  if (humanServeOutput()) {
    process.stderr.write(`qOS error [${error?.code ?? "INTERNAL_ERROR"}]: ${error instanceof QosError ? error.message : "The request failed closed"}\n`);
  } else {
    process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  }
  process.exitCode = 1;
});
