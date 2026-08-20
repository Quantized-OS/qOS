import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("browser bootstrap help is side-effect free and documents verified GitHub setup", () => {
  const result = spawnSync("sh", [join(ROOT, "web", "install.sh"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /curl --proto '=https' --tlsv1\.2/);
  assert.match(result.stdout, /Quantized-OS\/qOS GitHub Release/);
  assert.match(result.stdout, /QOS_RELEASE_SHA256/);
  assert.match(result.stdout, /mainnet wizard first asks whether/);
  const bootstrap = readFileSync(join(ROOT, "web", "install.sh"), "utf8");
  assert.match(bootstrap, /https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\/releases\/latest\/download/);
  assert.match(bootstrap, /source archive checksum mismatch/);
  assert.match(bootstrap, /setup\.sh" install --wizard/);
  assert.equal(existsSync(join(ROOT, "install.sh")), false);
});

test("macOS wrapper exposes side-effect-free help and delegates to isolated Lima Ubuntu", () => {
  const installer = join(ROOT, "web", "install-macos.sh");
  const result = spawnSync("sh", [installer, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Homebrew/);
  assert.match(result.stdout, /limactl shell qos/);
  assert.match(result.stdout, /asks whether to use your existing external key/);
  const source = readFileSync(installer, "utf8");
  assert.match(source, /brew install lima/);
  assert.match(source, /--mount-none/);
  assert.match(source, /template:ubuntu-24\.04/);
  assert.match(source, /ubuntu\\\|20\.04\|ubuntu\\\|22\.04\|ubuntu\\\|24\.04/);
  assert.match(source, /limactl shell --start --tty=true/);
  assert.match(source, /https:\/\/qos\.systems\/install\.sh/);
});

test("Windows wrapper provisions WSL Ubuntu and preserves explicit setup modes", () => {
  const source = readFileSync(join(ROOT, "web", "install-windows.ps1"), "utf8");
  assert.match(source, /wsl\.exe/);
  assert.match(source, /--install", "-d", "Ubuntu-24\.04"/);
  assert.match(source, /QOS_SETUP_MODE/);
  assert.match(source, /default mainnet wizard asks whether/);
  assert.match(source, /"devnet" \{ " -s -- --devnet" \}/);
  assert.match(source, /"insecure" \{ " -s -- --insecure" \}/);
  assert.match(source, /https:\/\/qos\.systems\/install\.sh/);
});

test("web release builder emits the front page and thin platform bootstraps", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-web-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "releases", "latest"), { recursive: true });
  writeFileSync(join(root, "releases", "latest", "qos-source.tar.gz"), "retired embedded payload\n");
  const result = spawnSync("python3", [join(ROOT, "scripts", "build-web-release.py"), "--output", root], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "index.html")), true);
  assert.equal(existsSync(join(root, "install.sh")), true);
  assert.equal(existsSync(join(root, "install-macos.sh")), true);
  assert.equal(existsSync(join(root, "install-windows.ps1")), true);
  assert.equal(existsSync(join(root, "releases")), false);
  assert.equal(existsSync(join(root, "qos-source.tar.gz")), false);
  const homepage = readFileSync(join(root, "index.html"), "utf8");
  assert.match(homepage, /Choose your system/);
  assert.match(homepage, /data-os="linux"/);
  assert.match(homepage, /data-os="macos"/);
  assert.match(homepage, /data-os="windows"/);
  assert.match(homepage, /wizard first asks whether to use your existing external key or generate a local key/);
  const manifest = JSON.parse(readFileSync(join(root, "RELEASE.json"), "utf8"));
  assert.equal(manifest.version, "0.14.0");
  assert.equal(manifest.homepage, "index.html");
  assert.deepEqual(manifest.bootstraps, {
    linux: "install.sh",
    macos: "install-macos.sh",
    windows: "install-windows.ps1",
  });
  assert.equal(manifest.repository, "https://github.com/Quantized-OS/qOS");
  assert.equal(manifest.source, "https://github.com/Quantized-OS/qOS/releases/latest/download/qos-source.tar.gz");
  assert.equal(manifest.checksums, "https://github.com/Quantized-OS/qOS/releases/latest/download/SHA256SUMS.txt");
});

test("GitHub release builder emits the exact verified installer assets", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qos-github-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("python3", [join(ROOT, "scripts", "build-github-release.py"), "--output", root], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "qos-source.tar.gz")), true);
  const checksum = readFileSync(join(root, "SHA256SUMS.txt"), "ascii");
  assert.match(checksum, /^[0-9a-f]{64}  qos-source\.tar\.gz\n$/);
  const archive = readFileSync(join(root, "qos-source.tar.gz"));
  assert.equal(createHash("sha256").update(archive).digest("hex"), checksum.slice(0, 64));
  const listing = spawnSync("tar", ["-tzf", join(root, "qos-source.tar.gz")], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /^qos-0\.14\.0\//m);
  assert.match(listing.stdout, /^qos-0\.14\.0\/setup\.sh$/m);
  assert.match(listing.stdout, /^qos-0\.14\.0\/web\/index\.html$/m);
  assert.match(listing.stdout, /^qos-0\.14\.0\/web\/install-macos\.sh$/m);
  assert.match(listing.stdout, /^qos-0\.14\.0\/web\/install-windows\.ps1$/m);
  assert.doesNotMatch(listing.stdout, /^qos-0\.14\.0\/install\.sh$/m);
  const manifest = JSON.parse(readFileSync(join(root, "RELEASE.json"), "utf8"));
  assert.equal(manifest.version, "0.14.0");
  assert.equal(manifest.repository, "Quantized-OS/qOS");
  assert.equal(manifest.source_sha256, checksum.slice(0, 64));
});
