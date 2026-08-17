import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentListenerStatus, listenerPaths, stopAgentDaemon } from "../src/agent-daemon.js";
import { loadPolicy } from "../src/policy.js";
import { ensureRuntimeProfile } from "../src/runtime-profile.js";
import { initializeSandbox } from "../src/service.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTROL = join(ROOT, "bin", "qos-agent-control.js");

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

test("CLI onboarding automatically starts one managed REST and MCP listener", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-agent-daemon-test-"));
  const home = join(root, "profile");
  initializeSandbox(home);
  ensureRuntimeProfile(home, { profile: "devnet" });
  const policy = loadPolicy(join(home, "policy.json"));
  const port = await unusedPort();
  t.after(async () => {
    try { await stopAgentDaemon(home, { timeoutMs: 1_000 }); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  const onboarded = spawnSync(process.execPath, [
    CONTROL,
    "--home", home,
    "--json",
    "onboard",
    "--id", "daemon-bot",
    "--asset", "sol",
    "--max-amount", "100",
    "--destination", policy.allowedDestinations[0],
    "--strategy-id", "1",
    "--yes",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, QOS_AGENT_PORT: String(port) },
    timeout: 15_000,
  });
  assert.equal(onboarded.status, 0, onboarded.stderr);
  const result = JSON.parse(onboarded.stdout);
  assert.equal(result.listener.status, "started");
  assert.equal(result.listener.mcpEndpoint, `http://127.0.0.1:${port}/mcp`);
  assert.equal(existsSync(listenerPaths(home).state), true);
  assert.equal((await agentListenerStatus(home)).status, "listening");

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "qos-agent-listener");

  const stopped = spawnSync(process.execPath, [CONTROL, "--home", home, "--json", "stop"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).wasRunning, true);
  assert.equal(existsSync(listenerPaths(home).state), false);
});
