# qOS v0.9.1 release-readiness report

## Release decision

**Status: hardened research/demo source only. Production custody is blocked.**

The repository contains a host-side Solana policy signer, a QEMU bare-metal
demonstration, and an intentionally unlinked stage-0 firmware starter. It does
not contain a production SoC port, working hardware secure-boot hooks, a
non-exportable production signer, or a bootable operating-system image.

The generated ISO is ISO-9660 research data media containing the source archive,
readiness report, source checksum, and readme. It is not bootable firmware or
an installer.

## v0.9.1 production-preparation changes

- Added source-wallet onboarding: setup pins and verifies RPC genesis, reports
  exact mainnet SOL/Token-2022 funding blockers, and requests a confirmed
  Devnet airdrop unless the operator selects `--no-fund` or `--offline`.
- Added per-agent onboarding, hashed revocable credentials, generated MCP skill
  packs, narrow scopes, ask/auto modes, one auto-started authenticated loopback
  REST/MCP service, memory-only approvals, rate limits, and offboarding that
  invalidates pending requests.
- Added a strict inline policy editor with private atomic replacement. Only
  reviewed limits, allowlists, commitment, and RPC URL can change; transaction
  identity fields remain locked.
- Added readable operator output with explicit `--json` machine mode.
- The POSIX `qos.systems` bootstrap now downloads the latest verified source
  assets from `Quantized-OS/qOS` on GitHub. The site bundle adds an install-first
  landing page plus macOS/Lima and Windows/WSL 2 wrappers; all paths enter a
  supported Ubuntu 24.04 environment and converge on that same bootstrap. The
  site contains no source payload; deterministic GitHub assets and
  tag-triggered publication are built separately.

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
- Guided Ubuntu beta onboarding added through `setup.sh install`: external
  mainnet custody is the default and disposable Devnet mode requires
  `--devnet`. The flow uses verified official toolchain artifacts, private
  runtime/API-token provisioning, measured Devnet QEMU firmware, atomic
  user-local launchers, and a bannered restricted interactive/non-interactive
  `qos` shell with shorthand commands.
- Confirmed `setup.sh uninstall` stops managed services and removes registered
  profiles, keys, policies, API/agent credentials, downloaded releases,
  toolchains, logs, marked launchers, and build artifacts without following
  symlinks. Shared packages and an unmanaged Git checkout remain.
- Uninstall now repairs legacy `0755` modes only after proving each qOS data,
  profile, and agent path is a real directory owned by the current user. It
  continues to reject symlinks and non-owned purge targets.
- Interactive mainnet setup now provides a complete signer-adapter wizard,
  validates a new profile's executable boundary before system changes, and stops safely
  with a plain-language implementation/review guide when no adapter is ready.
- The default Linux, macOS, and Windows setup flow now asks whether the operator
  has an existing externally held key or wants qOS to generate one. The latter
  selection enters the exact `--insecure` notice and acknowledgement path.
- `setup.sh install --insecure` now provides the requested accessible software
  key workaround. It requires an explicit notice acknowledgement before key
  creation and then exposes the same implemented mainnet qOS capabilities.
- Upgraded source trees safely retire a recognized old `install.sh` into a
  private release-excluded backup before static checks; unrelated files are
  preserved and block setup with an actionable error.

The complete source-grounded assessment is in
`PRODUCTION_SECURITY_REVIEW.md`.

## Verification in this workspace

- `make check`: pass; the complete Node.js and static safety suite passes.
- Node.js syntax checks: pass.
- Host C syntax with GCC C11, `-Wall -Wextra -Werror`: pass.
- Python and shell syntax checks: pass.
- Release secret scan: pass.
- Two release builds produce matching source archive and ISO digests.
- No firmware ELF was built or run because Cargo, rustc, QEMU, and the RISC-V
  cross-toolchain are not installed in this workspace.
- The networked pinned-toolchain bootstrap was syntax- and invariant-checked
  but not downloaded or executed in this workspace; clean-host CI remains a
  release requirement.

## Blocking production work

- Implement and independently review every `platform_*` hook on the selected
  SoC, including immutable boot/update inputs, DMA quiescence, rollback storage,
  measurement, authenticated FDT, PMP, debug, secrets, and failure behavior.
- Replace all software/QEMU seed handling with a non-exportable signer that
  independently reconstructs messages and persists rollback-safe risk state.
- Add exposure accounting, two-person approval, recovery, rotation, incident
  response, monitoring, and deliberately capped hot-wallet operations.
- Isolate each untrusted agent under a distinct OS/VM identity and independently
  review credential distribution, approval UX, and incident handling.
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
