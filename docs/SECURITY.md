# Security policy and deployment warning

qOS is a research firmware and policy-signer project. Version 0.11.1 adds strong
defensive primitives, but it is not independently audited or certified and
must not be described as production custody firmware without platform-specific
integration, review, and validation.

The macOS and Windows installers are convenience host wrappers, not native
firmware ports. macOS runs qOS inside Lima Ubuntu 24.04 with host-directory
mounts disabled; Windows runs it inside Ubuntu 24.04 on WSL 2. Homebrew, Lima,
WSL, the Ubuntu images, and the host hypervisor remain additional trusted
components. Both wrappers ultimately use the same checksum-verifying Linux
release bootstrap.

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

Run `qos security-audit` to exercise this boundary with
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

The managed agent REST/MCP service uses separate random credentials, stores
only their SHA-256 verifiers in the registry, binds to loopback, validates MCP
protocol/method/tool headers and browser Origins, and rechecks the agent scope
and live qOS policy before every action. MCP and REST converge on one action
validator, approval queue, and executor. Ask-mode requests exist only in process
memory and disappear on rejection, expiry, shutdown, or offboarding. Auto mode
intentionally removes the per-action human decision, but mainnet execution
still requires an explicit `ag re --confirm-live` restart gate.

Commercial model BYOK credentials are a separate trust domain. Each imported
API key is copied into an owner-only, single-link regular file; only its SHA-256
verifier appears in the model registry. Built-in providers pin HTTPS endpoints.
Custom endpoints require explicit acknowledgement, reject plaintext HTTP and
URL-embedded credentials, and never receive signer keys or agent bearer tokens.
Provider error bodies are not surfaced. Redirects, compressed/non-JSON output,
oversized output, credential-file replacement, and registry mismatches fail
closed. The model still produces an untrusted proposal that passes through the
same amount, destination, action, and policy validation as a local model.

The qOS service account can read its stored provider keys. A compromised
same-account process can therefore spend the associated commercial API quota.
Use provider-side key restrictions, spend limits, isolated service accounts,
and secret-manager mounts for production. BYOK isolation does not replace the
external signer boundary and does not grant a model direct transaction access.

Unattended setup accepts `--model-api-key` for automation compatibility and
copies the value into the same owner-only mode-`0600` credential file without
printing it or placing it in child arguments or environments. The setup process's original
command line can still be visible in shell history, `/proc`, process monitors,
CI logs, or orchestration metadata. Prefer `--model-api-key-file` or
`--model-api-key-env`; treat any literal command-line key as potentially
exposed and rotate it if the host or automation system records arguments.

Mode-0600 files separate Unix accounts, not processes sharing one account. An
agent running as the qOS user can read other same-user credentials and any
`--insecure` signer key. Use a separate account, container, VM, or equivalent
sandbox for each untrusted agent and a non-exportable external signer. The
generated skill pack is an interface contract, not a process sandbox.

Inline policy writes are allowlisted, fully validated, private, and atomic.
They do not update a protected external signer automatically. The operator must
restart the listener and review/pin the new signer-side policy commitment.

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
- Agent approvals are single-operator, memory-only decisions; there is no
  durable multi-party queue, reconciliation service, or scheduler.
- RPC remains an untrusted source of slots, blockhashes, account state, fees,
  simulation, and confirmation. Policy validation and shape checks reduce but
  do not eliminate that trust.
- No protection from traffic analysis or from Solana's public ledger.
- No reliable zeroization guarantee for JavaScript strings or native runtime
  internals.
- No bundled production SNARK circuit, proving key, ceremony, or verifier.
- QEMU is a functional demonstration, not a hardware isolation boundary, and
  the runner refuses mainnet broadcast.
- The listener implements policy-gated transfers only. It is not a general
  autonomous DEX trading engine.

See `reports/PRODUCTION_SECURITY_REVIEW.md` for the production release decision,
verification evidence, and acceptance criteria.

## Reporting vulnerabilities

Do not include private keys, passphrases, seed phrases, production proofs, or
real transaction secrets in a report. Provide the smallest reproducible test,
affected version, expected fail-closed behavior, and observed behavior through
the project's private maintainer channel before public disclosure.
