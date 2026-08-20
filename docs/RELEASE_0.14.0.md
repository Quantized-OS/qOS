# qOS firmware v0.14.0 — configurable RPC and reviewed multi-venue trading

qOS v0.14.0 extends Cloud host contract 3 without adding an arbitrary signing
surface.

## Full Solana RPC endpoints

The validated `rpc-url` policy field now supports complete HTTPS provider URLs,
including arbitrary project paths and query strings. Remote plaintext HTTP,
URL userinfo, fragments, redirects, wrong genesis hashes, malformed JSON-RPC,
and oversized responses remain rejected. Public status output reports only the
origin so path/query credentials are not disclosed.

Standalone setup accepts the same value through `--rpc-url-file PATH`. The file
must be owner-owned, non-symlinked, mode `0400` or `0600`, and contain exactly
one endpoint line; the secret URL is never placed in a process argument.

## Atomic Cloud lottery settlement

The Cloud settlement intent is version 5 and binds three Token-2022 operations
in one transaction:

- treasury `TransferChecked`;
- dedicated lottery `TransferChecked`; and
- `BurnChecked`.

Firmware verifies the gross amount, exact cumulative carries, destinations,
associated token accounts, mint, program, decimals, signer, instruction order,
and recent blockhash before signing. The corresponding Cloud release allocates
50% to lottery, 1% to burn, and the remainder to treasury.

## Jupiter and Raydium

Profiles can enable reviewed `jupiter` and `raydium` venues. MCP and direct
operator swap requests choose one venue explicitly; omitting the direct CLI
venue preserves the Jupiter default.

The Raydium adapter uses the official transaction API, asks for legacy unsigned
transactions, requires exactly one atomic swap and the qOS signer, verifies the
requested mint pair and amount, rejects unrelated signer token accounts, bounds
fees/rent/slippage, decodes setup and token instructions, and accepts only the
reviewed Raydium router, AMM, CPMM, CLMM, and stable-swap programs. The exact
signed transaction is simulated with inspected input/output/SOL balances before
the budget is reserved and the transaction is broadcast.

Every generated MCP skill includes the selected venues, exact firmware limits,
funding/proceeds wallets, and bounded DCA, rebalance, momentum, mean-reversion,
venue-comparison, and risk-off workflows. Strategies do not grant arbitrary
instructions, arbitrary programs, co-signers, or destination changes.
