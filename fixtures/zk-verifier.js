#!/usr/bin/env node
import { sha256Canonical } from "../src/zk.js";

if (process.argv[2] !== "--test-only") {
  process.stderr.write("This synthetic verifier fixture requires --test-only and does not verify production proofs.\n");
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(`${JSON.stringify({
  version: 1,
  valid: request.proof?.testOnlyAccept === true,
  requestDigest: sha256Canonical(request, "qos-snark-request-v1"),
})}\n`);
