# qOS firmware fix manifest — 2026-08-21

This archive was rebuilt from `qOS-main(20260820-224224).zip` with the
requested RPC, trade-routing, and trading-performance fixes.

## Functional changes

- Solana JSON-RPC HTTP 429 responses receive up to five bounded attempts with
  exponential backoff, jitter, `Retry-After` support, and one stable JSON-RPC
  request ID/body across retries.
- Retry exhaustion returns the explicit `RPC_RATE_LIMITED` error.
- DEX runtime state now records lifetime attempts, confirmed executions,
  conclusive failures, and unresolved outcomes.
- The public DEX policy exposes `successRateBasisPoints`; unresolved delivery
  outcomes are excluded from the completed-attempt denominator.
- qOS Cloud documentation now specifies that confirmed swap output proceeds
  are sent to the user's connected funding wallet.

## Files changed from the supplied archive

- `README.md`
- `docs/DEX_TRADING.md`
- `src/dex.js`
- `src/rpc.js`
- `test/dex.test.js`
- `test/rpc.test.js`

## Verification

- Full firmware suite: 159 tests passed.
- Static fail-closed checks passed.
- Key implementation markers: `RPC_RATE_LIMITED`, `retry-after`,
  `lifetimeAttempts`, `lifetimeSuccesses`, `lifetimeFailures`, and
  `successRateBasisPoints`.
- Original supplied ZIP SHA-256:
  `4657c9abe11dac054c18b4ce3f0a3d315d8d8961e11135fd0f7b7bd8fc3659f7`.

