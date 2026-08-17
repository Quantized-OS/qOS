import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { assertQos, publicError, QosError } from "./errors.js";
import { readSecureFile } from "./secure-file.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function isAuthorized(request, token) {
  const authorizationHeaders = request.headersDistinct?.authorization;
  if (!Array.isArray(authorizationHeaders) || authorizationHeaders.length !== 1) return false;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  try {
    return supplied.length === token.length && timingSafeEqual(supplied, token);
  } finally {
    supplied.fill(0);
  }
}

async function readJson(request) {
  const contentTypes = request.headersDistinct?.["content-type"];
  assertQos(Array.isArray(contentTypes) && contentTypes.length === 1 && contentTypes[0].split(";", 1)[0].trim() === "application/json", "UNSUPPORTED_CONTENT_TYPE", "Exactly one application/json Content-Type is required");
  assertQos(request.headers["content-encoding"] === undefined || request.headers["content-encoding"] === "identity", "UNSUPPORTED_CONTENT_ENCODING", "Compressed request bodies are not accepted");
  const contentLengths = request.headersDistinct?.["content-length"];
  assertQos(Array.isArray(contentLengths) && contentLengths.length === 1, "CONTENT_LENGTH_REQUIRED", "Exactly one Content-Length is required");
  const declaredLength = contentLengths[0];
  assertQos(/^(0|[1-9][0-9]*)$/.test(declaredLength), "INVALID_CONTENT_LENGTH", "Content-Length is invalid");
  assertQos(Number(declaredLength) <= MAX_BODY_BYTES, "BODY_TOO_LARGE", "Request body exceeds 16 KiB");
  const expectedLength = Number(declaredLength);
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      throw new QosError("BODY_TOO_LARGE", "Request body exceeds 16 KiB");
    }
    chunks.push(chunk);
  }
  assertQos(expectedLength === undefined || length === expectedLength, "INVALID_CONTENT_LENGTH", "Request body length does not match Content-Length");
  let body;
  try {
    body = Buffer.concat(chunks);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text);
  } catch {
    throw new QosError("INVALID_JSON", "Request body is not valid JSON");
  } finally {
    if (body) body.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function loopback(host) {
  return host === "127.0.0.1" || host === "::1";
}

function remoteIsLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function configuredApiToken(apiToken, apiTokenFile) {
  assertQos(!(apiToken !== undefined && apiTokenFile !== undefined), "API_TOKEN_CONFIG_CONFLICT", "Configure QOS_API_TOKEN_FILE or QOS_API_TOKEN, not both");
  let token;
  if (apiTokenFile !== undefined) {
    const fileBytes = readSecureFile(apiTokenFile, {
      privateFile: true,
      minBytes: 32,
      maxBytes: 1024,
      errorCode: "INSECURE_API_TOKEN_FILE",
      label: "API token file",
    });
    if (fileBytes[fileBytes.length - 1] === 0x0a) {
      const end = fileBytes.length > 1 && fileBytes[fileBytes.length - 2] === 0x0d
        ? fileBytes.length - 2
        : fileBytes.length - 1;
      token = Buffer.from(fileBytes.subarray(0, end));
      fileBytes.fill(0);
    } else {
      token = fileBytes;
    }
  } else if (typeof apiToken === "string") {
    token = Buffer.from(apiToken, "utf8");
  }
  try {
    assertQos(Buffer.isBuffer(token) && token.length > 0, "API_TOKEN_REQUIRED", "QOS_API_TOKEN_FILE or QOS_API_TOKEN is required for the HTTP service");
    assertQos(token.length >= 32 && token.length <= 512, "API_TOKEN_LENGTH_INVALID", "Configured API token must contain 32 to 512 bytes");
    assertQos(token.every((byte) => byte >= 0x21 && byte <= 0x7e), "API_TOKEN_FORMAT_INVALID", "Configured API token must contain visible ASCII bytes only");
    return token;
  } catch (error) {
    token?.fill(0);
    throw error;
  }
}

export function startServer(service, {
  host = "127.0.0.1",
  port = 8787,
  apiToken = process.env.QOS_API_TOKEN,
  apiTokenFile = process.env.QOS_API_TOKEN_FILE,
} = {}) {
  assertQos(Number.isInteger(port) && port >= 1 && port <= 65535, "INVALID_PORT", "Port must be between 1 and 65535");
  assertQos(loopback(host), "LOOPBACK_REQUIRED", "The built-in HTTP server is plaintext and may only bind to loopback; use a local TLS proxy or Unix-isolated deployment boundary");
  if (service?.policy?.cluster === "mainnet-beta") {
    assertQos(apiTokenFile !== undefined, "MAINNET_API_TOKEN_FILE_REQUIRED", "Mainnet service mode requires QOS_API_TOKEN_FILE instead of an environment token");
  }
  const expectedToken = configuredApiToken(apiToken, apiTokenFile);
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requireHostHeader: true }, async (request, response) => {
    try {
      assertQos(remoteIsLoopback(request.socket.remoteAddress), "REMOTE_CLIENT_FORBIDDEN", "The built-in HTTP service accepts loopback clients only");
      const hostHeaders = request.headersDistinct?.host;
      assertQos(Array.isArray(hostHeaders) && hostHeaders.length === 1 && hostHeaders[0].length >= 1 && hostHeaders[0].length <= 255, "INVALID_HOST_HEADER", "Exactly one bounded Host header is required");
      assertQos(request.headers["transfer-encoding"] === undefined, "TRANSFER_ENCODING_FORBIDDEN", "Transfer-Encoding is not accepted; send one bounded Content-Length");
      if (request.method === "GET") {
        const contentLengths = request.headersDistinct?.["content-length"];
        assertQos(contentLengths === undefined || (contentLengths.length === 1 && contentLengths[0] === "0"), "GET_BODY_FORBIDDEN", "GET requests may not contain a body");
      }
      assertQos(typeof request.url === "string" && request.url.startsWith("/") && !request.url.startsWith("//") && !request.url.includes("#"), "INVALID_REQUEST_TARGET", "HTTP request target must use origin form");
      const url = new URL(request.url, "http://qos.local");
      assertQos(url.search === "", "QUERY_STRING_NOT_ALLOWED", "API routes do not accept query strings");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (!isAuthorized(request, expectedToken)) {
        sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Bearer token is missing or invalid" } });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/policy") {
        sendJson(response, 200, service.publicPolicy());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/health") {
        sendJson(response, 200, await service.health());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/intents/prepare") {
        sendJson(response, 200, await service.prepareIntent(await readJson(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/token-intents/prepare") {
        sendJson(response, 200, await service.prepareTokenIntent(await readJson(request)));
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
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  server.once("close", () => expectedToken.fill(0));
  server.listen(port, host);
  return server;
}
