import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import { assertQos, QosError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

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
  assertQos(typeof command === "string" && isAbsolute(command), `${errorPrefix}_CONFIG`, "External command must be an absolute path");
  assertQos(Array.isArray(args) && args.every((value) => typeof value === "string"), `${errorPrefix}_CONFIG`, "External command arguments are invalid");
  assertQos(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000, `${errorPrefix}_CONFIG`, "External command timeout is invalid");

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
      env: {
        PATH: process.env.PATH,
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
      stdoutLength += chunk.length;
      if (stdoutLength > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new QosError(`${errorPrefix}_OUTPUT_TOO_LARGE`, "External command output exceeded the safe limit"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength <= 4096) stderr.push(Buffer.from(chunk));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        finish(new QosError(`${errorPrefix}_FAILED`, "External command failed closed", { exitCode: code, signal: signal ?? undefined }));
        return;
      }
      let value;
      try {
        const bytes = Buffer.concat(stdout);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        bytes.fill(0);
        value = JSON.parse(text);
      } catch {
        finish(new QosError(`${errorPrefix}_INVALID_RESPONSE`, "External command returned invalid JSON"));
        return;
      }
      finish(undefined, value);
    });
    child.stdin.once("error", () => {});
    child.stdin.end(input);
  });
}
