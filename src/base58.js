import { assertQos } from "./errors.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const LOOKUP = new Map([...ALPHABET].map((character, index) => [character, index]));

export function encodeBase58(input) {
  const bytes = Buffer.from(input);
  if (bytes.length === 0) return "";

  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = ALPHABET[remainder] + encoded;
  }
  return "1".repeat(zeroes) + encoded;
}

export function decodeBase58(text, expectedLength = undefined) {
  assertQos(typeof text === "string" && text.length > 0, "INVALID_BASE58", "Expected a non-empty base58 string");
  let value = 0n;
  for (const character of text) {
    const digit = LOOKUP.get(character);
    assertQos(digit !== undefined, "INVALID_BASE58", "Value contains a non-base58 character");
    value = value * 58n + BigInt(digit);
  }

  const output = [];
  while (value > 0n) {
    output.push(Number(value & 0xffn));
    value >>= 8n;
  }
  output.reverse();

  let zeroes = 0;
  while (zeroes < text.length && text[zeroes] === "1") zeroes += 1;
  const decoded = Buffer.concat([Buffer.alloc(zeroes), Buffer.from(output)]);
  assertQos(encodeBase58(decoded) === text, "NON_CANONICAL_BASE58", "Base58 value is not canonical");
  if (expectedLength !== undefined) {
    assertQos(decoded.length === expectedLength, "INVALID_BASE58_LENGTH", `Expected ${expectedLength} decoded bytes`);
  }
  return decoded;
}
