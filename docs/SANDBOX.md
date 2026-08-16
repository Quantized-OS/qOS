# Solana sandbox

The sandbox turns the qOS signer-policy design into a usable, deliberately
narrow Solana transaction path. Devnet is the default and supports native SOL.
An explicit mainnet policy supports only the pinned qOS Token-2022 mint.

## Requirements

- Node.js 20 or newer
- Network access to a Solana JSON-RPC endpoint for the selected cluster
- Disposable Devnet funds for the native-SOL path
- A separately created and deliberately funded mainnet signer for the token path

There are no third-party runtime dependencies and no install step.

## Fast path

From the repository root:

```sh
node bin/qos.js init
node bin/qos.js airdrop --lamports 200000000
node bin/qos.js transfer --lamports 1000000
```

`init` creates `.qos-ephemeral-devnet/` with mode-restricted, disposable
signer and receiver keys plus an allowlist policy. It creates no transaction
log or audit key.
It refuses to overwrite an existing directory. The generated receiver is only
for making the first sandbox transfer self-contained.

The public faucet is frequently rate-limited. If it rejects the request, fund
the signer address from another Devnet faucet or wallet and run `balance`
before retrying the transfer.

## CLI workflow

Show the signer and current balance:

```sh
node bin/qos.js address
node bin/qos.js balance
```

The privacy-preserving path prepares and submits in one process:

```sh
node bin/qos.js transfer --lamports 1000000
```

The optional two-step path exposes the intent to the caller:

```sh
node bin/qos.js prepare --lamports 1000000 > intent.json
```

Review `intent.json`, then submit it:

```sh
node bin/qos.js submit --intent intent.json
```

The shell redirection above deliberately writes transaction details to
intent.json and is therefore not ephemeral. Use the one-step transfer command
when local transaction retention is unwanted. Keyed commitments to used nonces
remain only for the process lifetime; raw nonces and transaction fields are not
retained.

Inspect the privacy boundary:

```sh
node bin/qos.js privacy-status
```

To use a dedicated Devnet provider, set `SOLANA_RPC_URL`. The endpoint may
change, but its live `getGenesisHash` response must equal the policy pin.

## qOS Token-2022 mainnet path

Create a separate home, explicitly select mainnet, and provision the public
identity of a reviewed external policy signer. Use a destination wallet whose
qOS associated token account already exists:

```sh
node bin/qos.js init --home .qos-ephemeral-mainnet --cluster mainnet-beta \
  --signer-public-key YOUR_EXTERNAL_SIGNER_PUBLIC_KEY \
  --destination YOUR_MAINNET_WALLET
export QOS_SIGNER_COMMAND=/absolute/path/to/reviewed-qos-signer-adapter
node bin/qos.js address --home .qos-ephemeral-mainnet
node bin/qos.js token-address --home .qos-ephemeral-mainnet
```

The policy pins:

- Mint: `5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump`
- Token program: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`
- Decimals: `6`
- Mint extensions: metadata pointer (`18`) and token metadata (`19`)
- Maximum transfer: `1000000000` base units (1,000 tokens)

Fund the printed signer with SOL for fees and send qOS tokens to its derived
associated token account. Then inspect its base-unit balance and prepare a
one-token intent:

```sh
node bin/qos.js token-balance --home .qos-ephemeral-mainnet
node bin/qos.js token-prepare --home .qos-ephemeral-mainnet --amount 1000000
```

Mainnet submission requires both the external signer and this exact additional
opt-in. Software-key homes fail closed:

```sh
QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND \
  node bin/qos.js token-transfer --home .qos-ephemeral-mainnet --amount 1000000
```

A different mainnet RPC can be supplied with `SOLANA_RPC_URL`; the client still
requires the mainnet genesis hash. There is no faucet or airdrop command in
mainnet mode.

## HTTP API

Start the loopback-only service:

```sh
umask 077
openssl rand -base64 48 | tr -d '\r\n' > /secure/path/qos-api-token
chmod 600 /secure/path/qos-api-token
export QOS_API_TOKEN_FILE=/secure/path/qos-api-token
node bin/qos.js serve
```

For a disposable Devnet-only session, `QOS_API_TOKEN` remains available as an
environment fallback. Mainnet service mode requires `QOS_API_TOKEN_FILE`.
The token file must be a non-symlinked, single-link, owner-only regular file.

Minimal unauthenticated liveness and authenticated detailed health/policy:

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/health \
  -H "Authorization: Bearer $(tr -d '\r\n' < "$QOS_API_TOKEN_FILE")"
curl http://127.0.0.1:8787/v1/policy \
  -H "Authorization: Bearer $(tr -d '\r\n' < "$QOS_API_TOKEN_FILE")"
```

For the remaining examples, load the token into a short-lived shell variable:

```sh
QOS_API_TOKEN="$(tr -d '\r\n' < "$QOS_API_TOKEN_FILE")"
```

Prepare an intent:

```sh
curl -sS http://127.0.0.1:8787/v1/intents/prepare \
  -H "Authorization: Bearer $QOS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"lamports":"1000000"}' > intent.json
```

Prepare a token intent when the server is using the mainnet home:

```sh
curl -sS http://127.0.0.1:8787/v1/token-intents/prepare \
  -H "Authorization: Bearer $QOS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"amount":"1000000"}' > token-intent.json
```

Submit it:

```sh
curl -sS http://127.0.0.1:8787/v1/intents/submit \
  -H "Authorization: Bearer $QOS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @intent.json
```

Configure a freshly generated visible-ASCII token containing 32 to 512 bytes;
it is mandatory for the HTTP service and required as `Authorization: Bearer`
on every detailed or mutating endpoint. Clear any temporary shell copy after
use with `unset QOS_API_TOKEN`. The
built-in server intentionally has no TLS and now refuses every non-loopback
bind, even when a bearer token is present. For remote administration, place a
separately isolated TLS and authentication proxy on the same host and keep qOS
bound to loopback.

HTTP request buffers are overwritten after parsing, but JSON strings are
managed by the JavaScript garbage collector. Curl output redirection, reverse
proxy access logs, application logging, terminal capture, and RPC-provider logs
can all retain transaction details outside qOS.

## Enforced checks

The signing path fails closed unless all of these conditions hold:

1. RPC genesis exactly matches the selected policy's cluster.
2. Intent fields and canonical encodings exactly match `OrderIntentV1` or
   `TokenTransferIntentV2`.
3. Venue, market, mints, side, strategy, and destination are allowlisted.
4. Amount, fee cap, compute price, relay tip, and slot TTL are within policy.
5. The blockhash is currently valid and the keyed nonce commitment has not
   appeared earlier in the current process; firmware demo nonces are strictly
   increasing per boot.
6. The internally built message self-parses as one System Program transfer or
   one Token-2022 `TransferChecked` instruction.
7. Token mode verifies the mint owner, decimals, extension set, associated
   account derivations, account owners, account state, and source balance.
8. RPC fee calculation fits both intent and policy limits.
9. The Ed25519 signature verifies locally.
10. Simulation succeeds, RPC returns the same signature, and the transaction
    reaches confirmed or finalized status before its blockhash expires.

## Ephemeral retention model

qOS writes no intent, message, blockhash, signature, or transaction audit
record. The one-step CLI and QEMU demo keep those values in process or guest
memory only and overwrite mutable buffers after the operation. The QEMU loader
uses unlinked files on Linux tmpfs; no intents.bin file is created. The
selected custody files, policy, firmware ELF, and public provisioning record
remain persistent by design. External-signer homes persist only a public
signer descriptor and create no private-key files.

Existing v0.5 homes contain audit data and are rejected rather than silently
ignored or deleted. The v0.7 defaults use .qos-ephemeral-devnet and
.qos-ephemeral-mainnet directories. Old homes remain untouched so the operator
can archive or securely remove them.

## Security boundary

Plaintext development homes use a mock signer whose key exists in the Node.js
process. Encrypted software homes protect the key at rest with AES-256-GCM and
scrypt, but the decrypted key still exists in that process while qOS runs.
External-signer homes create no private-key files and keep the key out of the
agent process; their adapter and backing HSM, firmware, enclave, KMS, or MPC
system become security-critical. None of these modes replaces an independent
review, physical hardening, rollback-safe replay state, or two-person controls.
Keep Devnet and mainnet homes separate and use deliberately capped keys.
Mainnet submission requires a non-exportable external signer and is additionally
guarded by `QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND`; the environment guard is
not a security boundary against a compromised operating system.

For the strongest demonstration host, disable swap and core dumps, avoid shell
history containing sensitive parameters, disable terminal recording, and use a
dedicated RPC that does not retain request bodies. Broadcast Solana
transactions are public and cannot be forgotten by qOS or removed from the
ledger.
