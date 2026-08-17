# Privacy, SNARKs, and agent-safe key custody

qOS v0.9.1 separates possession of a signing capability from possession of the
private key. This distinction is the central rule for agent deployments: the
agent may submit a typed request, but it should never receive, load, export, or
serialize the Ed25519 key.

## Custody profiles

| Profile | Private key in qOS process | At-rest protection | Intended use |
| --- | --- | --- | --- |
| External signer | No | Defined by HSM/TPM/enclave/KMS/MPC/firmware | Preferred for agents |
| Encrypted software key | Yes, while running | AES-256-GCM; scrypt N=262144, r=8, p=1; authenticated metadata | Controlled development/recovery |
| Plaintext software key | Yes | Mode-0600 PEM only | Disposable compatibility demo |

“Military-grade” is not a precise security property. qOS therefore names the
actual construction: AES-256-GCM with a unique 96-bit nonce, a 128-bit tag,
authenticated algorithm/KDF/public-key metadata, a 256-bit random salt, and
scrypt-derived 256-bit key material. A passphrase file must be mode 0600 and is
passed by path, never by command-line value or environment value. Encryption at
rest does not stop a compromised process from using a key after decryption.

Create an encrypted software home:

```sh
umask 077
openssl rand -base64 48 > /secure/path/qos-passphrase
node bin/qos.js init --key-passphrase-file /secure/path/qos-passphrase
QOS_KEY_PASSPHRASE_FILE=/secure/path/qos-passphrase node bin/qos.js address
```

## External signer protocol

Initialize with `--signer-public-key` and an explicit destination. qOS writes
only `signer.json`, the public policy, and no private or receiver key.
`QOS_SIGNER_COMMAND` must be an absolute path and is launched without a shell,
with bounded input/output and a deadline. It receives one JSON request on
standard input:

```json
{
  "version": 1,
  "operation": "authorize-and-sign-qos-intent",
  "publicKey": "BASE58_ED25519_PUBLIC_KEY",
  "messageBase64": "...",
  "authorization": {
    "version": 1,
    "intent": {},
    "intentCommitment": "SHA256_HEX",
    "policyCommitment": "SHA256_HEX",
    "privacyProofVerified": false
  }
}
```

It must return exactly `version`, `publicKey`, and canonical
`signatureBase64`. qOS rejects a different identity, malformed encoding, extra
fields, timeout, oversized output, nonzero exit, or signature that fails local
Ed25519 verification.

The adapter must independently parse the typed intent, reconstruct or parse the
message, compare that reconstruction byte-for-byte with `messageBase64`, and
pin the policy commitment in protected configuration. Its executable must be
an absolute, single-link, non-symlinked regular file owned by root or the
service account, without set-ID bits or group/other write access; qOS
launches it without a shell, from `/`, with a minimal environment. Merely
placing a generic `sign(bytes)` program behind this interface isolates the key
but does not stop a compromised agent from misusing the signing capability.
Run qOS as a dedicated unprivileged account; a root qOS process defeats the
ownership separation that this launcher check is intended to preserve.

Mainnet submission requires this external non-exportable profile. Encrypted or
plaintext software signers are rejected even when the broadcast opt-in is set.
The command protocol is still only a transport: production deployments must
place access control and policy enforcement inside the HSM, enclave, firmware,
or separately isolated service.

`privacyProofVerified` is a host verifier result, not a hardware attestation.
If proof authorization must remain valid after the qOS application is
compromised, the protected signer must verify the proof itself or validate an
authenticated verifier attestation; it must not trust that Boolean alone.

## SNARK authorization gate

qOS supports proof-carrying submit envelopes:

```json
{
  "intent": { "version": 1 },
  "privacyProof": {
    "version": 1,
    "proofSystem": "groth16-bn254",
    "circuitId": "qos-private-policy-v1",
    "proof": {}
  }
}
```

The supported adapter labels are `groth16-bn254` and `plonk-bn254`. qOS does
not implement elliptic-curve pairings in handwritten JavaScript. Instead, it
invokes an absolute-path, reviewed verifier adapter that uses a mature proof
library or hardware verifier. This avoids presenting a home-grown pairing
implementation as safe.

qOS—not the caller—constructs these public signals:

- domain-separated SHA-256 commitment to the exact canonical intent;
- domain-separated SHA-256 commitment to the exact validated policy;
- provisioned signer public key;
- intent expiry slot;
- pinned proof system, circuit ID, and verifying-key SHA-256.

The verifier response includes a digest of the complete verification request,
preventing stale, reordered, or cross-request responses. With
`QOS_REQUIRE_ZK_PROOF=1`, a missing command, missing proof, invalid proof,
changed circuit, or changed verifying-key digest fails closed before signing.

The programs under `fixtures/` are test fixtures only. They are not SNARK
implementations and must never be configured in a deployment.

## Privacy properties and limits

- Completed transaction records are not written by qOS.
- Nonces are generated from 128 random bits. Only keyed SHA-256 commitments are
  retained for same-process replay rejection, and they are cleared on dispose.
- The HTTP service requires an API token. Detailed health, policy, and mutating
  endpoints are authenticated; unauthenticated `/health` returns only
  `{"status":"ok"}`.
- The plaintext HTTP server is loopback-only. RPC responses and command output
  are size-bounded and strict UTF-8/JSON is required.
- SNARKs can hide private witness data from qOS and the verifier adapter only to
  the extent guaranteed by the chosen circuit and proof system. Public signals
  remain public to those components.
- Ordinary Solana transactions reveal their normal contents after broadcast.
  qOS cannot remove ledger data or make a public transfer confidential.
- JavaScript strings and Node.js `KeyObject` internals cannot be reliably
  zeroized. Use the external signer mode when that limitation is unacceptable.
