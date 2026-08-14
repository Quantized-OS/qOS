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
    }), { status: 200 });
  };
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  await assert.rejects(() => rpc.sendTransaction("AA=="), { code: "RPC_ERROR" });
});

test("RPC client rejects oversized responses before parsing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-length": String(2 * 1024 * 1024 + 1) },
  });
  const rpc = new SolanaRpc("https://example.invalid", { timeoutMs: 1000 });
  await assert.rejects(() => rpc.getGenesisHash(), { code: "RPC_RESPONSE_TOO_LARGE" });
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
});
