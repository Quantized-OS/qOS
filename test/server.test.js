import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

test("plaintext HTTP service always refuses a non-loopback bind", () => {
  assert.throws(
    () => startServer({}, { host: "0.0.0.0", port: 8787, apiToken: undefined }),
    { code: "LOOPBACK_REQUIRED" },
  );
  assert.throws(
    () => startServer({}, { host: "0.0.0.0", port: 8787, apiToken: "a".repeat(64) }),
    { code: "LOOPBACK_REQUIRED" },
  );
});

test("configured loopback API tokens must contain at least 32 bytes", () => {
  assert.throws(
    () => startServer({}, { host: "127.0.0.1", port: 8787, apiToken: undefined }),
    { code: "API_TOKEN_REQUIRED" },
  );
  assert.throws(
    () => startServer({}, { host: "127.0.0.1", port: 8787, apiToken: "too-short" }),
    { code: "API_TOKEN_TOO_SHORT" },
  );
});
