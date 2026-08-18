import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import { hasExactKeys } from "./canonical.js";
import { assertQos } from "./errors.js";
import { readSecureFile } from "./secure-file.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);
const PROFILE_KEYS = [
  "version",
  "id",
  "provider",
  "protocol",
  "model",
  "endpoint",
  "credentialSha256",
];
const MODEL_PROFILE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const MAX_MODEL_RESPONSE_BYTES = 64 * 1024;
const MAX_MODEL_CONTENT_LENGTH = 4096;
const MAX_PROMPT_LENGTH = 16 * 1024;

function definition(value) {
  return Object.freeze(value);
}

const PROVIDERS = Object.freeze({
  local: definition({
    name: "Local OpenAI-compatible",
    protocol: "openai-chat",
    auth: "none",
    endpoint: null,
    endpointMode: "loopback",
    tokenField: "max_tokens",
  }),
  openai: definition({
    name: "OpenAI",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.openai.com/v1/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_completion_tokens",
  }),
  anthropic: definition({
    name: "Anthropic Claude",
    protocol: "anthropic-messages",
    auth: "anthropic-key",
    endpoint: "https://api.anthropic.com/v1/messages",
    endpointMode: "fixed",
  }),
  google: definition({
    name: "Google Gemini",
    protocol: "gemini-generate-content",
    auth: "google-key",
    endpoint: null,
    endpointMode: "gemini-model",
  }),
  cohere: definition({
    name: "Cohere",
    protocol: "cohere-chat",
    auth: "bearer",
    endpoint: "https://api.cohere.com/v2/chat",
    endpointMode: "fixed",
  }),
  xai: definition({
    name: "xAI",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.x.ai/v1/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  groq: definition({
    name: "Groq",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  mistral: definition({
    name: "Mistral AI",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  deepseek: definition({
    name: "DeepSeek",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.deepseek.com/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  openrouter: definition({
    name: "OpenRouter",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  together: definition({
    name: "Together AI",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.together.xyz/v1/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  fireworks: definition({
    name: "Fireworks AI",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  perplexity: definition({
    name: "Perplexity",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.perplexity.ai/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  cerebras: definition({
    name: "Cerebras",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: "https://api.cerebras.ai/v1/chat/completions",
    endpointMode: "fixed",
    tokenField: "max_tokens",
  }),
  "azure-openai": definition({
    name: "Azure OpenAI",
    protocol: "openai-chat",
    auth: "azure-key",
    endpoint: null,
    endpointMode: "azure",
    tokenField: "max_tokens",
  }),
  "custom-openai": definition({
    name: "Custom OpenAI-compatible",
    protocol: "openai-chat",
    auth: "bearer",
    endpoint: null,
    endpointMode: "custom",
    tokenField: "max_tokens",
  }),
  "custom-anthropic": definition({
    name: "Custom Anthropic-compatible",
    protocol: "anthropic-messages",
    auth: "anthropic-key",
    endpoint: null,
    endpointMode: "custom",
  }),
  "custom-gemini": definition({
    name: "Custom Gemini-compatible",
    protocol: "gemini-generate-content",
    auth: "google-key",
    endpoint: null,
    endpointMode: "custom",
  }),
  "custom-cohere": definition({
    name: "Custom Cohere-compatible",
    protocol: "cohere-chat",
    auth: "bearer",
    endpoint: null,
    endpointMode: "custom",
  }),
});

function parseEndpoint(endpoint, mode) {
  assertQos(typeof endpoint === "string" && endpoint.length >= 1 && endpoint.length <= 2048, "MODEL_ENDPOINT_INVALID", "Model endpoint is invalid");
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    assertQos(false, "MODEL_ENDPOINT_INVALID", "Model endpoint is not a valid URL");
  }
  assertQos(!parsed.username && !parsed.password && parsed.hash === "", "MODEL_ENDPOINT_INVALID", "Model endpoint must not contain credentials or a fragment");
  assertQos(parsed.pathname !== "/" && parsed.pathname !== "", "MODEL_ENDPOINT_INVALID", "Model endpoint must include an API path");
  if (mode === "loopback") {
    assertQos(parsed.protocol === "http:" || parsed.protocol === "https:", "MODEL_ENDPOINT_INVALID", "Local model endpoint must use HTTP or HTTPS");
    assertQos(LOOPBACK_HOSTS.has(parsed.hostname), "AGENT_MODEL_REMOTE_FORBIDDEN", "Local model endpoint must stay on the local machine");
  } else {
    assertQos(parsed.protocol === "https:", "MODEL_ENDPOINT_TLS_REQUIRED", "Remote model endpoints must use HTTPS");
  }
  return parsed.toString();
}

function resolvedEndpoint(provider, model, endpoint, allowCustomEndpoint) {
  if (provider.endpointMode === "fixed") {
    assertQos(endpoint === undefined || endpoint === null || endpoint === provider.endpoint, "MODEL_ENDPOINT_FIXED", "This provider uses a fixed audited API endpoint; select a custom provider for a gateway or proxy");
    return provider.endpoint;
  }
  if (provider.endpointMode === "gemini-model") {
    const resource = model.startsWith("models/") || model.startsWith("tunedModels/") ? model : `models/${model}`;
    const encodedResource = resource.split("/").map(encodeURIComponent).join("/");
    const expected = `https://generativelanguage.googleapis.com/v1beta/${encodedResource}:generateContent`;
    assertQos(endpoint === undefined || endpoint === null || endpoint === expected, "MODEL_ENDPOINT_FIXED", "Google Gemini uses its fixed API endpoint; select custom-gemini for a gateway or proxy");
    return expected;
  }
  if (provider.endpointMode === "loopback") return parseEndpoint(endpoint, "loopback");
  assertQos(allowCustomEndpoint === true, "CUSTOM_MODEL_ENDPOINT_ACKNOWLEDGEMENT_REQUIRED", "Custom remote endpoints require --allow-custom-endpoint because the configured API key will be sent there");
  const parsed = new URL(parseEndpoint(endpoint, "remote"));
  if (provider.endpointMode === "azure") {
    assertQos(parsed.hostname.endsWith(".openai.azure.com"), "MODEL_ENDPOINT_INVALID", "Azure OpenAI endpoint must use a host ending in .openai.azure.com");
    assertQos(/^\/openai\/deployments\/[^/]+\/chat\/completions$/u.test(parsed.pathname), "MODEL_ENDPOINT_INVALID", "Azure OpenAI endpoint must target a deployment chat/completions path");
    assertQos(parsed.searchParams.has("api-version"), "MODEL_ENDPOINT_INVALID", "Azure OpenAI endpoint must include api-version");
  }
  return parsed.toString();
}

export function modelProviderCatalog() {
  return Object.entries(PROVIDERS).map(([id, provider]) => Object.freeze({
    id,
    name: provider.name,
    protocol: provider.protocol,
    credentialRequired: provider.auth !== "none",
    endpoint: provider.endpoint,
    endpointMode: provider.endpointMode,
  }));
}

export function createModelProviderProfile({
  id,
  provider,
  model,
  endpoint = undefined,
  credentialSha256 = null,
  allowCustomEndpoint = false,
} = {}) {
  assertQos(typeof id === "string" && MODEL_PROFILE_ID.test(id), "MODEL_PROFILE_ID_INVALID", "Model profile ID must start with a lowercase letter and contain at most 32 lowercase letters, digits, or hyphens");
  assertQos(typeof provider === "string" && Object.hasOwn(PROVIDERS, provider), "MODEL_PROVIDER_UNSUPPORTED", "Model provider is unsupported; use qos model catalog to list built-in and compatible providers");
  assertQos(typeof model === "string" && MODEL_NAME.test(model), "MODEL_NAME_INVALID", "Model name contains unsupported characters or is too long");
  const selected = PROVIDERS[provider];
  const resolved = resolvedEndpoint(selected, model, endpoint, allowCustomEndpoint);
  if (selected.auth === "none") {
    assertQos(credentialSha256 === null, "MODEL_CREDENTIAL_FORBIDDEN", "Local model profiles must not contain an API key");
  } else {
    assertQos(typeof credentialSha256 === "string" && /^[0-9a-f]{64}$/.test(credentialSha256), "MODEL_CREDENTIAL_INVALID", "Remote model profile credential hash is invalid");
  }
  return Object.freeze({
    version: 1,
    id,
    provider,
    protocol: selected.protocol,
    model,
    endpoint: resolved,
    credentialSha256,
  });
}

export function validateModelProviderProfile(record) {
  assertQos(record && typeof record === "object" && !Array.isArray(record) && hasExactKeys(record, PROFILE_KEYS), "MODEL_PROFILE_INVALID", "Model profile has missing or unknown fields");
  assertQos(record.version === 1, "MODEL_PROFILE_INVALID", "Model profile version is unsupported");
  const normalized = createModelProviderProfile({
    ...record,
    allowCustomEndpoint: true,
  });
  assertQos(normalized.protocol === record.protocol && normalized.endpoint === record.endpoint, "MODEL_PROFILE_INVALID", "Model profile protocol or endpoint does not match its provider");
  return normalized;
}

export function publicModelProviderProfile(record) {
  const profile = validateModelProviderProfile(record);
  const { credentialSha256: _credentialSha256, ...safe } = profile;
  return Object.freeze({
    ...safe,
    credentialConfigured: profile.credentialSha256 !== null,
  });
}

function credentialText(credentialFile, expectedSha256) {
  const bytes = readSecureFile(credentialFile, {
    privateFile: true,
    minBytes: 8,
    maxBytes: 4096,
    errorCode: "MODEL_CREDENTIAL_INSECURE",
    label: "Model provider API key file",
  });
  try {
    let end = bytes.length;
    if (bytes[end - 1] === 0x0a) end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
    const key = bytes.subarray(0, end);
    assertQos(key.length >= 8 && key.length <= 2048 && key.every((byte) => byte >= 0x21 && byte <= 0x7e), "MODEL_CREDENTIAL_INVALID", "Model provider API key must contain 8 to 2048 visible ASCII bytes");
    const actual = createHash("sha256").update(key).digest();
    const expected = Buffer.from(expectedSha256, "hex");
    try {
      assertQos(timingSafeEqual(actual, expected), "MODEL_CREDENTIAL_MISMATCH", "Model provider API key does not match its registered profile");
    } finally {
      actual.fill(0);
      expected.fill(0);
    }
    return key.toString("ascii");
  } finally {
    bytes.fill(0);
  }
}

function requestHeaders(provider, apiKey) {
  const headers = {
    accept: "application/json",
    "accept-encoding": "identity",
    "content-type": "application/json",
  };
  if (provider.auth === "bearer") headers.authorization = `Bearer ${apiKey}`;
  if (provider.auth === "anthropic-key") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  if (provider.auth === "google-key") headers["x-goog-api-key"] = apiKey;
  if (provider.auth === "azure-key") headers["api-key"] = apiKey;
  return headers;
}

function requestBody(provider, profile, system, prompt) {
  if (provider.protocol === "openai-chat") {
    return {
      model: profile.model,
      temperature: 0,
      [provider.tokenField]: 256,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    };
  }
  if (provider.protocol === "anthropic-messages") {
    return {
      model: profile.model,
      max_tokens: 256,
      temperature: 0,
      system,
      messages: [{ role: "user", content: prompt }],
    };
  }
  if (provider.protocol === "gemini-generate-content") {
    return {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      },
    };
  }
  return {
    model: profile.model,
    stream: false,
    temperature: 0,
    max_tokens: 256,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  };
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type");
  assertQos(typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType), "AGENT_MODEL_INVALID", "Model provider response must use application/json");
  const contentEncoding = response.headers.get("content-encoding");
  assertQos(contentEncoding === null || contentEncoding === "identity", "AGENT_MODEL_INVALID", "Compressed model provider responses are not accepted");
  const declaredLength = response.headers.get("content-length");
  let expectedLength;
  if (declaredLength !== null) {
    assertQos(/^(0|[1-9][0-9]*)$/.test(declaredLength), "AGENT_MODEL_INVALID", "Model provider returned an invalid Content-Length");
    assertQos(Number(declaredLength) <= MAX_MODEL_RESPONSE_BYTES, "AGENT_MODEL_RESPONSE_TOO_LARGE", "Model provider response exceeds 64 KiB");
    expectedLength = Number(declaredLength);
  }
  assertQos(response.body !== null, "AGENT_MODEL_INVALID", "Model provider returned an empty response");
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_MODEL_RESPONSE_BYTES) {
        bytes.fill(0);
        assertQos(false, "AGENT_MODEL_RESPONSE_TOO_LARGE", "Model provider response exceeds 64 KiB");
      }
      chunks.push(bytes);
    }
    assertQos(expectedLength === undefined || length === expectedLength, "AGENT_MODEL_INVALID", "Model provider response length does not match Content-Length");
    const body = Buffer.concat(chunks);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      assertQos(false, "AGENT_MODEL_INVALID", "Model provider returned invalid JSON");
    } finally {
      body.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function contentFromResponse(protocol, payload) {
  let content;
  if (protocol === "openai-chat") {
    content = payload?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) content = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  } else if (protocol === "anthropic-messages") {
    content = payload?.content?.filter?.((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  } else if (protocol === "gemini-generate-content") {
    content = payload?.candidates?.[0]?.content?.parts?.filter?.((part) => typeof part?.text === "string").map((part) => part.text).join("");
  } else {
    content = payload?.message?.content?.filter?.((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  }
  assertQos(typeof content === "string" && content.length > 0 && content.length <= MAX_MODEL_CONTENT_LENGTH, "AGENT_MODEL_INVALID", "Model provider returned no usable proposal");
  return content;
}

export async function requestModelCompletion({
  profile: rawProfile,
  credentialFile = undefined,
  system,
  prompt,
  fetchImpl = globalThis.fetch,
} = {}) {
  const profile = validateModelProviderProfile(rawProfile);
  const provider = PROVIDERS[profile.provider];
  assertQos(typeof system === "string" && system.length >= 1 && system.length <= 1024, "AGENT_MODEL_PROMPT_INVALID", "Model system instruction is invalid");
  assertQos(typeof prompt === "string" && prompt.length >= 1 && prompt.length <= MAX_PROMPT_LENGTH, "AGENT_MODEL_PROMPT_INVALID", "Model prompt is invalid");
  assertQos(typeof fetchImpl === "function", "AGENT_MODEL_UNAVAILABLE", "Model HTTP client is unavailable");
  let apiKey = null;
  if (provider.auth !== "none") {
    assertQos(typeof credentialFile === "string", "MODEL_CREDENTIAL_REQUIRED", "Remote model profile is missing its API key file");
    apiKey = credentialText(credentialFile, profile.credentialSha256);
  }
  let response;
  try {
    response = await fetchImpl(profile.endpoint, {
      method: "POST",
      headers: requestHeaders(provider, apiKey),
      body: JSON.stringify(requestBody(provider, profile, system, prompt)),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    assertQos(false, "AGENT_MODEL_UNAVAILABLE", "Model provider could not be reached");
  } finally {
    apiKey = null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    assertQos(false, "AGENT_MODEL_UNAVAILABLE", `Model provider returned HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await readJsonResponse(response);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  return contentFromResponse(profile.protocol, payload);
}
