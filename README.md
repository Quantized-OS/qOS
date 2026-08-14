# qOS

### Verifiable firmware for private crypto trading systems

qOS is a secure firmware project for dedicated crypto trading machines.

Most trading systems rely on a broad and fragile trust base: a general-purpose operating system, hot-wallet files, third-party dependencies, RPC providers, relays, and application code with access to signing functions. qOS is intended to move the critical trust boundary below that stack into measured firmware, hardware-isolated signing, and policies that the trading process cannot bypass.

The design has three goals: **keep strategies and keys private, make the machine verifiable, and give crypto applications hardware-enforced control over what may be signed.**

Solana is the first test environment because it combines high-throughput execution, latency-sensitive trading, composable programs, and a clear need for safer automated signing.

> qOS is an early-stage research and engineering project. The concept is being discussed with AMD as a possible approach to bringing firmware assurance onchain while preserving privacy. This repository does not announce an AMD partnership, endorsement, product commitment, or planned integration.

## Why qOS

Crypto traders need more than faster bots. They need machines that can prove what they booted, protect signing authority if user space is compromised, and reject trades that violate policy.

qOS focuses on five properties:

1. **Verification from reset** — Immutable machine-mode code verifies each mutable boot stage before it runs.
2. **Keys remain below the application** — The trading engine never receives raw Solana private-key material.
3. **No arbitrary signing** — The isolated signer accepts typed, allowlisted trade intents rather than generic `sign(bytes)` requests.
4. **Privacy before inclusion** — Transactions can use direct or private relay paths to reduce pre-trade leakage and exposure to hostile ordering.
5. **Public assurance without exposing private state** — Boot measurements, policy versions, and update commitments can be anchored or attested onchain without publishing strategies, keys, positions, or firmware secrets.

The core idea is **verifiable firmware without transparent execution**. The network can verify the identity and approved state of a qOS machine while sensitive work remains local.

## What “firmware onchain” means

qOS does not attempt to run a BIOS inside a smart contract. It connects hardware-rooted machine state to cryptographic networks.

Depending on the deployment, onchain commitments could include:

* Device and deployment identities
* Approved firmware measurements
* Security policy versions
* Signed update and rollback records
* Remote attestation proofs
* Auditable signer-policy events with sensitive fields concealed

Firmware images, live keys, strategies, order flow, and private machine state remain offchain. Privacy is the default boundary rather than an optional application setting.

## Solana as the first test platform

The Solana version of qOS separates the system into narrowly scoped trust domains:

| Layer                  | Responsibility                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| Stage-0 firmware       | Post-quantum-verified boot, rollback prevention, measurements, and hardware isolation                   |
| OpenSBI and minimal OS | Hardware abstraction, networking, process isolation, and immutable updates                              |
| Trading engine         | Market data, strategy execution, simulation, and unsigned order intents                                 |
| Policy signer          | Builds allowlisted Solana messages and enforces exposure, slippage, fee, mint, venue, and account rules |
| Relay client           | Sends signed transactions through configured direct or private routes and tracks inclusion              |

The signer is designed to reject unknown programs, unexpected writable accounts, unapproved mints, excessive tips or compute fees, stale requests, replayed nonces, and trades that exceed configured exposure limits.

Solana transactions currently require Ed25519 signatures. qOS therefore uses post-quantum cryptography for its boot, update, recovery, and management trust chains while retaining an isolated Ed25519 signer for network-compatible transactions. A local firmware change cannot alter Solana’s consensus rules.

Private routing protects the path to the validator, not the finalized ledger. Once a standard trade lands, its public transaction data remains visible. qOS does not present private relay routing as permanent onchain confidentiality.

## What is included in this starter

* `firmware/reset.S` — RV64 machine-mode reset entry
* `firmware/secure_boot.c` — Image bounds, digest, ML-DSA verification, rollback, measurement, and hardware-lock flow
* `firmware/include/platform.h` — Security-critical SoC integration boundary
* `firmware/linker.ld` — QEMU-oriented development memory layout
* `docs/ARCHITECTURE.md` — Trust domains and privacy boundaries
* `docs/SIGNER_POLICY.md` — Narrow Solana order-intent signing contract
* `docs/SANDBOX.md` — Devnet setup, CLI and HTTP API guide
* `src/` — Dependency-free Solana RPC, policy, transaction, signer, relay, and audit modules
* `bin/qos.js` — Sandbox CLI and local API server
* `config/devnet.policy.json` — Fail-closed Devnet policy template
* `test/` — Transaction, policy, audit, and relay integration tests
* `tests/static_checks.py` — Fail-closed starter invariants

The firmware code is intentionally incomplete. It will not produce a deployable firmware image until the target platform provides working implementations of ML-DSA-65, SHA3-384, rollback storage, measured boot, PMP locking, and failure handling. There is no development-signature bypass.

The repository now also contains a working **Devnet-only Solana sandbox**. It accepts typed `OrderIntentV1` requests, constructs a single pinned System Program transfer internally, signs it with an isolated mock Ed25519 signer, simulates it, submits it, waits for confirmation, and records authorization in a keyed hash-chain audit log. It does not accept arbitrary serialized messages for signing.

## Build the research starter

Run the host-side invariant checks:

```sh
make check
```

This requires Python 3 and Node.js 20 or newer. It does not download npm packages.

With a `riscv64-linux-gnu-` cross-toolchain, compile the firmware objects:

```sh
make build/reset.o build/secure_boot.o
```

Do not use this repository with production keys or mainnet funds.

## Run a real Solana Devnet transaction

Initialize disposable signer, receiver, audit, and policy files:

```sh
node bin/qos.js init
```

Fund the printed signer with Devnet SOL, then send 0.001 Devnet SOL to the generated allowlisted receiver:

```sh
node bin/qos.js airdrop --lamports 200000000
node bin/qos.js transfer --lamports 1000000
```

The transfer command checks the RPC genesis hash, creates a fresh bounded intent, applies policy, calculates the network fee, signs, simulates, broadcasts, polls `getSignatureStatuses`, and returns a Devnet Explorer link only after confirmation. The public Devnet faucet and RPC can rate-limit requests; a dedicated Devnet RPC may be selected with `SOLANA_RPC_URL`, but its genesis hash must match the pinned policy.

To allow an existing Devnet wallet instead of generating a receiver:

```sh
node bin/qos.js init --destination YOUR_DEVNET_PUBLIC_KEY
```

For the local HTTP interface and the complete two-step prepare/submit flow, see [`docs/SANDBOX.md`](docs/SANDBOX.md).

## Roadmap

* Boot the qOS root of trust under QEMU and verify failure and rollback behavior
* Integrate OpenSBI and a reproducible minimal OS image
* Replace the Devnet mock signer with an isolated process or hardware boundary
* Add a reviewed DEX instruction template after program, market, account, and token validation is specified
* Add a pinned private relay adapter; the current sandbox uses standard Solana JSON-RPC
* Anchor approved firmware measurements and policies onchain
* Port the hardware trust boundary to an AMD platform if technical and commercial discussions produce an agreed integration path
* Commission independent reviews of the firmware, custody model, Solana message handling, side-channel resistance, and fault-injection behavior before any mainnet deployment

## Who qOS is for

* Crypto-native market makers and trading teams
* Protocols operating automated treasury or liquidity infrastructure
* Wallet and custody providers that require policy-enforced signing
* Validator, relay, and RPC infrastructure teams
* Hardware vendors exploring verifiable, privacy-preserving crypto execution

qOS is not a wallet interface or a trading bot. It is intended to provide the trusted machine layer beneath them.

## Primary references

* [NIST FIPS 204: Module-Lattice-Based Digital Signature Standard](https://csrc.nist.gov/pubs/fips/204/final)
* [RISC-V OpenSBI](https://github.com/riscv-software-src/opensbi)
* [Solana transaction structure](https://solana.com/docs/core/transactions/transaction-structure)
* [Solana production signing](https://solana.com/docs/core/transactions/signing-in-production)
* [Solana Confidential Transfer](https://solana.com/docs/tokens/extensions/confidential-transfer)
* [Jito low-latency transaction sending](https://docs.jito.wtf/lowlatencytxnsend/)
