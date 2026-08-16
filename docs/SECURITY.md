# Security policy and deployment warning

qOS is a research firmware and policy-signer project. Version 0.7.3 adds strong
defensive primitives, but it is not independently audited or certified and
must not be described as production custody firmware without platform-specific
integration, review, and validation.

## Preferred deployment profile

1. Verified and measured boot with rollback-safe hardware state.
2. External non-exportable Ed25519 signer whose adapter independently
   reconstructs the authorized message, enforces the typed policy, and pins the
   policy commitment. This is the preferred mainnet custody path.
3. Minimal immutable OS, IOMMU/PMP, no swap or core dumps, mandatory access
   control, a dedicated unprivileged qOS service account, and an outbound
   network allowlist.
4. Loopback qOS API with a mode-0600 `QOS_API_TOKEN_FILE`, behind a separately
   isolated TLS/authentication proxy. Mainnet service mode rejects an
   environment-only token.
5. Required SNARK gate only with a reviewed circuit, ceremony/proving setup,
   verifier library, and pinned verifying-key digest.
6. Deliberately capped hot balance, separate treasury custody, operator
   approvals, monitoring without signing authority, and tested recovery.

## Threat model

The external-signer profile is intended to prevent an AI agent or compromised
application process from reading or exporting the private key. It does not
make a signing capability harmless. The signer-side policy boundary must reject
arbitrary messages and independently validate every typed authorization.
The command adapter is launched with an absolute non-symlinked executable,
bounded I/O, no shell, a deadline, a minimal environment, and a fixed working
directory. Those launcher controls do not replace signer-side authorization.

Run `node bin/qos-agent-security-audit.js` to exercise this boundary with
synthetic disposable keys. The harness intentionally proves that plaintext
software keys and exposed passphrases are recoverable by a process with file
access; those profiles are not acceptable for an agent deployment.

The encrypted software profile protects offline key bytes against file theft
without the passphrase. It does not protect the decrypted key from a compromised
qOS process, kernel, hypervisor, debugger, DMA-capable device, or physical
attacker.

`setup.sh install --insecure` is an explicit compatibility workaround for an
operator who wants qOS to generate a live mainnet software key locally. It
requires a setup-time accessibility acknowledgement and enables the same
implemented mainnet operations as the external profile. It does not protect the
key from an AI agent, malware, backup process, or any other program with the
qOS user's file access. The notice is informed consent, not a security boundary.

The SNARK adapter proves only what its exact circuit constrains. An incomplete
circuit, compromised setup, substituted verifying key, unsound library, or
malicious external verifier invalidates the authorization guarantee.

## Known non-goals and unfinished work

- No production SoC implementation of the platform hooks in `firmware/`.
- No complete ROM-rooted boot/update implementation, authenticated FDT source,
  DMA/IOMMU quiescence implementation, or verified immutable boot source.
- No rollback-safe persistent host nonce counter; same-process replay uses
  keyed commitments and firmware-demo replay state lasts one boot.
- No production HSM/enclave/firmware signer adapter is bundled. The fixture
  adapter requires `--test-only` and is not deployable.
- No persistent exposure accounting, two-person approval, recovery, or key
  rotation implementation.
- RPC remains an untrusted source of slots, blockhashes, account state, fees,
  simulation, and confirmation. Policy validation and shape checks reduce but
  do not eliminate that trust.
- No protection from traffic analysis or from Solana's public ledger.
- No reliable zeroization guarantee for JavaScript strings or native runtime
  internals.
- No bundled production SNARK circuit, proving key, ceremony, or verifier.
- QEMU is a functional demonstration, not a hardware isolation boundary, and
  the runner refuses mainnet broadcast.

See `reports/PRODUCTION_SECURITY_REVIEW.md` for the production release decision,
verification evidence, and acceptance criteria.

## Reporting vulnerabilities

Do not include private keys, passphrases, seed phrases, production proofs, or
real transaction secrets in a report. Provide the smallest reproducible test,
affected version, expected fail-closed behavior, and observed behavior through
the project's private maintainer channel before public disclosure.
