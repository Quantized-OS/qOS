# Isolated Solana signer policy v0.1

This document defines the narrow interface between the untrusted trading OS
and the trusted signing component.

## Request

The trusted component accepts a typed order intent, not serialized arbitrary
Solana instructions:

```text
OrderIntentV1
  request_nonce:       u128
  cluster_genesis:     [u8; 32]
  venue_id:            enum allowlisted venue
  market_id:           enum allowlisted market
  side:                BUY | SELL
  input_mint:          [u8; 32]
  output_mint:         [u8; 32]
  input_amount:        u64
  minimum_output:      u64
  max_fee_lamports:    u64
  max_cu_price:        u64
  max_relay_tip:       u64
  recent_blockhash:    [u8; 32]
  expires_at_slot:     u64
  strategy_id:         u32
  operator_approval:   optional authenticated approval token
```

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

