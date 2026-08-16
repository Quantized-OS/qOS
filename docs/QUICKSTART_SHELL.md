# One-command install and qOS Shell

This path is the supported clone-to-shell beta experience for Ubuntu 20.04,
22.04, and 24.04 on x86-64 or ARM64. Run it as a normal user with `sudo`
access for distribution packages:

```sh
./install.sh
```

The installer performs these steps in order:

1. Installs the required Ubuntu packages.
2. Downloads pinned Node.js and rustup artifacts from their official release
   hosts, verifies them against the official SHA-256 manifests, and installs
   them below the current user's qOS data directory. It does not execute a
   downloaded shell script.
3. Installs the pinned Rust toolchain and bare-metal RISC-V target.
4. Runs every static check and Node.js test.
5. Creates a disposable Devnet signer, destination, and strict policy.
6. Creates an owner-only API token and runtime profile without printing the
   token.
7. Builds the locked Rust firmware, copies Cargo's output into a private
   single-link ELF, and records its measurement.
8. Installs user-local commands under `~/.local/bin` and opens qOS Shell.

The installer never requests an airdrop, funds an address, or broadcasts a
transaction. Re-running it reuses and validates the existing profile instead
of overwriting keys or policy.

The first run enters qOS Shell by absolute launcher path. If `~/.local/bin` is
not already on `PATH` in later terminals, add it before using the short command
names:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## Shell commands

Start the shell again with:

```sh
qos-shell
```

Inspect the actual installed capabilities and custody mode:

```text
qos> capabilities
qos> status
```

Rehearse the provisioned firmware without contacting Solana:

```text
qos> firmware offline sol 1000000
```

Create a live Devnet intent without signing or broadcasting it:

```text
qos> sol prepare 1000000
```

Funding and broadcasting are separate, explicit operations:

```text
qos> airdrop 200000000
qos> sol send 1000000 --confirm-broadcast
```

The public Devnet faucet may rate-limit the airdrop. The transfer remains
bounded by the destination, amount, fee, cluster, blockhash, instruction, and
replay policy even after the shell confirmation.

Start the loopback agent API in the foreground:

```text
qos> serve 8787
```

The generated bearer token remains in the owner-only file reported by
`qos-profile show --home "$QOS_HOME"`. Do not copy it into prompts, logs, shell
history, or model configuration. The service accepts loopback clients only.

Every shell operation also has a non-interactive form suitable for an agent or
supervisor:

```sh
qos-shell --run capabilities
qos-shell --run firmware offline sol 1000000
qos balance
qos prepare --lamports 1000000
qos-agent-security-audit
```

The purpose-built shell never evaluates arbitrary shell text. Its child
processes use argument arrays with shell execution disabled.

## Mainnet external-signer profile

Do not use the disposable Devnet key for mainnet. Provision the public key in
a reviewed HSM, secure element, enclave, KMS, MPC service, or isolated signer
first, then run:

```sh
./install.sh \
  --profile mainnet-external \
  --public-key YOUR_EXTERNAL_SIGNER_PUBLIC_KEY \
  --destination YOUR_ALLOWLISTED_DESTINATION \
  --signer-command /absolute/path/to/reviewed-adapter
```

This profile creates `signer.json`, policy, runtime metadata, and an API token.
It creates no software private key. It also does not build the QEMU signer,
because QEMU's runtime seed is host-readable and therefore cannot represent a
mainnet custody boundary.

Review and prepare a qOS Token-2022 transfer:

```text
qos> token address
qos> token balance
qos> token prepare 1000000
qos> agent dry-run 1000000 --agent basic
```

An onchain send remains a separate explicit action:

```text
qos> token send 1000000 --confirm-live
```

The signer adapter must independently enforce the typed authorization
protocol. Merely pointing qOS at a generic wallet CLI does not create a secure
external boundary.

## Implemented operation boundary

This source release constructs one System Program SOL transfer and one pinned
qOS Token-2022 `TransferChecked` instruction. It does not contain a reviewed
DEX swap, order-book, liquidity, or perpetuals instruction template. Running
`trade` fails with `DEX_TEMPLATE_NOT_INSTALLED` before intent preparation or
network access.

Adding trading requires a separately reviewed venue adapter that pins the
program ID, instruction discriminant, complete account list and writability,
mints, direction, slippage, exposure, fees, expiry, and output checks in both
the host parser and the firmware. A transfer is not relabeled as a trade.

## Installer options

Use `./install.sh --help` for the complete surface. Important options include:

- `--home PATH` selects an isolated profile location.
- `--destination PUBKEY` pins an existing destination.
- `--skip-setup` uses already-installed dependencies without downloading the
  pinned user toolchain.
- `--skip-firmware` provisions the host profile without a QEMU build.
- `--no-shell` finishes installation without entering the interactive shell.

The installer supports Debian-family package management through its Ubuntu
setup path, but non-Ubuntu distributions receive a warning and are not part of
the tested beta matrix. Windows and macOS require a Linux VM or a future native
installer.
