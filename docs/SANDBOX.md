# Solana sandbox

The sandbox turns the qOS signer-policy design into a usable, deliberately
narrow Solana transaction path. Devnet is the default and supports native SOL.
An explicit mainnet policy supports only the pinned qOS Token-2022 mint.

## Requirements

- Node.js 20 or newer
- Network access to a Solana JSON-RPC endpoint for the selected cluster
- Disposable Devnet funds for the native-SOL path
- A separately created and deliberately funded mainnet signer for the token path

There are no third-party runtime dependencies. The supported setup installs
one operator command, `qos`; the source files under `bin/` are internal command
implementations and are not installed separately.

## Fast path

From the repository root:

```sh
./setup.sh install --devnet --no-shell
qos wallet fund 200000000
qos sol send 1000000 --confirm-broadcast
```

Setup creates a mode-restricted, disposable
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
qos address
qos balance
```

The privacy-preserving path prepares and submits in one process:

```sh
qos sol send 1000000 --confirm-broadcast
```

The optional two-step path exposes the intent to the caller:

```sh
qos --json sol prepare 1000000 > intent.json
```

Review `intent.json`, then submit it:

```sh
qos submit intent.json --confirm-broadcast
```

The shell redirection above deliberately writes transaction details to
intent.json and is therefore not ephemeral. Use the one-step transfer command
when local transaction retention is unwanted. Keyed commitments to used nonces
remain only for the process lifetime; raw nonces and transaction fields are not
retained.

Inspect the privacy boundary:

```sh
qos privacy
```

To use a dedicated Devnet provider, set `SOLANA_RPC_URL`. The endpoint may
change, but its live `getGenesisHash` response must equal the policy pin.

## qOS Token-2022 mainnet path

Create a separate home, explicitly select mainnet, and provision the public
identity of a reviewed external policy signer. Use a destination wallet whose
qOS associated token account already exists:

```sh
./setup.sh install \
  --public-key YOUR_EXTERNAL_SIGNER_PUBLIC_KEY \
  --destination YOUR_MAINNET_WALLET \
  --signer-command /absolute/path/to/reviewed-qos-signer-adapter
qos address
qos token address
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
qos token balance
qos token prepare 1000000
```

Mainnet submission requires the explicit shell confirmation. It accepts the
preferred external signer or a software-key home carrying the acknowledged
`mainnet-insecure` runtime profile created by `setup.sh install --insecure`:

```sh
qos token send 1000000 --confirm-live
```

A different mainnet RPC can be supplied with `SOLANA_RPC_URL`; the client still
requires the mainnet genesis hash. There is no faucet or airdrop command in
mainnet mode.

## HTTP API

Start the loopback-only core service. Setup already created its owner-only API
token file:

```sh
qos serve core 8787
```

In a second terminal, obtain the non-secret token-file path from the active
profile. Mainnet service mode requires this file-backed credential:

```sh
QOS_API_TOKEN_FILE="$(qos --json profile | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).apiTokenFile))')"
```

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
Mainnet submission requires either a non-exportable external signer or the
explicitly acknowledged `mainnet-insecure` software-custody profile. Both are
additionally guarded by `QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND`; the
environment guard and setup notice are not security boundaries against a
compromised operating system. In the insecure profile, any process with the
qOS user's file access can copy `signer.pem`.

For the strongest demonstration host, disable swap and core dumps, avoid shell
history containing sensitive parameters, disable terminal recording, and use a
dedicated RPC that does not retain request bodies. Broadcast Solana
transactions are public and cannot be forgotten by qOS or removed from the
ledger.
