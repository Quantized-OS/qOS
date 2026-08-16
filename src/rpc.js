import { assertQos, QosError } from "./errors.js";
import { TextDecoder } from "node:util";

const MAX_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readBoundedJson(response) {
  const contentType = response.headers.get("content-type");
  assertQos(
    typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType),
    "RPC_INVALID_CONTENT_TYPE",
    "Solana RPC response must use application/json",
  );
  const contentEncoding = response.headers.get("content-encoding");
  assertQos(contentEncoding === null || contentEncoding === "identity", "RPC_UNSUPPORTED_CONTENT_ENCODING", "Solana RPC response compression is not accepted");
  const contentLength = response.headers.get("content-length");
  let expectedLength;
  if (contentLength !== null) {
    assertQos(/^(0|[1-9][0-9]*)$/.test(contentLength), "RPC_INVALID_LENGTH", "Solana RPC returned an invalid Content-Length");
    assertQos(Number(contentLength) <= MAX_RPC_RESPONSE_BYTES, "RPC_RESPONSE_TOO_LARGE", "Solana RPC response exceeds 2 MiB");
    expectedLength = Number(contentLength);
  }
  assertQos(response.body !== null, "RPC_EMPTY_RESPONSE", "Solana RPC returned an empty response");
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_RPC_RESPONSE_BYTES) {
        bytes.fill(0);
        throw new QosError("RPC_RESPONSE_TOO_LARGE", "Solana RPC response exceeds 2 MiB");
      }
      chunks.push(bytes);
    }
    assertQos(expectedLength === undefined || length === expectedLength, "RPC_INVALID_LENGTH", "Solana RPC response length does not match Content-Length");
    const body = Buffer.concat(chunks);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      return JSON.parse(text);
    } finally {
      body.fill(0);
    }
  } catch (error) {
    if (error instanceof QosError) throw error;
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new QosError("RPC_INVALID_JSON", "Solana RPC returned invalid JSON");
    }
    throw new QosError("RPC_UNAVAILABLE", "Solana RPC response could not be read");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export class SolanaRpc {
  constructor(url, { timeoutMs = 10_000, commitment = "confirmed" } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.commitment = commitment;
    this.id = 0;
  }

  async call(method, params = []) {
    assertQos(this.id < Number.MAX_SAFE_INTEGER, "RPC_ID_EXHAUSTED", "Solana RPC request identifier space is exhausted");
    const id = ++this.id;
    let response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "accept": "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new QosError("RPC_UNAVAILABLE", "Solana RPC request failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      assertQos(false, "RPC_HTTP_ERROR", `Solana RPC returned HTTP ${response.status}`);
    }
    let payload;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    assertQos(payload && payload.jsonrpc === "2.0" && payload.id === id, "RPC_INVALID_RESPONSE", "Solana RPC response envelope is invalid");
    if (payload.error) {
      const rpcCode = Number.isSafeInteger(payload.error.code) ? payload.error.code : undefined;
      throw new QosError("RPC_ERROR", `Solana RPC ${method} failed`, rpcCode === undefined ? undefined : { rpcCode });
    }
    assertQos(Object.hasOwn(payload, "result"), "RPC_MISSING_RESULT", "Solana RPC response has no result");
    return payload.result;
  }

  getGenesisHash() {
    return this.call("getGenesisHash");
  }

  getBalance(address) {
    return this.call("getBalance", [address, { commitment: this.commitment }]);
  }

  async getAccountInfo(address) {
    const result = await this.call("getAccountInfo", [address, {
      commitment: this.commitment,
      encoding: "base64",
    }]);
    return result.value;
  }

  getSlot() {
    return this.call("getSlot", [{ commitment: this.commitment }]);
  }

  getLatestBlockhash() {
    return this.call("getLatestBlockhash", [{ commitment: this.commitment }]);
  }

  async isBlockhashValid(blockhash) {
    const result = await this.call("isBlockhashValid", [blockhash, { commitment: this.commitment }]);
    return result.value;
  }

  async getFeeForMessage(messageBase64) {
    const result = await this.call("getFeeForMessage", [messageBase64, { commitment: this.commitment }]);
    return result.value;
  }

  async simulateTransaction(transactionBase64) {
    const result = await this.call("simulateTransaction", [transactionBase64, {
      encoding: "base64",
      commitment: this.commitment,
      sigVerify: true,
      replaceRecentBlockhash: false,
    }]);
    return result.value;
  }

  sendTransaction(transactionBase64) {
    return this.call("sendTransaction", [transactionBase64, {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: this.commitment,
      maxRetries: 3,
    }]);
  }

  requestAirdrop(address, lamports) {
    return this.call("requestAirdrop", [address, Number(lamports), { commitment: this.commitment }]);
  }

  async confirmSignature(signature, { timeoutMs, recentBlockhash = undefined } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const statuses = await this.call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      assertQos(statuses && typeof statuses === "object" && Array.isArray(statuses.value) && statuses.value.length === 1, "RPC_INVALID_STATUS", "Solana RPC returned an invalid signature-status envelope");
      const status = statuses.value[0];
      if (status !== null && status !== undefined) {
        assertQos(status && typeof status === "object" && !Array.isArray(status), "RPC_INVALID_STATUS", "Solana RPC returned an invalid signature status");
        assertQos(Object.hasOwn(status, "err"), "RPC_INVALID_STATUS", "Solana RPC signature status omitted the transaction result");
        assertQos(Number.isSafeInteger(status.slot) && status.slot >= 0, "RPC_INVALID_STATUS", "Solana RPC signature status returned an invalid slot");
        assertQos([null, "processed", "confirmed", "finalized"].includes(status.confirmationStatus), "RPC_INVALID_STATUS", "Solana RPC returned an invalid confirmation status");
      }
      if (status && status.err !== null) {
        throw new QosError("TRANSACTION_FAILED", "Solana transaction failed", {
          slot: status.slot,
        });
      }
      const reachedCommitment = this.commitment === "finalized"
        ? status?.confirmationStatus === "finalized"
        : status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
      if (reachedCommitment) {
        return status;
      }
      if (recentBlockhash && !(await this.isBlockhashValid(recentBlockhash))) {
        throw new QosError("BLOCKHASH_EXPIRED", "Transaction blockhash expired before confirmation");
      }
      await sleep(750);
    }
    throw new QosError("CONFIRMATION_TIMEOUT", "Timed out waiting for Solana confirmation");
  }
}
