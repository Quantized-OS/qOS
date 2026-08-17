# Agent onboarding, approvals, and offboarding

qOS 0.9.1 gives every automated agent a separate, revocable credential and a
scope narrower than the active qOS policy. An agent never receives the signer
key or the operator API token. It can submit only one exact action shape to the
loopback listener.

This release supports two reviewed action templates:

| Profile | Agent action | Onchain instruction |
| --- | --- | --- |
| Devnet | `transfer_sol` | One native System Program transfer |
| Mainnet | `transfer_qos` | One pinned qOS Token-2022 `TransferChecked` |

There is no reviewed DEX venue or swap template. Calling these transfers
“arbitrary crypto trading” would be inaccurate. Unknown actions, programs,
mints, accounts, fields, and destinations fail before signing.

## Guided onboarding in qOS

Enter the shell and run:

```text
qos> ag on
```

The wizard asks for:

1. A stable lowercase agent ID.
2. A readable name.
3. `ask` or `auto` execution.
4. The one transfer template enabled by the profile (selected automatically
   when it is the only choice).
5. A maximum amount per request in base units.
6. A destination and strategy already present in the qOS policy.

`ask` is the default. A valid request stays in listener memory for at most five
minutes and is not prepared, signed, or sent until the operator approves it.

`auto` still enforces the agent scope and the complete qOS policy, but it can
move funds without another prompt while a live listener is running. The wizard
requires the operator to type `accept-auto`. Mainnet also requires the operator
to restart the managed service with `--confirm-live`; onboarding alone never
enables mainnet broadcast.

## Flag-based onboarding

```sh
qos agent onboard \
  --id treasury-bot \
  --name "Treasury bot" \
  --approval ask \
  --asset qos-token \
  --max-amount 1000000 \
  --destination YOUR_ALLOWLISTED_DESTINATION \
  --strategy-id 1
```

For unattended automatic mode, add both `--approval auto` and
`--accept-auto`. Setup can create the first agent with the equivalent
`--agent-*` flags:

```sh
./setup.sh install --insecure --accept-insecure-risk \
  --destination YOUR_DESTINATION \
  --agent-id treasury-bot \
  --agent-approval ask \
  --agent-max-amount 1000000
```

## Generated agent skills

Onboarding creates this owner-only layout without printing the credential:

```text
PROFILE/agents/AGENT_ID/
  token
  skills/
    SKILL.md
    capabilities.md
    transfer.md
    mcp.md
    approval.md
    manifest.json
```

Show the paths with:

```text
qos> ag skills treasury-bot
```

The skill pack states the exact MCP and REST endpoints, action, destination, strategy,
amount encoding, approval mode, and token-file path. It explicitly forbids
arbitrary signing and DEX claims. The token is hashed in the registry and never
stored in a manifest or printed by qOS.

File mode `0600` prevents access by other Unix accounts. It does not isolate
two processes running as the same Unix user. Put each untrusted agent in a
separate OS account, container, VM, or equivalent sandbox and grant it only its
own token and skill pack. A process running as the qOS account can read
`--insecure` keys and every same-account agent token.

## Auto-started MCP/API service and operator flow

Onboarding automatically starts one managed loopback service. It exposes the
agent-scoped MCP endpoint and REST compatibility endpoint on the same port:

```text
qos> ag st
MCP Endpoint: http://127.0.0.1:8790/mcp
Rest Endpoint: http://127.0.0.1:8790/v1/actions
```

Mainnet starts in non-live mode. After wallet readiness succeeds, explicitly
restart it for live execution:

```text
qos> ag re --confirm-live
```

In another operator terminal:

```text
qos> ag req
qos> ag ok REQUEST_ID
qos> ag no REQUEST_ID
```

The service binds only to `127.0.0.1` or `::1`, rejects transfer encoding and
oversized bodies, authenticates agents separately from the operator, reloads
the registry for every request, rate-limits each agent, and clears pending
requests on shutdown. If the policy changes, the listener stops accepting
actions until it is restarted with the new commitment. `ag up`, `ag down`, and
`ag re` are the manual start, stop, and restart controls.

## Offboarding

```text
qos> ag off treasury-bot
```

or, for unattended operation:

```sh
qos agent offboard treasury-bot --yes
```

Offboarding removes the registry authorization before deleting the token.
Copied tokens and already-pending requests are rejected immediately. The
managed service stops automatically after the last agent is removed. If an
agent directory was replaced with a link or otherwise damaged, qOS still
revokes authorization first and preserves the unsafe path for manual inspection
instead of following it during cleanup. Confirmed `setup.sh uninstall` is a
different, destructive operation that stops services and removes every
registered qOS profile, key, credential, toolchain, log, and build artifact.

## Agent MCP request

Connect to `POST http://127.0.0.1:8790/mcp` using Streamable HTTP and the
agent's own Bearer token. Call `qos_capabilities` first. Then call
`qos_request_transfer` with only:

```json
{"amount":"1000000"}
```

qOS supplies the agent's pinned action, destination, and strategy. The skill
pack documents the current `2026-07-28` request headers and the accepted
`2025-06-18` compatibility mode. MCP uses the same policy validation, rate
limit, memory-only approval queue, and execution function as REST; it is not a
second signer path.

## REST compatibility request

The agent sends exactly:

```json
{"version":1,"action":"transfer_qos","amount":"1000000","destination":"ALLOWLISTED_PUBLIC_KEY","strategyId":1}
```

to `POST http://127.0.0.1:8790/v1/actions` with its own Bearer token. JSON is
correct for an agent protocol; the qOS operator CLI renders the resulting state
in readable text by default. Use `qos --json ...` or `qos-agent --json ...` for
machine-readable operator output.
