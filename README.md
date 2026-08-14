# qOS

### Private execution. Verifiable firmware. Crypto-native control.

qOS is secure trading firmware for crypto-native machines.

Trading infrastructure still asks users to trust a fragile stack: a general-
purpose operating system, hot-wallet files, third-party dependencies, RPC
providers, relays, and application code that can request signatures. qOS moves
the critical trust boundary beneath that stackâ€”into measured firmware,
hardware-isolated signing, and policies the trading process cannot bypass.

The goal is straightforward: **keep strategy and keys private, make the machine
verifiable, and give crypto applications hardware-enforced control over what
can be signed.**

Solana is the first test environment because it combines high-throughput
execution, latency-sensitive trading, composable programs, and an immediate
need for safer automated signing.

> qOS is an early research and engineering project. The concept is currently
> being discussed with AMD around bringing firmware assurance onchain with
> privacy by default. This repository does not announce an AMD partnership,
> endorsement, product commitment, or shipping integration.

## Why qOS

Crypto traders do not only need a faster bot. They need a machine that can
prove what it booted, protect its signing authority when user space is
compromised, and reject trades that violate policy.

qOS is designed around five guarantees:

1. **Verified from reset** â€” immutable machine-mode code verifies every mutable
   boot stage before execution.
2. **Keys stay below the app** â€” the trading engine never receives raw Solana
   private-key material.
3. **No arbitrary signing** â€” the isolated signer accepts typed, allowlisted
   trade intents instead of a generic `sign(bytes)` request.
4. **Privacy before inclusion** â€” transaction routing can use direct/private
   relay paths to reduce pre-trade leakage and hostile ordering exposure.
5. **Public assurance, private state** â€” boot measurements, policy versions,
   and update commitments can be anchored or attested onchain without placing
   strategies, keys, positions, or raw firmware secrets onchain.

The thesis is **verifiable firmware without transparent execution**: the chain
can verify the identity and approved state of a qOS machine while the sensitive
work stays local.

## What â€œfirmware onchainâ€ means

qOS is not an attempt to run a BIOS inside a smart contract. It is a bridge
between hardware-rooted state and cryptographic networks.

Potential onchain commitments include:

- Device and deployment identity
- Approved firmware measurements
- Security-policy versions
- Signed update and rollback records
- Remote-attestation proofs
- Auditable signer-policy events with sensitive fields concealed

Firmware images, live keys, strategies, order flow, and private machine state
remain offchain. Privacy is the default boundary, not an optional application
setting.

## Solana: the first proving ground

The Solana version of qOS separates the system into narrowly scoped trust
domains:

| Layer | Responsibility |
| --- | --- |
| Stage-0 firmware | Post-quantum verified boot, rollback prevention, measurements, and hardware isolation |
| OpenSBI + minimal OS | Hardware abstraction, networking, process isolation, and immutable updates |
| Trading engine | Market data, strategy, simulation, and unsigned order intent |
| Policy signer | Builds allowlisted Solana messages and enforces exposure, slippage, fee, mint, venue, and account rules |
| Relay client | Sends signed transactions through configured direct/private routes and tracks inclusion |

The signer is designed to reject unknown programs, unexpected writable
accounts, unapproved mints, excessive tips or compute fees, stale requests,
replayed nonces, and trades outside configured exposure limits.

Solana transactions currently require Ed25519 signatures. qOS therefore uses
post-quantum cryptography for the boot, update, recovery, and management trust
chains while retaining an isolated Ed25519 signer for network-compatible
transactions. A local firmware change cannot alter Solana consensus rules.

Private routing protects the path to the validator, not the finalized ledger.
Once a normal trade lands, its public transaction data remains visible. qOS
does not market relay routing as permanent onchain confidentiality.

## What is in this starter

- `firmware/reset.S` â€” RV64 machine-mode reset entry
- `firmware/secure_boot.c` â€” image bounds, digest, ML-DSA verification,
  rollback, measurement, and hardware-lock flow
- `firmware/include/platform.h` â€” security-critical SoC integration boundary
- `firmware/linker.ld` â€” QEMU-oriented development memory layout
- `docs/ARCHITECTURE.md` â€” trust domains and privacy boundaries
- `docs/SIGNER_POLICY.md` â€” narrow Solana order-intent signing contract
- `tests/static_checks.py` â€” fail-closed starter invariants

The available code is intentionally incomplete. It refuses to produce a
deployable firmware image until the target platform supplies real ML-DSA-65,
SHA3-384, rollback storage, measured boot, PMP locking, and failure-handling
implementations. There is no development signature bypass.

## Build the research starter

Run the host-side invariants:

```sh
make check
```

With a `riscv64-linux-gnu-` cross-toolchain, compile the firmware objects:

```sh
make build/reset.o build/secure_boot.o
```

Do not use this repository with production keys or mainnet funds. The first
end-to-end milestone is a devnet-only order builder connected to a mock signer
that enforces `docs/SIGNER_POLICY.md`.

## Roadmap

- Boot the qOS root of trust under QEMU and verify failure/rollback behavior
- Integrate OpenSBI and a reproducible minimal OS image
- Build the isolated Solana order-intent signer
- Add devnet transaction templates for one tightly allowlisted venue
- Integrate direct/private relay routing and inclusion monitoring
- Anchor approved firmware measurements and policies onchain
- Port the hardware trust boundary to an AMD-aligned platform if technical and
  commercial discussions produce an agreed integration path
- Commission independent firmware, custody, Solana-message, side-channel, and
  fault-injection reviews before any mainnet deployment

## Who qOS is for

- Crypto-native market makers and trading teams
- Protocols operating automated treasury or liquidity infrastructure
- Wallet and custody providers that need policy-enforced signing
- Validator, relay, and RPC infrastructure teams
- Hardware vendors exploring verifiable, privacy-preserving crypto execution

qOS is not another wallet UI and not another trading bot. It is the trusted
machine beneath them.

## Primary references

- NIST FIPS 204, ML-DSA: https://csrc.nist.gov/pubs/fips/204/final
- RISC-V OpenSBI: https://github.com/riscv-software-src/opensbi
- Solana transaction structure: https://solana.com/docs/core/transactions/transaction-structure
- Solana production signing: https://solana.com/docs/core/transactions/signing-in-production
- Solana Confidential Transfer: https://solana.com/docs/tokens/extensions/confidential-transfer
- Jito low-latency transaction send: https://docs.jito.wtf/lowlatencytxnsend/
