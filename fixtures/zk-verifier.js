#!/usr/bin/env node
import { sha256Canonical } from "../src/zk.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(`${JSON.stringify({
  version: 1,
  valid: request.proof?.testOnlyAccept === true,
  requestDigest: sha256Canonical(request, "qos-snark-request-v1"),
})}\n`);
