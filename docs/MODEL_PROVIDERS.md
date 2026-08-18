# Model onboarding and BYOK providers

qOS uses one installed command: `qos`. Model setup, selection, rotation, and
removal are all under `qos model` (or `model` at the `qos>` prompt).

A local or commercial model may propose one narrow JSON action. qOS still
validates the exact amount, allowlisted destination, mint, accounts, fees,
simulation, signer response, and confirmation. An API key is not a signing key
and never grants model code access to the qOS signer.

## Guided onboarding

Run:

```sh
qos model onboard
```

The wizard lists every built-in provider and asks which one to use. Local is
the first and default choice. Pressing Enter through the local choices creates:

| Setting | Default |
| --- | --- |
| Profile ID | `local` |
| Provider | Local OpenAI-compatible |
| Model | `qwen2.5:3b` |
| Endpoint | `http://127.0.0.1:11434/v1/chat/completions` |

That endpoint works with Ollama's OpenAI-compatible interface. The endpoint
must resolve to literal loopback; a local profile cannot contain an API key.
You can enter another loopback endpoint for LM Studio, llama.cpp, or a similar
local server.

For a commercial provider, the wizard asks for the exact model ID enabled in
your account and the path to an owner-only API-key file. It does not ask you to
paste the key into the shell. Built-in HTTPS endpoints are selected
automatically. Azure and custom gateways also require an endpoint and an
explicit acknowledgement that the key will be sent there.

The onboarded profile becomes the default. Inspect or change it with:

```sh
qos model default
qos model list
qos model use PROFILE_ID
```

The first profile created with `qos model configure` also becomes the default.
Removing the default selects the next remaining profile, if one exists.

## Provider coverage

Run `qos model catalog` for the installed catalog. Version 0.11 includes:

| Protocol family | Presets |
| --- | --- |
| OpenAI Chat Completions | OpenAI, xAI, Groq, Mistral, DeepSeek, OpenRouter, Together AI, Fireworks AI, Perplexity, Cerebras |
| Anthropic Messages | Anthropic Claude |
| Gemini generateContent | Google Gemini |
| Cohere Chat v2 | Cohere |
| Managed/custom endpoints | Azure OpenAI and acknowledged custom OpenAI-, Anthropic-, Gemini-, or Cohere-compatible endpoints |
| Local | Ollama, LM Studio, llama.cpp, or another loopback OpenAI-compatible endpoint |

A provider with a different wire protocol or authentication scheme still needs
a small reviewed adapter. qOS never executes provider-supplied code or accepts
arbitrary request templates.

## Commercial API-key files

Save each key in a regular file owned by the qOS account, then restrict it:

```sh
chmod 600 /secure/path/provider-api-key
```

Do not put the key itself in command history, source control, an `.env` file,
or a model prompt. qOS rejects symlinks, hard-linked files, group/world access,
non-visible bytes, and oversized credentials. It copies an accepted key into a
separate mode-0600 profile file; provider metadata stores only a SHA-256
verifier. Keys are never printed or exposed through the managed REST/MCP
listener.

The guided wizard is recommended. The equivalent explicit commands are:

```sh
qos model configure openai-prod --default \
  --provider openai \
  --model YOUR_OPENAI_MODEL \
  --api-key-file /secure/path/openai-api-key

qos model configure claude-prod --default \
  --provider anthropic \
  --model YOUR_CLAUDE_MODEL \
  --api-key-file /secure/path/anthropic-api-key

qos model configure gemini-prod --default \
  --provider google \
  --model YOUR_GEMINI_MODEL \
  --api-key-file /secure/path/gemini-api-key
```

Use the exact model ID enabled in the provider account. qOS does not pin a
commercial model default because availability, pricing, and retirement are
controlled by each provider.

## Use the default model

For the validation-only proposal demo:

```sh
qos agent demo dry 1000000 --agent model
```

The selected default is used automatically. Override it for one run with:

```sh
qos agent demo dry 1000000 --agent model --model-profile claude-prod
```

Inside the interactive shell, the equivalent shorthand is:

```text
qos> ag demo dry 1000000 -a model
```

The current demo is a mainnet qOS Token-2022 transfer preflight, not a general
chat interface or DEX swap. It does not broadcast unless the separate live
gates are supplied.

## Local and custom endpoints

Explicit local configuration remains available:

```sh
qos model configure ollama-local --default \
  --provider local \
  --model qwen2.5:3b \
  --endpoint http://127.0.0.1:11434/v1/chat/completions
```

For a private gateway, choose the matching compatible protocol and explicitly
acknowledge the destination:

```sh
qos model configure company-gateway --default \
  --provider custom-openai \
  --model COMPANY_MODEL_ID \
  --endpoint https://llm-gateway.example.com/v1/chat/completions \
  --api-key-file /secure/path/company-llm-key \
  --allow-custom-endpoint
```

Remote HTTP, URL-embedded credentials, fragments, redirects, compressed
responses, non-JSON responses, and responses larger than 64 KiB fail closed.
Custom endpoint acknowledgement is a trust decision, not an authenticity
check; review the hostname and TLS deployment before importing a key.

## Rotation and removal

```sh
qos model rotate claude-prod --api-key-file /secure/path/anthropic-api-key-next
qos model remove claude-prod --yes
```

Removal revokes the profile in the registry before deleting credential bytes.
Unsafe or damaged paths are preserved for inspection while the profile remains
unusable.

## Cloud-service boundary

This release implements local and commercial BYOK proposal providers only. It
does not implement a hosted qOS API, shared cloud key custody, usage metering,
or `$qos` payment. A future cloud service should keep tenant credentials in a
managed secret store, isolate tenants and spend limits, perform server-side
model calls, and expose only the existing typed qOS action boundary.
