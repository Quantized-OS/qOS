import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";

import { QosError } from "./errors.js";
import { assertPrivateDirectory, readSecureFile } from "./secure-file.js";

export function readPrivateJson(path, {
  maxBytes = 256 * 1024,
  errorCode = "INVALID_PRIVATE_JSON",
  label = "Private JSON file",
} = {}) {
  const bytes = readSecureFile(path, {
    privateFile: true,
    maxBytes,
    errorCode,
    label,
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof QosError) throw error;
    throw new QosError(errorCode, `${label} is not valid UTF-8 JSON`);
  } finally {
    bytes.fill(0);
  }
}

export function writePrivateJsonAtomic(path, value, {
  errorCode = "PRIVATE_JSON_WRITE_FAILED",
  label = "Private JSON file",
} = {}) {
  const parent = dirname(path);
  assertPrivateDirectory(parent, { errorCode, label: `${label} directory` });
  if (existsSync(path)) {
    const probe = readSecureFile(path, {
      privateFile: true,
      maxBytes: 256 * 1024,
      errorCode,
      label,
    });
    probe.fill(0);
  }
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    throw new QosError(errorCode, `${label} could not be updated atomically`);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch {}
    }
  }
}
