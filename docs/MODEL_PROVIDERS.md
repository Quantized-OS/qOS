# Commercial model providers and BYOK

qOS can obtain an agent proposal from a local model or from an operator-owned
commercial LLM account. The model only proposes the same narrow JSON action;
qOS still validates the exact amount, allowlisted destination, mint, accounts,
fees, simulation, signer response, and confirmation.

API keys are not agent credentials and do not grant signing authority. qOS
stores each imported key in a separate mode-0600 file beneath the selected qOS
profile. Registry records contain only a SHA-256 verifier. Keys are never
printed, added to prompts, included in provider metadata, or exposed through
the managed-agent REST/MCP listener.

## Provider coverage

Run `qos-model catalog` (or `model catalog` inside qOS Shell) for the installed
catalog. Version 0.10 includes these protocol families and presets:

| Protocol family | Presets |
| --- | --- |
| OpenAI Chat Completions | OpenAI, xAI, Groq, Mistral, DeepSeek, OpenRouter, Together AI, Fireworks AI, Perplexity, Cerebras |
| Anthropic Messages | Anthropic Claude |
| Gemini generateContent | Google Gemini |
| Cohere Chat v2 | Cohere |
| Managed/custom endpoints | Azure OpenAI and acknowledged custom OpenAI-, Anthropic-, Gemini-, or Cohere-compatible endpoints |
| Local | Ollama, LM Studio, llama.cpp, or another loopback OpenAI-compatible endpoint |

The custom protocol profiles make the firmware compatible with additional
vendors and private gateways without accepting arbitrary request templates.
A provider with a different wire protocol or authentication scheme still needs
a small reviewed adapter; qOS does not execute provider-supplied code.

## Import a commercial API key

First save the key in a regular file owned by the qOS service account. Do not
put the key itself in shell history, source control, an `.env` file, or a model
prompt. qOS rejects symlinks, hard-linked key files, group/world access,
non-visible bytes, and oversized credentials.

Configure one or more named profiles:

```sh
qos-model --home .qos-ephemeral-mainnet configure openai-prod \
  --provider openai \
  --model YOUR_OPENAI_MODEL \
  --api-key-file /run/secrets/openai-api-key

qos-model --home .qos-ephemeral-mainnet configure claude-prod \
  --provider anthropic \
  --model YOUR_CLAUDE_MODEL \
  --api-key-file /run/secrets/anthropic-api-key

qos-model --home .qos-ephemeral-mainnet configure gemini-prod \
  --provider google \
  --model YOUR_GEMINI_MODEL \
  --api-key-file /run/secrets/gemini-api-key
```

Use the exact model ID enabled in the provider account. qOS deliberately does
not pin a default commercial model because availability, pricing, and
retirement schedules are controlled by each provider.

List only non-secret metadata:

```sh
qos-model --home .qos-ephemeral-mainnet list
qos-model --home .qos-ephemeral-mainnet show claude-prod
```

## Use a configured model

Select a provider profile for a validation-only proposal:

```sh
node bin/qos-agent-demo.js \
  --agent model \
  --model-profile claude-prod \
  --home .qos-ephemeral-mainnet \
  --amount 1000000
```

The equivalent qOS Shell command is:

```text
ag demo dry 1000000 -a model -p claude-prod
```

`QOS_AGENT_MODEL_PROFILE` may select a profile for a supervised service
environment. It contains an ID, not a credential. The older
`QOS_AGENT_MODEL_URL` and `QOS_AGENT_MODEL` variables remain available for
local-only OpenAI-compatible endpoints.

## Local and custom endpoints

A local profile never accepts an API key and must resolve to literal loopback:

```sh
qos-model --home .qos-ephemeral-mainnet configure ollama-local \
  --provider local \
  --model qwen2.5:3b \
  --endpoint http://127.0.0.1:11434/v1/chat/completions
```

Built-in commercial presets have fixed HTTPS endpoints. To use a private
gateway, select the matching `custom-*` protocol and explicitly acknowledge
that qOS will send the imported key to that URL:

```sh
qos-model --home .qos-ephemeral-mainnet configure company-gateway \
  --provider custom-openai \
  --model COMPANY_MODEL_ID \
  --endpoint https://llm-gateway.example.com/v1/chat/completions \
  --api-key-file /run/secrets/company-llm-key \
  --allow-custom-endpoint
```

Remote HTTP, URL-embedded credentials, fragments, redirects, compressed
responses, non-JSON responses, and responses larger than 64 KiB fail closed.
Custom endpoint acknowledgement is a trust decision, not an authenticity
check; review the hostname and TLS deployment before importing a key.

## Rotation and removal

Rotate only the secret while keeping the provider, endpoint, and model pinned:

```sh
qos-model --home .qos-ephemeral-mainnet rotate claude-prod \
  --api-key-file /run/secrets/anthropic-api-key-next
```

Remove a profile and its stored credential:

```sh
qos-model --home .qos-ephemeral-mainnet remove claude-prod --yes
```

Removal revokes the profile in the registry before deleting local credential
bytes. Unsafe or damaged paths are preserved for inspection while the profile
remains unusable.

## Cloud-service boundary

This release implements BYOK proposal providers only. It does not implement a
hosted qOS API, shared cloud key custody, metering, or qOS-token payment. A
future cloud service should keep tenant credentials in a managed secret store,
isolate tenants and spend limits, perform server-side model calls, and expose
only the existing typed qOS action boundary to clients.
