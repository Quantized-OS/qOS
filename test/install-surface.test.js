import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeBase58 } from "../src/base58.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTERNAL_SIGNER = join(ROOT, "fixtures", "external-signer.js");

test("setup actions and verified toolchain bootstrap expose side-effect-free help", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-setup-help-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["setup.sh", "scripts/setup-ubuntu-20.04.sh", "scripts/bootstrap-user-toolchain.sh"]) {
    const result = spawnSync("bash", [join(ROOT, path), "--help"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
  for (const action of ["install", "uninstall"]) {
    const result = spawnSync("bash", [join(ROOT, "setup.sh"), action, "--help"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /secure firmware shell/);
  }
  for (const path of ["bin/qos-agent-control.js", "bin/qos-policy.js", "bin/qos-wallet.js"]) {
    const result = spawnSync(process.execPath, [join(ROOT, path), "--help"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
  assert.equal(existsSync(join(ROOT, "install.sh")), false);

  const signerGuide = spawnSync("bash", [join(ROOT, "setup.sh"), "install", "--signer-guide"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(signerGuide.status, 0, signerGuide.stderr);
  assert.match(signerGuide.stdout, /qOS does not include a production adapter/);
  assert.match(signerGuide.stdout, /Never use fixtures\/external-signer\.js for funds/);

  const incompleteWizard = spawnSync("bash", [
    join(ROOT, "setup.sh"),
    "install",
    "--wizard",
    "--skip-setup",
    "--no-shell",
    "--home", join(root, "wizard-profile"),
    "--bin", join(root, "wizard-bin"),
  ], {
    cwd: ROOT,
    encoding: "utf8",
    input: "guide\n",
    env: { ...process.env, HOME: root, QOS_AGENT_AUTOSERVE: "0" },
  });
  assert.equal(incompleteWizard.status, 2);
  assert.match(incompleteWizard.stdout, /Mainnet key setup/);
  assert.match(incompleteWizard.stdout, /Generate a key for me \(--insecure\)/);
  assert.match(incompleteWizard.stdout, /Reviewed signer adapter: simple setup guide/);
  assert.match(incompleteWizard.stderr, /No dependencies, profile, key, or launcher were created/);
  assert.equal(existsSync(join(root, "wizard-profile")), false);

  const mainnetDefault = spawnSync("bash", [join(ROOT, "setup.sh"), "install", "--skip-setup", "--no-shell"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: root, QOS_AGENT_AUTOSERVE: "0" },
  });
  assert.equal(mainnetDefault.status, 1);
  assert.match(mainnetDefault.stderr, /Mainnet is the default/);
});

test("setup safely retires the recognized Devnet-default install.sh before checks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-legacy-install-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "qOS");
  const fakeBin = join(root, "fake-bin");
  const home = join(root, "home");
  const profileHome = join(root, "profile");
  const installBin = join(root, "installed-bin");
  cpSync(ROOT, checkout, { recursive: true });
  mkdirSync(fakeBin, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  for (const command of ["cargo", "rustup", "make"]) {
    const path = join(fakeBin, command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const legacy = [
    "#!/usr/bin/env bash",
    "printf '[qOS install] legacy\\n'",
    "# Usage: ./install.sh [options]",
    "# scripts/setup-ubuntu-20.04.sh",
    "",
  ].join("\n");
  const backupDirectory = join(checkout, ".qos-setup-backup");
  const existingBackup = "pre-existing retired installer\n";
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(backupDirectory, "install.sh.retired"), existingBackup, { mode: 0o600 });
  writeFileSync(join(checkout, "install.sh"), legacy, { mode: 0o700 });
  const environment = {
    ...process.env,
    QOS_AGENT_AUTOSERVE: "0",
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const args = [
    join(checkout, "setup.sh"),
    "install",
    "--devnet",
    "--home", profileHome,
    "--bin", installBin,
    "--skip-setup",
    "--skip-firmware",
    "--offline",
    "--no-shell",
  ];
  const result = spawnSync("bash", args, { cwd: checkout, encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Retired the old install\.sh/);
  assert.equal(existsSync(join(checkout, "install.sh")), false);
  assert.equal(readFileSync(join(backupDirectory, "install.sh.retired"), "utf8"), existingBackup);
  const retiredCopies = readdirSync(backupDirectory)
    .filter((name) => /^install\.sh\.retired(?:\.[1-9][0-9]*)?$/.test(name))
    .map((name) => readFileSync(join(backupDirectory, name), "utf8"));
  assert.ok(retiredCopies.includes(legacy), "the newly retired installer must be preserved under a free suffix");
  const staticCheck = spawnSync("python3", [join(checkout, "tests", "static_checks.py")], {
    cwd: checkout,
    encoding: "utf8",
  });
  assert.equal(staticCheck.status, 0, staticCheck.stderr);

  const unrelated = "#!/bin/sh\n# unrelated local installer\n";
  writeFileSync(join(checkout, "install.sh"), unrelated, { mode: 0o700 });
  const refused = spawnSync("bash", args, { cwd: checkout, encoding: "utf8", env: environment });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unrecognized install\.sh/);
  assert.equal(readFileSync(join(checkout, "install.sh"), "utf8"), unrelated);
});

test("setup install works repeatedly and uninstall purges all registered qOS artifacts", (t) => {
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
    join(ROOT, "setup.sh"),
    "install",
    "--devnet",
    "-H", profileHome,
    "-B", installBin,
    "-k",
    "-F",
    "--offline",
    "--agent-id", "setup-bot",
    "--agent-max-amount", "1000",
    "-n",
  ];
  const installEnvironment = {
    ...process.env,
    QOS_AGENT_AUTOSERVE: "0",
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
  assert.match(result.stdout, /Setup complete\. qOS will open on disposable Devnet/);
  assert.equal(existsSync(join(profileHome, "policy.json")), true);
  assert.equal(existsSync(join(profileHome, "runtime.json")), true);
  assert.equal(existsSync(join(profileHome, "api-token")), true);
  assert.equal(existsSync(join(installBin, "qos")), true);
  assert.equal(existsSync(join(installBin, "qos-core")), true);
  assert.equal(existsSync(join(installBin, "qos-shell")), true);
  assert.equal(existsSync(join(installBin, "qos-agent")), true);
  assert.equal(existsSync(join(installBin, "qos-policy")), true);
  assert.equal(existsSync(join(installBin, "qos-wallet")), true);
  assert.equal(existsSync(join(profileHome, "agents", "setup-bot", "token")), true);
  assert.equal(existsSync(join(profileHome, "agents", "setup-bot", "skills", "SKILL.md")), true);
  const signerBefore = readFileSync(join(profileHome, "signer.pem"));
  const tokenBefore = readFileSync(join(profileHome, "api-token"));
  const agentTokenBefore = readFileSync(join(profileHome, "agents", "setup-bot", "token"));

  const repeated = spawnSync("bash", installArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: installEnvironment,
  });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(readFileSync(join(profileHome, "signer.pem")), signerBefore);
  assert.deepEqual(readFileSync(join(profileHome, "api-token")), tokenBefore);
  assert.deepEqual(readFileSync(join(profileHome, "agents", "setup-bot", "token")), agentTokenBefore);

  const changedAgentArgs = [...installArgs];
  changedAgentArgs[changedAgentArgs.indexOf("1000")] = "2000";
  const changedAgent = spawnSync("bash", changedAgentArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: installEnvironment,
  });
  assert.equal(changedAgent.status, 1);
  assert.match(changedAgent.stderr, /different maximum amount/);
  assert.deepEqual(readFileSync(join(profileHome, "agents", "setup-bot", "token")), agentTokenBefore);

  const shell = spawnSync(join(installBin, "qos"), ["--json", "capa"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(JSON.parse(shell.stdout).profile, "devnet");

  const unmanagedCore = "#!/bin/sh\n# operator-managed command\nexit 0\n";
  writeFileSync(join(installBin, "qos-core"), unmanagedCore, { mode: 0o700 });
  const outside = join(root, "outside-qos-data");
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, "keep"), "preserved\n", { mode: 0o600 });
  const qosDataRoot = join(home, ".local", "share", "qos");
  symlinkSync(outside, join(qosDataRoot, "do-not-follow"));
  // Older qOS releases could leave these owner-controlled directories at 0755.
  // A confirmed purge must repair that mode without weakening ownership or
  // symlink checks, then remove the registered installation normally.
  chmodSync(qosDataRoot, 0o755);
  chmodSync(profileHome, 0o755);
  chmodSync(join(profileHome, "agents"), 0o755);
  const unconfirmed = spawnSync("bash", [join(ROOT, "setup.sh"), "uninstall", "--bin", installBin], {
    cwd: ROOT,
    encoding: "utf8",
    env: installEnvironment,
  });
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /requires --yes/);
  assert.equal(existsSync(profileHome), true);
  assert.equal(lstatSync(qosDataRoot).mode & 0o077, 0o055);
  const uninstall = spawnSync("bash", [join(ROOT, "setup.sh"), "uninstall", "--bin", installBin, "--yes"], {
    cwd: ROOT,
    encoding: "utf8",
    env: installEnvironment,
  });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(existsSync(join(installBin, "qos")), false);
  assert.equal(readFileSync(join(installBin, "qos-core"), "utf8"), unmanagedCore);
  assert.equal(existsSync(join(installBin, "qos-shell")), false);
  assert.equal(existsSync(profileHome), false);
  assert.equal(existsSync(join(home, ".local", "share", "qos")), false);
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "preserved\n");
  assert.match(uninstall.stdout, /Full qOS purge complete/);

  const refusedReinstall = spawnSync("bash", installArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: installEnvironment,
  });
  assert.equal(refusedReinstall.status, 1);
  assert.match(refusedReinstall.stderr, /Refusing to replace an unmanaged command/);
  assert.equal(existsSync(join(installBin, "qos")), false);
  assert.equal(readFileSync(join(installBin, "qos-core"), "utf8"), unmanagedCore);
});

test("setup defaults to a public-only mainnet external-signer profile", (t) => {
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

  const publicKey = encodeBase58(Buffer.alloc(32, 81));
  const destination = encodeBase58(Buffer.alloc(32, 82));
  const environment = {
    ...process.env,
    QOS_AGENT_AUTOSERVE: "0",
    HOME: home,
    QOS_INSTALL_BIN: installBin,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  chmodSync(externalSigner, 0o775);
  const insecureAdapter = spawnSync("bash", [
    join(ROOT, "setup.sh"),
    "install",
    "-H", profileHome,
    "-B", installBin,
    "-P", publicKey,
    "-D", destination,
    "-S", externalSigner,
    "-k",
    "--offline",
    "-n",
  ], { cwd: ROOT, encoding: "utf8", env: environment });
  assert.equal(insecureAdapter.status, 1);
  assert.match(insecureAdapter.stderr, /writable by a group or other users/);
  assert.equal(existsSync(profileHome), false);
  chmodSync(externalSigner, 0o700);

  const result = spawnSync("bash", [
    join(ROOT, "setup.sh"),
    "install",
    "--wizard",
    "-H", profileHome,
    "-B", installBin,
    "-k",
    "--offline",
    "-n",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    input: `1\n${publicKey}\n${destination}\n${externalSigner}\nyes\nno\n`,
    env: environment,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mainnet key setup/);
  assert.match(result.stdout, /Using your existing key through a reviewed external signer/);
  assert.match(result.stdout, /Guided setup: mainnet with an external signer/);
  assert.match(result.stdout, /Ready to install/);
  assert.match(result.stdout, /Setup complete\. qOS will open with public-only mainnet custody/);
  assert.equal(existsSync(join(profileHome, "signer.json")), true);
  assert.equal(existsSync(join(profileHome, "signer.pem")), false);
  assert.equal(existsSync(join(profileHome, "signer.qkey")), false);
  assert.equal(existsSync(join(profileHome, "runtime.json")), true);
  assert.equal(existsSync(join(profileHome, "api-token")), true);

  const shell = spawnSync(join(installBin, "qos"), ["--json", "capa"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(shell.status, 0, shell.stderr);
  const capabilities = JSON.parse(shell.stdout);
  assert.equal(capabilities.profile, "mainnet-external");
  assert.equal(capabilities.signerMode, "external-non-exportable-boundary");
});

test("setup --insecure and the default generated-key choice require the same warning", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-mainnet-insecure-install-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeBin = join(root, "fake-bin");
  const installBin = join(root, "installed-bin");
  const refusedHome = join(root, "refused-profile");
  const profileHome = join(root, "mainnet-insecure-profile");
  const home = join(root, "home");
  mkdirSync(fakeBin, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  for (const command of ["cargo", "rustup", "make"]) {
    const path = join(fakeBin, command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const destination = encodeBase58(Buffer.alloc(32, 83));
  const environment = {
    ...process.env,
    QOS_AGENT_AUTOSERVE: "0",
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };

  const incompatibleAgentHome = join(root, "incompatible-agent-profile");
  const incompatibleAgent = spawnSync("bash", [
    join(ROOT, "setup.sh"),
    "install",
    "--insecure",
    "--accept-insecure-risk",
    "--destination", destination,
    "--home", incompatibleAgentHome,
    "--agent-id", "wrong-asset-bot",
    "--agent-asset", "sol",
    "--agent-max-amount", "1",
  ], { cwd: ROOT, encoding: "utf8", env: environment });
  assert.equal(incompatibleAgent.status, 1);
  assert.match(incompatibleAgent.stderr, /enabled setup asset is qos-token/);
  assert.equal(existsSync(incompatibleAgentHome), false);

  const refused = spawnSync("bash", [
    join(ROOT, "setup.sh"),
    "install",
    "--insecure",
    "--destination", destination,
    "--home", refusedHome,
    "--bin", join(root, "refused-bin"),
    "--skip-setup",
    "--offline",
    "--no-shell",
  ], { cwd: ROOT, encoding: "utf8", env: environment });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /INSECURE MAINNET KEY NOTICE/);
  assert.match(refused.stderr, /--accept-insecure-risk/);
  assert.equal(existsSync(refusedHome), false);

  const unattendedHome = join(root, "unattended-profile");
  const unattended = spawnSync("bash", [
    join(ROOT, "setup.sh"),
    "install",
    "--insecure",
    "--accept-insecure-risk",
    "--destination", destination,
    "--home", unattendedHome,
    "--bin", join(root, "unattended-bin"),
    "--skip-setup",
    "--offline",
    "--no-shell",
  ], { cwd: ROOT, encoding: "utf8", env: environment });
  assert.equal(unattended.status, 0, unattended.stderr);
  assert.match(unattended.stdout, /Accepted the accessible mainnet software-key notice/);
  assert.equal(existsSync(join(unattendedHome, "signer.pem")), true);

  const result = spawnSync("bash", [
    join(ROOT, "setup.sh"),
    "install",
    "--wizard",
    "--home", profileHome,
    "--bin", installBin,
    "--skip-setup",
    "--offline",
    "--no-shell",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    input: `2\n${destination}\nyes\nyes\nmainnet-bot\nMainnet bot\nyes\n1000\nyes\n`,
    env: environment,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Generated-key custody selected; continuing with the --insecure mainnet setup/);
  assert.match(result.stdout, /INSECURE MAINNET KEY NOTICE/);
  assert.match(result.stdout, /same qOS mainnet transfer and agent capabilities/);
  assert.match(result.stdout, /Allowed action: qOS Token-2022 transfer \(qos-token\).*only transfer template/);
  assert.match(result.stdout, /Agent ready to onboard/);
  assert.match(result.stdout, /Setup complete\. qOS will open on mainnet with a locally generated software key/);
  assert.equal(existsSync(join(profileHome, "signer.pem")), true);
  assert.equal(existsSync(join(profileHome, "signer.json")), false);
  assert.equal(existsSync(join(profileHome, "runtime.json")), true);
  assert.equal(lstatSync(join(profileHome, "signer.pem")).mode & 0o077, 0);
  const installedAgent = JSON.parse(readFileSync(join(profileHome, "agents", "registry.json"), "utf8")).agents[0];
  assert.equal(installedAgent.id, "mainnet-bot");
  assert.equal(installedAgent.asset, "qos-token");
  assert.equal(existsSync(join(profileHome, "agents", "mainnet-bot", "token")), true);

  const runtime = JSON.parse(readFileSync(join(profileHome, "runtime.json"), "utf8"));
  assert.equal(runtime.profile, "mainnet-insecure");
  const shell = spawnSync(join(installBin, "qos"), ["--json", "capa"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(shell.status, 0, shell.stderr);
  const capabilities = JSON.parse(shell.stdout);
  assert.equal(capabilities.profile, "mainnet-insecure");
  assert.equal(capabilities.signerMode, "local-software-key-accessible");
  assert.ok(capabilities.operations.includes("qos-token-transfer"));
  assert.ok(capabilities.operations.includes("agent-directed-qos-token-transfer"));
});
