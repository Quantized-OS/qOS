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
qOS mint, Token-2022 program, decimals, mint extensions, associated token
accounts, destination allowlist, transfer limit, source balance, fee, fresh
blockhash, simulation, signature verification, and confirmation.

## Prerequisites

Use a separate mainnet home. Review its `policy.json`, and use an external
non-exportable signer for an agent deployment. The plaintext-development key
profile is disposable-demo only.

The signer needs enough SOL for one transaction fee and enough qOS base units.
The destination owner must already have its qOS associated token account. qOS
does not create token accounts. `1000000` base units is one qOS token.

## Basic agent, validation only

The built-in agent is deterministic and useful for the first rehearsal. It
does not broadcast by default:

```sh
node bin/qos-agent-demo.js \
  --home .qos-ephemeral-mainnet \
  --amount 1000000
```

The command prints the agent proposal and the exact qOS intent prepared for
review. An absent source or destination token account, insufficient balance,
or any policy mismatch fails closed.

## Local 3B-class model, validation only

The optional model mode uses a local OpenAI-compatible chat-completions
endpoint. Only public policy context is sent to the endpoint; the signer and
any private key material are never included. The endpoint must be loopback so
the proposal context is not sent to a remote service.

For an Ollama/LM Studio/llama.cpp-compatible endpoint, set the URL and model:

```sh
QOS_AGENT_MODEL_URL=http://127.0.0.1:11434/v1/chat/completions \
QOS_AGENT_MODEL=qwen2.5:3b \
node bin/qos-agent-demo.js \
  --agent model \
  --home .qos-ephemeral-mainnet \
  --amount 1000000
```

The response must be a JSON proposal with the exact requested amount and
allowlisted destination. The agent cannot turn this path into a swap, change
the destination, or increase the amount.

## Explicit live broadcast

First inspect the dry-run output and verify the exact amount, destination,
mint, and token accounts. Then the live command requires both a CLI flag and a
separate environment opt-in:

```sh
QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND \
node bin/qos-agent-demo.js \
  --agent model \
  --home .qos-ephemeral-mainnet \
  --amount 1000000 \
  --broadcast \
  --confirm-live
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
