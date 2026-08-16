# QEMU firmware transaction demo

This demo shows an actual bare-metal RV64 firmware image constructing and
signing either the native SOL transfer used on Devnet or the pinned qOS
Token-2022 `TransferChecked` instruction on mainnet. The firmware runs in
machine mode on QEMU's `virt` board; there is no guest operating system.

## What the audience sees

One run produces all of these events:

1. Firmware boots in M-mode and prints its signer public key.
2. A valid typed intent is accepted and signed.
3. The same policy receives an over-limit amount and rejects it.
4. A previously accepted nonce is replayed and rejected.
5. The host verifies the firmware signature against the exact System Program
   or Token-2022 transfer expected from the typed intent.
6. In live mode, the host simulates the transaction and, with `--broadcast`,
   waits for the configured commitment on the pinned cluster and prints the
   Explorer link.

The visible rejection cases are part of the run. They are not prerecorded
output and the host treats their absence as a failed demo.

## Install prerequisites

On Ubuntu or Debian, install QEMU's miscellaneous system targets:

```sh
sudo apt-get update
sudo apt-get install qemu-system-misc build-essential
```

Install a pinned Rust/rustup release from a verified package source if it is not
already installed. qOS intentionally does not download and execute a remote
bootstrap script. Then add the bare-metal RISC-V target:

```sh
rustup target add riscv64imac-unknown-none-elf
```

Verify the commands:

```sh
qemu-system-riscv64 --version
cargo --version
rustup target list --installed | grep riscv64imac-unknown-none-elf
```

No RISC-V GCC toolchain is required. Cargo uses the committed `Cargo.lock` and
retrieves its locked dependencies during the first build. Production build
infrastructure must additionally pin and verify the Rust toolchain and
dependency source artifacts. The demo uses an isolated build-local Cargo home
so user-level Cargo configuration, wrappers, and credentials are not inherited.

Run `node bin/qos-firmware-demo.js --help` for the complete command-line
surface. The repository wrapper also supports a build-only path that does not
require QEMU when prerequisites are already installed:

```sh
bash run-demo.sh --build-only --skip-setup
```

## Provision the demo firmware

Use the initialized `.qos-ephemeral-devnet` signer and its pinned destination. It does
not need funds for the offline rehearsal:

```sh
node bin/qos-firmware-demo.js build
```

This is a policy provisioning step. It reads the signer only to record its
public identity, compiles policy constants into the M-mode ELF, restricts the
build-tree permissions, and writes a non-secret provisioning record. The
Ed25519 seed is not passed to Cargo and is not embedded in the ELF.

Cargo may hard-link its final output to an internal dependency artifact. qOS
therefore reads that output with inode, ownership, permission, stability, and
size checks, atomically installs a separate owner-only ELF under
`build/firmware-demo`, and requires that installed ELF to have exactly one hard
link before it is measured or run.

The build requires exactly one allowlisted destination. If `QOS_HOME` or
`SOLANA_RPC_URL` was used for the host sandbox, export the same values here.

## Rehearse without broadcasting

```sh
node bin/qos-firmware-demo.js run --offline --lamports 1000000
```

Expected firmware portion:

```text
QOS_FW:BOOT mode=M policy=typed-sol-or-token-transfer retention=ephemeral-memory
QOS_FW:SIGNER_HEX ...
QOS_FW:ACCEPT index=0 signature_hex=<redacted-in-memory>
QOS_FW:REJECT index=1 code=AMOUNT
QOS_FW:REJECT index=2 code=NONCE_REPLAY
QOS_FW:DONE
```

The final JSON reports `"status": "verified-offline"`,
`"networkVerified": false`, and `"broadcast": false`. This path uses a
deterministic placeholder blockhash and slot, does not contact Solana, and does
not claim that the transaction can land. It proves the actual QEMU firmware
booted, enforced its policy, produced a valid Ed25519 signature, constructed
the exact allowlisted instruction, and rejected the two negative cases. The
run command reads signer.pem, verifies its public key against the provisioning
record, copies its seed into an unlinked RAM-backed key mailbox, and wipes the
host and guest mailbox buffers after firmware imports it.

## Verify against live Devnet without broadcasting

Fund the signer, then run without either mode flag:

```sh
node bin/qos.js balance
node bin/qos-firmware-demo.js run --lamports 1000000
```

This fetches a live blockhash and slot, calculates the fee, checks that the
signer has enough SOL, and simulates the firmware-signed transaction. The
result reports `"status": "verified"` and `"networkVerified": true`. A missing
balance fails with `INSUFFICIENT_SOL_BALANCE` and the exact required and
available lamports.

## Broadcast the firmware-signed transaction

Check that the firmware signer still has Devnet SOL:

```sh
node bin/qos.js balance
```

Then run the live demonstration:

```sh
node bin/qos-firmware-demo.js run --lamports 1000000 --broadcast
```

The host will refuse to relay if the RPC genesis, ELF measurement, signer,
destination, amount, blockhash, fee, signature, instruction template, or
simulation differs from the provisioned policy. A successful result includes
`"status": "confirmed"` and a Devnet Explorer URL.

## Rehearse the qOS token path

Create a separate disposable software-key demo home. Do not reuse the external
mainnet custody home described in [`SANDBOX.md`](SANDBOX.md):

```sh
node bin/qos.js init --home .qos-qemu-mainnet-demo --cluster mainnet-beta \
  --destination YOUR_DEMO_DESTINATION
node bin/qos-firmware-demo.js build --home .qos-qemu-mainnet-demo
node bin/qos-firmware-demo.js run --home .qos-qemu-mainnet-demo \
  --asset token --amount 1000000 --offline
```

The offline token rehearsal verifies the firmware's pinned mint, Token-2022
program, six decimals, source associated
token account, destination associated token account, destination owner, amount
ceiling, fee ceiling, strategy, cluster, slot window, and nonce. The host also
re-reads the three onchain accounts and rejects a changed mint extension set,
owner, mint, state, or insufficient source balance before QEMU runs in live
mode. Offline mode deliberately skips onchain account and balance checks and
reports `networkVerified: false`.

The QEMU runner refuses mainnet broadcast. Its runtime Ed25519 seed is readable
by the host, so an environment opt-in cannot turn it into a custody boundary.
Use this path only with a disposable, capped demo signer for offline rehearsal
or live simulation.

## Presenter script

Explain the boundary in four sentences while the command runs:

1. “The host can submit only this fixed typed intent; there is no sign-bytes API.”
2. “The machine-mode firmware pins the destination and limits before it builds the Solana message itself.”
3. “The second and third requests prove amount tampering and nonce replay fail closed.”
4. “The host receives only the signed public transaction, independently verifies it, and cannot alter it before broadcast.”

## Security limitations

This is an engineering demonstration, not a custody product. Mainnet broadcast
is disabled. QEMU's host can
inspect guest memory and signer.pem exists on the host. The ELF contains no
seed, but the host loads the seed into an unlinked tmpfs file descriptor at
runtime. Linux tmpfs is RAM-backed but may use swap; disable swap and core
dumps on a sensitive demo host. QOS_RAM_DIR may select another directory, but
the runner rejects it unless Linux reports the tmpfs filesystem type.

The nonce is monotonic only during one firmware boot and the current slot comes
from the untrusted host. Network blockhash expiry and the verifying relay limit
those weaknesses but do not replace trusted time and rollback-safe storage.
The ML-DSA secure-boot hooks in firmware/secure_boot.c remain unimplemented
platform boundaries. Use a new, deliberately capped demo signer, never a
treasury or production wallet.

The QEMU runner creates no transaction mailbox file in the repository and does
not send the raw transaction over the displayed UART. The complete transaction
still exists briefly in host memory for independent verification, simulation,
and optional broadcast. After broadcast it is public Solana ledger data and
cannot be made private or forgotten.
