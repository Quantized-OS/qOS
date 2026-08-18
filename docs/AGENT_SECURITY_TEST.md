# Synthetic agent security analysis

`qos security-audit` is a red-team harness for the agent boundary. It is
designed to answer two separate questions:

1. What happens if an agent can read qOS software-key material?
2. Can an untrusted agent proposal bypass the qOS typed-policy boundary?

The harness creates disposable synthetic homes under `/tmp/qos-agent-security-*`
and never accepts a user-supplied qOS home. It does not contact Solana, use
mainnet, or broadcast a transaction. It never prints private key bytes,
passphrases, or key fingerprints.

## Run it

```sh
qos security-audit
```

The command exits successfully as `PASS_WITH_EXPECTED_RISKS` when the harness
reproduces the known software-key risks and all qOS controls pass. It exits
with failure if an expected control is missing or an unexpected bypass is
accepted.

## What the probe does

- Creates a plaintext-development home and confirms that a process with file
  access can load `signer.pem`. This is an expected critical risk, not a bug
  in the test.
- Creates an encrypted software-key home and confirms that encryption blocks
  recovery without the passphrase, but that exposing the passphrase restores
  signing capability.
- Creates an external-signer home and confirms that it contains only the
  public signer descriptor and no private key file.
- Sends hostile proposal shapes through the agent boundary: arbitrary action,
  amount escalation, destination substitution, extra instructions, remote
  model endpoint, and malicious model output.
- Verifies that `--broadcast --confirm-live` still fails closed without the
  separate mainnet environment opt-in.

## Interpretation

The expected critical/high findings are the reason an AI agent must not receive
access to `signer.pem`, `signer.qkey` plus its passphrase, or qOS process memory.
Use an external non-exportable signer for agent workloads. Even with that
profile, the agent may still request policy-compliant actions, so the external
adapter must independently enforce the same typed policy and remain isolated
from the agent.

To create a public-only external-signer profile, use the supported setup flow:

```sh
./setup.sh install \
  --public-key EXTERNAL_SIGNER_PUBLIC_KEY \
  --destination ALLOWLISTED_DESTINATION \
  --signer-command /absolute/path/to/reviewed-signer-adapter
```

The public key must be supplied by the external signer. Setup refuses to
generate, import, copy, or expose a private key and does not transfer balances.

This is a basic boundary test, not an independent audit. It does not test a
kernel, hypervisor, DMA, firmware fault injection, side channels, a production
HSM, or a real model's ability to exploit an operating-system vulnerability.
