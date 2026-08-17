# Source-wallet readiness and inline policy control

## What setup can and cannot do

An Ed25519 public key is not created “on” one Solana cluster. The same address
can be queried on Devnet or mainnet. qOS makes a source wallet operational by
pinning the RPC genesis, deriving the supported token account, checking its
cluster state, and reporting or obtaining the assets needed by the reviewed
transaction template.

### Devnet

`./setup.sh install --devnet` creates the disposable source key and, by
default, requests and confirms a 0.2 SOL Devnet faucet airdrop. Faucet failure
does not get reported as success; setup retains the profile and prints the
retry command:

```text
qos> wal fund 200000000
```

Use `--no-fund` to verify without requesting an airdrop, or `--offline` to skip
all network checks. Neither option enables a broadcast.

### Mainnet

qOS cannot mint SOL or qOS tokens and does not ask a faucet to fund mainnet.
Setup verifies the mainnet genesis and prints:

- the exact source signer address;
- its SOL balance and configured fee reserve;
- the pinned qOS mint and Token-2022 program;
- the derived source associated token address;
- each allowlisted destination's derived associated token address;
- whether those accounts exist and their base-unit balances; and
- every blocker before the profile can submit its reviewed transfer.

Fund only those displayed addresses through a trusted Solana wallet or custody
system. qOS does not add an unreviewed associated-token-account creation
instruction to a transfer. Run this check at any time:

```text
qos> wal status
```

RPC failures and a wrong genesis fail closed. A readiness result does not
authorize a transaction.

## Readable output and JSON

The qOS shell renders operator commands as labels and values:

```text
qos> capa
qos> stat
qos> wal status
```

Automation can request the stable JSON representation explicitly:

```sh
qos --json capa
qos-wallet --json status
```

The low-level `qos-core` interface remains JSON-oriented.

## Inline policy editing

Show or edit the policy inside qOS:

```text
qos> pol show
qos> pol edit
qos> pol set max-token-amount 1000000
qos> pol destination add PUBLIC_KEY
qos> pol destination remove PUBLIC_KEY
qos> pol strategy add 2
qos> pol strategy remove 1
```

For unattended changes, add `--confirm-policy-change`. Supported scalar fields
are:

- `max-sol-lamports`
- `max-token-amount`
- `max-fee-lamports`
- `rate-limit`
- `ttl-slots`
- `commitment`
- `rpc-url`

Every edit is written to a private temporary file, fully revalidated, and
atomically renamed. The allowlists cannot become empty or contain duplicates.
The Solana genesis, venue/market template, program IDs, token mint, decimals,
and required mint extensions are not editable.

An agent is always constrained by the intersection of its onboarded scope and
the current qOS policy. Tightening policy takes effect immediately. Restart the
agent listener after any policy change. For `mainnet-external`, update and
independently review the protected policy commitment in the external signer as
well; qOS prints that requirement after each change.
