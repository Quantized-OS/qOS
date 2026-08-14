import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { assertQos, publicError, QosError } from "./errors.js";

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function isAuthorized(request, token) {
  if (!token) return true;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(request) {
  assertQos(request.headers["content-type"]?.split(";", 1)[0].trim() === "application/json", "UNSUPPORTED_CONTENT_TYPE", "Content-Type must be application/json");
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      throw new QosError("BODY_TOO_LARGE", "Request body exceeds 16 KiB");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new QosError("INVALID_JSON", "Request body is not valid JSON");
  }
}

function loopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function startServer(service, { host = "127.0.0.1", port = 8787, apiToken = process.env.QOS_API_TOKEN } = {}) {
  assertQos(Number.isInteger(port) && port >= 1 && port <= 65535, "INVALID_PORT", "Port must be between 1 and 65535");
  if (!loopback(host)) {
    assertQos(typeof apiToken === "string" && apiToken.length >= 32, "API_TOKEN_REQUIRED", "A token of at least 32 characters is required for non-loopback binding");
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://qos.local");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, await service.health());
        return;
      }
      if (!isAuthorized(request, apiToken)) {
        sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Bearer token is missing or invalid" } });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/policy") {
        sendJson(response, 200, service.publicPolicy());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/intents/prepare") {
        sendJson(response, 200, await service.prepareIntent(await readJson(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/intents/submit") {
        sendJson(response, 200, await service.submitIntent(await readJson(request)));
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    } catch (error) {
      const status = error instanceof QosError ? 400 : 500;
      sendJson(response, status, publicError(error));
    }
  });
  server.requestTimeout = 75_000;
  server.headersTimeout = 10_000;
  server.listen(port, host);
  return server;
}
