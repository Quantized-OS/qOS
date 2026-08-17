#!/usr/bin/env node
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";

if (process.argv[2] !== "--test-only" || typeof process.argv[3] !== "string") {
  process.stderr.write("This synthetic signer fixture requires --test-only and must never be used for custody.\n");
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (request.version !== 1 || request.operation !== "authorize-and-sign-qos-intent" || request.authorization?.version !== 1) {
  process.exit(2);
}
const privateKey = readFileSync(process.argv[3]);
const signature = sign(null, Buffer.from(request.messageBase64, "base64"), privateKey);
process.stdout.write(`${JSON.stringify({
  version: 1,
  publicKey: request.publicKey,
  signatureBase64: signature.toString("base64"),
})}\n`);
signature.fill(0);
privateKey.fill(0);
