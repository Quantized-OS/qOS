import { createHmac, randomBytes } from "node:crypto";
import { assertQos } from "./errors.js";
import { parseUnsigned } from "./policy.js";

const WINDOW_MS = 60_000;
const MAX_REMEMBERED_NONCES = 1_000_000;

// Authorization state exists only for the lifetime of this process.
// It stores no intent, message, blockhash, signature, or account data.
export class EphemeralSession {
  constructor({ clock = () => Date.now(), nonceSource = () => randomBytes(16) } = {}) {
    this.clock = clock;
    this.nonceSource = nonceSource;
    this.activeNonces = new Set();
    this.usedNonces = new Set();
    this.recentAuthorizations = [];
    this.commitmentKey = randomBytes(32);
    this.lastClock = 0;
  }

  nextNonce() {
    const bytes = Buffer.from(this.nonceSource());
    try {
      assertQos(bytes.length === 16, "INVALID_NONCE_SOURCE", "Nonce source must return exactly 16 bytes");
      const nonce = bytes.readBigUInt64BE(0) << 64n | bytes.readBigUInt64BE(8);
      return (nonce === 0n ? 1n : nonce).toString();
    } finally {
      bytes.fill(0);
    }
  }

  nonceCommitment(nonce) {
    return createHmac("sha256", this.commitmentKey)
      .update("qos-nonce-v1\0", "utf8")
      .update(nonce.toString(), "ascii")
      .digest("base64url");
  }

  begin(requestNonce, maxRequestsPerMinute) {
    const nonce = parseUnsigned(requestNonce, 128, "requestNonce");
    assertQos(nonce > 0n, "INVALID_NONCE", "requestNonce must be greater than zero");
    assertQos(
      Number.isInteger(maxRequestsPerMinute) && maxRequestsPerMinute > 0,
      "INVALID_RATE_LIMIT",
      "maxRequestsPerMinute must be a positive integer",
    );
    const now = this.clock();
    assertQos(Number.isSafeInteger(now) && now >= this.lastClock, "SESSION_TIME_ROLLBACK", "Session clock moved backwards");
    this.lastClock = now;
    this.recentAuthorizations = this.recentAuthorizations.filter((timestamp) => timestamp > now - WINDOW_MS);
    assertQos(this.recentAuthorizations.length < maxRequestsPerMinute, "RATE_LIMITED", "Signer request rate limit exceeded");
    const key = this.nonceCommitment(nonce);
    assertQos(!this.activeNonces.has(key), "NONCE_IN_FLIGHT", "requestNonce is already being authorized in this process");
    assertQos(!this.usedNonces.has(key), "NONCE_REPLAY", "requestNonce was already used in this process");
    assertQos(this.usedNonces.size < MAX_REMEMBERED_NONCES, "NONCE_MEMORY_EXHAUSTED", "Nonce replay memory is full; restart into a measured signer state");
    this.activeNonces.add(key);
    this.usedNonces.add(key);
    this.recentAuthorizations.push(now);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeNonces.delete(key);
    };
  }

  status() {
    return {
      retention: "ephemeral-memory",
      activeAuthorizations: this.activeNonces.size,
      recentAuthorizationCount: this.recentAuthorizations.length,
      rememberedNonceCommitments: this.usedNonces.size,
    };
  }

  dispose() {
    this.activeNonces.clear();
    this.usedNonces.clear();
    this.recentAuthorizations.fill(0);
    this.recentAuthorizations.length = 0;
    this.commitmentKey.fill(0);
    this.commitmentKey = randomBytes(32);
    this.lastClock = 0;
  }
}
