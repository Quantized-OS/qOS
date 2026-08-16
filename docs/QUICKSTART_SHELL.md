# qOS setup and secure firmware shell

This is the supported clone-to-shell beta experience for Ubuntu 20.04, 22.04,
and 24.04 on x86-64 or ARM64. Run setup as a normal user with `sudo` access for
distribution packages.

## Mainnet is the default

Start the guided mainnet setup with:

```sh
./setup.sh install
```

In an interactive terminal, qOS runs a full wizard. It explains mainnet and the
external signer in plain terms, shows the standard profile and command paths,
checks whether the signer is ready, validates the adapter executable, displays
a final summary, and asks for three public or operational values:

1. The public key already provisioned in a reviewed HSM, secure element,
   enclave, KMS, MPC service, or isolated signer.
2. The allowlisted destination public key.
3. The absolute path to the reviewed qOS signer adapter.

It never asks for or imports a mainnet private key. For unattended setup, pass
the same values explicitly:

```sh
./setup.sh install \
  --public-key YOUR_EXTERNAL_SIGNER_PUBLIC_KEY \
  --destination YOUR_ALLOWLISTED_DESTINATION \
  --signer-command /absolute/path/to/reviewed-adapter
```

Mainnet setup creates a public signer descriptor, strict policy, runtime
metadata, and owner-only API token. It creates no software private key and does
not build a QEMU signer because QEMU's seed would be readable by the host.

If you do not have a reviewed adapter, answer `no`. The wizard prints the exact
next steps and stops before it installs dependencies or creates files. Show the
guide at any time with:

```sh
./setup.sh install --signer-guide
```

The operator steps and adapter developer contract are in
[`SIGNER_ADAPTER_SETUP.md`](SIGNER_ADAPTER_SETUP.md). qOS does not bundle or
silently generate a production signer adapter.

## Mainnet workaround with a generated software key

If no external signer is available and you accept a key that local programs can
read, run:

```sh
./setup.sh install --insecure
```

The wizard prints the complete accessibility notice before creating anything,
asks for the one allowlisted destination, and requires a `yes` acknowledgement.
It then generates an Ed25519 key in the owner-only profile, creates the same
mainnet policy and API surface, installs the same qOS commands, and opens the
same shell. The implemented mainnet transfer, agent, simulation, signing,
submission, and confirmation behavior is the same as the external-signer path.

The difference is custody: `signer.pem` is accessible to every process that can
read files as the qOS user. A compromised AI agent, malware, backup, debugger,
or account can copy it and take the assets. Setup never prints the private key,
funds it, or broadcasts automatically.

For unattended setup, passing `--insecure` is not sufficient by itself. Supply
the destination and the explicit acknowledgement option:

```sh
./setup.sh install --insecure --accept-insecure-risk \
  --destination YOUR_ALLOWLISTED_DESTINATION
```

Do not combine `--insecure` with `--public-key`, `--signer-command`, or
`--devnet`. Re-running the command with `--insecure` reuses the existing key;
it never overwrites or silently rotates it.

## Devnet requires an explicit option

Disposable Devnet setup is never selected implicitly. Enable it with:

```sh
./setup.sh install --devnet
```

This path creates disposable development keys and a destination, installs the
policy, builds the locked RISC-V QEMU firmware, copies Cargo's output into a
private single-link ELF, records its measurement, installs commands, and opens
qOS. It never requests an airdrop, funds an account, or broadcasts a
transaction automatically.

All setup paths first install pinned user-local Node.js and Rust toolchains,
install required Ubuntu packages, and run every static check and Node.js test.
Re-running setup validates and reuses the existing profile instead of replacing
keys, tokens, or policy.

## Upgrading a directory that still has install.sh

The old Devnet-default `install.sh` is retired. A recognized old qOS installer
would otherwise trigger this safety-check error:

```text
AssertionError: install.sh: retired file must not exist
```

The new `setup.sh install` detects that exact legacy qOS script before toolchain
setup or tests, moves it into the private `.qos-setup-backup/` recovery folder,
and continues. The backup is not executed or included in a release build.

An unrecognized, symbolic, non-regular, oversized, or differently owned
`install.sh` is never deleted or overwritten. Setup stops and asks the operator
to preserve it outside the qOS source directory before retrying.

## qOS command experience

Setup installs `qos` as the interactive firmware shell. Start it later with:

```sh
qos
```

The banner and prompt identify the active profile. Long commands and
shorthands are equivalent:

| Long form | Shorthand |
| --- | --- |
| `capabilities` | `capa` |
| `status` | `stat` |
| `address` | `addr` |
| `health` | `hlth` |
| `balance` | `bal` |
| `airdrop` | `drop` |
| `sol` | `s` |
| `token` | `tok` |
| `firmware` | `fw` |
| `agent` | `ag` |
| `serve` | `api` |
| `security-audit` | `audit` |
| `prepare` | `prep` |
| `send` | `snd` |
| `build` | `bld` |
| `offline` | `off` |
| `broadcast` | `cast` |

The explicit `--confirm-broadcast` and `--confirm-live` options intentionally
have no shorthand.

Inspect the installed capabilities and custody mode:

```text
qos> capa
qos> stat
```

Rehearse provisioned Devnet firmware without contacting Solana:

```text
qos> fw off s 1000000
```

Create a live Devnet intent without signing or broadcasting it:

```text
qos> s prep 1000000
```

Funding and broadcasting remain separate, explicit Devnet operations:

```text
qos> drop 200000000
qos> s snd 1000000 --confirm-broadcast
```

Review and prepare a mainnet qOS Token-2022 transfer:

```text
qos> tok addr
qos> tok bal
qos> tok prep 1000000
qos> ag dry 1000000 -a basic
```

An onchain mainnet send remains a separate action:

```text
qos> tok snd 1000000 --confirm-live
```

The signer adapter must independently reconstruct and authorize the typed
transaction. Pointing qOS at a generic wallet CLI does not create a secure
custody boundary.

## Agents and non-interactive commands

Commands can be supplied directly, similar to an interactive developer CLI:

```sh
qos capa
qos fw off s 1000000
qos -r stat
```

Start the authenticated loopback API in the foreground with:

```text
qos> api 8787
```

The generated bearer token remains in the owner-only file reported by
`qos-profile show --home "$QOS_HOME"`. Do not put it in prompts, logs, shell
history, or model configuration. The service accepts loopback clients only.

The low-level sandbox CLI remains available as `qos-core`; automation should
normally prefer the restricted `qos` command surface.

## Uninstall

Remove the installed qOS command launchers with:

```sh
./setup.sh uninstall
```

Only regular files bearing the qOS managed-launcher marker are removed.
Unmanaged files are preserved. Profiles, policies, API tokens, keys,
toolchains, firmware measurements, and source files are deliberately retained
to prevent accidental loss of custody material. The command reports their
retention rather than silently deleting them.

Use `--bin PATH` if commands were installed outside `~/.local/bin`:

```sh
./setup.sh uninstall --bin /absolute/custom/bin
```

## Setup options

Run `./setup.sh install --help` or `./setup.sh uninstall --help` for the exact
surface. Install options include:

- `-d`, `--devnet` explicitly selects disposable development mode.
- `-i`, `--insecure` generates an accessible mainnet software key after notice.
- `-y`, `--accept-insecure-risk` acknowledges that notice for unattended setup.
- `-w`, `--wizard` forces guided questions when input is piped.
- `-G`, `--signer-guide` prints the signer walkthrough without installing.
- `-H`, `--home PATH` selects an isolated profile location.
- `-B`, `--bin PATH` selects the launcher directory.
- `-D`, `--destination PUBKEY` pins the destination.
- `-P`, `--public-key PUBKEY` supplies the mainnet external signer identity.
- `-S`, `--signer-command PATH` supplies the reviewed mainnet adapter.
- `-k`, `--skip-setup` uses already-installed dependencies.
- `-F`, `--skip-firmware` skips the Devnet QEMU build.
- `-n`, `--no-shell` finishes without entering qOS.

If `~/.local/bin` is not already on `PATH` in later terminals, add it:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## Implemented operation boundary

This source constructs one System Program SOL transfer and one pinned qOS
Token-2022 `TransferChecked` instruction. It contains no reviewed DEX swap,
order-book, liquidity, or perpetuals template. `trade` and `tr` fail with
`DEX_TEMPLATE_NOT_INSTALLED` before intent preparation or network access.

Adding trading requires a separately reviewed venue adapter that pins the
program ID, instruction discriminant, complete account list and writability,
mints, direction, slippage, exposure, fees, expiry, and output checks in both
the host parser and firmware. A transfer is not relabeled as a trade.

The tested setup matrix is Ubuntu 20.04, 22.04, and 24.04 on x86-64 or ARM64.
Other distributions are outside this beta matrix; Windows and macOS require a
Linux VM or a future native setup path.
