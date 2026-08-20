# Reviewed multi-venue any-token DEX trading

qOS 0.14.0 exposes one bounded swap action with reviewed Jupiter aggregation
and Raydium direct-routing adapters for any verified Solana Token or Token-2022
mint pair. Trading is disabled until an operator imports a Jupiter API key and
writes explicit amount, timing, slippage, route-fee, and network-fee limits.
The key enables Jupiter and is never sent to Raydium. Live trading is
mainnet-only.

## Configure

```sh
chmod 600 /owner-only/jupiter.key

qos trade configure \
  --api-key-file /owner-only/jupiter.key \
  --max-input-amount 10000000 \
  --daily-input-limit 100000000 \
  --receiver OPTIONAL_OUTPUT_WALLET \
  --max-slippage-bps 100 \
  --max-route-fee-bps 100 \
  --max-fee-lamports 5000000 \
  --min-interval-seconds 60 \
  --max-swaps-per-day 100
```

Both reviewed venues are enabled by default. The input/output mints and venue
are selected per swap, not during configuration. Firmware loads both mint
accounts from the policy-pinned Solana RPC and accepts only distinct,
initialized mints owned by the classic Token Program or Token-2022.

`max-input-amount` is measured in the requested input token's smallest unit.
For wrapped SOL that unit is one lamport. `daily-input-limit` is enforced
independently for each requested mint pair, while trade-count and cooldown
limits apply across the profile. qOS includes the quoted route fee in the gross
per-trade and daily reservation.

`--receiver` pins every trade's output wallet. If omitted, output returns to the
firmware signer. qOS Cloud pins the account server wallet so proceeds appear in
the account inventory. An MCP client cannot change the receiver.

## Trade through MCP

Connect to the agent's MCP endpoint, call `qos_capabilities`, read the generated
skill with `qos_get_trading_skill` or `resources/read`, then call:

```json
{"venue":"raydium","inputMint":"SOLANA_INPUT_MINT","outputMint":"SOLANA_OUTPUT_MINT","amount":"INPUT_BASE_UNITS"}
```

Use `"venue":"jupiter"` for the aggregation adapter. The MCP server also
serves `GET /skill`, `GET /skill/manifest`, individual files under
`/skill/files/`, and `GET /skill/download`. All routes require the agent Bearer
token. The ZIP contains no Bearer token, model credential, Jupiter key, or
signer secret.

For a direct operator request:

```sh
qos trade swap 1000000 \
  --venue raydium \
  --input-mint INPUT_MINT \
  --output-mint OUTPUT_MINT \
  --confirm-live
```

Omitting `--venue` preserves the legacy Jupiter default.

## Firmware boundary

For every swap qOS:

- accepts only `jupiter` or `raydium` when that venue is enabled in the profile;
- verifies both mint accounts on the pinned mainnet cluster;
- pins `https://api.jup.ag/swap/v2`, sends BYOK only as `x-api-key`, requests a
  manual ExactIn order, and rejects JupiterZ, gasless, provider co-signer,
  sponsored, and presigned paths;
- pins Raydium's official transaction API, requests legacy unsigned
  transactions, requires one atomic swap and the qOS wallet as the only signer,
  rejects unrelated signer-owned token accounts, and accepts only narrowly
  decoded wrapped-SOL, associated-account, token, compute-budget, memo, and
  reviewed Raydium router/AMM/CPMM/CLMM/stable instructions;
- signs and simulates the exact Raydium transaction while inspecting the
  policy-derived input, output, and signer accounts, then rejects excessive
  debits or output below the quote-protected minimum before broadcast;
- enforces gross input, daily input, count, cooldown, slippage, route fee,
  network/rent fee, router, and expiry controls;
- accepts only bounded transactions with one writable qOS signer and the
  policy-pinned output receiver;
- reserves the authorized gross amount before delivery so an ambiguous result
  cannot be blindly retried; and
- returns every confirmed Solana signature and Solscan URL on success.

The generated MCP skill includes policy-bound strategy templates for:

- scheduled dollar-cost averaging;
- target-weight portfolio rebalancing;
- momentum entries with cooldown and daily-budget checks;
- mean-reversion entries with conservative slippage;
- venue comparison using independent quotes before choosing an adapter; and
- risk-off conversion into a configured defensive mint.

These are agent workflows, not additional signer privileges. The agent submits
one exact venue/mint/amount request at a time, and qOS revalidates every
transaction produced by the external venue.

There is no generic transaction-signing endpoint and no arbitrary-program
escape hatch. Solana tokens and DEX routes can lose value. Use provider-side
budgets, small funded balances, conservative firmware limits, and independent
review before automatic trading.
