import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

test("HTTP service refuses a non-loopback bind without a strong token", () => {
  assert.throws(
    () => startServer({}, { host: "0.0.0.0", port: 8787, apiToken: undefined }),
    { code: "API_TOKEN_REQUIRED" },
  );
  assert.throws(
    () => startServer({}, { host: "0.0.0.0", port: 8787, apiToken: "too-short" }),
    { code: "API_TOKEN_REQUIRED" },
  );
});
