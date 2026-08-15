# qOS v0.7.1 release-readiness report

## Release decision

**Status: research/demo release only. Not production custody firmware.**

The repository contains a hardened host-side Solana policy signer and a QEMU
bare-metal demonstration. It does not contain a production SoC port, a
working secure-boot platform implementation, an audited custody boundary, or
a bootable operating-system image. A production firmware ISO cannot honestly
be released from this source alone.

The accompanying ISO is therefore **research media**: it contains the
reproducible source archive, this readiness report, and checksums. It is a valid
ISO-9660 data image for download and offline inspection; it is not a bootable
production firmware installer.

## What was reviewed

- Host policy validation, canonical JSON, base58, Solana message construction,
  Ed25519 signing, RPC handling, HTTP service, session replay controls, token
  account parsing, external signer boundary, encrypted software-key fallback,
  and SNARK verifier binding.
- RV64 QEMU demo mailbox format, fixed transaction templates, provisioning
  record binding, key mailbox handling, and failure/replay transcript checks.
- Stage-0 C/assembly trust-root starter, linker constraints, and the explicit
  unresolved platform-hook boundary.
- Release packaging for accidental keys, ignored runtime state, and
  deterministic source/archive contents.

## Fixes included in v0.7.1

1. Signature and public-key copies are wiped even when transaction assembly or
   self-verification fails.
2. Solana message parsers reject oversized messages and non-canonical compact
   length encodings; u64 builders reject negative or overflowing values.
3. RPC provider error messages and simulation payloads are no longer reflected
   into qOS errors.
4. Private-key loaders reject symlinked key paths.
5. The QEMU demo pins the provisioned signer public key inside the firmware
   image and rejects a different runtime seed.
6. The QEMU UART transcript carries only the firmware signature. The raw
   signed transaction is reconstructed and checked by the host instead of
   being printed on the display channel.
7. Regression tests cover each of the above controls.

## Verification performed in this workspace

- `make check`: pass.
- `node --test test/*.test.js`: 63 tests pass.
- `python3 tests/static_checks.py`: pass.
- Node syntax checks for both CLI entry points: pass.
- Host C syntax check with GCC and `-Wall -Wextra -Werror`: pass.
- Archive scan: no embedded private key, passphrase, or initialized sandbox
  state found.

## Blocking production work

- Implement and independently review every `platform_*` hook in
  `firmware/include/platform.h` for the target SoC: ROM-rooted key lookup,
  SHA3-384, ML-DSA-65 verification, rollback-safe monotonic storage, measured
  boot, root-secret locking, PMP configuration, and fail-closed hardware
  behavior.
- Define the immutable boot/update manifest format and sign it with the actual
  production management key. Test power loss, rollback, fault injection,
  malformed manifests, DMA, debug unlock, and secondary-hart behavior.
- Replace the QEMU demo's runtime seed mailbox with a non-exportable HSM,
  enclave, or hardware-held Ed25519 key. The current demo host can inspect its
  seed and QEMU memory.
- Add a rollback-safe persistent nonce/counter mechanism below the untrusted
  host boundary.
- Supply a reviewed DEX instruction template, exposure accounting, operator
  approval/recovery path, monitoring, key rotation, incident response, and
  capped hot-wallet deployment policy.
- Commission independent firmware, cryptographic, Solana serialization,
  side-channel, and operational security reviews before mainnet funds are
  permitted.
- Build and test a target-specific signed image with the actual toolchain and
  hardware or a faithful hardware model. The current environment has no
  Cargo/Rust toolchain, QEMU, or RISC-V cross-compiler, so no firmware ELF was
  produced here.

## Safe release use

Use the ISO and source archive for code review, offline host tests, and the
QEMU rehearsal after installing its pinned toolchain prerequisites. Do not use
the included templates with treasury keys, production keys, or unrestricted
mainnet funds. Mainnet broadcast remains explicitly opt-in, but that guard is
not a substitute for the missing production trust boundary.
