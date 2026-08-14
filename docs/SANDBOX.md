# Solana Devnet sandbox

The sandbox turns the qOS signer-policy design into a usable, deliberately
narrow Solana transaction path. It is locked to the pinned Devnet genesis hash
and has no mainnet switch.

## Requirements

- Node.js 20 or newer
- Network access to a Solana Devnet JSON-RPC endpoint
- Devnet SOL only

There are no third-party runtime dependencies and no install step.

## Fast path

From the repository root:

```sh
node bin/qos.js init
node bin/qos.js airdrop --lamports 200000000
node bin/qos.js transfer --lamports 1000000
```

`init` creates `.qos-devnet/` with mode-restricted, disposable signer and
receiver keys, a separate audit authentication key, and an allowlist policy.
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

Prepare an intent without signing it:

```sh
node bin/qos.js prepare --lamports 1000000 > intent.json
```

Review `intent.json`, then submit it:

```sh
node bin/qos.js submit --intent intent.json
```

Every authorized nonce is consumed even if later simulation or submission
fails. Prepare a new intent to receive the next nonce and a fresh blockhash.
Verify the local audit chain at any time:

```sh
node bin/qos.js audit-verify
```

To use a dedicated Devnet provider, set `SOLANA_RPC_URL`. The endpoint may
change, but its live `getGenesisHash` response must equal the policy pin.

## HTTP API

Start the loopback-only service:

```sh
node bin/qos.js serve
```

Health and public policy:

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/policy
```

Prepare an intent:

```sh
curl -sS http://127.0.0.1:8787/v1/intents/prepare \
  -H 'Content-Type: application/json' \
  -d '{"lamports":"1000000"}' > intent.json
```

Submit it:

```sh
curl -sS http://127.0.0.1:8787/v1/intents/submit \
  -H 'Content-Type: application/json' \
  --data-binary @intent.json
```

Set `QOS_API_TOKEN` to require `Authorization: Bearer ...`. A token of at least
32 characters is mandatory if the service is explicitly bound to a
non-loopback address. Put TLS and additional authentication in front of any
remote sandbox deployment; the built-in server intentionally does not provide
TLS.

## Enforced checks

The signing path fails closed unless all of these conditions hold:

1. RPC genesis exactly matches the pinned Devnet genesis.
2. Intent fields and canonical encodings exactly match `OrderIntentV1`.
3. Venue, market, mints, side, strategy, and destination are allowlisted.
4. Amount, fee cap, compute price, relay tip, and slot TTL are within policy.
5. The blockhash is currently valid and the nonce is strictly increasing.
6. The internally built message self-parses as one System Program transfer.
7. RPC fee calculation fits both intent and policy limits.
8. The Ed25519 signature verifies locally.
9. The authorization is appended to the authenticated audit chain.
10. Simulation succeeds, RPC returns the same signature, and the transaction
    reaches confirmed or finalized status before its blockhash expires.

## Security boundary

This is a mock signer suitable for Devnet integration and policy development.
The signer key exists in a local Node.js process and the operating system can
read it. It is not a replacement for the firmware, PMP, HSM, TEE, MPC, or
two-person controls described by the target architecture. Never copy mainnet
keys into `.qos-devnet/`, never change the genesis pin to enable mainnet, and
never treat public Devnet RPC availability as production infrastructure.
