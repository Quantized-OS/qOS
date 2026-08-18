# qOS

### Verifiable firmware for private crypto trading systems

qOS is a secure firmware project for dedicated crypto trading machines.

Most trading systems rely on a broad and fragile trust base: a general-purpose operating system, hot-wallet files, third-party dependencies, RPC providers, relays, and application code with access to signing functions. qOS is intended to move the critical trust boundary below that stack into measured firmware, hardware-isolated signing, and policies that the trading process cannot bypass.

The design has three goals: **keep strategies and keys private, make the machine verifiable, and give crypto applications hardware-enforced control over what may be signed.**

Solana is the first test environment because it combines high-throughput execution, latency-sensitive trading, composable programs, and a clear need for safer automated signing.

> qOS is an early-stage research and engineering project. The concept is being discussed with AMD as a possible approach to bringing firmware assurance onchain while preserving privacy. This repository does not announce an AMD partnership, endorsement, product commitment, or planned integration.

## Clone to qOS

After a GitHub Release is published and the thin `qos.systems` bootstrap is
deployed, installation is:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh | sh
```

On macOS, the host wrapper installs or reuses a mount-isolated Lima Ubuntu VM:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install-macos.sh | sh
```

On Windows, run the WSL 2 + Ubuntu 24.04 wrapper from PowerShell:

```powershell
irm https://qos.systems/install-windows.ps1 | iex
```

The site hosts only the bootstrap. It downloads and verifies the latest release
assets from `https://github.com/Quantized-OS/qOS`. The repository generates the
site tree with `make web-release` and GitHub assets with `make github-release`;
source code alone does not deploy either service. See
[`docs/BROWSER_INSTALL.md`](docs/BROWSER_INSTALL.md).

On a supported Ubuntu x86-64 or ARM64 host, the beta onboarding path is one
command after cloning. Mainnet is the default network. The interactive wizard
first asks whether to use an existing key through a reviewed external signer or
generate an accessible software key. External custody is the recommended
preselected choice; it then checks adapter permissions, shows a final summary,
and asks only for the signer public key, allowlisted destination, and reviewed
adapter path:

```sh
./setup.sh install
```

For disposable development only, Devnet must be selected explicitly:

```sh
./setup.sh install --devnet
```

Setup installs verified user-local Node.js and Rust toolchains, Ubuntu/QEMU
packages, runs the complete test suite, provisions the selected profile and
private API token, verifies the source wallet against the pinned cluster,
installs exactly one operator command, `qos`, under `~/.local/bin`, then opens
the restricted qOS firmware shell. Devnet requests a confirmed faucet airdrop by
default; `--no-fund` or `--offline` disables that step. Mainnet never funds or
broadcasts automatically. Onboarding an agent generates its scoped skill pack
and automatically starts one authenticated loopback REST/MCP service. The
recommended existing-key mainnet path creates no software private key and does
not use the host-readable QEMU signer.

Choosing “generate a key” continues through exactly the same guarded path as
passing `--insecure` explicitly:

```sh
./setup.sh install --insecure
```

The wizard displays the key-access warning and requires acceptance before it
installs dependencies or creates the key. This profile has the same implemented
mainnet qOS transfer and agent capabilities as the external-signer profile; only
the custody boundary changes. Programs running as the user can copy the key.

For one prompt-free invocation that also configures a commercial model and the
first scoped agent, pass every value explicitly:

```sh
bash setup.sh install \
  --unattended \
  --insecure \
  --accept-insecure-risk \
  --destination YOUR_ALLOWLISTED_DESTINATION \
  --model-provider openai \
  --model-profile openai \
  --model YOUR_OPENAI_MODEL \
  --model-api-key 'YOUR_OPENAI_API_KEY' \
  --agent-id test-agent \
  --agent-name 'Test agent' \
  --agent-approval auto \
  --agent-max-amount 1000000000 \
  --accept-auto
```

`--unattended` suppresses every wizard and finishes without opening the shell;
it does not bypass either risk acknowledgement. The literal key form is
supported, copied into the profile's mode-`0600` credential file, and never
printed. It can still be exposed by shell history or process inspection. Prefer
`--model-api-key-env OPENAI_API_KEY` after exporting that variable, or
`--model-api-key-file /owner-only/path`, on a real host. Re-running the same
invocation verifies the model settings, refreshes the supplied model key, and
preserves the qOS signing key and agent credential.

If no reviewed adapter is available yet, the wizard stops before installing
anything and prints the signer checklist. It is also available directly:

```sh
./setup.sh install --signer-guide
```

See [`docs/SIGNER_ADAPTER_SETUP.md`](docs/SIGNER_ADAPTER_SETUP.md) for the
plain-language operator walkthrough and exact adapter contract.

Inside the shell, start with:

```text
qos> capa
qos> stat
qos> wal status
qos> mod on
qos> ag on
qos> ag st
qos> pol show
qos> fw off s 1000000
qos> s prep 1000000
```

See [`docs/QUICKSTART_SHELL.md`](docs/QUICKSTART_SHELL.md) for Devnet sends,
the loopback agent REST/MCP service, readable output, long and shorthand commands, uninstall
behavior, and both mainnet custody setup paths. Agent lifecycle and execution
modes are in [`docs/AGENT_ONBOARDING.md`](docs/AGENT_ONBOARDING.md); wallet and
policy operations are in
[`docs/WALLET_AND_POLICY.md`](docs/WALLET_AND_POLICY.md). The current source implements
policy-gated transfers, not DEX swaps; `trade` fails closed until a reviewed
venue template exists.

## Separate qOS Cloud project

This repository is only the qOS firmware, restricted shell, self-hosted setup,
model/agent framework, and policy signer. It does not contain the managed
website, Phantom account service, customer wallets, orchestration backend,
hourly metering, market-price feed, or billing ledger.

Those components live in the independent
[`Quantized-OS/qOS-Cloud`](https://github.com/Quantized-OS/qOS-Cloud)
repository. qOS exports the versioned `qos-solana-sandbox/platform-sdk`
interface that an installed Cloud release may consume. The Cloud project
remains independently installable and versioned; it never belongs under this
source tree.

The supported integration contract is documented in
[`docs/PLATFORM_SDK.md`](docs/PLATFORM_SDK.md).

Self-hosted installation remains unchanged on Linux, macOS, and Windows and has
no managed runtime charge. The qOS core still enforces the atomic settlement
template used by Cloud—99% to the pinned treasury and a cumulative 1%
Token-2022 burn—without owning the Cloud business logic or service.

## Why qOS

Crypto traders need more than faster bots. They need machines that can prove what they booted, protect signing authority if user space is compromised, and reject trades that violate policy.

qOS focuses on five properties:

1. **Verification from reset** — Immutable machine-mode code verifies each mutable boot stage before it runs.
2. **Keys can remain below the application** — The preferred external signer keeps raw Solana private-key material out of the trading engine; `--insecure` explicitly gives up this property.
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
* `docs/AGENT_DEMO.md` — Agent-directed qOS Token-2022 transfer rehearsal
* `docs/MODEL_PROVIDERS.md` — Commercial LLM BYOK profiles, adapters, key rotation, and custom endpoints
* `docs/AGENT_ONBOARDING.md` — Per-agent credentials, skills, approvals, listener, and offboarding
* `docs/WALLET_AND_POLICY.md` — Cluster readiness, Devnet funding, and atomic inline policy edits
* `docs/BROWSER_INSTALL.md` — Verified `curl | sh` publication and trust boundary
* `docs/QUICKSTART_SHELL.md` — One-command install, runtime profiles, and qOS Shell
* `docs/SIGNER_ADAPTER_SETUP.md` — Guided signer-adapter deployment and review contract
* `docs/AGENT_SECURITY_TEST.md` — Synthetic red-team test for agent/key boundaries
* `docs/PRIVACY_ZK_CUSTODY.md` — Agent-safe key custody, AES-256-GCM keys, and SNARK verifier contract
* `src/` — Dependency-free Solana RPC, policy, transaction, signer, relay, and ephemeral-session modules
* `bin/qos-shell.js` — The only installed command; restricted interactive and one-shot qOS interface
* `bin/` — Private command implementations dispatched behind `qos` subcommands; they are not installed as companion executables
* `setup.sh` — Mainnet-default setup, wallet/agent onboarding, and confirmed full-purge uninstall
* `web/index.html` — Install-first qos.systems landing page with Linux, macOS, and Windows choices
* `web/install.sh` — Checksum-verifying POSIX browser bootstrap served separately from the source root
* `web/install-macos.sh` — Lima/Ubuntu macOS host wrapper with host mounts disabled
* `web/install-windows.ps1` — WSL 2/Ubuntu Windows host wrapper
* `firmware-demo/` — Bare-metal RV64 M-mode policy signer for QEMU `virt`
* `config/devnet.policy.json` — Fail-closed Devnet native-SOL policy template
* `config/mainnet.policy.json` — Mainnet policy pinned to the qOS Token-2022 mint
* `test/` — Transaction, policy, privacy, firmware-mailbox, and relay integration tests
* `tests/static_checks.py` — Fail-closed starter invariants
* `docs/SECURITY.md` — Threat model, deployment profiles, limitations, and disclosure guidance
* `docs/reports/HARDENING_REPORT.md` — Implemented controls, fixed defects, verification, and remaining gaps
* `docs/reports/PRODUCTION_SECURITY_REVIEW.md` — Production-preparation findings, blockers, and acceptance criteria

The firmware code is intentionally incomplete. It will not produce a deployable
firmware image until the target platform provides working implementations of
boot-source/DMA locking, ML-DSA-65, SHA3-384, rollback storage, measured boot,
authenticated FDT handling, PMP locking, root-secret locking, and failure
handling. There is no development-signature bypass.

The repository contains a working Solana sandbox. Devnet mode accepts typed
`OrderIntentV1` requests and constructs one pinned System Program transfer. The
explicit mainnet mode accepts `TokenTransferIntentV2` for the qOS mint
`5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump` and constructs one Token-2022
`TransferChecked` instruction. Mainnet submission accepts either a
non-exportable external signer or a setup-created `mainnet-insecure` software
profile whose accessibility notice was acknowledged. Both paths use the same
policy validation, simulate, submit, confirm, and forget
completed transaction state. Neither accepts arbitrary serialized messages for
signing.

## Ephemeral transaction privacy

qOS v0.11.1 does not create transaction audit logs. Intent, blockhash, serialized
message, signature, and firmware mailbox data exist only while a request is
active. Host buffers are overwritten where the runtime permits it, firmware
mailboxes and stack buffers are wiped with volatile writes, and QEMU receives
its typed intent and runtime key through already-unlinked files on Linux tmpfs.
The firmware ELF contains policy constants but no Ed25519 seed. The firmware's
public signature is redacted from the QEMU terminal transcript; the raw
transaction is never sent over that display channel.

The policy, public provisioning record, and firmware ELF remain on disk so the
sandbox keeps a stable identity and can verify what booted. External-signer
homes contain only a public signer descriptor and require an explicit public
destination, so initialization creates no private keys. Encrypted software
homes retain AES-256-GCM ciphertext and scrypt metadata. Plaintext demo homes
retain PEM keys. Runtime API tokens, per-agent credential files, commercial
model API-key files, hashed agent/model registry entries, and generated skill
packs persist until explicitly revoked
or a confirmed full uninstall removes the registered qOS installation; pending
approvals and completed transaction details do not.
JavaScript strings are garbage-collected and cannot be given
the same zeroization guarantee as native buffers. Use the external signer with
a minimal host, swap disabled, and core dumps disabled for the strongest
implemented host boundary.

## Agent-safe key custody and private authorization

For an AI agent or any other untrusted automation, initialize qOS with an
already provisioned public key and destination:

```sh
./setup.sh install --public-key YOUR_SIGNER_PUBLIC_KEY \
  --destination YOUR_ALLOWLISTED_DESTINATION \
  --signer-command /absolute/path/to/reviewed-qos-signer-adapter
qos address
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

For the complete first-run setup, use `./setup.sh install` (mainnet custody
chooser), `./setup.sh install --insecure` (explicit accessible software-custody
mainnet), or `./setup.sh install --devnet` (disposable development). For an operator-managed
toolchain, first install Node.js 20 or newer and rustup from verified, pinned
package sources. The demo wrapper can then install missing Ubuntu packages,
run the checks, and launch the deterministic QEMU demo:

```sh
bash run-demo.sh
```

It installs missing distribution packages, verifies the preinstalled Node/Rust
toolchain, initializes a new ephemeral Devnet home, builds the RV64 firmware,
and performs an offline transaction-signing rehearsal without contacting
Solana or spending funds. It never downloads and executes a remote bootstrap
script.
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

The `--insecure` path can execute the implemented mainnet operations, but its
private key is a host-readable hot-wallet key. Do not confuse that convenience
with production-grade firmware or non-exportable custody.

## Build the research release media

After the host checks pass, `make release-media` creates a deterministic source
archive, checksums, and `release-artifacts/qos-0.11.1-research-media.iso`. The
ISO is valid ISO-9660 data media for offline review; it is not a bootable
production firmware installer. Read [`RELEASE_READINESS.md`](docs/reports/RELEASE_READINESS.md)
before treating any qOS image as more than a research demonstration.

`make github-release` generates the latest-release assets consumed by every
installer. `make web-release` separately generates the `qos.systems` front
page and three thin platform bootstraps; the deployment tree contains no source
archive.

## Run a real Solana Devnet transaction

Install a disposable Devnet profile without immediately entering the shell:

```sh
./setup.sh install --devnet --no-shell
```

Fund the printed signer with Devnet SOL, then send 0.001 Devnet SOL to the
generated allowlisted receiver:

```sh
qos wallet fund 200000000
qos sol send 1000000 --confirm-broadcast
```

The transfer command checks the RPC genesis hash, creates a fresh bounded intent, applies policy, calculates the network fee, signs, simulates, broadcasts, polls `getSignatureStatuses`, and returns a Devnet Explorer link only after confirmation. The public Devnet faucet and RPC can rate-limit requests; a dedicated Devnet RPC may be selected with `SOLANA_RPC_URL`, but its genesis hash must match the pinned policy.

To allow an existing Devnet wallet instead of generating a receiver:

```sh
./setup.sh install --devnet --destination YOUR_DEVNET_PUBLIC_KEY --no-shell
```

For the local HTTP interface and the complete two-step prepare/submit flow, see [`docs/SANDBOX.md`](docs/SANDBOX.md).

## Transfer the qOS native token

The qOS token is pinned to mainnet address
`5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump`. The mint is owned by the
Token-2022 program, uses six decimals, and currently exposes metadata-pointer
and token-metadata mint extensions. The signer checks those properties and
fails closed if they change.

Install a mainnet profile with the public identity of a reviewed external
policy signer and an allowlisted destination wallet:

```sh
./setup.sh install --public-key YOUR_EXTERNAL_SIGNER_PUBLIC_KEY \
  --destination YOUR_MAINNET_WALLET \
  --signer-command /absolute/path/to/reviewed-qos-signer-adapter
qos address
qos token address
```

Fund the printed signer with enough SOL for fees and send qOS tokens to its
derived token account. The destination wallet must already have its qOS
associated token account. Verify the source balance and prepare a one-token
intent; token amounts are base units, so `1000000` is one token:

```sh
qos token balance
qos token prepare 1000000
```

Mainnet broadcast requires an explicit shell confirmation:

```sh
qos token send 1000000 --confirm-live
```

Review `.qos-ephemeral-mainnet/policy.json` before funding the signer. The
included maximum is `1000000000` base units (1,000 tokens). A separately
provisioned QEMU demo must be rebuilt after any change to its own demo policy.

## Agent-directed transfer demo

`qos agent demo` connects a deterministic basic agent, a local
OpenAI-compatible model, or an operator-configured commercial BYOK provider to
the pinned qOS Token-2022 transfer path. Native adapters cover OpenAI,
Anthropic Claude, Google Gemini, and Cohere; fixed OpenAI-compatible presets
cover xAI, Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks,
Perplexity, and Cerebras. Azure and custom compatible endpoints are also
available with an explicit endpoint acknowledgement.
The agent proposes a typed action; qOS remains authoritative for the mint,
destination, amount, accounts, fees, simulation, signing, and confirmation.
The default is validation-only:

```sh
qos agent demo dry 1000000
```

To use a local or commercial account, run the guided model onboarding. It
defaults to local Ollama-compatible inference; selecting a commercial provider
imports its key from an owner-only file without placing the key in a CLI value:

```sh
qos model onboard
qos model default
qos agent demo dry 1000000 --agent model
```

Use `qos model use ID` to switch defaults or `--model-profile ID` for a
one-run override.

See [`docs/MODEL_PROVIDERS.md`](docs/MODEL_PROVIDERS.md) for BYOK configuration
and [`docs/AGENT_DEMO.md`](docs/AGENT_DEMO.md) for the explicit
`--broadcast --confirm-live` mainnet gates. This is an agent-directed
Token-2022 transfer, not a DEX swap; the reviewed DEX instruction adapter is
still a roadmap item.

## Synthetic agent security analysis

Run the red-team harness before giving any automation access to a qOS host:

```sh
qos security-audit
```

It creates disposable synthetic keys only. The harness demonstrates why
plaintext and passphrase-accessible software-key homes are unsafe for agents,
verifies the external-signer file boundary, attacks malicious proposal output,
and checks the live-broadcast gate. It never reads a real home, contacts
Solana, or broadcasts a transaction. See
[`docs/AGENT_SECURITY_TEST.md`](docs/AGENT_SECURITY_TEST.md).

## Create an external-signer home

The public key must come from the external signer, HSM, or reviewed adapter and
must correspond to the private key held there. qOS cannot derive this public
key from a plaintext home without reusing the unsafe key custody profile.

The setup helper can reuse the existing home’s allowlisted destination, but it
never reads or copies `signer.pem`:

```sh
npm run setup:agent-external -- \
  --public-key EXTERNAL_SIGNER_PUBLIC_KEY \
  --source-home .qos-ephemeral-mainnet \
  --home .qos-ephemeral-mainnet-external \
  --signer-command /absolute/path/to/reviewed-signer-adapter \
  --create
```

It creates only `signer.json` and `policy.json`, prints the new signer token
account, and does not fund, migrate, or broadcast anything. Review the output
and run `privacy-status` on the new home before funding it.

## Demo firmware signing the transaction

The QEMU demonstration moves policy enforcement, Solana message construction,
and Ed25519 signing into a bare-metal RV64 M-mode firmware image. The host
loads fixed-size typed intent frames into a mailbox and receives only the
firmware signature over the emulated UART; it reconstructs the pinned message
locally for independent verification and optional relay. The firmware also
rejects an over-limit amount and a replayed nonce on screen before QEMU exits.

After installing QEMU, Rust, and the `riscv64imac-unknown-none-elf` Rust target:

```sh
qos firmware build
qos firmware offline sol 1000000
qos firmware live sol 1000000
qos firmware broadcast sol 1000000 --confirm-live
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

For the qOS Token-2022 path, use a separate disposable software-key demo home
(not the external-signer custody home) and run one token in offline or live
verification-only mode:

```sh
./setup.sh install --insecure --accept-insecure-risk \
  --destination YOUR_DEMO_DESTINATION --home .qos-qemu-mainnet-demo \
  --offline --no-shell
qos --home .qos-qemu-mainnet-demo firmware build
qos --home .qos-qemu-mainnet-demo firmware offline token 1000000
```

The QEMU runner refuses mainnet broadcast because its software seed is visible
to the host. It is a policy-enforcement rehearsal, not a custody boundary.

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
