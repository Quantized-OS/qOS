import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeBase58 } from "../src/base58.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTERNAL_SIGNER = join(ROOT, "fixtures", "external-signer.js");

test("one-command installer and verified toolchain bootstrap expose side-effect-free help", () => {
  for (const path of ["install.sh", "scripts/setup-ubuntu-20.04.sh", "scripts/bootstrap-user-toolchain.sh"]) {
    const result = spawnSync("bash", [join(ROOT, path), "--help"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
});

test("installer provisions a Devnet runtime and working launchers non-interactively", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-install-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeBin = join(root, "fake-bin");
  const installBin = join(root, "installed-bin");
  const home = join(root, "home");
  const profileHome = join(root, "requested-profile");
  mkdirSync(fakeBin, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  for (const command of ["cargo", "rustup", "make"]) {
    const path = join(fakeBin, command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(path, 0o700);
  }

  const installArgs = [
    join(ROOT, "install.sh"),
    "--home", profileHome,
    "--skip-setup",
    "--skip-firmware",
    "--no-shell",
  ];
  const installEnvironment = {
    ...process.env,
    HOME: home,
    QOS_INSTALL_BIN: installBin,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const result = spawnSync("bash", installArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: installEnvironment,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(profileHome, "policy.json")), true);
  assert.equal(existsSync(join(profileHome, "runtime.json")), true);
  assert.equal(existsSync(join(profileHome, "api-token")), true);
  assert.equal(existsSync(join(installBin, "qos")), true);
  assert.equal(existsSync(join(installBin, "qos-shell")), true);
  const signerBefore = readFileSync(join(profileHome, "signer.pem"));
  const tokenBefore = readFileSync(join(profileHome, "api-token"));

  const repeated = spawnSync("bash", installArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: installEnvironment,
  });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(readFileSync(join(profileHome, "signer.pem")), signerBefore);
  assert.deepEqual(readFileSync(join(profileHome, "api-token")), tokenBefore);

  const shell = spawnSync(join(installBin, "qos-shell"), ["--run", "capabilities"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(JSON.parse(shell.stdout).profile, "devnet");
});

test("installer creates a public-only mainnet external-signer profile", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-mainnet-install-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeBin = join(root, "fake-bin");
  const installBin = join(root, "installed-bin");
  const home = join(root, "home");
  const profileHome = join(root, "mainnet-profile");
  const externalSigner = join(root, "external-signer.js");
  mkdirSync(fakeBin, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  copyFileSync(EXTERNAL_SIGNER, externalSigner);
  chmodSync(externalSigner, 0o700);
  for (const command of ["cargo", "rustup", "make"]) {
    const path = join(fakeBin, command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(path, 0o700);
  }

  const result = spawnSync("bash", [
    join(ROOT, "install.sh"),
    "--profile", "mainnet-external",
    "--home", profileHome,
    "--public-key", encodeBase58(Buffer.alloc(32, 81)),
    "--destination", encodeBase58(Buffer.alloc(32, 82)),
    "--signer-command", externalSigner,
    "--skip-setup",
    "--no-shell",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      QOS_INSTALL_BIN: installBin,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(profileHome, "signer.json")), true);
  assert.equal(existsSync(join(profileHome, "signer.pem")), false);
  assert.equal(existsSync(join(profileHome, "signer.qkey")), false);
  assert.equal(existsSync(join(profileHome, "runtime.json")), true);
  assert.equal(existsSync(join(profileHome, "api-token")), true);

  const shell = spawnSync(join(installBin, "qos-shell"), ["--run", "capabilities"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(shell.status, 0, shell.stderr);
  const capabilities = JSON.parse(shell.stdout);
  assert.equal(capabilities.profile, "mainnet-external");
  assert.equal(capabilities.signerMode, "external-non-exportable-boundary");
});
