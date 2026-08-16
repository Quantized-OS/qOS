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
  assert.match(result.stdout, /current source implements transfers, not DEX swaps/);
});

test("qOS accepts a direct shorthand command and reports exact capabilities", (t) => {
  const home = devnetProfile(t);
  const result = spawnSync(process.execPath, [SHELL, "-H", home, "capa"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.profile, "devnet");
  assert.equal(capabilities.cluster, "devnet");
  assert.equal(capabilities.dexTrading, false);
  assert.ok(capabilities.operations.includes("qemu-firmware-rehearsal"));
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
  const result = spawnSync(process.execPath, [SHELL, "--home", home, "--run", "capa"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.signerMode, "external-non-exportable-boundary");
  assert.ok(capabilities.operations.includes("qos-token-transfer"));
  assert.equal(capabilities.operations.includes("native-sol-transfer"), false);
});

test("qOS Shell insecure mainnet profile keeps mainnet capabilities and reports accessible custody", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-shell-mainnet-insecure-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "mainnet-insecure");
  initializeSandbox(home, encodeBase58(Buffer.alloc(32, 93)), { cluster: "mainnet-beta" });
  ensureRuntimeProfile(home, { profile: "mainnet-insecure", acceptInsecureRisk: true });

  const result = spawnSync(process.execPath, [SHELL, "--home", home, "capa"], { encoding: "utf8" });
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
  const result = spawnSync(process.execPath, [SHELL, "--home", home, "tr"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "DEX_TEMPLATE_NOT_INSTALLED");
});

test("qOS Shell requires an explicit broadcast confirmation before network access", (t) => {
  const home = devnetProfile(t);
  const result = spawnSync(process.execPath, [SHELL, "--home", home, "s", "snd", "1"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "BROADCAST_CONFIRMATION_REQUIRED");

  const duplicate = spawnSync(process.execPath, [
    SHELL,
    "--home", home,
    "--run", "agent", "broadcast", "1", "--confirm-live", "--confirm-live",
  ], { encoding: "utf8" });
  assert.equal(duplicate.status, 1);
  assert.equal(JSON.parse(duplicate.stderr).error.code, "DUPLICATE_ARGUMENT");
});
