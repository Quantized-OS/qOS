import assert from "node:assert/strict";
import test from "node:test";

import { runAgentSecurityAnalysis } from "../src/agent-security.js";

test("synthetic agent security analysis proves key-custody and policy boundaries", async () => {
  const report = await runAgentSecurityAnalysis();
  assert.equal(report.result, "PASS_WITH_EXPECTED_RISKS");
  assert.equal(report.scope.networkAccess, false);
  assert.equal(report.scope.mainnetBroadcast, false);

  const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
  assert.equal(byId.get("PLAINTEXT_PRIVATE_KEY_EXPOSURE")?.status, "expected-risk");
  assert.equal(byId.get("PASSPHRASE_EXPOSURE_DECRYPTS_KEY")?.status, "expected-risk");
  assert.equal(byId.get("EXTERNAL_SIGNER_KEY_BOUNDARY")?.status, "pass");
  assert.equal(byId.get("ARBITRARY_ACTION_REJECTED")?.status, "pass");
  assert.equal(byId.get("MODEL_AMOUNT_ESCALATION_REJECTED")?.status, "pass");
  assert.equal(byId.get("MODEL_PROMPT_NO_KEY_MATERIAL")?.status, "pass");
  assert.equal(byId.get("MAINNET_BROADCAST_DOUBLE_GATE")?.status, "pass");
});
