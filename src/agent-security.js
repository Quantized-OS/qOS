import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { modelAgentPlan, normalizeAgentPlan, basicAgentPlan } from "./agent.js";
import { encodeBase58 } from "./base58.js";
import { publicKeyAddress } from "./key-store.js";
import { initializeSandbox, sandboxPaths } from "./service.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE_PATH = join(PROJECT_ROOT, "tests", "agent-key-probe.js");
const AGENT_DEMO_PATH = join(PROJECT_ROOT, "bin", "qos-agent-demo.js");
const DESTINATION = encodeBase58(Buffer.alloc(32, 42));
const AGENT_CONTEXT = {
  amount: "1000000",
  destination: DESTINATION,
  maxAmount: "1000000000",
  mint: "5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump",
  decimals: 6,
};

function finding(id, severity, status, detail, recommendation, expected = false) {
  return { id, severity, status, expected, detail, recommendation };
}

function successfulProbe(home, { passphrasePath } = {}) {
  const env = {
    PATH: process.env.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
    QOS_AGENT_TEST_HOME: home,
  };
  if (passphrasePath) env.QOS_AGENT_TEST_PASSPHRASE_PATH = passphrasePath;
  const result = spawnSync(process.execPath, [PROBE_PATH], {
    encoding: "utf8",
    env,
    maxBuffer: 128 * 1024,
  });
  if (result.status !== 0) throw new Error("synthetic agent key probe failed");
  return JSON.parse(result.stdout);
}

function checkFile(home, name) {
  return existsSync(join(home, name));
}

function custodyFindings(root) {
  const findings = [];
  const plaintextHome = join(root, "plaintext");
  initializeSandbox(plaintextHome, DESTINATION, { cluster: "devnet" });
  const plaintextProbe = successfulProbe(plaintextHome);

  findings.push(plaintextProbe.privateKeyReadable && plaintextProbe.canLoadPrivateKey
    ? finding(
      "PLAINTEXT_PRIVATE_KEY_EXPOSURE",
      "critical",
      "expected-risk",
      "A process that can read a plaintext-development qOS home can load the signer private key.",
      "Never give an agent access to a plaintext-development home; use an external non-exportable signer.",
      true,
    )
    : finding(
      "PLAINTEXT_PRIVATE_KEY_EXPOSURE",
      "critical",
      "fail",
      "The synthetic plaintext key exposure probe did not reproduce the expected risk.",
      "Investigate the test harness before trusting the result.",
    ));
  findings.push(finding(
    "PLAINTEXT_KEY_FILE_PRESENT",
    "critical",
    checkFile(plaintextHome, "signer.pem") ? "expected-risk" : "fail",
    "Plaintext-development homes intentionally persist signer.pem.",
    "Use an external signer for agent workloads.",
    true,
  ));

  const passphrasePath = join(root, "synthetic-passphrase");
  writeFileSync(passphrasePath, "synthetic agent security passphrase 32 bytes\n", { mode: 0o600 });
  chmodSync(passphrasePath, 0o600);
  const encryptedHome = join(root, "encrypted");
  initializeSandbox(encryptedHome, DESTINATION, { cluster: "devnet", keyPassphraseFile: passphrasePath });
  const encryptedProbe = successfulProbe(encryptedHome);
  const encryptedWithPassphraseProbe = successfulProbe(encryptedHome, { passphrasePath });

  findings.push(encryptedProbe.privateKeyReadable === false && encryptedProbe.canDecryptPrivateKey === false
    ? finding(
      "ENCRYPTED_KEY_AT_REST",
      "medium",
      "pass",
      "Without the passphrase, the synthetic agent could read only encrypted key material, not a usable private key.",
      "Treat encryption as at-rest protection only, not as an agent process boundary.",
    )
    : finding(
      "ENCRYPTED_KEY_AT_REST",
      "medium",
      "fail",
      "The encrypted-key probe recovered private-key capability without the passphrase.",
      "Review encrypted key handling immediately.",
    ));
  findings.push(encryptedWithPassphraseProbe.passphraseReadable && encryptedWithPassphraseProbe.canDecryptPrivateKey
    ? finding(
      "PASSPHRASE_EXPOSURE_DECRYPTS_KEY",
      "high",
      "expected-risk",
      "If an agent can read the encrypted key and its passphrase file, it can recover the signer capability.",
      "Do not expose QOS_KEY_PASSPHRASE_FILE to an agent; prefer an external signer.",
      true,
    )
    : finding(
      "PASSPHRASE_EXPOSURE_DECRYPTS_KEY",
      "high",
      "fail",
      "The synthetic passphrase exposure probe did not reproduce the expected recovery risk.",
      "Investigate the test harness before trusting the result.",
    ));

  const { privateKey } = generateKeyPairSync("ed25519");
  const externalHome = join(root, "external");
  const externalPublicKey = publicKeyAddress(privateKey);
  initializeSandbox(externalHome, DESTINATION, { cluster: "devnet", signerPublicKey: externalPublicKey });
  const externalProbe = successfulProbe(externalHome);
  const descriptor = JSON.parse(readFileSync(sandboxPaths(externalHome).signerDescriptor, "utf8"));
  const descriptorShapeIsPublicOnly = Object.keys(descriptor).sort().join(",") === "backend,publicKey,version";

  findings.push(externalProbe.privateKeyReadable === false && externalProbe.canDecryptPrivateKey === false && descriptorShapeIsPublicOnly
    ? finding(
      "EXTERNAL_SIGNER_KEY_BOUNDARY",
      "info",
      "pass",
      "The external-signer home contains a public descriptor and no private key file or decryptable key material.",
      "Keep the external signer process or hardware adapter separately isolated and policy-aware.",
    )
    : finding(
      "EXTERNAL_SIGNER_KEY_BOUNDARY",
      "critical",
      "fail",
      "The external-signer synthetic home exposed private key material or an unexpected descriptor shape.",
      "Stop deployment and review signer provisioning.",
    ));

  // Keep the generated key object confined to this short-lived synthetic test.
  privateKey.export({ type: "pkcs8", format: "der" }).fill(0);
  return findings;
}

async function expectRejected(findings, id, operation, expectedCode, detail, recommendation) {
  try {
    await operation();
    findings.push(finding(id, "high", "fail", `The adversarial proposal was accepted instead of failing with ${expectedCode}.`, recommendation));
  } catch (error) {
    findings.push(error?.code === expectedCode
      ? finding(id, "info", "pass", detail, recommendation)
      : finding(id, "high", "fail", `The proposal failed with an unexpected error code: ${error?.code ?? "unknown"}.`, recommendation));
  }
}

async function agentPolicyFindings() {
  const findings = [];
  const valid = basicAgentPlan(AGENT_CONTEXT);
  findings.push(valid.action === "transfer_qos" && valid.amount === AGENT_CONTEXT.amount
    ? finding("VALID_TYPED_PROPOSAL", "info", "pass", "The baseline agent proposal is normalized to the single typed qOS action.", "Keep the proposal schema closed.")
    : finding("VALID_TYPED_PROPOSAL", "high", "fail", "The baseline proposal was not normalized as expected.", "Review agent proposal normalization."));

  await expectRejected(
    findings,
    "ARBITRARY_ACTION_REJECTED",
    () => normalizeAgentPlan({ action: "sign_arbitrary", amount: AGENT_CONTEXT.amount, destination: DESTINATION }, AGENT_CONTEXT),
    "AGENT_ACTION_FORBIDDEN",
    "The agent cannot replace the typed transfer action with arbitrary signing.",
    "Do not add a generic sign(bytes) interface.",
  );
  await expectRejected(
    findings,
    "AMOUNT_ESCALATION_REJECTED",
    () => normalizeAgentPlan({ action: "transfer_qos", amount: "1000001", destination: DESTINATION }, AGENT_CONTEXT),
    "AGENT_AMOUNT_MISMATCH",
    "The agent cannot increase the operator-requested amount.",
    "Require an exact operator amount or a separately bounded policy cap.",
  );
  await expectRejected(
    findings,
    "DESTINATION_CHANGE_REJECTED",
    () => normalizeAgentPlan({ action: "transfer_qos", amount: AGENT_CONTEXT.amount, destination: encodeBase58(Buffer.alloc(32, 43)) }, AGENT_CONTEXT),
    "AGENT_DESTINATION_FORBIDDEN",
    "The agent cannot redirect the transfer outside the policy destination.",
    "Keep destination allowlists outside the model context and enforce them after inference.",
  );
  await expectRejected(
    findings,
    "EXTRA_INSTRUCTIONS_REJECTED",
    () => normalizeAgentPlan({ action: "transfer_qos", amount: AGENT_CONTEXT.amount, destination: DESTINATION, instructions: [{ program: "system" }] }, AGENT_CONTEXT),
    "AGENT_PLAN_INVALID",
    "The agent cannot smuggle extra instructions through the proposal JSON.",
    "Reject unknown fields before policy evaluation.",
  );
  await expectRejected(
    findings,
    "REMOTE_MODEL_ENDPOINT_REJECTED",
    () => modelAgentPlan({ ...AGENT_CONTEXT, url: "https://example.com/v1/chat/completions" }),
    "AGENT_MODEL_REMOTE_FORBIDDEN",
    "The model adapter refuses to send policy context to a remote endpoint.",
    "Keep model inference local or add a separately reviewed privacy boundary.",
  );

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: "transfer_qos", amount: "1000001", destination: DESTINATION }) } }] }),
    });
    await expectRejected(
      findings,
      "MODEL_AMOUNT_ESCALATION_REJECTED",
      () => modelAgentPlan({ ...AGENT_CONTEXT, url: "http://127.0.0.1:11434/v1/chat/completions" }),
      "AGENT_AMOUNT_MISMATCH",
      "A malicious model response cannot increase the requested amount.",
      "Treat model output as untrusted input and normalize it before signing.",
    );

    let capturedRequest;
    globalThis.fetch = async (_url, init) => {
      capturedRequest = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: "transfer_qos", amount: AGENT_CONTEXT.amount, destination: DESTINATION }) } }] }),
      };
    };
    await modelAgentPlan({ ...AGENT_CONTEXT, url: "http://127.0.0.1:11434/v1/chat/completions" });
    const promptText = JSON.stringify(capturedRequest);
    findings.push(!promptText.includes("signer.pem") && !promptText.includes("privateKey") && !promptText.includes("passphrase")
      ? finding("MODEL_PROMPT_NO_KEY_MATERIAL", "high", "pass", "The model prompt contains policy context only and no signer path, private-key field, or passphrase.", "Keep key material out of model prompts.")
      : finding("MODEL_PROMPT_NO_KEY_MATERIAL", "critical", "fail", "The model prompt contained key or passphrase markers.", "Remove key material from model context immediately."));
  } finally {
    globalThis.fetch = originalFetch;
  }

  return findings;
}

function broadcastGateFinding() {
  const env = { ...process.env };
  delete env[`QOS_${"ENABLE_MAINNET_BROADCAST"}`];
  const result = spawnSync(process.execPath, [
    AGENT_DEMO_PATH,
    "--home", join(tmpdir(), "qos-agent-security-no-home"),
    "--amount", "1",
    "--broadcast",
    "--confirm-live",
  ], { encoding: "utf8", env, maxBuffer: 64 * 1024 });
  return result.status !== 0 && result.stderr.includes("LIVE_BROADCAST_DISABLED")
    ? finding("MAINNET_BROADCAST_DOUBLE_GATE", "critical", "pass", "The agent CLI refuses live broadcast without the explicit environment opt-in even when --broadcast and --confirm-live are present.", "Keep both independent live-broadcast gates.")
    : finding("MAINNET_BROADCAST_DOUBLE_GATE", "critical", "fail", "The agent CLI did not fail closed before an unauthorised broadcast attempt.", "Disable live execution until the broadcast gate is restored.");
}

export async function runAgentSecurityAnalysis() {
  const root = mkdtempSync(join(tmpdir(), "qos-agent-security-"));
  try {
    const findings = [
      ...custodyFindings(root),
      ...(await agentPolicyFindings()),
      broadcastGateFinding(),
    ];
    const unexpectedFailures = findings.filter((item) => item.status === "fail");
    return {
      version: 1,
      test: "qOS agent security analysis",
      result: unexpectedFailures.length === 0 ? "PASS_WITH_EXPECTED_RISKS" : "FAIL",
      scope: {
        networkAccess: false,
        mainnetBroadcast: false,
        keys: "synthetic-disposable-only",
        plaintextKeyExposureProbe: true,
        encryptedKeyRecoveryProbe: true,
        externalSignerProbe: true,
        adversarialModelOutput: true,
      },
      findings,
      recommendations: [
        "Do not give an AI agent access to plaintext signer.pem files.",
        "Do not expose QOS_KEY_PASSPHRASE_FILE or encrypted-key passphrases to an agent.",
        "Use an external non-exportable signer and separately constrain its policy-aware adapter.",
        "Treat model output as hostile input; qOS must normalize and revalidate every proposal.",
        "Keep this harness synthetic-only and never point it at a production qOS home.",
      ],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
