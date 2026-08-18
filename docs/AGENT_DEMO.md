# Agent-directed qOS transfer demo

The agent demo wires a small proposal agent to the existing qOS policy signer.
It is intentionally a Token-2022 transfer demo, not a DEX trade or swap. The
current repository does not contain a reviewed DEX instruction adapter.

The agent proposes only this typed action:

```json
{
  "action": "transfer_qos",
  "amount": "1000000",
  "destination": "ALLOWLISTED_OWNER",
  "reason": "short explanation"
}
```

qOS then performs the authoritative checks: mainnet cluster identity, pinned
qOS mint, Token-2022 program, decimals, mint authorities/extensions, associated
token accounts, delegates/close authorities/extensions, destination allowlist,
transfer limit, source balance, fee, fresh blockhash, simulation, signature
verification, and confirmation.

## Prerequisites

Use the mainnet profile created by `./setup.sh install` and review it with
`qos policy show`. External non-exportable custody is recommended; an
acknowledged `--insecure` profile has a host-readable key and is unsafe for an
untrusted agent. The installed `qos` launcher carries the selected profile and
reviewed signer-adapter path.

The signer needs enough SOL for one transaction fee and enough qOS base units.
The destination owner must already have its qOS associated token account. qOS
does not create token accounts. `1000000` base units is one qOS token.

## Basic agent, validation only

The built-in agent is deterministic and useful for the first rehearsal. It
does not broadcast by default:

```sh
qos agent demo dry 1000000
```

The command prints the agent proposal and the exact qOS intent prepared for
review. An absent source or destination token account, insufficient balance,
or any policy mismatch fails closed.

## Configured local or commercial model, validation only

The preferred model mode uses a named provider profile. Profiles can target a
local endpoint or import an operator-owned API key for OpenAI, Anthropic
Claude, Google Gemini, Cohere, Azure OpenAI, and supported
OpenAI-compatible services. See [`MODEL_PROVIDERS.md`](MODEL_PROVIDERS.md) for
the provider catalog, secure key-file import, custom endpoints, rotation, and
removal.

```sh
qos model onboard
qos agent demo dry 1000000 --agent model
```

Onboarding makes the chosen provider the default. Use `qos model use ID` to
switch defaults or add `--model-profile ID` to override one run.

Only public policy context is sent to the selected endpoint. The provider API
key is added to the authenticated HTTP request separately; the signer, private
key material, agent bearer tokens, and provider credential never enter the
prompt.

## Local endpoint

The optional model mode uses a local OpenAI-compatible chat-completions
endpoint. Only public policy context is sent to the endpoint; the signer and
any private key material are never included. The endpoint must be loopback so
the proposal context is not sent to a remote service.

Choose local in the onboarding wizard. Pressing Enter accepts the Ollama
defaults (`qwen2.5:3b` and the loopback chat-completions endpoint):

```sh
qos model onboard
qos agent demo dry 1000000 --agent model
```

The response must be a JSON proposal with the exact requested amount and
allowlisted destination. The agent cannot turn this path into a swap, change
the destination, or increase the amount.

## Explicit live broadcast

First inspect the dry-run output and verify the exact amount, destination,
mint, and token accounts. Then the live shell command requires its explicit
confirmation gate:

```sh
qos agent demo broadcast 1000000 --agent model --confirm-live
```

Use the smallest amount needed for the recording. The command prints the
confirmed signature and Solana Explorer URL only after qOS receives confirmed
status. A send-RPC response by itself is not treated as success.

## What this proves

This demonstrates agent-directed intent generation followed by qOS
validation, typed message construction, isolated signing, simulation, and
on-chain confirmation. It does not prove a production hardware root of trust,
and it does not demonstrate market execution, price discovery, slippage
limits, or a DEX integration. Those require a separately reviewed DEX adapter
and production signer boundary.
