#!/usr/bin/env node

import { resolve } from "node:path";

import { publicError, QosError } from "../src/errors.js";
import { writeResult } from "../src/human-output.js";
import {
  configureModelProvider,
  getModelProvider,
  listModelProviders,
  removeModelProvider,
  rotateModelProviderCredential,
} from "../src/model-registry.js";
import { modelProviderCatalog } from "../src/model-provider.js";

const VALUE_OPTIONS = new Set([
  "--home",
  "--provider",
  "--model",
  "--endpoint",
  "--api-key-file",
]);
const FLAG_OPTIONS = new Set(["--json", "--allow-custom-endpoint", "--yes"]);
const OPTION_ALIASES = new Map([
  ["-H", "--home"],
  ["-j", "--json"],
  ["-p", "--provider"],
  ["-m", "--model"],
  ["-e", "--endpoint"],
  ["-k", "--api-key-file"],
]);

function usage() {
  return `qOS model provider and BYOK control

Usage:
  qos-model catalog [--json]
  qos-model [--home PATH] list [--json]
  qos-model [--home PATH] show ID [--json]
  qos-model [--home PATH] configure ID --provider NAME --model NAME [options]
  qos-model [--home PATH] rotate ID --api-key-file PATH
  qos-model [--home PATH] remove ID --yes

Configure options:
  -p, --provider NAME          Provider from qos-model catalog
  -m, --model NAME             Provider model ID
  -k, --api-key-file PATH      Owner-only file containing a commercial API key
  -e, --endpoint URL           Required for local, Azure, and custom providers
      --allow-custom-endpoint  Acknowledge that the API key is sent to this URL

API keys are copied into the selected qOS profile as owner-only files and are
never printed, stored in provider metadata, added to prompts, or passed on the
command line. Local profiles do not accept an API key. Built-in commercial
providers use fixed HTTPS endpoints; custom endpoints require acknowledgement.
`;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "-h" || raw === "--help") return { help: true };
    const token = OPTION_ALIASES.get(raw) ?? raw;
    if (VALUE_OPTIONS.has(token)) {
      if (values.has(token)) throw new QosError("DUPLICATE_ARGUMENT", `Duplicate ${token}`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", `${token} requires a value`);
      values.set(token, value);
    } else if (FLAG_OPTIONS.has(token)) {
      if (flags.has(token)) throw new QosError("DUPLICATE_ARGUMENT", `Duplicate ${token}`);
      flags.add(token);
    } else if (token.startsWith("-")) {
      throw new QosError("INVALID_ARGUMENT", `Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  const [command = "list"] = positional;
  const homeValue = values.get("--home") ?? process.env.QOS_HOME;
  if (command !== "catalog" && typeof homeValue !== "string") {
    throw new QosError("MISSING_RUNTIME_PROFILE", "Use --home or QOS_HOME to select an installed qOS profile");
  }
  return {
    help: false,
    home: homeValue === undefined ? undefined : resolve(homeValue),
    values,
    flags,
    positional,
    json: flags.has("--json"),
  };
}

function assertOptionSurface(options, valueOptions = [], flagOptions = []) {
  const allowedValues = new Set(["--home", ...valueOptions]);
  const allowedFlags = new Set(["--json", ...flagOptions]);
  const invalid = [
    ...[...options.values.keys()].filter((name) => !allowedValues.has(name)),
    ...[...options.flags].filter((name) => !allowedFlags.has(name)),
  ];
  if (invalid.length) throw new QosError("INVALID_ARGUMENT", `Option(s) not valid for this command: ${invalid.join(", ")}`);
}

async function main() {
  process.umask(0o077);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const [command = "list", ...rest] = options.positional;
  let result;
  if (command === "catalog") {
    assertOptionSurface(options);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "model catalog accepts no arguments");
    result = {
      providers: modelProviderCatalog(),
      customEndpointWarning: "Custom endpoints receive the configured API key and require explicit acknowledgement.",
    };
  } else if (command === "list") {
    assertOptionSurface(options);
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "model list accepts no arguments");
    result = { profiles: listModelProviders(options.home) };
  } else if (command === "show") {
    assertOptionSurface(options);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "model show requires one profile ID");
    result = getModelProvider(options.home, rest[0]);
  } else if (command === "configure") {
    assertOptionSurface(options, ["--provider", "--model", "--endpoint", "--api-key-file"], ["--allow-custom-endpoint"]);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "model configure requires one profile ID");
    result = configureModelProvider(options.home, {
      id: rest[0],
      provider: options.values.get("--provider"),
      model: options.values.get("--model"),
      endpoint: options.values.get("--endpoint"),
      apiKeyFile: options.values.get("--api-key-file"),
      allowCustomEndpoint: options.flags.has("--allow-custom-endpoint"),
    });
  } else if (command === "rotate") {
    assertOptionSurface(options, ["--api-key-file"]);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "model rotate requires one profile ID");
    result = rotateModelProviderCredential(options.home, rest[0], {
      apiKeyFile: options.values.get("--api-key-file"),
    });
  } else if (command === "remove") {
    assertOptionSurface(options, [], ["--yes"]);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "model remove requires one profile ID");
    if (!options.flags.has("--yes")) throw new QosError("CONFIRMATION_REQUIRED", "Removing a model profile requires --yes");
    result = removeModelProvider(options.home, rest[0]);
  } else {
    throw new QosError("UNKNOWN_COMMAND", `Unknown model command: ${command}`);
  }
  writeResult(result, { json: options.json, title: "qOS model providers" });
}

main().catch((error) => {
  const json = process.argv.includes("--json") || process.argv.includes("-j");
  if (json) process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  else process.stderr.write(`qOS error [${error?.code ?? "INTERNAL_ERROR"}]: ${error instanceof QosError ? error.message : "The request failed closed"}\n`);
  process.exitCode = 1;
});
