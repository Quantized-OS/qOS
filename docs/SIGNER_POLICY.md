# Isolated Solana signer policy v0.4

This document defines the narrow interface between the untrusted trading OS
and the trusted signing component.

## Request

The trusted component accepts one of two typed intents, not serialized arbitrary
Solana instructions:

```text
OrderIntentV1
  request_nonce:       u128
  cluster_genesis:     [u8; 32]
  venue_id:            enum allowlisted venue
  market_id:           enum allowlisted market
  side:                BUY | SELL | SEND
  input_mint:          [u8; 32]
  output_mint:         [u8; 32]
  input_amount:        u64
  minimum_output:      u64
  max_fee_lamports:    u64
  max_cu_price:        u64
  max_relay_tip:       u64
  destination:         [u8; 32]
  recent_blockhash:    [u8; 32]
  expires_at_slot:     u64
  strategy_id:         u32
  operator_approval:   optional authenticated approval token

TokenTransferIntentV2
  request_nonce:              u128
  cluster_genesis:            [u8; 32]
  venue_id:                   enum allowlisted venue
  market_id:                  enum allowlisted market
  side:                       SEND
  mint:                       [u8; 32]
  amount:                     u64 base units
  max_fee_lamports:           u64
  max_cu_price:               u64
  max_relay_tip:              u64
  destination:                [u8; 32] owner wallet
  source_token_account:       [u8; 32]
  destination_token_account:  [u8; 32]
  token_program:              [u8; 32]
  decimals:                   u8
  recent_blockhash:           [u8; 32]
  expires_at_slot:            u64
  strategy_id:                u32
  operator_approval:          optional authenticated approval token
```

The Node.js sandbox uses the equivalent camel-case JSON fields. Values wider
than JavaScript's safe integer range, including all lamport values, nonces, and
slots, are canonical unsigned decimal strings. Unknown fields, leading zeroes,
trailing data, and non-canonical base58 encodings are rejected.

## Implemented transaction templates

Policy version 2 exposes two exact templates:

- Venue: `QOS_SOLANA_POLICY_TRANSFER`
- Market: `SOLANA`
- Side: `SEND`
- Native program: `11111111111111111111111111111111` (System Program)
- Native instruction: exactly one SOL transfer
- Token mint: `5a8DpBYU12vaxruvSFm1NJL9bHkPzvJuek9viNyZpump`
- Token program: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`
- Token instruction: exactly one `TransferChecked`
- Token decimals: exactly `6`
- Allowed mint extensions: exactly `18` and `19` (metadata pointer and token metadata)
- Signer and fee payer: the isolated mock signer
- Destination owner: exact policy allowlist match
- Token accounts: associated addresses derived from owner, mint, and token program
- Address lookup tables, compute price, and relay tip: disabled

This is a real Solana transaction template for exercising signing, policy,
relay, confirmation, and audit controls. It is not represented as a DEX trade.
The Token-2022 path re-reads the mint, source account, and destination account
before signing. It rejects a changed token program, decimals, mint extension
set, account mint, account owner, frozen state, associated address, or
insufficient balance. It does not create token accounts; both associated token
accounts must already exist.

An actual DEX venue adapter must receive its own exact instruction discriminator,
account derivation rules, market and mint pins, token-account ownership checks,
slippage math, and tests before it can be added.

## Signer behavior

1. Decode using a fixed-length, canonical binary format.
2. Reject unknown versions, enum values, trailing data, and nonzero reserved
   fields.
3. Verify the request nonce is strictly increasing.
4. Apply amount, slippage, fee, program, market, and exposure policies.
5. Construct the exact versioned Solana message internally from a pinned
   instruction template.
6. Reject any account not derivable from the pinned template and request.
7. Sign the serialized message with the hardware-held Ed25519 key.
8. Return only the signature, public key, message digest, and audit sequence.
9. Append an authenticated audit record before authorizing another request.

The sandbox additionally verifies the RPC genesis identity, recent blockhash,
expiry slot, calculated fee, and its own serialized message before it releases
the transaction. A send RPC response is not considered success; the relay
waits for `confirmed` or `finalized` status.

## Explicitly forbidden interfaces

- Sign arbitrary bytes
- Export or wrap the live private key for the host
- Load policy supplied by the trading process
- Disable limits through an RPC flag
- Trust simulation output as authorization
- Use a host-reported profit/loss value as the sole exposure control

## Failure behavior

Any parse error, missing state, rollback indication, clock/slot uncertainty,
audit failure, or policy ambiguity fails closed.  Recovery requires a separate
management key and must never use the trading key.
