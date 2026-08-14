# QEMU firmware transaction demo

This demo shows an actual bare-metal RV64 firmware image constructing and
signing the same native SOL transfer that the host-side sandbox already
executes on Devnet. The firmware runs in machine mode on QEMU's `virt` board;
there is no guest operating system.

## What the audience sees

One run produces all of these events:

1. Firmware boots in M-mode and prints its signer public key.
2. A valid typed intent is accepted and signed.
3. The same policy receives an over-limit amount and rejects it.
4. A previously accepted nonce is replayed and rejected.
5. The host verifies the firmware signature and exact System Program transfer.
6. The host simulates the transaction and, with `--broadcast`, waits for a
   confirmed Devnet result and prints the Explorer link.

The visible rejection cases are part of the run. They are not prerecorded
output and the host treats their absence as a failed demo.

## Install prerequisites

On Ubuntu or Debian, install QEMU's miscellaneous system targets:

```sh
sudo apt-get update
sudo apt-get install qemu-system-misc curl build-essential
```

Install Rust with rustup if it is not already installed, then add the bare-metal
RISC-V target:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
rustup target add riscv64imac-unknown-none-elf
```

Verify the commands:

```sh
qemu-system-riscv64 --version
cargo --version
rustup target list --installed | grep riscv64imac-unknown-none-elf
```

No RISC-V GCC toolchain is required. Cargo retrieves the pinned
`ed25519-dalek` dependency during the first build.

## Provision the demo firmware

Use the already-funded `.qos-devnet` signer and its pinned destination:

```sh
node bin/qos-firmware-demo.js build
```

This is explicitly a provisioning step. It reads `signer.pem`, extracts the
standard 32-byte Ed25519 seed, compiles the seed and policy into the M-mode ELF,
restricts the build-tree permissions, and writes a non-secret provisioning
record containing the signer, policy, and firmware SHA-256 measurement.

The build requires exactly one allowlisted destination. If `QOS_HOME` or
`SOLANA_RPC_URL` was used for the host sandbox, export the same values here.

## Rehearse without broadcasting

```sh
node bin/qos-firmware-demo.js run --lamports 1000000
```

Expected firmware portion:

```text
QOS_FW:BOOT mode=M policy=typed-transfer key=sealed-demo
QOS_FW:SIGNER_HEX ...
QOS_FW:ACCEPT index=0 tx_hex=...
QOS_FW:REJECT index=1 code=AMOUNT
QOS_FW:REJECT index=2 code=NONCE_REPLAY
QOS_FW:DONE
```

The final JSON should report `"status": "verified"` and
`"broadcast": false`. The run command reads the public policy and provisioning
record but not `signer.pem`.

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

## Presenter script

Explain the boundary in four sentences while the command runs:

1. “The host can submit only this fixed typed intent; there is no sign-bytes API.”
2. “The machine-mode firmware pins the destination and limits before it builds the Solana message itself.”
3. “The second and third requests prove amount tampering and nonce replay fail closed.”
4. “The host receives only the signed public transaction, independently verifies it, and cannot alter it before broadcast.”

## Security limitations

This is an engineering demonstration, not a custody product. QEMU's host can
inspect guest memory, the provisioned ELF contains a disposable Devnet seed,
the nonce is monotonic only during one boot, and the current slot comes from the
untrusted host. Network blockhash expiry and the verifying relay limit those
last two weaknesses, but they do not replace trusted time and rollback-safe
storage. The ML-DSA secure-boot hooks in `firmware/secure_boot.c` remain
unimplemented platform boundaries. Never provision a mainnet key into this
image.

After the presentation, remove the secret-bearing build output with your normal
secure artifact-cleanup procedure. `make clean` intentionally does not remove
the firmware-demo target tree automatically because that deletion should be an
explicit operator action.
