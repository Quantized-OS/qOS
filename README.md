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
* Privacy-preserving device and policy attestation events that contain no transaction details

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
* `docs/PRIVACY_ZK_CUSTODY.md` — Agent-safe key custody, AES-256-GCM keys, and SNARK verifier contract
* src/ — Dependency-free Solana RPC, policy, transaction, signer, relay, and ephemeral-session modules
* `bin/qos.js` — Sandbox CLI and local API server
* `bin/qos-firmware-demo.js` — QEMU provisioning, typed-intent mailbox, verification, and relay
* `firmware-demo/` — Bare-metal RV64 M-mode policy signer for QEMU `virt`
* `config/devnet.policy.json` — Fail-closed Devnet native-SOL policy template
* `config/mainnet.policy.json` — Mainnet policy pinned to the qOS Token-2022 mint
* test/ — Transaction, policy, privacy, firmware-mailbox, and relay integration tests
* `tests/static_checks.py` — Fail-closed starter invariants
* `SECURITY.md` — Threat model, deployment profiles, limitations, and disclosure guidance
* `HARDENING_REPORT.md` — Implemented controls, fixed defects, verification, and remaining gaps

The firmware code is intentionally incomplete. It will not produce a deployable firmware image until the target platform provides working implementations of ML-DSA-65, SHA3-384, rollback storage, measured boot, PMP locking, and failure handling. There is no development-signature bypass.

The repository now contains a working Solana sandbox. Devnet mode accepts typed OrderIntentV1 requests and constructs one pinned System Program transfer. The explicit mainnet mode accepts TokenTransferIntentV2 for the qOS mint 5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump and constructs one Token-2022 TransferChecked instruction. Both paths support an external non-exportable signer, an AES-256-GCM encrypted software-key fallback, and the original plaintext development signer. They simulate, submit, confirm, and forget completed transaction state. Neither path accepts arbitrary serialized messages for signing.

## Ephemeral transaction privacy

qOS v0.7.1 does not create transaction audit logs. Intent, blockhash, serialized
message, signature, and firmware mailbox data exist only while a request is
active. Host buffers are overwritten where the runtime permits it, firmware
mailboxes and stack buffers are wiped with volatile writes, and QEMU receives
its typed intent and runtime key through already-unlinked files on Linux tmpfs.
The firmware ELF contains policy constants but no Ed25519 seed. Raw signed
the firmware's public signature is redacted from the QEMU terminal transcript;
the raw transaction is never sent over that display channel.

The policy, public provisioning record, and firmware ELF remain on disk so the
sandbox keeps a stable identity and can verify what booted. External-signer
homes contain only a public signer descriptor and require an explicit public
destination, so initialization creates no private keys. Encrypted software
homes retain AES-256-GCM ciphertext and scrypt metadata. Plaintext demo homes
retain PEM keys. JavaScript strings are garbage-collected and cannot be given
the same zeroization guarantee as native buffers. Use the external signer with
a minimal host, swap disabled, and core dumps disabled for the strongest
implemented host boundary.

## Agent-safe key custody and private authorization

For an AI agent or any other untrusted automation, initialize qOS with an
already provisioned public key and destination:

```sh
node bin/qos.js init --signer-public-key YOUR_SIGNER_PUBLIC_KEY \
  --destination YOUR_ALLOWLISTED_DESTINATION
QOS_SIGNER_COMMAND=/absolute/path/to/reviewed-qos-signer-adapter \
  node bin/qos.js address
```

The qOS process stores no private key in this mode. The external adapter should
be backed by an HSM, TPM, enclave, KMS, MPC service, or isolated firmware that
independently pins the policy commitment and accepts only the typed protocol.
Possession of the adapter capability can still authorize policy-compliant
signatures, so OS permissions and signer-side policy enforcement remain
essential.

The optional SNARK gate accepts Groth16-BN254 or PLONK-BN254 proof envelopes
through a separately reviewed verifier adapter. qOS computes and binds the
public signals itself: exact intent commitment, policy commitment, signer,
expiry, circuit ID, proof system, and verifying-key SHA-256. No demo verifier is
enabled at runtime, and a required verifier fails closed if it is absent. See
[`docs/PRIVACY_ZK_CUSTODY.md`](docs/PRIVACY_ZK_CUSTODY.md) for the protocol and
honest security boundaries.

Ephemeral local handling does not make a broadcast transaction secret. Once
Solana accepts it, the signature, accounts, amount, and instruction are public
ledger data. Shell redirection, terminal recording, RPC logging, and client
code can also create copies outside qOS.

## Build the research starter

On Ubuntu 20.04, 22.04, or 24.04, the complete deterministic QEMU demo is one
command:

```sh
bash run-demo.sh
```

It installs missing prerequisites, runs every project check, initializes the
new ephemeral Devnet home, builds the RV64 firmware, and performs an offline
transaction-signing rehearsal without contacting Solana or spending funds.
`npm run demo` is an equivalent package-script entry point. Use
`bash run-demo.sh --help` for live verification and broadcast options, or
`npm run demo:build -- --skip-setup` to build and provision on a machine that
already has Node.js, Rust, and the RISC-V Rust target. Build-only mode does not
require QEMU.

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

## Build the research release media

After the host checks pass, `make release-media` creates a deterministic source
archive, checksums, and `release-artifacts/qos-0.7.1-research-media.iso`. The
ISO is valid ISO-9660 data media for offline review; it is not a bootable
production firmware installer. Read [`RELEASE_READINESS.md`](RELEASE_READINESS.md)
before treating any qOS image as more than a research demonstration.

## Run a real Solana Devnet transaction

Initialize disposable signer, receiver, and policy files:

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

## Transfer the qOS native token

The qOS token is pinned to mainnet address
`5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump`. The mint is owned by the
Token-2022 program, uses six decimals, and currently exposes metadata-pointer
and token-metadata mint extensions. The signer checks those properties and
fails closed if they change.

Initialize a separate mainnet sandbox with an allowlisted destination wallet:

```sh
node bin/qos.js init --home .qos-ephemeral-mainnet --cluster mainnet-beta \
  --destination YOUR_MAINNET_WALLET
node bin/qos.js address --home .qos-ephemeral-mainnet
node bin/qos.js token-address --home .qos-ephemeral-mainnet
```

Fund the printed signer with enough SOL for fees and send qOS tokens to its
derived token account. The destination wallet must already have its qOS
associated token account. Verify the source balance and prepare a one-token
intent; token amounts are base units, so `1000000` is one token:

```sh
node bin/qos.js token-balance --home .qos-ephemeral-mainnet
node bin/qos.js token-prepare --home .qos-ephemeral-mainnet --amount 1000000
```

Mainnet broadcast requires both an explicit transfer command and a separate
environment opt-in:

```sh
QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND \
  node bin/qos.js token-transfer --home .qos-ephemeral-mainnet --amount 1000000
```

Review .qos-ephemeral-mainnet/policy.json before funding the signer. The included
maximum is `1000000000` base units (1,000 tokens), and any policy edit requires
rebuilding the firmware demo before it will run.

## Demo firmware signing the transaction

The QEMU demonstration moves policy enforcement, Solana message construction,
and Ed25519 signing into a bare-metal RV64 M-mode firmware image. The host
loads fixed-size typed intent frames into a mailbox and receives only the
firmware signature over the emulated UART; it reconstructs the pinned message
locally for independent verification and optional relay. The firmware also
rejects an over-limit amount and a replayed nonce on screen before QEMU exits.

After installing QEMU, Rust, and the `riscv64imac-unknown-none-elf` Rust target:

```sh
node bin/qos-firmware-demo.js build
node bin/qos-firmware-demo.js run --offline --lamports 1000000
node bin/qos-firmware-demo.js run --lamports 1000000
node bin/qos-firmware-demo.js run --lamports 1000000 --broadcast
```

The first command builds a measured, key-independent policy ELF. The runtime
run command reads signer.pem only long enough to populate an unlinked
RAM-backed key mailbox, verifies the provisioned ELF measurement, executes the
firmware, and independently verifies the signature and exact instruction.
Offline mode is the deterministic stage
rehearsal: it requires no RPC, faucet, or funded signer and reports
`networkVerified: false`. Without `--offline`, the host obtains a current
blockhash, checks the signer balance, and simulates the transaction; with
`--broadcast`, it also relays and confirms it. See
[`docs/QEMU_FIRMWARE_DEMO.md`](docs/QEMU_FIRMWARE_DEMO.md) for setup, expected
terminal output, and the precise security boundary.

For the qOS Token-2022 path, provision from the separate mainnet sandbox and
run one token in verification-only mode before enabling broadcast:

```sh
node bin/qos-firmware-demo.js build --home .qos-ephemeral-mainnet
node bin/qos-firmware-demo.js run --home .qos-ephemeral-mainnet \
  --asset token --amount 1000000 --offline
QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND \
  node bin/qos-firmware-demo.js run --home .qos-ephemeral-mainnet \
  --asset token --amount 1000000 --broadcast
```

## Roadmap

* Boot the qOS root of trust under QEMU and verify failure and rollback behavior
* Integrate OpenSBI and a reproducible minimal OS image
* Move typed policy re-validation and message construction into reviewed HSM, enclave, or firmware adapters
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
