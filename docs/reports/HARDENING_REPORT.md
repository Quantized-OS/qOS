# qOS v0.7.1 hardening report

Date: 2026-08-15

## Outcome

This revision adds an agent-oriented key-custody boundary, authenticated
encrypted software keys, a fail-closed SNARK authorization adapter, tighter
privacy controls, and regression coverage for the defects found during review.
It also bounds and canonicalizes transaction parsing, removes provider error
reflection, pins the QEMU demo signer inside the firmware image, and keeps raw
signed transactions off the demo UART display channel.

## Implemented security changes

- External Ed25519 signer protocol with a pinned public identity, absolute-path
  execution, no shell, minimal environment, bounded input/output, deadline,
  exact response schema, and local signature verification.
- External-signer initialization that creates no private signer or receiver key
  files. Ambiguous homes containing multiple signer backends fail closed.
- AES-256-GCM PKCS#8 encryption with authenticated metadata and public identity;
  scrypt N=262144, r=8, p=1; 256-bit salt; 96-bit IV; 128-bit tag; mode-0600
  passphrase file; and mutable-buffer clearing where Node.js permits it.
- Optional or mandatory Groth16-BN254 / PLONK-BN254 verifier adapter. qOS binds
  the request and reply to the canonical intent and policy commitments, signer,
  expiry, circuit, proof system, and verifying-key SHA-256.
- Unpredictable 128-bit nonces and keyed SHA-256 replay commitments retained
  only for the process lifetime. Concurrent and completed reuse now fail.
- Strict loopback-only plaintext HTTP service with mandatory API token, minimal
  public liveness response, authenticated detailed health, stronger defensive headers, fatal UTF-8
  decoding, body/encoding limits, and connection bounds.
- Bounded RPC response parsing with strict UTF-8/JSON and reduced upstream error
  disclosure.
- Canonical compact-length parsing, bounded Solana message readers, and strict
  unsigned-64-bit transaction field serialization.
- Symlink rejection for private-key and passphrase paths.
- Provisioned signer identity compiled into the QEMU demo firmware; mismatched
  runtime seeds fail closed.
- Firmware demo UART output limited to a redacted public signature; the host
  reconstructs and verifies the exact expected message.
- Compiler-resistant volatile zeroization of the stage-0 boot digest.

## Defects fixed

1. A completed request nonce could be reused in the host service.
2. Canonical JSON could silently drop a literal `__proto__` key by mutating the
   temporary object's prototype.
3. Detailed signer, cluster, and balance data was returned by unauthenticated
   health checks.
4. The built-in HTTP server allowed remote plaintext bearer-token transport.
5. RPC response bodies had no upper bound.
6. RPC error objects and simulation logs could disclose more upstream data than
   required.
7. The qOS service retained a directly accessible private-key property and had
   no non-exportable signer backend.
8. Software keys had no authenticated encryption-at-rest option.
9. Requiring a privacy proof had no fail-closed verifier integration.
10. External signer homes could otherwise be initialized with a self-transfer
    destination or ambiguous custody files.
11. The C compiler was not explicitly prevented from optimizing away the
    stage-0 digest wipe.
12. Firmware demo failure details could disclose the raw signed transaction
    even though the displayed QEMU transcript was redacted.
13. Firmware provisioning did not re-bind the sole strategy ID after policy
    changes.
14. Valid plaintext RPC endpoints on IPv6 loopback were rejected.
15. First-run sandbox initialization failed when `--home` used missing parent
    directories.
16. The wrapper required QEMU for `--build-only`, even though QEMU is needed
    only when running the firmware.
17. The source archive included an ignored, incomplete `.qos-demo` runtime
    directory that could be mistaken for an initialized runnable sandbox.
18. Signature buffers could remain live if transaction assembly failed after the
    signer returned a response.
19. Solana compact lengths were not required to use their canonical encoding and
    parser inputs were not bounded before copying.
20. RPC provider error messages and preflight simulation payloads could be
    reflected through qOS errors.
21. Private-key loaders followed symlinks, weakening the intended key-path
    boundary.
22. The QEMU demo did not pin its provisioned signer identity inside the ELF.
23. The QEMU demo printed the raw signed transaction on its UART data/display
    channel before the host redacted it.

## Verification performed

- `make check` passes.
- 63 Node.js tests pass, including encryption/decryption failure, external
  signer isolation, SNARK request binding, replay rejection, canonicalization,
  RPC size limits, HTTP bind restrictions, provisioning-policy binding,
  failure-output redaction, IPv6 loopback handling, nested sandbox
  initialization, firmware CLI help, canonical compact-length rejection,
  exceptional signature cleanup, provider-error redaction, and symlink
  rejection.
- Host C syntax checks pass with GCC, `-Wall -Wextra -Werror`.
- Python firmware/static fail-closed invariants pass.
- JavaScript syntax checks pass.
- Archive diff whitespace checks pass.
- Secret-pattern scan found no embedded private key or passphrase material.

The RISC-V C cross-compiler, Rust toolchain, and QEMU are not installed in the
verification environment, so no new firmware binary was produced. The existing
repository deliberately leaves production platform hooks unresolved. The
research ISO generated by `scripts/build-release.py` is data media, not a
production boot image.

## Remaining limitations

This review cannot establish that every defect is fixed. qOS remains research
software without an independent audit or production SoC port. In particular,
the host sandbox has no rollback-safe persistent nonce counter, JavaScript and
native runtime internals cannot guarantee complete zeroization, QEMU is not a
hardware boundary, and the package does not bundle a production SNARK circuit,
ceremony, proving key, or verifier. See `SECURITY.md` for the deployment threat
model and required controls.
