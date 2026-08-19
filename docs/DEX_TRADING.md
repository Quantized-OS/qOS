# BYOK DEX trading

qOS 0.12.0 can expose one bounded Jupiter Ultra Swap action to a managed agent.
Trading is disabled in every new profile until the operator imports a Jupiter
API key and writes an explicit DEX policy. It is supported only on Solana
mainnet-beta.

## Configure a profile

Create a Jupiter API key with the narrowest available permissions and budget,
save it in an owner-only file, and configure the mint pair and limits:

```sh
chmod 600 /owner-only/jupiter.key

qos trade configure \
  --api-key-file /owner-only/jupiter.key \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint 5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump \
  --max-input-amount 10000000 \
  --daily-input-limit 100000000 \
  --receiver OPTIONAL_OUTPUT_WALLET \
  --max-slippage-bps 100 \
  --max-route-fee-bps 100 \
  --max-fee-lamports 5000000 \
  --min-interval-seconds 60 \
  --max-swaps-per-day 100
```

`max-input-amount` and `daily-input-limit` use the input mint's smallest unit.
When the input mint is wrapped SOL, those values are lamports. Ten million
lamports is 0.01 SOL. qOS includes the quoted route fee when enforcing the
per-swap and daily gross-input budgets.

`--receiver` is optional for self-hosted qOS. When omitted, output returns to
the firmware signer. Managed qOS Cloud pins it to the account's server billing
wallet so proceeds appear in the account asset inventory and can be withdrawn
through the normal pause, settlement, and withdrawal flow. An agent cannot
change this receiver on a swap request.

The command copies the key into `PROFILE/dex/jupiter-api-key` with mode `0600`.
The source file is not referenced afterward. Provider metadata never contains
the key, and status output returns only `credentialConfigured: true`.

Inspect the active policy:

```text
qos> tr st
qos> capa
qos> pol show
```

## Enable an agent

DEX policy and agent permission are separate gates. A configured profile does
not automatically give existing agents the swap tool:

```sh
qos agent onboard \
  --id trading-bot \
  --name "Trading bot" \
  --approval auto \
  --asset qos-token \
  --max-amount 1000000 \
  --destination YOUR_ALLOWLISTED_DESTINATION \
  --strategy-id 1 \
  --enable-dex \
  --accept-auto \
  --yes
```

After the signer wallet is funded with the input asset and SOL for fees, start
mainnet execution explicitly:

```text
qos> ag re --confirm-live
```

The agent receives `qos_request_swap`. It can submit only `inputMint`,
`outputMint`, and `amount`; qOS fills the strategy and enforces the profile.
`ask` mode holds a valid request in volatile memory. `auto` mode can execute a
valid request without another prompt while the listener is live.

For a direct operator-initiated swap:

```sh
qos trade swap 1000000 \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint 5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump \
  --confirm-live
```

The successful result includes the Solana signature and a Solscan URL.

## Enforced boundary

For every request qOS:

- pins `https://api.jup.ag/swap/v2` and sends the BYOK value only as
  `x-api-key` to that origin;
- requests a manual ExactIn order for the firmware signer;
- pins the configured output receiver into the Jupiter order request;
- excludes JupiterZ and rejects gasless, sponsored, presigned, or additional
  signer paths;
- checks the exact mint pair, requested amount, quoted slippage, route fee,
  signature/prioritization/rent fees, router, and expiry metadata;
- accepts only a canonical Solana v0 transaction with exactly one writable
  signer, the qOS signer as fee payer, and bounded transaction complexity;
- commits the transaction hash and order metadata to the signer authorization;
- reserves the full authorized gross input before handing a signed transaction
  to the venue, then narrows that reservation to the confirmed wallet debit;
  ambiguous delivery therefore consumes the conservative reservation instead
  of permitting a potentially duplicate retry;
- enforces the UTC-day amount/count limits and cooldown across restarts.

There is no generic "sign transaction" endpoint. The Jupiter API remains an
external venue and transaction-construction trust dependency, and Solana trades
can lose value. BYOK encryption or Unix file modes do not make a server-held key
inaccessible to that server's administrator. Use provider-side limits, small
funded balances, conservative qOS limits, and independent review before live
automatic trading.
