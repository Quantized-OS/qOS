# qOS v0.7.2 production security review

Date: 2026-08-15

## Release decision

**BLOCKED for production custody and unrestricted mainnet funds.**

This revision is a hardened research candidate. It materially reduces the
attack surface exposed to an automated agent, but the repository does not
contain the target-specific hardware root of trust or a production
non-exportable signer implementation. The source must not be represented as a
production firmware release until every acceptance criterion below is met.

The review used the supplied `qOS-main` source archive as the source of truth.
It covered the RV64 stage-0 starter, the Rust QEMU policy signer, the Node.js
policy/signer/RPC/API paths, fixtures, release builder, tests, and operator
documentation. No production keys, accounts, or network transactions were
used.

Input archive SHA-256:
`ee97c2850892b4f94ea72bede7e9a7bb68226c303d30d85a86b6d94b40f57efd`.

## Security changes made

### Key and configuration files

- Centralized security-sensitive reads in `src/secure-file.js`.
- Reject symlinks, non-regular files, multiple hard links, unsafe ownership or
  permissions, and files outside explicit size bounds.
- Bind inspection and reads to one inode with `O_NOFOLLOW`, cap the read before
  allocation, and reject a file that changes or grows during the read.
- Require a private, owner-controlled qOS home.
- Wipe mutable key, passphrase, token, subprocess, and mailbox buffers on the
  paths where Node.js exposes those buffers.

### Agent and signer boundary

- Mainnet submission now rejects plaintext and encrypted software signers. It
  requires a signer reporting a non-exportable external custody boundary.
- Renamed the external operation to `authorize-and-sign-qos-intent` and require
  an exact authorization envelope with recomputed intent commitment.
- Validate external executable type and permissions; launch without a shell,
  from `/`, with a minimal environment, bounded output, and a deadline.
- Require test fixtures to receive an explicit `--test-only` flag.
- Keep the production requirement explicit: the external signer must
  independently reconstruct the message and pin the policy commitment.

### API, model, RPC, and input handling

- Mainnet HTTP mode requires a secure `QOS_API_TOKEN_FILE`; duplicate
  authorization headers and non-loopback clients are rejected.
- Added header, connection, request-target, content-length, body, UTF-8, and
  token format limits.
- RPC and local-model requests disable redirects, require JSON content types,
  use literal loopback rules where applicable, and enforce bounded responses.
- Slots must be non-negative safe integers. RPC URLs and local-model URLs reject
  credentials, fragments, and ambiguous `localhost` DNS resolution.
- CLI JSON, policy, descriptor, provisioning, and key inputs are size-bounded
  and strict UTF-8 where they are textual.

### Solana token policy

- The mainnet policy is pinned to the Token-2022 program, six decimals, and
  exactly mint extensions 18 and 19.
- Mint authority and freeze authority must be absent.
- Source and destination token accounts must have no delegate, delegated
  amount, native state, or close authority. Token-2022 accounts must expose
  exactly the ImmutableOwner account extension.
- Mainnet broadcast still requires the explicit environment opt-in in addition
  to the external signer boundary.

### Firmware and QEMU paths

- Stage-0 now requires the platform to quiesce DMA and make the manifest and
  image immutable before either is read.
- Snapshot the manifest once, make rollback reads fallible, measure the signed
  manifest fields, and require authenticated/measured/locked FDT handling.
- Wipe the manifest and digest before verified handoff.
- Sanitize Cargo and QEMU launch environments and reject symlinked build
  artifacts.
- QEMU mainnet broadcast is forbidden because its runtime software seed is
  readable by the host. Offline rehearsal and live simulation remain.

### Release engineering

- Removed remote bootstrap execution from the setup script.
- Fixed the release builder's readiness-report path.
- Added release-tree rejection for private-key markers and runtime secret
  filenames.
- Retained the deliberate unresolved-link failure for stage-0 until a real SoC
  implements every `platform_*` hook.

## Residual production blockers

1. **No hardware port.** ROM-rooted key lookup, ML-DSA-65, SHA3-384,
   DMA/IOMMU quiescence, immutable boot source, rollback-safe storage,
   measurement registers, authenticated FDT source, root-secret locking, PMP,
   debug policy, secondary-hart handling, and fail-closed reset behavior are
   interfaces only.
2. **No production signer.** The repository contains no reviewed HSM, enclave,
   MPC, KMS, TPM, or hardware-firmware adapter. A child process with a generic
   byte-signing API is not an authorization boundary. The host-provided
   `privacyProofVerified` Boolean is not an attestation and must be reverified or
   authenticated below the application boundary.
3. **No persistent risk state.** Nonce replay state and request-rate state are
   process-local. There is no rollback-safe exposure counter, position limit,
   two-person approval, recovery authority, or key-rotation workflow.
4. **RPC is an untrusted oracle.** Genesis is pinned and replies are validated,
   but slot, blockhash, fee, account state, simulation, and confirmation still
   come from the configured provider. There is no trusted clock or independent
   multi-provider quorum.
5. **No DEX template.** The implemented templates are transfers, not trades.
   They do not enforce market-specific account derivation, slippage, notional,
   inventory, or venue exposure.
6. **Runtime limits.** JavaScript strings, base64 strings, `KeyObject` internals,
   and garbage-collected values cannot be reliably zeroized.
7. **QEMU is not isolation.** Its host can inspect guest memory and the runtime
   seed. The runner's mainnet ban prevents accidental use but does not create a
   hardware boundary.
8. **Build assurance is incomplete.** The checked-in lockfile pins Rust crates,
   but this workspace lacked Cargo, rustc, QEMU, a RISC-V cross-compiler, and a
   complete offline advisory scanner. No firmware ELF or target image was built
   here.
9. **Independent review is absent.** Cryptography, serialization, firmware,
   fault injection, side channels, hardware integration, incident recovery,
   and operations require independent assessment.

## Verification evidence

| Check | Result |
| --- | --- |
| `make check` | Pass: 96 Node.js tests plus static invariants |
| Node.js syntax checks | Pass for all seven CLI entry points |
| Host C syntax | Pass with GCC C11, `-Wall -Wextra -Werror`, freestanding headers |
| Python syntax | Pass for release and static-check scripts |
| Shell syntax | Pass for setup and demo wrappers |
| Release secret scan | Pass for the source release tree |
| Deterministic release build | Pass when two independently generated source archives and ISOs match |
| Rust/QEMU execution | Not run: required tools are absent in this workspace |
| Clone-to-shell installer | Syntax/static/help tests pass; networked clean-host install not run in this workspace |

`package.json` declares no runtime or development npm dependencies. The Rust
demo is locked to `ed25519-dalek` 3.0.0, `curve25519-dalek` 5.0.0, and their
transitive lockfile versions. A focused check confirmed those versions are
newer than the fixes named by RUSTSEC-2022-0093 and RUSTSEC-2024-0344; this is
not a substitute for a complete advisory scan in the production build pipeline.

## Production acceptance criteria

Production approval requires all of the following, with evidence retained
outside the transaction data path:

- Implement, review, and negative-test every platform hook on the exact target
  silicon and immutable boot/update chain.
- Use a non-exportable signer that reconstructs the exact typed transaction
  below the application boundary and persists rollback-safe policy/risk state.
- Define a signed, canonical update manifest and prove atomic A/B update,
  rollback, recovery, and key-rotation behavior under power loss.
- Add target-specific tests for DMA, debug unlock, secondary harts, malformed
  FDT/manifests, memory aliasing, TOCTOU, voltage/clock faults, and side channels.
- Pin and reproduce the complete compiler, crate, system package, and firmware
  build inputs; run offline SBOM, license, and vulnerability gates.
- Add independently reviewed DEX templates before describing the system as a
  trading signer.
- Complete external cryptographic, firmware, Solana, hardware, and operational
  audits and close all critical/high findings.
- Conduct a capped canary deployment with tested monitoring, incident response,
  revocation, recovery, and treasury separation before any broader mainnet use.
