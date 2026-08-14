import { createHash } from "node:crypto";
import { canonicalJson, hasExactKeys } from "./canonical.js";
import { assertQos } from "./errors.js";
import { parseCommandArgs, runJsonCommand } from "./subprocess.js";

const PROOF_SYSTEMS = new Set(["groth16-bn254", "plonk-bn254"]);

export function sha256Canonical(value, domain) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function policyCommitment(policy) {
  return sha256Canonical(policy, "qos-policy-v1");
}

export function intentCommitment(intent) {
  return sha256Canonical(intent, "qos-intent-v1");
}

export class SnarkProofGate {
  constructor({ required = false, command, args = [], circuitId, verifyingKeySha256, proofSystem = "groth16-bn254", timeoutMs = 15_000 } = {}) {
    this.required = required;
    this.command = command;
    this.args = args;
    this.circuitId = circuitId;
    this.verifyingKeySha256 = verifyingKeySha256;
    this.proofSystem = proofSystem;
    this.timeoutMs = timeoutMs;
    this.enabled = typeof command === "string" && command.length > 0;
    assertQos(!required || this.enabled, "ZK_VERIFIER_REQUIRED", "A SNARK verifier command is required by configuration");
    if (this.enabled) {
      assertQos(PROOF_SYSTEMS.has(proofSystem), "INVALID_ZK_CONFIG", "SNARK proof system is unsupported");
      assertQos(typeof circuitId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(circuitId), "INVALID_ZK_CONFIG", "SNARK circuit ID is invalid");
      assertQos(typeof verifyingKeySha256 === "string" && /^[0-9a-f]{64}$/.test(verifyingKeySha256), "INVALID_ZK_CONFIG", "SNARK verifying-key digest must be lowercase SHA-256 hex");
      assertQos(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000, "INVALID_ZK_CONFIG", "SNARK verifier timeout is invalid");
    }
  }

  static fromEnvironment(env = process.env) {
    assertQos(env.QOS_REQUIRE_ZK_PROOF === undefined || env.QOS_REQUIRE_ZK_PROOF === "0" || env.QOS_REQUIRE_ZK_PROOF === "1", "INVALID_ZK_CONFIG", "QOS_REQUIRE_ZK_PROOF must be 0 or 1 when configured");
    const required = env.QOS_REQUIRE_ZK_PROOF === "1";
    const command = env.QOS_ZK_VERIFIER_COMMAND;
    return new SnarkProofGate({
      required,
      command,
      args: parseCommandArgs(env.QOS_ZK_VERIFIER_ARGS_JSON, "QOS_ZK_VERIFIER_ARGS_JSON"),
      circuitId: env.QOS_ZK_CIRCUIT_ID,
      verifyingKeySha256: env.QOS_ZK_VERIFYING_KEY_SHA256,
      proofSystem: env.QOS_ZK_PROOF_SYSTEM ?? "groth16-bn254",
      timeoutMs: env.QOS_ZK_TIMEOUT_MS === undefined ? 15_000 : Number(env.QOS_ZK_TIMEOUT_MS),
    });
  }

  async verify(intent, privacyProof, { policy, signer }) {
    if (!this.enabled) {
      assertQos(privacyProof === undefined, "ZK_NOT_CONFIGURED", "A privacy proof was supplied but no SNARK verifier is configured");
      return { verified: false, required: false };
    }
    if (privacyProof === undefined) {
      assertQos(!this.required, "ZK_PROOF_REQUIRED", "This signer requires a privacy-preserving authorization proof");
      return { verified: false, required: false };
    }
    assertQos(hasExactKeys(privacyProof, ["version", "proofSystem", "circuitId", "proof"]), "INVALID_ZK_PROOF", "Privacy proof has missing or unknown fields");
    assertQos(privacyProof.version === 1, "INVALID_ZK_PROOF", "Privacy proof version is unsupported");
    assertQos(privacyProof.proofSystem === this.proofSystem && privacyProof.circuitId === this.circuitId, "ZK_CIRCUIT_MISMATCH", "Privacy proof does not target the pinned circuit");
    assertQos(privacyProof.proof && typeof privacyProof.proof === "object" && !Array.isArray(privacyProof.proof), "INVALID_ZK_PROOF", "Privacy proof payload must be an object");
    assertQos(Buffer.byteLength(canonicalJson(privacyProof.proof)) <= 128 * 1024, "ZK_PROOF_TOO_LARGE", "Privacy proof exceeds 128 KiB");

    const request = {
      version: 1,
      operation: "verify-qos-snark",
      proofSystem: this.proofSystem,
      circuitId: this.circuitId,
      verifyingKeySha256: this.verifyingKeySha256,
      publicSignals: {
        intentCommitment: intentCommitment(intent),
        policyCommitment: policyCommitment(policy),
        signer,
        expiresAtSlot: intent.expiresAtSlot,
      },
      proof: privacyProof.proof,
    };
    const requestDigest = sha256Canonical(request, "qos-snark-request-v1");
    const response = await runJsonCommand(this.command, this.args, request, {
      timeoutMs: this.timeoutMs,
      errorPrefix: "ZK_VERIFIER",
    });
    assertQos(hasExactKeys(response, ["version", "valid", "requestDigest"]), "INVALID_ZK_RESPONSE", "SNARK verifier response has missing or unknown fields");
    assertQos(response.version === 1 && response.requestDigest === requestDigest, "ZK_RESPONSE_MISMATCH", "SNARK verifier response is not bound to this request");
    assertQos(response.valid === true, "ZK_PROOF_INVALID", "Privacy-preserving authorization proof did not verify");
    return { verified: true, required: this.required, proofSystem: this.proofSystem, circuitId: this.circuitId };
  }

  status() {
    return {
      enabled: this.enabled,
      required: this.required,
      ...(this.enabled ? {
        proofSystem: this.proofSystem,
        circuitId: this.circuitId,
        verifyingKeySha256: this.verifyingKeySha256,
      } : {}),
    };
  }
}

export function unwrapProofRequest(request) {
  if (request && typeof request === "object" && !Array.isArray(request) && Object.hasOwn(request, "intent")) {
    assertQos(hasExactKeys(request, ["intent", "privacyProof"]), "INVALID_SUBMIT_REQUEST", "Proof-carrying submit request must contain only intent and privacyProof");
    return { intent: request.intent, privacyProof: request.privacyProof };
  }
  return { intent: request, privacyProof: undefined };
}
