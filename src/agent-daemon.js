import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasExactKeys } from "./canonical.js";
import { assertQos, QosError } from "./errors.js";
import { readPrivateJson, writePrivateJsonAtomic } from "./private-json.js";
import { assertPrivateDirectory, readSecureFile } from "./secure-file.js";

const AGENT_CONTROL = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/qos-agent-control.js");
const STATE_KEYS = [
  "version", "pid", "instanceId", "home", "host", "port", "restEndpoint",
  "mcpEndpoint", "startedAt", "mainnetExecutionEnabled",
];

export function listenerPaths(home) {
  const resolvedHome = resolve(home);
  return {
    home: resolvedHome,
    agents: join(resolvedHome, "agents"),
    state: join(resolvedHome, "agents", "listener.json"),
    log: join(resolvedHome, "agents", "listener.log"),
  };
}

function validateState(state, home) {
  assertQos(state && typeof state === "object" && !Array.isArray(state) && hasExactKeys(state, STATE_KEYS), "INVALID_AGENT_LISTENER_STATE", "Agent listener state has missing or unknown fields");
  assertQos(state.version === 1, "INVALID_AGENT_LISTENER_STATE", "Agent listener state version is unsupported");
  assertQos(Number.isInteger(state.pid) && state.pid > 1, "INVALID_AGENT_LISTENER_STATE", "Agent listener PID is invalid");
  assertQos(typeof state.instanceId === "string" && /^[0-9a-f]{64}$/.test(state.instanceId), "INVALID_AGENT_LISTENER_STATE", "Agent listener instance ID is invalid");
  assertQos(resolve(state.home) === resolve(home), "INVALID_AGENT_LISTENER_STATE", "Agent listener home does not match its profile");
  assertQos(state.host === "127.0.0.1" || state.host === "::1", "INVALID_AGENT_LISTENER_STATE", "Agent listener host is not loopback");
  assertQos(Number.isInteger(state.port) && state.port >= 1 && state.port <= 65535, "INVALID_AGENT_LISTENER_STATE", "Agent listener port is invalid");
  const origin = `http://${state.host === "::1" ? "[::1]" : state.host}:${state.port}`;
  assertQos(state.restEndpoint === `${origin}/v1/actions` && state.mcpEndpoint === `${origin}/mcp`, "INVALID_AGENT_LISTENER_STATE", "Agent listener endpoints are invalid");
  assertQos(typeof state.startedAt === "string" && Number.isFinite(Date.parse(state.startedAt)), "INVALID_AGENT_LISTENER_STATE", "Agent listener start time is invalid");
  assertQos(typeof state.mainnetExecutionEnabled === "boolean", "INVALID_AGENT_LISTENER_STATE", "Agent listener live-mode state is invalid");
  return Object.freeze({ ...state });
}

function readState(home) {
  const paths = listenerPaths(home);
  assertPrivateDirectory(paths.home, { errorCode: "INSECURE_SANDBOX_HOME", label: "qOS profile home" });
  if (!existsSync(paths.agents)) return null;
  assertPrivateDirectory(paths.agents, { errorCode: "INSECURE_AGENT_DIRECTORY", label: "Agent registry directory" });
  if (!existsSync(paths.state)) return null;
  return validateState(readPrivateJson(paths.state, {
    errorCode: "INVALID_AGENT_LISTENER_STATE",
    label: "Agent listener state",
  }), paths.home);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new QosError("AGENT_LISTENER_PROCESS_CHECK_FAILED", "Could not verify the managed agent listener process");
  }
}

function processIdentityMatches(state) {
  if (process.platform !== "linux") return false;
  let argv;
  try {
    argv = readFileSync(`/proc/${state.pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
  } catch {
    return false;
  }
  const pair = (name, value) => argv.some((item, index) => item === name && argv[index + 1] === value);
  return argv.includes(AGENT_CONTROL)
    && argv.includes("listen")
    && argv.includes("--daemon-child")
    && pair("--home", state.home)
    && pair("--instance", state.instanceId);
}

function removeState(paths, expectedInstance) {
  if (!existsSync(paths.state)) return;
  const state = readState(paths.home);
  if (state?.instanceId !== expectedInstance) return;
  unlinkSync(paths.state);
}

function listenerResult(state, status) {
  return {
    status,
    pid: state.pid,
    address: state.restEndpoint.slice(0, -"/v1/actions".length),
    restEndpoint: state.restEndpoint,
    mcpEndpoint: state.mcpEndpoint,
    mainnetExecutionEnabled: state.mainnetExecutionEnabled,
    logFile: listenerPaths(state.home).log,
  };
}

function operatorToken(home) {
  const bytes = readSecureFile(join(resolve(home), "api-token"), {
    privateFile: true,
    minBytes: 32,
    maxBytes: 1024,
    errorCode: "INSECURE_API_TOKEN_FILE",
    label: "Operator API token file",
  });
  let end = bytes.length;
  if (bytes[end - 1] === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  const token = Buffer.from(bytes.subarray(0, end));
  bytes.fill(0);
  return token;
}

async function requestManagedShutdown(state) {
  const token = operatorToken(state.home);
  try {
    const response = await fetch(`${state.restEndpoint.slice(0, -"/v1/actions".length)}/v1/operator/shutdown`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.toString("utf8")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, instanceId: state.instanceId }),
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    token.fill(0);
  }
}

async function managedListenerResponds(state) {
  const token = operatorToken(state.home);
  try {
    const origin = state.restEndpoint.slice(0, -"/v1/actions".length);
    const response = await fetch(`${origin}/v1/operator/status`, {
      headers: { authorization: `Bearer ${token.toString("utf8")}` },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    const length = response.headers.get("content-length");
    if (response.status !== 200 || length === null || !/^[1-9][0-9]*$/.test(length) || Number(length) > 4096) return false;
    const value = await response.json();
    return value?.status === "listening"
      && value?.instanceId === state.instanceId
      && value?.mainnetExecutionEnabled === state.mainnetExecutionEnabled;
  } catch {
    return false;
  } finally {
    token.fill(0);
  }
}

export async function agentListenerStatus(home, { cleanStale = true } = {}) {
  const paths = listenerPaths(home);
  const state = readState(paths.home);
  if (state === null) return { status: "stopped", restEndpoint: null, mcpEndpoint: null };
  if (!processAlive(state.pid)) {
    if (cleanStale) removeState(paths, state.instanceId);
    return { status: "stopped", restEndpoint: null, mcpEndpoint: null, staleStateRemoved: cleanStale };
  }
  assertQos(await managedListenerResponds(state), "AGENT_LISTENER_IDENTITY_MISMATCH", "Listener state is occupied by a process that does not authenticate as this qOS profile; it was not trusted");
  return listenerResult(state, "listening");
}

function openPrivateLog(path) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags, 0o600);
  const metadata = lstatSync(path);
  try {
    assertQos(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid() && metadata.nlink === 1 && (metadata.mode & 0o077) === 0, "INSECURE_AGENT_LISTENER_LOG", "Agent listener log must be one owner-only regular file");
    chmodSync(path, 0o600);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function parsePort(value) {
  const text = String(value);
  assertQos(/^[1-9][0-9]*$/.test(text), "INVALID_PORT", "Agent listener port must be between 1 and 65535");
  const port = Number(text);
  assertQos(Number.isInteger(port) && port <= 65535, "INVALID_PORT", "Agent listener port must be between 1 and 65535");
  return port;
}

export async function startAgentDaemon(home, {
  host = "127.0.0.1",
  port = 8790,
  confirmLive = false,
  timeoutMs = 8_000,
} = {}) {
  const paths = listenerPaths(home);
  assertPrivateDirectory(paths.agents, { errorCode: "INSECURE_AGENT_DIRECTORY", label: "Agent registry directory" });
  assertQos(host === "127.0.0.1" || host === "::1", "LOOPBACK_REQUIRED", "The agent API and MCP service may bind only to loopback");
  const selectedPort = parsePort(port);
  const current = await agentListenerStatus(paths.home);
  if (current.status === "listening") {
    assertQos(current.address === `http://${host === "::1" ? "[::1]" : host}:${selectedPort}`, "AGENT_LISTENER_ALREADY_RUNNING", `A managed qOS listener is already running at ${current.address}; stop it before changing its address`);
    assertQos(!confirmLive || current.mainnetExecutionEnabled, "AGENT_LISTENER_RESTART_REQUIRED", "Restart the listener with --confirm-live to enable mainnet execution");
    return { ...current, status: "already-listening" };
  }

  const instanceId = randomBytes(32).toString("hex");
  const logDescriptor = openPrivateLog(paths.log);
  let child;
  let spawnFailure = null;
  let exited = false;
  try {
    const args = [
      AGENT_CONTROL,
      "--home", paths.home,
      "--json",
      "listen",
      "--host", host,
      "--port", String(selectedPort),
      "--daemon-child",
      "--instance", instanceId,
      ...(confirmLive ? ["--confirm-live"] : []),
    ];
    child = spawn(process.execPath, args, {
      cwd: "/",
      detached: true,
      env: { ...process.env, QOS_AGENT_AUTOSERVE: "0" },
      stdio: ["ignore", logDescriptor, logDescriptor],
      shell: false,
    });
    child.once("error", (error) => { spawnFailure = error; });
    child.once("exit", () => { exited = true; });
    child.unref();
  } finally {
    closeSync(logDescriptor);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnFailure !== null || exited) break;
    let state = null;
    try { state = readState(paths.home); } catch {}
    if (state?.instanceId === instanceId && state.pid === child.pid && processAlive(state.pid)) {
      return listenerResult(state, "started");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  if (child?.pid && processAlive(child.pid)) {
    const syntheticState = {
      version: 1,
      pid: child.pid,
      instanceId,
      home: paths.home,
      host,
      port: selectedPort,
      restEndpoint: `http://${host === "::1" ? "[::1]" : host}:${selectedPort}/v1/actions`,
      mcpEndpoint: `http://${host === "::1" ? "[::1]" : host}:${selectedPort}/mcp`,
      startedAt: new Date().toISOString(),
      mainnetExecutionEnabled: confirmLive,
    };
    if (processIdentityMatches(syntheticState)) process.kill(child.pid, "SIGTERM");
  }
  throw new QosError("AGENT_LISTENER_START_FAILED", `The agent was created, but its loopback API/MCP service did not start. Inspect ${paths.log} and run qos-agent start`);
}

export function writeAgentListenerState(home, {
  instanceId,
  host,
  port,
  mainnetExecutionEnabled,
} = {}) {
  const paths = listenerPaths(home);
  assertQos(typeof instanceId === "string" && /^[0-9a-f]{64}$/.test(instanceId), "INVALID_AGENT_LISTENER_INSTANCE", "Managed listener instance ID is invalid");
  const selectedPort = parsePort(port);
  const origin = `http://${host === "::1" ? "[::1]" : host}:${selectedPort}`;
  const state = validateState({
    version: 1,
    pid: process.pid,
    instanceId,
    home: paths.home,
    host,
    port: selectedPort,
    restEndpoint: `${origin}/v1/actions`,
    mcpEndpoint: `${origin}/mcp`,
    startedAt: new Date().toISOString(),
    mainnetExecutionEnabled: Boolean(mainnetExecutionEnabled),
  }, paths.home);
  writePrivateJsonAtomic(paths.state, state, {
    errorCode: "AGENT_LISTENER_STATE_WRITE_FAILED",
    label: "Agent listener state",
  });
  return state;
}

export function clearAgentListenerState(home, instanceId) {
  removeState(listenerPaths(home), instanceId);
}

export async function stopAgentDaemon(home, { timeoutMs = 5_000 } = {}) {
  const paths = listenerPaths(home);
  const state = readState(paths.home);
  if (state === null) return { status: "stopped", wasRunning: false };
  const shutdownAccepted = await requestManagedShutdown(state);
  if (shutdownAccepted) {
    const gracefulDeadline = Date.now() + timeoutMs;
    while (Date.now() < gracefulDeadline) {
      if (!existsSync(paths.state) || !await managedListenerResponds(state)) {
        removeState(paths, state.instanceId);
        return { status: "stopped", wasRunning: true, pid: state.pid };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  } else if (!processAlive(state.pid)) {
    removeState(paths, state.instanceId);
    return { status: "stopped", wasRunning: false, staleStateRemoved: true };
  }
  assertQos(processIdentityMatches(state), "AGENT_LISTENER_IDENTITY_MISMATCH", "Listener state could not be stopped through its authenticated endpoint and does not match its process; refusing to signal it");
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(state.pid)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  if (processAlive(state.pid)) {
    assertQos(processIdentityMatches(state), "AGENT_LISTENER_IDENTITY_MISMATCH", "Managed listener identity changed while stopping; refusing a forced signal");
    process.kill(state.pid, "SIGKILL");
  }
  removeState(paths, state.instanceId);
  return { status: "stopped", wasRunning: true, pid: state.pid };
}
