#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { publicError, QosError } from "../src/errors.js";
import { formatHuman } from "../src/human-output.js";
import { loadPolicy } from "../src/policy.js";
import { loadRuntimeProfile } from "../src/runtime-profile.js";
import { QosService } from "../src/service.js";

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
  ["mod", "model"],
  ["llm", "model"],
  ["wal", "wallet"],
  ["pol", "policy"],
  ["prof", "profile"],
  ["priv", "privacy"],
  ["sub", "submit"],
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
const AGENT_ACTION_ALIASES = new Map([
  ["dry", "dry-run"], ["cast", "broadcast"], ["on", "onboard"],
  ["ls", "list"], ["off", "offboard"], ["skill", "skills"],
  ["req", "requests"], ["ok", "approve"], ["no", "reject"],
  ["up", "start"], ["st", "status"], ["down", "stop"], ["re", "restart"],
]);
const MODEL_ACTION_ALIASES = new Map([
  ["on", "onboard"], ["cat", "catalog"], ["ls", "list"],
  ["cfg", "configure"], ["def", "default"], ["set", "use"],
  ["rot", "rotate"], ["rm", "remove"],
]);
const DEX_ACTION_ALIASES = new Map([["st", "status"], ["cfg", "configure"], ["s", "swap"]]);
const ASSET_ALIASES = new Map([["s", "sol"], ["tok", "token"], ["t", "token"]]);

function usage() {
  return `${BANNER}

qOS command shell

Usage:
  qos [-H|--home PATH] [-j|--json]
  qos [-H|--home PATH] [-j|--json] [-r|--run] COMMAND [ARGUMENTS...]

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
  wallet | wal status                         wallet | wal fund [LAMPORTS]
  policy | pol show|edit
  policy | pol set FIELD VALUE [--confirm-policy-change]
  policy | pol destination|strategy add|remove VALUE [--confirm-policy-change]
  profile | prof                              privacy | priv
  submit | sub INTENT_FILE --confirm-broadcast [--proof PROOF_FILE]
  agent | ag                                  list managed agents and next steps
  agent | ag onboard|on [onboarding flags]    agent | ag list|ls
  agent | ag show|skills|offboard ID           agent | ag status|st
  agent | ag start|up                          agent | ag stop|down
  agent | ag restart|re [--confirm-live]
  agent | ag requests|req                      agent | ag approve|ok REQUEST_ID
  agent | ag reject|no REQUEST_ID
  model | mod onboard|on                       guided local/BYOK model setup
  model | mod catalog|cat                      model | mod list|ls
  model | mod default|def                      model | mod use|set ID
  model | mod configure|cfg ID [options]       model | mod rotate|rot ID
  model | mod show ID                          model | mod remove|rm ID --yes
  agent | ag demo dry-run|dry AMOUNT [-a basic|model] [-p PROFILE]
  agent | ag demo broadcast|cast AMOUNT --confirm-live [demo options]
  serve [agent|api|mcp] [PORT] | api [PORT]
  serve core [PORT]                           security-audit | audit
  trade | tr status|st
  trade | tr configure|cfg [--api-key-file FILE] [--venues jupiter,raydium]
            [--max-input-amount N] [--daily-input-limit N]
            [advanced policy options]
  trade | tr swap|s AMOUNT [--venue jupiter|raydium] --input-mint PUBKEY
            --output-mint PUBKEY --confirm-live [--strategy-id N]
  help | h | ?           exit | x | q

The shell never executes arbitrary shell text. Broadcast commands require the
listed confirmation option and remain constrained by the qOS policy signer.
qos is the only installed command; every operator feature is grouped here.
DEX trading uses reviewed Jupiter and Raydium adapters and accepts any verified
Solana token pair while rejecting arbitrary programs, transactions, and out-of-policy spend.
`;
}

function parseProcessArgs(argv) {
  let home = process.env.QOS_HOME;
  let run = null;
  let homeSeen = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") return { help: true, home, run, json };
    if (token === "-H" || token === "--home") {
      if (homeSeen) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --home");
      homeSeen = true;
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", "--home requires a path");
      home = value;
      continue;
    }
    if (token === "-j" || token === "--json") {
      if (json) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --json");
      json = true;
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
  return { help: false, home, run, json };
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
    if (expanded[1] === "demo" && expanded[2] !== undefined) {
      expanded[2] = AGENT_ACTION_ALIASES.get(expanded[2]) ?? expanded[2];
    } else {
      expanded[1] = AGENT_ACTION_ALIASES.get(expanded[1]) ?? expanded[1];
    }
  } else if (expanded[0] === "model" && expanded[1] !== undefined) {
    expanded[1] = MODEL_ACTION_ALIASES.get(expanded[1]) ?? expanded[1];
  } else if (expanded[0] === "trade" && expanded[1] !== undefined) {
    expanded[1] = DEX_ACTION_ALIASES.get(expanded[1]) ?? expanded[1];
  }
  return expanded;
}

function runProgram(script, args, context, extraEnvironment = {}, { captureJson = false } = {}) {
  const environment = {
    ...process.env,
    QOS_HOME: context.runtime.home,
    QOS_API_TOKEN_FILE: context.runtime.apiTokenFile,
    QOS_CALLER_CWD: context.cwd,
    ...(context.runtime.signerCommand === null ? {} : { QOS_SIGNER_COMMAND: context.runtime.signerCommand }),
    ...extraEnvironment,
  };
  const result = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    env: environment,
    ...(captureJson ? { encoding: "utf8" } : { stdio: "inherit" }),
    shell: false,
  });
  if (result.error) throw new QosError("COMMAND_FAILED", `Could not start ${script}`);
  if (captureJson) {
    if ((result.status ?? 1) !== 0) {
      try {
        const failure = JSON.parse(result.stderr);
        throw new QosError(failure.error.code, failure.error.message, failure.error.details);
      } catch (error) {
        if (error instanceof QosError) throw error;
        throw new QosError("COMMAND_FAILED", `${script} exited with status ${result.status ?? 1}`);
      }
    }
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new QosError("COMMAND_OUTPUT_INVALID", `${script} returned invalid JSON`);
    }
    process.stdout.write(context.json ? `${JSON.stringify(value, null, 2)}\n` : formatHuman(value));
  }
  return result.status ?? 1;
}

function qos(args, context, extraEnvironment = {}) {
  return runProgram("bin/qos.js", [args[0], "--home", context.runtime.home, ...args.slice(1)], context, extraEnvironment, { captureJson: true });
}

function capabilitiesFor(context) {
  const tokenEnabled = context.policy.tokenTransfer !== null;
  const nativeEnabled = BigInt(context.policy.maxTransferLamports) > 0n;
  const insecureMainnet = context.runtime.profile === "mainnet-insecure";
  return {
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
      "inline-policy-edit",
      "source-wallet-readiness",
      "agent-onboard-offboard",
      "agent-ask-or-auto-execution",
      ...(nativeEnabled ? ["native-sol-intent", "native-sol-transfer"] : []),
      ...(tokenEnabled ? ["qos-token-intent", "qos-token-transfer", "agent-directed-qos-token-transfer"] : []),
      ...(context.runtime.profile === "devnet" ? ["qemu-firmware-rehearsal"] : []),
      "loopback-agent-api-mcp",
      "loopback-core-api",
      "byok-model-providers",
      ...(context.policy.dexTrading === null ? [] : ["reviewed-multivenue-dex-swap", "agent-directed-solana-token-swap"]),
    ],
    mainnetAutomaticExecutionRequiresLiveStart: context.policy.cluster === "mainnet-beta",
    dexTrading: context.policy.dexTrading !== null,
    dexReason: context.policy.dexTrading === null
      ? "DEX trading is available but not configured for this profile."
      : "Jupiter and Raydium swaps are constrained by the configured token scope and advanced firmware policy limits.",
  };
}

function printCapabilities(context) {
  const capabilities = capabilitiesFor(context);
  process.stdout.write(context.json ? `${JSON.stringify(capabilities, null, 2)}\n` : formatHuman(capabilities, { title: "qOS capabilities" }));
}

function parseAgentOptions(tokens) {
  const options = [];
  const allowed = new Set(["--agent", "--model-profile", "--model-url", "--model"]);
  const aliases = new Map([["-a", "--agent"], ["-p", "--model-profile"], ["-u", "--model-url"], ["-m", "--model"]]);
  for (let index = 0; index < tokens.length; index += 1) {
    const option = aliases.get(tokens[index]) ?? tokens[index];
    if (!allowed.has(option)) throw new QosError("INVALID_ARGUMENT", `Unknown agent option: ${option}`);
    const value = tokens[++index];
    if (!value || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", `${option} requires a value`);
    options.push(option, value);
  }
  return options;
}

function printAgentGuide() {
  process.stdout.write(`Managed-agent workflow
----------------------
1. Run: wal status
2. Resolve every displayed wallet blocker.
3. Run: ag on
4. qOS starts the authenticated REST + MCP service automatically.
5. Check it: ag st  (MCP is http://127.0.0.1:8790/mcp)
6. For ask mode: ag req, ag ok REQUEST_ID, or ag no REQUEST_ID
7. Mainnet live mode: ag re --confirm-live
8. Revoke access: ag off AGENT_ID

Model setup: mod on  (choose local inference or a commercial BYOK provider)
The synthetic proposal demo is separate: ag demo dry AMOUNT
Live demo submission requires: ag demo cast AMOUNT --confirm-live
`);
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
    const [action = "status", ...args] = rest;
    if (action === "status") {
      if (args.length) throw new QosError("INVALID_ARGUMENT", "trade status accepts no arguments");
      return { status: qos(["dex-status"], context), exit: false };
    }
    if (action === "configure") {
      const allowed = new Set(["--api-key-file", "--venues", "--max-input-amount", "--daily-input-limit", "--receiver", "--max-slippage-bps", "--max-route-fee-bps", "--max-fee-lamports", "--min-interval-seconds", "--max-swaps-per-day"]);
      const required = new Set();
      const seen = new Set();
      const forwarded = [];
      for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (!allowed.has(option)) throw new QosError("INVALID_ARGUMENT", `Unknown trade configure option: ${option}`);
        if (seen.has(option)) throw new QosError("DUPLICATE_ARGUMENT", `Duplicate ${option}`);
        seen.add(option);
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", `${option} requires a value`);
        forwarded.push(option, option === "--api-key-file" ? resolve(context.cwd, value) : value);
      }
      for (const option of required) if (!seen.has(option)) throw new QosError("MISSING_ARGUMENT", `${option} is required`);
      const status = qos(["dex-configure", ...forwarded], context);
      if (status === 0) context.policy = loadPolicy(join(context.runtime.home, "policy.json"));
      return { status, exit: false };
    }
    if (action === "swap") {
      const amount = canonicalAmount(args[0], "DEX input amount");
      const allowed = new Set(["--venue", "--input-mint", "--output-mint", "--strategy-id"]);
      const required = new Set(["--input-mint", "--output-mint"]);
      const seen = new Set();
      const forwarded = [];
      let confirmed = false;
      for (let index = 1; index < args.length; index += 1) {
        const option = args[index];
        if (option === "--confirm-live") {
          if (confirmed) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --confirm-live");
          confirmed = true;
          continue;
        }
        if (!allowed.has(option)) throw new QosError("INVALID_ARGUMENT", `Unknown trade swap option: ${option}`);
        if (seen.has(option)) throw new QosError("DUPLICATE_ARGUMENT", `Duplicate ${option}`);
        seen.add(option);
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new QosError("MISSING_ARGUMENT", `${option} requires a value`);
        forwarded.push(option, value);
      }
      for (const option of required) if (!seen.has(option)) throw new QosError("MISSING_ARGUMENT", `${option} is required`);
      if (!confirmed) throw new QosError("LIVE_CONFIRMATION_REQUIRED", "trade swap requires --confirm-live");
      return { status: qos(["dex-swap", "--amount", amount, ...forwarded], context, { QOS_ENABLE_MAINNET_BROADCAST: "I_UNDERSTAND" }), exit: false };
    }
    throw new QosError("INVALID_ARGUMENT", "Use trade status, trade configure, or trade swap");
  }
  if (command === "status") {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "status accepts no arguments");
    if (context.runtime.signerCommand !== null) process.env.QOS_SIGNER_COMMAND = context.runtime.signerCommand;
    const service = QosService.open(context.runtime.home);
    const status = {
      capabilities: capabilitiesFor(context),
      address: { signer: service.publicKey, cluster: context.policy.cluster },
      privacy: service.privacyStatus(),
    };
    process.stdout.write(context.json ? `${JSON.stringify(status, null, 2)}\n` : formatHuman(status, { title: "qOS status" }));
    return { status: 0, exit: false };
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
  if (command === "wallet") {
    const [action = "status", amount, ...extra] = rest;
    if (action === "status" || action === "check") {
      if (amount !== undefined || extra.length) throw new QosError("INVALID_ARGUMENT", "wallet status accepts no arguments");
      return {
        status: runProgram("bin/qos-wallet.js", ["--home", context.runtime.home, ...(context.json ? ["--json"] : []), "status"], context),
        exit: false,
      };
    }
    if (action === "fund" || action === "fund-devnet") {
      if (extra.length) throw new QosError("INVALID_ARGUMENT", "wallet fund accepts at most one lamport amount");
      return {
        status: runProgram("bin/qos-wallet.js", [
          "--home", context.runtime.home,
          ...(context.json ? ["--json"] : []),
          "fund-devnet",
          ...(amount === undefined ? [] : ["--lamports", canonicalAmount(amount, "airdrop lamports")]),
        ], context),
        exit: false,
      };
    }
    throw new QosError("INVALID_ARGUMENT", "Use wallet status or wallet fund");
  }
  if (command === "profile") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "show")) throw new QosError("INVALID_ARGUMENT", "profile accepts no arguments or show");
    return {
      status: runProgram("bin/qos-profile.js", ["show", "--home", context.runtime.home], context, {}, { captureJson: true }),
      exit: false,
    };
  }
  if (command === "privacy") {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "privacy accepts no arguments");
    return { status: qos(["privacy-status"], context), exit: false };
  }
  if (command === "policy") {
    const args = ["--home", context.runtime.home, ...(context.json ? ["--json"] : []), ...(rest.length ? rest : ["show"])];
    const status = runProgram("bin/qos-policy.js", args, context);
    if (status === 0) context.policy = loadPolicy(join(context.runtime.home, "policy.json"));
    return { status, exit: false };
  }
  if (command === "model") {
    const args = ["--home", context.runtime.home, ...(context.json ? ["--json"] : []), ...(rest.length ? rest : ["list"])];
    return { status: runProgram("bin/qos-model.js", args, context), exit: false };
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
  if (command === "submit") {
    const [intentFile, ...options] = rest;
    if (typeof intentFile !== "string" || intentFile.startsWith("--")) throw new QosError("MISSING_ARGUMENT", "submit requires an intent file");
    let confirmed = false;
    let proofFile;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option === "--confirm-broadcast") {
        if (confirmed) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --confirm-broadcast");
        confirmed = true;
      } else if (option === "--proof") {
        if (proofFile !== undefined) throw new QosError("DUPLICATE_ARGUMENT", "Duplicate --proof");
        proofFile = options[++index];
        if (!proofFile || proofFile.startsWith("--")) throw new QosError("MISSING_ARGUMENT", "--proof requires a file");
      } else {
        throw new QosError("INVALID_ARGUMENT", `Unknown submit option: ${option}`);
      }
    }
    if (!confirmed) throw new QosError("BROADCAST_CONFIRMATION_REQUIRED", "submit requires --confirm-broadcast");
    return {
      status: qos([
        "submit",
        "--intent", resolve(context.cwd, intentFile),
        ...(proofFile === undefined ? [] : ["--proof", resolve(context.cwd, proofFile)]),
      ], context, { QOS_ENABLE_MAINNET_BROADCAST: "I_UNDERSTAND" }),
      exit: false,
    };
  }
  if (command === "firmware") {
    const [action] = rest;
    if (action === "build") {
      if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "firmware build accepts no additional arguments");
      return { status: runProgram("bin/qos-firmware-demo.js", ["build", "--home", context.runtime.home], context, {}, { captureJson: true }), exit: false };
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
    const lifecycleActions = new Set(["onboard", "list", "show", "skills", "offboard", "start", "status", "stop", "restart", "listen", "requests", "approve", "reject"]);
    if (rest.length === 0) {
      const status = runProgram("bin/qos-agent-control.js", ["--home", context.runtime.home, ...(context.json ? ["--json"] : []), "list"], context);
      if (!context.json && status === 0) printAgentGuide();
      return { status, exit: false };
    }
    if (rest[0] === "help") {
      if (rest.length !== 1) throw new QosError("INVALID_ARGUMENT", "agent help accepts no arguments");
      printAgentGuide();
      return { status: 0, exit: false };
    }
    if (lifecycleActions.has(rest[0])) {
      const args = ["--home", context.runtime.home, ...(context.json ? ["--json"] : []), ...rest];
      return { status: runProgram("bin/qos-agent-control.js", args, context), exit: false };
    }
    if (["dry-run", "broadcast"].includes(rest[0])) {
      throw new QosError("AGENT_DEMO_NAMESPACE_REQUIRED", `Use agent demo ${rest[0]} so a synthetic demo cannot be mistaken for a managed agent`);
    }
    if (rest[0] !== "demo") {
      throw new QosError("INVALID_ARGUMENT", "Use agent, agent onboard, agent listen, agent requests, agent offboard, or agent demo");
    }
    const [action, amount, ...options] = rest.slice(1);
    if (action !== "dry-run" && action !== "broadcast") throw new QosError("INVALID_ARGUMENT", "Use agent demo dry-run or agent demo broadcast");
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
    const args = ["--home", context.runtime.home, "--amount", amount, ...(context.json ? ["--json"] : []), ...parseAgentOptions(filtered)];
    if (action === "broadcast") args.push("--broadcast", "--confirm-live");
    return {
      status: runProgram("bin/qos-agent-demo.js", args, context, action === "broadcast" ? { QOS_ENABLE_MAINNET_BROADCAST: "I_UNDERSTAND" } : {}),
      exit: false,
    };
  }
  if (command === "serve") {
    const namespace = ["agent", "api", "mcp", "core"].includes(rest[0]) ? rest[0] : "agent";
    const serveArguments = namespace === "agent" && !["agent", "api", "mcp"].includes(rest[0]) ? rest : rest.slice(1);
    if (serveArguments.length > 1) throw new QosError("INVALID_ARGUMENT", "Use serve, serve PORT, serve agent PORT, serve mcp PORT, or serve core PORT");
    const port = serveArguments[0];
    if (port !== undefined && (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)) {
      throw new QosError("INVALID_PORT", "API port must be a canonical integer between 1 and 65535");
    }
    if (namespace === "core") {
      return {
        status: runProgram("bin/qos.js", [
          "serve", "--home", context.runtime.home,
          ...(port ? ["--port", port] : []),
        ], context, { QOS_HUMAN_OUTPUT: "1" }),
        exit: false,
      };
    }
    const args = ["--home", context.runtime.home, ...(context.json ? ["--json"] : []), "start", ...(port ? ["--port", port] : [])];
    return {
      status: runProgram("bin/qos-agent-control.js", args, context),
      exit: false,
    };
  }
  if (command === "security-audit") {
    if (rest.length) throw new QosError("INVALID_ARGUMENT", "security-audit accepts no arguments");
    return { status: runProgram("bin/qos-agent-security-audit.js", [], context), exit: false };
  }
  throw new QosError("UNKNOWN_COMMAND", `Unknown qOS Shell command: ${command}`);
}

function contextFor(home, json = false) {
  if (typeof home !== "string") throw new QosError("MISSING_RUNTIME_PROFILE", "Use --home or QOS_HOME to select an installed qOS profile");
  const runtime = loadRuntimeProfile(resolve(home));
  const policy = loadPolicy(join(runtime.home, "policy.json"));
  return { runtime, policy, json, cwd: process.cwd() };
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
  const context = contextFor(options.home, options.json);
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
  process.stdout.write("Type help for commands. No asset transfer has been broadcast in this shell.\n");
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
      if (context.json) process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
      else process.stderr.write(`qOS error [${error?.code ?? "INTERNAL_ERROR"}]: ${error instanceof QosError ? error.message : "The request failed closed"}\n`);
    }
    terminal.prompt();
  });
}

main().catch((error) => {
  if (process.argv.includes("--json") || process.argv.includes("-j")) process.stderr.write(`${JSON.stringify(publicError(error), null, 2)}\n`);
  else process.stderr.write(`qOS error [${error?.code ?? "INTERNAL_ERROR"}]: ${error instanceof QosError ? error.message : "The request failed closed"}\n`);
  process.exitCode = 1;
});
