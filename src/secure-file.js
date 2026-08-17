import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";

import { assertQos, QosError } from "./errors.js";

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left, right) {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertSecureMetadata(metadata, {
  privateFile,
  requireSingleLink,
  minBytes,
  maxBytes,
  errorCode,
  label,
}) {
  assertQos(metadata.isFile(), errorCode, `${label} must be a regular file`);
  assertQos(!requireSingleLink || metadata.nlink === 1, errorCode, `${label} must have exactly one hard link`);
  assertQos(
    Number.isSafeInteger(metadata.size) && metadata.size >= minBytes && metadata.size <= maxBytes,
    errorCode,
    `${label} size is outside the permitted range`,
  );

  if (process.platform === "win32") return;
  const mode = metadata.mode & 0o777;
  if (privateFile) {
    assertQos((mode & 0o077) === 0, errorCode, `${label} must not be accessible by group or other users`);
  } else {
    assertQos((mode & 0o022) === 0, errorCode, `${label} must not be writable by group or other users`);
  }

  if (typeof process.geteuid === "function") {
    const effectiveUid = process.geteuid();
    assertQos(
      metadata.uid === effectiveUid || (!privateFile && metadata.uid === 0),
      errorCode,
      `${label} must be owned by the service account or root`,
    );
  }
}

/**
 * Open a security-sensitive file without following a final-component symlink,
 * bind the read to the inode inspected before open, and enforce a size and
 * permission policy. The returned Buffer belongs to the caller and should be
 * cleared when it contains secret material.
 */
export function readSecureFile(path, {
  privateFile = false,
  requireSingleLink = true,
  minBytes = 1,
  maxBytes,
  errorCode = "INSECURE_FILE",
  label = "Security-sensitive file",
} = {}) {
  assertQos(typeof path === "string" && path.length > 0, errorCode, `${label} path is invalid`);
  assertQos(typeof requireSingleLink === "boolean", errorCode, `${label} hard-link policy is invalid`);
  assertQos(Number.isSafeInteger(maxBytes) && maxBytes >= minBytes, errorCode, `${label} size policy is invalid`);

  let before;
  try {
    before = lstatSync(path);
  } catch {
    throw new QosError(errorCode, `${label} is unavailable`);
  }
  assertSecureMetadata(before, { privateFile, requireSingleLink, minBytes, maxBytes, errorCode, label });

  let descriptor;
  let bytes;
  let probe;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const closeOnExec = constants.O_CLOEXEC ?? 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow | closeOnExec);
    const opened = fstatSync(descriptor);
    assertQos(sameFile(before, opened), errorCode, `${label} changed while it was being opened`);
    assertSecureMetadata(opened, { privateFile, requireSingleLink, minBytes, maxBytes, errorCode, label });
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      assertQos(count > 0, errorCode, `${label} changed while it was being read`);
      offset += count;
    }
    probe = Buffer.alloc(1);
    assertQos(readSync(descriptor, probe, 0, 1, null) === 0, errorCode, `${label} grew while it was being read`);
    const after = fstatSync(descriptor);
    assertQos(
      sameVersion(opened, after),
      errorCode,
      `${label} changed while it was being read`,
    );
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof QosError) throw error;
    throw new QosError(errorCode, `${label} could not be read safely`);
  } finally {
    probe?.fill(0);
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        bytes?.fill(0);
        throw new QosError(errorCode, `${label} could not be closed safely`);
      }
    }
  }
}

export function assertPrivateDirectory(path, {
  errorCode = "INSECURE_DIRECTORY",
  label = "Security directory",
} = {}) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new QosError(errorCode, `${label} is unavailable`);
  }
  assertQos(metadata.isDirectory() && !metadata.isSymbolicLink(), errorCode, `${label} must be a directory, not a symbolic link`);
  if (process.platform === "win32") return path;
  assertQos((metadata.mode & 0o077) === 0, errorCode, `${label} must not be accessible by group or other users`);
  if (typeof process.geteuid === "function") {
    assertQos(metadata.uid === process.geteuid(), errorCode, `${label} must be owned by the service account`);
  }
  return path;
}
