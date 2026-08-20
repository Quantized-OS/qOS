# qOS firmware v0.15.0 — optional Jupiter, generated trading skills, and safer defaults

qOS v0.15.0 provides a policy-enforced Solana trading surface for qOS Cloud
v0.10.0 and self-hosted operators. It does not add a generic signing endpoint.

## Optional Jupiter and keyless Raydium

- A Raydium-only profile no longer requires a Jupiter API key.
- Enabling Jupiter still requires an owner-only BYOK credential, and that key is
  never sent to Raydium or written into a skill pack.
- Omitting `--venue` in the direct CLI selects the first enabled profile venue,
  so a keyless Raydium profile no longer falls back to unavailable Jupiter.
- `qos trade configure` accepts a keyless no-argument policy setup. Its amount
  budgets default to the u64 protocol maximum, with 300 swaps per UTC day and a
  30-second minimum interval.

## Any-token trading boundary

Runtime requests may select any two distinct, initialized Solana Token Program
or Token-2022 mints. qOS independently loads the mint accounts, validates their
program and decimals, verifies the exact-in amount, and pins the output receiver.
The Cloud uses qOS only for launch and settlement fees; qOS is not a required
asset in the traded pair.

Live execution remains limited to two reviewed adapters:

- Jupiter manual ExactIn routes with one qOS signer and no provider co-signer,
  gasless, presigned, sponsored, or JupiterZ route; and
- Raydium legacy transactions restricted to decoded token/system/ATA/compute
  instructions and the reviewed router, AMM, CPMM, CLMM, and stable programs.

There is deliberately no arbitrary serialized-transaction, program, receiver,
or signature endpoint.

## Market discovery and strategies

Trading MCP servers expose:

- `qos_search_markets` for bounded DexScreener search and Pump.fun-origin
  filtering;
- `qos_token_markets` for an exact mint; and
- `qos_request_swap` for a reviewed live venue.

Discovery results are read-only and attacker-controlled. The generated skill
requires exact-mint verification, fresh executable quotes, authority/liquidity/
holder checks where available, and reconciliation before retrying ambiguous
delivery. Configuration-specific skills cover DCA/time slicing, threshold
rebalance, momentum/breakout, mean reversion, new-pool observation, venue
comparison, and risk-off behavior. The agent can select a strategy from current
evidence, but strategy text cannot weaken firmware controls.

## Upgrade notes

- Package version: 0.15.0.
- Cloud host contract: 3.
- Existing provider configuration versions 1 and 2 are migrated in memory;
  v3 records whether Jupiter is configured.
- Existing Jupiter-only profiles continue to use Jupiter as their first venue.
- New keyless profiles default to Raydium.
- Node-based setup pins Node.js 24.19.0.

Read `docs/reports/PRODUCTION_SECURITY_REVIEW_0.15.0.md` before using software
keys or autonomous execution with mainnet value.
