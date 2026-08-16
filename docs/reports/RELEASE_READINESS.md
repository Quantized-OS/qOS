# qOS v0.7.2 release-readiness report

## Release decision

**Status: hardened research/demo source only. Production custody is blocked.**

The repository contains a host-side Solana policy signer, a QEMU bare-metal
demonstration, and an intentionally unlinked stage-0 firmware starter. It does
not contain a production SoC port, working hardware secure-boot hooks, a
non-exportable production signer, or a bootable operating-system image.

The generated ISO is ISO-9660 research data media containing the source archive,
readiness report, source checksum, and readme. It is not bootable firmware or
an installer.

## v0.7.2 production-preparation changes

- Secure inode-bound and size-bounded reads for keys, passphrases, policy,
  signer descriptors, API tokens, provisioning records, and CLI JSON.
- Mandatory external non-exportable signer for mainnet submission.
- Mandatory secure API-token file for mainnet HTTP service mode.
- Strict RPC/model content type, redirect, URL, slot, UTF-8, response-size, and
  error-disclosure handling.
- Exact Token-2022 mint/account extension and authority/delegate checks.
- Sanitized external signer, verifier, Cargo, and QEMU subprocess boundaries.
- Pre-read boot-source/DMA locking interface, one-time manifest snapshot,
  fallible rollback read, manifest measurement, and authenticated FDT interface.
- Mainnet broadcast disabled in the host-readable QEMU path.
- Remote bootstrap execution removed and release secret scanning strengthened.

The complete source-grounded assessment is in
`PRODUCTION_SECURITY_REVIEW.md`.

## Verification in this workspace

- `make check`: pass; 85 Node.js tests and static safety checks.
- Node.js syntax checks: pass.
- Host C syntax with GCC C11, `-Wall -Wextra -Werror`: pass.
- Python and shell syntax checks: pass.
- Release secret scan: pass.
- Two release builds produce matching source archive and ISO digests.
- No firmware ELF was built or run because Cargo, rustc, QEMU, and the RISC-V
  cross-toolchain are not installed in this workspace.

## Blocking production work

- Implement and independently review every `platform_*` hook on the selected
  SoC, including immutable boot/update inputs, DMA quiescence, rollback storage,
  measurement, authenticated FDT, PMP, debug, secrets, and failure behavior.
- Replace all software/QEMU seed handling with a non-exportable signer that
  independently reconstructs messages and persists rollback-safe risk state.
- Add exposure accounting, two-person approval, recovery, rotation, incident
  response, monitoring, and deliberately capped hot-wallet operations.
- Add separately reviewed venue-specific DEX templates; current code implements
  native SOL and pinned Token-2022 transfers only.
- Reproduce and test the signed target image with pinned offline toolchains and
  complete dependency/SBOM/advisory gates.
- Complete independent firmware, cryptographic, Solana, fault-injection,
  side-channel, hardware, and operational reviews.

## Safe release use

Use the source archive and research media for review, host tests, and disposable
QEMU rehearsal. Do not use production keys, treasury assets, or unrestricted
mainnet funds. Environment opt-ins are operational friction, not a substitute
for the missing hardware and custody boundaries.
