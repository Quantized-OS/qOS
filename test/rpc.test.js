import test from "node:test";
import assert from "node:assert/strict";
import { SolanaRpc } from "../src/rpc.js";

test("RPC client emits canonical JSON-RPC requests and validates the envelope", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, options, request });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "genesis" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  assert.equal(await rpc.getGenesisHash(), "genesis");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.method, "getGenesisHash");
  assert.deepEqual(requests[0].request.params, []);
  assert.equal(requests[0].options.headers["content-type"], "application/json");
  assert.equal(requests[0].options.redirect, "error");
});

test("RPC client fails closed on JSON-RPC errors", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32002, message: "simulation failed", data: { logs: ["no"] } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  await assert.rejects(() => rpc.sendTransaction("AA=="), { code: "RPC_ERROR" });
});

test("RPC errors do not reflect untrusted provider messages", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const secretProviderMessage = "provider-internal\n" + "x".repeat(100_000);
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32099, message: secretProviderMessage },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  await assert.rejects(
    () => rpc.sendTransaction("AA=="),
    (error) => error.code === "RPC_ERROR"
      && error.message === "Solana RPC sendTransaction failed"
      && error.details.rpcCode === -32099
      && !error.message.includes("provider-internal"),
  );
});

test("RPC client rejects oversized responses before parsing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
  });
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  await assert.rejects(() => rpc.getGenesisHash(), { code: "RPC_RESPONSE_TOO_LARGE" });
});

test("RPC client rejects a non-JSON response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("not json", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  await assert.rejects(() => rpc.getGenesisHash(), { code: "RPC_INVALID_CONTENT_TYPE" });
});

test("RPC client rejects compressed or length-mismatched JSON", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
  });
  await assert.rejects(() => rpc.getGenesisHash(), { code: "RPC_UNSUPPORTED_CONTENT_ENCODING" });
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "3" },
  });
  await assert.rejects(() => rpc.getGenesisHash(), { code: "RPC_INVALID_LENGTH" });
});

test("RPC confirmation waits for the configured finalized commitment", async () => {
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000, commitment: "finalized" });
  const statuses = [
    { slot: 10, confirmationStatus: "confirmed", err: null },
    { slot: 11, confirmationStatus: "finalized", err: null },
  ];
  let calls = 0;
  rpc.call = async () => ({ value: [statuses[calls++]] });
  const status = await rpc.confirmSignature("signature", { timeoutMs: 2000 });
  assert.equal(calls, 2);
  assert.equal(status.confirmationStatus, "finalized");

  const invalid = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  invalid.call = async () => ({ value: [{ slot: -1, confirmationStatus: "finalized" }] });
  await assert.rejects(
    () => invalid.confirmSignature("signature", { timeoutMs: 2000 }),
    { code: "RPC_INVALID_STATUS" },
  );
});
