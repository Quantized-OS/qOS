import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import { assertQos, QosError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function assertTrustedExecutable(command, errorPrefix = "EXTERNAL_COMMAND") {
  assertQos(typeof command === "string" && isAbsolute(command), `${errorPrefix}_CONFIG`, "External command must be an absolute path");
  let metadata;
  try {
    metadata = lstatSync(command);
  } catch {
    assertQos(false, `${errorPrefix}_CONFIG`, "External command is unavailable");
  }
  assertQos(metadata.isFile() && !metadata.isSymbolicLink(), `${errorPrefix}_CONFIG`, "External command must be a regular file, not a symbolic link");
  assertQos(metadata.nlink === 1, `${errorPrefix}_CONFIG`, "External command must have exactly one hard link");
  if (process.platform !== "win32") {
    const mode = metadata.mode & 0o777;
    assertQos((mode & 0o111) !== 0, `${errorPrefix}_CONFIG`, "External command is not executable");
    assertQos((mode & 0o022) === 0, `${errorPrefix}_CONFIG`, "External command must not be writable by group or other users");
    assertQos((metadata.mode & 0o6000) === 0, `${errorPrefix}_CONFIG`, "Set-user-ID and set-group-ID external commands are not accepted");
    if (typeof process.geteuid === "function") {
      const effectiveUid = process.geteuid();
      assertQos(effectiveUid === 0 || metadata.uid === 0 || metadata.uid === effectiveUid, `${errorPrefix}_CONFIG`, "External command must be owned by root or the service account");
    }
  }
  return command;
}

export function parseCommandArgs(text, field) {
  if (text === undefined) return [];
  let args;
  try {
    args = JSON.parse(text);
  } catch {
    throw new QosError("INVALID_COMMAND_ARGS", `${field} must be a JSON array of strings`);
  }
  assertQos(Array.isArray(args) && args.every((value) => typeof value === "string"), "INVALID_COMMAND_ARGS", `${field} must be a JSON array of strings`);
  assertQos(args.length <= 32 && args.every((value) => Buffer.byteLength(value) <= 4096), "INVALID_COMMAND_ARGS", `${field} exceeds the safe argument limit`);
  return args;
}

export function runJsonCommand(command, args, request, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  errorPrefix = "EXTERNAL_COMMAND",
} = {}) {
  assertTrustedExecutable(command, errorPrefix);
  assertQos(Array.isArray(args) && args.every((value) => typeof value === "string"), `${errorPrefix}_CONFIG`, "External command arguments are invalid");
  assertQos(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000, `${errorPrefix}_CONFIG`, "External command timeout is invalid");
  assertQos(Number.isInteger(maxOutputBytes) && maxOutputBytes >= 1024 && maxOutputBytes <= 1024 * 1024, `${errorPrefix}_CONFIG`, "External command output limit is invalid");

  const input = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  assertQos(input.length <= 256 * 1024, `${errorPrefix}_REQUEST_TOO_LARGE`, "External command request exceeds 256 KiB");

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutLength = 0;
    let stderrLength = 0;
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/",
      env: {
        PATH: SAFE_PATH,
        LANG: "C",
        LC_ALL: "C",
      },
    });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.fill(0);
      for (const chunk of stdout) chunk.fill(0);
      for (const chunk of stderr) chunk.fill(0);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new QosError(`${errorPrefix}_TIMEOUT`, "External command timed out"));
    }, timeoutMs);
    timer.unref?.();

    child.once("error", () => finish(new QosError(`${errorPrefix}_UNAVAILABLE`, "External command could not be started")));
    child.stdout.on("data", (chunk) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      stdoutLength += chunk.length;
      if (stdoutLength > maxOutputBytes) {
        child.kill("SIGKILL");
        chunk.fill(0);
        finish(new QosError(`${errorPrefix}_OUTPUT_TOO_LARGE`, "External command output exceeded the safe limit"));
        return;
      }
      stdout.push(Buffer.from(chunk));
      chunk.fill(0);
    });
    child.stderr.on("data", (chunk) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      stderrLength += chunk.length;
      if (stderrLength <= 4096) stderr.push(Buffer.from(chunk));
      chunk.fill(0);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        finish(new QosError(`${errorPrefix}_FAILED`, "External command failed closed", { exitCode: code, signal: signal ?? undefined }));
        return;
      }
      let value;
      let bytes;
      try {
        bytes = Buffer.concat(stdout);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        value = JSON.parse(text);
      } catch {
        finish(new QosError(`${errorPrefix}_INVALID_RESPONSE`, "External command returned invalid JSON"));
        return;
      } finally {
        bytes?.fill(0);
      }
      finish(undefined, value);
    });
    child.stdin.once("error", () => {});
    child.stdin.end(input);
  });
}
