#!/usr/bin/env node
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (request.version !== 1 || request.operation !== "sign-solana-message" || request.authorization?.version !== 1) {
  process.exit(2);
}
const privateKey = readFileSync(process.argv[2]);
const signature = sign(null, Buffer.from(request.messageBase64, "base64"), privateKey);
process.stdout.write(`${JSON.stringify({
  version: 1,
  publicKey: request.publicKey,
  signatureBase64: signature.toString("base64"),
})}\n`);
signature.fill(0);
privateKey.fill(0);
