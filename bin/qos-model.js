#!/usr/bin/env node

import { readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { TextDecoder } from "node:util";

import { publicError, QosError } from "../src/errors.js";
import { writeResult } from "../src/human-output.js";
import {
  configureModelProvider,
  getDefaultModelProvider,
  getModelProvider,
  listModelProviders,
  removeModelProvider,
  rotateModelProviderCredential,
  setDefaultModelProvider,
} from "../src/model-registry.js";
import { modelProviderCatalog } from "../src/model-provider.js";

const VALUE_OPTIONS = new Set([
  "--home",
  "--provider",
  "--model",
  "--endpoint",
  "--api-key-file",
]);
const FLAG_OPTIONS = new Set(["--json", "--allow-custom-endpoint", "--default", "--wizard", "--yes"]);
const OPTION_ALIASES = new Map([
  ["-H", "--home"],
  ["-j", "--json"],
  ["-p", "--provider"],
  ["-m", "--model"],
  ["-e", "--endpoint"],
  ["-k", "--api-key-file"],
]);

function usage() {
  return `qOS model onboarding and BYOK control

Usage:
  qos model onboard [ID]                 Guided provider/local setup
  qos model catalog [--json]
  qos model list [--json]
  qos model show ID [--json]
  qos model default                     Show the default model
  qos model use ID                      Select the default model
  qos model configure ID --provider NAME --model NAME [options]
  qos model rotate ID --api-key-file PATH
  qos model remove ID --yes

Configure options:
  -p, --provider NAME          Provider from qos model catalog
  -m, --model NAME             Provider model ID
  -k, --api-key-file PATH      Owner-only file containing a commercial API key
  -e, --endpoint URL           Required for local, Azure, and custom providers
      --allow-custom-endpoint  Acknowledge that the API key is sent to this URL
      --default                Make a configured profile the default
      --wizard                 Force guided onboarding with piped input

API keys are copied into the selected qOS profile as owner-only files and are
never printed, stored in provider metadata, or added to prompts. This command
accepts only an API-key file path, never the key value. Local profiles do not
accept an API key. Built-in commercial
providers use fixed HTTPS endpoints; custom endpoints require acknowledgement.
Guided onboarding defaults local models to Ollama at 127.0.0.1 with
qwen2.5:3b. Commercial model IDs are entered explicitly because account access,
pricing, and provider availability change independently of qOS.
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

function userPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(process.env.QOS_CALLER_CWD ?? process.cwd(), value);
}

async function ask(terminal, question, fallback = undefined) {
  const suffix = fallback === undefined ? "" : ` [${fallback}]`;
  const answer = (await terminal.question(`${question}${suffix}: `)).trim();
  return answer === "" ? fallback : answer;
}

async function askRequired(terminal, question, fallback = undefined) {
  while (true) {
    const value = await ask(terminal, question, fallback);
    if (typeof value === "string" && value.length > 0) return value;
    process.stdout.write("A value is required.\n");
  }
}

async function promptTerminal(forceWizard) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return createInterface({ input: process.stdin, output: process.stdout });
  }
  if (!forceWizard) throw new QosError("INTERACTIVE_TTY_REQUIRED", "Guided model onboarding requires a terminal or --wizard");
  let totalBytes = 0;
  return {
    async question(text) {
      process.stdout.write(text);
      const line = Buffer.alloc(4096);
      let length = 0;
      try {
        while (true) {
          const count = readSync(process.stdin.fd, line, length, 1, null);
          if (count === 0) {
            if (length === 0) throw new QosError("MODEL_ONBOARDING_INPUT_ENDED", "Model onboarding input ended before setup was complete");
            break;
          }
          totalBytes += 1;
          if (totalBytes > 64 * 1024) throw new QosError("INPUT_TOO_LARGE", "Model onboarding input exceeds 64 KiB");
          if (line[length] === 0x0a) break;
          length += 1;
          if (length === line.length) throw new QosError("INPUT_TOO_LARGE", "One model onboarding answer exceeds 4096 bytes");
        }
        if (length > 0 && line[length - 1] === 0x0d) length -= 1;
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(line.subarray(0, length));
        } catch {
          throw new QosError("INVALID_INPUT", "Model onboarding input is not valid UTF-8");
        }
      } finally {
        line.fill(0);
      }
    },
    close() {},
  };
}

function orderedCatalog() {
  const order = [
    "local", "openai", "anthropic", "google", "xai", "groq", "mistral",
    "deepseek", "openrouter", "together", "fireworks", "perplexity",
    "cohere", "cerebras", "azure-openai", "custom-openai",
    "custom-anthropic", "custom-gemini", "custom-cohere",
  ];
  const catalog = new Map(modelProviderCatalog().map((provider) => [provider.id, provider]));
  return order.map((id) => catalog.get(id)).filter(Boolean);
}

async function selectProvider(terminal, selected) {
  const catalog = orderedCatalog();
  process.stdout.write("\nChoose a model provider\n-----------------------\n");
  catalog.forEach((provider, index) => {
    const detail = provider.id === "local"
      ? "no API key; Ollama-compatible default"
      : provider.endpointMode === "fixed" || provider.endpointMode === "gemini-model"
        ? "built-in HTTPS endpoint"
        : "endpoint required";
    process.stdout.write(`${String(index + 1).padStart(2, " ")}. ${provider.name} (${provider.id}) — ${detail}\n`);
  });
  let candidate = selected;
  while (true) {
    candidate = candidate ?? await ask(terminal, "Provider number or ID", "1");
    const number = /^[1-9][0-9]*$/.test(candidate) ? Number(candidate) : null;
    const provider = number !== null ? catalog[number - 1] : catalog.find((entry) => entry.id === candidate);
    if (provider !== undefined) return provider;
    process.stdout.write("Choose one of the listed provider numbers or IDs.\n");
    candidate = undefined;
  }
}

async function onboardingConfiguration(options, idFromCommand) {
  const guided = process.stdin.isTTY && process.stdout.isTTY || options.flags.has("--wizard");
  if (!guided) {
    if (!options.flags.has("--yes")) throw new QosError("CONFIRMATION_REQUIRED", "Unattended model onboarding requires --yes");
    return {
      id: idFromCommand,
      provider: options.values.get("--provider"),
      model: options.values.get("--model"),
      endpoint: options.values.get("--endpoint"),
      apiKeyFile: options.values.get("--api-key-file") === undefined ? undefined : userPath(options.values.get("--api-key-file")),
      allowCustomEndpoint: options.flags.has("--allow-custom-endpoint"),
      makeDefault: true,
    };
  }

  const terminal = await promptTerminal(options.flags.has("--wizard"));
  try {
    process.stdout.write("\nModel onboarding\n----------------\nChoose local inference or a commercial BYOK provider. qOS stores credentials outside model metadata and makes this profile the default.\n");
    const provider = await selectProvider(terminal, options.values.get("--provider"));
    const existingIds = new Set(listModelProviders(options.home).map((profile) => profile.id));
    let id = idFromCommand;
    while (id === undefined || existingIds.has(id)) {
      if (id !== undefined) process.stdout.write(`Profile ${id} already exists; choose a new ID.\n`);
      id = await askRequired(terminal, "Profile ID", provider.id);
    }
    const model = options.values.get("--model") ?? await askRequired(
      terminal,
      provider.id === "local" ? "Local model name" : "Exact model ID enabled in your provider account",
      provider.id === "local" ? "qwen2.5:3b" : undefined,
    );
    let endpoint = options.values.get("--endpoint");
    let allowCustomEndpoint = options.flags.has("--allow-custom-endpoint");
    if (provider.endpointMode === "loopback") {
      endpoint = endpoint ?? await askRequired(terminal, "Local OpenAI-compatible endpoint", "http://127.0.0.1:11434/v1/chat/completions");
    } else if (!["fixed", "gemini-model"].includes(provider.endpointMode)) {
      endpoint = endpoint ?? await askRequired(terminal, "HTTPS model endpoint");
      if (!allowCustomEndpoint) {
        process.stdout.write("This endpoint will receive the imported API key. Verify its hostname and TLS deployment before continuing.\n");
        allowCustomEndpoint = (await askRequired(terminal, "Type allow-endpoint to continue")) === "allow-endpoint";
        if (!allowCustomEndpoint) throw new QosError("MODEL_ONBOARDING_CANCELLED", "Custom endpoint was not approved");
      }
    }
    let apiKeyFile;
    if (provider.credentialRequired) {
      process.stdout.write("Save the API key in an owner-only file (chmod 600). Enter the path, never the key itself.\n");
      apiKeyFile = userPath(options.values.get("--api-key-file") ?? await askRequired(terminal, "API key file"));
    }
    process.stdout.write(`\nReady to configure\n------------------\nProfile:  ${id}\nProvider: ${provider.name} (${provider.id})\nModel:    ${model}\nEndpoint: ${endpoint ?? "built-in provider endpoint"}\nDefault:  yes\n`);
    if (!options.flags.has("--yes")) {
      const answer = await askRequired(terminal, "Create this model profile? Type yes to continue");
      if (answer.toLowerCase() !== "yes") throw new QosError("MODEL_ONBOARDING_CANCELLED", "Model profile was not created");
    }
    return {
      id,
      provider: provider.id,
      model,
      endpoint,
      apiKeyFile,
      allowCustomEndpoint,
      makeDefault: true,
    };
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
    const currentDefault = getDefaultModelProvider(options.home);
    result = { defaultProfile: currentDefault.defaultProfile, profiles: listModelProviders(options.home) };
  } else if (command === "show") {
    assertOptionSurface(options);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "model show requires one profile ID");
    result = getModelProvider(options.home, rest[0]);
  } else if (command === "onboard") {
    assertOptionSurface(options, ["--provider", "--model", "--endpoint", "--api-key-file"], ["--allow-custom-endpoint", "--wizard", "--yes"]);
    if (rest.length > 1) throw new QosError("INVALID_ARGUMENT", "model onboard accepts at most one profile ID");
    const configuration = await onboardingConfiguration(options, rest[0]);
    result = {
      status: "model-ready",
      ...configureModelProvider(options.home, configuration),
      next: "Run qos agent demo dry AMOUNT -a model to use this default provider.",
    };
  } else if (command === "configure") {
    assertOptionSurface(options, ["--provider", "--model", "--endpoint", "--api-key-file"], ["--allow-custom-endpoint", "--default"]);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "model configure requires one profile ID");
    result = configureModelProvider(options.home, {
      id: rest[0],
      provider: options.values.get("--provider"),
      model: options.values.get("--model"),
      endpoint: options.values.get("--endpoint"),
      apiKeyFile: options.values.get("--api-key-file") === undefined ? undefined : userPath(options.values.get("--api-key-file")),
      allowCustomEndpoint: options.flags.has("--allow-custom-endpoint"),
      makeDefault: options.flags.has("--default"),
    });
  } else if (command === "default" || command === "use") {
    assertOptionSurface(options);
    if (command === "default" && rest.length === 0) result = getDefaultModelProvider(options.home);
    else {
      if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", `model ${command} requires one profile ID`);
      result = setDefaultModelProvider(options.home, rest[0]);
    }
  } else if (command === "rotate") {
    assertOptionSurface(options, ["--api-key-file"]);
    if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "model rotate requires one profile ID");
    result = rotateModelProviderCredential(options.home, rest[0], {
      apiKeyFile: options.values.get("--api-key-file") === undefined ? undefined : userPath(options.values.get("--api-key-file")),
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
