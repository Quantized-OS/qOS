#!/usr/bin/env node

import { runAgentSecurityAnalysis } from "../src/agent-security.js";

process.umask(0o077);

function usage() {
  console.log(`qOS synthetic agent security analysis

Usage:
  qos security-audit

This command creates disposable synthetic qOS homes under /tmp, runs an
adversarial key-access probe, tests plaintext/encrypted/external signer
profiles, attacks agent proposal validation, and verifies the broadcast gate.
It never reads a user-supplied home, calls Solana RPC, or broadcasts a
transaction. Never modify the harness to point it at production keys.
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
} else if (args.length > 0) {
  process.stderr.write("Unknown argument. Use --help for usage.\n");
  process.exitCode = 2;
} else {
  runAgentSecurityAnalysis().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.result === "FAIL") process.exitCode = 2;
  }).catch(() => {
    process.stderr.write("qOS agent security analysis failed closed\n");
    process.exitCode = 2;
  });
}
