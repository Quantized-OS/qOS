# Security policy and deployment warning

qOS is a research firmware and policy-signer project. Version 0.7.1 adds strong
defensive primitives, but it is not independently audited or certified and
must not be described as production custody firmware without platform-specific
integration, review, and validation.

## Preferred deployment profile

1. Verified and measured boot with rollback-safe hardware state.
2. External non-exportable Ed25519 signer whose adapter independently enforces
   the typed policy and pins the policy commitment.
3. Minimal immutable OS, IOMMU/PMP, no swap or core dumps, mandatory access
   control, and an outbound network allowlist.
4. Loopback qOS API behind a separately isolated TLS/authentication proxy.
5. Required SNARK gate only with a reviewed circuit, ceremony/proving setup,
   verifier library, and pinned verifying-key digest.
6. Deliberately capped hot balance, separate treasury custody, operator
   approvals, monitoring without signing authority, and tested recovery.

## Threat model

The external-signer profile is intended to prevent an AI agent or compromised
application process from reading or exporting the private key. It does not
make a signing capability harmless. The signer-side policy boundary must reject
arbitrary messages and independently validate every typed authorization.

The encrypted software profile protects offline key bytes against file theft
without the passphrase. It does not protect the decrypted key from a compromised
qOS process, kernel, hypervisor, debugger, DMA-capable device, or physical
attacker.

The SNARK adapter proves only what its exact circuit constrains. An incomplete
circuit, compromised setup, substituted verifying key, unsound library, or
malicious external verifier invalidates the authorization guarantee.

## Known non-goals and unfinished work

- No production SoC implementation of the platform hooks in `firmware/`.
- No rollback-safe persistent host nonce counter; same-process replay uses
  keyed commitments and firmware-demo replay state lasts one boot.
- No protection from traffic analysis or from Solana's public ledger.
- No reliable zeroization guarantee for JavaScript strings or native runtime
  internals.
- No bundled production SNARK circuit, proving key, ceremony, or verifier.
- QEMU is a functional demonstration, not a hardware isolation boundary.

## Reporting vulnerabilities

Do not include private keys, passphrases, seed phrases, production proofs, or
real transaction secrets in a report. Provide the smallest reproducible test,
affected version, expected fail-closed behavior, and observed behavior through
the project's private maintainer channel before public disclosure.
