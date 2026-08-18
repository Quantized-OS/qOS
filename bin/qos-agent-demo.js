#!/usr/bin/env node

import { resolve } from "node:path";
import { basicAgentPlan, configuredModelAgentPlan, modelAgentPlan } from "../src/agent.js";
import { assertQos, publicError, QosError } from "../src/errors.js";
import { formatHuman } from "../src/human-output.js";
import { loadModelProviderForRequest } from "../src/model-registry.js";
import { QosService } from "../src/service.js";
import { walletReadiness } from "../src/wallet-onboarding.js";

function usage() {
  console.log(`qOS agent-directed Token-2022 transfer demo

Usage:
  node bin/qos-agent-demo.js --home <dir> --amount <base units> [options]

Options:
  --agent basic|model       Proposal agent (default: basic)
  --model-profile <id>      Configured local or commercial BYOK provider profile
  --model-url <url>         Legacy loopback OpenAI-compatible endpoint
  --model <name>            Legacy local model name (default: qwen2.5:3b)
  --destination <pubkey>    Must match the destination pinned in policy
  --broadcast               Submit after qOS validation and simulation
  --confirm-live            Required together with --broadcast
  --json                    Emit machine-readable event objects
  --help                    Show this help

Default behavior prepares and validates an intent without broadcasting it.
This demo transfers the pinned qOS Token-2022 asset; it is not a DEX swap.
`);
}

function parseArgs(argv) {
  const options = { agent: "basic" };
  const seen = new Set();
  const valueOptions = new Set(["home", "amount", "agent", "model-profile", "model-url", "model", "destination"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--broadcast" || arg === "--confirm-live" || arg === "--json") {
      const key = arg.slice(2);
      assertQos(!seen.has(key), "DUPLICATE_ARGUMENT", `Duplicate --${key}`);
      seen.add(key);
      options[key] = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      assertQos(valueOptions.has(match[1]), "CLI_ARGUMENT_INVALID", `Unknown option: --${match[1]}`);
      assertQos(!seen.has(match[1]), "DUPLICATE_ARGUMENT", `Duplicate --${match[1]}`);
      seen.add(match[1]);
      options[match[1]] = match[2];
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      assertQos(valueOptions.has(key), "CLI_ARGUMENT_INVALID", `Unknown option: --${key}`);
      assertQos(!seen.has(key), "DUPLICATE_ARGUMENT", `Duplicate --${key}`);
      seen.add(key);
      const value = argv[index + 1];
      assertQos(value && !value.startsWith("--"), "CLI_ARGUMENT_INVALID", `Missing value for --${key}`);
      options[key] = value;
      index += 1;
      continue;
    }
    assertQos(false, "CLI_ARGUMENT_INVALID", `Unexpected argument: ${arg}`);
  }
  return options;
}

function printEvent(event, details = {}, json = false) {
  const value = { event, ...details };
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : formatHuman(value, { title: `qOS agent: ${event.replaceAll("_", " ")}` }));
}

async function main() {
  process.umask(0o077);
  const options = parseArgs(process.argv.slice(2));
  assertQos(typeof options.home === "string", "CLI_ARGUMENT_INVALID", "--home is required");
  assertQos(typeof options.amount === "string", "CLI_ARGUMENT_INVALID", "--amount is required");
  assertQos(options.agent === "basic" || options.agent === "model", "CLI_ARGUMENT_INVALID", "--agent must be basic or model");
  assertQos(!options["confirm-live"] || options.broadcast, "LIVE_CONFIRMATION_REQUIRED", "--confirm-live requires --broadcast");
  if (options.broadcast) {
    assertQos(options["confirm-live"] === true, "LIVE_CONFIRMATION_REQUIRED", "Live broadcast requires --confirm-live");
    assertQos(process.env.QOS_ENABLE_MAINNET_BROADCAST === "I_UNDERSTAND", "LIVE_BROADCAST_DISABLED", "Set QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND for an explicit mainnet broadcast");
  }

  const service = QosService.open(resolve(options.home));
  assertQos(service.policy.cluster === "mainnet-beta", "AGENT_CLUSTER_INVALID", "The agent demo requires a mainnet-beta policy");
  assertQos(service.policy.tokenTransfer, "AGENT_TOKEN_POLICY_MISSING", "The policy does not enable the qOS Token-2022 transfer path");

  const destination = options.destination ?? service.policy.allowedDestinations?.[0];
  assertQos(typeof destination === "string", "AGENT_DESTINATION_INVALID", "No policy destination is available");
  assertQos(service.policy.allowedDestinations.includes(destination), "AGENT_DESTINATION_FORBIDDEN", "Destination is not allowlisted by policy");

  const agentContext = {
    amount: options.amount,
    destination,
    maxAmount: service.policy.tokenTransfer.maxTransferAmount,
    mint: service.policy.tokenTransfer.mint,
    decimals: service.policy.tokenTransfer.decimals,
  };

  const explicitLegacyModel = options["model-url"] !== undefined || options.model !== undefined;
  assertQos(!(options["model-profile"] && explicitLegacyModel), "CLI_ARGUMENT_INVALID", "--model-profile cannot be combined with legacy --model-url or --model");
  const modelProfileId = options["model-profile"] ?? (explicitLegacyModel ? undefined : process.env.QOS_AGENT_MODEL_PROFILE);
  let selectedProvider;
  if (options.agent === "model" && modelProfileId) {
    selectedProvider = loadModelProviderForRequest(resolve(options.home), modelProfileId);
  }

  const plan = options.agent === "basic"
    ? basicAgentPlan(agentContext)
    : selectedProvider
      ? await configuredModelAgentPlan({ ...agentContext, ...selectedProvider })
      : await modelAgentPlan({
        ...agentContext,
        url: options["model-url"] ?? process.env.QOS_AGENT_MODEL_URL,
        model: options.model ?? process.env.QOS_AGENT_MODEL ?? "qwen2.5:3b",
      });

  printEvent("agent_decision", {
    agent: options.agent === "basic"
      ? "basic-policy-aware"
      : selectedProvider
        ? `${selectedProvider.profile.provider}/${selectedProvider.profile.model}`
        : (options.model ?? process.env.QOS_AGENT_MODEL ?? "qwen2.5:3b"),
    ...(selectedProvider ? { modelProfile: modelProfileId } : {}),
    plan,
  }, options.json === true);

  const readiness = await walletReadiness(service);
  if (readiness.status !== "ready") {
    printEvent("wallet_readiness", {
      status: readiness.status,
      signer: readiness.signer,
      balanceLamports: readiness.balanceLamports,
      sourceTokenAccount: readiness.token?.tokenAccount ?? null,
      blockers: readiness.blockers,
      nextSteps: readiness.nextSteps,
    }, options.json === true);
    throw new QosError("WALLET_NOT_READY", "Resolve the displayed source-wallet blockers, run qos wallet status, and retry the demo preflight");
  }

  const intent = await service.prepareTokenIntent({ amount: plan.amount, destination: plan.destination });
  printEvent("qos_intent_prepared", {
    status: "validated",
    broadcast: false,
    intent,
    controls: ["pinned-mint", "token-program", "decimals", "allowlisted-destination", "amount-limit", "account-existence", "balance", "fresh-blockhash"],
  }, options.json === true);

  if (!options.broadcast) {
    printEvent("demo_complete", { status: "dry-run", next: "add --broadcast --confirm-live after reviewing the exact intent" }, options.json === true);
    return;
  }

  const result = await service.submitIntent(intent);
  printEvent("qos_transaction_broadcast", {
    status: "confirmed",
    signature: result.signature,
    cluster: "mainnet-beta",
    explorer: `https://explorer.solana.com/tx/${result.signature}`,
  }, options.json === true);
}

main().catch((error) => {
  if (process.argv.includes("--json")) console.error(JSON.stringify(publicError(error), null, 2));
  else process.stderr.write(`qOS error [${error?.code ?? "INTERNAL_ERROR"}]: ${error instanceof QosError ? error.message : "The request failed closed"}\n`);
  process.exitCode = 1;
});
