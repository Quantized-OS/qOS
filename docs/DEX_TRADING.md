# BYOK any-token DEX trading

qOS 0.13.0 exposes a bounded Jupiter Ultra Swap action for any verified Solana
Token or Token-2022 mint pair. Trading is disabled until an operator imports a
Jupiter API key and writes explicit amount, timing, slippage, route-fee, and
network-fee limits. Live trading is mainnet-only.

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

The input and output mints are selected per swap, not during configuration.
Firmware loads both accounts from the policy-pinned Solana RPC and accepts only
distinct, initialized mints owned by the classic Token Program or Token-2022.

`max-input-amount` is measured in the requested input token's smallest unit.
For wrapped SOL that unit is one lamport. `daily-input-limit` is enforced
independently for each requested mint pair, while the trade-count and cooldown
limits apply across the profile. qOS includes the quoted route fee in the gross
per-trade and daily reservation.

`--receiver` pins every trade's output wallet. If omitted, output returns to the
firmware signer. qOS Cloud pins the account server wallet so proceeds appear in
the account inventory. An MCP client cannot change the receiver.

## Trade through MCP

Connect to the agent's MCP endpoint, call `qos_capabilities`, read the generated
skill with `qos_get_trading_skill` or `resources/read`, then call:

```json
{"inputMint":"SOLANA_INPUT_MINT","outputMint":"SOLANA_OUTPUT_MINT","amount":"INPUT_BASE_UNITS"}
```

The MCP server also serves `GET /skill`, `GET /skill/manifest`, individual files
under `/skill/files/`, and `GET /skill/download`. All routes require the agent
Bearer token. The ZIP contains no Bearer token, model credential, Jupiter key,
or signer secret.

For a direct operator request:

```sh
qos trade swap 1000000 \
  --input-mint INPUT_MINT \
  --output-mint OUTPUT_MINT \
  --confirm-live
```

## Firmware boundary

For every swap qOS:

- pins `https://api.jup.ag/swap/v2` and sends BYOK only as `x-api-key`;
- verifies both mint accounts on the pinned mainnet cluster;
- requests a manual ExactIn order and pins signer plus output receiver;
- rejects JupiterZ, gasless, provider co-signer, sponsored, and presigned paths;
- enforces gross input, daily input, count, cooldown, slippage, route fee,
  network/rent fee, router, and expiry controls;
- accepts only a bounded Solana v0 transaction with one writable qOS signer;
- reserves the authorized gross amount before delivery so an ambiguous result
  cannot be blindly retried; and
- returns a confirmed Solana signature and Solscan URL on success.

There is no generic transaction-signing endpoint. Solana tokens and Jupiter
routes can lose value. Use provider-side budgets, small funded balances,
conservative firmware limits, and independent review before automatic trading.
