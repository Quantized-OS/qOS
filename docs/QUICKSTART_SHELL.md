# qOS setup and secure firmware shell

This is the supported clone-to-shell beta experience for Ubuntu 20.04, 22.04,
and 24.04 on x86-64 or ARM64. Run setup as a normal user with `sudo` access for
distribution packages.

## Browser install

Once the operator has published a GitHub Release and deployed the thin
`web-root` bootstrap, run:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh | sh
```

macOS runs the same verified installer inside a dedicated Lima Ubuntu VM:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install-macos.sh | sh
```

Windows runs it inside Ubuntu 24.04 on WSL 2 from PowerShell:

```powershell
irm https://qos.systems/install-windows.ps1 | iex
```

Pass setup options after `sh -s --`, for example:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh \
  | sh -s -- --devnet
```

The browser script downloads the latest `Quantized-OS/qOS` GitHub Release and
verifies the deterministic archive SHA-256 before invoking `setup.sh`. The
repository generates the site files with `make web-release` and release assets
with `make github-release`; it does not deploy the domain. See
`BROWSER_INSTALL.md`.

## Mainnet is the default

Start the guided mainnet setup with:

```sh
./setup.sh install
```

In an interactive terminal, qOS first asks how the source-wallet key should be
held. Choose an existing key through a reviewed external signer (recommended),
or ask qOS to generate an accessible software key. The second choice sets the
same internal mode as `--insecure` and cannot create the key until the complete
risk notice is accepted.

For existing-key custody, the wizard explains the external signer in plain
terms, shows the standard profile and command paths, validates the adapter
executable, displays a final summary, and asks for three public or operational
values:

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

If you do not have a reviewed adapter, type `guide` at the custody chooser. The
wizard prints the exact next steps and stops before it installs dependencies or
creates files. Show the guide at any time with:

```sh
./setup.sh install --signer-guide
```

The operator steps and adapter developer contract are in
[`SIGNER_ADAPTER_SETUP.md`](SIGNER_ADAPTER_SETUP.md). qOS does not bundle or
silently generate a production signer adapter.

## Mainnet workaround with a generated software key

If no external signer is available and you accept a key that local programs can
read, choose option 2 in the default wizard or run:

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
policy, requests and confirms 0.2 Devnet SOL from the faucet, builds the locked
RISC-V QEMU firmware, copies Cargo's output into a private single-link ELF,
records its measurement, installs commands, and opens qOS. It never spends the
funds or broadcasts a transfer automatically. Use `--no-fund` to check the
cluster without an airdrop or `--offline` to defer both steps.

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
| `wallet` | `wal` |
| `policy` | `pol` |
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

Output is readable text by default. Use `qos --json capa` for automation; the
low-level `qos-core` interface remains JSON-oriented.

Verify that the source wallet exists on the pinned cluster and has the exact
fee/token requirements needed by the enabled template:

```text
qos> wal status
```

Mainnet cannot be faucet-funded. The report prints the signer address, SOL fee
reserve, pinned mint, derived Token-2022 source account, and blockers. See
`WALLET_AND_POLICY.md`.

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

After an agent is onboarded, qOS starts the authenticated combined REST and MCP
service automatically. Check it with:

```text
qos> ag st
```

The default MCP endpoint is `http://127.0.0.1:8790/mcp`. `api 8787` or
`serve mcp 8787` manually starts the same managed service on another port when
it is stopped. Each generated agent Bearer token remains in that agent's
owner-only token file. Do not put it in prompts, logs, shell history, or remote
model configuration. The service accepts loopback clients only.

The low-level sandbox CLI remains available as `qos-core`; automation should
normally prefer the restricted `qos` command surface.

Onboard a scoped agent with the shell wizard:

```text
qos> ag on
```

or with flags:

```sh
qos agent onboard --id bot --approval ask --asset qos-token \
  --max-amount 1000000 --destination YOUR_ALLOWLISTED_DESTINATION \
  --strategy-id 1
```

The service starts during onboarding. Ask-mode requests are memory-only until
the operator runs `ag ok REQUEST_ID` or `ag no REQUEST_ID`. Automatic mode
requires an onboarding acknowledgement, and mainnet execution additionally
requires `ag re --confirm-live`. Revoke an agent with `ag off AGENT_ID`.
See `AGENT_ONBOARDING.md` for the MCP tools, REST compatibility shape,
generated skill pack, isolation requirements, and offboarding semantics.

Configure a local or commercial BYOK proposal model independently of the
managed-agent credential:

```text
qos> model catalog
qos> model configure claude-prod --provider anthropic --model MODEL_ID --api-key-file /run/secrets/anthropic-key
qos> ag demo dry 1000000 -a model -p claude-prod
```

`model list`, `model show ID`, `model rotate ID --api-key-file PATH`, and
`model remove ID --yes` never print the key. See `MODEL_PROVIDERS.md` for the
provider matrix and custom-endpoint trust boundary.

Edit reviewed policy fields inline:

```text
qos> pol show
qos> pol edit
qos> pol set max-token-amount 1000000
qos> pol destination add PUBLIC_KEY
```

Template identity, genesis, program IDs, mint, decimals, and extension rules
remain locked. Restart the agent listener after a change. External-signer
profiles must update the protected signer-side policy commitment too.

## Uninstall

Permanently remove all qOS-managed installation artifacts with:

```sh
./setup.sh uninstall
```

The interactive command requires typing `DELETE`. It stops managed services and
removes registered profiles, policies, API tokens, private keys, agent tokens
and skills, downloaded browser releases, user-local qOS toolchains, logs,
firmware/build output, and marked launchers. This cannot be undone. Unmanaged
launchers, shared Ubuntu packages, and an unmanaged Git source checkout are
preserved. Symlinks are unlinked rather than followed.

Use `--bin PATH` if commands were installed outside `~/.local/bin`:

```sh
./setup.sh uninstall --bin /absolute/custom/bin
```

For confirmed unattended removal, add `--yes`.

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
- `-v`, `--verbose` shows every security-suite check instead of the one-line
  pass summary.
- `--offline` defers RPC genesis and source-wallet readiness checks.
- `--no-fund` verifies Devnet without requesting its default airdrop.
- `--airdrop-lamports N` changes the confirmed Devnet faucet request.
- `--agent-id` plus the `--agent-*` options onboards the first scoped agent.
- `--accept-auto` acknowledges unattended automatic agent execution.
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
