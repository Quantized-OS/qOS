import { decodeBase58 } from "./base58.js";
import { assertQos } from "./errors.js";
import { parseUnsigned } from "./policy.js";
import { TextDecoder } from "node:util";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);
const MAX_REASON_LENGTH = 256;
const MAX_MODEL_CONTENT_LENGTH = 4096;
const MAX_MODEL_RESPONSE_BYTES = 64 * 1024;

function parseAmount(value, field) {
  const amount = parseUnsigned(String(value), 64, field);
  assertQos(amount > 0n, "AGENT_AMOUNT_INVALID", `${field} must be greater than zero`);
  return amount;
}

function assertAllowedDestination(destination, expectedDestination) {
  assertQos(typeof destination === "string", "AGENT_DESTINATION_INVALID", "Agent destination must be a string");
  assertQos(destination === expectedDestination, "AGENT_DESTINATION_FORBIDDEN", "Agent destination is not the policy destination");
  try {
    decodeBase58(destination, 32);
  } catch {
    assertQos(false, "AGENT_DESTINATION_INVALID", "Agent destination is not a valid Solana public key");
  }
}

function assertKnownPlanFields(plan) {
  const allowed = new Set(["action", "amount", "destination", "reason"]);
  for (const key of Object.keys(plan)) {
    assertQos(allowed.has(key), "AGENT_PLAN_INVALID", `Agent plan contains unsupported field: ${key}`);
  }
}

/**
 * Validate an agent proposal against the operator's exact transfer request and
 * the qOS policy boundary. This deliberately accepts only one action.
 */
export function normalizeAgentPlan(rawPlan, { amount, destination, maxAmount }) {
  assertQos(rawPlan && typeof rawPlan === "object" && !Array.isArray(rawPlan), "AGENT_PLAN_INVALID", "Agent plan must be a JSON object");
  assertKnownPlanFields(rawPlan);

  const requestedAmount = parseAmount(amount, "requested amount");
  const policyMaximum = parseAmount(maxAmount, "policy maximum");

  assertQos(rawPlan.action === "transfer_qos", "AGENT_ACTION_FORBIDDEN", "Agent may only request transfer_qos");
  const proposedAmount = parseAmount(rawPlan.amount, "agent amount");
  assertQos(proposedAmount === requestedAmount, "AGENT_AMOUNT_MISMATCH", "Agent amount does not match the operator request");
  assertQos(proposedAmount <= policyMaximum, "AGENT_AMOUNT_EXCEEDS_POLICY", "Agent amount exceeds the qOS policy maximum");
  assertAllowedDestination(rawPlan.destination, destination);

  const reason = rawPlan.reason ?? "agent-directed qOS transfer";
  assertQos(typeof reason === "string" && reason.length <= MAX_REASON_LENGTH, "AGENT_REASON_INVALID", "Agent reason is invalid");

  return {
    action: "transfer_qos",
    amount: proposedAmount.toString(),
    destination,
    reason,
  };
}

export function basicAgentPlan(context) {
  return normalizeAgentPlan({
    action: "transfer_qos",
    amount: String(context.amount),
    destination: context.destination,
    reason: "basic policy-aware demo agent",
  }, context);
}

function assertLoopbackModelUrl(modelUrl) {
  let parsed;
  try {
    parsed = new URL(modelUrl);
  } catch {
    assertQos(false, "AGENT_MODEL_URL_INVALID", "Agent model URL is invalid");
  }

  assertQos(parsed.protocol === "http:" || parsed.protocol === "https:", "AGENT_MODEL_URL_INVALID", "Agent model URL must use HTTP or HTTPS");
  assertQos(LOOPBACK_HOSTS.has(parsed.hostname), "AGENT_MODEL_REMOTE_FORBIDDEN", "Agent model must run on the local machine");
  assertQos(!parsed.username && !parsed.password && parsed.hash === "", "AGENT_MODEL_URL_INVALID", "Agent model URL must not contain credentials or a fragment");
  return parsed.toString();
}

async function readModelResponse(response) {
  const contentType = response.headers.get("content-type");
  assertQos(typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType), "AGENT_MODEL_INVALID", "Local agent model response must use application/json");
  const contentEncoding = response.headers.get("content-encoding");
  assertQos(contentEncoding === null || contentEncoding === "identity", "AGENT_MODEL_INVALID", "Compressed local agent model responses are not accepted");
  const declaredLength = response.headers.get("content-length");
  let expectedLength;
  if (declaredLength !== null) {
    assertQos(/^(0|[1-9][0-9]*)$/.test(declaredLength), "AGENT_MODEL_INVALID", "Local agent model returned an invalid Content-Length");
    assertQos(Number(declaredLength) <= MAX_MODEL_RESPONSE_BYTES, "AGENT_MODEL_RESPONSE_TOO_LARGE", "Local agent model response exceeds 64 KiB");
    expectedLength = Number(declaredLength);
  }
  assertQos(response.body !== null, "AGENT_MODEL_INVALID", "Local agent model returned an empty response");

  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_MODEL_RESPONSE_BYTES) {
        bytes.fill(0);
        assertQos(false, "AGENT_MODEL_RESPONSE_TOO_LARGE", "Local agent model response exceeds 64 KiB");
      }
      chunks.push(bytes);
    }
    assertQos(expectedLength === undefined || length === expectedLength, "AGENT_MODEL_INVALID", "Local agent model response length does not match Content-Length");
    const body = Buffer.concat(chunks);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      assertQos(false, "AGENT_MODEL_INVALID", "Local agent model returned invalid JSON");
    } finally {
      body.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function modelPrompt({ amount, destination, mint, decimals, maxAmount }) {
  return [
    "Return JSON only. You are a constrained qOS demo agent.",
    "The only permitted action is transfer_qos.",
    "Copy the requested amount and destination exactly; do not invent values.",
    "Do not request SOL, swaps, arbitrary instructions, or any other action.",
    JSON.stringify({
      action: "transfer_qos",
      requestedAmountBaseUnits: String(amount),
      allowedDestination: destination,
      pinnedMint: mint,
      decimals,
      maxAmountBaseUnits: String(maxAmount),
    }),
    'Required JSON shape: {"action":"transfer_qos","amount":"<base units>","destination":"<public key>","reason":"<short reason>"}',
  ].join("\n");
}

/**
 * Ask a local OpenAI-compatible endpoint for a proposal. Only public policy
 * context is sent; the qOS signer and key material never enter this request.
 */
export async function modelAgentPlan({
  url,
  model = "qwen2.5:3b",
  amount,
  destination,
  mint,
  decimals,
  maxAmount,
}) {
  const endpoint = assertLoopbackModelUrl(url);
  assertQos(typeof model === "string" && /^[a-zA-Z0-9._:/-]{1,128}$/.test(model), "AGENT_MODEL_INVALID", "Agent model name is invalid");

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 256,
        messages: [
          { role: "system", content: "You output only the requested JSON object." },
          { role: "user", content: modelPrompt({ amount, destination, mint, decimals, maxAmount }) },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    assertQos(false, "AGENT_MODEL_UNAVAILABLE", "Local agent model could not be reached");
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    assertQos(false, "AGENT_MODEL_UNAVAILABLE", `Local agent model returned HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await readModelResponse(response);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }

  const content = payload?.choices?.[0]?.message?.content;
  assertQos(typeof content === "string" && content.length > 0 && content.length <= MAX_MODEL_CONTENT_LENGTH, "AGENT_MODEL_INVALID", "Local agent model returned no usable proposal");

  let rawPlan;
  try {
    rawPlan = JSON.parse(content);
  } catch {
    assertQos(false, "AGENT_MODEL_INVALID", "Local agent model did not return a JSON proposal");
  }

  return normalizeAgentPlan(rawPlan, { amount, destination, maxAmount });
}
