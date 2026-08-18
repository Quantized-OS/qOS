import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeBase58 } from "../src/base58.js";
import { ensureRuntimeProfile } from "../src/runtime-profile.js";
import { initializeSandbox } from "../src/service.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHELL = join(ROOT, "bin", "qos-shell.js");
const EXTERNAL_SIGNER = join(ROOT, "fixtures", "external-signer.js");

function devnetProfile(t) {
  const root = mkdtempSync(join(tmpdir(), "qos-shell-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "devnet");
  initializeSandbox(home);
  ensureRuntimeProfile(home, { profile: "devnet" });
  return home;
}

test("qOS Shell help is available before profile creation", () => {
  const result = spawnSync(process.execPath, [SHELL, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /secure firmware shell/);
  assert.match(result.stdout, /qOS command shell/);
  assert.match(result.stdout, /send\|snd LAMPORTS --confirm-broadcast/);
  assert.match(result.stdout, /capabilities \| capa/);
  assert.match(result.stdout, /model \| mod catalog/);
  assert.match(result.stdout, /current source implements transfers, not DEX swaps/);
});

test("qOS accepts a direct shorthand command and reports exact capabilities", (t) => {
  const home = devnetProfile(t);
  const result = spawnSync(process.execPath, [SHELL, "-H", home, "--json", "capa"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.profile, "devnet");
  assert.equal(capabilities.cluster, "devnet");
  assert.equal(capabilities.dexTrading, false);
  assert.ok(capabilities.operations.includes("qemu-firmware-rehearsal"));
  assert.ok(capabilities.operations.includes("byok-model-providers"));
});

test("qOS Shell exposes the commercial model catalog and empty provider registry", (t) => {
  const home = devnetProfile(t);
  const catalog = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "mod", "cat"], { encoding: "utf8" });
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.ok(JSON.parse(catalog.stdout).providers.some((provider) => provider.id === "anthropic"));
  const list = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "model"], { encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).profiles, []);
});

test("qOS routes bare agent commands to managed onboarding and isolates the synthetic demo namespace", (t) => {
  const home = devnetProfile(t);
  const managed = spawnSync(process.execPath, [SHELL, "--home", home, "ag"], { encoding: "utf8" });
  assert.equal(managed.status, 0, managed.stderr);
  assert.match(managed.stdout, /Agents: \(none\)/);
  assert.match(managed.stdout, /Managed-agent workflow/);
  assert.match(managed.stdout, /ag on/);

  const ambiguous = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "ag", "broadcast", "1"], { encoding: "utf8" });
  assert.equal(ambiguous.status, 1);
  assert.equal(JSON.parse(ambiguous.stderr).error.code, "AGENT_DEMO_NAMESPACE_REQUIRED");

  const serveForm = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "serve", "api", "not-a-port"], { encoding: "utf8" });
  assert.equal(serveForm.status, 1);
  assert.equal(JSON.parse(serveForm.stderr).error.code, "INVALID_PORT");

  const recognizedServeForm = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "serve", "api", "800"], {
    encoding: "utf8",
  });
  assert.equal(recognizedServeForm.status, 1);
  assert.equal(JSON.parse(recognizedServeForm.stderr).error.code, "NO_AGENTS_ONBOARDED");
});

test("qOS operator output is readable by default and JSON only when requested", (t) => {
  const home = devnetProfile(t);
  const readable = spawnSync(process.execPath, [SHELL, "--home", home, "capa"], { encoding: "utf8" });
  assert.equal(readable.status, 0, readable.stderr);
  assert.match(readable.stdout, /^qOS capabilities\n-+\n/);
  assert.match(readable.stdout, /Profile: devnet/);
  assert.throws(() => JSON.parse(readable.stdout));
  const json = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "capa"], { encoding: "utf8" });
  assert.equal(JSON.parse(json.stdout).profile, "devnet");
  const status = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "stat"], { encoding: "utf8" });
  const statusValue = JSON.parse(status.stdout);
  assert.equal(statusValue.capabilities.profile, "devnet");
  assert.equal(statusValue.address.cluster, "devnet");
});

test("qOS Shell mainnet capabilities expose token transfer but not disabled native SOL transfer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-shell-mainnet-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "mainnet");
  const externalSigner = join(root, "external-signer.js");
  copyFileSync(EXTERNAL_SIGNER, externalSigner);
  chmodSync(externalSigner, 0o700);
  initializeSandbox(home, encodeBase58(Buffer.alloc(32, 91)), {
    cluster: "mainnet-beta",
    signerPublicKey: encodeBase58(Buffer.alloc(32, 92)),
  });
  ensureRuntimeProfile(home, { profile: "mainnet-external", signerCommand: externalSigner });
  const result = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "--run", "capa"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.signerMode, "external-non-exportable-boundary");
  assert.ok(capabilities.operations.includes("qos-token-transfer"));
  assert.equal(capabilities.operations.includes("native-sol-transfer"), false);
  const status = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "stat"], { encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).address.signer, encodeBase58(Buffer.alloc(32, 92)));
});

test("qOS Shell insecure mainnet profile keeps mainnet capabilities and reports accessible custody", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-shell-mainnet-insecure-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "mainnet-insecure");
  initializeSandbox(home, encodeBase58(Buffer.alloc(32, 93)), { cluster: "mainnet-beta" });
  ensureRuntimeProfile(home, { profile: "mainnet-insecure", acceptInsecureRisk: true });

  const result = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "capa"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.profile, "mainnet-insecure");
  assert.equal(capabilities.signerMode, "local-software-key-accessible");
  assert.equal(capabilities.keyAccessibleToLocalProcesses, true);
  assert.ok(capabilities.operations.includes("qos-token-transfer"));
  assert.ok(capabilities.operations.includes("agent-directed-qos-token-transfer"));
  assert.equal(capabilities.operations.includes("native-sol-transfer"), false);
});

test("qOS Shell refuses a DEX trade when no reviewed venue template exists", (t) => {
  const home = devnetProfile(t);
  const result = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "tr"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "DEX_TEMPLATE_NOT_INSTALLED");
});

test("qOS Shell requires an explicit broadcast confirmation before network access", (t) => {
  const home = devnetProfile(t);
  const result = spawnSync(process.execPath, [SHELL, "--home", home, "--json", "s", "snd", "1"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "BROADCAST_CONFIRMATION_REQUIRED");

  const duplicate = spawnSync(process.execPath, [
    SHELL,
    "--home", home,
    "--json",
    "--run", "agent", "demo", "broadcast", "1", "--confirm-live", "--confirm-live",
  ], { encoding: "utf8" });
  assert.equal(duplicate.status, 1);
  assert.equal(JSON.parse(duplicate.stderr).error.code, "DUPLICATE_ARGUMENT");
});
