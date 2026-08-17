import { join, resolve } from "node:path";

import { decodeBase58 } from "./base58.js";
import { assertQos } from "./errors.js";
import { loadPolicy, parseUnsigned, validatePolicy } from "./policy.js";
import { writePrivateJsonAtomic } from "./private-json.js";
import { loadRuntimeProfile } from "./runtime-profile.js";
import { policyCommitment } from "./zk.js";

export const EDITABLE_POLICY_FIELDS = Object.freeze([
  "max-sol-lamports",
  "max-token-amount",
  "max-fee-lamports",
  "rate-limit",
  "ttl-slots",
  "commitment",
  "rpc-url",
]);

function clonePolicy(policy) {
  return JSON.parse(JSON.stringify(policy));
}

function parseBoundedInteger(value, field, minimum, maximum) {
  assertQos(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "INVALID_POLICY_VALUE", `${field} must be a canonical integer`);
  const number = Number(value);
  assertQos(Number.isSafeInteger(number) && number >= minimum && number <= maximum, "INVALID_POLICY_VALUE", `${field} must be between ${minimum} and ${maximum}`);
  return number;
}

function policyResult(home, policy, changed) {
  const runtime = loadRuntimeProfile(home);
  return {
    changed,
    profile: runtime.profile,
    cluster: policy.cluster,
    policyFile: join(home, "policy.json"),
    policyCommitment: policyCommitment(policy),
    externalSignerPolicySyncRequired: changed && runtime.profile === "mainnet-external",
    policy,
  };
}

export function showEditablePolicy(home) {
  const resolvedHome = resolve(home);
  const policy = loadPolicy(join(resolvedHome, "policy.json"));
  return policyResult(resolvedHome, policy, false);
}

function commitPolicy(home, next) {
  const validated = validatePolicy(next);
  writePrivateJsonAtomic(join(home, "policy.json"), validated, {
    errorCode: "POLICY_UPDATE_FAILED",
    label: "Policy file",
  });
  return policyResult(home, loadPolicy(join(home, "policy.json")), true);
}

export function setPolicyField(home, field, value) {
  const resolvedHome = resolve(home);
  assertQos(EDITABLE_POLICY_FIELDS.includes(field), "POLICY_FIELD_LOCKED", `Editable field must be one of: ${EDITABLE_POLICY_FIELDS.join(", ")}`);
  const next = clonePolicy(loadPolicy(join(resolvedHome, "policy.json")));
  switch (field) {
    case "max-sol-lamports":
      parseUnsigned(value, 64, field);
      next.maxTransferLamports = value;
      break;
    case "max-token-amount":
      assertQos(next.tokenTransfer !== null, "TOKEN_TRANSFERS_DISABLED", "This policy has no token transfer template");
      parseUnsigned(value, 64, field);
      next.tokenTransfer.maxTransferAmount = value;
      break;
    case "max-fee-lamports":
      parseUnsigned(value, 64, field);
      next.maxFeeLamports = value;
      break;
    case "rate-limit":
      next.maxRequestsPerMinute = parseBoundedInteger(value, field, 1, 120);
      break;
    case "ttl-slots":
      next.maxIntentTtlSlots = parseBoundedInteger(value, field, 1, 300);
      break;
    case "commitment":
      assertQos(value === "confirmed" || value === "finalized", "INVALID_POLICY_VALUE", "commitment must be confirmed or finalized");
      next.commitment = value;
      break;
    case "rpc-url":
      next.rpcUrl = value;
      break;
    default:
      assertQos(false, "POLICY_FIELD_LOCKED", "Policy field is locked");
  }
  return commitPolicy(resolvedHome, next);
}

export function changePolicyDestination(home, action, destination) {
  const resolvedHome = resolve(home);
  decodeBase58(destination, 32);
  const next = clonePolicy(loadPolicy(join(resolvedHome, "policy.json")));
  if (action === "add") {
    assertQos(!next.allowedDestinations.includes(destination), "DUPLICATE_DESTINATION", "Destination is already allowlisted");
    next.allowedDestinations.push(destination);
  } else if (action === "remove") {
    assertQos(next.allowedDestinations.includes(destination), "DESTINATION_NOT_FOUND", "Destination is not in the allowlist");
    assertQos(next.allowedDestinations.length > 1, "EMPTY_DESTINATION_ALLOWLIST", "At least one destination must remain allowlisted");
    next.allowedDestinations = next.allowedDestinations.filter((value) => value !== destination);
  } else {
    assertQos(false, "INVALID_POLICY_ACTION", "Destination action must be add or remove");
  }
  return commitPolicy(resolvedHome, next);
}

export function changePolicyStrategy(home, action, text) {
  const resolvedHome = resolve(home);
  const strategyId = parseBoundedInteger(text, "strategy-id", 0, 0xffffffff);
  const next = clonePolicy(loadPolicy(join(resolvedHome, "policy.json")));
  if (action === "add") {
    assertQos(!next.allowedStrategyIds.includes(strategyId), "DUPLICATE_STRATEGY", "Strategy ID is already allowlisted");
    next.allowedStrategyIds.push(strategyId);
    next.allowedStrategyIds.sort((left, right) => left - right);
  } else if (action === "remove") {
    assertQos(next.allowedStrategyIds.includes(strategyId), "STRATEGY_NOT_FOUND", "Strategy ID is not in the allowlist");
    assertQos(next.allowedStrategyIds.length > 1, "EMPTY_STRATEGY_ALLOWLIST", "At least one strategy ID must remain allowlisted");
    next.allowedStrategyIds = next.allowedStrategyIds.filter((value) => value !== strategyId);
  } else {
    assertQos(false, "INVALID_POLICY_ACTION", "Strategy action must be add or remove");
  }
  return commitPolicy(resolvedHome, next);
}
