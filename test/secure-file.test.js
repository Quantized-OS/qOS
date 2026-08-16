import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSecureFile } from "../src/secure-file.js";

test("secure file reads reject hard links, exposed secrets, and oversized input", { skip: process.platform === "win32" }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qos-secure-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "secret");
  writeFileSync(source, "a".repeat(64), { mode: 0o600 });

  const linked = join(directory, "linked-secret");
  linkSync(source, linked);
  assert.throws(
    () => readSecureFile(source, { privateFile: true, maxBytes: 128 }),
    { code: "INSECURE_FILE" },
  );

  const exposed = join(directory, "exposed-secret");
  writeFileSync(exposed, "b".repeat(64), { mode: 0o600 });
  chmodSync(exposed, 0o640);
  assert.throws(
    () => readSecureFile(exposed, { privateFile: true, maxBytes: 128 }),
    { code: "INSECURE_FILE" },
  );

  const oversized = join(directory, "oversized");
  writeFileSync(oversized, "c".repeat(129), { mode: 0o600 });
  assert.throws(
    () => readSecureFile(oversized, { privateFile: true, maxBytes: 128 }),
    { code: "INSECURE_FILE" },
  );
});
