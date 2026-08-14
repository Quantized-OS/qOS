import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("mainnet initialization uses the new ephemeral home when no home is supplied", () => {
  const cwd = mkdtempSync(join(tmpdir(), "qos-cli-mainnet-"));
  const result = spawnSync(process.execPath, [join(ROOT, "bin", "qos.js"), "init", "--cluster", "mainnet-beta"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(cwd, ".qos-ephemeral-mainnet", "policy.json")), true);
  assert.equal(existsSync(join(cwd, ".qos-ephemeral-devnet")), false);
});
