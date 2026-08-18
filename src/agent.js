import { decodeBase58 } from "./base58.js";
import { assertQos } from "./errors.js";
import { createModelProviderProfile, requestModelCompletion } from "./model-provider.js";
import { parseUnsigned } from "./policy.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);
const MAX_REASON_LENGTH = 256;

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

function planFromContent(content, context) {
  let candidate = content.trim();
  const fenced = candidate.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu);
  if (fenced) candidate = fenced[1].trim();
  let rawPlan;
  try {
    rawPlan = JSON.parse(candidate);
  } catch {
    assertQos(false, "AGENT_MODEL_INVALID", "Model provider did not return a JSON proposal");
  }
  return normalizeAgentPlan(rawPlan, context);
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
  fetchImpl = globalThis.fetch,
}) {
  const endpoint = assertLoopbackModelUrl(url);
  const profile = createModelProviderProfile({
    id: "legacy-local",
    provider: "local",
    model,
    endpoint,
    credentialSha256: null,
  });
  const content = await requestModelCompletion({
    profile,
    system: "You output only the requested JSON object.",
    prompt: modelPrompt({ amount, destination, mint, decimals, maxAmount }),
    fetchImpl,
  });
  return planFromContent(content, { amount, destination, maxAmount });
}

/**
 * Ask an operator-configured local or commercial model provider for a proposal.
 * The provider receives public policy context only; credentials are added to
 * the HTTP request separately and never become part of the model prompt.
 */
export async function configuredModelAgentPlan({
  profile,
  credentialFile = undefined,
  amount,
  destination,
  mint,
  decimals,
  maxAmount,
  fetchImpl = globalThis.fetch,
}) {
  const content = await requestModelCompletion({
    profile,
    credentialFile,
    system: "You output only the requested JSON object.",
    prompt: modelPrompt({ amount, destination, mint, decimals, maxAmount }),
    fetchImpl,
  });
  return planFromContent(content, { amount, destination, maxAmount });
}
