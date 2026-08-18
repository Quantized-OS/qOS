import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { configuredModelAgentPlan } from "../src/agent.js";
import {
  configureModelProvider,
  getDefaultModelProvider,
  getModelProvider,
  listModelProviders,
  loadModelProviderRegistry,
  loadModelProviderForRequest,
  modelProviderPaths,
  removeModelProvider,
  rotateModelProviderCredential,
  setDefaultModelProvider,
} from "../src/model-registry.js";
import {
  createModelProviderProfile,
  modelProviderCatalog,
  requestModelCompletion,
} from "../src/model-provider.js";
import { ensureRuntimeProfile } from "../src/runtime-profile.js";
import { initializeSandbox } from "../src/service.js";

const DESTINATION = "2HRxdPxxReP4PAHunxHD5mjPXWwBhnhYq4NowVEoLxg5";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "qos-model-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  initializeSandbox(home);
  ensureRuntimeProfile(home, { profile: "devnet" });
  const keyFile = join(root, "provider-key");
  const apiKey = "test-provider-secret-123456789";
  writeFileSync(keyFile, `${apiKey}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return { root, home, keyFile, apiKey };
}

function response(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("provider catalog covers native APIs, OpenAI-compatible companies, and custom adapters", () => {
  const ids = new Set(modelProviderCatalog().map((provider) => provider.id));
  for (const id of [
    "local", "openai", "anthropic", "google", "cohere", "xai", "groq",
    "mistral", "deepseek", "openrouter", "together", "fireworks",
    "perplexity", "cerebras", "azure-openai", "custom-openai",
    "custom-anthropic", "custom-gemini", "custom-cohere",
  ]) assert.equal(ids.has(id), true, id);
});

test("BYOK registry stores credentials separately and never returns or serializes the key", (t) => {
  const { home, keyFile, apiKey } = fixture(t);
  const configured = configureModelProvider(home, {
    id: "openai-prod",
    provider: "openai",
    model: "gpt-test",
    apiKeyFile: keyFile,
  });
  const paths = modelProviderPaths(home, "openai-prod");
  assert.equal(configured.credentialConfigured, true);
  assert.equal(configured.default, true);
  assert.equal(JSON.stringify(configured).includes(apiKey), false);
  assert.equal(JSON.stringify(getModelProvider(home, "openai-prod")).includes("credentialSha256"), false);
  assert.equal(lstatSync(paths.credential).mode & 0o077, 0);
  assert.equal(lstatSync(paths.credential).nlink, 1);
  assert.equal(lstatSync(paths.profile).mode & 0o077, 0);
  assert.equal(readFileSync(paths.registry, "utf8").includes(apiKey), false);
  assert.equal(listModelProviders(home).length, 1);
  assert.equal(getDefaultModelProvider(home).defaultProfile, "openai-prod");
  assert.equal(loadModelProviderForRequest(home).profile.id, "openai-prod");

  const removed = removeModelProvider(home, "openai-prod");
  assert.equal(removed.credentialRevoked, true);
  assert.equal(removed.credentialRemoved, true);
  assert.equal(listModelProviders(home).length, 0);
});

test("model defaults are explicit, switchable, and version-1 registries migrate safely", (t) => {
  const { home } = fixture(t);
  configureModelProvider(home, {
    id: "ollama",
    provider: "local",
    model: "qwen2.5:3b",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
  });
  configureModelProvider(home, {
    id: "lm-studio",
    provider: "local",
    model: "local-model",
    endpoint: "http://127.0.0.1:1234/v1/chat/completions",
  });
  assert.equal(getDefaultModelProvider(home).defaultProfile, "ollama");
  assert.equal(getModelProvider(home, "lm-studio").default, false);
  assert.equal(setDefaultModelProvider(home, "lm-studio").default, true);
  assert.equal(loadModelProviderForRequest(home).profile.id, "lm-studio");

  const paths = modelProviderPaths(home);
  const current = JSON.parse(readFileSync(paths.registry, "utf8"));
  writeFileSync(paths.registry, `${JSON.stringify({ version: 1, profiles: current.profiles }, null, 2)}\n`, { mode: 0o600 });
  assert.equal(loadModelProviderRegistry(home).defaultProfile, null);
  assert.throws(() => loadModelProviderForRequest(home), { code: "MODEL_PROFILE_SELECTION_REQUIRED" });
  assert.equal(setDefaultModelProvider(home, "ollama").default, true);
  assert.equal(JSON.parse(readFileSync(paths.registry, "utf8")).version, 2);
});

test("provider profiles pin fixed endpoints and require acknowledgement for custom destinations", () => {
  const hash = "0".repeat(64);
  assert.throws(() => createModelProviderProfile({
    id: "openai-prod",
    provider: "openai",
    model: "gpt-test",
    endpoint: "https://example.com/v1/chat/completions",
    credentialSha256: hash,
  }), { code: "MODEL_ENDPOINT_FIXED" });
  assert.throws(() => createModelProviderProfile({
    id: "custom",
    provider: "custom-openai",
    model: "vendor-model",
    endpoint: "https://models.example.com/v1/chat/completions",
    credentialSha256: hash,
  }), { code: "CUSTOM_MODEL_ENDPOINT_ACKNOWLEDGEMENT_REQUIRED" });
  assert.throws(() => createModelProviderProfile({
    id: "custom",
    provider: "custom-openai",
    model: "vendor-model",
    endpoint: "http://models.example.com/v1/chat/completions",
    credentialSha256: hash,
    allowCustomEndpoint: true,
  }), { code: "MODEL_ENDPOINT_TLS_REQUIRED" });
  assert.equal(createModelProviderProfile({
    id: "custom",
    provider: "custom-openai",
    model: "vendor-model",
    endpoint: "https://models.example.com/v1/chat/completions",
    credentialSha256: hash,
    allowCustomEndpoint: true,
  }).endpoint, "https://models.example.com/v1/chat/completions");
});

test("native provider adapters send credentials only in the expected header and parse responses", async (t) => {
  const { keyFile, apiKey } = fixture(t);
  const credentialSha256 = createHash("sha256").update(apiKey).digest("hex");
  const cases = [
    {
      provider: "openai",
      protocol: "openai-chat",
      header: "authorization",
      headerValue: `Bearer ${apiKey}`,
      payload: { choices: [{ message: { content: "{\"ok\":\"openai\"}" } }] },
      expected: "{\"ok\":\"openai\"}",
    },
    {
      provider: "anthropic",
      protocol: "anthropic-messages",
      header: "x-api-key",
      headerValue: apiKey,
      payload: { content: [{ type: "text", text: "{\"ok\":\"anthropic\"}" }] },
      expected: "{\"ok\":\"anthropic\"}",
    },
    {
      provider: "google",
      protocol: "gemini-generate-content",
      header: "x-goog-api-key",
      headerValue: apiKey,
      payload: { candidates: [{ content: { parts: [{ text: "{\"ok\":\"google\"}" }] } }] },
      expected: "{\"ok\":\"google\"}",
    },
    {
      provider: "cohere",
      protocol: "cohere-chat",
      header: "authorization",
      headerValue: `Bearer ${apiKey}`,
      payload: { message: { content: [{ type: "text", text: "{\"ok\":\"cohere\"}" }] } },
      expected: "{\"ok\":\"cohere\"}",
    },
  ];
  for (const item of cases) {
    const profile = createModelProviderProfile({
      id: `${item.provider}-test`,
      provider: item.provider,
      model: "model-test",
      credentialSha256,
    });
    let captured;
    const content = await requestModelCompletion({
      profile,
      credentialFile: keyFile,
      system: "Return JSON.",
      prompt: "Public policy context only.",
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return response(item.payload);
      },
    });
    assert.equal(content, item.expected);
    assert.equal(captured.options.headers[item.header], item.headerValue);
    assert.equal(captured.options.body.includes(apiKey), false);
    assert.equal(captured.options.redirect, "error");
    assert.equal(JSON.parse(captured.options.body).constructor, Object);
  }
});

test("configured model proposals remain constrained by the qOS plan validator", async (t) => {
  const { home, keyFile } = fixture(t);
  configureModelProvider(home, {
    id: "claude-prod",
    provider: "anthropic",
    model: "claude-test",
    apiKeyFile: keyFile,
  });
  const configured = loadModelProviderForRequest(home, "claude-prod");
  const plan = await configuredModelAgentPlan({
    ...configured,
    amount: "1000000",
    destination: DESTINATION,
    maxAmount: "1000000000",
    mint: "5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump",
    decimals: 6,
    fetchImpl: async () => response({
      content: [{
        type: "text",
        text: `\`\`\`json\n{\"action\":\"transfer_qos\",\"amount\":\"1000000\",\"destination\":\"${DESTINATION}\",\"reason\":\"provider test\"}\n\`\`\``,
      }],
    }),
  });
  assert.deepEqual(plan, {
    action: "transfer_qos",
    amount: "1000000",
    destination: DESTINATION,
    reason: "provider test",
  });
});

test("credential rotation changes the verifier and tampering fails closed", (t) => {
  const { root, home, keyFile } = fixture(t);
  configureModelProvider(home, {
    id: "groq-prod",
    provider: "groq",
    model: "model-test",
    apiKeyFile: keyFile,
  });
  const rotated = join(root, "rotated-key");
  writeFileSync(rotated, "replacement-provider-secret-987654321\n", { mode: 0o600 });
  assert.equal(rotateModelProviderCredential(home, "groq-prod", { apiKeyFile: rotated }).credentialRotated, true);
  const paths = modelProviderPaths(home, "groq-prod");
  writeFileSync(paths.credential, "tampered-provider-secret-000000000\n", { mode: 0o600 });
  assert.throws(() => loadModelProviderForRequest(home, "groq-prod"), { code: "MODEL_CREDENTIAL_MISMATCH" });
});

test("qos-model exposes help and catalog without opening a qOS profile", () => {
  const script = new URL("../bin/qos-model.js", import.meta.url).pathname;
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /BYOK control/);
  const catalog = spawnSync(process.execPath, [script, "--json", "catalog"], { encoding: "utf8" });
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.ok(JSON.parse(catalog.stdout).providers.length >= 15);
});
