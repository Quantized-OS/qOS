# Setting up a reviewed qOS signer adapter

This guide separates the simple operator steps from the exact contract an
adapter developer and security reviewer must implement.

## First: what the adapter is

The adapter is a small executable between qOS and a separately secured Ed25519
key. The key may live in an HSM, secure element, KMS, MPC service, isolated
signing server, enclave, or production firmware.

The adapter is not the private key. It must never print, export, copy, or return
the key or seed. It receives one proposed qOS transfer, checks that proposal,
asks the secure signer for one signature, and returns only that signature.

qOS does not bundle a production adapter because each secure signer has a
different API and trust model. The file under `fixtures/external-signer.js` is
only a synthetic test fixture. It reads an exportable software key and must not
be used with funds.

## Operator walkthrough

### 1. Provision the secure key

Create an Ed25519 key inside the secure signer. Disable private-key export when
the product supports that control. Record only the corresponding raw 32-byte
public key encoded as a Solana base58 address.

You should finish this step with:

- one base58 public signer address;
- no private key, seed, or recovery phrase on the qOS host; and
- an authenticated way for the reviewed adapter to request a signature.

### 2. Obtain the adapter

Have the secure-signer integrator implement the contract in the developer
section below. The adapter must enforce qOS policy itself. A generic command
that signs any supplied bytes protects key extraction but does not protect the
funds from a compromised agent.

Have a reviewer independent of the implementer examine the adapter, protected
policy, secure-signer access control, replay behavior, error handling, logs,
deployment instructions, and key-rotation process. “Reviewed” is an operational
assurance step; it is not a label qOS can add automatically.

### 3. Install the reviewed executable

Install it in a directory the AI agent and qOS service account cannot replace:

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec/qos
sudo install -o root -g root -m 0755 ./YOUR_REVIEWED_ADAPTER \
  /usr/local/libexec/qos/qos-signer-adapter
```

Confirm the result:

```sh
test ! -L /usr/local/libexec/qos/qos-signer-adapter
stat -c 'type=%F links=%h owner=%U mode=%a path=%n' \
  /usr/local/libexec/qos/qos-signer-adapter
```

The result must be a regular file, have one hard link, be owned by root or the
qOS service account, be executable, have no set-ID bits, and not be writable by
group or other users. qOS also requires the final path to be absolute.

### 4. Run the qOS wizard

Mainnet external custody is the default:

```sh
./setup.sh install
```

The wizard explains each value and asks for:

1. the public signer address from step 1;
2. the single allowlisted destination wallet; and
3. `/usr/local/libexec/qos/qos-signer-adapter`.

The wizard never asks for a private key, seed phrase, recovery phrase, HSM PIN,
API secret, or cloud credential. For a new mainnet profile, it validates the
adapter file before installing dependencies or creating the profile. Review the
summary and answer `yes` only when the network, signer, destination, and paths
are correct.

For unattended provisioning, use the same values explicitly:

```sh
./setup.sh install \
  --public-key YOUR_EXTERNAL_SIGNER_PUBLIC_KEY \
  --destination YOUR_ALLOWLISTED_DESTINATION \
  --signer-command /usr/local/libexec/qos/qos-signer-adapter \
  --no-shell
```

### 5. Verify without sending

After setup, inspect the boundary and prepare an intent without signing or
broadcasting it:

```sh
qos capa
qos stat
qos tok addr
qos tok prep 1000000
```

The capability output must report profile `mainnet-external` and signer mode
`external-non-exportable-boundary`. Status must report that the key is not
exportable to the agent process. The mainnet profile must contain `signer.json`
and must not contain `signer.pem` or `signer.qkey`.

Preparing an intent does not exercise the secure signature. Test the adapter
and secure signer with their dedicated test environment and a non-production
key before authorizing any funded mainnet request. Keep the first funded signer
separate and deliberately capped.

## Exact adapter contract for developers

qOS starts the adapter once per request, without a shell, with working directory
`/` and a minimal environment containing only a safe `PATH`, `LANG=C`, and
`LC_ALL=C`. The default deadline is 10 seconds. Standard input is limited to
256 KiB and standard output to 64 KiB. Adapter-owned configuration therefore
needs absolute paths or protected built-in configuration.

The adapter receives one UTF-8 JSON request followed by a newline:

```json
{
  "version": 1,
  "operation": "authorize-and-sign-qos-intent",
  "publicKey": "BASE58_ED25519_PUBLIC_KEY",
  "messageBase64": "CANONICAL_BASE64_SOLANA_MESSAGE",
  "authorization": {
    "version": 1,
    "intent": {},
    "intentCommitment": "LOWERCASE_SHA256_HEX",
    "policyCommitment": "LOWERCASE_SHA256_HEX",
    "privacyProofVerified": false
  }
}
```

It must return one JSON object containing exactly these fields:

```json
{
  "version": 1,
  "publicKey": "THE_SAME_BASE58_ED25519_PUBLIC_KEY",
  "signatureBase64": "CANONICAL_BASE64_64_BYTE_ED25519_SIGNATURE"
}
```

Write operational logs somewhere other than standard output. A nonzero exit,
signal, timeout, extra response field, identity change, malformed base64,
non-64-byte signature, or signature that fails local Ed25519 verification is
rejected by qOS.

Before signing, the protected side must at minimum:

1. Reject missing, extra, or wrongly typed request and authorization fields.
2. Require request and authorization version 1 and the exact operation name.
3. Require the request public key to equal the protected signer's identity.
4. Recompute the intent commitment as SHA-256 over UTF-8 domain
   `qos-intent-v1`, one zero byte, and qOS canonical JSON for the typed intent.
5. Store the approved policy in protected configuration, compute its matching
   `qos-policy-v1` commitment, and require an exact match.
6. Validate every typed intent field against that protected policy, including
   cluster genesis, destination, asset, amount, fee cap, expiry, strategy,
   nonce, token program, mint, decimals, and token accounts where applicable.
7. Independently reconstruct or strictly parse the single permitted Solana
   instruction and compare the complete message byte-for-byte with decoded
   `messageBase64`.
8. Enforce protected replay, rate, exposure, approval, and recovery controls
   required by the deployment. The qOS host's process-local replay state is not
   a substitute for rollback-safe signer-side state.
9. Treat `privacyProofVerified` as an untrusted host result unless the protected
   side independently verifies the proof or validates an authenticated verifier
   attestation.
10. Ask the non-exportable Ed25519 key to sign only after every check succeeds.

The current transaction formats and intent fields are defined in
`src/transaction.js` and `src/policy.js`. Commitment encoding is defined in
`src/canonical.js` and `src/zk.js`. The qOS-side request and response checks are
defined in `src/signer.js` and `src/subprocess.js`.

## Common errors

`External command must not be writable by group or other users`

: For a reviewed user-owned development adapter, use `chmod 0700 ABSOLUTE_PATH`.
  For production, reinstall the reviewed bytes into the root-controlled path
  shown above. Do not loosen qOS validation.

`External command must have exactly one hard link`

: Use `install` to make a separate reviewed copy at the final protected path.

`External command must be a regular file, not a symbolic link`

: Install a real copy. qOS deliberately refuses symbolic links.

`SIGNER_IDENTITY_MISMATCH`

: The returned public key differs from the public key provisioned in the qOS
  profile. Stop and reconcile the secure key identity; do not bypass the check.

`SIGNATURE_SELF_CHECK_FAILED`

: The signature does not verify for the provisioned public key and exact Solana
  message. Treat this as an adapter, key-selection, or message-construction
  failure and keep the profile unfunded.
