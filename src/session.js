import { assertQos } from "./errors.js";
import { parseUnsigned } from "./policy.js";

const WINDOW_MS = 60_000;

// Authorization state exists only for the lifetime of this process.
// It stores no intent, message, blockhash, signature, or account data.
export class EphemeralSession {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.activeNonces = new Set();
    this.recentAuthorizations = [];
    this.counter = 0n;
    this.lastClock = 0;
  }

  nextNonce() {
    this.counter += 1n;
    return this.counter.toString();
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
    const key = nonce.toString();
    assertQos(!this.activeNonces.has(key), "NONCE_IN_FLIGHT", "requestNonce is already being authorized in this process");
    this.activeNonces.add(key);
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
    };
  }

  dispose() {
    this.activeNonces.clear();
    this.recentAuthorizations.fill(0);
    this.recentAuthorizations.length = 0;
    this.counter = 0n;
    this.lastClock = 0;
  }
}
