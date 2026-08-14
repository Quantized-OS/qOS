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

## qOS Token-2022 mainnet path

Create a separate home and explicitly select mainnet. Use a destination wallet
whose qOS associated token account already exists:

```sh
node bin/qos.js init --home .qos-mainnet --cluster mainnet-beta \
  --destination YOUR_MAINNET_WALLET
node bin/qos.js address --home .qos-mainnet
node bin/qos.js token-address --home .qos-mainnet
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
node bin/qos.js token-balance --home .qos-mainnet
node bin/qos.js token-prepare --home .qos-mainnet --amount 1000000 > token-intent.json
```

Review the intent. Mainnet submission requires this exact additional opt-in:

```sh
QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND \
  node bin/qos.js submit --home .qos-mainnet --intent token-intent.json
```

A different mainnet RPC can be supplied with `SOLANA_RPC_URL`; the client still
requires the mainnet genesis hash. There is no faucet or airdrop command in
mainnet mode.

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

Prepare a token intent when the server is using `.qos-mainnet`:

```sh
curl -sS http://127.0.0.1:8787/v1/token-intents/prepare \
  -H 'Content-Type: application/json' \
  -d '{"amount":"1000000"}' > token-intent.json
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

1. RPC genesis exactly matches the selected policy's cluster.
2. Intent fields and canonical encodings exactly match `OrderIntentV1` or
   `TokenTransferIntentV2`.
3. Venue, market, mints, side, strategy, and destination are allowlisted.
4. Amount, fee cap, compute price, relay tip, and slot TTL are within policy.
5. The blockhash is currently valid and the nonce is strictly increasing.
6. The internally built message self-parses as one System Program transfer or
   one Token-2022 `TransferChecked` instruction.
7. Token mode verifies the mint owner, decimals, extension set, associated
   account derivations, account owners, account state, and source balance.
8. RPC fee calculation fits both intent and policy limits.
9. The Ed25519 signature verifies locally.
10. The authorization is appended to the authenticated audit chain.
11. Simulation succeeds, RPC returns the same signature, and the transaction
    reaches confirmed or finalized status before its blockhash expires.

## Security boundary

This is a mock signer suitable for integration and policy development.
The signer key exists in a local Node.js process and the operating system can
read it. It is not a replacement for the firmware, PMP, HSM, TEE, MPC, or
two-person controls described by the target architecture. Keep `.qos-devnet`
and `.qos-mainnet` separate, use only deliberately capped keys, and never treat
the public RPC endpoints or this prototype as production custody
infrastructure. Mainnet submission is guarded by
`QOS_ENABLE_MAINNET_BROADCAST=I_UNDERSTAND`, but that guard is not a security
boundary against a compromised operating system.
