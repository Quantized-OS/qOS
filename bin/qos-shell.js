#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { publicError, QosError } from "../src/errors.js";
import { loadPolicy } from "../src/policy.js";
import { loadRuntimeProfile } from "../src/runtime-profile.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_COMMAND_BYTES = 4096;
const BANNER = [
  "  qqq     OOO    SSS",
  " q   q   O   O  S",
  " q   q   O   O   SSS",
  "  qqqq    OOO       S",
  "     q           SSS",
  "       secure firmware shell",
].join("\n");

const COMMAND_ALIASES = new Map([
  ["cap", "capabilities"],
  ["capa", "capabilities"],
  ["stat", "status"],
  ["addr", "address"],
  ["hlth", "health"],
  ["bal", "balance"],
  ["drop", "airdrop"],
  ["s", "sol"],
  ["tok", "token"],
  ["fw", "firmware"],
  ["ag", "agent"],
  ["api", "serve"],
  ["audit", "security-audit"],
  ["tr", "trade"],
  ["h", "help"],
  ["?", "help"],
  ["x", "exit"],
  ["q", "exit"],
]);
const SOL_ACTION_ALIASES = new Map([["prep", "prepare"], ["snd", "send"]]);
const TOKEN_ACTION_ALIASES = new Map([
  ["addr", "address"],
  ["bal", "balance"],
  ["prep", "prepare"],
  ["snd", "send"],
]);
const FIRMWARE_ACTION_ALIASES = new Map([
  ["bld", "build"],
  ["off", "offline"],
  ["cast", "broadcast"],
]);
const AGENT_ACTION_ALIASES = new Map([["dry", "dry-run"], ["cast", "broadcast"]]);
const ASSET_ALIASES = new Map([["s", "sol"], ["tok", "token"], ["t", "token"]]);

function usage() {
  return `${BANNER}

qOS command shell

Usage:
  qos [-H|--home PATH]
  qos [-H|--home PATH] [-r|--run] COMMAND [ARGUMENTS...]

Commands (long | shorthand):
  capabilities | capa
  status | stat        address | addr       health | hlth
  balance | bal [ADDRESS]                  airdrop | drop [LAMPORTS]
  sol | s prepare|prep [LAMPORTS]
  sol | s send|snd LAMPORTS --confirm-broadcast
  token | tok address|addr [OWNER]          token | tok balance|bal [OWNER]
  token | tok prepare|prep AMOUNT
  token | tok send|snd AMOUNT --confirm-live
  firmware | fw build|bld
  firmware | fw offline|off|live [sol|s|token|tok] [AMOUNT]
  firmware | fw broadcast|cast [sol|s|token|tok] [AMOUNT] --confirm-live
  agent | ag dry-run|dry AMOUNT [-a basic|model] [-u URL] [-m NAME]
  agent | ag broadcast|cast AMOUNT --confirm-live [agent options]
  serve | api [PORT]     security-audit | audit     trade | tr
  help | h | ?           exit | x | q

The shell never executes arbitrary shell text. Broadcast commands require the
listed confirmation option and remain constrained by the qOS policy signer.
The current source implements transfers, not DEX swaps; trade reports the
missing reviewed venue template instead of submitting anything.
`;
}

function parseProcessArgs(argv) {
  let home = process.env.QOS_HOME;
  let run = null;
  let homeSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") return { help: true, home, run };
    if (token === "-H" || token === "--home") {
      if (homeSeen) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --home");
      homeSeen = true;
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", "--home requires a path");
      home = value;
      continue;
    }
    if (token === "-r" || token === "--run") {
      run = argv.slice(index + 1);
      if (run.length === 0) throw new QosError("MISSING_ARGUMENT", "--run requires a qOS Shell command");
      break;
    }
    if (token.startsWith("-")) throw new QosError("INVALID_ARGUMENT", `Unexpected argument: ${token}`);
    run = argv.slice(index);
    break;
  }
  return { help: false, home, run };
}

function parseLine(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_COMMAND_BYTES) throw new QosError("COMMAND_TOO_LARGE", "qOS Shell command exceeds 4096 bytes");
  const trimmed = line.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/u);
}

function canonicalAmount(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || value.length > 20) {
    throw new QosError("INVALID_AMOUNT", `${label} must be a positive canonical integer`);
  }
  return value;
}

function expandAliases(tokens) {
  const expanded = [...tokens];
  expanded[0] = COMMAND_ALIASES.get(expanded[0]) ?? expanded[0];
  if (expanded[0] === "sol" && expanded[1] !== undefined) {
    expanded[1] = SOL_ACTION_ALIASES.get(expanded[1]) ?? expanded[1];
  } else if (expanded[0] === "token" && expanded[1] !== undefined) {
    expanded[1] = TOKEN_ACTION_ALIASES.get(expanded[1]) ?? expanded[1];
  } else if (expanded[0] === "firmware") {
    if (expanded[1] !== undefined) expanded[1] = FIRMWARE_ACTION_ALIASES.get(expanded[1]) ?? expanded[1];
    if (expanded[2] !== undefined) expanded[2] = ASSET_ALIASES.get(expanded[2]) ?? expanded[2];
  } else if (expanded[0] === "agent" && expanded[1] !== undefined) {
    expanded[1] = AGENT_ACTION_ALIASES.get(expanded[1]) ?? expanded[1];
  }
  return expanded;
}

function runProgram(script, args, context, extraEnvironment = {}) {
  const environment = {
    ...process.env,
    QOS_HOME: context.runtime.home,
    QOS_API_TOKEN_FILE: context.runtime.apiTokenFile,
    ...(context.runtime.signerCommand === null ? {} : { QOS_SIGNER_COMMAND: context.runtime.signerCommand }),
    ...extraEnvironment,
  };
  const result = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    env: environment,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw new QosError("COMMAND_FAILED", `Could not start ${script}`);
  return result.status ?? 1;
}

function qos(args, context, extraEnvironment = {}) {
  return runProgram("bin/qos.js", [args[0], "--home", context.runtime.home, ...args.slice(1)], context, extraEnvironment);
}

function printCapabilities(context) {
  const tokenEnabled = context.policy.tokenTransfer !== null;
  const nativeEnabled = BigInt(context.policy.maxTransferLamports) > 0n;
  const insecureMainnet = context.runtime.profile === "mainnet-insecure";
  process.stdout.write(`${JSON.stringify({
    profile: context.runtime.profile,
    cluster: context.policy.cluster,
    signerMode: insecureMainnet
      ? "local-software-key-accessible"
      : context.runtime.signerCommand === null
        ? "development-software"
        : "external-non-exportable-boundary",
    keyAccessibleToLocalProcesses: context.runtime.signerCommand === null,
    operations: [
      "policy-status",
      ...(nativeEnabled ? ["native-sol-intent", "native-sol-transfer"] : []),
      ...(tokenEnabled ? ["qos-token-intent", "qos-token-transfer", "agent-directed-qos-token-transfer"] : []),
      ...(context.runtime.profile === "devnet" ? ["qemu-firmware-rehearsal"] : []),
      "loopback-agent-api",
    ],
    dexTrading: false,
    dexReason: "No reviewed DEX program/instruction template is present in this source release.",
  }, null, 2)}\n`);
}

function parseAgentOptions(tokens) {
  const options = [];
  const allowed = new Set(["--agent", "--model-url", "--model"]);
  const aliases = new Map([["-a", "--agent"], ["-u", "--model-url"], ["-m", "--model"]]);
  for (let index = 0; index < tokens.length; index += 1) {
    const option = aliases.get(tokens[index]) ?? tokens[index];
    if (!allowed.has(option)) throw new QosError("INVALID_ARGUMENT", `Unknown agent option: ${option}`);
    const value = tokens[++index];
    if (!value || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", `${option} requires a value`);
    options.push(option, value);
  }
  return options;
}

function firmwareAmountArgs(asset, amount) {
  if (amount === undefined) return [];
  canonicalAmount(amount, asset === "sol" ? "lamports" : "token amount");
  return [asset === "sol" ? "--lamports" : "--amount", amount];
}

function dispatch(tokens, context) {
  if (tokens.length === 0) return { status: 0, exit: false };
  const [command, ...rest] = expandAliases(tokens);
  if (command === "help") {
    process.stdout.write(usage());
    return { status: 0, exit: false };
  }
  if (command === "exit" || command === "quit") return { status: 0, exit: true };
  if (command === "capabilities") {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "capabilities accepts no arguments");
    printCapabilities(context);
    return { status: 0, exit: false };
  }
  if (command === "trade") {
    throw new QosError("DEX_TEMPLATE_NOT_INSTALLED", "This build contains no reviewed DEX instruction template; no transaction was prepared or submitted");
  }
  if (command === "status") {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "status accepts no arguments");
    printCapabilities(context);
    const first = qos(["address"], context);
    const second = qos(["privacy-status"], context);
    return { status: first || second, exit: false };
  }
  if (["address", "health"].includes(command)) {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", `${command} accepts no arguments`);
    return { status: qos([command], context), exit: false };
  }
  if (command === "balance") {
    if (rest.length > 1) throw new QosError("INVALID_ARGUMENT", "balance accepts at most one address");
    return { status: qos(["balance", ...(rest[0] ? ["--address", rest[0]] : [])], context), exit: false };
  }
  if (command === "airdrop") {
    if (rest.length > 1) throw new QosError("INVALID_ARGUMENT", "airdrop accepts at most one amount");
    const amount = rest[0] === undefined ? "200000000" : canonicalAmount(rest[0], "airdrop lamports");
    return { status: qos(["airdrop", "--lamports", amount], context), exit: false };
  }
  if (command === "sol") {
    const [action, amount, confirmation, ...extra] = rest;
    if (action === "prepare") {
      if (confirmation !== undefined || extra.length) throw new QosError("INVALID_ARGUMENT", "sol prepare accepts at most one amount");
      return { status: qos(["prepare", ...(amount ? ["--lamports", canonicalAmount(amount, "lamports")] : [])], context), exit: false };
    }
    if (action === "send") {
      canonicalAmount(amount, "lamports");
      if (confirmation !== "--confirm-broadcast" || extra.length) throw new QosError("BROADCAST_CONFIRMATION_REQUIRED", "sol send requires --confirm-broadcast");
      return { status: qos(["transfer", "--lamports", amount], context), exit: false };
    }
    throw new QosError("INVALID_ARGUMENT", "Use sol prepare or sol send");
  }
  if (command === "token") {
    const [action, value, confirmation, ...extra] = rest;
    if (action === "address" || action === "balance") {
      if (confirmation !== undefined || extra.length) throw new QosError("INVALID_ARGUMENT", `token ${action} accepts at most one owner`);
      return { status: qos([`token-${action}`, ...(value ? ["--owner", value] : [])], context), exit: false };
    }
    if (action === "prepare") {
      if (confirmation !== undefined || extra.length) throw new QosError("INVALID_ARGUMENT", "token prepare accepts exactly one amount");
      return { status: qos(["token-prepare", "--amount", canonicalAmount(value, "token amount")], context), exit: false };
    }
    if (action === "send") {
      canonicalAmount(value, "token amount");
      if (confirmation !== "--confirm-live" || extra.length) throw new QosError("LIVE_CONFIRMATION_REQUIRED", "token send requires --confirm-live");
      return {
        status: qos(["token-transfer", "--amount", value], context, { QOS_ENABLE_MAINNET_BROADCAST: "I_UNDERSTAND" }),
        exit: false,
      };
    }
    throw new QosError("INVALID_ARGUMENT", "Use token address, token balance, token prepare, or token send");
  }
  if (command === "firmware") {
    const [action] = rest;
    if (action === "build") {
      if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "firmware build accepts no additional arguments");
      return { status: runProgram("bin/qos-firmware-demo.js", ["build", "--home", context.runtime.home], context), exit: false };
    }
    const firmwareOptions = rest.slice(1);
    let confirmed = false;
    if (firmwareOptions.at(-1) === "--confirm-live") {
      confirmed = true;
      firmwareOptions.pop();
    }
    const [asset = "sol", amount, ...extra] = firmwareOptions;
    if (!["offline", "live", "broadcast"].includes(action) || !["sol", "token"].includes(asset)) {
      throw new QosError("INVALID_ARGUMENT", "Use firmware build, offline, live, or broadcast with asset sol or token");
    }
    if (extra.length) throw new QosError("INVALID_ARGUMENT", "Unexpected firmware arguments");
    if (action === "broadcast" && !confirmed) throw new QosError("LIVE_CONFIRMATION_REQUIRED", "firmware broadcast requires --confirm-live");
    if (action !== "broadcast" && confirmed) throw new QosError("INVALID_ARGUMENT", "--confirm-live is only valid with firmware broadcast");
    const args = ["run", "--home", context.runtime.home, "--asset", asset, ...firmwareAmountArgs(asset, amount)];
    if (action === "offline") args.push("--offline");
    if (action === "broadcast") args.push("--broadcast");
    return { status: runProgram("bin/qos-firmware-demo.js", args, context), exit: false };
  }
  if (command === "agent") {
    const [action, amount, ...options] = rest;
    if (action !== "dry-run" && action !== "broadcast") throw new QosError("INVALID_ARGUMENT", "Use agent dry-run or agent broadcast");
    canonicalAmount(amount, "agent token amount");
    let confirmed = false;
    const filtered = options.filter((option) => {
      if (option === "--confirm-live") {
        if (confirmed) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --confirm-live");
        confirmed = true;
        return false;
      }
      return true;
    });
    if (action === "broadcast" && !confirmed) throw new QosError("LIVE_CONFIRMATION_REQUIRED", "agent broadcast requires --confirm-live");
    if (action === "dry-run" && confirmed) throw new QosError("INVALID_ARGUMENT", "--confirm-live is only valid with agent broadcast");
    const args = ["--home", context.runtime.home, "--amount", amount, ...parseAgentOptions(filtered)];
    if (action === "broadcast") args.push("--broadcast", "--confirm-live");
    return {
      status: runProgram("bin/qos-agent-demo.js", args, context, action === "broadcast" ? { QOS_ENABLE_MAINNET_BROADCAST: "I_UNDERSTAND" } : {}),
      exit: false,
    };
  }
  if (command === "serve") {
    if (rest.length > 1) throw new QosError("INVALID_ARGUMENT", "serve accepts at most one port");
    const args = ["serve", ...(rest[0] ? ["--port", rest[0]] : [])];
    return { status: qos(args, context), exit: false };
  }
  if (command === "security-audit") {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "security-audit accepts no arguments");
    return { status: runProgram("bin/qos-agent-security-audit.js", [], context), exit: false };
  }
  throw new QosError("UNKNOWN_COMMAND", `Unknown qOS Shell command: ${command}`);
}

function contextFor(home) {
  if (typeof home !== "string") throw new QosError("MISSING_RUNTIME_PROFILE", "Use --home or QOS_HOME to select an installed qOS profile");
  const runtime = loadRuntimeProfile(resolve(home));
  const policy = loadPolicy(join(runtime.home, "policy.json"));
  return { runtime, policy };
}

async function main() {
  process.umask(0o077);
  const options = parseProcessArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.run !== null && expandAliases(options.run)[0] === "help") {
    process.stdout.write(usage());
    return;
  }
  const context = contextFor(options.home);
  if (options.run !== null) {
    const result = dispatch(options.run, context);
    process.exitCode = result.status;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new QosError("INTERACTIVE_TTY_REQUIRED", "Use --run for non-interactive qOS Shell commands");
  }

  process.stdout.write(`${BANNER}\n\n`);
  process.stdout.write(`Profile: ${context.runtime.profile} (${context.policy.cluster})\n`);
  process.stdout.write("Type help for commands. No transaction has been broadcast.\n");
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  terminal.setPrompt("qos> ");
  terminal.prompt();
  terminal.on("line", (line) => {
    try {
      const result = dispatch(parseLine(line), context);
      if (result.exit) {
        terminal.close();
        return;
      }
      if (result.status !== 0) process.stderr.write(`Command exited with status ${result.status}.\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
    }
    terminal.prompt();
  });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  process.exitCode = 1;
});
