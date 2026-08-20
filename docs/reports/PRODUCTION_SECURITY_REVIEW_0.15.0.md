# qOS firmware v0.15.0 production-preparation security review

Date: 2026-08-20

Input archive SHA-256:
`0bd710ab1f45fe5cfbc7e10218ca2822dfed4fc0c2beeb76ea795f0b919cde33`.

## Decision

**Suitable only as a reviewed release candidate with bounded hot-wallet value;
not independently certified for unrestricted custody or autonomous trading.**
The JavaScript signer and acknowledged `mainnet-insecure` profile are accessible
to the host user and any compromised process with that authority. The bare-metal
firmware interfaces still require a target-specific hardware implementation.

## Scope and methods

The review covered provider configuration, mint and account parsing, Jupiter
and Raydium transaction validation, runtime budget state, policy persistence,
RPC endpoint handling, MCP authentication/tools/resources, generated skill
files, secure-file handling, Cloud settlement/withdrawal exports, CLIs, setup
scripts, and regression tests. It included source review, secret/dangerous-API
searches, exact-schema negative tests, JavaScript and Python syntax/static
checks, shell syntax checks, and the complete Node test suite. No production
key was used and no mainnet transaction was broadcast.

## Findings fixed

1. Jupiter credentials are no longer required for Raydium-only execution.
   Provider metadata binds enabled venues to credential presence and removes a
   stale key when reconfigured keyless.
2. Direct CLI venue selection now follows the profile instead of always
   defaulting to Jupiter.
3. CLI amount budgets can use the documented u64 defaults; they are no longer
   accidentally mandatory even though the SDK supported defaults.
4. Trading cadence defaults are 300 per UTC day and 30 seconds, with bounded
   integer validation and persistent per-profile accounting.
5. Market discovery has response, timeout, redirect, JSON, chain, item-count,
   and string bounds. Results are explicitly untrusted and cannot carry a
   transaction into the signer.
6. Generated skills accurately include only configured venues and credential
   capabilities and never contain BYOK secrets or the MCP Bearer token.
7. Strategy guidance now requires exact mint, evidence, sizing, invalidation,
   cost, and ambiguous-delivery reconciliation; it does not create authority.

## Controls verified

- Full RPC URLs allow HTTPS provider paths/queries but reject plaintext remote
  HTTP, userinfo, fragments, redirects, wrong genesis, malformed JSON, and
  oversized responses.
- Secure files reject symlinks, unsafe permissions/ownership, multiple links,
  non-regular files, inode changes, and unbounded reads.
- Both input mints are loaded from the pinned cluster and must be distinct,
  initialized classic Token or Token-2022 mints.
- Swap policies bind receiver, exact-in amount, per-trade/daily u64 budgets,
  slippage, route fee, network/rent fee, cooldown, count, and strategy ID.
- Jupiter and Raydium returned transactions are decoded and revalidated; signer,
  programs, accounts, mints, amount, receiver, and fee effects cannot be chosen
  arbitrarily by the provider or agent.
- Conservative reservation happens before broadcast, and ambiguous delivery is
  not blindly retried.
- MCP uses bounded authenticated requests and exposes only reviewed tools,
  standard skill resources, and generated public files.
- Atomic Cloud settlement verifies treasury, lottery, burn, gross amount,
  accounts, instruction order, and cumulative carries before signing.
- Cloud withdrawal verifies asset, connected-wallet destination, fixed treasury,
  0.25% cumulative fee, account creation, gross amount, and signer policy.

## Residual risks

1. **Host-readable keys:** the managed Cloud and `--insecure` modes are hot-wallet
   custody. Malware, an agent escape, operator compromise, backups, or root can
   copy keys. Keep balances capped and move to a non-exportable signer.
2. **External transaction builders:** qOS validates returned transactions, but
   Jupiter/Raydium availability, quotes, and route construction remain external
   dependencies. Parser gaps or newly introduced program behavior require
   ongoing review.
3. **Single RPC oracle:** genesis and response schemas are checked, but account,
   simulation, slot, fee, and confirmation data still come from the configured
   provider. Add independent RPC monitoring or quorum for high-value use.
4. **Token complexity:** Token-2022 extensions, transfer fees, frozen/paused
   markets, malicious metadata, concentrated supply, and economic attacks can
   make a syntactically valid token unsafe or untradeable. No strategy guarantees
   profit or exit liquidity.
5. **JavaScript secret lifetime:** mutable buffers are wiped where practical,
   but strings, KeyObjects, native modules, and garbage-collected copies cannot
   be proven erased.
6. **MCP bearer security:** anyone with a box token can exercise that box's tool
   surface. Store it outside prompts/logs, rotate on disclosure, and retain host
   rate limits and TLS.
7. **Bare-metal gap:** QEMU is a demonstration. ROM trust, DMA isolation,
   rollback-safe state, measured boot, debug policy, PMP, secure update, fault
   handling, and non-exportable keys need exact-silicon implementation and
   independent firmware review.
8. **Independent assurance:** external Solana/parser, application, container,
   cryptographic, operational, and legal reviews are still required before
   unrestricted mainnet launch.

## Acceptance gate

- Run `npm run check` in clean CI and retain the result with the release digest.
- Fuzz mint/account/transaction parsers and venue response decoders.
- Test ambiguous delivery, provider corruption, stale quotes, RPC disagreement,
  process crashes, state rollback, and budget exhaustion.
- Pin and sign the source commit, runtime image, build inputs, SBOM, and release
  provenance.
- Use a capped canary, monitored transaction reconciliation, incident response,
  key rotation, and emergency disable procedure.
- Complete independent security and legal review.
